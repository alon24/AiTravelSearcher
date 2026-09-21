from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class SearchRequest(BaseModel):
    origin: str = "TLV"
    # Candidate destinations, searched in parallel ("cheapest of ROM / PAR / LON").
    destinations: list[str] = Field(min_length=1)
    # Open-jaw: extra airports the traveller may fly home from (e.g. land PAR, return BRU).
    # Every destination is also a valid return airport.
    return_airports: list[str] = Field(default_factory=list)
    open_jaw: bool = True
    # Multi-stop: TLV -> D1 -> D2 -> TLV, with a leg connecting the destinations.
    connect_destinations: bool = False

    window_start: date
    window_end: date  # latest allowed return date
    min_nights: int = Field(ge=1)
    max_nights: int = Field(ge=1)

    allow_connections: bool = True
    max_stops_per_leg: int = Field(default=1, ge=0, le=3)
    min_layover_min: int = 90
    max_layover_min: int = 72 * 60
    max_travel_min_per_direction: int | None = None

    # Virtual interlining
    allow_mixed_airlines: bool = True  # outbound and return on different airlines
    allow_self_transfer: bool = False  # separate tickets, same direction
    self_transfer_hubs: list[str] = Field(default_factory=list)
    self_transfer_buffer_min: int = 240
    # Multi-stop: minimum nights in each city
    min_nights_per_stop: int = 1

    adults: int = 1
    currency: str = "USD"

    # Best-value scoring: effective_cost = price + value_of_time * hours + penalties
    value_of_time_per_hour: float = 10.0
    self_transfer_penalty: float = 40.0
    top_n: int = 5
    max_api_calls: int = 400

    @model_validator(mode="after")
    def _check(self) -> "SearchRequest":
        self.origin = self.origin.upper()
        self.destinations = [d.upper() for d in self.destinations]
        self.return_airports = [d.upper() for d in self.return_airports]
        self.self_transfer_hubs = [d.upper() for d in self.self_transfer_hubs]
        if self.window_end <= self.window_start:
            raise ValueError("window_end must be after window_start")
        if self.max_nights < self.min_nights:
            raise ValueError("max_nights must be >= min_nights")
        if not self.allow_connections:
            self.max_stops_per_leg = 0
        return self


class Segment(BaseModel):
    airline_code: str
    airline: str = ""
    flight_number: str
    origin: str
    destination: str
    departs: datetime
    arrives: datetime
    # Real flight time from the provider; local arrival - departure is wrong across time zones.
    duration_min: int | None = None

    @property
    def label(self) -> str:
        return f"{self.airline_code}{self.flight_number}".replace(" ", "")


class Offer(BaseModel):
    """A single purchasable one-way ticket (or a self-transfer bundle of them)."""

    origin: str
    destination: str
    price: float
    currency: str
    segments: list[Segment]
    deep_links: list[str] = Field(default_factory=list)
    provider: str = ""
    self_transfer: bool = False
    hub: str | None = None  # where the tickets of a self-transfer bundle meet

    @property
    def departs(self) -> datetime:
        return self.segments[0].departs

    @property
    def arrives(self) -> datetime:
        return self.segments[-1].arrives

    @property
    def stops(self) -> int:
        return len(self.segments) - 1

    @property
    def duration_min(self) -> int:
        """Door-to-door minutes: real flight times plus layovers (layovers are measured at one
        airport, so they are time-zone safe). Falls back to local-time difference if unknown."""
        flying = sum(
            s.duration_min if s.duration_min is not None
            else int((s.arrives - s.departs).total_seconds() // 60)
            for s in self.segments
        )
        return flying + sum(self.layovers_min)

    @property
    def layovers_min(self) -> list[int]:
        return [
            int((b.departs - a.arrives).total_seconds() // 60)
            for a, b in zip(self.segments, self.segments[1:])
        ]

    @property
    def airlines(self) -> list[str]:
        seen: list[str] = []
        for s in self.segments:
            if s.airline_code not in seen:
                seen.append(s.airline_code)
        return seen


class LegView(BaseModel):
    origin: str
    destination: str
    airlines: list[str]
    segments: list[Segment]
    stops: int
    layovers_min: list[int]
    duration_min: int
    price: float
    self_transfer: bool
    deep_links: list[str]


class Trip(BaseModel):
    kind: Literal["round_trip", "open_jaw", "multi_stop"]
    destination: str  # human label, e.g. "ROM" or "PAR→BRU" or "ROM+PAR"
    depart_date: date
    return_date: date
    nights: int
    legs: list[LegView]
    price: float
    currency: str
    total_travel_min: int
    stops: int
    airlines: list[str]
    self_transfer: bool
    warnings: list[str] = Field(default_factory=list)
    effective_cost: float  # lower is better

    @property
    def flight_type(self) -> str:
        return "direct" if self.stops == 0 else f"{self.stops} stop(s)"


class DailyBest(BaseModel):
    depart_date: date
    cheapest: Trip
    best_value: Trip


class SearchResult(BaseModel):
    request: SearchRequest
    daily: list[DailyBest]
    top: list[Trip]
    api_calls: int
    cache_hits: int
    warnings: list[str] = Field(default_factory=list)


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)
