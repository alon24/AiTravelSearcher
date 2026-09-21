"""Airline finder: which airlines fly between an origin and the airports of a country (or a list of airports)?
Asks the provider route by route: first one date for every airport, then more dates only for airports that
have flights, so a country costs about one lookup per airport plus a few."""
from __future__ import annotations

import time
from collections import defaultdict
from datetime import date, timedelta

from pydantic import BaseModel

from .engine import FlightSearchEngine
from .models import SearchRequest


class AirlineRoute(BaseModel):
    airport: str
    nonstop: bool
    dates: list[date]
    cheapest: float | None
    flights: list[str]                # sample flight numbers


class ExploreAirline(BaseModel):
    code: str
    name: str
    nonstop_airports: int
    routes: list[AirlineRoute]


class ExploreResult(BaseModel):
    origin: str
    direction: str
    airports_checked: list[str]
    airports_with_flights: list[str]
    dates: list[date]
    airlines: list[ExploreAirline]
    trimmed: bool = False
    currency: str
    api_calls: int
    cache_hits: int
    elapsed_s: float


async def explore(engine: FlightSearchEngine, req: SearchRequest, origin: str, airports: list[str], direction: str,
                  first_day: date, extra_days: list[int]) -> ExploreResult:
    started = time.perf_counter()
    key = lambda ap, d: (origin, ap, d) if direction == "to" else (ap, origin, d)  # noqa: E731
    engine.api_calls = engine.cache_hits = 0
    raw, _ = await engine._prefetch(req, {key(ap, first_day) for ap in airports})
    active = [ap for ap in airports if raw.get(key(ap, first_day))]
    days = [first_day] + [first_day + timedelta(days=n) for n in extra_days]
    if active and extra_days:
        more, _ = await engine._prefetch(req, {key(ap, d) for ap in active for d in days[1:]})
        raw.update(more)

    agg: dict[str, dict] = {}
    for (o, d, dy), offers in raw.items():
        ap = d if direction == "to" else o
        for off in offers:
            for code in {s.airline_code for s in off.segments}:
                a = agg.setdefault(code, {"name": "", "routes": defaultdict(lambda: {"nonstop": False, "dates": set(), "cheapest": None, "flights": set()})})
                a["name"] = a["name"] or next(s.airline for s in off.segments if s.airline_code == code) or code
                r = a["routes"][ap]
                r["nonstop"] = r["nonstop"] or off.stops == 0
                r["dates"].add(dy)
                if off.priced:
                    r["cheapest"] = off.price if r["cheapest"] is None else min(r["cheapest"], off.price)
                r["flights"].add("+".join(f"{s.airline_code}{s.flight_number}" for s in off.segments if s.airline_code == code))
    airlines = []
    for code, a in agg.items():
        routes = [AirlineRoute(airport=ap, nonstop=r["nonstop"], dates=sorted(r["dates"]), cheapest=r["cheapest"], flights=sorted(r["flights"])[:4])
                  for ap, r in sorted(a["routes"].items())]
        airlines.append(ExploreAirline(code=code, name=a["name"], nonstop_airports=sum(r.nonstop for r in routes), routes=routes))
    airlines.sort(key=lambda x: (-x.nonstop_airports, -len(x.routes), x.name))
    return ExploreResult(origin=origin, direction=direction, airports_checked=airports, airports_with_flights=active, dates=days, airlines=airlines,
                         currency=req.currency, api_calls=engine.api_calls, cache_hits=engine.cache_hits,
                         elapsed_s=round(time.perf_counter() - started, 1))
