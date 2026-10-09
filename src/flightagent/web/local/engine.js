/* engine.py in the browser: enumerate date pairs and route shapes, fetch the one-way fares they need (cached), then
   filter, compose and rank trips. A line-for-line port: tests/test_browser_parity.py runs both on the same searches
   and requires identical results. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const TOP_PER_LEG = 6;           // candidates kept per one-way leg for combination
  const LONG_LAYOVER_MIN = 8 * 60;
  const MAX_CELLS = 300;           // 10 destinations x 30 trip lengths

  class BudgetExceeded extends Error {
    constructor(needed, budget) {
      super(`Search needs ${needed} uncached provider calls but max_api_calls=${budget}. `
        + "Narrow the date window / nights range / destinations, or raise max_api_calls.");
    }
  }

  // Lexicographic min / sort keys, keeping the first of equals like Python's min() and sorted().
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
  const minBy = (list, key) => list.reduce((best, x) => (cmp(key(x), key(best)) < 0 ? x : best));
  const sortBy = (list, key) => list.map(x => [key(x), x]).sort((a, b) => cmp(a[0], b[0])).map(p => p[1]);
  const keyOf = (o, d, day) => `${o}|${d}|${day}`;
  const splitKey = k => k.split("|");

  class Engine {
    /** provider: {name, oneWay(origin, dest, day, opts)}; cache: see db.js OfferCache (optional). */
    constructor(provider, cache = null, concurrency = 8) {
      this.provider = provider; this.cache = cache; this.concurrency = concurrency;
      this.reset();
    }

    reset() { this.apiCalls = 0; this.cacheHits = 0; this.sources = {}; this.oldestTs = null; this.onProgress = null; }

    // ---------------------------------------------------------------- public

    /** onProgress(done, total) is called as uncached lookups complete. */
    async search(req, onProgress = null) {
      const M = L.models;
      this.reset();
      this.onProgress = onProgress;
      const started = Date.now();
      const shapes = this.planShapes(req);
      const keys = this.requiredKeys(req, shapes);
      const [raw, warnings] = await this.prefetch(req, keys);

      const legCache = new Map();
      const options = k => { if (!legCache.has(k)) legCache.set(k, this.legOptions(req, k, raw)); return legCache.get(k); };

      const airlines = this.airlineSummary(req, raw);
      const unpriced = await this.unpriced(req, raw);
      const trips = [];
      for (const [kind, label, dep, ret, keyset] of shapes) {
        const perLeg = keyset.map(options);
        if (perLeg.some(o => !o.length)) continue;
        for (const legs of this.pick(req, kind, perLeg)) trips.push(this.buildTrip(req, kind, label, dep, ret, legs));
      }

      if (!trips.length) warnings.push("No itinerary satisfied the constraints.");
      if (req.carry_on_bags || req.checked_bags) {
        warnings.push(`Prices include Google's estimated fees for ${M.bagsLabel(req)}. Google only has fee data for some airlines and `
          + "markets (mostly US and Europe); where it has none, the bag is not priced in.");
      }
      if (req.children_ages.length) {
        warnings.push(`Prices are totals for ${M.paxLabel(req)}. Google prices children by age `
          + "(under 2 = infant on lap, 2-11 = child, 12+ = adult); airlines' own rules can differ.");
      }
      if (M.pax(req).infants) {
        warnings.push("Travelling with an infant under 2 (on a lap): infant fees and rules differ by airline, may not be in "
          + "these prices, and Google may hide airlines that do not carry infants. Confirm on the airline's site.");
      }
      return {
        request: req, daily: daily(trips), top: top(trips, req.top_n), cells: cells(trips), api_calls: this.apiCalls,
        cache_hits: this.cacheHits, airlines, data_from: this.oldestTs, unpriced, sources: { ...this.sources },
        elapsed_s: Math.round((Date.now() - started) / 100) / 10, warnings,
      };
    }

    /** How many one-way lookups a search needs, and how many are already cached. */
    async estimate(req) {
      const keys = this.requiredKeys(req, this.planShapes(req));
      let cached = 0;
      if (this.cache) for (const k of keys) if (await this.cache.has(this.cacheKey(req, k))) cached++;
      return { lookups: keys.size, cached, to_fetch: keys.size - cached };
    }

    /** Every one-way offer for a single route and day (for hand-built trips). Uses the shared cache. */
    async oneWayOptions(req, origin, dest, day) {
      this.reset();
      const k = keyOf(origin, dest, day);
      const [raw] = await this.prefetch(req, new Set([k]));
      return raw.get(k) || [];
    }

    // -------------------------------------------------------------- planning

    /** [kind, label, depart, return, [leg keys]] for every date pair and route shape. */
    planShapes(req) {
      const M = L.models, shapes = [];
      const returnPool = [...new Set([...req.destinations, ...req.return_airports])];
      for (const dep of M.days(req.window_start, req.window_end)) {
        for (let nights = req.min_nights; nights <= req.max_nights; nights++) {
          const ret = M.addDays(dep, nights);
          if (ret > req.window_end) break;
          for (const dOut of req.destinations) {
            for (const dRet of returnPool) {
              if (dOut !== dRet && !req.open_jaw) continue;
              const [kind, label] = dOut === dRet ? ["round_trip", dOut] : ["open_jaw", `${dOut}→${dRet}`];
              shapes.push([kind, label, dep, ret, [keyOf(req.origin, dOut, dep), keyOf(dRet, req.origin, ret)]]);
            }
          }
          if (req.connect_destinations) {
            const m = req.min_nights_per_stop;
            for (const d1 of req.destinations) {
              for (const d2 of req.destinations) {
                if (d1 === d2) continue;
                for (let off = m; off <= nights - m; off++) {
                  const mid = M.addDays(dep, off);
                  shapes.push(["multi_stop", `${d1}+${d2}`, dep, ret,
                    [keyOf(req.origin, d1, dep), keyOf(d1, d2, mid), keyOf(d2, req.origin, ret)]]);
                }
              }
            }
          }
        }
      }
      return shapes;
    }

    requiredKeys(req, shapes) {
      const keys = new Set();
      for (const s of shapes) for (const k of s[4]) keys.add(k);
      if (req.allow_self_transfer) {
        for (const k of [...keys]) {
          const [o, d, day] = splitKey(k);
          for (const h of req.self_transfer_hubs) {
            if (h === o || h === d) continue;
            keys.add(keyOf(o, h, day)); keys.add(keyOf(h, d, day)); keys.add(keyOf(h, d, L.models.addDays(day, 1)));
          }
        }
      }
      return keys;
    }

    // ----------------------------------------------------------------- fetch

    /** How long this result may be reused: unpriced flights are rechecked soon, near departures expire faster. */
    ttlFor(day, offers) {
      const daysOut = L.models.daysBetween(L.models.today(), day);
      let ttl = L.polling.fareTtl(daysOut, this.cache.ttl);
      if (offers.some(o => !o.priced)) ttl = Math.min(ttl, L.polling.unpricedInterval(daysOut));
      return ttl;
    }

    cacheKey(req, k) {
      const [o, d, day] = splitKey(k), p = L.models.pax(req);
      return `v4|${this.provider.name}|${o}|${d}|${day}|${req.currency}|${p.adults}-${p.children}-${p.infants}|b${req.carry_on_bags}${req.checked_bags}|${req.max_stops_per_leg}`;
    }

    async prefetch(req, keys) {
      const raw = new Map(), missing = [];
      for (const k of keys) {
        const entry = this.cache ? await this.cache.getEntry(this.cacheKey(req, k), req.stale_ok) : null;
        let cached = entry ? entry.offers : null;
        if (cached && req.refresh_unpriced && cached.some(o => !o.priced)) cached = null;   // a recheck: don't trust a cached "no price"
        if (!cached) missing.push(k);
        else {
          raw.set(k, cached);
          this.cacheHits++;
          this.oldestTs = this.oldestTs === null ? entry.ts : Math.min(this.oldestTs, entry.ts);
        }
      }
      if (missing.length > req.max_api_calls) throw new BudgetExceeded(missing.length, req.max_api_calls);

      const errors = [], p = L.models.pax(req);
      let done = 0;
      if (this.onProgress) this.onProgress(0, missing.length);
      const fetchOne = async k => {
        const [o, d, day] = splitKey(k);
        let offers;
        try {
          offers = await this.provider.oneWay(o, d, day, { currency: req.currency, adults: p.adults, children: p.children,
            infants: p.infants, maxStops: req.max_stops_per_leg, carryOnBags: req.carry_on_bags, checkedBags: req.checked_bags });
        } catch (e) {               // one bad route/day must not sink the whole search
          errors.push(`${o}->${d} ${day}: ${e.message || e}`);
          return;
        }
        this.apiCalls++;
        if (this.cache) await this.cache.rememberFares(Object.fromEntries(offers.filter(x => x.priced).map(x => [this.fareKey(req, x), x.price])));
        const src = offers.source || this.provider.name;
        this.sources[src] = (this.sources[src] || 0) + 1;
        raw.set(k, offers);
        if (this.cache && offers.length) await this.cache.put(this.cacheKey(req, k), offers, this.ttlFor(day, offers));  // never cache "no flights"
      };
      const queue = [...missing];
      const worker = async () => {
        while (queue.length) {
          await fetchOne(queue.shift());
          done++;
          if (this.onProgress) this.onProgress(done, missing.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));

      if (errors.length && !raw.size) throw new Error(`All provider calls failed. First error: ${errors[0]}`);
      const warnings = errors.length ? [`${errors.length} provider call(s) failed; first: ${errors[0]}`] : [];
      if (raw.size && ![...raw.values()].some(v => v.length)) {
        warnings.push("The provider returned no flights for ANY route. Check the airport codes "
          + "(use airports such as FCO, or a city code the provider supports) and the dates.");
      }
      return [raw, warnings];
    }

    // ------------------------------------------------------- one-way options

    legOptions(req, key, raw) {
      const M = L.models, [o, d, day] = splitKey(key);
      const okRaw = k => (raw.get(k) || []).filter(x => x.priced && airlineOk(req, x));
      const candidates = okRaw(key);
      if (req.allow_self_transfer) {
        for (const h of req.self_transfer_hubs) {
          if (h === o || h === d) continue;
          const first = sortBy(okRaw(keyOf(o, h, day)), x => [x.price]).slice(0, 5);
          const second = sortBy([...okRaw(keyOf(h, d, day)), ...okRaw(keyOf(h, d, M.addDays(day, 1)))], x => [x.price]).slice(0, 8);
          for (const a of first) {
            for (const b of second) {
              const gap = M.minutesBetween(M.arrives(a), M.departs(b));
              if (Math.max(req.self_transfer_buffer_min, req.min_layover_min) <= gap && gap <= req.max_layover_min) {
                candidates.push(M.offer({ origin: o, destination: d, price: M.round2(a.price + b.price), currency: a.currency,
                  segments: [...a.segments, ...b.segments], deep_links: [...a.deep_links, ...b.deep_links],
                  provider: a.provider, self_transfer: true, hub: h }));
              }
            }
          }
        }
      }
      return sortBy(candidates.filter(c => passes(req, c)), c => [legCost(req, c)]).slice(0, TOP_PER_LEG);
    }

    /** Every airline the provider returned (before filtering), with the routes it flies. */
    airlineSummary(req, raw) {
      const M = L.models, info = new Map();
      for (const offers of raw.values()) {
        for (const o of offers) {
          const route = `${o.origin}>${o.destination}`;
          for (const code of new Set(o.segments.map(s => s.airline_code))) {
            if (!info.has(code)) info.set(code, { name: "", offers: 0, cheapest: null, routes: new Set(), nonstop: new Set(), nofare: new Set() });
            const a = info.get(code);
            a.name = a.name || o.segments.find(s => s.airline_code === code).airline || code;
            a.offers++;
            if (o.priced) a.cheapest = a.cheapest === null ? o.price : Math.min(a.cheapest, o.price);
            else a.nofare.add(route);
            a.routes.add(route);
            if (M.stops(o) === 0) a.nonstop.add(route);
          }
        }
      }
      const sorted = set => [...set].sort();
      const list = [...info].map(([code, a]) => ({ code, name: a.name, offers: a.offers, cheapest: a.cheapest, routes: sorted(a.routes),
        nonstop: sorted(a.nonstop), included: airlineOk(req, { segments: [{ airline_code: code }] }), no_price_routes: sorted(a.nofare) }));
      return sortBy(list, x => [x.cheapest === null ? 1 : 0, x.cheapest || 0, x.name, x.code]);
    }

    fareKey(req, f) {
      const p = L.models.pax(req);
      return `${req.currency}|${p.adults}-${p.children}-${p.infants}|b${req.carry_on_bags}${req.checked_bags}|${L.models.label(f)}|${L.models.departs(f)}`;
    }

    /** Flights the source lists without a fare: shown to the user, never ranked. */
    async unpriced(req, raw) {
      const M = L.models, seen = new Set(), out = [];
      const entries = sortBy([...raw], ([k]) => [splitKey(k)[2], k]);
      for (const [, offers] of entries) {
        for (const f of offers) {
          if (f.priced || !airlineOk(req, f)) continue;
          const label = M.label(f), sig = `${label}|${M.departs(f)}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const last = this.cache ? await this.cache.recallFare(this.fareKey(req, f)) : null;
          const s0 = f.segments[0];
          out.push({ date: M.dayOf(M.departs(f)), origin: f.origin, destination: f.destination, airline: s0.airline || s0.airline_code,
            airline_code: s0.airline_code, flights: label, departs: M.departs(f), arrives: M.arrives(f), duration_min: M.duration(f),
            stops: M.stops(f), link: f.deep_links[0] || "", last_price: last ? last.price : null, last_seen: last ? last.ts : null });
        }
      }
      return out.slice(0, 60);
    }

    // ----------------------------------------------------------- composition

    /** Legs are independent, so the cheapest / best-value trip is just the per-leg minimum. Only the same-airline
        restriction couples outbound and return, needing a real product. */
    pick(req, kind, perLeg) {
      if (!req.allow_mixed_airlines && kind !== "multi_stop") {
        const same = (a, b) => { const x = new Set(L.models.airlines(a)), y = new Set(L.models.airlines(b)); return x.size === y.size && [...x].every(c => y.has(c)); };
        const combos = [];
        for (const a of perLeg[0]) for (const b of perLeg[1]) if (same(a, b)) combos.push([a, b]);
        if (!combos.length) return [];
        return dedupe([minBy(combos, c => [c.reduce((t, x) => t + x.price, 0)]),
          minBy(combos, c => [c.reduce((t, x) => t + legCost(req, x), 0)])]);
      }
      const cheapest = perLeg.map(opts => minBy(opts, x => [x.price]));
      const best = perLeg.map(opts => opts[0]);      // lists are pre-sorted by value score
      return dedupe([cheapest, best]);
    }

    buildTrip(req, kind, label, dep, ret, legs) {
      const M = L.models, views = legs.map(M.legView), warnings = [];
      for (const l of legs) {
        if (l.self_transfer) {
          warnings.push(`SELF-TRANSFER ${l.origin}→${l.destination} via ${l.hub}: separate tickets. `
            + "You must collect and re-check baggage (possibly change terminal); "
            + "a delay on the first flight is NOT protected on the second.");
        }
        M.layovers(l).forEach((lay, i) => {
          if (lay >= LONG_LAYOVER_MIN) warnings.push(`Long layover at ${l.segments[i].destination}: ${Math.floor(lay / 60)}h${String(lay % 60).padStart(2, "0")}`);
        });
      }
      for (const g of L.itinerary.analyse(views).gaps) { const w = L.itinerary.gapWarning(g); if (w) warnings.push(w); }
      if (new Set(legs.map(l => M.airlines(l).join(","))).size > 1 && kind !== "multi_stop") {
        warnings.push("Outbound and return are separate one-way tickets on different airlines.");
      }
      return {
        kind, destination: label, depart_date: dep, return_date: ret, nights: M.daysBetween(dep, ret), legs: views,
        price: M.round2(legs.reduce((t, l) => t + l.price, 0)), currency: req.currency,
        total_travel_min: legs.reduce((t, l) => t + M.duration(l), 0), stops: legs.reduce((t, l) => t + M.stops(l), 0),
        airlines: [...new Set(legs.flatMap(M.airlines))], self_transfer: legs.some(l => l.self_transfer), warnings,
        effective_cost: M.round2(legs.reduce((t, l) => t + legCost(req, l), 0)),
      };
    }
  }

  function airlineOk(req, c) {
    const codes = new Set(c.segments.map(s => s.airline_code));
    if (req.airlines_include.length && ![...codes].every(x => req.airlines_include.includes(x))) return false;
    return !req.airlines_exclude.some(x => codes.has(x));
  }

  function passes(req, c) {
    const M = L.models;
    if (!c.priced || M.stops(c) > req.max_stops_per_leg || !airlineOk(req, c)) return false;
    if (M.layovers(c).some(lay => !(req.min_layover_min <= lay && lay <= req.max_layover_min))) return false;
    const cap = req.max_travel_min_per_direction;
    return cap === null || M.duration(c) <= cap;
  }

  /** Price plus the monetary value of time in transit ("best value" score). */
  function legCost(req, c) {
    const cost = c.price + req.value_of_time_per_hour * L.models.duration(c) / 60;
    return cost + (c.self_transfer ? req.self_transfer_penalty : 0);
  }

  function dedupe(items) {
    const out = [];
    for (const i of items) if (!out.some(o => o.length === i.length && o.every((x, n) => x === i[n]))) out.push(i);
    return out;
  }

  // ------------------------------------------------------------- aggregation

  function groupBy(list, key) {
    const m = new Map();
    for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  }

  function daily(trips) {
    return [...groupBy(trips, t => t.depart_date)].sort((a, b) => cmp([a[0]], [b[0]])).map(([day, ts]) => ({
      depart_date: day, cheapest: minBy(ts, t => [t.price, t.effective_cost]), best_value: minBy(ts, t => [t.effective_cost, t.price]),
    }));
  }

  /** Cheapest trip for every (destination, nights): the compare matrix. Over MAX_CELLS, the cheapest are kept. */
  function cells(trips) {
    const list = [...groupBy(trips, t => `${t.destination}|${t.nights}`).values()].map(ts => ({
      destination: ts[0].destination, nights: ts[0].nights, cheapest: minBy(ts, t => [t.price, t.effective_cost]), trips: ts.length,
    }));
    const kept = sortBy(list, c => [c.cheapest.price]).slice(0, MAX_CELLS);
    return sortBy(kept, c => [c.nights, c.cheapest.price]);
  }

  function top(trips, n) {
    const seen = new Set(), out = [];
    for (const t of sortBy(trips, t => [t.effective_cost, t.price])) {
      const sig = [t.kind, t.destination, t.depart_date, t.return_date, ...t.legs.flatMap(l => l.segments.map(s => `${s.airline_code}${s.flight_number}`.replace(/ /g, "")))].join("|");
      if (!seen.has(sig)) { seen.add(sig); out.push(t); }
      if (out.length === n) break;
    }
    return out;
  }

  L.engine = { Engine, BudgetExceeded, airlineOk };
  if (typeof module !== "undefined" && module.exports) module.exports = L.engine;
})(typeof window !== "undefined" ? window : globalThis);
