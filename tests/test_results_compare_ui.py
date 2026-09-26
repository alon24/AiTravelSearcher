"""Results screen (docs/stitch/DESIGN.md, "Results screen rules"): the trip-length x destination matrix, the trips table grouped by
length, the sticky airline bar, bold airline names, readable "Check on airline site" buttons and the full-screen layout.
Drives the real page in Chromium against the real app (mock provider)."""
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
