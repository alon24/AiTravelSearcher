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

    # Airline filters (IATA codes). Applied after fetching, so changing them costs no new lookups.
    stale_ok: bool = False           # use saved flights even if expired (instant re-filtering; the result says how old they are)
    refresh_unpriced: bool = False   # ignore cached results that contain unpriced flights (recheck them now)
    airlines_include: list[str] = Field(default_factory=list)  # empty = any airline
    airlines_exclude: list[str] = Field(default_factory=list)
    # Bags whose estimated fees Google adds to the prices (only where Google has fee data: mostly US and Europe).
    carry_on_bags: int = Field(default=0, ge=0, le=3)
    checked_bags: int = Field(default=0, ge=0, le=3)
    adults: int = Field(default=1, ge=1, le=9)
    # Ages of children on the travel date. Google's categories: <2 infant on lap, 2-11 child, 12+ adult.
    children_ages: list[int] = Field(default_factory=list)
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
        self.airlines_include = sorted({a.strip().upper() for a in self.airlines_include if a.strip()})
        self.airlines_exclude = sorted({a.strip().upper() for a in self.airlines_exclude if a.strip()})
        if self.window_end <= self.window_start:
            raise ValueError("window_end must be after window_start")
        if self.max_nights < self.min_nights:
            raise ValueError("max_nights must be >= min_nights")
        if not self.allow_connections:
            self.max_stops_per_leg = 0
        if any(not 0 <= a <= 17 for a in self.children_ages):
            raise ValueError("children_ages must be between 0 and 17")
        if self.adults + len(self.children_ages) > 9:
            raise ValueError("At most 9 travellers per search")
        if self.pax_infants > self.pax_adults:
            raise ValueError("Each infant under 2 needs their own adult (one lap infant per adult)")
        return self

    @property
    def pax_infants(self) -> int:
        return sum(a < 2 for a in self.children_ages)

    @property
    def pax_children(self) -> int:
        return sum(2 <= a <= 11 for a in self.children_ages)

    @property
    def pax_adults(self) -> int:
        return self.adults + sum(a >= 12 for a in self.children_ages)

    @property
    def bags_label(self) -> str:
        parts = [f"{self.carry_on_bags} cabin bag{'s' if self.carry_on_bags != 1 else ''}"] if self.carry_on_bags else []
        if self.checked_bags:
            parts.append(f"{self.checked_bags} checked bag{'s' if self.checked_bags != 1 else ''}")
        return " + ".join(parts)

    @property
    def pax_label(self) -> str:
        label = f"{self.adults} adult{'s' if self.adults != 1 else ''}"
        if self.children_ages:
            label += ", children aged " + ", ".join(str(a) for a in sorted(self.children_ages))
        return label


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
    aircraft: str = ""   # as Google Flights names it, e.g. "Airbus A320neo"
    legroom: str = ""    # e.g. "30 in"; Google omits it for some flights

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
    priced: bool = True          # False: the source lists the flight but shows no fare (book on the airline's site)
    self_transfer: bool = False
    hub: str | None = None  # where the tickets of a self-transfer bundle meet
    co2_g: int | None = None          # Google's CO2 estimate for the itinerary, grams per passenger
    co2_typical_g: int | None = None  # Google's typical figure for the route, which its "+20% emissions" compares to

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
    priced: bool = True
    co2_g: int | None = None
    co2_typical_g: int | None = None


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


class BestCell(BaseModel):
    """The cheapest trip for one destination and one trip length (nights): one cell of the compare matrix."""

    destination: str
    nights: int
    cheapest: Trip
    trips: int                 # how many trips (dates, airline mixes) were compared for this cell


class AirlineInfo(BaseModel):
    """An airline seen in the provider's results for this search, before any airline filter."""

    code: str
    name: str
    offers: int                # itineraries it appears in
    cheapest: float | None     # None when every flight it has here is listed without a price
    routes: list[str]          # "TLV>FCO": itineraries it appears in (connections included)
    nonstop: list[str]         # routes where it has a nonstop flight
    included: bool = True      # False when the current filters remove it
    no_price_routes: list[str] = Field(default_factory=list)  # routes where it is listed without a price


class UnpricedFlight(BaseModel):
    """A flight the source lists but shows no fare for (often airlines that sell only on their own site)."""

    date: date
    origin: str
    destination: str
    airline: str
    airline_code: str
    flights: str               # e.g. "H4236"
    departs: datetime
    arrives: datetime
    duration_min: int
    stops: int
    link: str = ""
    last_price: float | None = None     # the last fare we saw for this exact flight (Google drops fares at times)
    last_seen: float | None = None      # unix time of that observation


class SearchResult(BaseModel):
    request: SearchRequest
    daily: list[DailyBest]
    top: list[Trip]
    cells: list[BestCell] = Field(default_factory=list)   # best trip per destination x nights (the compare matrix)
    api_calls: int
    cache_hits: int
    airlines: list[AirlineInfo] = Field(default_factory=list)
    data_from: float | None = None     # unix time of the oldest flight data used (None = all fetched just now)
    unpriced: list[UnpricedFlight] = Field(default_factory=list)
    sources: dict[str, int] = Field(default_factory=dict)  # provider -> lookups it served
    elapsed_s: float = 0.0
    warnings: list[str] = Field(default_factory=list)


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)
