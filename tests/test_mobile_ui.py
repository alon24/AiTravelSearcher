"""The phone layout (web/mobile.js): a 4-step search wizard, results as top picks plus a short list of compact trips (tap one
for its flights, full screen), the chart and Mix & match in tabs, and a bottom bar instead of the floating launchers."""
import re

import pytest

pytest.importorskip("playwright.sync_api")

PHONE = {"width": 390, "height": 844}


def _fill(p):
    p.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR']; f.start = '2026-11-02'; f.end = '2026-11-12';
                          f.lenMode = 'range'; f.nmin = 3; f.nmax = 4; writeForm(f); onFormChange(); }""")


@pytest.fixture
def phone(page):
    page.set_viewport_size(PHONE)
    page.wait_for_function("document.querySelector('#form').classList.contains('wz')")
    return page


@pytest.fixture
def results(phone):
    _fill(phone)
    phone.wait_for_function("!document.querySelector('#go').disabled")
    phone.click("#go")
    phone.wait_for_selector(".m-results", timeout=60000)
    return phone


def _price(text):
    return float(re.sub(r"[^\d.]", "", text))


# ---------------------------------------------------------------------------- wizard
def test_the_form_is_one_step_at_a_time(phone):
    phone.evaluate("ac.to.set([]); onFormChange(); Mobile.wizardTo(1)")
    assert phone.locator(".wz-title").inner_text() == "Step 1 of 4 · Where"
    assert phone.locator("#ac-to").is_visible() and not phone.locator("#start").is_visible() and not phone.locator("#go").is_visible()
    phone.click(".wz-next")                                              # no destination yet: says so and stays
    assert phone.locator("#form-error").inner_text() == "Pick at least one destination."
    assert phone.locator(".wz-title").inner_text() == "Step 1 of 4 · Where"
    phone.evaluate("ac.to.set(['ROM']); onFormChange(); Mobile.wizardTo(1)")
    phone.click(".wz-next")
    assert phone.locator(".wz-title").inner_text() == "Step 2 of 4 · When"
    assert phone.locator("#start").is_visible() and phone.locator("#end").is_visible() and not phone.locator("#ac-to").is_visible()
    phone.click(".wz-next")
    assert phone.locator("#adults").is_visible() and not phone.locator("#start").is_visible()
    phone.click(".wz-next")
    review = phone.locator(".wz-review").inner_text()
    assert "TLV → ROM" in review and "1 adult" in review
    assert phone.locator("#go").is_visible() and phone.locator("[name=currency]").first.is_visible()
    phone.locator(".wz-row", has_text="When").click()                    # each review line jumps back to its step
    assert phone.locator(".wz-title").inner_text() == "Step 2 of 4 · When"


def test_a_filled_form_opens_on_the_review_and_searches_from_there(phone):
    _fill(phone)
    assert phone.locator(".wz-title").inner_text() == "Step 4 of 4 · Review"
    phone.click("#go")
    phone.wait_for_selector(".m-results", timeout=60000)
    assert phone.locator("#step-panel").is_hidden()


def test_start_over_clears_the_form_and_returns_to_step_one(phone):
    _fill(phone)
    assert phone.locator(".wz-title").inner_text() == "Step 4 of 4 · Review"
    phone.click(".wz-reset")
    assert phone.locator(".wz-title").inner_text() == "Step 1 of 4 · Where"
    assert phone.evaluate("readForm().to.length") == 0


def test_search_now_skips_the_remaining_steps(phone):
    _fill(phone)
    phone.evaluate("Mobile.wizardTo(2)")
    phone.click(".wz-now")
    phone.wait_for_selector(".m-results", timeout=60000)


def test_the_desktop_form_is_not_a_wizard(page):
    assert page.locator(".wz-head").is_hidden() and page.locator(".wz-nav").is_hidden()
    assert page.locator("#ac-to").is_visible() and page.locator("#start").is_visible() and page.locator("#adults").is_visible()
    assert page.locator(".m-nav").is_hidden()


# ---------------------------------------------------------------------------- results
def test_results_fit_a_few_screens_and_never_scroll_sideways(results):
    p = results
    assert p.evaluate("document.documentElement.scrollWidth") <= PHONE["width"]
    assert p.evaluate("document.documentElement.scrollHeight") < 5 * PHONE["height"], "the old phone page was ~30 screens"
    assert p.locator(".card.trip").count() == 0, "no full trip cards until one is tapped"
    assert p.locator(".cmp-table").count() == 0


def test_top_picks_come_first_and_the_cheapest_is_the_lowest_price(results):
    p = results
    first = p.locator(".m-picks .m-card").first
    assert "CHEAPEST" in first.locator(".m-labels").inner_text().upper()
    prices = [_price(t) for t in p.locator(".m-rows .m-price").all_inner_texts()]
    assert _price(first.locator(".m-price").inner_text()) == min(prices)
    assert prices == sorted(prices)                                       # the list starts sorted by price
    labels = " ".join(p.locator(".m-picks .m-labels").all_inner_texts()).upper()
    assert "BEST VALUE" in labels and "FASTEST" in labels


def test_the_list_shows_ten_at_a_time_and_filters(results):
    p = results
    total = int(re.search(r"\d+", p.locator(".m-count").inner_text()).group())
    assert total > 10 and p.locator(".m-rows .m-card").count() == 10
    p.click(".m-more")
    assert p.locator(".m-rows .m-card").count() == min(20, total)
    p.locator(".m-tools .cmp-chip", has_text=re.compile(r"^PAR$")).click()
    dests = p.locator(".m-rows .m-dest").evaluate_all("els => els.map(e => e.firstChild.textContent)")
    assert dests and set(dests) == {"PAR"}
    assert re.fullmatch(r"\d+ of \d+ trips", p.locator(".m-count").inner_text())
    p.locator(".m-tools .cmp-chip", has_text=re.compile(r"^PAR$")).click()
    p.locator(".m-tools .cmp-chip", has_text="Direct").click()
    assert all(", direct" in t or "· direct ·" in t for t in p.locator(".m-rows .m-line.sub").all_inner_texts())
    p.select_option(".m-tools select", "travel")
    assert p.locator(".m-tools select").input_value() == "travel"


def test_tapping_a_trip_opens_it_full_screen_and_back_closes_it(results):
    p = results
    card = p.locator(".m-picks .m-card").first
    price = card.locator(".m-price").inner_text()
    card.click()
    sheet = p.locator(".m-sheet")
    assert sheet.is_visible() and sheet.locator(".card.trip .trip-price .p").inner_text() == price
    box = sheet.bounding_box()
    assert (box["width"], box["height"]) == (PHONE["width"], PHONE["height"])
    assert sheet.locator(".leg .btn", has_text="Google Flights").first.is_visible(), "where the price came from stays in view"
    assert not sheet.locator(".leg .btn", has_text="All flights that day").first.is_visible()
    sheet.locator(".more-acts summary").first.click()                   # the less used actions fold under "More"
    assert sheet.locator(".leg .btn", has_text="All flights that day").first.is_visible()
    sheet.locator("button", has_text="Back").click()
    assert p.locator(".m-sheet").count() == 0
    p.locator(".m-rows .m-card").first.click()
    p.go_back()                                                           # the phone's own Back button
    p.wait_for_function("!document.querySelector('.m-sheet')")
    assert p.locator(".m-results").is_visible(), "Back closed the trip, not the page"


def test_the_chart_and_mix_and_match_are_tabs(results):
    p = results
    assert p.locator(".chart").is_hidden() and p.locator(".mm").is_hidden()
    p.click(".m-nav [data-nav=days]")
    assert p.locator(".chart").is_visible() and p.locator(".m-tabs [aria-selected=true]").inner_text() == "Days"
    p.wait_for_selector(".chart svg")
    assert p.locator(".m-pane[data-pane=days] .m-card").count() == 1    # the selected day's trip, compact
    p.locator(".m-tabs button", has_text="Mix & match").click()
    assert p.locator(".mm").is_visible() and p.locator(".chart").is_hidden()


# ---------------------------------------------------------------------------- bottom bar
def test_the_bottom_bar_replaces_the_floating_launchers(results):
    p = results
    assert p.locator("#tb-launch").is_hidden() and p.locator("#chat-launch").is_hidden()
    nav = p.locator(".m-nav").bounding_box()
    assert nav["y"] + nav["height"] == pytest.approx(PHONE["height"], abs=1) and nav["width"] == PHONE["width"]
    p.locator(".m-picks .m-card").first.click()
    p.locator(".m-sheet .btn", has_text="Add all flights to Trip builder").click()
    p.locator(".m-sheet button", has_text="Back").click()
    assert p.locator(".m-nav [data-nav=trip] b").inner_text() == p.locator("#tb-count").inner_text() != "0"
    p.click(".m-nav [data-nav=trip]")
    p.wait_for_selector("#tb.open")
    p.click("#tb-close")
    p.click(".m-nav [data-nav=search]")
    assert p.locator("#step-panel").is_visible() and p.locator(".wz-title").inner_text() == "Step 4 of 4 · Review"


def test_before_a_search_trips_and_days_are_disabled(phone):
    assert phone.locator(".m-nav [data-nav=trips]").is_disabled() and phone.locator(".m-nav [data-nav=days]").is_disabled()


def test_turning_to_desktop_width_brings_back_the_desktop_results(results):
    p = results
    p.set_viewport_size({"width": 1400, "height": 900})
    p.wait_for_selector(".cmp-table")
    assert p.locator(".m-results").count() == 0 and p.locator("#tb-launch").is_visible()


# ---------------------------------------------------------------------------- touch
def _hit_from(p, sel, dx):
    """Does a tap `dx` px right of the control's centre still land on it?"""
    return p.locator(sel).first.evaluate("""(e, dx) => { const r = e.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2 + dx, r.y + r.height / 2); return at === e || e.contains(at); }""", dx)


def test_airline_bar_buttons_are_big_enough_for_a_finger(results):
    heights = results.locator(".ab-name:visible, .ab-solo:visible").evaluate_all("els => els.map(e => e.getBoundingClientRect().height)")
    assert heights and min(heights) >= 40


def test_wizard_steps_and_remove_buttons_are_easy_to_tap(phone):
    p = phone
    heights = p.locator(".wz-dots button").evaluate_all("els => els.map(e => e.getBoundingClientRect().height)")
    assert min(heights) >= 40
    _fill(p)
    p.locator(".wz-dots button").first.click()
    chip_x = "#ac-to .chip button"
    p.locator(chip_x).first.wait_for()
    assert _hit_from(p, chip_x, 13), "a tap just beside the × still removes the destination"


def test_on_a_touch_screen_delete_is_shown_without_hovering(base_url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_context(viewport=PHONE, is_mobile=True, has_touch=True).new_page()
        p.goto(base_url + "/")
        p.wait_for_function("typeof readForm === 'function' && !!ac.from")
        assert p.evaluate("matchMedia('(hover: none)').matches")
        _fill(p)
        p.wait_for_function("!document.querySelector('#go').disabled")
        p.click("#go")
        p.wait_for_function("(e => e && getComputedStyle(e).opacity === '1')(document.querySelector('.hist-item .hi-del'))", timeout=60000)
        b.close()
