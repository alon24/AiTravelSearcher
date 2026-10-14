"""Help (web/help.js): the welcome tour on a first plain visit, the ? panel with a tour of the screen you are on, and the
"Jump to" row on the desktop results."""
import pytest

pytest.importorskip("playwright.sync_api")

PHONE = {"width": 390, "height": 844}


@pytest.fixture
def fresh(base_url):
    """A first-time visitor: nothing in storage, so the welcome tour is due."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_page(viewport={"width": 1400, "height": 900})
        p.goto(base_url + "/")
        yield p
        b.close()


def _titles(p):
    """Steps through the open tour to the end, returning each step's title."""
    seen = []
    while True:
        seen.append(p.inner_text(".tour-tip h3"))
        if p.inner_text(".tour-next") == "Done":
            p.click(".tour-next")
            return seen
        p.click(".tour-next")


def _search(p):
    p.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR']; f.start = '2026-11-02'; f.end = '2026-11-12';
                          f.lenMode = 'range'; f.nmin = 3; f.nmax = 4; writeForm(f); onFormChange(); }""")
    p.wait_for_function("!document.querySelector('#go').disabled")
    p.evaluate("document.querySelector('#form').requestSubmit()")
    p.wait_for_selector(".res-head", timeout=60000)


def test_a_first_visit_opens_the_welcome_tour_once(fresh):
    fresh.wait_for_selector(".tour")
    assert fresh.text_content(".tour-count") == "1 of 10"
    titles = _titles(fresh)
    assert titles[0] == "Welcome to Skyhop" and titles[-1] == "Help is always here"
    assert {"Where", "When", "Search", "Past searches", "Trip builder"} <= set(titles)
    assert "Four short steps" not in titles, "the phone wizard step is skipped on a desktop"
    assert fresh.locator(".tour").count() == 0
    fresh.reload()
    fresh.wait_for_function("typeof Help === 'object' && !!ac.from")
    fresh.wait_for_timeout(700)
    assert fresh.locator(".tour").count() == 0, "shown once, not on every visit"


def test_the_tour_spotlights_each_element_and_skip_or_escape_only_close_it(fresh):
    fresh.wait_for_selector(".tour")
    fresh.click(".tour-next")
    assert fresh.inner_text(".tour-tip h3") == "Where"
    hole, row = fresh.locator(".tour-hole").bounding_box(), fresh.locator("#form .row.two").bounding_box()
    assert hole["x"] <= row["x"] and hole["y"] <= row["y"] and hole["width"] >= row["width"], "the spotlight frames the From/To row"
    fresh.click(".tour-back")
    assert fresh.inner_text(".tour-tip h3") == "Welcome to Skyhop"
    fresh.click(".tour-skip")
    assert fresh.locator(".tour").count() == 0
    fresh.reload()
    fresh.wait_for_selector(".tour")   # Skip only closes it: it comes back next visit
    fresh.keyboard.press("ArrowRight")
    assert fresh.inner_text(".tour-tip h3") == "Where"
    fresh.keyboard.press("Escape")
    assert fresh.locator(".tour").count() == 0
    assert fresh.evaluate("localStorage.getItem('skyhop.tour')") is None, "Escape is a skip, not a 'never'"


def test_dont_show_again_stops_the_welcome_tour(fresh):
    fresh.wait_for_selector(".tour")
    fresh.click(".tour-next")
    fresh.click(".tour-never")
    assert fresh.locator(".tour").count() == 0
    fresh.reload()
    fresh.wait_for_function("typeof Help === 'object' && !!ac.from")
    fresh.wait_for_timeout(700)
    assert fresh.locator(".tour").count() == 0
    fresh.click(".main-head .help-btn")
    auto = fresh.locator(".help-auto")
    assert not auto.is_checked(), "Help shows it is off, and can turn it back on"
    fresh.locator(".help-auto-row").click()
    fresh.reload()
    fresh.wait_for_selector(".tour")


def test_a_hebrew_browser_gets_the_tour_in_hebrew_and_can_switch(base_url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_context(locale="he-IL", viewport={"width": 1400, "height": 900}).new_page()
        p.goto(base_url + "/")
        p.wait_for_selector(".tour")
        tip = p.locator(".tour-tip")
        assert tip.get_attribute("dir") == "rtl" and p.inner_text(".tour-tip h3") == "ברוכים הבאים ל-Skyhop"
        assert p.text_content(".tour-count").endswith(" מתוך 10")
        p.click(".tour-next")
        assert p.inner_text(".tour-tip h3") == "לאן"
        p.click(".tour-tip .help-lang [lang=en]")
        assert p.inner_text(".tour-tip h3") == "Where", "switching language keeps the step"
        assert p.locator(".tour-tip").get_attribute("dir") == "ltr"
        p.keyboard.press("Escape")
        p.click(".main-head .help-btn")
        assert p.locator(".help").get_attribute("dir") == "ltr", "the choice is remembered"
        p.click(".help .help-lang [lang=he]")
        assert p.locator(".help").get_attribute("dir") == "rtl" and "סיור במסך הזה" in p.inner_text(".help-tour.here")
        assert p.locator(".help-faq summary").first.inner_text() == "המחירים אמיתיים?"
        b.close()


@pytest.mark.parametrize("link", ["?from=TLV&to=LIS&start=2026-11-13&end=2026-11-22&nights=3", "#trip=abc123"], ids=["travel-hub", "invite"])
def test_a_travel_hub_or_invite_link_opens_without_the_tour(base_url, link):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_page()
        p.goto(base_url + "/" + link)
        p.wait_for_function("typeof Help === 'object' && !!ac.from")
        p.wait_for_timeout(700)
        assert p.locator(".tour").count() == 0
        b.close()


def test_help_offers_a_tour_of_the_search_screen(page):
    page.click(".main-head .help-btn")
    page.keyboard.press("Escape")
    assert page.locator(".help-wrap").count() == 0
    page.click(".main-head .help-btn")
    here = page.locator(".help-tour.here")
    assert "Welcome to Skyhop" in here.inner_text()
    assert page.locator(".help-faq").count() >= 5
    page.click(".help-faq summary >> text=Can I buy tickets here?")
    assert "airline's own site" in page.inner_text(".help-faq[open]")
    here.click()
    assert page.locator(".help-wrap").count() == 0
    assert page.inner_text(".tour-tip h3") == "Welcome to Skyhop"


def test_after_a_search_help_tours_the_results(page):
    _search(page)
    page.click(".main-head .help-btn")
    assert "Reading the results" in page.inner_text(".help-tour.here")
    page.click(".help-tour.here")
    titles = _titles(page)
    assert titles[:2] == ["Your search", "Three views"]
    assert {"Airlines", "The best picks", "More trips", "Book it"} <= set(titles)


def test_the_trip_builder_tour_opens_the_builder(page):
    page.click(".main-head .help-btn")
    page.click("[data-help-tour=builder]")
    assert page.locator("#tb.open").count() == 1
    assert _titles(page) == ["Trip builder", "Legs", "Total and next steps"]


def test_desktop_results_are_three_tabs_with_the_top_trips_as_rows(page):
    _search(page)
    tabs = page.locator("#air-sticky .res-tabs [role=tab]")
    assert [t.inner_text() for t in tabs.all()] == ["Trips", "Price by day", "Mix & match"]
    assert page.locator(".res-pane:not([hidden])").get_attribute("data-pane") == "trips"
    assert page.locator(".res-chart").is_hidden() and page.locator(".res-mix").is_hidden()
    assert page.locator(".top-trips .trips > article.trip").count() == 3, "the best three trips in full"
    row = page.locator(".trip-row").first
    assert row.locator("article.trip").count() == 0, "a row's full card is built when it opens"
    row.locator("summary").click()
    row.locator("article.trip .hub-save").wait_for(timeout=3000)   # the card is built on the toggle event, just after the click
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    tabs.nth(1).click()
    assert page.locator(".res-chart").is_visible() and page.locator(".top-trips").is_hidden()
    assert page.evaluate("document.querySelector('.res-chart').getBoundingClientRect().top") < 600, "switching tabs scrolls back up to the results"
    assert page.locator("#finder").is_hidden(), "the airline finder is out of the way while reading results"
    page.click("[data-tab=mix]")
    page.evaluate("renderResult(currentRow, { keepScroll: true })")
    assert page.locator(".res-pane:not([hidden])").get_attribute("data-pane") == "mix", "the tab survives a redraw"


def test_on_a_phone_the_tour_follows_the_wizard_and_bottom_bar(base_url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_page(viewport=PHONE)
        p.goto(base_url + "/")
        p.wait_for_selector(".tour")
        titles = _titles(p)
        b.close()
    assert {"Four short steps", "Next step", "Getting around"} <= set(titles)
    assert "When" not in titles, "steps hidden behind later wizard pages are skipped"
    assert "Your steps" not in titles, "the closed side bar is off screen"
