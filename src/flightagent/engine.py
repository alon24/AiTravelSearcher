from __future__ import annotations

import asyncio
import itertools
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from .cache import OfferCache
from .links import AIRLINE_SITES
from .itinerary import analyse, gap_warning
from .polling import fare_ttl, unpriced_interval
from .models import AirlineInfo, BestCell, DailyBest, LegView, Offer, SearchRequest, SearchResult, Segment, Trip, UnpricedFlight
from .providers.base import FlightProvider

Key = tuple[str, str, date]  # (origin, destination, day)
TOP_PER_LEG = 6  # candidates kept per one-way leg for combination
LONG_LAYOVER_MIN = 8 * 60


def leg_view(l: Offer) -> LegView:
    return LegView(origin=l.origin, destination=l.destination, airlines=l.airlines, segments=l.segments, stops=l.stops,
                   layovers_min=l.layovers_min, duration_min=l.duration_min, price=l.price,
                   self_transfer=l.self_transfer, deep_links=l.deep_links, priced=l.priced,
                   co2_g=l.co2_g, co2_typical_g=l.co2_typical_g, usual_price=l.usual_price, provider=l.provider, hub=l.hub)


def _sum(*values: int | None) -> int | None:
    """A bundle's total, or None when any ticket's figure is unknown (a partial sum would look complete)."""
    return None if None in values else sum(values)


class BudgetExceeded(RuntimeError):
    def __init__(self, needed: int, budget: int):
        super().__init__(
            f"Search needs {needed} uncached provider calls but max_api_calls={budget}. "
            "Narrow the date window / nights range / destinations, or raise max_api_calls."
        )


class FlightSearchEngine:
    def __init__(self, provider: FlightProvider, cache: OfferCache | None = None, concurrency: int = 8):
        self._on_progress = None
        self.oldest_ts: float | None = None
        self.api_calls = self.cache_hits = 0
        self.sources: Counter[str] = Counter()
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
        self.oldest_ts: float | None = None
        started = time.perf_counter()
        shapes = self._plan_shapes(req)
        keys = self._required_keys(req, shapes)
        raw, warnings = await self._prefetch(req, keys)

        leg_cache: dict[Key, list[Offer]] = {}

        def options(key: Key) -> list[Offer]:
            if key not in leg_cache:
                leg_cache[key] = self._leg_options(req, key, raw)
            return leg_cache[key]

        airlines = self._airline_summary(req, raw)
        unpriced = self._unpriced(req, raw)
        trips: list[Trip] = []
        for kind, label, dep, ret, keyset in shapes:
            per_leg = [options(k) for k in keyset]
            if any(not o for o in per_leg):
                continue
            for legs in self._pick(req, kind, per_leg):
                trips.append(self._build_trip(req, kind, label, dep, ret, keyset, legs))

        daily = self._daily(trips)
        top = self._top(trips, req.top_n)
        cells = self._cells(trips)
        if not trips:
            warnings.append("No itinerary satisfied the constraints.")
        if req.carry_on_bags or req.checked_bags:
            warnings.append(f"Prices include Google's estimated fees for {req.bags_label}. Google only has fee data for some airlines and "
                            "markets (mostly US and Europe); where it has none, the bag is not priced in.")
        if req.children_ages:
            warnings.append(f"Prices are totals for {req.pax_label}. Google prices children by age "
                            "(under 2 = infant on lap, 2-11 = child, 12+ = adult); airlines' own rules can differ.")
        if req.pax_infants:
            warnings.append("Travelling with an infant under 2 (on a lap): infant fees and rules differ by airline, may not be in "
                            "these prices, and Google may hide airlines that do not carry infants. Confirm on the airline's site.")
        return SearchResult(
            request=req, daily=daily, top=top, cells=cells,
            api_calls=self.api_calls, cache_hits=self.cache_hits, warnings=warnings,
            airlines=airlines, unpriced=unpriced, data_from=self.oldest_ts, sources=dict(self.sources), elapsed_s=round(time.perf_counter() - started, 1),
        )

    def estimate(self, req: SearchRequest) -> dict[str, int]:
        """How many one-way lookups a search needs, and how many are already cached."""
        keys = self._required_keys(req, self._plan_shapes(req))
        cached = sum(1 for k in keys if self.cache and self.cache.has(self._cache_key(req, k)))
        return {"lookups": len(keys), "cached": cached, "to_fetch": len(keys) - cached}

    async def one_way_options(self, req: SearchRequest, origin: str, dest: str, day: date) -> list[Offer]:
        """Every one-way offer for a single route and day (for hand-built trips). Uses the shared cache."""
        self.api_calls = self.cache_hits = 0
        self.sources = Counter()
        self._on_progress = None
        key = (origin, dest, day)
        raw, _ = await self._prefetch(req, {key})
        return raw.get(key, [])

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

    def _ttl_for(self, day: date, offers: list[Offer]) -> float:
        """How long this result may be reused: unpriced flights are rechecked soon (15 min when the flight is within
        two weeks), and fares close to departure expire faster than distant ones."""
        days_out = (day - date.today()).days
        ttl = fare_ttl(days_out, self.cache.ttl)
        if any(not o.priced for o in offers):
            ttl = min(ttl, unpriced_interval(days_out))
        return ttl

    def _cache_key(self, req: SearchRequest, k: Key) -> str:
        return f"v4|{self.provider.name}|{k[0]}|{k[1]}|{k[2]}|{req.currency}|{req.pax_adults}-{req.pax_children}-{req.pax_infants}|b{req.carry_on_bags}{req.checked_bags}|{req.max_stops_per_leg}"

    async def _prefetch(self, req: SearchRequest, keys: set[Key]):
        raw: dict[Key, list[Offer]] = {}
        missing: list[Key] = []
        for k in keys:
            entry = self.cache.get_entry(self._cache_key(req, k), stale=req.stale_ok) if self.cache else None
            cached = entry[0] if entry else None
            if cached is not None and req.refresh_unpriced and any(not o.priced for o in cached):
                cached = None            # a recheck was asked for: do not trust a cached "no price"
            if cached is None:
                missing.append(k)
            else:
                raw[k] = cached
                self.cache_hits += 1
                self.oldest_ts = entry[1] if self.oldest_ts is None else min(self.oldest_ts, entry[1])
        if len(missing) > req.max_api_calls:
            raise BudgetExceeded(len(missing), req.max_api_calls)

        errors: list[str] = []
        fallbacks: list[str] = []      # why a lookup was answered by the backup provider (FallbackProvider)
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
                        k[0], k[1], k[2], currency=req.currency, adults=req.pax_adults,
                        children=req.pax_children, infants=req.pax_infants, max_stops=req.max_stops_per_leg,
                        carry_on_bags=req.carry_on_bags, checked_bags=req.checked_bags,
                    )
                except Exception as e:  # one bad route/day must not sink the whole search
                    errors.append(f"{k[0]}->{k[1]} {k[2]}: {e}")
                    return
                self.api_calls += 1
                if self.cache:
                    self.cache.remember_fares({self._fare_key(req, o): o.price for o in offers if o.priced})
                self.sources[getattr(offers, "source", "") or self.provider.name] += 1
                if getattr(offers, "fallback", ""):
                    fallbacks.append(offers.fallback)
                raw[k] = offers
                if self.cache and offers:  # never cache "no flights": it may be a bad code, not a fact
                    self.cache.put(self._cache_key(req, k), offers, self._ttl_for(k[2], offers))

        await asyncio.gather(*(fetch(k) for k in missing))
        if errors and not raw:
            raise RuntimeError(f"All provider calls failed. First error: {errors[0]}")
        warnings = [f"{len(errors)} provider call(s) failed; first: {errors[0]}"] if errors else []
        if fallbacks:
            warnings.append(f"{len(fallbacks)} lookup(s) used the backup provider; first: {fallbacks[0]}")
        if raw and not any(raw.values()):
            warnings.append("The provider returned no flights for ANY route. Check the airport codes "
                            "(use airports such as FCO, or a city code the provider supports) and the dates.")
        return raw, warnings

    # --------------------------------------------------------- one-way options

    def _leg_options(self, req: SearchRequest, key: Key, raw: dict[Key, list[Offer]]) -> list[Offer]:
        o, d, day = key
        ok_raw = lambda k: [x for x in raw.get(k, []) if x.priced and self._airline_ok(req, x)]  # noqa: E731
        candidates = ok_raw((o, d, day))
        if req.allow_self_transfer:
            for h in req.self_transfer_hubs:
                if h in (o, d):
                    continue
                first = sorted(ok_raw((o, h, day)), key=lambda x: x.price)[:5]
                second = sorted(
                    ok_raw((h, d, day)) + ok_raw((h, d, day + timedelta(days=1))),
                    key=lambda x: x.price)[:8]
                for a, b in itertools.product(first, second):
                    gap = int((b.departs - a.arrives).total_seconds() // 60)
                    if max(req.self_transfer_buffer_min, req.min_layover_min) <= gap <= req.max_layover_min:
                        candidates.append(Offer(
                            origin=o, destination=d, price=round(a.price + b.price, 2),
                            currency=a.currency, segments=a.segments + b.segments,
                            deep_links=a.deep_links + b.deep_links,
                            provider=a.provider, self_transfer=True, hub=h,
                            co2_g=_sum(a.co2_g, b.co2_g), co2_typical_g=_sum(a.co2_typical_g, b.co2_typical_g),
                        ))
        ok = [c for c in candidates if self._passes(req, c)]
        ok.sort(key=lambda c: self._leg_cost(req, c))
        return ok[:TOP_PER_LEG]

    @staticmethod
    def _airline_ok(req: SearchRequest, c: Offer) -> bool:
        codes = {s.airline_code for s in c.segments}
        if req.airlines_include and not codes <= set(req.airlines_include):
            return False
        return not codes & set(req.airlines_exclude)

    def _airline_summary(self, req: SearchRequest, raw: dict[Key, list[Offer]]) -> list[AirlineInfo]:
        """Every airline the provider returned (before filtering), with the routes it flies."""
        info: dict[str, dict] = {}
        for offers in raw.values():
            for o in offers:
                route = f"{o.origin}>{o.destination}"
                for code in {s.airline_code for s in o.segments}:
                    a = info.setdefault(code, {"name": "", "offers": 0, "cheapest": None, "routes": set(), "nonstop": set(), "nofare": set()})
                    a["name"] = a["name"] or next(s.airline for s in o.segments if s.airline_code == code) or code
                    a["offers"] += 1
                    if o.priced:
                        a["cheapest"] = o.price if a["cheapest"] is None else min(a["cheapest"], o.price)
                    else:
                        a["nofare"].add(route)
                    a["routes"].add(route)
                    if o.stops == 0:
                        a["nonstop"].add(route)
        probe = lambda code: self._airline_ok(req, Offer(origin="", destination="", price=0, currency="", segments=[  # noqa: E731
            Segment(airline_code=code, flight_number="", origin="", destination="", departs=datetime.min, arrives=datetime.min)]))
        return sorted((AirlineInfo(code=c, name=a["name"], offers=a["offers"], cheapest=a["cheapest"], routes=sorted(a["routes"]),
                                    nonstop=sorted(a["nonstop"]), included=probe(c), no_price_routes=sorted(a["nofare"]))
                       for c, a in info.items()),
                      key=lambda x: (x.cheapest is None, x.cheapest or 0, x.name))

    @staticmethod
    def _fare_key(req: SearchRequest, f: Offer) -> str:
        label = "+".join(f"{s.airline_code}{s.flight_number}" for s in f.segments)
        return f"{req.currency}|{req.pax_adults}-{req.pax_children}-{req.pax_infants}|b{req.carry_on_bags}{req.checked_bags}|{label}|{f.departs.isoformat()}"

    def _unpriced(self, req: SearchRequest, raw: dict[Key, list[Offer]]) -> list[UnpricedFlight]:
        """Flights the source lists without a fare: shown to the user, never ranked."""
        seen, out = set(), []
        for (o, d, day), offers in sorted(raw.items(), key=lambda kv: kv[0][2]):
            for f in offers:
                if f.priced or not self._airline_ok(req, f):
                    continue
                label = "+".join(f"{s.airline_code}{s.flight_number}" for s in f.segments)
                if (label, f.departs) in seen:
                    continue
                seen.add((label, f.departs))
                last = self.cache.recall_fare(self._fare_key(req, f)) if self.cache else None
                out.append(UnpricedFlight(date=f.departs.date(), origin=f.origin, destination=f.destination, airline=f.segments[0].airline or f.segments[0].airline_code,
                                          airline_code=f.segments[0].airline_code, flights=label, departs=f.departs, arrives=f.arrives,
                                          duration_min=f.duration_min, stops=f.stops, link=(f.deep_links or [""])[0],
                                          last_price=last[0] if last else None, last_seen=last[1] if last else None))
        return out[:60]

    @staticmethod
    def _passes(req: SearchRequest, c: Offer) -> bool:
        if not c.priced or c.stops > req.max_stops_per_leg or not FlightSearchEngine._airline_ok(req, c):
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
        views = [leg_view(l) for l in legs]
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
        warnings += [w for g in analyse(views).gaps if (w := gap_warning(g))]  # transfer time between airports, tight/long gaps
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

    # Most cells sent to the browser (each carries a full trip). 300 = 10 destinations x 30 trip lengths.
    MAX_CELLS = 300

    @staticmethod
    def _cells(trips: list[Trip]) -> list[BestCell]:
        """Cheapest trip for every (destination, nights): what "4, 5 or 6 nights to Rome, Paris or London" needs.
        A single "cheapest trip" hides those choices. If there are more than MAX_CELLS, the cheapest are kept."""
        groups: dict[tuple[str, int], list[Trip]] = defaultdict(list)
        for t in trips:
            groups[(t.destination, t.nights)].append(t)
        cells = [BestCell(destination=dest, nights=n, cheapest=min(ts, key=lambda t: (t.price, t.effective_cost)), trips=len(ts))
                 for (dest, n), ts in groups.items()]
        cells.sort(key=lambda c: c.cheapest.price)
        cells = cells[:FlightSearchEngine.MAX_CELLS]
        return sorted(cells, key=lambda c: (c.nights, c.cheapest.price))

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
