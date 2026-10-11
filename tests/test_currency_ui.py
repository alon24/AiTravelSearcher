"""Converted prices: the rate and its source are on the page, and without live rates nothing is converted (a guessed
rate would show a price nobody quoted). Drives the real page in Chromium against the real app (mock provider)."""
import pytest

pytest.importorskip("playwright.sync_api")


@pytest.fixture
def usd_results(page):
    """A finished search made in USD."""
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM']; f.start = '2026-10-05'; f.end = '2026-10-12';
                              f.currency = 'USD'; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(300)
    page.click("#go")
    page.wait_for_selector(".res-head", timeout=60000)
    return page


def show_in(page, cur, rates, info):
    page.evaluate("([cur, r, i]) => { rates = r; ratesInfo = i; displayCurrency = cur; rerenderCurrency(); }", [cur, rates, info])


def test_converted_prices_show_the_rate_and_its_source_without_hovering(usd_results):
    p = usd_results
    show_in(p, "ILS", {"USD": 1, "ILS": 3.7}, {"source": "ECB via frankfurter.dev", "date": "2026-10-10", "error": None})
    badge = p.locator(".res-head .conv-toggle").inner_text()
    assert "Converted from USD" in badge and "1 USD = 3.700 ILS, ECB via frankfurter.dev 2026-10-10" in badge
    assert "₪" in p.locator("#results").inner_text()


def test_without_live_rates_prices_stay_as_searched_and_say_why(usd_results):
    p = usd_results
    show_in(p, "ILS", {}, {"source": None, "date": None, "error": "live exchange rates unavailable: timed out"})
    assert p.locator(".conv-toggle").count() == 0
    assert p.locator(".res-head .conv-off").inner_text() == "Prices in USD, as searched · live exchange rates unavailable: timed out"
    assert "₪" not in p.locator("#results").inner_text()                     # nothing converted with a made-up rate
    assert p.locator(".orig").count() == 0
