"""Cancel on the progress card: a wide search can be stopped, and what it already fetched is kept for the next one.
Drives the real page in Chromium against the real app (mock provider)."""
import pytest

pytest.importorskip("playwright.sync_api")

WIDE = """() => { const f = readForm(); f.to = ['ROM', 'PAR', 'LON']; f.start = '2026-10-05'; f.end = '2026-11-25';
                  f.lenMode = 'range'; f.nmin = 3; f.nmax = 9; writeForm(f); onFormChange(); }"""


def test_the_progress_card_has_cancel_and_a_cancelled_search_says_what_was_kept(page):
    page.evaluate("""() => { window.__asked = []; const real = api;
        window.api = (path, o) => path.endsWith('/cancel') ? (window.__asked.push(path), Promise.resolve({ cancelled: true })) : real(path, o); }""")
    row = {"id": "abc123", "status": "running", "progress": {"done": 3, "total": 40},
           "request": {"origin": "TLV", "destinations": ["ROM"], "window_start": "2026-10-05", "window_end": "2026-10-25"}}
    page.evaluate("row => renderProgress(row)", row)
    btn = page.locator(".progress .cancel-search")
    assert btn.inner_text() == "Cancel" and btn.bounding_box()["height"] >= 36
    btn.click()
    page.wait_for_function("window.__asked.length === 1")
    assert page.evaluate("window.__asked") == ["/api/searches/abc123/cancel"]
    page.evaluate("row => renderProgress(row)", row)                                   # the next poll redraws the card
    assert page.locator(".progress .cancel-search").inner_text() == "Cancelling…"
    assert page.locator(".progress .cancel-search").is_disabled()


def test_cancelling_a_wide_search_stops_it_and_keeps_its_fares(page):
    page.evaluate("""() => { const real = SkyhopLocal.mock.oneWay;
        SkyhopLocal.mock.oneWay = async (...a) => { await new Promise(r => setTimeout(r, 40)); return real(...a); }; }""")
    page.evaluate(WIDE)
    page.wait_for_function("!document.querySelector('#go').disabled")
    page.click("#go")
    page.wait_for_selector(".progress .cancel-search")
    page.wait_for_function("/Checking flights… [1-9]\\d* of/.test(document.querySelector('.progress .txt').textContent)")
    page.click(".progress .cancel-search")
    note = page.locator("#results .note:has-text('Cancelled.')")
    note.wait_for(timeout=20000)
    assert note.inner_text() == "Cancelled. Fares fetched before you stopped are saved, so searching again reuses them."
    assert "bad" not in note.get_attribute("class")
    assert page.locator("#results button:has-text('Search again')").count() == 1
