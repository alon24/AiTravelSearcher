from __future__ import annotations

import hashlib
import random
from datetime import date, datetime, time, timedelta

from ..links import google_flights_link
from ..models import Offer, Segment

AIRLINES = {
    "LY": "El Al", "W6": "Wizz Air", "FR": "Ryanair", "U2": "easyJet",
    "TK": "Turkish Airlines", "A3": "Aegean", "OS": "Austrian", "LH": "Lufthansa",
    "PC": "Pegasus", "LO": "LOT",
}
HUBS = ["IST", "ATH", "VIE", "FRA", "WAW", "BUD", "LCA", "SAW"]


def _rng(*parts: object) -> random.Random:
    digest = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


class MockProvider:
    """Deterministic fake fares for offline development and tests. Times are naive local
    times; timezones are ignored."""

    name = "mock"

    async def one_way(
        self, origin: str, dest: str, day: date, *, currency: str, adults: int, max_stops: int
    ) -> list[Offer]:
        route = _rng("route", *sorted([origin, dest]))
        base = route.uniform(50, 220)
        weekday_factor = {4: 1.25, 6: 1.2, 5: 1.1}.get(day.weekday(), 0.95)
        offers: list[Offer] = []

        def make(codes_hubs: list[str], price: float, dep: datetime, r: random.Random) -> Offer:
            points = [origin, *codes_hubs, dest]
            segs, t = [], dep
            for i, (a, b) in enumerate(zip(points, points[1:])):
                code = r.choice(list(AIRLINES))
                fly = timedelta(minutes=r.randint(90, 260))
                segs.append(Segment(
                    airline_code=code, airline=AIRLINES[code],
                    flight_number=str(r.randint(100, 9999)),
                    origin=a, destination=b, departs=t, arrives=t + fly,
                ))
                t = t + fly + timedelta(minutes=r.choice([45, 75, 120, 240, 600, 1080]))
            return Offer(
                origin=origin, destination=dest, price=round(price * adults, 2),
                currency=currency, segments=segs, provider=self.name,
                deep_links=[google_flights_link(origin, dest, day)],
            )

        # Direct flights exist on ~70% of routes.
        if route.random() < 0.7:
            for k in range(2):
                r = _rng("direct", origin, dest, day, k)
                dep = datetime.combine(day, time(r.randint(5, 22), r.choice([0, 15, 30, 45])))
                offers.append(make([], base * weekday_factor * r.uniform(0.9, 1.35), dep, r))

        if max_stops >= 1:
            for k in range(3):
                r = _rng("stop1", origin, dest, day, k)
                hub = r.choice([h for h in HUBS if h not in (origin, dest)])
                dep = datetime.combine(day, time(r.randint(5, 20), r.choice([0, 30])))
                offers.append(make([hub], base * weekday_factor * r.uniform(0.6, 0.95), dep, r))
        if max_stops >= 2:
            r = _rng("stop2", origin, dest, day)
            hubs = r.sample([h for h in HUBS if h not in (origin, dest)], 2)
            dep = datetime.combine(day, time(r.randint(5, 18), 0))
            offers.append(make(hubs, base * weekday_factor * 0.55, dep, r))
        return offers
