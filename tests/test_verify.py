"""Price check by a second fare source (verify.py, web/local/verify.js): the same flights are found by airline, flight
number and departure minute, never by price, and Python and the browser judge them the same way."""
import asyncio
import json
import shutil
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from flightagent.models import LegView, Offer, Segment
from flightagent.providers.airports import CITY_AIRPORTS
from flightagent.verify import judge, lookup_key, lookups, second_source, worst

RUNNER = Path(__file__).parent / "js" / "engine_runner.js"
DAY = date(2026, 11, 2)


def seg(o, d, h, code="LY", num="381"):
    dep = datetime.combine(DAY, datetime.min.time()) + timedelta(hours=h)
    return Segment(airline_code=code, flight_number=num, origin=o, destination=d, departs=dep, arrives=dep + timedelta(hours=2))


def leg(segs, price, **kw):
    return LegView(origin=segs[0].origin, destination=segs[-1].destination, airlines=[s.airline_code for s in segs],
                   segments=segs, stops=len(segs) - 1, layovers_min=[], duration_min=120, price=price, deep_links=[],
                   **{"self_transfer": False, "provider": "gflights", **kw})


def offer(segs, price, priced=True):
    return Offer(origin=segs[0].origin, destination=segs[-1].destination, price=price, currency="USD", segments=segs,
                 provider="serpapi", priced=priced)


OUT = [seg("TLV", "FCO", 8)]
VIA = [seg("TLV", "IST", 6, "TK", "785"), seg("IST", "FCO", 11, "W6", "4001")]
CASES = {
    "same price": (leg(OUT, 161), [offer(OUT, 163)]),
    "a different price": (leg(OUT, 161), [offer(OUT, 175)]),
    "the closest of two fares for the same flight": (leg(OUT, 161), [offer(OUT, 240), offer(OUT, 160)]),
    "another flight at the same price is not a match": (leg(OUT, 161), [offer([seg("TLV", "FCO", 9)], 161)]),
    "listed without a price": (leg(OUT, 161), [offer(OUT, 0, priced=False)]),
    "flight number written with a leading zero": (leg(OUT, 161), [offer([seg("TLV", "FCO", 8, num="0381")], 161)]),
    "self-transfer via a city hub, both tickets found": (
        leg(VIA, 230, self_transfer=True, hub="IST"), [offer(VIA[:1], 120), offer(VIA[1:], 112)]),
}


def py_judge(lg, offers, errors=None):
    found = {}
    for o in offers:
        found.setdefault(lookup_key(o.segments), []).append(o)
    return judge(lg, found, errors or {}, "serpapi")


def test_statuses():
    got = {name: py_judge(lg, offers) for name, (lg, offers) in CASES.items()}
    assert got["same price"] == {"status": "confirmed", "price": 161, "seen_price": 163, "note": ""}
    assert got["a different price"]["status"] == "price_differs" and got["a different price"]["seen_price"] == 175
    assert got["the closest of two fares for the same flight"]["status"] == "confirmed"
    assert got["another flight at the same price is not a match"] == {"status": "not_found", "price": 161, "seen_price": None,
                                                                        "note": "serpapi doesn't list LY381"}
    assert got["listed without a price"]["note"] == "serpapi doesn't list LY381 (listed without a price)"
    assert got["flight number written with a leading zero"]["status"] == "confirmed"
    assert got["self-transfer via a city hub, both tickets found"] == {"status": "confirmed", "price": 230, "seen_price": 232, "note": ""}
    k = lookup_key(OUT)
    assert judge(leg(OUT, 161), {}, {k: "SerpApi: Invalid API key."}, "serpapi")["note"] == "serpapi: SerpApi: Invalid API key."
    assert worst([got["same price"], got["listed without a price"], got["same price"]]) == "not_found"
    assert lookups([leg(VIA, 230, self_transfer=True, hub="IST")]) == {("TLV", "IST", DAY), ("IST", "FCO", DAY)}


def test_the_other_source_checks_and_demo_fares_have_none():
    assert second_source(["gflights", "serpapi"], [leg(OUT, 1)]) == "serpapi"
    assert second_source(["gflights", "serpapi"], [leg(OUT, 1, provider="serpapi")]) == "gflights"
    assert second_source(["mock"], [leg(OUT, 1, provider="mock")]) is None
    assert second_source(["gflights"], [leg(OUT, 1)]) is None


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_the_browser_judges_like_python():
    for name, (lg, offers) in CASES.items():
        found = {}
        for o in offers:
            k = lookup_key(o.segments)
            found.setdefault(f"{k[0]}|{k[1]}|{k[2].isoformat()}", []).append(json.loads(o.model_dump_json()))
        job = {"op": "verify", "legs": [json.loads(lg.model_dump_json())], "found": found, "errors": {}, "source": "serpapi",
               "cities": CITY_AIRPORTS}
        out = subprocess.run(["node", str(RUNNER)], input=json.dumps(job), capture_output=True, text=True, timeout=60, check=True)
        assert json.loads(out.stdout) == [py_judge(lg, offers)], name


def test_api_checks_each_leg_on_the_other_source(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    import flightagent.api as api

    class Serp:
        name = "serpapi"

        async def one_way(self, o, d, day, **kw):
            if d == "TLV":
                raise RuntimeError("SerpApi: Invalid API key.")
            return [offer(OUT, 170)]

    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "c.sqlite"))
    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "gflights,serpapi")
    monkeypatch.setattr(api, "get_provider", lambda name: Serp())
    back = [seg("FCO", "TLV", 18)]
    body = {"request": {"destinations": ["FCO"], "window_start": "2026-11-02", "window_end": "2026-11-09", "min_nights": 3, "max_nights": 3},
            "legs": [json.loads(leg(OUT, 161).model_dump_json()), json.loads(leg(back, 99).model_dump_json())]}
    with TestClient(api.app) as c:
        r = c.post("/api/verify", json=body).json()
        assert r["source"] == "serpapi" and r["status"] == "price_differs"
        assert [v["status"] for v in r["legs"]] == ["price_differs", "error"]
        assert "Invalid API key" in r["legs"][1]["note"]
        monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
        no = c.post("/api/verify", json=body)
        assert no.status_code == 409 and "second fare source" in no.json()["detail"]
