/* Skyhop's /api, answered inside the browser: app.js's api() hands every request here. Real fares, sign-in and the
   AI come from Skyhop's Cloudflare Worker (worker/); without it, demo fares. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});

  class HttpError extends Error {}
  const fail = msg => { throw new HttpError(msg); };

  let cache, history, engineProvider;
  const running = new Set();
  const jobs = new Map();          // id -> the engine of a running search, for Cancel
  const jsonOnce = url => { let p; return () => (p = p || fetch(url).then(r => r.json())); };
  const loadConfig = jsonOnce("config.json");
  const loadAirports = jsonOnce("airports.json");
  const loadZones = jsonOnce("local/airport_tz.json");

  function setup(provider = L.mock) {
    engineProvider = provider;
    cache = new L.db.OfferCache();
    history = new L.db.History();
  }
  /** Real fares through the Worker once signed in (account.js): free Google Flights first, SerpApi if Google refuses
      (or only the one the Worker has); else the provider given to setup() (demo fares). */
  function provider() {
    const a = L.account;
    if (!a || !a.live()) return engineProvider;
    const free = a.has("gflights") && L.gflights.provider(a.get), paid = a.has("serpapi") && L.serpapi.provider(a.get);
    return free && paid ? L.gflights.fallback(free, paid) : free || paid;
  }
  const engine = () => new L.engine.Engine(provider(), cache);
  async function zones() { if (!L.geo.zonesLoaded()) L.geo.setZones(await loadZones().catch(() => ({}))); }

  function request(body) {
    try { return L.models.searchRequest(body); } catch (e) { if (e instanceof L.models.ValidationError) fail(e.message); throw e; }
  }
  const bestPrice = result => (result.daily.length ? Math.min(...result.daily.map(d => d.cheapest.price)) : null);
  const nextCheck = (result, rechecks) => L.polling.nextCheckTime(result.unpriced.map(u => u.date), rechecks, Date.now() / 1000);
  async function stored(id) { const row = await history.get(id); if (!row) fail("search not found"); return row; }
  async function done(id) { const row = await history.get(id); if (!row || row.status !== "done") fail("search not found or not finished"); return row; }
  async function search(req, onProgress, eng = engine()) {
    await zones();
    try { return await eng.search(req, onProgress); } catch (e) { fail(e.message); }
  }
  async function oneWayOptions(req, o, d, day) {
    try { return await engine().oneWayOptions(req, o, d, day); } catch (e) { fail(e.message); }
  }
  const byListing = (a, b) => (a.priced === b.priced ? a.price - b.price || a.duration_min - b.duration_min : a.priced ? -1 : 1);

  // ------------------------------------------------------------------------------------------- routes
  const routes = [
    ["GET", /^\/api\/config$/, async () => { if (L.account) await L.account.check(); return { ...(await loadConfig()), provider: provider().name }; }],
    ["GET", /^\/api\/rates$/, rates],
    ["GET", /^\/api\/countries$/, countries],
    ["GET", /^\/api\/decide\/health$/, async () => ({ jev_configured: false, decider: "laya", spent: 0 })],
    ["GET", /^\/api\/airline-site$/, async ({ q }) => L.sites.resolve(q.get("code"), q.get("name"))],
    ["POST", /^\/api\/estimate$/, async ({ body }) => engine().estimate(request(body))],
    ["POST", /^\/api\/searches$/, createSearch],
    ["GET", /^\/api\/searches$/, async () => { await history.failInterrupted(running); return history.list(); }],
    ["GET", /^\/api\/searches\/(\w+)$/, async ({ m }) => stored(m[1])],
    ["DELETE", /^\/api\/searches\/(\w+)$/, async ({ m }) => ({ deleted: await history.delete(m[1]) })],
    ["POST", /^\/api\/searches\/(\w+)\/filter$/, filterSearch],
    ["POST", /^\/api\/searches\/(\w+)\/cancel$/, cancelSearch],
    ["POST", /^\/api\/searches\/(\w+)\/recheck$/, recheckSearch],
    ["GET", /^\/api\/searches\/(\w+)\/flights$/, searchFlights],
    ["GET", /^\/api\/searches\/(\w+)\/bagfees$/, bagFees],
    ["GET", /^\/api\/flights$/, flights],
    ["POST", /^\/api\/itinerary\/check$/, checkItinerary],
    ["POST", /^\/api\/roundtrip$/, roundTrip],
    ["POST", /^\/api\/verify$/, verifyTrip],
    ["POST", /^\/api\/explore$/, explore],
    ["POST", /^\/api\/chat\/complete$/, chatTurn],
  ];

  /** fetch()-like entry point: resolves with the route's JSON, or rejects with the error message the server would give. */
  async function handle(path, opts = {}) {
    if (!history) setup();
    const url = new URL(path, "http://local"), method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    for (const [verb, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && verb === method) return fn({ m, body, q: url.searchParams });
    }
    fail(`Not available in the web version: ${method} ${url.pathname}`);
  }

  async function createSearch({ body }) {
    const req = request(body);
    const est = await engine().estimate(req);
    if (est.to_fetch > req.max_api_calls) fail(new L.engine.BudgetExceeded(est.to_fetch, req.max_api_calls).message);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");
    await history.create(id, req);
    running.add(id);
    const eng = engine();
    jobs.set(id, eng);
    (async () => {
      try {
        const result = await search(req, (d, t) => history.progress(id, d, t), eng);
        await history.finish(id, result, bestPrice(result), nextCheck(result, 0));
      } catch (e) {
        await history.fail(id, e.message || String(e));
      } finally { running.delete(id); jobs.delete(id); }
    })();
    return { id };
  }

  /** Stop a running search. */
  async function cancelSearch({ m }) {
    const eng = jobs.get(m[1]);
    if (!eng) fail("this search isn't running");
    eng.cancel();
    return { cancelled: true };
  }

  /** Change a finished search's airline filter in place, recomputed from the flights already saved. */
  async function filterSearch({ m, body }) {
    const row = await done(m[1]);
    const req = request({ ...row.request, airlines_include: body.airlines_include || [], airlines_exclude: body.airlines_exclude || [], stale_ok: true });
    const result = await search(req);
    const kept = { ...req, stale_ok: false };
    await history.patch(m[1], { request: kept, result, best_price: bestPrice(result),
      next_check: nextCheck(result, row.rechecks), updated: Date.now() / 1000 });
    return history.get(m[1]);
  }

  /** Ask again about flights that had no price; returns how many were unpriced before and after. */
  async function recheckSearch({ m }) {
    const row = await done(m[1]);
    if (running.has(m[1])) fail("a recheck is already running for this search");
    running.add(m[1]);
    try {
      const before = (row.result.unpriced || []).length;
      const result = await search(request({ ...row.request, refresh_unpriced: true }));
      const rechecks = row.rechecks + 1;
      await history.patch(m[1], { result, best_price: bestPrice(result), next_check: nextCheck(result, rechecks), rechecks, updated: Date.now() / 1000 });
      return { changed: { before, after: result.unpriced.length }, search: await history.get(m[1]) };
    } finally { running.delete(m[1]); }
  }

  async function searchFlights({ m, q }) {
    const req = request((await stored(m[1])).request);
    const o = (q.get("origin") || "").toUpperCase(), d = (q.get("dest") || "").toUpperCase(), day = q.get("date");
    const offers = await oneWayOptions(req, o, d, day);
    const kept = q.get("all") === "1" || q.get("all") === "true" ? offers : offers.filter(x => L.engine.airlineOk(req, x));
    return { origin: o, dest: d, date: day, travellers: L.models.paxLabel(req), currency: req.currency, bags: L.models.bagsLabel(req),
      hidden_by_filter: offers.length - kept.length, filter: { include: req.airlines_include, exclude: req.airlines_exclude },
      flights: kept.map(L.models.legView).sort(byListing).slice(0, 60) };
  }

  /** Fee for one cabin and one checked bag per flight: the fare with the bag minus the fare without it. */
  async function bagFees({ m, q }) {
    const base = request({ ...(await stored(m[1])).request, carry_on_bags: 0, checked_bags: 0 });
    const o = (q.get("origin") || "").toUpperCase(), d = (q.get("dest") || "").toUpperCase(), day = q.get("date");
    const plain = await oneWayOptions(base, o, d, day);
    const cabin = await oneWayOptions({ ...base, carry_on_bags: 1 }, o, d, day);
    const hold = await oneWayOptions({ ...base, checked_bags: 1 }, o, d, day);
    const price = offers => new Map(offers.filter(x => x.priced).map(x => [L.models.label(x), x.price]));
    const b = price(plain), c = price(cabin), h = price(hold), fees = {};
    for (const [label, p] of b) {
      fees[label] = { cabin: c.has(label) ? L.models.round2(c.get(label) - p) : null, checked: h.has(label) ? L.models.round2(h.get(label) - p) : null };
    }
    const available = Object.values(fees).some(f => (f.cabin || 0) > 0 || (f.checked || 0) > 0);
    const notes = (await loadConfig()).bag_notes || {};
    const codes = [...new Set(plain.flatMap(x => x.segments.map(s => s.airline_code)))].sort();
    return { available, fees, currency: base.currency, notes: Object.fromEntries(codes.filter(c => c in notes).map(c => [c, notes[c]])) };
  }

  /** All one-way flights for one route and day, cheapest first (for the trip builder). */
  async function flights({ q }) {
    const day = q.get("date"), int = k => (q.has(k) ? Number(q.get(k)) : undefined);
    const req = request({ origin: q.get("origin") || "", destinations: [q.get("dest") || ""], window_start: day,
      window_end: day && L.models.addDays(day, 1), min_nights: 1, max_nights: 1, adults: int("adults") ?? 1,
      children_ages: (q.get("children_ages") || "").replace(/,/g, " ").split(/\s+/).filter(Boolean).map(Number),
      currency: q.get("currency") || "USD", max_stops_per_leg: int("max_stops") ?? 2 });
    const offers = await oneWayOptions(req, req.origin, req.destinations[0], day);
    return { origin: req.origin, dest: req.destinations[0], date: day, travellers: L.models.paxLabel(req), currency: req.currency,
      flights: offers.map(L.models.legView).sort(byListing).slice(0, 40) };
  }

  async function checkItinerary({ body }) {
    if (!body.legs || !body.legs.length || body.legs.some(l => !l.segments || !l.segments.length)) fail("every leg needs at least one flight segment");
    await zones();
    return L.itinerary.analyse(body.legs, body.currency || "USD");
  }

  /** Google's cheapest return ticket for the trip's dates, through the Worker's free /gflights. */
  async function roundTrip({ body }) {
    const a = L.account;
    if (!(a && a.live() && a.has("gflights"))) fail("round-trip prices come from Google Flights: sign in for real fares");
    const req = request(body.request), p = L.models.pax(req);
    const q = new URLSearchParams({ origin: body.origin, dest: body.dest, date: body.date, return_date: body.return_date, currency: req.currency,
      adults: p.adults, children: p.children, infants: p.infants, max_stops: req.max_stops_per_leg, carry_on_bags: req.carry_on_bags, checked_bags: req.checked_bags });
    let r;
    try { r = await a.get(`/gflights?${q}`); } catch (e) { fail(e.message); }
    const prices = L.gflights.parse(r.groups, body.origin, body.dest, req.currency, r.url).filter(o => o.priced).map(o => o.price);
    return { price: prices.length ? Math.min(...prices) : null, flights: r.groups.length, url: r.url };
  }

  /** The trip's flights looked up again on the other fare source the Worker has (verify.js). */
  async function verifyTrip({ body }) {
    const a = L.account, legs = body.legs || [];
    const available = a && a.live() ? ["gflights", "serpapi"].filter(n => a.has(n)) : [];
    const source = L.verify.secondSource(available, legs);
    if (!source) fail(available.length ? `checking a price needs a second fare source, and this site only has ${available.join(", ")}` : "checking a price needs real fares: sign in");
    const req = request(body.request), cities = (await loadConfig()).city_airports || {};
    const eng = new L.engine.Engine(source === "gflights" ? L.gflights.provider(a.get) : L.serpapi.provider(a.get), null);  // no cache: ask now
    const found = {}, errors = {};
    for (const k of L.verify.lookups(legs, cities)) {
      const [o, d, day] = k.split("|");
      try { found[k] = await eng.oneWayOptions(req, o, d, day); } catch (e) { errors[k] = e.message || String(e); }
    }
    const results = legs.map(l => L.verify.judge(l, found, errors, source, cities));
    return { source, status: L.verify.worst(results), legs: results, checked_at: Date.now() / 1000 };
  }

  /** One model turn for the AI chat (chat.js), through the Worker: it holds the OpenRouter key. */
  async function chatTurn({ body }) {
    if (!(L.account && L.account.signedIn())) fail("Sign in with Google to chat with Skyhop");
    try {
      return await L.account.get("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) { fail(e.message); }
  }

  async function rates() {
    try {
      const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=ILS,GBP,EUR");
      if (!r.ok) throw new Error(`frankfurter.dev answered ${r.status}`);
      const j = await r.json();
      return { base: "USD", rates: { USD: 1.0, ...j.rates }, date: j.date || null, source: "ECB via frankfurter.dev" };
    } catch (e) {     // no guessed rates, the page keeps prices as searched
      return { base: "USD", rates: {}, date: null, source: null, error: `live exchange rates unavailable: ${e.message}` };
    }
  }

  /** country -> [[iata, name, rank]], rank 1 = well-known; only airports with scheduled flights when the country has
      any, and city groups (rank 2) left out. */
  async function byCountry() {
    const out = new Map();
    for (const [iata, , name, country, rank, , service] of await loadAirports()) {
      if (rank === 2) continue;
      if (!out.has(country)) out.set(country, []);
      out.get(country).push([iata, name, rank, service]);
    }
    for (const [c, list] of out) out.set(c, list.filter(a => a[3] || !list.some(x => x[3])).map(a => a.slice(0, 3)));
    return out;
  }
  async function countries() {
    return [...(await byCountry())].map(([name, a]) => ({ name, airports: a.length })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Which airlines fly between the origin and a country's airports (or the given airports)? */
  async function explore({ body }) {
    const M = L.models, started = Date.now();
    let airports = (body.airports || []).map(a => a.trim().toUpperCase()).filter(Boolean), trimmed = false;
    if (body.country && !airports.length) {
      const list = [...(await byCountry())].find(([name]) => name.toLowerCase() === body.country.trim().toLowerCase());
      const codes = list ? list[1] : [];
      airports = codes.length <= 60 ? codes.map(a => a[0]) : codes.filter(a => a[2] === 1).slice(0, 60).map(a => a[0]);
      trimmed = codes.length > 60;
      if (!airports.length) fail(`No airports found for country '${body.country}'. Check the spelling, or list airports instead.`);
    }
    if (!airports.length) fail("Give a country or at least one airport.");
    const direction = body.direction || "to";
    if (!["to", "from"].includes(direction)) fail("direction must be 'to' or 'from'");
    const first = body.date, extra = body.extra_days || [2, 5];
    const req = request({ origin: body.origin || "TLV", destinations: airports.slice(0, 1), window_start: first,
      window_end: first && M.addDays(first, 1), min_nights: 1, max_nights: 1, adults: body.adults ?? 1,
      currency: body.currency || "ILS", max_stops_per_leg: 2, max_api_calls: 400 });
    const origin = req.origin, eng = engine();
    const key = (ap, d) => (direction === "to" ? `${origin}|${ap}|${d}` : `${ap}|${origin}|${d}`);
    let raw;
    try { [raw] = await eng.prefetch(req, new Set(airports.map(ap => key(ap, first)))); } catch (e) { fail(e.message); }
    const active = airports.filter(ap => (raw.get(key(ap, first)) || []).length);
    const days = [first, ...extra.map(n => M.addDays(first, n))];
    if (active.length && extra.length) {
      try {
        const [more] = await eng.prefetch(req, new Set(active.flatMap(ap => days.slice(1).map(d => key(ap, d)))));
        for (const [k, v] of more) raw.set(k, v);
      } catch (e) { fail(e.message); }
    }

    const agg = new Map();
    for (const [k, offers] of raw) {
      const [o, d, dy] = k.split("|"), ap = direction === "to" ? d : o;
      for (const off of offers) {
        for (const code of new Set(off.segments.map(s => s.airline_code))) {
          if (!agg.has(code)) agg.set(code, { name: "", routes: new Map() });
          const a = agg.get(code);
          a.name = a.name || off.segments.find(s => s.airline_code === code).airline || code;
          if (!a.routes.has(ap)) a.routes.set(ap, { nonstop: false, dates: new Set(), cheapest: null, flights: new Set() });
          const r = a.routes.get(ap);
          r.nonstop = r.nonstop || M.stops(off) === 0;
          r.dates.add(dy);
          if (off.priced) r.cheapest = r.cheapest === null ? off.price : Math.min(r.cheapest, off.price);
          r.flights.add(off.segments.filter(s => s.airline_code === code).map(s => `${s.airline_code}${s.flight_number}`).join("+"));
        }
      }
    }
    const airlines = [...agg].map(([code, a]) => {
      const routes = [...a.routes].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([ap, r]) => ({ airport: ap, nonstop: r.nonstop,
        dates: [...r.dates].sort(), cheapest: r.cheapest, flights: [...r.flights].sort().slice(0, 4) }));
      return { code, name: a.name, nonstop_airports: routes.filter(r => r.nonstop).length, routes };
    });
    airlines.sort((a, b) => b.nonstop_airports - a.nonstop_airports || b.routes.length - a.routes.length
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.code < b.code ? -1 : 1));
    return { origin, direction, airports_checked: airports, airports_with_flights: active, dates: days, airlines, trimmed,
      currency: req.currency, api_calls: eng.apiCalls, cache_hits: eng.cacheHits, elapsed_s: Math.round((Date.now() - started) / 100) / 10 };
  }

  L.backend = { setup, handle, HttpError };
  if (typeof module !== "undefined" && module.exports) module.exports = L.backend;
})(typeof window !== "undefined" ? window : globalThis);
