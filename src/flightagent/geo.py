"""Airport geography: time zones, metro areas (cities with several airports) and estimated ground-transfer times.

The transfer times are typical estimates (taxi/train/bus in normal traffic) supplied by us, NOT measured data:
they are meant to warn about tight connections, and are labelled as estimates wherever they are shown."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

METROS: dict[str, set[str]] = {
    "ROM": {"FCO", "CIA"}, "LON": {"LHR", "LGW", "STN", "LTN", "LCY", "SEN"}, "PAR": {"CDG", "ORY", "BVA"},
    "NYC": {"JFK", "EWR", "LGA"}, "MIL": {"MXP", "LIN", "BGY"}, "IST": {"IST", "SAW"}, "STO": {"ARN", "BMA", "NYO"},
    "MOW": {"SVO", "DME", "VKO"}, "TYO": {"HND", "NRT"}, "WAS": {"IAD", "DCA", "BWI"}, "CHI": {"ORD", "MDW"},
    "BUH": {"OTP", "BBU"}, "BJS": {"PEK", "PKX"}, "OSA": {"KIX", "ITM"}, "SAO": {"GRU", "CGH", "VCP"},
    "BUE": {"EZE", "AEP"}, "VCE": {"VCE", "TSF"},
}
_METRO_OF = {a: m for m, airports in METROS.items() for a in airports}

# (airport, airport, minutes, how). Typical door-to-door ground time between the two airports.
_PAIRS = [
    ("FCO", "CIA", 60, "taxi, or train via Roma Termini"),
    ("LHR", "LGW", 90, "coach or taxi"), ("LHR", "STN", 100, "coach, or train via central London"),
    ("LHR", "LTN", 90, "coach or taxi"), ("LHR", "LCY", 60, "train or taxi"), ("LGW", "STN", 120, "train via central London"),
    ("LGW", "LTN", 120, "train via central London"), ("STN", "LTN", 90, "taxi or coach"), ("LGW", "LCY", 80, "train or taxi"),
    ("STN", "LCY", 70, "train or taxi"), ("LTN", "LCY", 80, "train or taxi"),
    ("CDG", "ORY", 75, "taxi, or RER + Orlyval"), ("CDG", "BVA", 120, "coach via Paris or taxi"), ("ORY", "BVA", 120, "coach via Paris"),
    ("JFK", "LGA", 50, "taxi"), ("JFK", "EWR", 80, "taxi or train"), ("LGA", "EWR", 70, "taxi"),
    ("MXP", "LIN", 70, "Malpensa Express + metro"), ("MXP", "BGY", 100, "coach or taxi"), ("LIN", "BGY", 60, "bus or taxi"),
    ("IST", "SAW", 100, "taxi or shuttle, traffic varies a lot"),
    ("ARN", "BMA", 50, "taxi or bus"), ("ARN", "NYO", 100, "coach or taxi"), ("BMA", "NYO", 110, "coach or taxi"),
    ("SVO", "DME", 120, "taxi or train, traffic varies a lot"), ("SVO", "VKO", 90, "taxi"), ("DME", "VKO", 90, "taxi"),
    ("HND", "NRT", 100, "limousine bus or train"),
    ("IAD", "DCA", 60, "taxi or metro"), ("IAD", "BWI", 80, "taxi or train"), ("DCA", "BWI", 60, "train or taxi"),
    ("ORD", "MDW", 70, "taxi or train"), ("OTP", "BBU", 50, "taxi"), ("PEK", "PKX", 100, "taxi or train"),
    ("KIX", "ITM", 65, "limousine bus or train"), ("GRU", "CGH", 80, "taxi, traffic varies a lot"),
    ("GRU", "VCP", 130, "coach or taxi"), ("CGH", "VCP", 140, "coach or taxi"), ("EZE", "AEP", 60, "taxi or bus"),
    ("VCE", "TSF", 70, "bus or taxi"),
]
_TRANSFER = {frozenset((a, b)): (m, how) for a, b, m, how in _PAIRS}
DEFAULT_METRO_TRANSFER = (90, "typical estimate")


def metro_of(code: str) -> str | None:
    return _METRO_OF.get(code.upper())


def transfer_between(a: str, b: str) -> tuple[int, str] | None:
    """Estimated ground minutes between two DIFFERENT airports of the same city, else None."""
    a, b = a.upper(), b.upper()
    if a == b or not metro_of(a) or metro_of(a) != metro_of(b):
        return None
    return _TRANSFER.get(frozenset((a, b)), DEFAULT_METRO_TRANSFER)


@lru_cache
def _tz_names() -> dict[str, str]:
    return json.loads((Path(__file__).parent / "data" / "airport_tz.json").read_text(encoding="utf-8"))


@lru_cache
def tz_of(code: str) -> ZoneInfo | None:
    name = _tz_names().get(code.upper())
    try:
        return ZoneInfo(name) if name else None
    except ZoneInfoNotFoundError:
        return None


@lru_cache
def airports_by_country() -> dict[str, list[tuple[str, str, int]]]:
    """country -> [(iata, airport name, rank)]. Rank 1 = well-known airport. Only airports with scheduled flights
    (OurAirports, tools/build_airports.py) when the country has any: air bases and closed fields would be wasted
    lookups. City groups are excluded."""
    rows = json.loads((Path(__file__).parent / "web" / "airports.json").read_text(encoding="utf-8"))
    out: dict[str, list[tuple[str, str, int, int]]] = {}
    for iata, _city, name, country, rank, _aliases, service in rows:
        if rank != 2:
            out.setdefault(country, []).append((iata, name, rank, service))
    return {c: [a[:3] for a in airports if a[3] or not any(x[3] for x in airports)] for c, airports in out.items()}


def country_airports(country: str, limit: int = 60) -> tuple[list[str], bool]:
    """IATA codes of a country's airports. Over `limit`, only the well-known ones (flag = True when trimmed)."""
    for name, airports in airports_by_country().items():
        if name.lower() == country.strip().lower():
            codes = [a[0] for a in airports]
            if len(codes) <= limit:
                return codes, False
            return [a[0] for a in airports if a[2] == 1][:limit], True
    return [], False
