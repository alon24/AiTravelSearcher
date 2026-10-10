"""The GitHub Pages build (tools/build_pages.py): the whole app runs in the page, with no Python service behind it.
Drives the built site in Chromium; the shared UI tests also run against it (conftest.py), these cover what only Pages has."""
import re

import pytest

pytest.importorskip("playwright.sync_api")


@pytest.fixture
def pages(page, base_url):
    if not base_url.endswith("/skyhop"):
        pytest.skip("Pages build only")
    return page


def _search(p):
    p.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR']; f.start = '2026-11-02'; f.end = '2026-11-12';
                          f.lenMode = 'range'; f.nmin = 3; f.nmax = 4; writeForm(f); onFormChange(); }""")
    p.wait_for_function("!document.querySelector('#go').disabled")
    p.click("#go")
    p.wait_for_selector(".cmp-table", timeout=60000)


def test_a_search_runs_without_any_server(pages):
    asked = []
    pages.on("request", lambda r: asked.append(r.url))
    _search(pages)
    assert not [u for u in asked if "/api/" in u], "the Pages build must answer /api itself"
    assert pages.locator(".mode-badge.demo").first.inner_text() == "⚠ DEMO DATA"
    assert pages.locator(".cmp-tr").count() > 0


def test_past_searches_survive_a_reload(pages):
    _search(pages)
    pages.reload()
    pages.wait_for_function("typeof readForm === 'function' && !!ac.from")
    item = pages.locator(".hist-item").first
    item.wait_for()
    assert "TLV → ROM, PAR" in item.inner_text() and "from" in item.inner_text()
    item.click()
    pages.wait_for_selector(".cmp-table", timeout=10000)


def test_a_second_identical_search_is_served_from_the_browser_cache(pages):
    _search(pages)
    pages.evaluate("onFormChange()")                       # re-estimate the same search
    pages.wait_for_function("/(\\d+) lookups · \\1 cached/.test(document.querySelector('#estimate-text').textContent)", timeout=5000)
    lookups = int(re.search(r"(\d+) lookups", pages.inner_text("#estimate-text")).group(1))
    assert lookups > 0
