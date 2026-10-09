"""Checks the gaps between consecutive flights of a hand-built trip: how long the wait is, whether the airports
differ, the estimated ground-transfer time (see geo.py) and whether it all fits."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel

from .geo import metro_of, transfer_between, tz_of
from .models import LegView

SAME_AIRPORT_MIN = 90          # re-check bags and clear security again (separate tickets)
SAME_AIRPORT_RECOMMENDED = 180
CHECKIN_BUFFER_MIN = 120       # be at the airport this long before departure
DIFFERENT_CITY_TIGHT_MIN = 360
LONG_WAIT_MIN = 8 * 60
DAY_MIN = 24 * 60


class GapCheck(BaseModel):
    index: int                                   # gap between legs[index] and legs[index + 1]
    arrive_airport: str
    depart_airport: str
    arrives: datetime
    departs: datetime
    gap_min: int
    gap_text: str
    kind: Literal["same_airport", "same_city", "different_city"]
    transfer_min: int | None = None              # estimated ground time between different airports of one city
    transfer_how: str = ""
    needed_min: int | None = None                # what this connection needs to be comfortable
    status: Literal["ok", "tight", "impossible"]
    long_wait: bool = False
    tz_known: bool = True
    headline: str
    detail: str


class ItineraryCheck(BaseModel):
    total_price: float
    currency: str
    gaps: list[GapCheck]
    warnings: list[str]


def fmt_dur(minutes: int) -> str:
    minutes = abs(minutes)
    h, m = divmod(minutes, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m"


def _gap(arr: datetime, arr_code: str, dep: datetime, dep_code: str) -> tuple[int, bool]:
    """Minutes between landing and the next departure. Local times are converted with each airport's time zone, to UTC
    first: Python subtracts two times of the same zone as wall-clock times, missing a clock change in between."""
    a_tz, d_tz = tz_of(arr_code), tz_of(dep_code)
    if a_tz and d_tz:
        utc = lambda t, tz: t.replace(tzinfo=tz).astimezone(timezone.utc)  # noqa: E731
        return int((utc(dep, d_tz) - utc(arr, a_tz)).total_seconds() // 60), True
    return int((dep - arr).total_seconds() // 60), False


def _gap_text(arr: datetime, dep: datetime, gap: int) -> str:
    nights = (dep.date() - arr.date()).days
    if gap >= 18 * 60 and nights >= 1:
        return f"{nights} night{'s' if nights != 1 else ''}"
    return fmt_dur(gap)


def check_gap(index: int, a: LegView, b: LegView) -> GapCheck:
    land, take = a.segments[-1], b.segments[0]
    A, B = land.destination, take.origin
    gap, tz_known = _gap(land.arrives, A, take.departs, B)
    text = _gap_text(land.arrives, take.departs, gap)
    multi_night = gap >= DAY_MIN
    transfer = transfer_between(A, B)
    if A == B:
        kind, t_min, how = "same_airport", None, ""
        hard, needed = SAME_AIRPORT_MIN, SAME_AIRPORT_RECOMMENDED
    elif transfer:
        kind, (t_min, how) = "same_city", transfer
        hard, needed = t_min, t_min + CHECKIN_BUFFER_MIN
    else:
        kind, t_min, how = "different_city", None, ""
        hard, needed = None, None

    if gap < 0:
        status = "impossible"
    elif hard is not None and gap < hard:
        status = "impossible"
    elif needed is not None and gap < needed:
        status = "tight"
    elif kind == "different_city" and gap < DIFFERENT_CITY_TIGHT_MIN:
        status = "tight"
    else:
        status = "ok"
    long_wait = kind != "different_city" and LONG_WAIT_MIN <= gap < DAY_MIN

    where = f"landing at {A} and leaving from {B}" if A != B else f"flights at {A}"
    if gap < 0:
        headline = f"Not enough time: the next flight leaves {fmt_dur(gap)} before this one lands."
    elif status == "impossible":
        headline = f"Not enough time: only {text} between {where}."
    elif status == "tight":
        headline = f"Tight connection: only {text} between {where}."
    elif long_wait:
        headline = f"Long wait: {text} between {where}."
    else:
        headline = f"{text} between {where}."

    if kind == "same_airport":
        detail = "" if multi_night else "Same airport but separate tickets: collect bags, re-check in and clear security again. Plan at least 3h."
    elif kind == "same_city":
        detail = (f"You land at {A} but the next flight leaves from {B}: getting between them takes about {t_min} min "
                  f"({how}; estimate, traffic varies).")
        if not multi_night:
            detail += f" With about 2h to check in, you need at least {fmt_dur(needed)} between landing and departure."
    else:
        detail = f"{A} and {B} are in different cities. No transfer estimate is available, so allow for your own ground travel."
    if not tz_known:
        detail = (detail + " Time zones unknown, so the gap is approximate.").strip()

    return GapCheck(index=index, arrive_airport=A, depart_airport=B, arrives=land.arrives, departs=take.departs, gap_min=gap,
                    gap_text=text, kind=kind, transfer_min=t_min, transfer_how=how, needed_min=needed, status=status,
                    long_wait=long_wait, tz_known=tz_known, headline=headline, detail=detail)


def analyse(legs: list[LegView], currency: str = "USD") -> ItineraryCheck:
    gaps = [check_gap(i, a, b) for i, (a, b) in enumerate(zip(legs, legs[1:]))]
    warnings = []
    if len(legs) > 1:
        warnings.append("Each flight is a separate ticket: a delay or cancellation on one is not covered by the others, "
                        "and bags are not checked through.")
    return ItineraryCheck(total_price=round(sum(l.price for l in legs), 2), currency=currency, gaps=gaps, warnings=warnings)


def gap_warning(g: GapCheck) -> str | None:
    """A gap worth telling the user about in search results: airports differ, it is tight, or the wait is long."""
    if g.kind == "same_airport" and g.status == "ok" and not g.long_wait:
        return None
    return f"{g.headline} {g.detail}".strip()
