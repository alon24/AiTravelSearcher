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
