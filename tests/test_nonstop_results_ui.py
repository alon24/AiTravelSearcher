"""Regression: a search that found a nonstop trip drew an empty results area (compare.js shadowed its tr() translator)."""
import pytest

pytest.importorskip("playwright.sync_api")


def test_results_with_a_nonstop_trip_are_drawn(page):
    page.evaluate("""async () => {
      const L = SkyhopLocal, M = L.models, seg = (o, d, dep) => M.segment({ airline_code: 'LY', flight_number: '1', origin: o, destination: d,
        departs: dep, arrives: M.addMinutes(dep, 180) });
      const provider = { name: 'fake', oneWay: async (o, d, day) => [M.offer({ origin: o, destination: d, price: 100, currency: 'USD', segments: [seg(o, d, day + 'T10:00:00')] })] };
      const q = M.searchRequest({ origin: 'TLV', destinations: ['ROM'], window_start: '2026-12-05', window_end: '2026-12-08', min_nights: 2, max_nights: 3, adults: 2 });
      renderResult({ id: 'x', status: 'done', request: q, result: await new L.engine.Engine(provider, null).search(q), created: Date.now() / 1000 });
    }""")
    page.wait_for_selector(".cmp-table", state="attached", timeout=10000)
