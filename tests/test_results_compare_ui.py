"""Results screen (docs/stitch/DESIGN.md, "Results screen rules"): the trip-length x destination matrix, the trips table grouped by
length, the sticky airline bar, bold airline names, readable "Check on airline site" buttons and the full-screen layout.
Drives the real page in Chromium against the real app (mock provider)."""
import json
import re
from urllib.parse import parse_qs, urlparse

import pytest

pytest.importorskip("playwright.sync_api")


@pytest.fixture
def results(page):
    """A search for Rome, Paris and London, 4-6 nights, that has finished."""
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR', 'LON']; f.start = '2026-10-05'; f.end = '2026-10-25';
                              f.lenMode = 'range'; f.nmin = 4; f.nmax = 6; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(500)
    page.click("#go")
    page.wait_for_selector(".cmp-table", timeout=60000)
    return page


def texts(page, sel):
    return page.locator(sel).all_inner_texts()


def test_matrix_has_every_destination_and_length_and_nothing_preselected(results):
    p = results
    assert p.locator(".cmp-cell:not(.empty)").count() == 9                       # 3 lengths x 3 destinations
    assert p.locator(".cmp-cell.sel").count() == 0
    assert p.locator(".cmp-cell.lowest").count() == 1                            # only the single cheapest cell is badged
    rows = texts(p, ".cmp-matrix-wrap .cmp-rh b")
    assert [r.split()[0] for r in rows] == ["4", "5", "6"]
    assert [t.strip() for t in texts(p, ".cmp-head .cmp-ch")] == ["ROM", "PAR", "LON"]   # open-jaw combos are not extra columns
    assert p.locator(".cmp-combos").count() == 1                                  # ...but can be switched on


def test_table_is_grouped_by_length_with_every_destination_under_each(results):
    p = results
    bands = texts(p, ".cmp-grp b")
    assert [b.split(" · ")[0].split()[0] for b in bands] == ["4", "5", "6"]
    assert all(b.split(" · ")[1].startswith("from") for b in bands)
    # nine rows: under each band all three destinations
    trs = p.locator(".cmp-table tbody tr").evaluate_all("rows => rows.map(r => r.className)")
    seq, current = [], None
    for cls in trs:
        if "cmp-grp" in cls:
            current = []; seq.append(current)
        elif "cmp-tr" in cls:
            current.append(1)
    assert [len(g) for g in seq] == [3, 3, 3]
    dests = p.locator(".cmp-tr .c-dest b").all_inner_texts()
    assert sorted(dests[:3]) == ["LON", "PAR", "ROM"]
    # sorted by price inside a band, and the cheapest is emphasised
    prices = p.locator(".cmp-tr .c-price").evaluate_all("cells => cells.map(c => parseFloat(c.textContent.replace(/[^0-9.]/g, '')))")
    for i in (0, 3, 6):
        assert prices[i] <= prices[i + 1] <= prices[i + 2]
    assert p.locator(".cmp-tr .c-price.low").count() == 3


def test_filters_grouping_and_matrix_selection(results):
    p = results
    p.click(".cmp-seg button:text-is('Destination')")                            # group by destination instead
    assert [b.split(" · ")[0] for b in texts(p, ".cmp-grp b")] == ["ROM", "PAR", "LON"]
    p.click(".cmp-seg button:text-is('Length')")
    p.locator(".cmp-cell:not(.empty)").first.click()                              # select one matrix cell
    assert p.locator(".cmp-cell.sel").count() == 1 and p.locator(".cmp-tr").count() == 1
    p.locator(".cmp-cell:not(.empty)").nth(4).click()                             # multi-select
    assert p.locator(".cmp-tr").count() == 2
    p.click("button:has-text('Clear 2 selected cells')")
    assert p.locator(".cmp-tr").count() == 9
    p.click(".cmp-chips button:has-text('4 nights')")                              # a length filter
    assert p.locator(".cmp-tr").count() == 3
    p.check(".cmp-check:has-text('Nonstop only') input")
    assert p.locator(".cmp-tr").count() <= 3                                       # mock fares are mostly 2-stop: it can only shrink


def test_open_jaw_combinations_are_opt_in(results):
    p = results
    p.check(".cmp-combos input")
    assert p.locator(".cmp-cell:not(.empty)").count() == 27                        # 9 labels x 3 lengths
    assert p.locator(".cmp-head .cmp-ch").count() == 9
    p.uncheck(".cmp-combos input")
    assert p.locator(".cmp-cell:not(.empty)").count() == 9


def test_row_click_opens_the_full_trip(results):
    p = results
    p.locator(".cmp-tr").first.click()
    assert p.locator(".cmp-detail .trip").count() == 1
    p.locator(".cmp-tr").first.click()
    assert p.locator(".cmp-detail").count() == 0


def test_check_on_airline_site_buttons_are_readable_buttons(results):
    p = results
    btns = p.locator(".cmp-tr .site-btn")
    assert btns.count() >= 9
    first = btns.first
    label = first.inner_text().replace("↗", "").strip()
    assert label.startswith("Check on ") and label.endswith(" site")
    box = first.bounding_box()
    assert box["height"] >= 40                                                     # a real target, not small link text
    style = first.evaluate("e => { const s = getComputedStyle(e); return {w: parseInt(s.fontWeight), b: s.borderTopWidth, fs: parseFloat(s.fontSize)}; }")
    assert style["w"] >= 700 and style["b"] == "2px" and style["fs"] >= 13
    assert first.get_attribute("href").startswith("http") and first.get_attribute("rel") == "noopener noreferrer"
    # none of them is clipped by the card
    card = p.locator(".cmp-scroll").first.bounding_box()
    for i in range(btns.count()):
        b = btns.nth(i).bounding_box()
        assert b["x"] >= card["x"] - 1 and b["x"] + b["width"] <= card["x"] + card["width"] + 1


def test_airline_names_are_bold(results):
    p = results
    weights = p.locator(".cmp-air b").evaluate_all("els => els.map(e => parseInt(getComputedStyle(e).fontWeight))")
    assert weights and min(weights) >= 800
    sizes = p.locator(".cmp-air b").evaluate_all("els => els.map(e => parseFloat(getComputedStyle(e).fontSize))")
    assert min(sizes) >= 15


def test_airline_bar_is_sticky_two_rows_and_shows_every_airline(results):
    p = results
    bar = p.locator("#air-sticky")
    assert bar.is_visible()
    assert bar.evaluate("e => getComputedStyle(e).position") == "sticky"
    assert p.locator("#air-sticky .ab-top").count() == 1 and p.locator("#air-sticky .ab-row").count() == 1
    assert "TLV" in p.locator("#air-sticky .ab-sum").inner_text() and p.locator("#air-sticky button:has-text('Edit search')").count() == 1
    n = p.locator("#air-sticky .ab-chip").count()
    assert n >= 5
    p.evaluate("window.scrollTo(0, document.body.scrollHeight)")                   # still pinned to the top after scrolling far down
    p.wait_for_timeout(200)
    top = bar.bounding_box()["y"]
    assert -1 <= top <= 1
    vw = p.evaluate("window.innerWidth")
    for i in range(n):                                                             # every chip is fully inside the window (none clipped)
        b = p.locator("#air-sticky .ab-chip").nth(i).bounding_box()
        assert b["x"] >= 0 and b["x"] + b["width"] <= vw


def test_layout_uses_the_whole_screen_and_nothing_overflows(results):
    p = results
    vw = p.evaluate("window.innerWidth")
    main = p.locator("main").bounding_box()
    assert main["x"] + main["width"] >= vw - 2                                     # main reaches the right edge: no centred max-width column
    assert p.evaluate("document.documentElement.scrollWidth") <= vw + 1            # and the page is not wider than the window
    p.set_viewport_size({"width": 2560, "height": 1200})
    p.wait_for_timeout(300)
    main = p.locator("main").bounding_box()
    assert main["width"] > 2000 and p.evaluate("document.documentElement.scrollWidth") <= 2561


def test_a_single_combination_keeps_the_three_picks(page):
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM']; f.start = '2026-10-05'; f.end = '2026-10-25'; f.lenMode = 'exact'; f.nmin = 5; f.nmax = 5; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(500)
    page.click("#go")
    page.wait_for_selector(".picks, .cmp", timeout=60000)
    # ROM only, 5 nights: the round trips are one cell (open-jaw needs two destinations) -> nothing to compare
    assert page.locator(".cmp-table").count() == 0 and page.locator(".picks").count() == 1


def test_mix_and_match_rows_have_bold_airline_names_and_readable_site_buttons(results):
    p = results
    p.wait_for_selector(".mm-row")
    weights = p.locator(".mm-air").evaluate_all("els => els.map(e => parseInt(getComputedStyle(e).fontWeight))")
    assert weights and min(weights) >= 800
    btns = p.locator(".mm-row .site-btn")
    assert btns.count() >= 4
    assert btns.first.bounding_box()["height"] >= 40 and btns.first.inner_text().replace("↗", "").strip().startswith("Check on ")
    picked = p.locator(".mm-row.picked").count()
    btns.first.evaluate("e => e.addEventListener('click', ev => ev.preventDefault(), true)")   # do not navigate away in the test
    btns.first.click()
    assert p.locator(".mm-row.picked").count() == picked                                  # clicking the button does not also pick the flight


def _pretend_the_extension_is_installed(p):
    codes = p.locator(".cmp-air .code").evaluate_all("els => [...new Set(els.flatMap(e => e.textContent.split(' + ').map(x => x.trim().slice(0, 2))))]")
    p.evaluate("""codes => {
        const root = document.documentElement;
        root.dataset.skyhopExtension = '1';
        root.dataset.skyhopAirlines = JSON.stringify(Object.fromEntries(codes.map(c => [c, {name: c, status: 'verified'}])));
        window.__events = [];
        window.addEventListener('skyhop-select-flight', e => window.__events.push(e.detail));
    }""", codes)
    p.check(".cmp-check:has-text('Nonstop only') input")          # any redraw of the table re-reads what the extension supports
    p.uncheck(".cmp-check:has-text('Nonstop only') input")


def test_check_on_site_searches_the_flight_when_the_extension_is_there(results):
    p = results
    p.wait_for_selector(".cmp-tr")
    assert p.locator(".cmp-tr .site-btn[data-assist]").count() == 0                     # no extension: plain links only
    _pretend_the_extension_is_installed(p)
    btn = p.locator(".cmp-tr .site-btn[data-assist]").first
    assert btn.count() == 1
    btn.click()                                                                        # opens nothing itself: the extension does that
    ev = p.evaluate("window.__events")
    assert len(ev) == 1
    d = ev[0]
    assert d["airline"] and d["flightNumber"].startswith(d["airline"]) and len(d["departTime"]) == 5 and len(d["day"]) == 10
    assert d["originName"] == "Tel Aviv" and d["destination"]                          # what the extension needs to search, and to teach in words


def test_tarom_link_is_the_english_site():
    from flightagent.links import AIRLINE_SITES
    assert AIRLINE_SITES["RO"] == "https://www.tarom.ro/en"


def test_airline_names_use_the_full_name_when_the_provider_abbreviates(page):
    got = page.evaluate("""() => [airlineName('AZ', 'ITA'), airlineName('AZ', 'ITA Airways'), airlineName('6H', 'Israir Airlines'), airlineName('6H', 'Israir'),
                                  airlineName('U8', ''), airlineName('ZZ', 'Zed Air'), airlineName('ZZ', ''), airlineName('LY', 'EL AL')]""")
    assert got == ["ITA Airways", "ITA Airways", "Israir Airlines", "Israir", "Tus Air", "Zed Air", "ZZ", "EL AL"]


def _button_names(loc):
    """['Lufthansa', ...] from the labels 'Check on X site' / 'Search on X site' (a known search link) / "Looking for X's website…" /
    "Couldn't find X's website" of the buttons in `loc`."""
    out = []
    for t in loc.all_inner_texts():
        t = t.replace("↗", "").strip()
        m = re.fullmatch(r"(?:Check|Search) on (.+) site|Looking for (.+)'s website…|Couldn't find (.+)'s website", t)
        assert m, t
        out.append(m.group(1) or m.group(2) or m.group(3))
    return out


def test_every_airline_in_every_row_has_a_button(results):
    """Not just the airlines we keep a site address for: one button per airline of the trip, in the table, Mix & match and the trip card."""
    p = results
    for i in range(p.locator(".cmp-tr").count()):
        row = p.locator(".cmp-tr").nth(i)
        shown = set()
        for name in row.locator(".cmp-air b").all_inner_texts():
            shown.update(x.strip() for x in name.split(" + "))
        assert set(_button_names(row.locator(".site-btn"))) == shown, i
    for i in range(p.locator(".mm-row").count()):
        row = p.locator(".mm-row").nth(i)
        assert set(_button_names(row.locator(".site-btn"))) == {x.strip() for x in row.locator(".mm-air").inner_text().split("·")}, i


def _answer_site_lookups(page, answer, delay_ms=0):
    """Answer airline-site lookups with `answer()` (a JSON string, as /api/airline-site sends). The server asks Wikidata itself; the
    Pages build asks Wikidata from the page and then checks that the site answers, so those requests are answered to match."""
    def server(route):
        page.wait_for_timeout(delay_ms)
        route.fulfill(status=200, content_type="application/json", body=answer())

    def wikidata(route):
        page.wait_for_timeout(delay_ms)
        a = json.loads(answer())
        if a.get("unavailable"):
            return route.fulfill(status=503, body="")
        label = re.search(r'rdfs:label "([^"]*)"', parse_qs(urlparse(route.request.url).query)["query"][0])
        rows = [{"site": {"value": a["url"]}, "aLabel": {"value": label.group(1) if label else ""}, "byCode": {"value": "1"}}] if a["url"] else []
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"results": {"bindings": rows}}))

    page.route("**/api/airline-site**", server)
    page.route("https://query.wikidata.org/**", wikidata)
    page.route("https://www.lufthansa-example.test/**", lambda r: r.fulfill(status=200, body=""))


def _search_without_two_known_sites(page, answer):
    """Runs the 3-destination search after making Lufthansa and Austrian 'unknown' (stand-ins for a brand-new airline like Animawings),
    with airline-site lookups answering `answer` (JSON) after a short delay."""
    _answer_site_lookups(page, lambda: answer, delay_ms=150)
    page.evaluate("() => { delete config.airline_sites.LH; delete config.airline_sites.OS; }")
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR', 'LON']; f.start = '2026-10-05'; f.end = '2026-10-25';
                              f.lenMode = 'range'; f.nmin = 4; f.nmax = 6; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(500)
    page.click("#go")
    page.wait_for_selector(".cmp-table", timeout=60000)


def test_an_unknown_airline_is_looked_up_and_then_links_to_its_real_site(page):
    _search_without_two_known_sites(page, '{"url": "https://www.lufthansa-example.test/", "source": "wikidata"}')
    page.wait_for_function("document.querySelectorAll('.cmp-tr .site-btn.checking').length === 0", timeout=10000)
    links = page.locator(".cmp-tr a.site-btn[href^='https://www.lufthansa-example.test']")
    assert links.count() >= 1
    label = links.first.inner_text().replace("↗", "").strip()
    assert label.startswith("Check on ") and label.endswith(" site")                     # the same button as every other airline
    assert links.first.bounding_box()["height"] >= 40
    assert page.locator(".site-btn", has_text="Google").count() == 0                     # a search engine is never offered
    assert page.evaluate("config.airline_sites.LH") == "https://www.lufthansa-example.test/"   # remembered: no second lookup


def test_an_airline_with_no_website_says_so_plainly_and_is_not_a_link(page):
    _search_without_two_known_sites(page, '{"url": null, "source": null}')
    page.wait_for_function("document.querySelectorAll('.cmp-tr .site-btn.missing').length > 0", timeout=10000)
    miss = page.locator(".cmp-tr .site-btn.missing").first
    text = miss.inner_text().strip()
    assert text.startswith("Couldn't find ") and text.endswith("'s website")
    assert miss.evaluate("e => e.tagName") == "SPAN" and miss.get_attribute("href") is None    # nothing to click through to
    assert "won't guess" in miss.get_attribute("title")
    assert page.locator(".cmp-tr .site-btn.checking").count() == 0
    assert page.locator("a.site-btn[href*='google.com']").count() == 0


def test_a_lookup_that_could_not_be_made_is_not_reported_as_no_website_and_can_be_retried(page):
    state = {"retried": False}         # Wikidata is "down" until the user clicks Try again
    def answer():
        return '{"url": "https://www.lufthansa-example.test/", "source": "wikidata"}' if state["retried"] else '{"url": null, "source": null, "unavailable": true}'
    _answer_site_lookups(page, answer)
    page.evaluate("() => { delete config.airline_sites.LH; }")
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR', 'LON']; f.start = '2026-10-05'; f.end = '2026-10-25';
                              f.lenMode = 'range'; f.nmin = 4; f.nmax = 6; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(500)
    page.click("#go")
    page.wait_for_selector(".cmp-table", timeout=60000)
    page.wait_for_function("document.querySelector('.cmp-tr .site-btn.retry')", timeout=10000)
    retry = page.locator(".cmp-tr .site-btn.retry").first
    text = retry.inner_text().strip()
    assert "right now" in text and text.endswith("Try again")
    assert "Couldn't find" not in text                                               # it does NOT claim the airline has no website
    assert page.locator(".cmp-tr .site-btn.missing").count() == 0
    state["retried"] = True
    retry.click()
    page.wait_for_function("document.querySelector('.cmp-tr a.site-btn[href^=\"https://www.lufthansa-example.test\"]')", timeout=10000)
    assert page.evaluate("config.airline_sites.LH") == "https://www.lufthansa-example.test/"


def test_clicking_a_site_button_opens_the_site_and_copies_the_flight(results):
    p = results
    p.evaluate("""() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }, configurable: true });
                          window.addEventListener('click', e => { if (e.target.closest && e.target.closest('a.site-btn')) e.preventDefault(); }, true); }""")
    btn = p.locator(".cmp-tr a.site-btn").first
    assert btn.get_attribute("target") == "_blank"
    btn.click()
    p.wait_for_function("window.__copied !== null")
    note = p.evaluate("window.__copied")
    assert re.search(r"[A-Z0-9]{2}\d+ [A-Z]{3} → [A-Z]{3}, \w{3} \d+ \w{3} \d\d:\d\d", note), note        # e.g. "LH5429 TLV → IST, Wed 7 Oct 05:00"
    assert "Search for it there" in p.inner_text(".toast")


def test_the_server_knows_many_more_airline_sites():
    from flightagent.links import AIRLINE_SITES
    assert len(AIRLINE_SITES) >= 60
    for code in ("LY", "6H", "IZ", "W6", "W4", "FR", "U2", "RO", "TP", "UX", "HV", "VY", "EW", "AZ"):
        assert AIRLINE_SITES[code].startswith("https://")


def test_the_trip_builder_and_unpriced_flights_have_the_button_too(results):
    p = results
    p.locator(".cmp-tr").first.click()
    p.click(".cmp-detail button:has-text('Add all flights to Trip builder')")
    p.click("#tb-launch")
    p.wait_for_selector(".tb-chosen")
    assert p.locator(".tb-chosen .site-btn").count() >= 1
    label = p.locator(".tb-chosen .site-btn").first.inner_text().replace("↗", "").strip()
    assert label.startswith("Check on ") or label.startswith("Find ")
    p.click("#tb-close")
    # a flight Google lists without a price, for an airline nobody has heard of: still a button; with no website found it says so
    _answer_site_lookups(p, lambda: '{"url": null, "source": null}')
    html = p.evaluate("""() => {
        const u = { date: '2026-10-23', origin: 'TLV', destination: 'OTP', airline: 'Animawings', airline_code: 'XX', flights: 'XX123',
                    departs: '2026-10-23T09:10:00', arrives: '2026-10-23T12:00:00', duration_min: 170, stops: 0, link: '', last_price: null, last_seen: null };
        window.__unp = unpricedPanel({ unpriced: [u] }, { id: 'x', request: currentRow.request, rechecks: 0 });
        document.body.append(window.__unp);
        return window.__unp.querySelectorAll('.site-btn').length;
    }""")
    assert html == 1
    p.wait_for_function("window.__unp.querySelector('.site-btn.missing')", timeout=10000)
    assert p.evaluate("window.__unp.querySelector('.site-btn.missing').textContent.trim()") == "Couldn't find Animawings's website"


def test_the_return_leg_also_gets_the_search_button_when_the_driver_supports_any_origin(results):
    """The bug this fixes: 'Select on site' only ever appeared on the outbound leg (it assumed every search starts at TLV). A driver
    parameterised by {origin} (Wizz Air-style "url" mode, or one learned from the user) works from wherever the flight actually leaves."""
    p = results
    codes = p.locator(".cmp-air .code").evaluate_all("els => [...new Set(els.flatMap(e => e.textContent.split(' + ').map(x => x.trim().slice(0, 2))))]")
    p.evaluate("""codes => {
        document.documentElement.dataset.skyhopExtension = '1';
        document.documentElement.dataset.skyhopAirlines = JSON.stringify(Object.fromEntries(codes.map(c => [c, {name: c, status: 'verified', anyOrigin: true}])));
        window.__events = [];
        window.addEventListener('skyhop-select-flight', e => window.__events.push(e.detail));
    }""", codes)
    p.click(".cmp-tr")                                                                 # open one trip: outbound + return legs, in one card
    p.wait_for_selector(".cmp-detail .leg")
    buttons = p.locator(".cmp-detail .leg .actions button.accent")
    assert buttons.count() >= 2                                                         # both legs offer it, not just the outbound one
    buttons.nth(0).click()
    buttons.nth(1).click()
    origins = [e["origin"] for e in p.evaluate("window.__events")]
    assert len(set(origins)) == 2 and "TLV" in origins                                  # different origins: one leg IS the return leg


def test_a_bespoke_driver_stays_limited_to_its_own_origin(results):
    """El Al / TAROM: origin-locked by their OWN site (El Al's widget defaults to Tel Aviv; TAROM's link hardcodes it), not by a Skyhop
    assumption -- so a return leg from Rome must NOT offer a fake "Select on site" for these two."""
    p = results
    p.evaluate("""() => {
        document.documentElement.dataset.skyhopExtension = '1';
        document.documentElement.dataset.skyhopAirlines = JSON.stringify({ RO: { name: 'TAROM', status: 'bespoke', anyOrigin: false } });
    }""")
    got = p.evaluate("""() => {
        const tlv = { airline_code: 'RO', flight_number: '156', origin: 'TLV', destination: 'OTP', departs: '2026-10-23T10:00:00', arrives: '2026-10-23T13:00:00' };
        const fco = { airline_code: 'RO', flight_number: '157', origin: 'OTP', destination: 'TLV', departs: '2026-10-28T10:00:00', arrives: '2026-10-28T13:00:00' };
        return [!!assistFor('RO', [tlv]), !!assistFor('RO', [fco])];
    }""")
    assert got == [True, False]


def test_without_the_extension_a_known_airline_link_opens_its_own_search_for_the_flight(results):
    """Phones: Wizz Air's verified results link opens already searched for this flight's route and day."""
    p = results
    btn = p.locator(".site-btn", has_text="Search on Wizz Air site").first
    btn.wait_for(state="attached")
    href = btn.get_attribute("href")
    m = re.fullmatch(r"https://www\.wizzair\.com/en-gb/booking/select-flight/([A-Z]{3})/([A-Z]{3})/(\d{4}-\d{2}-\d{2})/null/1/0/0/null", href)
    assert m, href
    origin, dest, day = m.groups()
    assert origin != dest                                                 # Wizz Air's own part of the leg (it may change in a hub)
    assert "2026-10-05" <= day <= "2026-10-31"
    assert re.fullmatch(rf"Opens Wizz Air's own results for {origin} → {dest} that day and copies this flight \(W6\d+ .+\); you pick it there",
                        btn.get_attribute("title"))
    assert p.locator(".site-btn", has_text="Search on El Al site").count() == 0, "El Al has no search link: plain site link"
