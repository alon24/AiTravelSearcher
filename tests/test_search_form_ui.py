"""Search form: no false "length was set to fit" warning on a fresh page."""
import pytest

pytest.importorskip("playwright.sync_api")


def test_no_length_warning_on_a_fresh_page_in_simple_mode(page):
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM']; f.start = '2026-10-05'; f.end = '2026-10-25'; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(400)
    assert "set to fit" not in page.inner_text("#nights-hint")
    assert "20 nights" in page.inner_text("#len-any")
    # ...but in expert mode a length that cannot fit the dates is still explained
    page.check("#expert")
    page.fill("#nmin", "9"); page.dispatch_event("#nmin", "change")
    page.fill("#nmax", "30"); page.dispatch_event("#nmax", "change")
    assert "at most" in page.inner_text("#nights-hint")
