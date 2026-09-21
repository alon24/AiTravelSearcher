import asyncio
from datetime import date, datetime, timedelta

import pytest

from flightagent.cache import OfferCache
from flightagent.engine import BudgetExceeded, FlightSearchEngine
from flightagent.models import Offer, SearchRequest, Segment
from flightagent.providers.serpapi import SerpApiProvider


def seg(o, d, dep, mins, code="LY", num="1"):
    return Segment(airline_code=code, flight_number=num, origin=o, destination=d,
                   departs=dep, arrives=dep + timedelta(minutes=mins))


def offer(o, d, dep, price, code="LY"):
    return Offer(origin=o, destination=d, price=price, currency="USD", segments=[seg(o, d, dep, 180, code)])


class Fake:
    """Provider driven by a function (o, d, day) -> list[Offer]."""
    name = "fake"

    def __init__(self, fn):
        self.fn, self.calls = fn, []

    async def one_way(self, o, d, day, *, currency, adults, max_stops, **kw):
        self.calls.append((o, d, day))
        self.kw = {"adults": adults, **kw}
        return self.fn(o, d, day)


def at(day, h=10):
    return datetime.combine(day, datetime.min.time()) + timedelta(hours=h)


def req(**kw):
    base = dict(destinations=["ROM"], window_start=date(2026, 10, 1), window_end=date(2026, 10, 10),
                min_nights=3, max_nights=4)
    return SearchRequest(**{**base, **kw})


def run(engine, r):
    return asyncio.run(engine.search(r))


def test_date_pairs_respect_window_and_nights():
    p = Fake(lambda o, d, day: [offer(o, d, at(day), 100)])
    res = run(FlightSearchEngine(p), req())
    pairs = {(t.depart_date, t.return_date) for dd in res.daily for t in (dd.cheapest,)}
    assert all(3 <= (r - d).days <= 4 and r <= date(2026, 10, 10) for d, r in pairs)
    assert res.daily[0].depart_date == date(2026, 10, 1)
    assert res.daily[-1].depart_date == date(2026, 10, 7)  # 7+3 = 10 is the last valid return


def test_mixed_airlines_cheapest_picks_each_direction_independently():
    def fn(o, d, day):
        return [offer(o, d, at(day), 50 if o == "TLV" else 80, code="W6"),
                offer(o, d, at(day, 12), 90 if o == "TLV" else 40, code="LY")]
    res = run(FlightSearchEngine(Fake(fn)), req())
    t = res.daily[0].cheapest
    assert t.price == 90 and t.airlines == ["W6", "LY"]
    assert any("different airlines" in w for w in t.warnings)


def test_same_airline_restriction():
    def fn(o, d, day):
        # mixed W6 out + LY back = 50 + 40 = 90; single-airline best is W6 both ways = 130
        return [offer(o, d, at(day), 50 if o == "TLV" else 80, code="W6"),
                offer(o, d, at(day, 12), 90 if o == "TLV" else 40, code="LY")]
    assert run(FlightSearchEngine(Fake(fn)), req()).daily[0].cheapest.price == 90
    t = run(FlightSearchEngine(Fake(fn)), req(allow_mixed_airlines=False)).daily[0].cheapest
    assert t.price == 130 and t.airlines == ["W6"]


def test_open_jaw_generated_and_can_win():
    def fn(o, d, day):
        return [offer(o, d, at(day), 30 if d == "TLV" and o == "BRU" else 100)]
    res = run(FlightSearchEngine(Fake(fn)), req(destinations=["PAR"], return_airports=["BRU"]))
    t = res.daily[0].cheapest
    assert t.kind == "open_jaw" and t.destination == "PAR→BRU" and t.price == 130
    off = run(FlightSearchEngine(Fake(fn)), req(destinations=["PAR"], return_airports=["BRU"], open_jaw=False))
    assert off.daily[0].cheapest.kind == "round_trip"


def test_multi_stop_between_destinations():
    prices = {("TLV", "PAR"): 50, ("LON", "TLV"): 50, ("PAR", "TLV"): 200, ("TLV", "LON"): 200}

    def fn(o, d, day):
        return [offer(o, d, at(day), prices.get((o, d), 20 if {o, d} == {"PAR", "LON"} else 999))]
    r = req(destinations=["PAR", "LON"], open_jaw=False, min_nights=4, max_nights=4)
    off = run(FlightSearchEngine(Fake(fn)), r).daily[0].cheapest
    assert off.kind == "round_trip" and off.price == 250
    on = run(FlightSearchEngine(Fake(fn)), r.model_copy(update={"connect_destinations": True})).daily[0].cheapest
    assert on.kind == "multi_stop" and on.destination == "PAR+LON" and on.price == 120
    assert [(l.origin, l.destination) for l in on.legs] == [("TLV", "PAR"), ("PAR", "LON"), ("LON", "TLV")]


def test_layover_and_travel_time_filters():
    def fn(o, d, day):
        # 1 stop, layover 60 min (too short), plus a good 120 min one
        short = Offer(origin=o, destination=d, price=10, currency="USD", segments=[
            seg(o, "IST", at(day), 120), seg("IST", d, at(day) + timedelta(minutes=180), 120)])
        ok = Offer(origin=o, destination=d, price=60, currency="USD", segments=[
            seg(o, "IST", at(day), 120), seg("IST", d, at(day) + timedelta(minutes=240), 120)])
        return [short, ok]
    res = run(FlightSearchEngine(Fake(fn)), req())
    assert res.daily[0].cheapest.price == 120  # only the 120-min layover offers survive
    none = run(FlightSearchEngine(Fake(fn)), req(max_travel_min_per_direction=200))
    assert none.daily == [] and any("No itinerary" in w for w in none.warnings)
    direct_only = run(FlightSearchEngine(Fake(fn)), req(allow_connections=False))
    assert direct_only.daily == []


def test_self_transfer_bundles_with_buffer_and_warning():
    def fn(o, d, day):
        if (o, d) == ("TLV", "ROM") or (o, d) == ("ROM", "TLV"):
            return []  # no through offer at all
        if d == "IST" or (o == "IST" and d == "TLV"):
            return [offer(o, d, at(day, 8), 40)]
        if o == "IST" and d == "ROM" or (o == "ROM" and d == "IST"):
            return [offer(o, d, at(day, 9), 30),    # gap 8:00+3h=11:00 -> 9:00 departs before arrival: invalid
                    offer(o, d, at(day, 16), 35)]   # gap 5h: valid (buffer 4h)
        return []
    r = req(allow_self_transfer=True, self_transfer_hubs=["IST"])
    res = run(FlightSearchEngine(Fake(fn)), r)
    t = res.daily[0].cheapest
    assert t.self_transfer and t.price == 150
    assert any("SELF-TRANSFER" in w and "IST" in w for w in t.warnings)
    strict = run(FlightSearchEngine(Fake(fn)), req(allow_self_transfer=True, self_transfer_hubs=["IST"],
                                                   self_transfer_buffer_min=30 * 60))
    assert strict.daily == []


def test_best_value_penalises_long_trips():
    def fn(o, d, day):
        slow = Offer(origin=o, destination=d, price=100, currency="USD", segments=[
            seg(o, "IST", at(day, 6), 120), seg("IST", d, at(day, 6) + timedelta(minutes=120 + 18 * 60), 120)])
        return [offer(o, d, at(day), 110), slow]
    res = run(FlightSearchEngine(Fake(fn)), req(max_layover_min=24 * 60))
    d = res.daily[0]
    assert d.cheapest.stops == 2 and d.best_value.stops == 0  # 10$ cheaper but 18h layover loses on value


def test_cache_and_budget():
    p = Fake(lambda o, d, day: [offer(o, d, at(day), 100)])
    engine = FlightSearchEngine(p, OfferCache(":memory:"))
    first = run(engine, req())
    n = len(p.calls)
    second = run(engine, req())
    assert len(p.calls) == n and second.cache_hits == first.api_calls and second.api_calls == 0
    with pytest.raises(BudgetExceeded):
        run(FlightSearchEngine(Fake(lambda *a: [])), req(max_api_calls=3))


def test_provider_failures_become_warnings():
    def fn(o, d, day):
        if day == date(2026, 10, 2):
            raise RuntimeError("boom")
        return [offer(o, d, at(day), 100)]
    res = run(FlightSearchEngine(Fake(fn)), req())
    assert res.daily and any("failed" in w for w in res.warnings)


def test_serpapi_parse():
    data = {
        "search_metadata": {"google_flights_url": "https://www.google.com/travel/flights?x=1"},
        "best_flights": [{"price": 123, "flights": [
            {"departure_airport": {"id": "TLV", "time": "2026-10-05 08:30"},
             "arrival_airport": {"id": "IST", "time": "2026-10-05 11:00"},
             "airline": "Turkish Airlines", "flight_number": "TK 787", "duration": 190},
            {"departure_airport": {"id": "IST", "time": "2026-10-05 13:00"},
             "arrival_airport": {"id": "ROM", "time": "2026-10-05 14:30"},
             "airline": "Turkish Airlines", "flight_number": "TK 1861", "duration": 150}]}],
        "other_flights": [{"flights": []}],  # no price -> skipped
    }
    offers = SerpApiProvider("k").parse(data, "TLV", "ROM", date(2026, 10, 5), "USD")
    assert len(offers) == 1
    o = offers[0]
    assert (o.price, o.stops, o.airlines, o.layovers_min) == (123.0, 1, ["TK"], [120])
    # local times say 150 + 90 min flying, but the provider reports 190 + 150: time zones
    assert o.duration_min == 190 + 150 + 120
    assert o.segments[0].label == "TK787" and o.deep_links[0].endswith("x=1")


def test_simple_endpoint_maps_flat_strings(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from flightagent.api import SimpleSearch, app, to_request

    r = to_request(SimpleSearch(destinations="rom, par", from_date="2026-10-01", to_date="2026-10-20",
                                nights="4-7", direct_only="true", self_transfer_hubs="ist",
                                max_travel_hours="5", top="2"))
    assert r.destinations == ["ROM", "PAR"] and (r.min_nights, r.max_nights) == (4, 7)
    assert r.max_stops_per_leg == 0 and r.allow_self_transfer and r.self_transfer_hubs == ["IST"]
    assert r.max_travel_min_per_direction == 300 and r.top_n == 2

    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    c = TestClient(app)
    ok = c.post("/search/simple", json={"destinations": "ROM", "from_date": "2026-10-01",
                                        "to_date": "2026-10-10", "nights": "3"}).json()
    assert "DEMO DATA" in ok["report"]
    bad = c.post("/search/simple", json={"destinations": "ROM", "from_date": "nonsense",
                                         "to_date": "2026-10-10", "nights": "3"}).json()
    assert "error" in bad


def test_city_codes_expand_for_serpapi(monkeypatch):
    from flightagent.providers.airports import expand
    assert expand("rom") == "FCO,CIA" and expand("TLV") == "TLV"
    sent = {}

    async def fake_get(self, params):
        sent.update(params)
        return {"error": "Google Flights hasn't returned any results for this query."}
    monkeypatch.setattr(SerpApiProvider, "_get", fake_get)
    p = SerpApiProvider("k")
    assert asyncio.run(p.one_way("TLV", "LON", date(2026, 10, 5), currency="USD", adults=1, max_stops=1)) == []
    assert sent["arrival_id"] == "LHR,LGW,STN,LTN,LCY" and sent["departure_id"] == "TLV"


def test_empty_results_are_not_cached_and_warn():
    engine = FlightSearchEngine(Fake(lambda *a: []), OfferCache(":memory:"))
    res = run(engine, req())
    assert any("no flights for ANY route" in w for w in res.warnings)
    assert engine.cache.db.execute("select count(*) from offers").fetchone()[0] == 0


def test_gflights_parses_best_and_other_groups():
    import json
    from pathlib import Path
    from flightagent.providers.gflights import parse_groups

    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    offers = parse_groups(fx["best"] + fx["other"], "TLV", "FCO", "USD")
    assert len(offers) == 9
    cheapest = min(offers, key=lambda o: o.price)
    # the $161 Tus Air fare lives in Google's "best flights" block, which fast-flights drops
    assert (cheapest.price, cheapest.airlines, cheapest.segments[0].label) == (161.0, ["U8"], "U8132")
    assert cheapest.duration_min == 225 and cheapest.stops == 0
    sky = next(o for o in offers if o.airlines == ["GQ"])
    assert sky.stops == 1 and sky.segments[1].origin == "ATH" and sky.layovers_min[0] > 0


def test_fallback_provider_and_selection(monkeypatch):
    from flightagent.providers import FallbackProvider, get_provider

    class Boom:
        name = "boom"
        async def one_way(self, *a, **k):
            raise RuntimeError("blocked")

    backup = Fake(lambda o, d, day: [offer(o, d, at(day), 99)])
    got = asyncio.run(FallbackProvider(Boom(), backup).one_way("TLV", "ROM", date(2026, 10, 5),
                                                             currency="USD", adults=1, max_stops=1))
    assert got[0].price == 99 and got.source == "fake"
    r = run(FlightSearchEngine(FallbackProvider(Boom(), backup)), req())
    assert r.sources == {"fake": r.api_calls} and r.elapsed_s >= 0
    from flightagent.report import render
    assert "lookups via fake x" in render(r)
    monkeypatch.setenv("SERPAPI_API_KEY", "k")
    assert get_provider("gflights,serpapi").name == "gflights+serpapi"
    assert get_provider("mock").name == "mock"


def test_ui_api_search_history_estimate(monkeypatch, tmp_path):
    import time
    from fastapi.testclient import TestClient
    from flightagent.api import app

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    body = {"destinations": ["ROM", "PAR"], "window_start": "2026-10-01", "window_end": "2026-10-10",
            "min_nights": 3, "max_nights": 4}
    with TestClient(app) as c:
        est = c.post("/api/estimate", json=body).json()
        assert est["lookups"] > 0 and est["cached"] == 0 and est["to_fetch"] == est["lookups"]
        assert c.post("/api/searches", json={**body, "max_api_calls": 3}).status_code == 422
        sid = c.post("/api/searches", json=body).json()["id"]
        for _ in range(50):
            row = c.get(f"/api/searches/{sid}").json()
            if row["status"] != "running":
                break
            time.sleep(0.1)
        assert row["status"] == "done" and row["result"]["daily"] and row["best_price"] > 0
        assert row["progress"]["done"] == row["progress"]["total"] == est["lookups"]
        assert c.post("/api/estimate", json=body).json()["to_fetch"] == 0  # now cached
        assert [r["id"] for r in c.get("/api/searches").json()] == [sid]
        assert "result" not in c.get("/api/searches").json()[0]  # list stays light
        assert c.delete(f"/api/searches/{sid}").json() == {"deleted": True}
        assert c.get(f"/api/searches/{sid}").status_code == 404
        assert c.get("/").status_code == 200 and c.get("/health").json()["status"] == "ok"


def test_passenger_ages_map_to_google_categories():
    r = req(adults=2, children_ages=[0, 5, 11, 12, 16])
    assert (r.pax_adults, r.pax_children, r.pax_infants) == (4, 2, 1)
    assert r.pax_label == "2 adults, children aged 0, 5, 11, 12, 16"
    for bad in (dict(children_ages=[18]), dict(children_ages=[-1]), dict(adults=1, children_ages=[0, 1]),
                dict(adults=5, children_ages=[3] * 5), dict(adults=0)):
        with pytest.raises(ValueError):
            req(**bad)


def test_engine_passes_passengers_and_caches_them_separately():
    p = Fake(lambda o, d, day: [offer(o, d, at(day), 100)])
    engine = FlightSearchEngine(p, OfferCache(":memory:"))
    run(engine, req(adults=2, children_ages=[0, 6]))
    assert p.kw == {"adults": 2, "children": 1, "infants": 1}
    n = len(p.calls)
    run(engine, req(adults=2, children_ages=[0, 6]))
    assert len(p.calls) == n                        # same travellers: cached
    res = run(engine, req(adults=2))                # different travellers must not reuse that cache
    assert len(p.calls) > n and res.api_calls > 0
    kids = run(engine, req(adults=2, children_ages=[0, 6]))
    assert any("infant" in w.lower() for w in kids.warnings) and any("totals" in w for w in kids.warnings)
    from flightagent.report import render
    assert render(kids).startswith("Travellers: 2 adults, children aged 0, 6")


def test_gflights_skips_unpriced_flights_instead_of_crashing():
    import json
    from pathlib import Path
    from flightagent.providers.gflights import parse_groups

    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    unpriced = [fx["best"][0][0], [[], "token"]]     # Google lists it but shows no price
    offers = parse_groups(fx["best"] + fx["other"] + [unpriced], "TLV", "FCO", "USD")
    assert len(offers) == 9


def test_serpapi_sends_passengers(monkeypatch):
    sent = {}

    async def fake_get(self, params):
        sent.update(params)
        return {"error": "Google Flights hasn't returned any results for this query."}
    monkeypatch.setattr(SerpApiProvider, "_get", fake_get)
    asyncio.run(SerpApiProvider("k").one_way("TLV", "FCO", date(2026, 10, 5), currency="USD", adults=2, max_stops=1, children=1, infants=1))
    assert (sent["adults"], sent["children"], sent["infants_on_lap"]) == (2, 1, 1)


def test_gflights_encodes_lap_infants_with_measured_wire_value():
    from flightagent.providers.gflights import _passengers

    # ADULT=1, CHILD=2; lap infant is wire value 3 (measured: priced as adult-only fare), not the library's name for 4
    assert _passengers(2, 1, 1).pb() == [1, 1, 2, 3]
    assert _passengers(1, 0, 0).pb() == [1]


def test_simple_endpoint_reports_validation_errors_briefly(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from flightagent.api import app

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    r = TestClient(app).post("/search/simple", json={"destinations": "ROM", "from_date": "2026-10-01", "to_date": "2026-10-09",
                                                      "nights": "4", "adults": "1", "children_ages": "0,1"}).json()
    assert r["error"] == "Each infant under 2 needs their own adult (one lap infant per adult)"


def test_airline_filters_apply_after_fetching_and_report_who_flies_where():
    def fn(o, d, day):
        return [offer(o, d, at(day), 50, code="FR"), offer(o, d, at(day, 12), 90, code="LY"),
                Offer(origin=o, destination=d, price=70, currency="USD", segments=[
                    seg(o, "IST", at(day, 6), 120, "TK"), seg("IST", d, at(day, 6) + timedelta(minutes=300), 120, "TK")])]
    p = Fake(fn)
    engine = FlightSearchEngine(p, OfferCache(":memory:"))
    base = run(engine, req(max_stops_per_leg=1))
    assert base.daily[0].cheapest.price == 100 and base.daily[0].cheapest.airlines == ["FR"]
    calls = len(p.calls)
    no_fr = run(engine, req(max_stops_per_leg=1, airlines_exclude=["fr"]))
    assert len(p.calls) == calls and no_fr.api_calls == 0                       # filters cost no lookups
    assert no_fr.daily[0].cheapest.airlines == ["TK"] and no_fr.daily[0].cheapest.price == 140
    only_ly = run(engine, req(max_stops_per_leg=1, airlines_include=["LY"]))
    assert only_ly.daily[0].cheapest.airlines == ["LY"] and only_ly.daily[0].cheapest.price == 180
    none = run(engine, req(max_stops_per_leg=1, airlines_include=["XX"]))
    assert none.daily == [] and any("No itinerary" in w for w in none.warnings)
    # the airline list is unfiltered, says who flies which direction, and flags what the filter removed
    byc = {a.code: a for a in no_fr.airlines}
    assert set(byc) == {"FR", "LY", "TK"} and byc["FR"].included is False and byc["TK"].included is True
    assert byc["FR"].cheapest == 50 and set(byc["FR"].nonstop) == {"TLV>ROM", "ROM>TLV"}
    assert byc["TK"].nonstop == [] and set(byc["TK"].routes) == {"TLV>ROM", "ROM>TLV"}
    from flightagent.report import render
    assert "Ryanair" not in render(no_fr) and "FR) from 50" in render(no_fr) and "[excluded by filter]" in render(no_fr)


def test_ui_files_are_revalidated_not_heuristically_cached():
    from fastapi.testclient import TestClient
    from flightagent.api import app

    with TestClient(app) as c:
        for path in ("/", "/app.js", "/style.css"):
            assert c.get(path).headers["cache-control"] == "no-cache"
