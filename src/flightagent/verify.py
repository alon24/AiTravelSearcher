"""Price verification by an independent provider (docs/DESIGN.md section 8).

Each leg of a trip is looked up again on the verifier and the same flights are found by airline code, flight number
and departure time of every segment (never by price). The verifier's price is then compared with the search's.
"""
from __future__ import annotations

import time
from datetime import date

from .engine import FlightSearchEngine
from .models import LegView, Offer, SearchRequest, Segment, Trip, TripVerification, Verification, VerifyStatus
from .providers.airports import expand

# Worst last: a trip's status is its worst leg's. A price that disagrees is the only real evidence of an error;
# "not found" and "error" are inconclusive.
RANK: dict[str, int] = {"confirmed": 0, "error": 1, "not_found": 2, "price_differs": 3}

Key = tuple[str, str, date]
FlightKey = tuple[tuple[str, str, str], ...]


def tolerance(price: float, pct: float = 0.03, minimum: float = 5.0) -> float:
    """Default rule: max(3 %, 5 in the search currency)."""
    return max(abs(price) * pct, minimum)


def _number(n: str) -> str:
    return n.replace(" ", "").upper().lstrip("0") or "0"


def flight_key(segments: list[Segment]) -> FlightKey:
    """Identity of an itinerary: airline + flight number + departure minute of every segment."""
    return tuple((s.airline_code.strip().upper(), _number(s.flight_number), s.departs.isoformat(timespec="minutes"))
                 for s in segments)


def trip_key(t: Trip) -> str:
    """Stable id for a trip across re-renders, rechecks and filter changes (the UI computes the same string)."""
    return "/".join("|".join(f"{s.airline_code}{s.flight_number}@{s.departs.isoformat(timespec='minutes')}" for s in leg.segments)
                    for leg in t.legs)


def tickets(leg: LegView) -> list[list[Segment]] | None:
    """The separately bought tickets of a leg: one, or two for a self-transfer (split where they meet at the hub).
    None when a self-transfer leg has no hub recorded (results saved before verification existed)."""
    if not leg.self_transfer:
        return [leg.segments]
    if not leg.hub:
        return None
    hub = {leg.hub, *expand(leg.hub).split(",")}
    for i, s in enumerate(leg.segments[:-1]):
        if s.destination in hub:
            return [leg.segments[: i + 1], leg.segments[i + 1:]]
    return None


def lookup_key(segments: list[Segment]) -> Key:
    return segments[0].origin, segments[-1].destination, segments[0].departs.date()


def _match(segments: list[Segment], offers: list[Offer], expected: float) -> tuple[float | None, bool]:
    """(price the verifier shows for exactly these flights, listed at all). Several fares for the same flights: the
    one closest to ours, so a second fare class is not reported as a disagreement."""
    want = flight_key(segments)
    same = [o for o in offers if flight_key(o.segments) == want]
    priced = [o.price for o in same if o.priced]
    if not priced:
        return None, bool(same)
    return min(priced, key=lambda p: abs(p - expected)), True


def verify_leg(leg: LegView, raw: dict[Key, list[Offer]], errors: dict[Key, str], provider: str, now: float) -> Verification:
    v = lambda status, note="", seen=None: Verification(  # noqa: E731
        status=status, price=leg.price, seen_price=seen, delta=None if seen is None else round(seen - leg.price, 2),
        provider=provider, checked_at=now, note=note)
    parts = tickets(leg)
    if parts is None:
        return v("error", "Self-transfer saved without its hub: search again to verify it")
    seen_total, missing = 0.0, []
    for segs in parts:
        k = lookup_key(segs)
        if k in errors or k not in raw:
            return v("error", errors.get(k, "lookup failed"))
        # Each ticket of a self-transfer is priced separately; the search only kept their sum.
        price, listed = _match(segs, raw[k], leg.price / len(parts))
        if price is None:
            missing.append("+".join(s.label for s in segs) + (" (listed without a price)" if listed else ""))
        else:
            seen_total += price
    if missing:
        return v("not_found", f"{provider} does not list {', '.join(missing)}")
    seen_total = round(seen_total, 2)
    if abs(seen_total - leg.price) <= tolerance(leg.price):
        return v("confirmed", seen=seen_total)
    return v("price_differs", seen=seen_total)


def worst(statuses: list[VerifyStatus]) -> VerifyStatus:
    return max(statuses, key=RANK.__getitem__)


async def verify_trips(trips: list[Trip], req: SearchRequest, verifier: FlightSearchEngine) -> list[TripVerification]:
    """Verify every leg of these trips with one batch of lookups (shared routes and days are fetched once)."""
    keys: set[Key] = set()
    for t in trips:
        for leg in t.legs:
            keys.update(lookup_key(segs) for segs in tickets(leg) or [])
    raw, errors = await verifier.lookups(req, keys) if keys else ({}, {})
    now, name = time.time(), verifier.provider.name
    out = []
    for t in trips:
        legs = [verify_leg(leg, raw, errors, name, now) for leg in t.legs]
        out.append(TripVerification(status=worst([lv.status for lv in legs]), legs=legs, provider=name, checked_at=now))
    return out
