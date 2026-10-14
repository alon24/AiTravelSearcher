"""Travel Hub link (web/hub.js): the hub opens Skyhop with its trip filled in, and "Save to Travel Hub" sends the picked
flights back to the hub as #/handoff/<base64url JSON> (the contract pinned by tests/fixtures/travel-hub-handoff.json)."""
import base64
import json

import pytest

pytest.importorskip("playwright.sync_api")

HUB = "http://localhost:9/travel-hub/"
QUERY = f"?from=TLV&to=LIS&back=OPO&start=2026-11-13&end=2026-11-22&nights=3&adults=3&trip=trip_abc123&hub={HUB}"


def _open_from_hub(page, base_url):
    page.goto(base_url + "/" + QUERY)
    page.wait_for_function("typeof readForm === 'function' && !!ac.from && readForm().to.length > 0")


def test_the_hub_link_fills_the_search(page, base_url):
    _open_from_hub(page, base_url)
    f = page.evaluate("readForm()")
    assert (f["from"], f["to"], f["back"]) == (["TLV"], ["LIS"], ["OPO"])
    assert (f["start"], f["end"], f["nmin"], f["nmax"], f["adults"]) == ("2026-11-13", "2026-11-22", 3, 3, 3)
    assert page.locator("#expert").is_checked()
    assert "from=" not in page.url                                    # the link is consumed, a reload starts clean
    assert page.evaluate("JSON.parse(localStorage.getItem('skyhop.hub'))") == {"trip": "trip_abc123", "hub": HUB}


def test_a_whole_country_from_the_hub_searches_all_its_airports(page, base_url):
    page.goto(base_url + "/?from=TLV&to=LIS,OPO,FAO&start=2026-11-13&end=2026-11-22&nights=3&adults=2")
    page.wait_for_function("typeof readForm === 'function' && !!ac.from && readForm().to.length > 0")
    f = page.evaluate("readForm()")
    assert (f["to"], f["back"]) == (["LIS", "OPO", "FAO"], [])


@pytest.mark.parametrize("size", [(1280, 720), (390, 844)])
def test_find_flights_is_ready_to_press_when_you_arrive_from_the_hub(page, base_url, size):
    page.set_viewport_size({"width": size[0], "height": size[1]})
    _open_from_hub(page, base_url)
    page.wait_for_function("document.activeElement && document.activeElement.id === 'go'")
    # On screen and not hidden under the floating Trip builder button
    assert page.evaluate("""() => { const b = document.querySelector('#go').getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return b.top >= 0 && b.bottom <= innerHeight && !!hit && !!hit.closest('#go'); }""")


def test_save_to_travel_hub_sends_the_picked_flights(page, base_url):
    _open_from_hub(page, base_url)
    page.route(HUB, lambda r: r.fulfill(status=200, content_type="text/html", body="<title>hub</title>"))
    page.click("#go")
    save = page.locator(".trip .hub-save").first
    save.wait_for(timeout=60000)
    assert save.inner_text() == "✈ Save to my Travel Hub trip"
    save.click()
    page.wait_for_url(HUB + "#/handoff/*")
    b64 = page.url.split("#/handoff/")[1]
    data = json.loads(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)))
    assert (data["v"], data["kind"], data["source"], data["tripId"], data["adults"]) == (1, "flights", "skyhop", "trip_abc123", 3)
    legs = data["legs"]
    assert legs[0]["origin"] == "TLV" and legs[0]["destination"] == "LIS"
    assert legs[-1]["origin"] == "OPO" and legs[-1]["destination"] == "TLV"   # open-jaw: home from Porto
    assert all(l["price"] > 0 for l in legs) and data["names"]["LIS"] == "Lisbon"


def test_without_a_hub_trip_the_button_still_starts_one(page):
    page.evaluate("""() => { const f = readForm(); f.to = ['LIS']; f.start = '2026-11-13'; f.end = '2026-11-22';
                          f.lenMode = 'exact'; f.nmin = 3; f.nmax = 3; writeForm(f); onFormChange(); }""")
    page.wait_for_function("!document.querySelector('#go').disabled")
    page.click("#go")
    save = page.locator(".trip .hub-save").first
    save.wait_for(timeout=60000)
    assert save.inner_text() == "✈ Save to Travel Hub"


def test_the_trip_builder_can_send_its_flights_too(page, base_url):
    _open_from_hub(page, base_url)
    page.route(HUB, lambda r: r.fulfill(status=200, content_type="text/html", body="<title>hub</title>"))
    page.click("#go")
    page.get_by_role("button", name="＋ Add all flights to Trip builder").first.click(timeout=60000)
    page.click("#tb-launch")
    page.locator("#tb .hub-save").click()
    page.wait_for_url(HUB + "#/handoff/*")
    b64 = page.url.split("#/handoff/")[1]
    data = json.loads(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)))
    assert [l["origin"] for l in data["legs"]] == ["TLV", "OPO"] and data["tripId"] == "trip_abc123"
