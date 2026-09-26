"""The trip-length control in the web app: simple mode (any length that fits the dates), expert mode (exactly N / between
N and M) and its validation. Drives the real page in Chromium against the real app (mock provider)."""
import socket
import threading
import time

import pytest

pw = pytest.importorskip("playwright.sync_api")
uvicorn = pytest.importorskip("uvicorn")


@pytest.fixture(scope="module")
def base_url(tmp_path_factory):
    import os
    os.environ["FLIGHTAGENT_PROVIDER"] = "mock"
    os.environ["FLIGHTAGENT_CACHE_DB"] = str(tmp_path_factory.mktemp("db") / "offers.sqlite")
    os.environ["FLIGHTAGENT_RECHECK"] = "0"
    from flightagent.api import app
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True); t.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)


@pytest.fixture
def page(base_url):
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto(base_url + "/")
        pg.evaluate("localStorage.clear()")
        pg.reload()
        pg.wait_for_function("typeof readForm === 'function' && !!ac.from")
        yield pg
        b.close()


def set_dates(pg, start, end):
    pg.fill("#start", start)
    pg.fill("#end", end)
    pg.dispatch_event("#end", "change")


def choose(pg, name, value):
    """Click a segmented-control option the way a person does (its radio is visually hidden, the label is the target)."""
    pg.click(f"label:has(input[name={name}][value={value}])")


def form(pg):
    return pg.evaluate("(() => { const f = readForm(); return {nmin: f.nmin, nmax: f.nmax, mode: f.lenMode}; })()")


def commit(pg, sel, value):
    pg.fill(sel, str(value))
    pg.dispatch_event(sel, "change")


def test_default_is_the_whole_timeframe(page):
    set_dates(page, "2026-10-01", "2026-10-21")                       # 20 nights
    assert page.is_visible("#len-any") and not page.is_visible("#len-expert")
    assert not page.is_checked("#expert")
    assert "20 nights" in page.inner_text("#len-any")
    assert form(page) == {"nmin": 1, "nmax": 20, "mode": "any"}
    set_dates(page, "2026-10-01", "2026-10-11")                       # the timeframe changes -> so does the length
    assert form(page) == {"nmin": 1, "nmax": 10, "mode": "any"}


def test_expert_exactly_and_between(page):
    set_dates(page, "2026-10-01", "2026-10-21")
    page.check("#expert")
    assert page.is_visible("#len-expert") and not page.is_visible("#len-any")
    assert form(page) == {"nmin": 4, "nmax": 7, "mode": "range"}       # what the form had before, not the whole range
    choose(page, "lenmode", "exact")
    assert not page.is_visible("#nmax")
    commit(page, "#nmin", 4)
    assert form(page) == {"nmin": 4, "nmax": 4, "mode": "exact"}
    choose(page, "lenmode", "range")
    commit(page, "#nmax", 6)
    assert form(page) == {"nmin": 4, "nmax": 6, "mode": "range"}
    assert "Between 4–6 nights" in page.inner_text("#nights-hint")


def test_to_can_never_be_lower_than_from(page):
    set_dates(page, "2026-10-01", "2026-10-21")
    page.check("#expert")
    commit(page, "#nmin", 5)
    commit(page, "#nmax", 3)                                           # 3 < 5: raised to 5
    assert form(page)["nmin"] == 5 and form(page)["nmax"] == 5
    assert "can't be lower" in page.inner_text("#nights-hint")
    commit(page, "#nmin", 9)                                           # raising "from" above "to" pushes "to" up
    assert form(page) == {"nmin": 9, "nmax": 9, "mode": "range"}
    page.click("[data-for=nmax][data-step='-1']")                      # the stepper cannot go below "from" either
    assert form(page)["nmax"] == 9


def test_changing_the_dates_revalidates_the_length(page):
    set_dates(page, "2026-10-01", "2026-10-21")
    page.check("#expert")
    commit(page, "#nmin", 10)
    commit(page, "#nmax", 14)
    set_dates(page, "2026-10-01", "2026-10-06")                        # only 5 nights now
    assert form(page) == {"nmin": 5, "nmax": 5, "mode": "range"}
    assert "at most" in page.inner_text("#nights-hint") and "5 nights" in page.inner_text("#nights-hint")
    assert page.get_attribute("#nmin", "max") == "5" and page.get_attribute("#nmax", "max") == "5"


def test_days_unit_and_switching_back_to_simple(page):
    set_dates(page, "2026-10-01", "2026-10-21")
    page.check("#expert")
    commit(page, "#nmin", 4)
    commit(page, "#nmax", 6)
    choose(page, "unit", "days")
    assert page.input_value("#nmin") == "5" and page.input_value("#nmax") == "7"      # 4-6 nights = 5-7 days
    assert form(page) == {"nmin": 4, "nmax": 6, "mode": "range"}                      # the API still gets nights
    page.uncheck("#expert")
    assert form(page) == {"nmin": 1, "nmax": 20, "mode": "any"}
    page.check("#expert")
    assert form(page) == {"nmin": 4, "nmax": 6, "mode": "range"}                      # expert mode remembers its numbers


def test_it_is_remembered_and_older_searches_map_to_a_mode(page):
    set_dates(page, "2026-10-01", "2026-10-21")
    page.check("#expert")
    choose(page, "lenmode", "exact")
    commit(page, "#nmin", 4)
    page.reload()
    page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    assert form(page) == {"nmin": 4, "nmax": 4, "mode": "exact"}
    assert page.evaluate("[inferLenMode({start:'2026-10-01',end:'2026-10-21',nmin:1,nmax:20}), inferLenMode({start:'2026-10-01',end:'2026-10-21',nmin:4,nmax:4}), inferLenMode({start:'2026-10-01',end:'2026-10-21',nmin:4,nmax:7})]") == ["any", "exact", "range"]
