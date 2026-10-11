"""Demo fares have nothing to check a price against, so their trips offer no price check (web/app.js verifyButton);
tests/test_account_ui.py covers the check with real fares on the Pages build."""
import pytest

pytest.importorskip("playwright.sync_api")


def test_demo_trips_offer_no_price_check(page):
    page.evaluate("""() => { const f = readForm(); f.to = ['ATH']; f.start = '2026-11-02'; f.end = '2026-11-04';
                             f.lenMode = 'range'; f.nmin = 3; f.nmax = 3; writeForm(f); onFormChange(); }""")
    page.wait_for_function("!document.querySelector('#go').disabled")
    page.click("#go")
    page.locator("article.trip").first.wait_for(timeout=60000)
    assert page.locator("article.trip .vf-check").count() == 0
    assert page.locator("article.trip .rt-check").count() > 0
