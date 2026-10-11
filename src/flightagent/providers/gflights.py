from __future__ import annotations

import asyncio
import json
import random
from datetime import date, datetime
from urllib.parse import urlencode

from ..links import google_flights_link
from ..models import Offer, Segment


def _time(value: list[int | None] | None) -> tuple[int, int]:
    """Google omits zero components: [8] is 08:00, [None, 31] is 00:31."""
    padded = [*(value or []), None, None]
    return padded[0] or 0, padded[1] or 0


URL = "https://www.google.com/travel/flights"   # what fast-flights fetches


def _at(value, *path):
    """value[i][j]..., or None where Google left a part out."""
    for i in path:
        if not isinstance(value, list) or len(value) <= i:
            return None
        value = value[i]
    return value


def parse_groups(groups: list[list], origin: str, dest: str, currency: str, link: str | None = None) -> list[Offer]:
    """`link` is the Google Flights page the fares came from, so "Google Flights" opens the very same search."""
    offers = []
    for entry in groups:
        flight = entry[0]
        try:
            price = entry[1][0][1]
        except (IndexError, TypeError):
            price = None
        priced = bool(price)   # Google lists some flights without a fare (airline sells only on its own site)
        segs = []
        for s in flight[2]:
            dep_h, dep_m = _time(s[8])
            arr_h, arr_m = _time(s[10])
            code, number, _, airline = s[22][:4]
            segs.append(Segment(
                airline_code=code, airline=airline, flight_number=str(number),
                origin=s[3], destination=s[6],
                departs=datetime(*s[20], dep_h, dep_m), arrives=datetime(*s[21], arr_h, arr_m),
                duration_min=s[11], aircraft=s[17] or "", legroom=s[14] or "",
            ))
        co2, typical = _at(flight, 22, 7), _at(flight, 22, 8)
        offers.append(Offer(
            origin=segs[0].origin, destination=segs[-1].destination, price=float(price or 0),
            currency=currency, segments=segs, provider="gflights", priced=priced,
            deep_links=[link or google_flights_link(origin, dest, segs[0].departs.date())],
            co2_g=co2, co2_typical_g=typical if co2 is not None else None,
        ))
    return offers


def parse_html(html: str, origin: str, dest: str, currency: str, link: str | None = None) -> list[Offer]:
    from selectolax.lexbor import LexborHTMLParser

    tree = LexborHTMLParser(html)
    script = tree.css_first(r"script.ds\:1")
    if script is None:
        from .laya_classify import diagnose

        text = tree.body.text(separator=" ", strip=True) if tree.body else ""
        raise RuntimeError(f"Google returned no result data ({diagnose(text)})")
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
    return parse_groups(groups, origin, dest, currency, link)


def _passengers(adults: int, children: int, infants: int):
    """Passenger list for the query. fast-flights names wire value 3 INFANT_IN_SEAT and 4 INFANT_ON_LAP, but
    measured against Google, value 3 is priced as a lap infant (fare = adult-only fare) and value 4 as an infant
    with its own seat (roughly a second full fare), so the library's names are swapped. We send raw values."""
    from types import SimpleNamespace

    from fast_flights.pb import flights_pb2 as pb
    return SimpleNamespace(pb=lambda: [*[pb.Passenger.Value("ADULT")] * adults, *[pb.Passenger.Value("CHILD")] * children,
                                       *[3] * infants])


def _merge(old: list[Offer], new: list[Offer]) -> list[Offer]:
    """Combine two fetches of the same route/day: a priced version of a flight replaces an unpriced one."""
    key = lambda o: ("+".join(f"{s.airline_code}{s.flight_number}" for s in o.segments), o.departs)  # noqa: E731
    merged = {key(o): o for o in old}
    for o in new:
        k = key(o)
        if k not in merged or (o.priced and not merged[k].priced):
            merged[k] = o
    return list(merged.values())


class GoogleFlightsScraper:
    """Free provider: scrapes Google Flights pages (no API key). Uses fast-flights only for its
    browser-impersonating HTTP client and query encoding. Keep the request rate low.
    Note: scraping may violate Google's terms and can be blocked or break without notice."""

    name = "gflights"

    def __init__(self, concurrency: int = 3, delay: tuple[float, float] = (0.2, 0.7), retry_unpriced: int = 2):
        self.sem = asyncio.Semaphore(concurrency)
        self.delay = delay
        self.retry_unpriced = retry_unpriced

    async def one_way(
        self, origin: str, dest: str, day: date, *, currency: str, adults: int, max_stops: int,
        children: int = 0, infants: int = 0, carry_on_bags: int = 0, checked_bags: int = 0,
    ) -> list[Offer]:
        bags = (carry_on_bags, checked_bags)
        offers = await self._once(origin, dest, day, currency, adults, max_stops, children, infants, *bags)
        # Google sometimes omits a fare it shows on the next request (seen with HiSky): ask again for unpriced flights.
        for _ in range(self.retry_unpriced):
            if all(o.priced for o in offers):
                break
            await asyncio.sleep(1.0)
            offers = _merge(offers, await self._once(origin, dest, day, currency, adults, max_stops, children, infants, *bags))
        return offers

    async def _once(self, origin, dest, day, currency, adults, max_stops, children, infants, carry_on_bags=0, checked_bags=0) -> list[Offer]:
        query = self._query(origin, dest, day, currency, adults, max_stops, children, infants, carry_on_bags, checked_bags)
        async with self.sem:
            await asyncio.sleep(random.uniform(*self.delay))
            html = await asyncio.to_thread(self._fetch, query, f"{origin}->{dest} {day}")
        return parse_html(html, origin, dest, currency, link=f"{URL}?{urlencode(query.params())}")

    @staticmethod
    def _query(origin: str, dest: str, day: date, currency: str, adults: int, max_stops: int,
               children: int = 0, infants: int = 0, carry_on_bags: int = 0, checked_bags: int = 0):
        import fast_flights as ff

        return ff.create_query(
            flights=[ff.FlightQuery(date=day.isoformat(), from_airport=origin, to_airport=dest)],
            trip="one-way", currency=currency, language="en-US",
            passengers=_passengers(adults, children, infants), max_stops=max_stops if max_stops < 3 else None,
            carry_on_bags=carry_on_bags, checked_bags=checked_bags,
        )

    @staticmethod
    def _fetch(query, what: str) -> str:
        import fast_flights as ff

        last: Exception | None = None
        for attempt in range(3):
            try:
                return ff.fetch_flights_html(query)
            except Exception as e:
                last = e
                import time
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"Google Flights fetch failed for {what}: {last}")
