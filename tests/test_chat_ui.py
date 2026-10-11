"""Ask Skyhop (web/chat.js): the AI chat runs searches in the page, remembers conversations, and turns them into trip
briefs that can be shared, saved to Google Drive and continued. The model is faked: on the server build it answers
/api/chat/complete, on the Pages build the Worker's /chat (signed in with a stored Google token)."""
import json
import time
from urllib.parse import parse_qs, urlparse

import pytest

pytest.importorskip("playwright.sync_api")

WORKER = "https://worker.test"
RUNTIME = 'window.SKYHOP_RUNTIME = {"backend": "browser", "workerUrl": "%s", "googleClientId": "client-1"};' % WORKER
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type"}
ASK = "Rome or Athens for 3 to 5 nights in early November"
BRIEF = {"title": "Rome or Athens, November", "summary": "One adult from Tel Aviv, 3-5 nights in early November.",
         "conditions": ["2-12 Nov", "3-5 nights"], "best_options": ["Rome from 400"], "next_steps": []}


def brain(body):
    """The fake model: searches when asked about Rome, answers after a search, and summarizes as JSON."""
    msgs = body["messages"]
    if body.get("json_mode"):
        return {"role": "assistant", "content": json.dumps(BRIEF)}
    last = msgs[-1]
    if last["role"] == "tool":
        out = json.loads(last["content"])
        return {"role": "assistant", "content": f"Cheapest is {out['trips'][0]['destination']} for {out['trips'][0]['price']}."}
    if "Rome" in last["content"] or "December" in last["content"]:
        month = ("2026-12-01", "2026-12-10") if "December" in last["content"] else ("2026-11-02", "2026-11-12")
        args = {"destinations": ["ROM", "ATH"], "window_start": month[0], "window_end": month[1], "min_nights": 3, "max_nights": 5}
        return {"role": "assistant", "content": "", "tool_calls": [
            {"id": f"call{len(msgs)}", "type": "function", "function": {"name": "search_flights", "arguments": json.dumps(args)}}]}
    return {"role": "assistant", "content": "Which dates are you thinking of?"}


@pytest.fixture
def chat(page, base_url):
    """The page with a fake model behind its chat; `state["asked"]` holds every request the model got."""
    state = {"asked": [], "drive": []}
    pages = base_url.endswith("/skyhop")

    def model(route):
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        body = route.request.post_data_json
        state["asked"].append(body)
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"message": brain(body)}))

    if pages:
        def worker(route):
            if route.request.method == "OPTIONS":
                return route.fulfill(status=204, headers=CORS)
            path = urlparse(route.request.url).path
            if path == "/chat":
                return model(route)
            ok = route.request.headers.get("authorization") == "Bearer tok-1"
            route.fulfill(status=200, headers=CORS, json={"serpapi": False, "jev": True, "chat": True, "sign_in": True,
                                                          "user": "ilan@example.com" if ok else None})
        page.route(f"{WORKER}/**", worker)
        page.route("**/skyhop/runtime.js", lambda r: r.fulfill(content_type="text/javascript", body=RUNTIME))
        until = int(time.time() * 1000) + 3_000_000
        page.evaluate("s => localStorage.setItem('skyhop.google', JSON.stringify(s))",
                      {"token": "tok-1", "until": until, "email": "ilan@example.com", "scopes": ["openid", "email"]})
    else:
        page.route("**/api/chat/complete", model)
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    state["pages"] = pages
    return state


def _open(p):
    p.click("#chat-launch")
    p.wait_for_selector("#chat.open")


def _say(p, text):
    p.fill("#chat-input", text)
    p.press("#chat-input", "Enter")


def _ask_rome(p):
    _open(p)
    _say(p, ASK)
    p.wait_for_selector(".msg.ai:has-text('Cheapest is')", timeout=60000)


def test_the_chat_runs_a_search_and_talks_about_it(page, chat):
    _ask_rome(page)
    assert page.locator(".msg.me").inner_text() == ASK
    card = page.locator(".msg.tool")
    assert "TLV → ROM, ATH" in card.inner_text() and "from" in card.inner_text()
    assert page.evaluate("ac.to.get()") == ["ROM", "ATH"], "the search fills the form, so the user can see and tweak it"
    page.wait_for_selector(".cmp-table")                    # the results are on the page, beside the chat
    first = chat["asked"][0]
    assert first["tools"][0]["function"]["name"] == "search_flights"
    assert "origin TLV" in first["messages"][0]["content"]
    digest = json.loads(chat["asked"][1]["messages"][-1]["content"])
    assert digest["demo"] is True and digest["trips"] and {"ROM", "ATH"} <= set(digest["cheapest_by_destination"])
    cheapest = min(digest["cheapest_by_destination"].values())
    assert f"from {page.evaluate('([v, c]) => money(v, c)', [cheapest, digest['currency']])}" in card.inner_text(), \
        "the card quotes the cheapest trip, not the top-ranked one"
    card.get_by_role("button", name="Show results").click()
    page.wait_for_selector("#chat", state="hidden")


def test_a_question_without_a_search_is_just_answered(page, chat):
    _open(page)
    _say(page, "I want a holiday")
    page.wait_for_selector(".msg.ai:has-text('Which dates')")
    assert page.locator(".msg.tool").count() == 0


def test_conversations_are_remembered_after_a_reload(page, chat):
    _ask_rome(page)
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    _open(page)
    page.locator(".chat-recent", has_text="Rome or Athens").click()
    page.wait_for_selector(".msg.ai:has-text('Cheapest is')")
    _say(page, "Same in December?")
    page.wait_for_selector(".msg.tool:has-text('1 Dec')", timeout=60000)
    sent = [m.get("content") for m in chat["asked"][-1]["messages"]]
    assert ASK in sent, "the model sees the earlier conversation"


def test_the_model_reads_each_search_in_full_only_once(page, chat):
    """Every turn resends the conversation, so an older search shrinks to its best trip and the cheapest prices."""
    _ask_rome(page)
    _say(page, "Same in December?")
    page.wait_for_selector(".msg.tool:has-text('1 Dec')", timeout=60000)
    page.wait_for_function("[...document.querySelectorAll('.msg.ai')].filter(m => m.textContent.includes('Cheapest is')).length >= 2")
    tools = [m for m in chat["asked"][-1]["messages"] if m["role"] == "tool"]
    old, new = json.loads(tools[0]["content"]), json.loads(tools[1]["content"])
    assert old["earlier_search"] and "trips" not in old and len(tools[0]["content"]) < 400, old
    assert old["best"]["destination"] in ("ROM", "ATH") and old["cheapest_by_destination"]
    assert len(new["trips"]) == 5 and new["trips"][0]["depart"].startswith("2026-12")
    # The full digest is compact: whole prices, no ids the model can't use, and a warning written once for every trip it fits
    assert "search_id" not in new and all(isinstance(t["price"], int) and "warnings" not in t for t in new["trips"])
    assert all(isinstance(text, str) and set(nums) <= {1, 2, 3, 4, 5} for text, nums in new["trip_warnings"].items())
    assert len(tools[1]["content"]) < 1400


def test_summarize_keeps_a_brief_that_a_new_chat_can_continue(page, chat):
    _ask_rome(page)
    page.click("#chat-summarize")
    brief = page.locator(".msg.brief")
    brief.wait_for()
    assert "Rome or Athens, November" in brief.inner_text() and "One adult from Tel Aviv" in brief.inner_text()
    assert chat["asked"][-1]["json_mode"] is True
    page.click("#chat-new")
    home_brief = page.locator(".msg.brief", has_text="Rome or Athens, November")
    home_brief.wait_for()
    page.evaluate("writeForm({ ...readForm(), to: ['PAR'] })")
    home_brief.get_by_role("button", name="Continue").click()
    page.wait_for_selector(".msg.ai:has-text('Continuing')")
    assert page.evaluate("ac.to.get()") == ["ROM", "ATH"], "continuing a brief brings its search back into the form"
    _say(page, "Same but December")
    page.wait_for_selector(".msg.tool:has-text('1 Dec')", timeout=60000)
    system = chat["asked"][-1]["messages"][1]
    assert system["role"] == "system" and "# Rome or Athens, November" in system["content"]


def test_big_live_searches_wait_for_a_yes(page, chat):
    assert page.evaluate("Chat.needsConfirm(120, true, 0)") is True
    assert page.evaluate("Chat.needsConfirm(120, true, 120)") is False
    assert page.evaluate("Chat.needsConfirm(30, true, 0)") is False
    assert page.evaluate("Chat.needsConfirm(500, false, 0)") is False, "demo fares cost nothing"


def test_a_shared_search_link_fills_the_form(page, chat, base_url):
    link = page.evaluate("""Chat.shareLink(SkyhopLocal.models.searchRequest({ origin: 'TLV', destinations: ['LIS', 'OPO'],
        window_start: '2026-11-20', window_end: '2026-11-30', min_nights: 5, max_nights: 7, currency: 'EUR' }))""")
    assert link.startswith(base_url + "/#search=")
    page.goto("about:blank")
    page.goto(link)
    page.wait_for_function("typeof readForm === 'function' && !!ac.from && ac.to.get().length === 2")
    f = page.evaluate("readForm()")
    assert (f["to"], f["start"], f["end"], f["currency"]) == (["LIS", "OPO"], "2026-11-20", "2026-11-30", "EUR")
    assert "#search" not in page.url


def test_on_pages_the_chat_asks_to_sign_in_first(page, chat):
    if not chat["pages"]:
        pytest.skip("Pages build only")
    page.evaluate("localStorage.removeItem('skyhop.google')")
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    _open(page)
    assert page.locator("#chat-signin").is_visible() and not page.locator("#chat-form").is_visible()


def test_a_brief_saves_to_google_drive(page, chat):
    if not chat["pages"]:
        pytest.skip("Google Drive needs the Pages build's Google sign-in")
    gis = """window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken: () => setTimeout(() =>
      c.callback({ access_token: "tok-1", expires_in: 3599, scope: c.scope }), 0) }) } } };"""
    page.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(content_type="text/javascript", body=gis))

    def drive(route):
        req = route.request
        chat["drive"].append((req.method, req.url, req.post_data or ""))
        if "upload" in req.url:
            return route.fulfill(headers=CORS, json={"id": "f1", "webViewLink": "https://drive.google.com/file/f1"})
        if req.method == "POST":
            return route.fulfill(headers=CORS, json={"id": "folder1"})
        route.fulfill(headers=CORS, json={"files": []})
    page.route("https://www.googleapis.com/**", drive)
    _ask_rome(page)
    page.click("#chat-summarize")
    page.locator(".msg.brief").get_by_role("button", name="Save to Drive").click()
    page.wait_for_selector(".msg.brief a:has-text('in Google Drive')")
    upload = next(d for d in chat["drive"] if "upload" in d[1])
    assert '"parents":["folder1"]' in upload[2] and "# Rome or Athens, November" in upload[2] and "<!-- skyhop-brief" in upload[2]
    assert page.locator(".msg.brief a").get_attribute("href") == "https://drive.google.com/file/f1"


def test_the_chat_fits_a_phone(page, chat):
    page.set_viewport_size({"width": 360, "height": 800})
    chat_btn, builder_btn = page.locator("#chat-launch").bounding_box(), page.locator("#tb-launch").bounding_box()
    assert chat_btn["y"] + chat_btn["height"] <= builder_btn["y"], "the two launchers must not overlap"
    _open(page)
    box = page.locator("#chat").bounding_box()
    assert round(box["width"]) == 360 and page.locator("#chat-summarize").is_visible() and page.locator("#chat-new").is_visible()
    assert page.locator("#chat-input").bounding_box()["width"] > 200, "room to type on a phone"
    _say(page, ASK)
    page.wait_for_selector(".msg.ai:has-text('Cheapest is')", timeout=60000)
    page.click("#chat-new")
    page.locator(".chat-recent").wait_for()
    assert page.evaluate("document.querySelector('#chat-body').scrollWidth <= document.querySelector('#chat-body').clientWidth")
    send = page.locator("#chat-send").bounding_box()
    assert page.locator("#chat").bounding_box()["y"] == 0 and send["y"] + send["height"] <= 800, "the drawer stays put and Send stays on screen"


MAPS_GIS = """window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken: () => setTimeout(() =>
  c.callback({ access_token: "tok-1", expires_in: 3599, scope: c.scope }), 0) }) } } };"""
EXISTING = {"schema": 1, "id": "x", "title": "Portugal", "description": "", "updatedAt": "2026-10-01T00:00:00Z",
            "layers": [{"id": "l1", "name": "Lisbon sights", "visible": True, "color": "#1f6f5c", "style": "individual", "features": []}]}


@pytest.fixture
def maps(page, chat):
    """Google Drive as MyMaps AI uses it: one existing map; records every call."""
    if not chat["pages"]:
        pytest.skip("MyMaps AI maps live in Google Drive: Pages build only")
    calls = []

    def drive(route):
        req = route.request
        calls.append((req.method, req.url, req.post_data or ""))
        url = urlparse(req.url)
        if url.path.startswith("/upload/"):
            return route.fulfill(headers=CORS, json={"id": "m1" if req.method == "PATCH" else "newmap"})
        if url.path.endswith("/permissions"):
            return route.fulfill(headers=CORS, json={"id": "p1"})
        if url.path.endswith("/files/m1"):
            return route.fulfill(headers=CORS, content_type="application/json", body=json.dumps(EXISTING))
        if req.method == "POST":
            return route.fulfill(headers=CORS, json={"id": "folder9"})
        q = parse_qs(url.query).get("q", [""])[0]
        files = [{"id": "m1", "name": "Portugal.mymap.json"}] if "application/json" in q else []
        route.fulfill(headers=CORS, json={"files": files})
    page.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(content_type="text/javascript", body=MAPS_GIS))
    page.route("https://www.googleapis.com/**", drive)
    return calls


def _multipart_json(body):
    """The two JSON parts of a Drive multipart upload: metadata, content."""
    return [json.loads(part.split("\r\n\r\n", 1)[1].rsplit("\r\n", 1)[0]) for part in body.split("--skyhop")[1:3]]


def test_a_search_becomes_a_new_shared_mymaps_map(page, chat, maps):
    _ask_rome(page)
    page.get_by_role("button", name="🗺 Map it").click()
    page.wait_for_selector(".map-pick option:has-text('Add to: Portugal')", state="attached")
    page.locator(".map-pick input[type=checkbox]").check()
    page.get_by_role("button", name="Make map").click()
    link = page.locator(".msg.tool a:has-text('Open in MyMaps AI')")
    link.wait_for()
    assert link.get_attribute("href") == "https://alon24.github.io/mymaps-ai/#/m/newmap"
    meta, doc = _multipart_json(next(c for c in maps if "/upload/" in c[1])[2])
    assert meta["parents"] == ["folder9"] and meta["appProperties"] == {"app": "mymaps-ai"} and meta["name"].endswith(".mymap.json")
    (layer,) = doc["layers"]
    points = {f["properties"]["name"]: f for f in layer["features"] if f["geometry"]["type"] == "Point"}
    assert points["Tel-aviv (home)"]["geometry"]["coordinates"] == [34.887, 32.011], "GeoJSON order: longitude, latitude"
    rome = next(f for name, f in points.items() if name.startswith("Rom"))
    assert rome["properties"]["description"].startswith("From ")
    assert sum(f["geometry"]["type"] == "LineString" for f in layer["features"]) == 2
    assert any(c[0] == "POST" and c[1].endswith("/permissions?supportsAllDrives=true") and '"anyone"' in c[2] for c in maps)


def test_a_search_can_be_added_to_an_existing_map(page, chat, maps):
    _ask_rome(page)
    page.get_by_role("button", name="🗺 Map it").click()
    page.wait_for_selector(".map-pick option:has-text('Add to: Portugal')", state="attached")
    page.locator(".map-pick select").select_option(label="Add to: Portugal")
    page.get_by_role("button", name="Make map").click()
    page.wait_for_selector(".msg.tool a:has-text('Open in MyMaps AI')")
    method, url, body = next(c for c in maps if "/upload/" in c[1])
    assert method == "PATCH" and "/files/m1?uploadType=media" in url
    doc = json.loads(body)
    assert [l["name"] for l in doc["layers"]][0] == "Lisbon sights" and len(doc["layers"]) == 2
    assert doc["layers"][1]["color"] != "#1f6f5c", "the new layer gets a colour the map doesn't use yet"
    assert not any("/permissions" in c[1] for c in maps), "not shared unless asked"


def test_the_map_picker_fits_a_phone(page, chat, maps):
    page.set_viewport_size({"width": 360, "height": 800})
    _ask_rome(page)
    page.get_by_role("button", name="🗺 Map it").click()
    page.wait_for_selector(".map-pick option:has-text('Add to: Portugal')", state="attached")
    for part in (".map-pick select", ".map-pick input[type=checkbox]", ".map-pick button >> nth=0", ".map-pick button >> nth=1"):
        box = page.locator(part).bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 360, f"{part} is off screen"
