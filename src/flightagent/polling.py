"""When to look again. Fares move faster close to departure, and a flight Google lists without a price is often
priced on the next request, so those are rechecked on a schedule that depends on how far away the flight is."""
from __future__ import annotations

from datetime import date

MAX_INTERVAL_S = 6 * 3600


def unpriced_interval(days_out: int) -> int:
    """Seconds before a route/day that has unpriced flights is worth asking about again."""
    return 15 * 60 if days_out <= 14 else 3600 if days_out <= 60 else 3 * 3600


def fare_ttl(days_out: int, default: float) -> float:
    """Cache lifetime for priced results: shorter right before departure, when fares change quickly."""
    if days_out <= 2:
        return min(default, 3600)
    if days_out <= 14:
        return min(default, 3 * 3600)
    return default


def next_check_time(unpriced_dates: list[date], rechecks: int, now: float, today: date | None = None) -> float | None:
    """Unix time of the next automatic recheck, or None when there is nothing to recheck.
    Backs off (x2 after 4 fruitless rechecks, x3 after 8, ...) so a flight Google never prices costs little."""
    today = today or date.today()
    future = [d for d in unpriced_dates if d >= today]
    if not future:
        return None
    base = unpriced_interval((min(future) - today).days)
    return now + min(base * (1 + rechecks // 4), MAX_INTERVAL_S)
