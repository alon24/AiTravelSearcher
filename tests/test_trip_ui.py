"""Shared trips (web/trip.js, worker/src/trips.js): a conversation becomes a group chat that friends join by link;
anyone in it can ask Skyhop. Pages build only. Two browsers (ilan, who may spend the keys, and dana, a guest) talk to
one fake Worker that keeps trips in memory like the Durable Object does."""
import json
import re
import time
from urllib.parse import parse_qs, urlparse

import pytest

pytest.importorskip("playwright.sync_api")

from test_account_ui import _fares  # noqa: E402
from test_chat_ui import ASK, CORS, RUNTIME, WORKER, brain  # noqa: E402

PEOPLE = {"tok-ilan": ("ilan@example.com", True), "tok-dana": ("dana@example.com", False)}
GIS = """window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken: () => setTimeout(() =>
  c.callback({ access_token: "tok-dana", expires_in: 3599, scope: c.scope }), 0) }) } } };"""


class FakeWorker:
    """The Worker's /health, /chat and /trips, with trips in memory."""

    def __init__(self):
        self.trips, self.model_calls, self.patches, self.serpapi, self.lookups = {}, [], [], False, []

    def __call__(self, route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers={**CORS, "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Trip",
                                                      "Access-Control-Allow-Methods": "GET, POST, PATCH"})
        who = PEOPLE.get((req.headers.get("authorization") or "").removeprefix("Bearer "))
        url = urlparse(req.url)
        if url.path == "/health":
            return self.ok(route, {"serpapi": self.serpapi, "chat": True, "trips": True, "sign_in": True,
                                   "user": who[0] if who and who[1] else None, "guest": who[0] if who and not who[1] else None})
        if not who:
            return self.ok(route, {"error": "sign in"}, 401)
        email, allowed = who
        if url.path == "/serpapi":
            self.lookups.append((email, req.headers.get("x-trip")))
            return self.ok(route, _fares(parse_qs(url.query)))
        if url.path == "/chat":
            if not allowed and req.headers.get("x-trip") not in self.trips:
                return self.ok(route, {"error": "not allowed"}, 403)
            body = req.post_data_json
            self.model_calls.append((email, req.headers.get("x-trip"), body))
            return self.ok(route, {"message": brain(body)})
        parts = url.path.split("/")[2:]
        if not parts and req.method == "POST":
            tid = f"trip{len(self.trips):08d}"
            body = req.post_data_json
            t = {"title": body["title"], "owner": email, "members": [email], "brief": None, "request": body.get("request"), "messages": []}
            self.trips[tid] = t
            for m in body.get("messages", []):
                self.add(t, "ai" if m.get("author") == "ai" else email, m["kind"], m.get("text", ""), m.get("data"))
            return self.ok(route, {"id": tid}, 201)
        t = self.trips[parts[0]]
        if email not in t["members"]:
            t["members"].append(email)
        if len(parts) == 1 and req.method == "GET":
            since = int(parse_qs(url.query).get("since", ["0"])[0])
            meta = {k: v for k, v in t.items() if k != "messages"}
            return self.ok(route, {**meta, "seq": len(t["messages"]), "messages": [m for m in t["messages"] if m["seq"] > since]})
        body = req.post_data_json
        if len(parts) == 1:                                    # PATCH
            self.patches.append(body)
            t.update({k: v for k, v in body.items() if v is not None})
            return self.ok(route, {"ok": True})
        return self.ok(route, self.add(t, "ai" if body["kind"] == "ai" else email, body["kind"], body.get("text", ""), body.get("data")))

    @staticmethod
    def add(t, author, kind, text, data):
        m = {"seq": len(t["messages"]) + 1, "at": 0, "author": author, "kind": kind, "text": text, "data": data}
        t["messages"].append(m)
        return m

    @staticmethod
    def ok(route, body, status=200):
        route.fulfill(status=status, headers=CORS, content_type="application/json", body=json.dumps(body))


def _wire(page, worker, token=None):
    page.route(f"{WORKER}/**", worker)
    page.route("**/skyhop/runtime.js", lambda r: r.fulfill(content_type="text/javascript", body=RUNTIME))
    page.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(content_type="text/javascript", body=GIS))
    if token:
        page.evaluate("s => localStorage.setItem('skyhop.google', JSON.stringify(s))",
                      {"token": token, "until": int(time.time() * 1000) + 3_000_000, "email": PEOPLE[token][0], "scopes": ["openid", "email"]})


@pytest.fixture
def ilan(page, base_url):
    if not base_url.endswith("/skyhop"):
        pytest.skip("shared trips live on the Worker: Pages build only")
    worker = FakeWorker()
    _wire(page, worker, "tok-ilan")
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    page.worker = worker
    return page


@pytest.fixture
def dana(ilan):
    """A second person, in their own browser profile, not signed in yet."""
    ctx = ilan.context.browser.new_context(viewport={"width": 1400, "height": 900})
    p = ctx.new_page()
    _wire(p, ilan.worker)
    yield p
    ctx.close()


def _share(p):
    p.click("#chat-launch")
    p.fill("#chat-input", ASK)
    p.press("#chat-input", "Enter")
    p.wait_for_selector(".msg.ai:has-text('Cheapest is')", timeout=60000)
    p.click("#chat-share")
    p.wait_for_selector("#chat-title:has-text('👥')")
    return p.input_value(".invite-link input")


def test_a_conversation_becomes_a_shared_trip_with_an_invite_link(ilan):
    link = _share(ilan)
    assert re.fullmatch(r".*/skyhop/#trip=trip\d{8}", link)
    (trip,) = ilan.worker.trips.values()
    assert [m["kind"] for m in trip["messages"]] == ["user", "search", "ai"], "the conversation so far moves into the trip"
    assert trip["request"]["destinations"] == ["ROM", "ATH"]
    assert ilan.locator("#chat-ask").is_visible() and ilan.locator("#chat-invite").is_visible()
    assert "With You" in ilan.inner_text("#chat-sub")


def test_a_guest_joins_by_link_and_asks_skyhop_for_everyone(ilan, dana):
    link = _share(ilan)
    dana.goto(link)
    dana.wait_for_selector("#chat.open")
    assert dana.inner_text("#chat-title") == "Join a shared trip"
    dana.click("#chat-signin")
    dana.wait_for_selector("#chat-title:has-text('👥')")
    assert "ilan" in dana.locator(".msg.them").first.inner_text(), "a guest sees who said what"
    assert dana.locator(".msg.tool").count() == 1
    dana.fill("#chat-input", "Same in December?")
    dana.click("#chat-ask")
    dana.wait_for_selector(".msg.tool:has-text('1 Dec')", timeout=60000)
    dana.wait_for_selector(".msg.ai:has-text('Cheapest is')  >> nth=1")
    who, trip_header, body = ilan.worker.model_calls[-1]
    assert (who, trip_header) == ("dana@example.com", next(iter(ilan.worker.trips))), "a guest's AI turn is billed to the trip"
    assert "group chat" in body["messages"][0]["content"] and body["messages"][-1]["role"] in ("user", "tool")
    assert any(m["content"].startswith("dana: Same in December") for m in body["messages"] if m["role"] == "user")
    ilan.wait_for_selector(".msg.them:has-text('Same in December?')", timeout=10000)   # ilan's page picks it up
    assert "dana" in ilan.inner_text("#chat-sub")


def test_a_trip_brief_is_shared_with_everyone(ilan, dana):
    link = _share(ilan)
    ilan.click("#chat-summarize")
    ilan.wait_for_selector(".msg.brief:has-text('Rome or Athens, November')")
    assert ilan.worker.patches[-1]["brief"]["title"] == "Rome or Athens, November"
    dana.goto(link)
    dana.click("#chat-signin")
    dana.wait_for_selector(".msg.brief:has-text('Rome or Athens, November')")


def test_anyone_can_open_a_search_from_the_trip(ilan, dana):
    link = _share(ilan)
    dana.goto(link)
    dana.click("#chat-signin")
    dana.wait_for_selector("#chat-title:has-text('👥')")
    dana.get_by_role("button", name="Open results").click()
    dana.wait_for_selector(".cmp-table", timeout=60000)
    assert dana.evaluate("ac.to.get()") == ["ROM", "ATH"]


def test_leaving_returns_to_your_own_chats_and_lists_the_trip(ilan):
    _share(ilan)
    ilan.click("#chat-leave")
    ilan.wait_for_selector("#chat-title:text-is('Ask Skyhop')")
    ilan.locator(".chat-recent", has_text="👥").click()
    ilan.wait_for_selector("#chat-title:has-text('👥')")


def test_a_guest_gets_real_fares_only_inside_the_trip(ilan, dana):
    link = _share(ilan)                     # on demo fares; then the owner's Worker gets a SerpApi key
    ilan.worker.serpapi = True
    dana.goto(link)
    dana.click("#chat-signin")
    dana.wait_for_selector("#chat-title:has-text('👥')")
    dana.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")
    dana.get_by_role("button", name="Open results").click()
    dana.wait_for_function("document.querySelector('#results').textContent.includes('serpapi')", timeout=60000)
    trip = next(iter(ilan.worker.trips))
    assert {t for who, t in ilan.worker.lookups if who == "dana@example.com"} == {trip}, "the guest's lookups are billed to the trip"
    dana.click("#chat-launch")
    dana.click("#chat-leave")
    dana.wait_for_function("document.querySelector('#mode-badge-desk').textContent === '⚠ DEMO DATA'")


def test_a_shared_trip_fits_a_phone(ilan, dana):
    link = _share(ilan)
    dana.set_viewport_size({"width": 360, "height": 800})
    dana.goto(link)
    dana.click("#chat-signin")
    dana.wait_for_selector("#chat-title:has-text('👥')")
    for button in ("#chat-summarize", "#chat-invite", "#chat-leave", "#chat-close", "#chat-send", "#chat-ask"):
        box = dana.locator(button).bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 360, f"{button} is off screen"
    assert dana.locator(".toast", has_text="invited accounts").count() == 0, "joining by invite doesn't talk about access lists"
