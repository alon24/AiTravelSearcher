"""Google sign-in on the GitHub Pages build (web/local/account.js): signed in, searches use real fares through Skyhop's
Cloudflare Worker (worker/). Google's script and the Worker are faked here; worker/test/ covers the Worker itself."""
import json
import re
from urllib.parse import parse_qs, urlparse

import pytest

pytest.importorskip("playwright.sync_api")

WORKER = "https://worker.test"
RUNTIME = 'window.SKYHOP_RUNTIME = {"backend": "browser", "workerUrl": "%s", "googleClientId": "client-1"};' % WORKER
GIS_STUB = """window.google = { accounts: { oauth2: {
  initTokenClient: c => ({ requestAccessToken: () => setTimeout(() => c.callback({ access_token: "tok-1", expires_in: 3599 }), 0) }),
} } };"""
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type"}


def _fares(q):
    """A SerpApi answer for one lookup: one nonstop Zed Air flight."""
    o, d, day = q["origin"][0], q["dest"][0], q["date"][0]
    return {"best_flights": [{"price": 101, "flights": [{
        "departure_airport": {"id": o, "time": f"{day} 08:00"}, "arrival_airport": {"id": d, "time": f"{day} 11:00"},
        "airline": "Zed Air", "flight_number": "ZZ 101", "duration": 180}]}], "other_flights": []}


def _google(q):
    """The Worker's /gflights answer for one lookup: Google's result groups with one nonstop Gee Air flight, and the
    Google Flights page they came from."""
    o, d, day = q["origin"][0], q["dest"][0], q["date"][0]
    ymd = [int(x) for x in day.split("-")]
    seg = [None] * 23
    seg[3], seg[6], seg[8], seg[10], seg[11], seg[20], seg[21] = o, d, [9], [12], 180, ymd, ymd
    seg[14], seg[17], seg[22] = "29 in", "Airbus A320", ["GG", "7", None, "Gee Air"]
    flight = [None, None, [seg]] + [None] * 19 + [[None, None, -10, None, None, 1, 1, 180000, 200000]]
    return {"groups": [[flight, [[None, 77]]]], "url": f"https://www.google.com/travel/flights?tfs={o}{d}{day}&curr=EUR",
            "usual": [60, 110]}


@pytest.fixture
def worker(page, base_url):
    """Point the page at a fake Worker and Google; `state` sets who the Worker accepts and records what it was asked."""
    if not base_url.endswith("/skyhop"):
        pytest.skip("sign-in exists only on the Pages build")
    state = {"user": "ilan@example.com", "guest": None, "serpapi": True, "gflights": None, "links": None, "asked": [], "revoked": []}

    def answer(route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        url = urlparse(req.url)
        signed = req.headers.get("authorization") == "Bearer tok-1"
        state["asked"].append((url.path, signed))
        if url.path == "/health":
            body = {"links": state["links"] is not None, "gflights": bool(state["gflights"]), "serpapi": state["serpapi"], "jev": True, "sign_in": True, "user": state["user"] if signed else None,
                    "guest": state["guest"] if signed else None}
        elif not (signed and state["user"]):
            return route.fulfill(status=401, headers=CORS, json={"error": "sign in"})
        elif url.path == "/links":
            body = state["links"]
        elif url.path == "/gflights":
            if state["gflights"] == "blocked":
                return route.fulfill(status=502, headers=CORS, json={"error": "Google returned no result data (a robot check)"})
            body = _google(parse_qs(url.query))
        elif state.get("serpapi_down"):
            return route.fulfill(status=502, headers=CORS, json={"error": "SerpApi: Invalid API key"})
        else:
            body = _fares(parse_qs(url.query))
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps(body))

    page.route(f"{WORKER}/**", answer)
    page.route("**/skyhop/runtime.js", lambda r: r.fulfill(content_type="text/javascript", body=RUNTIME))
    page.route("https://oauth2.googleapis.com/revoke", lambda r: (state["revoked"].append(r.request.post_data), r.fulfill(status=200)))
    page.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(content_type="text/javascript", body=GIS_STUB))
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    return state


def _fill(p, end="2026-11-06", nights=3):
    p.evaluate("""([end, n]) => { const f = readForm(); f.to = ['ROM']; f.start = '2026-11-02'; f.end = end;
                                  f.lenMode = 'range'; f.nmin = n; f.nmax = n; writeForm(f); onFormChange(); }""", [end, nights])
    p.wait_for_function("!document.querySelector('#go').disabled")


def _sign_in(p):
    p.locator(".account-btn:visible").click()
    p.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")


def test_without_a_worker_there_is_no_sign_in(page):
    assert page.locator(".account-btn:visible").count() == 0


def test_signing_in_turns_on_real_fares_from_the_worker(page, worker):
    button = page.locator(".account-btn:visible")
    assert button.inner_text() == "Sign in" and page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA"
    _sign_in(page)
    assert button.inner_text() == "Sign out" and "ilan@example.com" in button.get_attribute("title")
    _fill(page)
    page.wait_for_function("/SerpApi credits/.test(document.querySelector('#estimate-text').textContent)")
    page.click("#go")
    page.wait_for_selector("text=serpapi ×4", timeout=60000)      # 4 lookups, all from the Worker
    lookups = [signed for path, signed in worker["asked"] if path == "/serpapi"]
    assert lookups and all(lookups), "every fare lookup goes to the Worker with the Google token"
    assert "Zed Air" in page.inner_text("main")


def test_free_google_flights_fares_come_first(page, worker):
    worker["gflights"] = "ok"
    _sign_in(page)
    _fill(page)
    page.wait_for_function("/free; up to \\d+ SerpApi credits only if Google refuses/.test(document.querySelector('#estimate-text').textContent)")
    page.click("#go")
    page.wait_for_selector("text=gflights ×4", timeout=60000)
    assert "Gee Air" in page.inner_text("main")
    # what Google shows per flight, and a link back to the exact Google search that priced it
    leg = page.locator(".leg").first
    assert "Airbus A320 · 29 in legroom" in leg.inner_text() and "180 kg CO₂ · 10% below typical" in leg.inner_text()
    assert re.search(r"Google: this search usually costs \D*60\D*–\D*110", leg.inner_text())
    href = leg.get_by_role("link", name="Google Flights ↗").get_attribute("href")
    assert href.startswith("https://www.google.com/travel/flights?tfs=") and href.endswith("&curr=EUR")
    assert not [p for p, _ in worker["asked"] if p == "/serpapi"], "no SerpApi credits spent while Google answers"


def test_serpapi_answers_when_google_refuses_the_worker(page, worker):
    worker["gflights"] = "blocked"
    _sign_in(page)
    _fill(page)
    page.click("#go")
    page.wait_for_selector("text=serpapi ×4", timeout=60000)
    assert "Zed Air" in page.inner_text("main")
    assert "4 lookup(s) used the backup provider; first: gflights failed (Google returned no result data (a robot check)), " \
           "so serpapi answered" in page.inner_text("main"), "the page says why credits were spent"


def test_when_google_and_serpapi_both_fail_both_reasons_are_shown(page, worker):
    worker["gflights"], worker["serpapi_down"] = "blocked", True
    _sign_in(page)
    _fill(page, end="2026-11-04", nights=1)
    page.click("#go")
    page.wait_for_selector("text=SerpApi: Invalid API key", timeout=60000)
    assert "gflights: Google returned no result data (a robot check); serpapi: SerpApi: Invalid API key" in page.inner_text("main")


def test_live_fares_need_no_serpapi_key(page, worker):
    worker["gflights"], worker["serpapi"] = "ok", False
    _sign_in(page)
    _fill(page, end="2026-11-04", nights=1)
    page.click("#go")
    page.wait_for_selector("text=gflights ×", timeout=60000)


def test_sign_in_survives_a_reload_and_sign_out_returns_to_demo(page, worker):
    _sign_in(page)
    page.reload()
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")
    page.locator(".account-btn:visible").click()
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === '⚠ DEMO DATA'")
    assert worker["revoked"] == ["token=tok-1"], "the token is handed back to Google"
    assert page.locator(".account-btn:visible").inner_text() == "Sign in"
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    assert page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA"


def test_an_account_the_worker_refuses_stays_on_demo_fares(page, worker):
    worker["user"] = None
    page.locator(".account-btn:visible").click()
    page.wait_for_selector(".toast:has-text(\"didn't confirm\")")
    assert page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA"
    assert page.locator(".account-btn:visible").inner_text() == "Sign in"


def test_an_account_not_on_the_list_is_a_guest_on_demo_fares(page, worker):
    worker["user"], worker["guest"] = None, "dana@example.com"
    page.locator(".account-btn:visible").click()
    page.wait_for_selector(".toast:has-text('trips shared with you')")
    assert page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA", "a guest never spends the owner's credits outside a trip"
    assert page.locator(".account-btn:visible").inner_text() == "Sign out"


def test_signed_in_before_live_fares_are_set_up_says_so(page, worker):
    worker["serpapi"] = False
    page.locator(".account-btn:visible").click()
    page.wait_for_selector(".toast:has-text(\"aren't set up\")")
    assert page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA"
    assert page.locator(".account-btn:visible").inner_text() == "Sign out"


def test_a_token_that_expires_mid_session_signs_out(page, worker):
    _sign_in(page)
    worker["user"] = None                     # Google no longer vouches for the token
    _fill(page, end="2026-11-04", nights=1)
    page.click("#go")
    page.wait_for_selector(".toast:has-text('Sign in again')")
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === '⚠ DEMO DATA'")
    assert page.locator(".account-btn:visible").inner_text() == "Sign in"


def test_sign_in_fits_the_phone_top_bar(page, worker):
    page.set_viewport_size({"width": 360, "height": 800})
    button = page.locator(".topbar .account-btn")
    assert button.is_visible() and button.inner_text() == "Sign in"
    assert page.locator(".topbar .theme-toggle").is_visible()
    box = page.locator(".topbar .theme-toggle").bounding_box()
    assert box["x"] + box["width"] <= 360, "the top bar must not spill off a phone screen"
    assert page.evaluate("document.documentElement.scrollWidth") <= 360


def test_the_airline_assist_extension_gets_the_worker_for_jev(page, worker):
    """No local server on the web version: the page hands the extension its Worker and sign-in (content-bridge.js)."""
    page.evaluate("window.routes = []; addEventListener('skyhop-jev-route', e => routes.push(e.detail.route))")
    _sign_in(page)
    page.wait_for_function("routes.some(r => r)")
    route = [r for r in page.evaluate("routes") if r][-1]
    assert route["url"] == WORKER and route["token"] == "tok-1" and route["until"] > 0
    page.locator(".account-btn:visible").click()
    page.wait_for_function("routes.length && routes[routes.length - 1] === null")


def test_search_links_learned_on_the_computer_work_on_the_phone(page, worker):
    """The desktop extension shares the links it learns through the Worker; a phone uses them for "Search on <airline> site"."""
    worker["links"] = {"ZZ": {"generic": "https://www.zed.example/search/{origin:l}-{destcity}/{date:DDMMYYYY}"}}
    page.set_viewport_size({"width": 390, "height": 844})
    _sign_in(page)
    _fill(page, end="2026-11-04", nights=1)
    page.click("#go")
    btn = page.locator(".site-btn:visible", has_text="Search on Zed Air site").first
    btn.wait_for(timeout=60000)
    assert re.fullmatch(r"https://www\.zed\.example/search/tlv-ROM/0[2-4]112026", btn.get_attribute("href"))


# ---------------------------------------------------------------------------- one sign-in for the suite (travel-hub)
HUB = "travel-hub.session"
DRIVE = "https://www.googleapis.com/auth/drive.file"


def _hub(p, session=None):
    """Travel Hub AI's stored sign-in on this origin: set it (a dict, or the token with an hour left) or read it."""
    if session is None:
        return p.evaluate("k => JSON.parse(localStorage.getItem(k))", HUB)
    if isinstance(session, str):
        session = {"token": session, "expires": p.evaluate("Date.now()") + 3_600_000, "email": "ilan@example.com", "name": "Ilan",
                   "scopes": ["openid", "email", "profile", DRIVE]}
    p.evaluate("([k, s]) => localStorage.setItem(k, JSON.stringify(s))", [HUB, session])


def test_signed_in_to_the_hub_is_signed_in_to_skyhop(page, worker):
    _hub(page, "tok-1")
    page.reload()
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")
    assert page.locator(".account-btn:visible").inner_text() == "Sign out"
    assert ("/health", True) in worker["asked"], "the hub's token goes to Skyhop's Worker"
    assert page.evaluate("SkyhopLocal.account.hasDrive()"), "Save to Drive needs no second popup"


def test_signing_in_or_out_of_skyhop_does_the_same_in_the_hub(page, worker):
    _sign_in(page)
    hub = _hub(page)
    assert hub["token"] == "tok-1" and hub["email"] == "ilan@example.com" and hub["expires"] > page.evaluate("Date.now()") + 3_000_000
    assert hub["scopes"] == ["openid", "email", "profile", DRIVE], "the suite's scopes, so MyMaps AI can open its maps with it"
    page.locator(".account-btn:visible").click()
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === '⚠ DEMO DATA'")
    assert _hub(page) is None, "the revoked token is gone from the hub too"


def test_a_hub_signed_in_as_someone_else_is_left_alone(page, worker):
    other = {"token": "tok-other", "expires": page.evaluate("Date.now()") + 3_600_000, "email": "dana@example.com"}
    _hub(page, other)
    page.evaluate("localStorage.setItem('skyhop.google', JSON.stringify({token: 'tok-1', until: Date.now() + 3e6, email: 'ilan@example.com', scopes: ['openid', 'email']}))")
    page.reload()
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")
    page.locator(".account-btn:visible").click()          # Skyhop's own sign-in wins in Skyhop; signing out of it...
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === '⚠ DEMO DATA'")
    assert _hub(page) == other, "...doesn't touch the hub's other account"


def test_an_expired_or_refused_hub_sign_in_is_not_used(page, worker):
    _hub(page, {"token": "tok-1", "expires": page.evaluate("Date.now()") + 30_000, "email": "ilan@example.com"})
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    assert page.locator(".account-btn:visible").inner_text() == "Sign in", "under a minute left: the hub would refuse it too"
    _hub(page, "tok-dead")                                # Google no longer vouches for it
    page.reload()
    page.wait_for_function("document.querySelector('.account-btn:not([hidden])') && !!localStorage.getItem('travel-hub.session') === false")
    assert page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA"
    assert page.locator(".account-btn:visible").inner_text() == "Sign in"
