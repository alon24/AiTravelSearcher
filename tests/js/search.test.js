// Whole searches on the demo fares (local/mock.js), pinned to what the Python engine answered on 2026-10-13, when the two
// gave identical results. A change here changes what every Pages user sees.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, M } = require("./skyhop");

const run = body => new L.engine.Engine(L.mock).search(M.searchRequest(body));
const flights = t => t.legs.map(l => l.segments.map(s => `${s.airline_code}${s.flight_number}`).join("+"));
const MIXED = "Outbound and return are separate one-way tickets on different airlines.";

const BASE = { origin: "TLV", window_start: "2026-11-02", window_end: "2026-11-12", min_nights: 3, max_nights: 5 };
// days: [count, first, last]; cells: {kind: [cells, cheapest]}; best: the top trip; airlines: cheapest fare per airline,
// `excluded` the ones the filter removed; warnings: the search's own (not a trip's).
const SEARCHES = {
  "round trip, two destinations": [{ ...BASE, destinations: ["FCO", "CDG"], open_jaw: false }, {
    days: [8, "2026-11-02", "2026-11-09"], lookups: 32, cheapest: 72.77, cells: { round_trip: [6, 72.77] },
    top: [130.87, 118.58, 116.85, 128.14, 105.76],
    best: ["round_trip", "CDG", "2026-11-03", "2026-11-07", 130.87, 169.87, 234, ["A3206", "LO3568"], [MIXED]],
    airlines: { A3: 33.77, LY: 33.77, LH: 33.79, PC: 33.79, U2: 33.79, OS: 34.46, TK: 35.51, W6: 35.86, LO: 37.31, FR: 39 } }],
  "open jaw with extra return airports": [{ ...BASE, destinations: ["FCO", "LHR"], return_airports: ["CIA", "STN"] }, {
    days: [8, "2026-11-02", "2026-11-09"], lookups: 48, cheapest: 66, cells: { round_trip: [6, 66], open_jaw: [18, 125.85] },
    top: [66, 71.07, 81.99, 94.43, 75.19],
    best: ["round_trip", "LHR", "2026-11-02", "2026-11-05", 66, 226.5, 963, ["LH3746+A32052", "TK2100+LH5734"], [MIXED]],
    airlines: { A3: 32.16, OS: 32.16, LO: 32.16, U2: 32.16, LY: 32.18, PC: 32.18, LH: 32.24, TK: 33.23, FR: 37.46, W6: 38.1 } }],
  "multi-stop": [{ ...BASE, destinations: ["ATH", "BUD"], connect_destinations: true, min_nights_per_stop: 2 }, {
    days: [8, "2026-11-02", "2026-11-09"], lookups: 46, cheapest: 78.1, cells: { round_trip: [6, 78.1], open_jaw: [6, 154.48], multi_stop: [4, 268.82] },
    top: [112.67, 123.11, 138.56, 129.61, 132.95],
    best: ["round_trip", "BUD", "2026-11-09", "2026-11-12", 112.67, 174.5, 371, ["PC6035", "FR894"], [MIXED]],
    airlines: { LY: 37.54, W6: 37.54, LH: 38.03, LO: 38.18, FR: 39.08, OS: 40.06, TK: 40.06, PC: 41.32, A3: 41.83, U2: 49.09 } }],
  "self-transfer via hubs": [{ ...BASE, destinations: ["LIS"], allow_self_transfer: true, self_transfer_hubs: ["IST", "VIE"], airlines_exclude: ["TK"] }, {
    days: [8, "2026-11-02", "2026-11-09"], lookups: 84, cheapest: 258.28, cells: { round_trip: [3, 258.28] },
    top: [282.97, 274.93, 269.18, 280.24, 294.56],
    best: ["round_trip", "LIS", "2026-11-05", "2026-11-08", 282.97, 431.8, 893, ["LH5240+LO6389", "LO9411+LY6583"], [MIXED]],
    airlines: { A3: 41.35, OS: 41.35, LO: 42.03, W6: 43.85, LY: 44.15, TK: 46.05, PC: 48.39, FR: 48.77, U2: 50.16, LH: 53.81 }, excluded: ["TK"] }],
  "same airline both ways": [{ ...BASE, destinations: ["FCO", "BCN"], allow_mixed_airlines: false, max_stops_per_leg: 2 }, {
    days: [6, "2026-11-02", "2026-11-08"], lookups: 32, cheapest: 156.76, cells: { round_trip: [4, 156.76], open_jaw: [4, 184.4] },
    top: [188.35, 211.99, 204.37, 231.86, 229.81],
    best: ["round_trip", "BCN", "2026-11-08", "2026-11-12", 188.35, 236.85, 291, ["FR5093", "FR1723"], []],
    airlines: { A3: 47.36, OS: 47.36, LY: 47.36, LO: 47.36, LH: 47.36, FR: 47.36, TK: 47.36, W6: 47.36, U2: 47.36, PC: 55.2 } }],
  "airline filters and travel cap": [{ ...BASE, destinations: ["FCO", "ATH"], airlines_include: ["w6", "fr", "tk", " LY ", "os", "a3", "lh"],
    airlines_exclude: ["FR"], max_travel_min_per_direction: 900 }, {
    days: [4, "2026-11-03", "2026-11-08"], lookups: 32, cheapest: 250.34, cells: { round_trip: [2, 256.1], open_jaw: [4, 250.34] },
    top: [250.34, 256.1, 265.3, 291.46, 288.98],
    best: ["open_jaw", "ATH→FCO", "2026-11-03", "2026-11-07", 250.34, 409.67, 956, ["OS3408+LH2784", "TK9752+LY3570"],
      ["4 nights between landing at ATH and leaving from FCO. ATH and FCO are in different cities. No transfer estimate is available, so allow for your own ground travel.", MIXED]],
    airlines: { OS: 88.96, TK: 88.96, LY: 89.93, PC: 89.93, LH: 90.85, FR: 90.85, LO: 94.83, U2: 97.93, A3: 99.83, W6: 101.68 }, excluded: ["FR", "LO", "PC", "U2"] }],
  "family with bags": [{ ...BASE, destinations: ["LCA", "ATH"], adults: 2, children_ages: [1, 7, 13], carry_on_bags: 1, checked_bags: 2, currency: "EUR",
    value_of_time_per_hour: 25, top_n: 8 }, {
    days: [8, "2026-11-02", "2026-11-09"], lookups: 32, cheapest: 633.32, cells: { round_trip: [6, 633.32], open_jaw: [6, 753.28] },
    top: [670.71, 868.6, 869.51, 656.8, 920.95, 802.89, 903.3, 673.85],
    best: ["round_trip", "LCA", "2026-11-02", "2026-11-05", 670.71, 1001.13, 793, ["LH7187", "LH9587+LH6345"], []],
    airlines: { LH: 266.33, OS: 279.66, LY: 279.66, A3: 282.34, FR: 285.44, TK: 296.42, LO: 299.99, U2: 300.84, PC: 319.31, W6: 322.08 },
    warnings: [
      "Prices include Google's estimated fees for 1 cabin bag + 2 checked bags. Google only has fee data for some airlines and markets (mostly US and Europe); where it has none, the bag is not priced in.",
      "Prices are totals for 2 adults, children aged 1, 7, 13. Google prices children by age (under 2 = infant on lap, 2-11 = child, 12+ = adult); airlines' own rules can differ.",
      "Travelling with an infant under 2 (on a lap): infant fees and rules differ by airline, may not be in these prices, and Google may hide airlines that do not carry infants. Confirm on the airline's site."] }],
  "across the October clock change": [{ ...BASE, destinations: ["LHR", "CDG"], window_start: "2026-10-20", window_end: "2026-10-30", max_stops_per_leg: 2,
    min_layover_min: 45 }, {
    days: [8, "2026-10-20", "2026-10-27"], lookups: 32, cheapest: 57.84, cells: { round_trip: [6, 57.84], open_jaw: [6, 58.74] },
    top: [115.71, 132.6, 115.64, 138.73, 91.54],
    best: ["round_trip", "CDG", "2026-10-22", "2026-10-27", 115.71, 159.88, 265, ["A3174", "LH4794"], [MIXED]],
    airlines: { A3: 28.92, OS: 28.92, LO: 28.92, LH: 28.92, PC: 28.92, FR: 28.92, TK: 28.92, W6: 28.92, U2: 28.92, LY: 29.82 } }],
  "no connections": [{ ...BASE, destinations: ["VIE", "WAW", "BUD"], allow_connections: false }, {
    days: [8, "2026-11-02", "2026-11-09"], lookups: 48, cheapest: 112.67, cells: { round_trip: [9, 112.67], open_jaw: [18, 164.25] },
    top: [112.67, 123.11, 138.56, 131.19, 129.61],
    best: ["round_trip", "BUD", "2026-11-09", "2026-11-12", 112.67, 174.5, 371, ["PC6035", "FR894"], [MIXED]],
    airlines: { FR: 54.85, LO: 56.36, LH: 57.45, PC: 57.82, LY: 58.61, A3: 60.54, TK: 69.34, W6: 72.07, U2: 73.32, OS: 75.08 } }],
};

for (const [name, [body, want]] of Object.entries(SEARCHES)) {
  test(`demo search: ${name}`, async () => {
    const res = await run(body);
    assert.deepEqual([res.daily.length, res.daily[0].depart_date, res.daily.at(-1).depart_date], want.days);
    assert.deepEqual([res.api_calls, res.cache_hits], [want.lookups, 0]);
    assert.equal(Math.min(...res.daily.map(d => d.cheapest.price)), want.cheapest);
    const cells = {};
    for (const c of res.cells) { const k = c.cheapest.kind; cells[k] = [(cells[k] || [0])[0] + 1, Math.min(c.cheapest.price, (cells[k] || [0, Infinity])[1])]; }
    assert.deepEqual(cells, want.cells);
    assert.deepEqual(res.top.map(t => t.price), want.top);
    const t = res.top[0];
    assert.deepEqual([t.kind, t.destination, t.depart_date, t.return_date, t.price, t.effective_cost, t.total_travel_min, flights(t), t.warnings], want.best);
    assert.equal(t.nights, M.daysBetween(t.depart_date, t.return_date));
    assert.equal(t.currency, body.currency || "USD");
    assert.deepEqual(Object.fromEntries(res.airlines.map(a => [a.code, a.cheapest])), want.airlines);
    assert.deepEqual(res.airlines.filter(a => !a.included).map(a => a.code).sort(), want.excluded || []);
    assert.deepEqual(res.warnings, want.warnings || []);
    assert.deepEqual([res.unpriced, res.sources], [[], { mock: want.lookups }]);
  });
}

test("the estimate counts the lookups a self-transfer search needs", async () => {
  const r = M.searchRequest(SEARCHES["self-transfer via hubs"][0]);
  assert.deepEqual(await new L.engine.Engine(L.mock).estimate(r), { lookups: 84, cached: 0, to_fetch: 84 });
});
