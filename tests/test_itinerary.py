from datetime import datetime, timedelta

from flightagent.geo import metro_of, transfer_between, tz_of
from flightagent.itinerary import analyse, check_gap
from flightagent.models import LegView, Segment


def leg(o, d, dep, minutes=180, price=100):
    s = Segment(airline_code="W4", flight_number="1", origin=o, destination=d, departs=dep, arrives=dep + timedelta(minutes=minutes))
    return LegView(origin=o, destination=d, airlines=["W4"], segments=[s], stops=0, layovers_min=[], duration_min=minutes,
                   price=price, self_transfer=False, deep_links=[])


T0 = datetime(2026, 10, 12, 10, 0)


def gap(a_dest, b_origin, wait_min, a_origin="TLV", b_dest="TLV"):
    a = leg(a_origin, a_dest, T0)
    b = leg(b_origin, b_dest, a.segments[-1].arrives + timedelta(minutes=wait_min))
    return check_gap(0, a, b)


def test_geo_basics():
    assert transfer_between("FCO", "CIA") == (60, "taxi, or train via Roma Termini")
    assert transfer_between("cia", "fco")[0] == 60                  # order and case do not matter
    assert transfer_between("LHR", "CDG") is None and transfer_between("FCO", "FCO") is None
    assert transfer_between("LHR", "STN")[0] == 100 and metro_of("orly") is None and metro_of("ORY") == "PAR"
    assert str(tz_of("TLV")) == "Asia/Jerusalem" and str(tz_of("JFK")) == "America/New_York" and tz_of("ZZZ") is None


def test_same_airport_thresholds():
    assert gap("FCO", "FCO", -30).status == "impossible" and "before this one lands" in gap("FCO", "FCO", -30).headline
    assert gap("FCO", "FCO", 60).status == "impossible"
    g = gap("FCO", "FCO", 150)
    assert g.status == "tight" and g.headline.startswith("Tight connection") and "separate tickets" in g.detail
    assert gap("FCO", "FCO", 240).status == "ok"
    long = gap("FCO", "FCO", 10 * 60)
    assert long.long_wait and long.headline.startswith("Long wait: 10h 00m")
    nights = gap("FCO", "FCO", 4 * 24 * 60 + 5 * 60)
    assert nights.status == "ok" and nights.gap_text == "4 nights" and nights.detail == ""


def test_different_airports_same_city_mention_transfer_time():
    tight = gap("FCO", "CIA", 150)                       # needs 60 + 120 = 180
    assert tight.kind == "same_city" and tight.status == "tight" and tight.transfer_min == 60 and tight.needed_min == 180
    assert "about 60 min" in tight.detail and "estimate" in tight.detail and "3h 00m" in tight.detail
    assert gap("FCO", "CIA", 50).status == "impossible" and gap("FCO", "CIA", 200).status == "ok"
    stay = gap("FCO", "CIA", 4 * 24 * 60)                # a multi-night stay still mentions the transfer, without the hurry
    assert stay.status == "ok" and "about 60 min" in stay.detail and "check in" not in stay.detail
    assert "landing at FCO and leaving from CIA" in stay.headline


def test_different_cities_have_no_estimate():
    g = gap("CDG", "BRU", 3 * 60)
    assert g.kind == "different_city" and g.status == "tight" and g.transfer_min is None and "different cities" in g.detail
    assert gap("CDG", "BRU", 2 * 24 * 60).status == "ok"


def test_gap_uses_time_zones_not_clock_difference():
    # Land at LHR 13:00 local (BST = UTC+1 -> 12:00 UTC); next flight from CDG 14:30 local (CEST = UTC+2 -> 12:30 UTC).
    a = leg("TLV", "LHR", datetime(2026, 10, 12, 10, 0), minutes=180)
    b = leg("CDG", "TLV", datetime(2026, 10, 12, 14, 30))
    g = check_gap(0, a, b)
    assert g.gap_min == 30 and g.tz_known                  # clocks say 90 minutes, reality is 30
    assert check_gap(0, a, leg("ZZZ", "TLV", datetime(2026, 10, 12, 14, 30))).tz_known is False


def test_gap_counts_a_clock_change_between_airports_of_one_time_zone():
    # Rome springs forward at 02:00 on 29 March: land FCO 01:00 CET (00:00 UTC), leave CIA 03:00 CEST (01:00 UTC).
    a = leg("TLV", "FCO", datetime(2026, 3, 28, 22, 0), minutes=180)
    b = leg("CIA", "TLV", datetime(2026, 3, 29, 3, 0))
    g = check_gap(0, a, b)
    assert g.gap_min == 60 and g.status == "tight"     # clocks say 2h, but only 1h passes


def test_analyse_totals_and_separate_ticket_warning():
    a, b = leg("TLV", "FCO", T0, price=65), leg("CIA", "TLV", T0 + timedelta(days=4), price=80)
    res = analyse([a, b], "USD")
    assert res.total_price == 145 and len(res.gaps) == 1 and "separate ticket" in res.warnings[0]
    assert analyse([a]).warnings == []


def test_open_jaw_trip_warns_about_the_airport_transfer(tmp_path):
    import asyncio
    from datetime import date

    from flightagent.cache import OfferCache
    from flightagent.engine import FlightSearchEngine
    from flightagent.models import Offer, SearchRequest

    class P:
        name = "p"

        async def one_way(self, o, d, day, **kw):
            dep = datetime.combine(day, datetime.min.time()) + timedelta(hours=10)
            s = Segment(airline_code="W4", flight_number="1", origin=o, destination=d, departs=dep, arrives=dep + timedelta(minutes=180))
            return [Offer(origin=o, destination=d, price=90 if "CIA" in (o, d) else 100, currency="USD", segments=[s])]

    r = SearchRequest(destinations=["FCO"], return_airports=["CIA"], window_start=date(2026, 10, 1), window_end=date(2026, 10, 6),
                      min_nights=4, max_nights=4)
    res = asyncio.run(FlightSearchEngine(P(), OfferCache(":memory:")).search(r))
    oj = next(d.cheapest for d in res.daily if d.cheapest.kind == "open_jaw")
    assert any("landing at FCO and leaving from CIA" in w and "about 60 min" in w for w in oj.warnings)
    plain = SearchRequest(destinations=["FCO"], window_start=date(2026, 10, 1), window_end=date(2026, 10, 6), min_nights=4, max_nights=4)
    res2 = asyncio.run(FlightSearchEngine(P(), OfferCache(":memory:")).search(plain))
    assert all(t.kind == "round_trip" and not any("min" in w for w in t.warnings)      # a same-airport round trip stays quiet
               for d in res2.daily for t in (d.cheapest, d.best_value))


def test_builder_endpoints(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from flightagent.api import app

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    with TestClient(app) as c:
        r = c.get("/api/flights", params={"origin": "tlv", "dest": "ROM", "date": "2026-10-12", "adults": 2, "children_ages": "5"})
        assert r.status_code == 200
        body = r.json()
        prices = [f["price"] for f in body["flights"]]
        assert body["origin"] == "TLV" and body["travellers"] == "2 adults, children aged 5" and prices == sorted(prices) and prices
        assert c.get("/api/flights", params={"origin": "TLV", "dest": "ROM", "date": "2026-10-12", "adults": 1, "children_ages": "0,1"}).status_code == 422
        legs = [body["flights"][0], c.get("/api/flights", params={"origin": "ROM", "dest": "TLV", "date": "2026-10-16"}).json()["flights"][0]]
        chk = c.post("/api/itinerary/check", json={"legs": legs, "currency": "USD"}).json()
        assert len(chk["gaps"]) == 1 and chk["total_price"] > 0 and chk["gaps"][0]["gap_min"] > 0
        assert c.post("/api/itinerary/check", json={"legs": []}).status_code == 422


def test_recheck_endpoint_and_due_schedule(monkeypatch, tmp_path):
    import time
    from fastapi.testclient import TestClient
    from flightagent.api import app, history

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    body = {"destinations": ["ROM"], "window_start": "2026-10-01", "window_end": "2026-10-08", "min_nights": 3, "max_nights": 3}
    with TestClient(app) as c:
        sid = c.post("/api/searches", json=body).json()["id"]
        for _ in range(60):
            row = c.get(f"/api/searches/{sid}").json()
            if row["status"] == "done":
                break
            time.sleep(0.1)
        assert row["status"] == "done" and row["next_check"] is None and row["rechecks"] == 0      # nothing unpriced: nothing to poll
        r = c.post(f"/api/searches/{sid}/recheck").json()
        assert r["changed"] == {"before": 0, "after": 0} and r["search"]["rechecks"] == 1 and r["search"]["result"]["daily"]
        assert c.post("/api/searches/nope/recheck").status_code == 404
        # due(): only searches whose next_check has passed are returned
        h = history()
        h.postpone(sid, time.time() - 5)
        assert h.due(time.time()) == [sid]
        h.postpone(sid, time.time() + 900)
        assert h.due(time.time()) == []


def test_rates_endpoint_uses_ecb_then_falls_back(monkeypatch):
    import flightagent.api as api
    from fastapi.testclient import TestClient

    class Resp:
        def raise_for_status(self): pass
        def json(self): return {"date": "2026-09-21", "rates": {"ILS": 3.0115, "GBP": 0.74656, "EUR": 0.87032}}

    class OK:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None): return Resp()

    class Down(OK):
        async def get(self, url, params=None): raise RuntimeError("offline")

    api._RATES.update(at=0.0, data=None)
    monkeypatch.setattr(api.httpx, "AsyncClient", OK)
    with TestClient(api.app) as c:
        r = c.get("/api/rates").json()
        assert r["rates"]["ILS"] == 3.0115 and r["rates"]["USD"] == 1.0 and r["source"].startswith("ECB")
        assert c.get("/api/rates").json() == r                       # cached
        api._RATES.update(at=0.0, data=None)
        monkeypatch.setattr(api.httpx, "AsyncClient", Down)
        fb = c.get("/api/rates").json()
        assert fb["source"] == "approximate fallback" and set(fb["rates"]) == {"USD", "ILS", "GBP", "EUR"}
    api._RATES.update(at=0.0, data=None)


def test_bags_are_part_of_the_cache_key_and_reach_the_provider():
    import asyncio
    from datetime import date

    from flightagent.cache import OfferCache
    from flightagent.engine import FlightSearchEngine
    from flightagent.models import Offer, SearchRequest, Segment

    seen = []

    class P:
        name = "p"

        async def one_way(self, o, d, day, *, currency, adults, max_stops, carry_on_bags=0, checked_bags=0, **kw):
            seen.append((carry_on_bags, checked_bags))
            dep = datetime.combine(day, datetime.min.time()) + timedelta(hours=9)
            s = Segment(airline_code="FR", flight_number="1", origin=o, destination=d, departs=dep, arrives=dep + timedelta(hours=3))
            return [Offer(origin=o, destination=d, price=50 + 48 * carry_on_bags + 30 * checked_bags, currency="USD", segments=[s])]

    engine = FlightSearchEngine(P(), OfferCache(":memory:"))
    base = dict(destinations=["ROM"], window_start=date(2026, 10, 1), window_end=date(2026, 10, 6), min_nights=4, max_nights=4)
    r0 = asyncio.run(engine.search(SearchRequest(**base)))
    r1 = asyncio.run(engine.search(SearchRequest(**base, carry_on_bags=1)))
    assert r0.daily[0].cheapest.price == 100 and r1.daily[0].cheapest.price == 196      # 2 x (50 + 48): a separate cache entry
    assert (0, 0) in seen and (1, 0) in seen
    assert any("estimated fees for 1 cabin bag" in w for w in r1.warnings) and not any("estimated fees" in w for w in r0.warnings)


def test_search_flights_and_bag_fee_endpoints(monkeypatch, tmp_path):
    import time
    from fastapi.testclient import TestClient
    from flightagent.api import app

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    body = {"destinations": ["ROM"], "window_start": "2026-10-01", "window_end": "2026-10-08", "min_nights": 3, "max_nights": 3}
    with TestClient(app) as c:
        sid = c.post("/api/searches", json=body).json()["id"]
        for _ in range(60):
            if c.get(f"/api/searches/{sid}").json()["status"] == "done":
                break
            time.sleep(0.1)
        r = c.get(f"/api/searches/{sid}/flights", params={"origin": "TLV", "dest": "ROM", "date": "2026-10-02"}).json()
        assert r["flights"] and r["bags"] == "" and [f["price"] for f in r["flights"]] == sorted(f["price"] for f in r["flights"])
        fees = c.get(f"/api/searches/{sid}/bagfees", params={"origin": "TLV", "dest": "ROM", "date": "2026-10-02"}).json()
        assert set(fees) == {"available", "fees", "currency", "notes"} and fees["fees"]
        for label, f in fees["fees"].items():        # the mock charges bag fees only on FR / W6 / U2
            code = label.split("+")[0][:2]
            assert (f["cabin"] or 0) == (25 if code in ("FR", "W6", "U2") else 0), (label, f)
        assert fees["available"] == any(k.split("+")[0][:2] in ("FR", "W6", "U2") for k in fees["fees"])
        assert c.get("/api/searches/nope/flights", params={"origin": "TLV", "dest": "ROM", "date": "2026-10-02"}).status_code == 404


def test_search_flight_lists_and_unpriced_obey_the_airline_filter(monkeypatch, tmp_path):
    import time
    from fastapi.testclient import TestClient
    from flightagent.api import app

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    base = {"destinations": ["ROM"], "window_start": "2026-10-01", "window_end": "2026-10-08", "min_nights": 3, "max_nights": 3}

    def finish(c, body):
        sid = c.post("/api/searches", json=body).json()["id"]
        for _ in range(80):
            if c.get(f"/api/searches/{sid}").json()["status"] == "done":
                return sid
            time.sleep(0.1)

    q = {"origin": "TLV", "dest": "ROM", "date": "2026-10-02"}
    with TestClient(app) as c:
        sid0 = finish(c, base)
        everything = c.get(f"/api/searches/{sid0}/flights", params=q).json()
        codes = sorted({s["airline_code"] for f in everything["flights"] for s in f["segments"]})
        assert len(codes) >= 2 and everything["hidden_by_filter"] == 0
        keep = next(next(iter({s["airline_code"] for s in f["segments"]})) for f in everything["flights"] if len({s["airline_code"] for s in f["segments"]}) == 1)
        sid1 = finish(c, {**base, "airlines_include": [keep]})
        filtered = c.get(f"/api/searches/{sid1}/flights", params=q).json()
        assert filtered["flights"] and all({s["airline_code"] for s in f["segments"]} == {keep} for f in filtered["flights"])
        assert filtered["hidden_by_filter"] == len(everything["flights"]) - len(filtered["flights"]) > 0
        assert filtered["filter"] == {"include": [keep], "exclude": []}
        again = c.get(f"/api/searches/{sid1}/flights", params={**q, "all": 1}).json()
        assert len(again["flights"]) == len(everything["flights"]) and again["hidden_by_filter"] == 0


def test_filter_endpoint_is_instant_and_works_from_expired_data(monkeypatch, tmp_path):
    import time
    from fastapi.testclient import TestClient
    import flightagent.api as api

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    body = {"destinations": ["ROM"], "window_start": "2026-10-01", "window_end": "2026-10-08", "min_nights": 3, "max_nights": 3}
    with TestClient(api.app) as c:
        sid = c.post("/api/searches", json=body).json()["id"]
        for _ in range(80):
            row = c.get(f"/api/searches/{sid}").json()
            if row["status"] == "done":
                break
            time.sleep(0.1)
        codes = [a["code"] for a in row["result"]["airlines"]]
        assert len(codes) >= 2
        # let every saved flight expire: filtering must still work, with zero lookups, and say how old the data is
        import sqlite3
        with sqlite3.connect(str(tmp_path / "c.sqlite")) as db:
            db.execute("UPDATE offers SET expires = 1")
        r = c.post(f"/api/searches/{sid}/filter", json={"airlines_exclude": [codes[0]]}).json()
        assert r["request"]["airlines_exclude"] == [codes[0]] and r["request"]["stale_ok"] is False
        assert r["result"]["api_calls"] == 0 and r["result"]["cache_hits"] > 0 and r["result"]["data_from"]
        assert all(codes[0] not in t["airlines"] for d in r["result"]["daily"] for t in (d["cheapest"], d["best_value"]))
        assert next(a for a in r["result"]["airlines"] if a["code"] == codes[0])["included"] is False
        assert len(c.get("/api/searches").json()) == 1                      # same history entry, not a new one
        back = c.post(f"/api/searches/{sid}/filter", json={}).json()
        assert back["request"]["airlines_exclude"] == [] and all(a["included"] for a in back["result"]["airlines"])
        assert c.post("/api/searches/nope/filter", json={}).status_code == 404
