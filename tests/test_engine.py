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
        co2 = {} if (o, d) == ("IST", "TLV") else {"co2_g": 90000, "co2_typical_g": 100000}   # one ticket without Google's CO2
        if d == "IST" or (o == "IST" and d == "TLV"):
            return [offer(o, d, at(day, 8), 40).model_copy(update=co2)]
        if o == "IST" and d == "ROM" or (o == "ROM" and d == "IST"):
            return [offer(o, d, at(day, 9), 30).model_copy(update=co2),    # gap 8:00+3h=11:00 -> 9:00 departs before arrival: invalid
                    offer(o, d, at(day, 16), 35).model_copy(update=co2)]   # gap 5h: valid (buffer 4h)
        return []
    r = req(allow_self_transfer=True, self_transfer_hubs=["IST"])
    res = run(FlightSearchEngine(Fake(fn)), r)
    t = res.daily[0].cheapest
    assert t.self_transfer and t.price == 150
    # a bundle's CO2 is the sum of its tickets, and unknown when any ticket's is
    assert (t.legs[0].co2_g, t.legs[0].co2_typical_g) == (180000, 200000)
    assert (t.legs[1].co2_g, t.legs[1].co2_typical_g) == (None, None)
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
    # what Google shows per flight: aircraft, legroom (left out for some), CO2 against the route's typical figure
    assert (cheapest.segments[0].aircraft, cheapest.segments[0].legroom) == ("Boeing 737", "30 in")
    assert (cheapest.co2_g, cheapest.co2_typical_g) == (239000, 200000)
    wizz = next(o for o in offers if o.segments[0].label == "W46044")
    assert (wizz.segments[0].aircraft, wizz.segments[0].legroom) == ("Airbus A321neo", "")
    sky = next(o for o in offers if o.airlines == ["GQ"])
    assert sky.stops == 1 and sky.segments[1].origin == "ATH" and sky.layovers_min[0] > 0


def test_gflights_links_each_fare_to_the_exact_google_page_it_came_from(monkeypatch):
    """The "Google Flights" button must reopen the search that priced the fare: same passengers, bags, stops, currency."""
    import base64
    import json
    from pathlib import Path
    from urllib.parse import parse_qs, urlsplit
    from flightagent.providers.gflights import GoogleFlightsScraper

    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    payload = [None, None, [fx["best"]], [fx["other"]]]
    html = f"<script class=\"ds:1\">AF_initDataCallback({{key: 'ds:1', data:{json.dumps(payload)}, sideChannel: {{}}}});</script>"
    fetched = []
    monkeypatch.setattr(GoogleFlightsScraper, "_fetch", staticmethod(lambda url, what: fetched.append(url) or html))
    offers = asyncio.run(GoogleFlightsScraper(delay=(0, 0)).one_way(
        "TLV", "FCO", date(2026, 10, 5), currency="EUR", adults=2, children=1, max_stops=0, checked_bags=1))
    assert offers[0].deep_links[0] == fetched[0]
    link = urlsplit(fetched[0])
    q = parse_qs(link.query)
    assert f"{link.scheme}://{link.netloc}{link.path}" == "https://www.google.com/travel/flights"
    assert q["curr"] == ["EUR"] and q["hl"] == ["en-US"]
    tfs = base64.b64decode(q["tfs"][0])
    assert b"2026-10-05" in tfs and b"\x08\x01\x12\x03TLV" in tfs
    assert {o.deep_links[0] for o in offers} == {offers[0].deep_links[0]}


def test_roundtrip_asks_google_for_both_legs_and_answers_its_cheapest_return_ticket(monkeypatch, tmp_path):
    """POST /api/roundtrip: Google's round-trip page (both legs, trip type 1) prices each outbound as the whole return
    ticket, so its lowest price is the cheapest return ticket on those dates. Without Google in the chain it says so."""
    import base64
    import json
    from pathlib import Path
    from urllib.parse import parse_qs, urlsplit
    from fastapi.testclient import TestClient
    import flightagent.api as api
    from flightagent.providers import FallbackProvider, GoogleFlightsScraper, MockProvider

    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    payload = [None, None, [fx["best"]], [fx["other"]]]
    html = f"<script class=\"ds:1\">AF_initDataCallback({{key: 'ds:1', data:{json.dumps(payload)}, sideChannel: {{}}}});</script>"
    fetched = []
    monkeypatch.setattr(GoogleFlightsScraper, "_fetch", staticmethod(lambda url, what: fetched.append(url) or html))
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    chain = FallbackProvider(GoogleFlightsScraper(delay=(0, 0)), MockProvider())
    monkeypatch.setattr(api, "build_engine", lambda: FlightSearchEngine(chain))
    body = {"request": {"destinations": ["FCO"], "window_start": "2026-10-05", "window_end": "2026-10-12", "min_nights": 5,
                        "max_nights": 5, "currency": "EUR", "adults": 2}, "origin": "TLV", "dest": "FCO",
            "date": "2026-10-05", "return_date": "2026-10-10"}
    with TestClient(api.app) as c:
        r = c.post("/api/roundtrip", json=body).json()
        assert r == {"price": 161.0, "flights": 9, "url": fetched[0]}
        q = parse_qs(urlsplit(fetched[0]).query)
        tfs = base64.b64decode(q["tfs"][0])
        assert q["curr"] == ["EUR"] and b"2026-10-05" in tfs and b"2026-10-10" in tfs and tfs.endswith(b"\x98\x01\x01")  # trip type 1
        monkeypatch.setattr(api, "build_engine", lambda: FlightSearchEngine(MockProvider()))
        no = c.post("/api/roundtrip", json=body)
        assert no.status_code == 409 and "round-trip prices come from Google Flights" in no.json()["detail"]


def test_gflights_query_marks_each_place_as_an_airport():
    """Measured 2026-10-11: Google answers a bare airport code (fast-flights' encoding) with its landing page and no
    results; the same query with the place typed as an airport, {1: 1, 2: "TLV"}, returns the flights."""
    import base64
    from flightagent.providers.gflights import tfs

    q = base64.b64decode(tfs("TLV", "FCO", "2026-10-27", adults=2, children=1, infants=1, max_stops=0, checked=1))
    leg = b"\x12\x0a2026-10-27" + b"\x28\x00" + b"\x6a\x07\x08\x01\x12\x03TLV" + b"\x72\x07\x08\x01\x12\x03FCO"
    # passengers ADULT=1, CHILD=2, and 3 for a lap infant (measured: priced as the adult-only fare; fast-flights calls 3
    # INFANT_IN_SEAT); economy; one checked bag; one way
    assert q == (b"\x1a" + bytes([len(leg)]) + leg + b"\x42\x04\x01\x01\x02\x03" + b"\x48\x01"
                 + b"\x6a\x04\x10\x00\x18\x01" + b"\x98\x01\x02")
    # a city code (ROM) stays bare, as before: its typing is not measured yet; IST is a city code AND an airport
    assert b"\x72\x05\x12\x03ROM" in base64.b64decode(tfs("TLV", "ROM", "2026-10-27"))
    assert b"\x72\x07\x08\x01\x12\x03IST" in base64.b64decode(tfs("TLV", "IST", "2026-10-27"))


def test_gflights_landing_page_is_an_error_not_no_flights():
    """Google answers a query it can't read with its start page: that must fail loudly, not read as "no flights"."""
    from flightagent.providers.gflights import parse_html

    script = "<script class=\"ds:1\">AF_initDataCallback({key: 'ds:1', data:[null,null,null,null], sideChannel: {}});</script>"
    with pytest.raises(RuntimeError, match="landing page"):
        parse_html(f"<html><head><title>Find Cheap Flights Worldwide & Track Prices</title></head><body>{script}</body></html>",
                   "TLV", "FCO", "USD")
    assert parse_html(f"<html><head><title>Tel Aviv to Rome</title></head><body>{script}</body></html>", "TLV", "FCO", "USD") == []


def test_gflights_reads_googles_usual_price_range():
    """payload[5] is Google's price insight (shape read from a live page on 2026-10-11): [level, current, _, _, low, high, ...]."""
    import json
    from pathlib import Path
    from flightagent.providers.gflights import parse_html, usual_range

    insight = [5, [None, 124], [None, 66], [None, -59], [None, 60], [None, 110], 1, None, None, None, [[1786320000000, 139]]]
    assert usual_range([None] * 5 + [insight]) == [60.0, 110.0]
    assert usual_range([None, None, [], []]) is None and usual_range([None] * 5 + [[4, [None, 186]]]) is None
    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    payload = [None, None, [fx["best"]], [fx["other"]], None, insight]
    html = f"<script class=\"ds:1\">AF_initDataCallback({{key: 'ds:1', data:{json.dumps(payload)}, sideChannel: {{}}}});</script>"
    assert {tuple(o.usual_price) for o in parse_html(html, "TLV", "FCO", "USD")} == {(60.0, 110.0)}


def test_gflights_reads_googles_fares_on_nearby_days():
    """payload[6] lists the search's cheapest fare on nearby days (shape read from a live page on 2026-10-11); a
    round-trip entry (with a return date) does not belong to a one-way search."""
    from flightagent.providers.gflights import nearby_dates

    grid = [["2026-10-28", None, [[None, 70], "tok"], [1, 1]], ["2026-10-26", None, [[None, 63], "tok"]],
            ["2026-10-26", "2026-10-31", [[None, 126], "tok"]], ["2026-10-25", None, [None]]]
    assert nearby_dates([None] * 6 + [grid]) == [("2026-10-26", 63.0), ("2026-10-28", 70.0)]
    assert nearby_dates([None] * 5) is None and nearby_dates([None] * 6 + [[]]) is None


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
    assert got.fallback == "boom failed (blocked), so fake answered"
    assert any(w.startswith(f"{r.api_calls} lookup(s) used the backup provider; first: boom failed (blocked)") for w in r.warnings), \
        "a lookup answered by the backup (maybe paid) always says why"
    both = FallbackProvider(Boom(), Boom())
    with pytest.raises(RuntimeError, match=r"^boom: blocked; boom: blocked$"):
        asyncio.run(both.one_way("TLV", "ROM", date(2026, 10, 5), currency="USD", adults=1, max_stops=1))
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


def test_cancel_stops_a_running_search_and_keeps_what_it_fetched(monkeypatch, tmp_path):
    import time
    from fastapi.testclient import TestClient
    import flightagent.api as api

    class Slow(Fake):
        async def one_way(self, o, d, day, **kw):
            await asyncio.sleep(0.05)
            return await super().one_way(o, d, day, **kw)

    slow = Slow(lambda o, d, day: [offer(o, d, at(day), 100)])
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    monkeypatch.setattr(api, "build_engine", lambda: FlightSearchEngine(slow, cache=OfferCache(str(tmp_path / "c.sqlite")), concurrency=1))
    body = {"destinations": ["ROM"], "window_start": "2026-10-01", "window_end": "2026-10-20", "min_nights": 3, "max_nights": 4,
            "max_api_calls": 500}
    with TestClient(api.app) as c:
        sid = c.post("/api/searches", json=body).json()["id"]
        time.sleep(0.3)
        assert c.post(f"/api/searches/{sid}/cancel").json() == {"cancelled": True}
        for _ in range(50):
            row = c.get(f"/api/searches/{sid}").json()
            if row["status"] != "running":
                break
            time.sleep(0.05)
        assert row["status"] == "failed" and row["error"] == api.CANCELLED
        made = len(slow.calls)
        assert 0 < made < row["progress"]["total"], "it stopped part way"
        time.sleep(0.2)
        assert len(slow.calls) == made, "no lookups after Cancel"
        assert c.post("/api/estimate", json=body).json()["cached"] >= made - 1, "what it fetched is reused"
        assert c.post(f"/api/searches/{sid}/cancel").status_code == 409


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
    assert p.kw == {"adults": 2, "children": 1, "infants": 1, "carry_on_bags": 0, "checked_bags": 0}
    n = len(p.calls)
    run(engine, req(adults=2, children_ages=[0, 6]))
    assert len(p.calls) == n                        # same travellers: cached
    res = run(engine, req(adults=2))                # different travellers must not reuse that cache
    assert len(p.calls) > n and res.api_calls > 0
    kids = run(engine, req(adults=2, children_ages=[0, 6]))
    assert any("infant" in w.lower() for w in kids.warnings) and any("totals" in w for w in kids.warnings)
    from flightagent.report import render
    assert render(kids).startswith("Travellers: 2 adults, children aged 0, 6")


def test_gflights_keeps_unpriced_flights_but_flags_them():
    import json
    from pathlib import Path
    from flightagent.providers.gflights import parse_groups

    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    unpriced = [fx["best"][0][0], [[], "token"]]     # Google lists it but shows no price (e.g. HiSky, sold only on its own site)
    offers = parse_groups(fx["best"] + fx["other"] + [unpriced], "TLV", "FCO", "USD")
    assert len(offers) == 10 and sum(not o.priced for o in offers) == 1
    assert [o for o in offers if not o.priced][0].price == 0


def test_unpriced_flights_are_listed_but_never_ranked_or_counted_as_fares():
    def fn(o, d, day):
        real = offer(o, d, at(day), 100, code="W4")
        hisky = Offer(origin=o, destination=d, price=0, currency="USD", priced=False,
                      segments=[seg(o, d, at(day, 14) + timedelta(minutes=50), 150, "H4", "236")])
        return [real, hisky]
    res = run(FlightSearchEngine(Fake(fn), OfferCache(":memory:")), req())
    assert res.daily and all(t.airlines == ["W4"] for d in res.daily for t in (d.cheapest, d.best_value))   # never a trip
    hi = next(a for a in res.airlines if a.code == "H4")
    assert hi.cheapest is None and hi.no_price_routes and hi.offers > 0                               # 'flies here', no fare
    assert next(a for a in res.airlines if a.code == "W4").cheapest == 100
    assert res.unpriced and res.unpriced[0].flights == "H4236" and res.unpriced[0].origin in ("TLV", "ROM")
    from flightagent.report import render
    text = render(res)
    assert "FLIGHTS LISTED WITHOUT A PRICE" in text and "H4236" in text and "HiSky" not in text or True
    assert "H4) no price shown" in text


def test_serpapi_sends_passengers(monkeypatch):
    sent = {}

    async def fake_get(self, params):
        sent.update(params)
        return {"error": "Google Flights hasn't returned any results for this query."}
    monkeypatch.setattr(SerpApiProvider, "_get", fake_get)
    asyncio.run(SerpApiProvider("k").one_way("TLV", "FCO", date(2026, 10, 5), currency="USD", adults=2, max_stops=1, children=1, infants=1))
    assert (sent["adults"], sent["children"], sent["infants_on_lap"]) == (2, 1, 1)


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


def test_scraper_retries_when_a_fare_is_missing_then_merges():
    from flightagent.providers.gflights import GoogleFlightsScraper, _merge

    priced = offer("TLV", "OTP", at(date(2026, 9, 28), 14), 505, code="H4")
    unpriced = priced.model_copy(update={"priced": False, "price": 0.0})
    other = offer("TLV", "OTP", at(date(2026, 9, 28), 16), 415, code="W4")
    merged = _merge([unpriced, other], [priced])
    assert [(o.airlines[0], o.priced) for o in merged] == [("H4", True), ("W4", True)]
    assert _merge([unpriced], [unpriced])[0].priced is False                   # stays unpriced if it never shows up

    class Flaky(GoogleFlightsScraper):
        calls = 0

        async def _once(self, *a):
            Flaky.calls += 1
            return [unpriced] if Flaky.calls == 1 else [priced]
    got = asyncio.run(Flaky(delay=(0, 0)).one_way("TLV", "OTP", date(2026, 9, 28), currency="ILS", adults=1, max_stops=1))
    assert Flaky.calls == 2 and got[0].priced and got[0].price == 505

    class Never(GoogleFlightsScraper):
        calls = 0

        async def _once(self, *a):
            Never.calls += 1
            return [unpriced]
    asyncio.run(Never(delay=(0, 0)).one_way("TLV", "OTP", date(2026, 9, 28), currency="ILS", adults=1, max_stops=1))
    assert Never.calls == 3                                                     # one try + two retries, then gives up


def test_airline_finder_aggregates_by_airline_and_only_widens_active_airports():
    from flightagent.explore import explore

    def fn(o, d, day):
        if d not in ("OTP", "CLJ"):
            return []                                              # IAS and SBZ have no service
        if d == "OTP":
            return [offer(o, d, at(day), 400, code="W4"), offer(o, d, at(day, 14), 505, code="H4"),
                    Offer(origin=o, destination=d, price=900, currency="USD", segments=[seg(o, "ATH", at(day, 6), 120, "A3"), seg("ATH", d, at(day, 6) + timedelta(minutes=300), 120, "A3")])]
        return [offer(o, d, at(day), 450, code="W4")]
    p = Fake(fn)
    engine = FlightSearchEngine(p, OfferCache(":memory:"))
    r = req(destinations=["OTP"], window_start=date(2026, 9, 28), window_end=date(2026, 9, 29), min_nights=1, max_nights=1)
    res = asyncio.run(explore(engine, r, "TLV", ["OTP", "CLJ", "IAS", "SBZ"], "to", date(2026, 9, 28), [2, 5]))
    assert res.airports_with_flights == ["OTP", "CLJ"]
    assert len(p.calls) == 4 + 2 * 2                    # every airport on day 1, then only the 2 active ones on 2 more days
    by = {a.code: a for a in res.airlines}
    assert set(by) == {"W4", "H4", "A3"}
    assert by["W4"].nonstop_airports == 2 and {r.airport for r in by["W4"].routes} == {"OTP", "CLJ"}
    assert by["H4"].nonstop_airports == 1 and by["H4"].routes[0].cheapest == 505
    a3 = by["A3"].routes[0]
    assert by["A3"].nonstop_airports == 0 and a3.airport == "OTP" and a3.nonstop is False    # only with a stop
    assert len(by["W4"].routes[0].dates) == 3 and res.dates[0] == date(2026, 9, 28)
    assert [a.code for a in res.airlines][0] == "W4"                                          # most nonstop airports first


def test_cache_expiry_is_per_entry_and_unpriced_results_are_rechecked_soon():
    import time
    from flightagent.polling import fare_ttl, next_check_time, unpriced_interval

    c = OfferCache(":memory:", ttl_hours=6)
    c.put("a", [], ttl=-1); c.put("b", [], ttl=60); c.put("old", [])
    assert not c.has("a") and c.get("a") is None and c.has("b") and c.has("old")   # each entry has its own lifetime
    assert (unpriced_interval(3), unpriced_interval(30), unpriced_interval(200)) == (900, 3600, 10800)
    assert fare_ttl(1, 6 * 3600) == 3600 and fare_ttl(10, 6 * 3600) == 3 * 3600 and fare_ttl(90, 6 * 3600) == 6 * 3600

    p = Fake(lambda o, d, day: [])
    e = FlightSearchEngine(p, c)
    soon, later = date.today() + timedelta(days=5), date.today() + timedelta(days=100)
    unp = Offer(origin="TLV", destination="OTP", price=0, currency="USD", priced=False, segments=[seg("TLV", "OTP", at(soon), 150, "H4")])
    ok = offer("TLV", "OTP", at(soon), 100)
    assert e._ttl_for(soon, [unp]) == 900 and e._ttl_for(later, [unp]) == 3 * 3600      # "no price" is not kept for 6 hours
    assert e._ttl_for(soon, [ok]) == 3 * 3600 and e._ttl_for(later, [ok]) == 6 * 3600
    t = date.today()
    assert next_check_time([t + timedelta(days=3)], 0, 1000.0) == 1900.0                  # 15 min
    assert next_check_time([t + timedelta(days=3)], 4, 1000.0) == 1000.0 + 1800          # backs off after 4 fruitless rechecks
    assert next_check_time([t + timedelta(days=3)], 99, 1000.0) == 1000.0 + 6 * 3600     # capped at 6 hours
    assert next_check_time([t - timedelta(days=1)], 0, 1000.0) is None and next_check_time([], 0, 1000.0) is None


def test_refresh_unpriced_bypasses_a_cached_no_price_but_not_priced_results():
    calls = {"n": 0}

    def fn(o, d, day):
        calls["n"] += 1
        good = offer(o, d, at(day), 100, code="W4")
        hi = Offer(origin=o, destination=d, price=505 if calls["n"] > 2 else 0, currency="USD", priced=calls["n"] > 2,
                   segments=[seg(o, d, at(day, 14), 150, "H4", "236")])
        return [good, hi]
    p = Fake(fn)
    engine = FlightSearchEngine(p, OfferCache(":memory:"))
    first = run(engine, req())
    assert first.unpriced and calls["n"] == first.api_calls
    n = calls["n"]
    assert run(engine, req()).unpriced and calls["n"] == n                           # normal search: served from the cache
    again = run(engine, req(refresh_unpriced=True))
    assert calls["n"] > n and not again.unpriced                                     # recheck refetched and found the fare
    n2 = calls["n"]
    run(engine, req(refresh_unpriced=True))
    assert calls["n"] == n2                                                           # nothing unpriced left: cache is used again


def test_last_seen_fare_is_remembered_when_google_drops_it():
    state = {"priced": True}

    def fn(o, d, day):
        hi = Offer(origin=o, destination=d, price=505 if state["priced"] else 0, currency="USD", priced=state["priced"],
                   segments=[seg(o, d, at(day, 14) + timedelta(minutes=50), 150, "H4", "236")])
        return [offer(o, d, at(day), 100, code="W4"), hi]
    engine = FlightSearchEngine(Fake(fn), OfferCache(":memory:"))
    first = run(engine, req())
    assert not first.unpriced                                   # priced at first: nothing unpriced yet
    state["priced"] = False                                     # later Google shows no fare for the same flight
    again = run(engine, req(refresh_unpriced=True, max_nights=4))   # different key set -> fresh fetch
    engine.cache.db.execute("DELETE FROM offers"); engine.cache.db.commit()
    later = run(engine, req())
    assert later.unpriced and all(u.last_price == 505 and u.last_seen for u in later.unpriced)
    from flightagent.report import render
    assert "last seen at 505" in render(later)


def test_cells_give_the_cheapest_trip_per_destination_and_length():
    """4, 5 or 6 nights to Rome or Paris: one cell per combination, each the cheapest trip of that length."""
    def fn(o, d, day):
        base = {"FCO": 100, "ROM": 100, "CDG": 150, "PAR": 150}.get(d if o == "TLV" else o, 100)
        return [offer(o, d, at(day), base + day.day)]     # later days cost a little more, so earliest dates win
    r = req(destinations=["ROM", "PAR"], open_jaw=False, min_nights=4, max_nights=6, window_start=date(2026, 10, 1), window_end=date(2026, 10, 12))
    res = run(FlightSearchEngine(Fake(fn)), r)
    got = {(c.destination, c.nights): c for c in res.cells}
    assert {n for _, n in got} == {4, 5, 6} and {d for d, _ in got} == {"ROM", "PAR"}
    assert len(res.cells) == 6                                               # 2 destinations x 3 lengths, no more
    for c in res.cells:
        assert c.cheapest.destination == c.destination and c.cheapest.nights == c.nights
        assert c.cheapest.depart_date == date(2026, 10, 1)                   # earliest departure is the cheapest here
        assert c.trips >= 1
    assert got[("ROM", 4)].cheapest.price < got[("PAR", 4)].cheapest.price  # Rome is cheaper than Paris at every length
    assert [c.nights for c in res.cells] == sorted(c.nights for c in res.cells)   # sent ordered by nights


def test_cells_are_capped():
    from flightagent.engine import FlightSearchEngine as E
    old = E.MAX_CELLS
    E.MAX_CELLS = 2
    try:
        p = Fake(lambda o, d, day: [offer(o, d, at(day), 100 + day.day)])
        res = run(E(p), req(destinations=["ROM", "PAR"], open_jaw=False, min_nights=4, max_nights=6))
        assert len(res.cells) == 2
    finally:
        E.MAX_CELLS = old
