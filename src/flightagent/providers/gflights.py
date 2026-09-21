from __future__ import annotations

import asyncio
import json
import random
from datetime import date, datetime

from ..links import google_flights_link
from ..models import Offer, Segment


def _time(value: list[int | None] | None) -> tuple[int, int]:
    """Google omits zero components: [8] is 08:00, [None, 31] is 00:31."""
    padded = [*(value or []), None, None]
    return padded[0] or 0, padded[1] or 0


def parse_groups(groups: list[list], origin: str, dest: str, currency: str) -> list[Offer]:
    offers = []
    for entry in groups:
        flight, price = entry[0], entry[1][0][1]
        segs = []
        for s in flight[2]:
            dep_h, dep_m = _time(s[8])
            arr_h, arr_m = _time(s[10])
            code, number, _, airline = s[22][:4]
            segs.append(Segment(
                airline_code=code, airline=airline, flight_number=str(number),
                origin=s[3], destination=s[6],
                departs=datetime(*s[20], dep_h, dep_m), arrives=datetime(*s[21], arr_h, arr_m),
                duration_min=s[11],
            ))
        offers.append(Offer(
            origin=segs[0].origin, destination=segs[-1].destination, price=float(price),
            currency=currency, segments=segs, provider="gflights",
            deep_links=[google_flights_link(origin, dest, segs[0].departs.date())],
        ))
    return offers


def parse_html(html: str, origin: str, dest: str, currency: str) -> list[Offer]:
    from selectolax.lexbor import LexborHTMLParser

    script = LexborHTMLParser(html).css_first(r"script.ds\:1")
    if script is None:
        raise RuntimeError("Google returned no result data (consent page, block or layout change)")
    raw = script.text().split("data:", 1)[1].rsplit(",", 1)[0]
    if raw.endswith("errorHasStatus: true"):
        return []
    payload = json.loads(raw)
    # payload[2] = Google's "best flights" (usually the cheapest!), payload[3] = "other flights".
    # The fast-flights library only reads [3], silently dropping the best fares.
    groups: list[list] = []
    for idx in (2, 3):
        if len(payload) > idx and payload[idx] and payload[idx][0]:
            groups += payload[idx][0]
    return parse_groups(groups, origin, dest, currency)


class GoogleFlightsScraper:
    """Free provider: scrapes Google Flights pages (no API key). Uses fast-flights only for its
    browser-impersonating HTTP client and query encoding. Keep the request rate low.
    Note: scraping may violate Google's terms and can be blocked or break without notice."""

    name = "gflights"

    def __init__(self, concurrency: int = 3, delay: tuple[float, float] = (0.2, 0.7)):
        self.sem = asyncio.Semaphore(concurrency)
        self.delay = delay

    async def one_way(
        self, origin: str, dest: str, day: date, *, currency: str, adults: int, max_stops: int
    ) -> list[Offer]:
        async with self.sem:
            await asyncio.sleep(random.uniform(*self.delay))
            html = await asyncio.to_thread(self._fetch, origin, dest, day, currency, adults, max_stops)
        return parse_html(html, origin, dest, currency)

    @staticmethod
    def _fetch(origin: str, dest: str, day: date, currency: str, adults: int, max_stops: int) -> str:
        import fast_flights as ff

        query = ff.create_query(
            flights=[ff.FlightQuery(date=day.isoformat(), from_airport=origin, to_airport=dest)],
            trip="one-way", currency=currency, language="en-US",
            passengers=ff.Passengers(adults=adults), max_stops=max_stops if max_stops < 3 else None,
        )
        last: Exception | None = None
        for attempt in range(3):
            try:
                return ff.fetch_flights_html(query)
            except Exception as e:
                last = e
                import time
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"Google Flights fetch failed for {origin}->{dest} {day}: {last}")
