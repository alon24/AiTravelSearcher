"""Price check by a second fare source (docs/DESIGN.md section 8): each leg of a trip is looked up again on the other
source (Google Flights <-> SerpApi) and the same flights are found by airline, flight number and departure minute of
every segment, never by price. web/local/verify.js is the same logic in the browser (parity-tested)."""
from __future__ import annotations

from datetime import date

from .models import LegView, Offer, Segment
from .providers.airports import expand

# A trip's status is its worst leg's. A price that disagrees is the only real evidence of an error; "not found" and
# "error" are inconclusive.
RANK = {"confirmed": 0, "error": 1, "not_found": 2, "price_differs": 3}
Key = tuple[str, str, date]


def tolerance(price: float) -> float:
    """max(3 %, 5 in the search currency): rounding and a currency's last digit are not a disagreement."""
    return max(abs(price) * 0.03, 5.0)


def flight_key(segments: list[Segment]) -> tuple:
    return tuple((s.airline_code.strip().upper(), s.flight_number.replace(" ", "").upper().lstrip("0") or "0",
                  s.departs.isoformat(timespec="minutes")) for s in segments)


def tickets(leg: LegView) -> list[list[Segment]] | None:
    """The separately bought tickets of a leg: one, or two for a self-transfer, split where they meet at the hub."""
    if not leg.self_transfer:
        return [leg.segments]
    hub = {leg.hub, *expand(leg.hub).split(",")} if leg.hub else set()
    for i, s in enumerate(leg.segments[:-1]):
        if s.destination in hub:
            return [leg.segments[: i + 1], leg.segments[i + 1:]]
    return None


def lookup_key(segments: list[Segment]) -> Key:
    return segments[0].origin, segments[-1].destination, segments[0].departs.date()


def lookups(legs: list[LegView]) -> set[Key]:
    return {lookup_key(t) for leg in legs for t in tickets(leg) or []}


def judge(leg: LegView, found: dict[Key, list[Offer]], errors: dict[Key, str], source: str) -> dict:
    """{status, price, seen_price, note} for one leg, from what the second source listed for its route and day."""
    out = lambda status, note="", seen=None: {"status": status, "price": leg.price, "seen_price": seen, "note": note}  # noqa: E731
    parts = tickets(leg)
    if parts is None:
        return out("error", "a self-transfer saved without its hub: search again to check it")
    seen, missing = 0.0, []
    for segs in parts:
        k = lookup_key(segs)
        if k in errors:
            return out("error", f"{source}: {errors[k]}")
        same = [o for o in found.get(k, []) if flight_key(o.segments) == flight_key(segs)]
        priced = [o.price for o in same if o.priced]
        if not priced:      # several fares for the same flights: the closest, so a second fare class isn't a disagreement
            missing.append("+".join(s.label for s in segs) + (" (listed without a price)" if same else ""))
        else:
            seen += min(priced, key=lambda p: abs(p - leg.price / len(parts)))
    if missing:
        return out("not_found", f"{source} doesn't list {', '.join(missing)}")
    seen = round(seen, 2)
    return out("confirmed" if abs(seen - leg.price) <= tolerance(leg.price) else "price_differs", seen=seen)


def worst(results: list[dict]) -> str:
    return max((r["status"] for r in results), key=RANK.__getitem__)


def second_source(chain: list[str], legs: list[LegView]) -> str | None:
    """The real-fare source in the chain that did not price these legs, or None when there is no second one."""
    used = {leg.provider for leg in legs}
    return next((n for n in chain if n in ("gflights", "serpapi") and n not in used), None)
