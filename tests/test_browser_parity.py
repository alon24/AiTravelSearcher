"""The browser engine (web/local/*.js, used on GitHub Pages) must give the same answers as the Python engine. Each test
runs one job through both and compares the JSON. Skipped when Node is not installed."""
import asyncio
import json
import shutil
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from flightagent.airline_sites import _pick
from flightagent.engine import FlightSearchEngine
from flightagent.itinerary import analyse
from flightagent.models import LegView, SearchRequest, Segment
from flightagent.providers.mock import MockProvider
from flightagent.providers.serpapi import SerpApiProvider

RUNNER = Path(__file__).parent / "js" / "engine_runner.js"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")


def js(job: dict):
    out = subprocess.run(["node", str(RUNNER)], input=json.dumps(job), capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)


def py_search(body: dict) -> dict:
    result = asyncio.run(FlightSearchEngine(MockProvider()).search(SearchRequest(**body)))
    return json.loads(result.model_dump_json())


def comparable(result: dict) -> dict:
    """elapsed_s is timing; airlines tied on price and name come out in fetch order, which neither side fixes."""
    return {**result, "elapsed_s": None, "airlines": sorted(result["airlines"], key=lambda a: a["code"])}


BASE = {"origin": "TLV", "window_start": "2026-11-02", "window_end": "2026-11-12", "min_nights": 3, "max_nights": 5}
SEARCHES = {
    "round trip, two destinations": {**BASE, "destinations": ["FCO", "CDG"], "open_jaw": False},
    "open jaw with extra return airports": {**BASE, "destinations": ["FCO", "LHR"], "return_airports": ["CIA", "STN"]},
    "multi-stop": {**BASE, "destinations": ["ATH", "BUD"], "connect_destinations": True, "min_nights_per_stop": 2},
    "self-transfer via hubs": {**BASE, "destinations": ["LIS"], "allow_self_transfer": True, "self_transfer_hubs": ["IST", "VIE"],
                               "airlines_exclude": ["TK"]},
    "same airline both ways": {**BASE, "destinations": ["FCO", "BCN"], "allow_mixed_airlines": False, "max_stops_per_leg": 2},
    "airline filters and travel cap": {**BASE, "destinations": ["FCO", "ATH"],
                                       "airlines_include": ["w6", "fr", "tk", " LY ", "os", "a3", "lh"],
                                       "airlines_exclude": ["FR"], "max_travel_min_per_direction": 900},
    "family with bags": {**BASE, "destinations": ["LCA", "ATH"], "adults": 2, "children_ages": [1, 7, 13], "carry_on_bags": 1,
                         "checked_bags": 2, "currency": "EUR", "value_of_time_per_hour": 25, "top_n": 8},
    "across the October clock change": {**BASE, "destinations": ["LHR", "CDG"], "window_start": "2026-10-20",
                                        "window_end": "2026-10-30", "max_stops_per_leg": 2, "min_layover_min": 45},
    "no connections": {**BASE, "destinations": ["VIE", "WAW", "BUD"], "allow_connections": False},
}


@pytest.mark.parametrize("body", SEARCHES.values(), ids=SEARCHES.keys())
def test_search_matches_python_engine(body):
    py = py_search(body)
    assert py["top"], "the case should produce trips, or it compares nothing"
    assert comparable(js({"op": "search", "request": body})) == comparable(py)


def test_estimate_matches_python_engine():
    body = SEARCHES["self-transfer via hubs"]
    want = FlightSearchEngine(MockProvider()).estimate(SearchRequest(**body))
    assert js({"op": "estimate", "request": body}) == want


@pytest.mark.parametrize("args", [
    ["TLV", "FCO", "2026-11-06", {"currency": "EUR", "adults": 2, "maxStops": 2, "children": 1, "infants": 1, "carryOnBags": 1, "checkedBags": 1}],
    ["BUD", "TLV", "2026-11-09", {"currency": "USD", "adults": 1, "maxStops": 1}],
    ["IST", "SAW", "2027-01-31", {"currency": "ILS", "adults": 3, "maxStops": 0}],
])
def test_mock_fares_are_identical(args):
    o, d, day, kw = args
    py = asyncio.run(MockProvider().one_way(o, d, date.fromisoformat(day), currency=kw["currency"], adults=kw["adults"],
                                            max_stops=kw["maxStops"], children=kw.get("children", 0), infants=kw.get("infants", 0),
                                            carry_on_bags=kw.get("carryOnBags", 0), checked_bags=kw.get("checkedBags", 0)))
    assert js({"op": "one_way", "args": args}) == [json.loads(o.model_dump_json()) for o in py]


def leg(o, d, dep: datetime, minutes=180):
    s = Segment(airline_code="W4", flight_number="1", origin=o, destination=d, departs=dep, arrives=dep + timedelta(minutes=minutes))
    return LegView(origin=o, destination=d, airlines=["W4"], segments=[s], stops=0, layovers_min=[], duration_min=minutes,
                   price=99.95, self_transfer=False, deep_links=[])


@pytest.mark.parametrize("legs", [
    [leg("TLV", "LHR", datetime(2026, 10, 24, 9)), leg("CDG", "TLV", datetime(2026, 10, 25, 2, 30))],    # BST/CEST end that night
    [leg("TLV", "FCO", datetime(2026, 3, 28, 22)), leg("CIA", "TLV", datetime(2026, 3, 29, 3))],         # CET -> CEST
    [leg("TLV", "JFK", datetime(2026, 11, 1, 1)), leg("EWR", "LAX", datetime(2026, 11, 1, 9)), leg("LAX", "XYZ", datetime(2026, 11, 3, 8))],
    [leg("TLV", "FCO", datetime(2026, 10, 12, 10)), leg("FCO", "TLV", datetime(2026, 10, 12, 12, 30))],
    [leg("TLV", "LHR", datetime(2026, 10, 12, 10)), leg("STN", "TLV", datetime(2026, 10, 14, 20))],
], ids=["dst-end", "dst-start", "unknown-tz", "same-airport", "same-city"])
def test_connection_checks_match(legs):
    want = json.loads(analyse(legs, "EUR").model_dump_json())
    assert js({"op": "analyse", "legs": [json.loads(l.model_dump_json()) for l in legs], "currency": "EUR"}) == want


@pytest.mark.parametrize("body", [
    {**BASE, "destinations": ["fco"], "airlines_include": ["w6", "w6", ""], "self_transfer_hubs": ["ist"], "allow_connections": False},
    {**BASE, "destinations": []},
    {**BASE, "destinations": ["FCO"], "window_end": "2026-11-02"},
    {**BASE, "destinations": ["FCO"], "max_nights": 2},
    {**BASE, "destinations": ["FCO"], "adults": 0},
    {**BASE, "destinations": ["FCO"], "adults": 1, "children_ages": [0, 1]},
    {**BASE, "destinations": ["FCO"], "adults": 5, "children_ages": [3, 4, 5, 6, 7]},
    {**BASE, "destinations": ["FCO"], "children_ages": [18]},
    {**BASE, "destinations": ["FCO"], "checked_bags": 4},
])
def test_request_validation_matches(body):
    try:
        want = json.loads(SearchRequest(**body).model_dump_json())
    except ValidationError:
        want = None
    got = js({"op": "request", "request": body})
    assert (None if "error" in got else got) == want


def site(label, url, by_code):
    return {"aLabel": {"value": label}, "site": {"value": url}, "byCode": {"value": str(by_code)}}


@pytest.mark.parametrize("rows,name", [
    ([site("Animawings", "https://animawings.com/", 0), site("Aero Contractors", "https://flyaero.com/", 1)], "AnimaWings"),
    ([site("Wizz Air", "https://wizzair.com/", 0), site("Wizz Air Hungary", "https://wizzair.com/hu", 1)], "Wizz Air Hungary"),
    ([site("Air Malta", "https://airmalta.com/", 1), site("KM Malta Airlines", "https://kmmaltairlines.com/", 1)], "KM Malta Airlines"),
    ([site("Some Airline", "https://x.example/", 1)], ""),
    ([site("Lufthansa", "https://lufthansa.com/", 1), {"aLabel": {"value": "Lufthansa"}}], "Air Lufthansa"),
    ([site("Air France", "https://airfrance.com/", 1)], "Air India"),
])
def test_airline_site_choice_matches(rows, name):
    assert js({"op": "pick", "rows": rows, "name": name}) == _pick(rows, name)


def _flight(o, d, dep, arr, number="TK 787", **extra):
    return {"departure_airport": {"id": o, "time": dep}, "arrival_airport": {"id": d, "time": arr},
            "airline": "Turkish Airlines", "flight_number": number, **extra}


SERPAPI_ANSWERS = {
    "connection with durations": {
        "search_metadata": {"google_flights_url": "https://www.google.com/travel/flights?x=1"},
        "best_flights": [{"price": 123, "flights": [_flight("TLV", "IST", "2026-10-05 08:30", "2026-10-05 11:00", duration=190),
                                                    _flight("IST", "FCO", "2026-10-05 13:00", "2026-10-05 14:30", "TK 1861", duration=150)]}],
        "other_flights": [{"flights": []}, {"price": 99, "flights": []},
                          {"price": 87.5, "flights": [_flight("TLV", "CIA", "2026-10-05 23:10", "2026-10-06 02:05", "W62327")]}]},
    "no link, no flight number": {"best_flights": [{"price": 300, "flights": [
        {k: v for k, v in _flight("TLV", "FCO", "2026-10-05 06:00", "2026-10-05 09:00").items() if k != "flight_number"}]}]},
    "empty": {},
}


@pytest.mark.parametrize("data", SERPAPI_ANSWERS.values(), ids=SERPAPI_ANSWERS.keys())
def test_serpapi_answers_parse_the_same(data):
    """Real fares on Pages come from SerpApi through the Worker; the page must read them as the Python provider does."""
    py = SerpApiProvider("k").parse(data, "TLV", "ROM", date(2026, 10, 5), "EUR")
    assert js({"op": "serpapi_parse", "data": data, "args": ["TLV", "ROM", "2026-10-05", "EUR"]}) == [json.loads(o.model_dump_json()) for o in py]


def test_google_flights_results_parse_the_same():
    """Free fares on Pages come from Google Flights through the Worker; the page must read them as gflights.py does."""
    from flightagent.providers.gflights import parse_groups

    fx = json.loads((Path(__file__).parent / "fixtures" / "gflights_tlv_fco_2026-10-05.json").read_text())
    groups = fx["best"] + fx["other"]
    groups[1] = [groups[1][0], []]                                  # a flight Google lists without a fare
    link = "https://www.google.com/travel/flights?tfs=GhoSCjIwMjYtMTAtMDU%3D&hl=en-US&curr=EUR"
    py = [json.loads(o.model_dump_json()) for o in parse_groups(groups, "TLV", "FCO", "EUR", link, [60.0, 110.0])]
    assert js({"op": "gflights_parse", "groups": groups, "args": ["TLV", "FCO", "EUR", link, [60, 110]]}) == py
    assert {o["deep_links"][0] for o in py} == {link}
    assert [o["priced"] for o in py].count(False) == 1
