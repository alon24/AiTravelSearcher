// The search engine (local/engine.js) on fake providers: date pairs, route shapes, filters, composition, ranking,
// the offer cache and the warnings a search returns. Never touches the network.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, M, at, seg, offer, fake, req, search, sleep } = require("./skyhop");

const dayNo = day => Number(day.slice(8));
const trips = res => res.daily.flatMap(d => [d.cheapest, d.best_value]);
const connecting = (o, d, dep, price, layover, code = "LY") =>
  M.offer({ origin: o, destination: d, price, currency: "USD", segments: [seg(o, "IST", dep, 120, code), seg("IST", d, M.addMinutes(dep, 120 + layover), 120, code)] });

test("date pairs stay inside the window and the nights range", async () => {
  const res = await search(fake((o, d, day) => [offer(o, d, at(day), 100)]));
  for (const { cheapest: t } of res.daily) {
    const n = M.daysBetween(t.depart_date, t.return_date);
    assert.ok(n >= 3 && n <= 4 && t.return_date <= "2026-10-10", JSON.stringify(t));
  }
  assert.equal(res.daily[0].depart_date, "2026-10-01");
  assert.equal(res.daily.at(-1).depart_date, "2026-10-07");      // 7 + 3 = 10 is the last valid return
});

// mixed W6 out + LY back = 50 + 40 = 90; the best single airline is W6 both ways = 130
const twoAirlines = (o, d, day) => [offer(o, d, at(day), o === "TLV" ? 50 : 80, "W6"), offer(o, d, at(day, 12), o === "TLV" ? 90 : 40, "LY")];

test("mixed airlines: the cheapest trip picks each direction on its own", async () => {
  const t = (await search(fake(twoAirlines))).daily[0].cheapest;
  assert.equal(t.price, 90);
  assert.deepEqual(t.airlines, ["W6", "LY"]);
  assert.ok(t.warnings.some(w => w.includes("different airlines")));
});

test("same airline both ways costs more when mixing is off", async () => {
  assert.equal((await search(fake(twoAirlines))).daily[0].cheapest.price, 90);
  const t = (await search(fake(twoAirlines), { allow_mixed_airlines: false })).daily[0].cheapest;
  assert.equal(t.price, 130);
  assert.deepEqual(t.airlines, ["W6"]);
});

test("open-jaw trips are built and can win, unless turned off", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), o === "BRU" && d === "TLV" ? 30 : 100)]);
  const t = (await search(p, { destinations: ["PAR"], return_airports: ["BRU"] })).daily[0].cheapest;
  assert.deepEqual([t.kind, t.destination, t.price], ["open_jaw", "PAR→BRU", 130]);
  const off = await search(p, { destinations: ["PAR"], return_airports: ["BRU"], open_jaw: false });
  assert.equal(off.daily[0].cheapest.kind, "round_trip");
});

test("connecting destinations makes a multi-stop trip that can beat two round trips", async () => {
  const prices = { "TLV|PAR": 50, "LON|TLV": 50, "PAR|TLV": 200, "TLV|LON": 200 };
  const p = fake((o, d, day) => [offer(o, d, at(day), prices[`${o}|${d}`] ?? ([o, d].sort().join() === "LON,PAR" ? 20 : 999))]);
  const r = { destinations: ["PAR", "LON"], open_jaw: false, min_nights: 4, max_nights: 4 };
  const off = (await search(p, r)).daily[0].cheapest;
  assert.deepEqual([off.kind, off.price], ["round_trip", 250]);
  const on = (await search(p, { ...r, connect_destinations: true })).daily[0].cheapest;
  assert.deepEqual([on.kind, on.destination, on.price], ["multi_stop", "PAR+LON", 120]);
  assert.deepEqual(on.legs.map(l => [l.origin, l.destination]), [["TLV", "PAR"], ["PAR", "LON"], ["LON", "TLV"]]);
});

test("layover, travel-time and direct-only filters drop flights", async () => {
  // 1 stop: a 60 min layover (too short) at 10, a 120 min one at 60
  const p = fake((o, d, day) => [connecting(o, d, at(day), 10, 60), connecting(o, d, at(day), 60, 120)]);
  assert.equal((await search(p)).daily[0].cheapest.price, 120);       // only the 120 min layovers survive
  const capped = await search(p, { max_travel_min_per_direction: 200 });
  assert.deepEqual(capped.daily, []);
  assert.ok(capped.warnings.some(w => w.includes("No itinerary")));
  assert.deepEqual((await search(p, { allow_connections: false })).daily, []);
});

test("self-transfer bundles keep the buffer, sum their CO2 and warn", async () => {
  const co2 = { co2_g: 90000, co2_typical_g: 100000 };
  const p = fake((o, d, day) => {
    if ([o, d].sort().join() === "ROM,TLV") return [];                                     // no through offer at all
    const kept = o === "IST" && d === "TLV" ? {} : co2;                                      // one ticket without Google's CO2
    if (d === "IST" || (o === "IST" && d === "TLV")) return [offer(o, d, at(day, 8), 40, "LY", kept)];
    if ([o, d].sort().join() === "IST,ROM") {
      return [offer(o, d, at(day, 9), 30, "LY", kept),        // leaves before the 8:00 + 3h flight lands: invalid
        offer(o, d, at(day, 16), 35, "LY", kept)];             // a 5h gap clears the 4h buffer
    }
    return [];
  });
  const t = (await search(p, { allow_self_transfer: true, self_transfer_hubs: ["IST"] })).daily[0].cheapest;
  assert.equal(t.self_transfer, true);
  assert.equal(t.price, 150);
  // a bundle's CO2 is the sum of its tickets, and unknown when any ticket's is
  assert.deepEqual([t.legs[0].co2_g, t.legs[0].co2_typical_g], [180000, 200000]);
  assert.deepEqual([t.legs[1].co2_g, t.legs[1].co2_typical_g], [null, null]);
  assert.ok(t.warnings.some(w => w.includes("SELF-TRANSFER") && w.includes("IST")));
  const strict = await search(p, { allow_self_transfer: true, self_transfer_hubs: ["IST"], self_transfer_buffer_min: 30 * 60 });
  assert.deepEqual(strict.daily, []);
});

test("best value prefers a slightly dearer direct flight to an 18-hour layover", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), 110), connecting(o, d, at(day, 6), 100, 18 * 60)]);
  const d = (await search(p, { max_layover_min: 24 * 60 })).daily[0];
  assert.equal(d.cheapest.stops, 2);
  assert.equal(d.best_value.stops, 0);
});

test("a second search is served from the cache, and an over-budget search refuses to start", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), 100)]);
  const engine = new L.engine.Engine(p, new L.db.OfferCache());
  const first = await engine.search(req());
  const n = p.calls.length;
  const second = await engine.search(req());
  assert.equal(p.calls.length, n);
  assert.equal(second.cache_hits, first.api_calls);
  assert.equal(second.api_calls, 0);
  await assert.rejects(search(fake(() => []), { max_api_calls: 3 }), L.engine.BudgetExceeded);
});

test("a failing lookup becomes a warning, not a failed search", async () => {
  const p = fake((o, d, day) => { if (day === "2026-10-02") throw new Error("boom"); return [offer(o, d, at(day), 100)]; });
  const res = await search(p);
  assert.ok(res.daily.length);
  assert.ok(res.warnings.some(w => w.includes("failed")));
});

test("no flights anywhere warns and caches nothing", async () => {
  const cache = new L.db.OfferCache();
  const res = await search(fake(() => []), {}, cache);
  assert.ok(res.warnings.some(w => w.includes("no flights for ANY route")));
  assert.equal((await cache.offers.values()).length, 0);
});

test("a backup provider's answers are counted and explained", async () => {
  const boom = { name: "boom", oneWay: async () => { throw new Error("blocked"); } };
  const backup = fake((o, d, day) => [offer(o, d, at(day), 99)]);
  const got = await L.gflights.fallback(boom, backup).oneWay("TLV", "ROM", "2026-10-05", { currency: "USD", adults: 1, maxStops: 1 });
  assert.equal(got[0].price, 99);
  assert.equal(got.source, "fake");
  assert.equal(got.fallback, "boom failed (blocked), so fake answered");
  const r = await search(L.gflights.fallback(boom, backup));
  assert.deepEqual(r.sources, { fake: r.api_calls });
  assert.ok(r.elapsed_s >= 0);
  assert.ok(r.warnings.some(w => w.startsWith(`${r.api_calls} lookup(s) used the backup provider; first: boom failed (blocked)`)),
    "a lookup answered by the backup (maybe paid) always says why");
  await assert.rejects(L.gflights.fallback(boom, boom).oneWay("TLV", "ROM", "2026-10-05", { currency: "USD", adults: 1, maxStops: 1 }),
    /^Error: boom: blocked; boom: blocked$/);
});

test("cancel stops a running search and keeps what it fetched", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), 100)]);
  const slow = { name: "slow", oneWay: async (...a) => { await sleep(20); return p.oneWay(...a); } };
  const cache = new L.db.OfferCache(), r = req({ window_end: "2026-10-20", max_api_calls: 500 });
  const engine = new L.engine.Engine(slow, cache, 1);
  const running = engine.search(r);
  await sleep(150);
  engine.cancel();
  await assert.rejects(running, /^Error: Cancelled\. Fares fetched before you stopped are saved/);
  const made = p.calls.length, { lookups, cached } = await new L.engine.Engine(slow, cache).estimate(r);
  assert.ok(made > 0 && made < lookups, "it stopped part way");
  await sleep(60);
  assert.equal(p.calls.length, made, "no lookups after Cancel");
  assert.ok(cached >= made - 1, "what it fetched is reused");
});

test("the engine passes travellers to the provider and caches each group apart", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), 100)]);
  const engine = new L.engine.Engine(p, new L.db.OfferCache());
  await engine.search(req({ adults: 2, children_ages: [0, 6] }));
  assert.deepEqual(p.opts, { currency: "USD", adults: 2, children: 1, infants: 1, maxStops: 1, carryOnBags: 0, checkedBags: 0 });
  const n = p.calls.length;
  await engine.search(req({ adults: 2, children_ages: [0, 6] }));
  assert.equal(p.calls.length, n);                                   // same travellers: cached
  const res = await engine.search(req({ adults: 2 }));                // different travellers must not reuse that cache
  assert.ok(p.calls.length > n && res.api_calls > 0);
  const kids = await engine.search(req({ adults: 2, children_ages: [0, 6] }));
  assert.ok(kids.warnings.some(w => w.toLowerCase().includes("infant")));
  assert.ok(kids.warnings.some(w => w.includes("totals for 2 adults, children aged 0, 6")));
});

test("bags reach the provider, have their own cache entries and are named in a warning", async () => {
  const seen = [];
  const p = { name: "p", oneWay: async (o, d, day, { carryOnBags, checkedBags }) => {
    seen.push([carryOnBags, checkedBags]);
    return [offer(o, d, at(day, 9), 50 + 48 * carryOnBags + 30 * checkedBags, "FR")];
  } };
  const engine = new L.engine.Engine(p, new L.db.OfferCache());
  const base = { window_end: "2026-10-06", min_nights: 4, max_nights: 4 };
  const r0 = await engine.search(req(base)), r1 = await engine.search(req({ ...base, carry_on_bags: 1 }));
  assert.equal(r0.daily[0].cheapest.price, 100);
  assert.equal(r1.daily[0].cheapest.price, 196);                     // 2 x (50 + 48): a separate cache entry
  assert.ok(seen.some(s => s.join() === "0,0") && seen.some(s => s.join() === "1,0"));
  assert.ok(r1.warnings.some(w => w.includes("estimated fees for 1 cabin bag")));
  assert.ok(!r0.warnings.some(w => w.includes("estimated fees")));
});

// a real W4 fare, and HiSky's H4236 that Google lists without a price
const hisky = (o, d, day, price = 0) =>
  M.offer({ origin: o, destination: d, price, currency: "USD", priced: price > 0, segments: [seg(o, d, M.addMinutes(at(day, 14), 50), 150, "H4", "236")] });

test("unpriced flights are listed but never ranked or counted as fares", async () => {
  const res = await search(fake((o, d, day) => [offer(o, d, at(day), 100, "W4"), hisky(o, d, day)]), {}, new L.db.OfferCache());
  assert.ok(res.daily.length && trips(res).every(t => t.airlines.join() === "W4"));       // never a trip
  const hi = res.airlines.find(a => a.code === "H4");
  assert.equal(hi.cheapest, null);                                                        // "flies here", no fare
  assert.ok(hi.no_price_routes.length && hi.offers > 0);
  assert.equal(res.airlines.find(a => a.code === "W4").cheapest, 100);
  assert.equal(res.unpriced[0].flights, "H4236");
  assert.ok(["TLV", "ROM"].includes(res.unpriced[0].origin));
});

test("a recheck refetches cached results that had no price, but not priced ones", async () => {
  let n = 0;
  const p = fake((o, d, day) => { n++; return [offer(o, d, at(day), 100, "W4"), hisky(o, d, day, n > 2 ? 505 : 0)]; });
  const engine = new L.engine.Engine(p, new L.db.OfferCache());
  const first = await engine.search(req());
  assert.ok(first.unpriced.length);
  assert.equal(n, first.api_calls);
  const n1 = n;
  assert.ok((await engine.search(req())).unpriced.length);
  assert.equal(n, n1);                                                    // a normal search: served from the cache
  const again = await engine.search(req({ refresh_unpriced: true }));
  assert.ok(n > n1);
  assert.deepEqual(again.unpriced, []);                                   // the recheck found the fare
  const n2 = n;
  await engine.search(req({ refresh_unpriced: true }));
  assert.equal(n, n2);                                                    // nothing unpriced left: the cache is used again
});

test("the last fare seen is remembered when Google drops it", async () => {
  let priced = true;
  const p = fake((o, d, day) => [offer(o, d, at(day), 100, "W4"), hisky(o, d, day, priced ? 505 : 0)]);
  const cache = new L.db.OfferCache(), engine = new L.engine.Engine(p, cache);
  assert.deepEqual((await engine.search(req())).unpriced, []);           // priced at first
  priced = false;                                                          // later Google shows no fare for the same flight
  cache.offers = new L.db.Store("offers");                                 // the fares expired
  const later = await engine.search(req());
  assert.ok(later.unpriced.length);
  assert.ok(later.unpriced.every(u => u.last_price === 505 && u.last_seen > 0));
});

test("airline filters apply after fetching, cost no lookups, and the airline list says who flies where", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), 50, "FR"), offer(o, d, at(day, 12), 90, "LY"), connecting(o, d, at(day, 6), 70, 180, "TK")]);
  const engine = new L.engine.Engine(p, new L.db.OfferCache());
  const run = over => engine.search(req({ max_stops_per_leg: 1, ...over }));
  const base = await run();
  assert.deepEqual([base.daily[0].cheapest.price, base.daily[0].cheapest.airlines], [100, ["FR"]]);
  const calls = p.calls.length;
  const noFr = await run({ airlines_exclude: ["fr"] });
  assert.equal(p.calls.length, calls);
  assert.equal(noFr.api_calls, 0);
  assert.deepEqual([noFr.daily[0].cheapest.price, noFr.daily[0].cheapest.airlines], [140, ["TK"]]);
  const onlyLy = await run({ airlines_include: ["LY"] });
  assert.deepEqual([onlyLy.daily[0].cheapest.price, onlyLy.daily[0].cheapest.airlines], [180, ["LY"]]);
  const none = await run({ airlines_include: ["XX"] });
  assert.deepEqual(none.daily, []);
  assert.ok(none.warnings.some(w => w.includes("No itinerary")));
  // the airline list is unfiltered, says who flies which direction, and flags what the filter removed
  const by = Object.fromEntries(noFr.airlines.map(a => [a.code, a]));
  assert.deepEqual(Object.keys(by).sort(), ["FR", "LY", "TK"]);
  assert.deepEqual([by.FR.included, by.TK.included, by.FR.cheapest], [false, true, 50]);
  assert.deepEqual(by.FR.nonstop, ["ROM>TLV", "TLV>ROM"]);
  assert.deepEqual(by.TK.nonstop, []);
  assert.deepEqual(by.TK.routes, ["ROM>TLV", "TLV>ROM"]);
});

test("cells give the cheapest trip for every destination and length", async () => {
  // later days cost a little more, so the earliest dates win; Rome is cheaper than Paris
  const base = { FCO: 100, ROM: 100, CDG: 150, PAR: 150 };
  const p = fake((o, d, day) => [offer(o, d, at(day), (base[o === "TLV" ? d : o] ?? 100) + dayNo(day))]);
  const res = await search(p, { destinations: ["ROM", "PAR"], open_jaw: false, min_nights: 4, max_nights: 6, window_end: "2026-10-12" });
  const got = Object.fromEntries(res.cells.map(c => [`${c.destination}${c.nights}`, c]));
  assert.deepEqual(Object.keys(got).sort(), ["PAR4", "PAR5", "PAR6", "ROM4", "ROM5", "ROM6"]);      // 2 destinations x 3 lengths
  for (const c of res.cells) {
    assert.deepEqual([c.cheapest.destination, c.cheapest.nights, c.cheapest.depart_date], [c.destination, c.nights, "2026-10-01"]);
    assert.ok(c.trips >= 1);
  }
  for (const n of [4, 5, 6]) assert.ok(got[`ROM${n}`].cheapest.price < got[`PAR${n}`].cheapest.price);
  assert.deepEqual(res.cells.map(c => c.nights), [4, 4, 5, 5, 6, 6]);                             // sent ordered by nights
});

test("cells stop at 300, keeping the cheapest", async () => {
  const cheap = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];          // 10 x 30 lengths = 300 cells
  const p = fake((o, d, day) => [offer(o, d, at(day), (o === "XXX" || d === "XXX" ? 900 : 100) + dayNo(day))]);
  const res = await search(p, { destinations: [...cheap, "XXX"], open_jaw: false, min_nights: 1, max_nights: 30,
    window_end: "2026-11-01", max_api_calls: 1000 });
  assert.equal(res.cells.length, 300);
  assert.ok(res.cells.every(c => c.destination !== "XXX"));
  assert.deepEqual(res.cells.map(c => c.nights), res.cells.map(c => c.nights).sort((a, b) => a - b));
});

test("an open-jaw trip names the airport transfer; a same-airport round trip stays quiet", async () => {
  const p = fake((o, d, day) => [offer(o, d, at(day), [o, d].includes("CIA") ? 90 : 100, "W4")]);
  const r = { destinations: ["FCO"], window_end: "2026-10-06", min_nights: 4, max_nights: 4 };
  const oj = (await search(p, { ...r, return_airports: ["CIA"] })).daily.map(d => d.cheapest).find(t => t.kind === "open_jaw");
  assert.ok(oj.warnings.some(w => w.includes("landing at FCO and leaving from CIA") && w.includes("about 60 min")));
  const plain = await search(p, r);
  assert.ok(trips(plain).every(t => t.kind === "round_trip" && !t.warnings.some(w => w.includes("min"))));
});

test("cache entries expire one by one, and unpriced or near-term results sooner", async () => {
  const cache = new L.db.OfferCache(6);
  await cache.put("a", [], -1); await cache.put("b", [], 60); await cache.put("old", []);
  assert.deepEqual([await cache.has("a"), await cache.getEntry("a"), await cache.has("b"), await cache.has("old")], [false, null, true, true]);
  const e = new L.engine.Engine(fake(() => []), cache), today = M.today();
  const soon = M.addDays(today, 5), later = M.addDays(today, 100);
  const unp = M.offer({ origin: "TLV", destination: "OTP", price: 0, currency: "USD", priced: false, segments: [seg("TLV", "OTP", at(soon), 150, "H4")] });
  const ok = offer("TLV", "OTP", at(soon), 100);
  assert.equal(e.ttlFor(soon, [unp]), 900);                            // "no price" is not kept for 6 hours
  assert.equal(e.ttlFor(later, [unp]), 3 * 3600);
  assert.equal(e.ttlFor(soon, [ok]), 3 * 3600);
  assert.equal(e.ttlFor(later, [ok]), 6 * 3600);
});
