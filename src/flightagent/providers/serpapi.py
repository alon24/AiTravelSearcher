from __future__ import annotations

import asyncio
from datetime import date, datetime

import httpx

from ..links import google_flights_link
from ..models import Offer, Segment
from .airports import expand

URL = "https://serpapi.com/search.json"
# SerpApi `stops` param: 0 any, 1 nonstop only, 2 up to 1 stop, 3 up to 2 stops
_STOPS = {0: 1, 1: 2, 2: 3, 3: 0}


class SerpApiProvider:
    """Google Flights through SerpApi (engine=google_flights). One credit per search."""

    name = "serpapi"

    def __init__(self, api_key: str, timeout: float = 45.0):
        self.api_key = api_key
        self.client = httpx.AsyncClient(timeout=timeout)

    async def one_way(
        self, origin: str, dest: str, day: date, *, currency: str, adults: int, max_stops: int,
        children: int = 0, infants: int = 0,
    ) -> list[Offer]:
        params = {
            "engine": "google_flights", "type": 2, "hl": "en",
            "departure_id": expand(origin), "arrival_id": expand(dest),
            "outbound_date": day.isoformat(), "currency": currency,
            "adults": adults, "stops": _STOPS[max_stops], "api_key": self.api_key,
        }
        if children:
            params["children"] = children
        if infants:
            params["infants_on_lap"] = infants
        data = await self._get(params)
        if "error" in data:
            # "Google Flights hasn't returned any results" is a normal empty answer.
            if "hasn't returned any results" in data["error"]:
                return []
            raise RuntimeError(f"SerpApi error for {origin}->{dest} {day}: {data['error']}")
        return self.parse(data, origin, dest, day, currency)

    async def _get(self, params: dict) -> dict:
        for attempt in range(4):
            resp = await self.client.get(URL, params=params)
            if resp.status_code in (429, 500, 502, 503) and attempt < 3:
                await asyncio.sleep(2**attempt)
                continue
            if resp.status_code == 400 and "error" in resp.json():
                return resp.json()
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError("unreachable")

    def parse(self, data: dict, origin: str, dest: str, day: date, currency: str) -> list[Offer]:
        link = data.get("search_metadata", {}).get("google_flights_url") or google_flights_link(
            origin, dest, day
        )
        offers = []
        for item in data.get("best_flights", []) + data.get("other_flights", []):
            if "price" not in item or not item.get("flights"):
                continue
            segs = []
            for f in item["flights"]:
                code, _, number = f.get("flight_number", "??  ").partition(" ")
                segs.append(Segment(
                    airline_code=code, airline=f.get("airline", ""), flight_number=number,
                    origin=f["departure_airport"]["id"], destination=f["arrival_airport"]["id"],
                    departs=datetime.strptime(f["departure_airport"]["time"], "%Y-%m-%d %H:%M"),
                    arrives=datetime.strptime(f["arrival_airport"]["time"], "%Y-%m-%d %H:%M"),
                    duration_min=f.get("duration"),
                ))
            offers.append(Offer(
                origin=segs[0].origin, destination=segs[-1].destination,
                price=float(item["price"]), currency=currency, segments=segs,
                deep_links=[link], provider=self.name,
            ))
        return offers
