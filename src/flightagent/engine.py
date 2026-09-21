from __future__ import annotations

import asyncio
import itertools
import time
from collections import Counter, defaultdict
from datetime import date, timedelta

from .cache import OfferCache
from .links import AIRLINE_SITES
from .models import DailyBest, LegView, Offer, SearchRequest, SearchResult, Trip
from .providers.base import FlightProvider

Key = tuple[str, str, date]  # (origin, destination, day)
TOP_PER_LEG = 6  # candidates kept per one-way leg for combination
LONG_LAYOVER_MIN = 8 * 60


class BudgetExceeded(RuntimeError):
    def __init__(self, needed: int, budget: int):
        super().__init__(
            f"Search needs {needed} uncached provider calls but max_api_calls={budget}. "
            "Narrow the date window / nights range / destinations, or raise max_api_calls."
        )


class FlightSearchEngine:
    def __init__(self, provider: FlightProvider, cache: OfferCache | None = None, concurrency: int = 8):
        self._on_progress = None
        self.provider = provider
        self.cache = cache
        self.sem = asyncio.Semaphore(concurrency)
        self.api_calls = 0
        self.cache_hits = 0

    # ------------------------------------------------------------------ public

    async def search(self, req: SearchRequest, on_progress=None) -> SearchResult:
        """on_progress(done, total) is called as uncached lookups complete."""
        self._on_progress = on_progress
        self.api_calls = self.cache_hits = 0
        self.sources: Counter[str] = Counter()
        started = time.perf_counter()
        shapes = self._plan_shapes(req)
        keys = self._required_keys(req, shapes)
        raw, warnings = await self._prefetch(req, keys)

        leg_cache: dict[Key, list[Offer]] = {}

        def options(key: Key) -> list[Offer]:
            if key not in leg_cache:
                leg_cache[key] = self._leg_options(req, key, raw)
            return leg_cache[key]

        trips: list[Trip] = []
        for kind, label, dep, ret, keyset in shapes:
            per_leg = [options(k) for k in keyset]
            if any(not o for o in per_leg):
                continue
            for legs in self._pick(req, kind, per_leg):
                trips.append(self._build_trip(req, kind, label, dep, ret, keyset, legs))

        daily = self._daily(trips)
        top = self._top(trips, req.top_n)
        if not trips:
            warnings.append("No itinerary satisfied the constraints.")
        return SearchResult(
            request=req, daily=daily, top=top,
            api_calls=self.api_calls, cache_hits=self.cache_hits, warnings=warnings,
            sources=dict(self.sources), elapsed_s=round(time.perf_counter() - started, 1),
        )

    def estimate(self, req: SearchRequest) -> dict[str, int]:
        """How many one-way lookups a search needs, and how many are already cached."""
        keys = self._required_keys(req, self._plan_shapes(req))
        cached = sum(1 for k in keys if self.cache and self.cache.has(self._cache_key(req, k)))
        return {"lookups": len(keys), "cached": cached, "to_fetch": len(keys) - cached}

    # ---------------------------------------------------------------- planning

    def _plan_shapes(self, req: SearchRequest):
        """Enumerate (kind, label, depart, return, [leg keys]) for every date pair and route shape."""
        shapes = []
        return_pool = list(dict.fromkeys(req.destinations + req.return_airports))
        for dep in _days(req.window_start, req.window_end):
            for nights in range(req.min_nights, req.max_nights + 1):
                ret = dep + timedelta(days=nights)
                if ret > req.window_end:
                    break
                for d_out in req.destinations:
                    for d_ret in return_pool:
                        if d_out != d_ret and not req.open_jaw:
                            continue
                        if d_out == d_ret:
                            kind, label = "round_trip", d_out
                        else:
                            kind, label = "open_jaw", f"{d_out}→{d_ret}"
                        shapes.append((kind, label, dep, ret,
                                       [(req.origin, d_out, dep), (d_ret, req.origin, ret)]))
                if req.connect_destinations:
                    m = req.min_nights_per_stop
                    for d1, d2 in itertools.permutations(req.destinations, 2):
                        for mid_off in range(m, nights - m + 1):
                            mid = dep + timedelta(days=mid_off)
                            shapes.append(("multi_stop", f"{d1}+{d2}", dep, ret,
                                           [(req.origin, d1, dep), (d1, d2, mid), (d2, req.origin, ret)]))
        return shapes

    def _required_keys(self, req: SearchRequest, shapes) -> set[Key]:
        keys: set[Key] = set()
        for *_, keyset in shapes:
            keys.update(keyset)
        if req.allow_self_transfer:
            for o, d, day in list(keys):
                for h in req.self_transfer_hubs:
                    if h not in (o, d):
                        keys |= {(o, h, day), (h, d, day), (h, d, day + timedelta(days=1))}
        return keys

    # ------------------------------------------------------------------- fetch

    def _cache_key(self, req: SearchRequest, k: Key) -> str:
        return f"{self.provider.name}|{k[0]}|{k[1]}|{k[2]}|{req.currency}|{req.adults}|{req.max_stops_per_leg}"

    async def _prefetch(self, req: SearchRequest, keys: set[Key]):
        raw: dict[Key, list[Offer]] = {}
        missing: list[Key] = []
        for k in keys:
            cached = self.cache.get(self._cache_key(req, k)) if self.cache else None
            if cached is None:
                missing.append(k)
            else:
                raw[k] = cached
                self.cache_hits += 1
        if len(missing) > req.max_api_calls:
            raise BudgetExceeded(len(missing), req.max_api_calls)

        errors: list[str] = []
        done = 0
        if self._on_progress:
            self._on_progress(0, len(missing))

        async def fetch(k: Key):
            nonlocal done
            try:
                await fetch_one(k)
            finally:
                done += 1
                if self._on_progress:
                    self._on_progress(done, len(missing))

        async def fetch_one(k: Key):
            async with self.sem:
                try:
                    offers = await self.provider.one_way(
                        k[0], k[1], k[2], currency=req.currency, adults=req.adults,
                        max_stops=req.max_stops_per_leg,
                    )
                except Exception as e:  # one bad route/day must not sink the whole search
                    errors.append(f"{k[0]}->{k[1]} {k[2]}: {e}")
                    return
                self.api_calls += 1
                self.sources[getattr(offers, "source", "") or self.provider.name] += 1
                raw[k] = offers
                if self.cache and offers:  # never cache "no flights": it may be a bad code, not a fact
                    self.cache.put(self._cache_key(req, k), offers)

        await asyncio.gather(*(fetch(k) for k in missing))
        if errors and not raw:
            raise RuntimeError(f"All provider calls failed. First error: {errors[0]}")
        warnings = [f"{len(errors)} provider call(s) failed; first: {errors[0]}"] if errors else []
        if raw and not any(raw.values()):
            warnings.append("The provider returned no flights for ANY route. Check the airport codes "
                            "(use airports such as FCO, or a city code the provider supports) and the dates.")
        return raw, warnings

    # --------------------------------------------------------- one-way options

    def _leg_options(self, req: SearchRequest, key: Key, raw: dict[Key, list[Offer]]) -> list[Offer]:
        o, d, day = key
        candidates = list(raw.get((o, d, day), []))
        if req.allow_self_transfer:
            for h in req.self_transfer_hubs:
                if h in (o, d):
                    continue
                first = sorted(raw.get((o, h, day), []), key=lambda x: x.price)[:5]
                second = sorted(
                    raw.get((h, d, day), []) + raw.get((h, d, day + timedelta(days=1)), []),
                    key=lambda x: x.price)[:8]
                for a, b in itertools.product(first, second):
                    gap = int((b.departs - a.arrives).total_seconds() // 60)
                    if max(req.self_transfer_buffer_min, req.min_layover_min) <= gap <= req.max_layover_min:
                        candidates.append(Offer(
                            origin=o, destination=d, price=round(a.price + b.price, 2),
                            currency=a.currency, segments=a.segments + b.segments,
                            deep_links=a.deep_links + b.deep_links,
                            provider=a.provider, self_transfer=True, hub=h,
                        ))
        ok = [c for c in candidates if self._passes(req, c)]
        ok.sort(key=lambda c: self._leg_cost(req, c))
        return ok[:TOP_PER_LEG]

    @staticmethod
    def _passes(req: SearchRequest, c: Offer) -> bool:
        if c.stops > req.max_stops_per_leg:
            return False
        if any(not (req.min_layover_min <= lay <= req.max_layover_min) for lay in c.layovers_min):
            return False
        cap = req.max_travel_min_per_direction
        return cap is None or c.duration_min <= cap

    @staticmethod
    def _leg_cost(req: SearchRequest, c: Offer) -> float:
        """Price plus the monetary value of time in transit ("best value" score)."""
        cost = c.price + req.value_of_time_per_hour * c.duration_min / 60
        return cost + (req.self_transfer_penalty if c.self_transfer else 0)

    # ------------------------------------------------------------- composition

    def _pick(self, req: SearchRequest, kind: str, per_leg: list[list[Offer]]):
        """Legs are independent, so the cheapest / best-value trip is just the per-leg minimum.
        Only the same-airline restriction couples outbound and return, needing a real product."""
        if not req.allow_mixed_airlines and kind != "multi_stop":
            combos = [c for c in itertools.product(*per_leg)
                      if set(c[0].airlines) == set(c[1].airlines)]
            if not combos:
                return []
            return _dedupe([min(combos, key=lambda c: sum(x.price for x in c)),
                            min(combos, key=lambda c: sum(self._leg_cost(req, x) for x in c))])
        cheapest = tuple(min(opts, key=lambda x: x.price) for opts in per_leg)
        best = tuple(opts[0] for opts in per_leg)  # lists are pre-sorted by value score
        return _dedupe([cheapest, best])

    def _build_trip(self, req, kind, label, dep, ret, keyset, legs: tuple[Offer, ...]) -> Trip:
        views = [LegView(
            origin=l.origin, destination=l.destination, airlines=l.airlines, segments=l.segments,
            stops=l.stops, layovers_min=l.layovers_min, duration_min=l.duration_min,
            price=l.price, self_transfer=l.self_transfer, deep_links=l.deep_links,
        ) for l in legs]
        warnings: list[str] = []
        for l in legs:
            if l.self_transfer:
                hub = l.hub
                warnings.append(
                    f"SELF-TRANSFER {l.origin}→{l.destination} via {hub}: separate tickets. "
                    "You must collect and re-check baggage (possibly change terminal); "
                    "a delay on the first flight is NOT protected on the second."
                )
            for seg, lay in zip(l.segments, l.layovers_min):
                if lay >= LONG_LAYOVER_MIN:
                    warnings.append(f"Long layover at {seg.destination}: {lay // 60}h{lay % 60:02d}")
        if kind == "open_jaw":
            warnings.append("Open-jaw: arrive and depart from different airports; plan ground transport.")
        if len({tuple(l.airlines) for l in legs}) > 1 and kind != "multi_stop":
            warnings.append("Outbound and return are separate one-way tickets on different airlines.")
        return Trip(
            kind=kind, destination=label, depart_date=dep, return_date=ret,
            nights=(ret - dep).days, legs=views, price=round(sum(l.price for l in legs), 2),
            currency=req.currency, total_travel_min=sum(l.duration_min for l in legs),
            stops=sum(l.stops for l in legs),
            airlines=list(dict.fromkeys(a for l in legs for a in l.airlines)),
            self_transfer=any(l.self_transfer for l in legs), warnings=warnings,
            effective_cost=round(sum(self._leg_cost(req, l) for l in legs), 2),
        )

    # ------------------------------------------------------------- aggregation

    @staticmethod
    def _daily(trips: list[Trip]) -> list[DailyBest]:
        by_day: dict[date, list[Trip]] = defaultdict(list)
        for t in trips:
            by_day[t.depart_date].append(t)
        return [
            DailyBest(
                depart_date=day,
                cheapest=min(ts, key=lambda t: (t.price, t.effective_cost)),
                best_value=min(ts, key=lambda t: (t.effective_cost, t.price)),
            )
            for day, ts in sorted(by_day.items())
        ]

    @staticmethod
    def _top(trips: list[Trip], n: int) -> list[Trip]:
        seen, out = set(), []
        for t in sorted(trips, key=lambda t: (t.effective_cost, t.price)):
            sig = (t.kind, t.destination, t.depart_date, t.return_date,
                   tuple(s.label for l in t.legs for s in l.segments))
            if sig not in seen:
                seen.add(sig)
                out.append(t)
            if len(out) == n:
                break
        return out


def airline_site(code: str) -> str | None:
    return AIRLINE_SITES.get(code)


def _days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def _dedupe(items):
    out = []
    for i in items:
        if i not in out:
            out.append(i)
    return out
