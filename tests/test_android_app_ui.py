"""The Skyhop Android app's page (android/, tests/test_android_app.py): the Pages build with the app's script and a
stand-in for its Java side, whose airline tab is a same-origin frame so the extension's drivers can run in it."""
import base64
import json
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip("playwright.sync_api")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from build_android import bundle  # noqa: E402

from test_account_ui import CORS, WORKER, worker  # noqa: E402,F401  (the fake Worker and Google)

WIZZ = "https://www.wizzair.com/en-gb/booking/select-flight/TLV/BUD/2026-11-02/null/1/0/0/null"

# The Java side as the page sees it: the airline tab is a frame on this origin, so the scripts can run in it.
NATIVE = """
if (window === window.top) {
  window.__native = { opened: [], signIns: [] };
  let frame = null, url = "";
  window.SkyhopNative = {
    openTab(u) {
      __native.opened.push(u); url = u;
      if (!frame) { frame = document.createElement("iframe"); frame.id = "airline-tab"; frame.style.cssText = "width:900px;height:600px"; document.body.append(frame); }
      frame.onload = () => { frame.contentWindow.SkyhopAirline = { send: (id, json) => setTimeout(() => SkyhopShim.fromAirline(id, json), 0) }; };
      frame.src = "/__airline__?u=" + encodeURIComponent(u);
    },
    tabState() {
      const d = frame && frame.contentDocument, ready = d && d.readyState === "complete" && d.location.pathname === "/__airline__";
      return JSON.stringify({ url, status: ready ? "complete" : "loading" });
    },
    exec(id, code) { setTimeout(() => { let v = null; try { v = frame.contentWindow.eval(code); } catch { v = null; } SkyhopShim.done(id, v); }, 0); },
    toAirline(id, json) { setTimeout(() => frame.contentWindow.__skyhopBridge.reply(id, json), 0); },
    signIn(scope, hint) { __native.signIns.push([scope, hint]); },
    version() { return "test"; },
  };
}
"""
# Wizz Air's results page, reduced to one flight card.
AIRLINE_PAGE = """<!doctype html><html><body><h1>Select your flight</h1>
<div class="card"><span>06:00</span> TLV <span>08:05</span> BUD <span>€ 49.99</span> <button>Select</button></div>
<div class="card"><span>13:40</span> TLV <span>15:45</span> BUD <span>€ 79.99</span> <button>Select</button></div>
</body></html>"""


def _raw(token):
    return base64.urlsafe_b64encode(json.dumps(token).encode()).decode().rstrip("=")


@pytest.fixture
def app(page, worker):
    """The Pages build as the Android app shows it: the stand-in Java bridge, then the app's script."""
    worker["decide"] = []

    def decide(route):
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        worker["decide"].append(json.loads(route.request.post_data))
        route.fulfill(headers=CORS, json={"answers": {"q": {"noul": 0.9}}})

    page.route(f"{WORKER}/decide", decide)
    page.route("**/__airline__*", lambda r: r.fulfill(content_type="text/html", body=AIRLINE_PAGE))
    page.add_init_script(NATIVE)
    page.add_init_script(bundle())
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    return worker


def _app_sign_in(p, token=None):
    asked = p.evaluate("__native.signIns.length")
    p.locator(".account-btn:visible").click()
    p.wait_for_function("n => __native.signIns.length > n", arg=asked)
    token = token or {"token": "tok-1", "until": int(time.time() * 1000) + 3_000_000, "scopes": ["openid", "email"]}
    p.evaluate("raw => dispatchEvent(new CustomEvent('skyhop-app-token', { detail: { raw } }))", _raw(token))


def test_signing_in_in_the_app_goes_through_the_phones_browser(page, app):
    _app_sign_in(page)
    assert page.evaluate("__native.signIns") == [["openid email", ""]]
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")
    assert page.locator(".account-btn:visible").inner_text() == "Sign out"


def test_a_cancelled_or_broken_app_sign_in_says_so(page, app):
    page.locator(".account-btn:visible").click()
    page.wait_for_function("__native.signIns.length === 1")
    page.evaluate("dispatchEvent(new CustomEvent('skyhop-app-token', { detail: { error: 'Sign-in was cancelled in the browser' } }))")
    page.wait_for_selector("text=Sign-in was cancelled in the browser")
    _app_sign_in(page, token={"token": "tok-1", "until": 1000, "scopes": []})   # already expired
    page.wait_for_selector("text=The browser handed the app an unusable Google sign-in; try again")
    assert page.inner_text("#mode-badge-desk") == "⚠ DEMO DATA"


def test_assist_is_on_in_the_app_and_always_uses_jev(page, app):
    page.wait_for_function("document.documentElement.dataset.skyhopDecider === 'jev'")
    assert page.locator(".ext-badge:visible").text_content() == "✈ Assist on"
    assert "built into the app" in page.locator(".ext-badge:visible").get_attribute("title")
    page.locator(".dec-badge:visible").click()
    page.wait_for_selector("text=The app always uses Jev: Laya runs only on a computer")
    assert page.evaluate("document.documentElement.dataset.skyhopDecider") == "jev"


def test_select_on_site_finds_the_flight_in_the_airline_tab_with_jev(page, app):
    _app_sign_in(page)
    page.wait_for_function("document.querySelector('#mode-badge-desk').textContent === 'LIVE'")
    page.evaluate("selectOnAirlineSite('W6', 'TLV', 'BUD', '2026-11-02', 'W62326', '06:00')")
    page.wait_for_function("__native.opened.length === 1")
    assert page.evaluate("__native.opened") == [WIZZ], "the airline's own search, filled in"
    banner = page.frame_locator("#airline-tab").locator("#skyhop-status-banner")
    banner.filter(has_text="cheapest fare").wait_for(timeout=30000)
    assert banner.inner_text() == ("Skyhop Assist (Jev): 06:00: cheapest fare 49.99 outlined (fares on this flight: 49.99). "
                                   "A lower price can be a members-only fare. Not pressed -- you choose.")
    assert app["decide"], "Jev was asked through the Worker"
    assert ("/health", True) in app["asked"], "with the app's Google sign-in"


def test_without_sign_in_the_airline_tab_says_why_jev_cant_help(page, app):
    page.evaluate("selectOnAirlineSite('W6', 'TLV', 'BUD', '2026-11-02', 'W62326', '06:00')")
    banner = page.frame_locator("#airline-tab").locator("#skyhop-status-banner")
    banner.filter(has_text="sign in").wait_for(timeout=30000)
    assert banner.inner_text() == ("Skyhop Assist: can't ask its decision model: "
                                   "sign in to Skyhop first (Jev needs your Google sign-in, on an invited account)")
    assert not app["decide"]


def test_the_airline_tab_can_only_ask_assist_questions(page, app):
    page.evaluate("selectOnAirlineSite('W6', 'TLV', 'BUD', '2026-11-02', 'W62326', '06:00')")
    page.wait_for_function("!!document.querySelector('#airline-tab') && !!document.querySelector('#airline-tab').contentWindow.__skyhopBridge", timeout=30000)
    answer = page.frame_locator("#airline-tab").locator("body").evaluate(
        "() => new Promise(ok => chrome.runtime.sendMessage({ type: 'set-jev-route', route: { url: 'https://evil.example' } }, ok))")
    assert answer == {"ok": False, "error": "not a Skyhop Assist message"}


# ------------------------------------------------------------------------------------- the phone's browser
def test_the_browser_signs_in_for_the_app_and_hands_the_token_back(page, worker, base_url):
    page.goto(base_url + "/?app-sign-in=1&scope=openid+email&hint=")
    dialog = page.get_by_role("dialog", name="Sign in for the Skyhop app")
    dialog.get_by_role("button", name="Sign in with Google").click()
    back = dialog.get_by_role("link", name="Back to the Skyhop app")
    back.wait_for()
    href = back.get_attribute("href")
    assert href.startswith("skyhop://signed-in?t=")
    raw = href.split("t=", 1)[1]
    token = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert token["token"] == "tok-1" and token["scopes"] == ["openid", "email"] and token["until"] > time.time() * 1000


def test_the_browser_refuses_a_sign_in_link_asking_for_more(page, worker, base_url):
    page.goto(base_url + "/?app-sign-in=1&scope=openid+https://mail.google.com/")
    dialog = page.get_by_role("dialog", name="Sign in for the Skyhop app")
    dialog.get_by_text("asks for access Skyhop never uses").wait_for()
    assert dialog.get_by_role("button", name="Sign in with Google").count() == 0 or not dialog.get_by_role("button").is_visible()
