from __future__ import annotations

import asyncio
import base64
import json
import random
from datetime import date, datetime
from urllib.parse import urlencode

from ..links import google_flights_link
from ..models import Offer, Segment
from .airports import is_city_only


def _time(value: list[int | None] | None) -> tuple[int, int]:
    """Google omits zero components: [8] is 08:00, [None, 31] is 00:31."""
    padded = [*(value or []), None, None]
    return padded[0] or 0, padded[1] or 0


URL = "https://www.google.com/travel/flights"
LANDING_TITLE = "Find Cheap Flights"   # Google's start page, seen 2026-10-11 for a query it could not read


def _at(value, *path):
    """value[i][j]..., or None where Google left a part out."""
    for i in path:
        if not isinstance(value, list) or len(value) <= i:
            return None
        value = value[i]
    return value


def parse_groups(groups: list[list], origin: str, dest: str, currency: str, link: str | None = None,
                 usual: list[float] | None = None) -> list[Offer]:
    """`link` is the Google Flights page the fares came from, so "Google Flights" opens the very same search;
    `usual` is that page's "usually costs between" range."""
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
            co2_g=co2, co2_typical_g=typical if co2 is not None else None, usual_price=usual,
        ))
    return offers


def usual_range(payload: list) -> list[float] | None:
    """Google's price insight, payload[5] (read 2026-10-11): [level, [_, current], _, _, [_, low], [_, high], ...];
    low-high is the range Google says the search usually costs."""
    low, high = _at(payload, 5, 4, 1), _at(payload, 5, 5, 1)
    return [float(low), float(high)] if isinstance(low, (int, float)) and isinstance(high, (int, float)) else None


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
    title = tree.css_first("title")
    if not groups and title is not None and title.text().startswith(LANDING_TITLE):
        raise RuntimeError("Google returned its landing page instead of results (it did not understand the query)")
    return parse_groups(groups, origin, dest, currency, link, usual_range(payload))


# ------------------------------------------------------------------------------- the `tfs` query (a protobuf)
# Passenger wire values: 3 is what Google prices as a lap infant (fare = adult-only fare), although fast-flights'
# schema names it INFANT_IN_SEAT; 4 is priced as an infant with its own seat (roughly a second full fare).
ADULT, CHILD, LAP_INFANT = 1, 2, 3
ECONOMY, ROUND_TRIP, ONE_WAY, AIRPORT = 1, 1, 2, 1


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | 0x80 if n else b)
        if not n:
            return bytes(out)


def _int(field: int, v: int) -> bytes:
    return _varint(field << 3) + _varint(v)


def _bytes(field: int, b: bytes) -> bytes:
    return _varint(field << 3 | 2) + _varint(len(b)) + b


def tfs(origin: str, dest: str, day: str, adults: int = 1, children: int = 0, infants: int = 0, max_stops: int = 1,
        carry_on: int = 0, checked: int = 0, return_day: str | None = None) -> str:
    """The `tfs` query for one one-way search, or a round trip with `return_day`; worker/src/gflights.js builds the
    same bytes. An airport carries its type (1): measured 2026-10-11, Google answers a bare airport code, as
    fast-flights sends it, with its landing page. City codes (ROM) stay bare as before: how Google wants them typed is
    not measured yet. A round trip is both legs and trip type 1, the shape of Google's own links (decoded 2026-10-11)."""
    place = lambda code: (b"" if is_city_only(code) else _int(1, AIRPORT)) + _bytes(2, code.encode())  # noqa: E731
    leg = lambda a, b, d: _bytes(3, _bytes(2, d.encode()) + (_int(5, max_stops) if max_stops < 3 else b"")  # noqa: E731
                                 + _bytes(13, place(a)) + _bytes(14, place(b)))
    pax = b"".join(_varint(p) for p in [ADULT] * adults + [CHILD] * children + [LAP_INFANT] * infants)
    bags = _bytes(13, _int(2, carry_on) + _int(3, checked)) if carry_on or checked else b""
    legs = leg(origin, dest, day) + (leg(dest, origin, return_day) if return_day else b"")
    info = legs + _bytes(8, pax) + _int(9, ECONOMY) + bags + _int(19, ROUND_TRIP if return_day else ONE_WAY)
    return base64.b64encode(info).decode()


def search_url(origin: str, dest: str, day: date, currency: str, adults: int, max_stops: int, children: int = 0,
               infants: int = 0, carry_on_bags: int = 0, checked_bags: int = 0, return_day: date | None = None) -> str:
    q = tfs(origin, dest, day.isoformat(), adults, children, infants, max_stops, carry_on_bags, checked_bags,
            return_day.isoformat() if return_day else None)
    return f"{URL}?{urlencode({'tfs': q, 'hl': 'en-US', 'curr': currency})}"


def round_trip_answer(prices: list[float], flights: int, url: str) -> dict:
    """What /api/roundtrip answers: the lowest round-trip price Google showed, with the page it came from."""
    return {"price": min(prices) if prices else None, "flights": flights, "url": url}


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
    """Free provider: scrapes Google Flights pages (no API key) with primp, a browser-impersonating HTTP client.
    Keep the request rate low.
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
        url = search_url(origin, dest, day, currency, adults, max_stops, children, infants, carry_on_bags, checked_bags)
        async with self.sem:
            await asyncio.sleep(random.uniform(*self.delay))
            html = await asyncio.to_thread(self._fetch, url, f"{origin}->{dest} {day}")
        return parse_html(html, origin, dest, currency, link=url)

    async def round_trip(
        self, origin: str, dest: str, day: date, return_day: date, *, currency: str, adults: int, max_stops: int,
        children: int = 0, infants: int = 0, carry_on_bags: int = 0, checked_bags: int = 0,
    ) -> dict:
        """Google's cheapest return ticket for these dates, any flights: on its round-trip page each outbound flight
        is priced as the whole return ticket. {price, url, flights}; price None when Google priced none."""
        url = search_url(origin, dest, day, currency, adults, max_stops, children, infants, carry_on_bags, checked_bags, return_day)
        async with self.sem:
            html = await asyncio.to_thread(self._fetch, url, f"{origin}<->{dest} {day}/{return_day}")
        offers = parse_html(html, origin, dest, currency, link=url)
        return round_trip_answer([o.price for o in offers if o.priced], len(offers), url)

    @staticmethod
    def _fetch(url: str, what: str) -> str:
        import time

        from primp import Client

        client = Client(impersonate="chrome_145", impersonate_os="macos", referer=True, cookie_store=True)
        last: Exception | None = None
        for attempt in range(3):
            try:
                return client.get(url).text
            except Exception as e:
                last = e
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"Google Flights fetch failed for {what}: {last}")
