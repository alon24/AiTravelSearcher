from __future__ import annotations

from datetime import date
from typing import Protocol

from ..models import Offer


class FlightProvider(Protocol):
    """Anything that can price a one-way trip. Everything else (round trips, open-jaw,
    mixed airlines, self-transfer) is composed from one-way offers by the engine."""

    name: str

    async def one_way(
        self, origin: str, dest: str, day: date, *, currency: str, adults: int, max_stops: int
    ) -> list[Offer]: ...


class FallbackProvider:
    """Use `primary`; if it raises (blocked, layout change, quota), answer from `backup`."""

    def __init__(self, primary: FlightProvider, backup: FlightProvider):
        self.primary, self.backup = primary, backup
        self.name = f"{primary.name}+{backup.name}"

    async def one_way(self, origin, dest, day, **kw):
        try:
            return await self.primary.one_way(origin, dest, day, **kw)
        except Exception:
            return await self.backup.one_way(origin, dest, day, **kw)
