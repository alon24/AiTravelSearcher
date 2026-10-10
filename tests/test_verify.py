import asyncio
import json
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from flightagent.conformance import compare, run_contract, summarize
from flightagent.engine import FlightSearchEngine, leg_view
from flightagent.models import Offer, SearchRequest, Segment, Trip
from flightagent.providers.gflights import parse_groups
from flightagent.verify import tickets, tolerance, trip_key, verify_trips

DAY = date(2026, 10, 5)


def fixture_offers() -> list[Offer]:
    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    return parse_groups(fx["best"] + fx["other"], "TLV", "FCO", "USD")


def seg(o, d, dep, code="LY", num="1", mins=180):
    return Segment(airline_code=code, flight_number=num, origin=o, destination=d, departs=dep, arrives=dep + timedelta(minutes=mins))


def offer(o, d, dep, price, code="LY", num="1", provider="verifier"):
    return Offer(origin=o, destination=d, price=price, currency="USD", segments=[seg(o, d, dep, code, num)], provider=provider)


def trip(*legs: Offer) -> Trip:
    views = [leg_view(x) for x in legs]
    return Trip(kind="round_trip", destination="FCO", depart_date=legs[0].departs.date(), return_date=legs[-1].departs.date(),
                nights=3, legs=views, price=sum(v.price for v in views), currency="USD", total_travel_min=0, stops=0,
                airlines=[], self_transfer=False, effective_cost=0)


class Verifier:
    """A second provider driven by a function (o, d, day) -> list[Offer]."""
    name = "verifier"

    def __init__(self, fn):
        self.fn, self.calls = fn, []

    async def one_way(self, o, d, day, **kw):
        self.calls.append((o, d, day))
        return self.fn(o, d, day)


def req(**kw):
    return SearchRequest(**{**dict(destinations=["FCO"], window_start=DAY, window_end=DAY + timedelta(days=5), min_nights=3, max_nights=3), **kw})


def check(trips, fn):
    v = Verifier(fn)
    return asyncio.run(verify_trips(trips, req(), FlightSearchEngine(v))), v


BACK = offer("FCO", "TLV", datetime(2026, 10, 8, 12), 150, code="AZ", num="806", provider="gflights")


def back_ok(o, d, day):
    return [BACK.model_copy(update={"provider": "verifier"})] if (o, d) == ("FCO", "TLV") else None


def test_same_flights_same_prices_are_confirmed():
    out = fixture_offers()
    trips = [trip(o, BACK) for o in out]
    res, v = check(trips, lambda o, d, day: back_ok(o, d, day) or [x.model_copy(update={"provider": "verifier"}) for x in out])
    assert [r.status for r in res] == ["confirmed"] * len(out)
    assert all(lg.delta == 0 and lg.provider == "verifier" for r in res for lg in r.legs)
    assert sorted(set(v.calls)) == [("FCO", "TLV", date(2026, 10, 8)), ("TLV", "FCO", DAY)]   # shared lookups fetched once


def test_corrupted_fixture_price_is_reported_as_price_differs():
    out = fixture_offers()
    cheapest = min(out, key=lambda o: o.price)   # the $161 Tus Air fare
    corrupted = [x.model_copy(update={"price": round(x.price * 1.2, 2)}) if x is cheapest else x for x in out]
    res, _ = check([trip(cheapest, BACK)], lambda o, d, day: back_ok(o, d, day) or corrupted)
    r = res[0]
    assert r.status == "price_differs"
    assert (r.legs[0].status, r.legs[0].price, r.legs[0].seen_price, r.legs[0].delta) == ("price_differs", 161.0, 193.2, 32.2)
    assert r.legs[1].status == "confirmed"


def test_missing_flight_is_not_found_never_confirmed():
    out = fixture_offers()
    cheapest = min(out, key=lambda o: o.price)
    rest = [x for x in out if x is not cheapest]
    res, _ = check([trip(cheapest, BACK)], lambda o, d, day: back_ok(o, d, day) or rest)
    assert res[0].status == "not_found" and res[0].legs[0].seen_price is None
    assert "U8132" in res[0].legs[0].note


def test_match_is_by_flights_and_departure_not_price():
    out = offer("TLV", "FCO", datetime(2026, 10, 5, 8), 100, num="381")
    # same flight number one hour later is a different flight; a cheap unrelated flight is never a match
    other = [offer("TLV", "FCO", datetime(2026, 10, 5, 9), 100, num="381"), offer("TLV", "FCO", datetime(2026, 10, 5, 8), 100, num="382")]
    res, _ = check([trip(out, BACK)], lambda o, d, day: back_ok(o, d, day) or other)
    assert res[0].legs[0].status == "not_found"
    # formatting differences between providers (spaces, leading zeros) still match
    padded = [offer("TLV", "FCO", datetime(2026, 10, 5, 8), 100, num=" 0381")]
    res, _ = check([trip(out, BACK)], lambda o, d, day: back_ok(o, d, day) or padded)
    assert res[0].legs[0].status == "confirmed"


def test_unpriced_listing_is_not_found():
    out = offer("TLV", "FCO", datetime(2026, 10, 5, 8), 100)
    res, _ = check([trip(out, BACK)], lambda o, d, day: back_ok(o, d, day) or [out.model_copy(update={"priced": False, "price": 0})])
    assert res[0].legs[0].status == "not_found" and "without a price" in res[0].legs[0].note


def test_tolerance_is_three_percent_or_five():
    assert tolerance(100) == 5 and tolerance(1000) == 30
    out = offer("TLV", "FCO", datetime(2026, 10, 5, 8), 1000)
    for seen, status in ((1030, "confirmed"), (1031, "price_differs"), (970, "confirmed")):
        res, _ = check([trip(out, BACK)], lambda o, d, day: back_ok(o, d, day) or [out.model_copy(update={"price": seen})])
        assert res[0].legs[0].status == status


def test_verifier_failure_is_error_not_not_found_and_trip_takes_the_worst_leg():
    out = offer("TLV", "FCO", datetime(2026, 10, 5, 8), 100)

    def fn(o, d, day):
        if (o, d) == ("TLV", "FCO"):
            raise RuntimeError("blocked")
        return [BACK.model_copy(update={"price": 400})]
    res, _ = check([trip(out, BACK)], fn)
    assert [lg.status for lg in res[0].legs] == ["error", "price_differs"] and "blocked" in res[0].legs[0].note
    assert res[0].status == "price_differs"

    def all_fail(o, d, day):
        raise RuntimeError("down")
    res, _ = check([trip(out, BACK)], all_fail)
    assert res[0].status == "error" and all(lg.status == "error" for lg in res[0].legs)


def test_self_transfer_checks_each_ticket_on_its_own_route_and_day():
    a = offer("TLV", "ATH", datetime(2026, 10, 5, 22), 60, code="W6", num="2311")
    b = offer("ATH", "FCO", datetime(2026, 10, 6, 7), 45, code="FR", num="6511")
    bundle = Offer(origin="TLV", destination="FCO", price=105, currency="USD", segments=a.segments + b.segments,
                   self_transfer=True, hub="ATH")
    leg = leg_view(bundle)
    assert leg.hub == "ATH" and [len(t) for t in tickets(leg)] == [1, 1]
    res, v = check([trip(bundle, BACK)], lambda o, d, day: back_ok(o, d, day) or {("TLV", "ATH"): [a], ("ATH", "FCO"): [b]}.get((o, d), []))
    assert res[0].legs[0].status == "confirmed" and res[0].legs[0].seen_price == 105
    assert ("ATH", "FCO", date(2026, 10, 6)) in v.calls     # the second ticket flies the next morning
    old = leg.model_copy(update={"hub": None})
    assert tickets(old) is None


def test_trip_key_is_stable_and_matches_the_ui_format():
    t = trip(offer("TLV", "FCO", datetime(2026, 10, 5, 8), 100, num="381"), BACK)
    assert trip_key(t) == "LY381@2026-10-05T08:00/AZ806@2026-10-08T12:00"
    assert trip_key(Trip.model_validate(json.loads(t.model_dump_json()))) == trip_key(t)


# ---------------------------------------------------------------- conformance


def test_conformance_reports_overlap_price_agreement_and_dropped_flights():
    out = fixture_offers()
    same = compare("TLV", "FCO", DAY, out, out)
    assert (same.reference, same.shared, same.price_agree, same.dropped) == (9, 9, 9, [])
    assert summarize("c", "r", [same]).passed

    cheapest = min(out, key=lambda o: o.price)
    worse = [x.model_copy(update={"price": x.price * 1.2}) for x in out if x is not cheapest]
    r = compare("TLV", "FCO", DAY, out, worse)
    assert (r.shared, r.price_agree) == (8, 0) and r.dropped == ["U8132 " + cheapest.departs.isoformat(timespec="minutes")]
    s = summarize("c", "r", [r])
    assert s.overlap == round(8 / 9, 3) and s.price_agreement == 0 and not s.passed


def test_conformance_runner_leaves_outages_out_of_the_rates():
    out = fixture_offers()

    def ref(o, d, day):
        if day.day == 6:
            raise RuntimeError("timeout")
        return out
    rep = asyncio.run(run_contract(Verifier(lambda *a: out), Verifier(ref), [("TLV", "FCO", DAY), ("TLV", "FCO", DAY + timedelta(days=1))]))
    assert rep.passed and rep.overlap == 1 and rep.samples[1].error == "timeout"


# ------------------------------------------------------------------------ API


@pytest.fixture
def client(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from flightagent import simple
    from flightagent.api import app
    from flightagent.providers import MockProvider

    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    monkeypatch.setenv("FLIGHTAGENT_RECHECK", "0")
    monkeypatch.delenv("FLIGHTAGENT_VERIFIER", raising=False)
    class Second(MockProvider):
        """An independent provider that happens to agree with mock on everything."""
        name, calls = "second", []

        async def one_way(self, o, d, day, **kw):
            self.calls.append((o, d, day))
            return await super().one_way(o, d, day, **kw)
    second = Second()
    second.calls = []
    real = simple._provider
    monkeypatch.setattr(simple, "_provider", lambda name: second if name == "second" else real(name))
    with TestClient(app) as c:
        c.second = second
        yield c


def _search(c) -> dict:
    import time
    body = {"destinations": ["ROM", "PAR"], "window_start": "2026-11-01", "window_end": "2026-11-08", "min_nights": 3, "max_nights": 4}
    sid = c.post("/api/searches", json=body).json()["id"]
    for _ in range(100):
        row = c.get(f"/api/searches/{sid}").json()
        if row["status"] != "running":
            return row
        time.sleep(0.05)
    raise AssertionError("search did not finish")


def test_without_a_verifier_nothing_changes_and_no_lookups_are_made(client):
    assert client.get("/api/config").json()["verifier"] is None
    row = _search(client)
    assert row["status"] == "done" and row["verifications"] == {}
    r = client.post(f"/api/searches/{row['id']}/verify")
    assert r.status_code == 409 and "FLIGHTAGENT_VERIFIER" in r.json()["detail"]
    assert client.second.calls == []


def test_verifier_must_differ_from_the_search_provider(client, monkeypatch):
    row = _search(client)
    monkeypatch.setenv("FLIGHTAGENT_VERIFIER", "mock")
    assert client.get("/api/config").json()["verifier"] is None
    r = client.post(f"/api/searches/{row['id']}/verify")
    assert r.status_code == 409 and "independent" in r.json()["detail"]


def test_top_five_trips_get_a_status_in_one_request_and_are_stored(client, monkeypatch):
    monkeypatch.setenv("FLIGHTAGENT_VERIFIER", "second")
    assert client.get("/api/config").json()["verifier"] == "second"
    row = _search(client)
    assert client.second.calls == []                 # searching never spends verifier lookups
    top = row["result"]["top"]
    assert len(top) >= 5
    r = client.post(f"/api/searches/{row['id']}/verify").json()
    keys = [trip_key(Trip.model_validate(t)) for t in top[:5]]
    assert sorted(r["checked"]) == sorted(keys)
    assert {v["status"] for v in r["checked"].values()} == {"confirmed"}     # same data on both sides
    assert 0 < r["lookups"] <= 2 * 5 * 2
    stored = client.get(f"/api/searches/{row['id']}").json()["verifications"]
    assert set(stored) == set(keys)

    # one trip by index, and any trip of the result by key (a day's pick that is not in the top list)
    calls = len(client.second.calls)
    one = client.post(f"/api/searches/{row['id']}/verify", params={"trip": 0}).json()
    assert list(one["checked"]) == [keys[0]] and len(client.second.calls) == calls     # served from the cache
    d = row["result"]["daily"][-1]["best_value"]
    by_key = client.post(f"/api/searches/{row['id']}/verify", params={"key": trip_key(Trip.model_validate(d))})
    assert by_key.status_code == 200 and list(by_key.json()["checked"]) == [trip_key(Trip.model_validate(d))]
    assert client.post(f"/api/searches/{row['id']}/verify", params={"trip": 99}).status_code == 404
    assert client.post(f"/api/searches/{row['id']}/verify", params={"key": "nope"}).status_code == 404
    assert client.post("/api/searches/missing/verify").status_code == 404
