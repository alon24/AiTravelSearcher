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

    async def one_way(self, o, d, day, *, currency, adults, max_stops):
        self.calls.append((o, d, day))
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
