// The /api routes as the Pages build answers them inside the page (local/backend.js): searches and their history,
// filters, rechecks, the trip builder's flight lists, bag fees, the airline finder, exchange rates and price checks.
// fetch() is answered from the repo's files, as the page fetches them next to itself.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, at, seg, offer, fake, read, sleep } = require("./skyhop");

const FILES = { "config.json": ["src", "flightagent", "data", "config.json"], "airports.json": ["src", "flightagent", "web", "airports.json"] };
let online = async url => { throw new Error(`unexpected fetch ${url}`); };
globalThis.fetch = async url => (url in FILES ? { ok: true, json: async () => read(...FILES[url]) } : online(url));

const api = (path, body, method = body === undefined ? "GET" : "POST") => L.backend.handle(path, { method, body: body && JSON.stringify(body) });
async function finished(id) {
  for (let i = 0; i < 500; i++) {
    const row = await api(`/api/searches/${id}`);
    if (row.status !== "running") return row;
    await sleep(10);
  }
  throw new Error(`search ${id} never finished`);
}
const searchDone = async body => { const { id } = await api("/api/searches", body); return [id, await finished(id)]; };
const ROME = { destinations: ["ROM"], window_start: "2026-10-01", window_end: "2026-10-08", min_nights: 3, max_nights: 3 };
const codes = f => [...new Set(f.segments.map(s => s.airline_code))];

test("a search runs in the background, is listed light, served from the cache next time and can be deleted", async () => {
  L.backend.setup();
  const body = { destinations: ["ROM", "PAR"], window_start: "2026-10-01", window_end: "2026-10-10", min_nights: 3, max_nights: 4 };
  const est = await api("/api/estimate", body);
  assert.ok(est.lookups > 0);
  assert.deepEqual([est.cached, est.to_fetch], [0, est.lookups]);
  await assert.rejects(api("/api/searches", { ...body, max_api_calls: 3 }), /max_api_calls=3/);
  const [id, row] = await searchDone(body);
  assert.equal(row.status, "done");
  assert.ok(row.result.daily.length && row.best_price > 0);
  assert.deepEqual([row.progress.done, row.progress.total], [est.lookups, est.lookups]);
  assert.equal((await api("/api/estimate", body)).to_fetch, 0);                           // now cached
  const list = await api("/api/searches");
  assert.deepEqual(list.map(r => r.id), [id]);
  assert.ok(!("result" in list[0]));                                                      // the list stays light
  assert.deepEqual(await api(`/api/searches/${id}`, undefined, "DELETE"), { deleted: true });
  await assert.rejects(api(`/api/searches/${id}`), /search not found/);
});

test("a finished search with every fare priced has nothing to recheck, and a manual recheck counts", async () => {
  L.backend.setup();
  const [id, row] = await searchDone(ROME);
  assert.deepEqual([row.status, row.next_check, row.rechecks], ["done", null, 0]);         // nothing unpriced: nothing to poll
  const r = await api(`/api/searches/${id}/recheck`, {});
  assert.deepEqual(r.changed, { before: 0, after: 0 });
  assert.equal(r.search.rechecks, 1);
  assert.ok(r.search.result.daily.length);
  await assert.rejects(api("/api/searches/nope/recheck", {}), /search not found/);
});

test("changing a finished search's airline filter is instant and works from expired fares", async () => {
  L.backend.setup();
  const [id, row] = await searchDone(ROME);
  const airlines = row.result.airlines.map(a => a.code), drop = airlines[0];
  assert.ok(airlines.length >= 2);
  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 3600 * 1000;                                          // every saved fare has expired
  try {
    const r = await api(`/api/searches/${id}/filter`, { airlines_exclude: [drop] });
    assert.deepEqual([r.request.airlines_exclude, r.request.stale_ok], [[drop], false]);
    assert.equal(r.result.api_calls, 0);                                                   // no lookups, and it says how old the data is
    assert.ok(r.result.cache_hits > 0 && r.result.data_from);
    assert.ok(r.result.daily.every(d => !d.cheapest.airlines.includes(drop) && !d.best_value.airlines.includes(drop)));
    assert.equal(r.result.airlines.find(a => a.code === drop).included, false);
    assert.equal((await api("/api/searches")).length, 1);                                 // the same history entry, not a new one
    const back = await api(`/api/searches/${id}/filter`, {});
    assert.deepEqual(back.request.airlines_exclude, []);
    assert.ok(back.result.airlines.every(a => a.included));
    await assert.rejects(api("/api/searches/nope/filter", {}), /search not found/);
  } finally { Date.now = realNow; }
});

test("a search's flight list is sorted by price and its bag fees come from the fares with bags", async () => {
  L.backend.setup();
  const [id] = await searchDone(ROME);
  const q = "origin=TLV&dest=ROM&date=2026-10-02";
  const r = await api(`/api/searches/${id}/flights?${q}`);
  assert.ok(r.flights.length);
  assert.equal(r.bags, "");
  assert.deepEqual(r.flights.map(f => f.price), r.flights.map(f => f.price).sort((a, b) => a - b));
  const fees = await api(`/api/searches/${id}/bagfees?${q}`);
  assert.deepEqual(Object.keys(fees).sort(), ["available", "currency", "fees", "notes"]);
  assert.ok(Object.keys(fees.fees).length);
  const charges = label => ["FR", "W6", "U2"].includes(label.split("+")[0].slice(0, 2));   // the demo charges bags only on these
  for (const [label, f] of Object.entries(fees.fees)) assert.equal(f.cabin || 0, charges(label) ? 25 : 0, label);
  assert.equal(fees.available, Object.keys(fees.fees).some(charges));
  await assert.rejects(api(`/api/searches/nope/flights?${q}`), /search not found/);
});

test("a search's flight list obeys its airline filter unless all flights are asked for", async () => {
  L.backend.setup();
  const q = "origin=TLV&dest=ROM&date=2026-10-02";
  const [all] = await searchDone(ROME);
  const everything = await api(`/api/searches/${all}/flights?${q}`);
  assert.ok(new Set(everything.flights.flatMap(codes)).size >= 2);
  assert.equal(everything.hidden_by_filter, 0);
  const keep = codes(everything.flights.find(f => codes(f).length === 1))[0];
  const [some] = await searchDone({ ...ROME, airlines_include: [keep] });
  const filtered = await api(`/api/searches/${some}/flights?${q}`);
  assert.ok(filtered.flights.length && filtered.flights.every(f => codes(f).join() === keep));
  assert.equal(filtered.hidden_by_filter, everything.flights.length - filtered.flights.length);
  assert.ok(filtered.hidden_by_filter > 0);
  assert.deepEqual(filtered.filter, { include: [keep], exclude: [] });
  const again = await api(`/api/searches/${some}/flights?${q}&all=1`);
  assert.deepEqual([again.flights.length, again.hidden_by_filter], [everything.flights.length, 0]);
});

test("the trip builder lists one route's flights and checks the connections between them", async () => {
  L.backend.setup();
  const r = await api("/api/flights?origin=tlv&dest=ROM&date=2026-10-12&adults=2&children_ages=5");
  const prices = r.flights.map(f => f.price);
  assert.deepEqual([r.origin, r.travellers], ["TLV", "2 adults, children aged 5"]);
  assert.ok(prices.length);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  await assert.rejects(api("/api/flights?origin=TLV&dest=ROM&date=2026-10-12&adults=1&children_ages=0,1"), /one lap infant per adult/);
  const back = await api("/api/flights?origin=ROM&dest=TLV&date=2026-10-16");
  const chk = await api("/api/itinerary/check", { legs: [r.flights[0], back.flights[0]], currency: "USD" });
  assert.equal(chk.gaps.length, 1);
  assert.ok(chk.total_price > 0 && chk.gaps[0].gap_min > 0);
  await assert.rejects(api("/api/itinerary/check", { legs: [] }), /every leg needs at least one flight segment/);
});

test("the airline finder sums up airlines per airport and only widens the dates for airports with flights", async () => {
  const p = fake((o, d, day) => {
    if (d === "OTP") {
      return [offer(o, d, at(day), 400, "W4"), offer(o, d, at(day, 14), 505, "H4"), L.models.offer({ origin: o, destination: d, price: 900,
        currency: "USD", segments: [seg(o, "ATH", at(day, 6), 120, "A3"), seg("ATH", d, at(day, 11), 120, "A3")] })];
    }
    return d === "CLJ" ? [offer(o, d, at(day), 450, "W4")] : [];          // IAS and SBZ have no service
  });
  L.backend.setup(p);
  const res = await api("/api/explore", { origin: "TLV", airports: ["OTP", "CLJ", "IAS", "SBZ"], direction: "to", date: "2026-09-28", extra_days: [2, 5] });
  assert.deepEqual(res.airports_with_flights, ["OTP", "CLJ"]);
  assert.equal(p.calls.length, 4 + 2 * 2);                                 // every airport on day 1, then only the 2 active ones on 2 more days
  const by = Object.fromEntries(res.airlines.map(a => [a.code, a]));
  assert.deepEqual(Object.keys(by).sort(), ["A3", "H4", "W4"]);
  assert.equal(by.W4.nonstop_airports, 2);
  assert.deepEqual(by.W4.routes.map(r => r.airport).sort(), ["CLJ", "OTP"]);
  assert.deepEqual([by.H4.nonstop_airports, by.H4.routes[0].cheapest], [1, 505]);
  const a3 = by.A3.routes[0];
  assert.deepEqual([by.A3.nonstop_airports, a3.airport, a3.nonstop], [0, "OTP", false]);   // only with a stop
  assert.equal(by.W4.routes[0].dates.length, 3);
  assert.equal(res.dates[0], "2026-09-28");
  assert.equal(res.airlines[0].code, "W4");                                // most nonstop airports first
});

test("a country's airports for the finder are the ones with scheduled flights", async () => {
  L.backend.setup(fake(() => []));
  const res = await api("/api/explore", { origin: "TLV", country: "Portugal", date: "2026-09-28", extra_days: [] });
  assert.equal(res.trimmed, false);
  for (const code of ["LIS", "OPO", "FAO", "FNC", "PDL"]) assert.ok(res.airports_checked.includes(code), code);
  for (const code of ["AVR", "QLR", "BYJ"]) assert.ok(!res.airports_checked.includes(code), code);   // air bases and fields without flights
});

test("exchange rates come from the ECB, and a failure says so instead of guessing", async () => {
  L.backend.setup();
  online = async () => ({ ok: true, json: async () => ({ date: "2026-09-21", rates: { ILS: 3.0115, GBP: 0.74656, EUR: 0.87032 } }) });
  try {
    const r = await api("/api/rates");
    assert.deepEqual([r.rates.ILS, r.rates.USD], [3.0115, 1]);
    assert.ok(r.source.startsWith("ECB"));
    online = async () => { throw new Error("offline"); };
    const down = await api("/api/rates");
    assert.deepEqual([down.rates, down.source], [{}, null]);               // no made-up rates: prices stay as searched
    assert.equal(down.error, "live exchange rates unavailable: offline");
  } finally { online = async url => { throw new Error(`unexpected fetch ${url}`); }; }
});

test("a price check asks the other fare source about each leg", async () => {
  L.backend.setup();
  const out = [seg("TLV", "FCO", "2026-11-02T08:00:00", 120, "LY", "381")], back = [seg("FCO", "TLV", "2026-11-02T18:00:00", 120, "LY", "381")];
  const leg = (segs, price) => ({ ...L.models.legView(L.models.offer({ origin: segs[0].origin, destination: segs[0].destination, price,
    currency: "USD", segments: segs })), provider: "gflights" });
  const serp = { best_flights: [{ price: 170, flights: [{ departure_airport: { id: "TLV", time: "2026-11-02 08:00" },
    arrival_airport: { id: "FCO", time: "2026-11-02 10:00" }, airline: "El Al", flight_number: "LY 381" }] }] };
  const body = { request: { ...ROME, destinations: ["FCO"], window_start: "2026-11-02", window_end: "2026-11-09" }, legs: [leg(out, 161), leg(back, 99)] };
  L.account = { live: () => true, has: () => true, get: async path => {
    if (new URL(path, "http://worker").searchParams.get("dest") === "TLV") throw new Error("SerpApi: Invalid API key.");
    return serp;
  } };
  try {
    const r = await api("/api/verify", body);
    assert.deepEqual([r.source, r.status], ["serpapi", "price_differs"]);
    assert.deepEqual(r.legs.map(v => v.status), ["price_differs", "error"]);
    assert.ok(r.legs[1].note.includes("Invalid API key"));
  } finally { delete L.account; }
  await assert.rejects(api("/api/verify", body), /checking a price needs real fares: sign in/);   // demo fares have no second source
});
