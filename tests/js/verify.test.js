// Price check by a second fare source (local/verify.js): the same flights are found by airline, flight number and
// departure minute, never by price.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, M } = require("./skyhop");
const { judge, lookupKey, lookups, worst, secondSource } = L.verify;

const DAY = "2026-11-02";
const seg = (o, d, h, code = "LY", num = "381") => {
  const dep = `${DAY}T${String(h).padStart(2, "0")}:00:00`;
  return M.segment({ airline_code: code, flight_number: num, origin: o, destination: d, departs: dep, arrives: M.addMinutes(dep, 120) });
};
const leg = (segs, price, extra = {}) => ({ origin: segs[0].origin, destination: segs.at(-1).destination, airlines: segs.map(s => s.airline_code),
  segments: segs, stops: segs.length - 1, layovers_min: [], duration_min: 120, price, deep_links: [], self_transfer: false, provider: "gflights", hub: null, ...extra });
const offer = (segs, price, priced = true) => M.offer({ origin: segs[0].origin, destination: segs.at(-1).destination, price, currency: "USD",
  segments: segs, provider: "serpapi", priced });
function check(lg, offers, errors = {}) {
  const found = {};
  for (const o of offers) (found[lookupKey(o.segments)] = found[lookupKey(o.segments)] || []).push(o);
  return judge(lg, found, errors, "serpapi", { IST: "IST,SAW" });
}

const OUT = [seg("TLV", "FCO", 8)];
const VIA = [seg("TLV", "IST", 6, "TK", "785"), seg("IST", "FCO", 11, "W6", "4001")];

test("the same flight within a few dollars is confirmed", () => {
  assert.deepEqual(check(leg(OUT, 161), [offer(OUT, 163)]), { status: "confirmed", price: 161, seen_price: 163, note: "" });
});

test("the same flight at another price differs", () => {
  const r = check(leg(OUT, 161), [offer(OUT, 175)]);
  assert.deepEqual([r.status, r.seen_price], ["price_differs", 175]);
});

test("of two fares for the same flight, the closer one counts", () => {
  assert.equal(check(leg(OUT, 161), [offer(OUT, 240), offer(OUT, 160)]).status, "confirmed");
});

test("another flight at the same price is not a match", () => {
  assert.deepEqual(check(leg(OUT, 161), [offer([seg("TLV", "FCO", 9)], 161)]),
    { status: "not_found", price: 161, seen_price: null, note: "serpapi doesn't list LY381" });
});

test("a flight listed without a price is not found, and says why", () => {
  assert.equal(check(leg(OUT, 161), [offer(OUT, 0, false)]).note, "serpapi doesn't list LY381 (listed without a price)");
});

test("a flight number written with a leading zero is the same flight", () => {
  assert.equal(check(leg(OUT, 161), [offer([seg("TLV", "FCO", 8, "LY", "0381")], 161)]).status, "confirmed");
});

test("a self-transfer is checked as its two tickets, split at the hub", () => {
  const st = leg(VIA, 230, { self_transfer: true, hub: "IST" });
  assert.deepEqual(check(st, [offer(VIA.slice(0, 1), 120), offer(VIA.slice(1), 112)]), { status: "confirmed", price: 230, seen_price: 232, note: "" });
  assert.deepEqual(lookups([st]), ["TLV|IST|2026-11-02", "IST|FCO|2026-11-02"]);
});

test("a failed lookup is an error naming the source, and the worst leg decides the trip", () => {
  const r = check(leg(OUT, 161), [], { [lookupKey(OUT)]: "SerpApi: Invalid API key." });
  assert.deepEqual([r.status, r.note], ["error", "serpapi: SerpApi: Invalid API key."]);
  const ok = check(leg(OUT, 161), [offer(OUT, 163)]), missing = check(leg(OUT, 161), [offer(OUT, 0, false)]);
  assert.equal(worst([ok, missing, ok]), "not_found");
});

test("the check uses the real-fare source that did not price the trip, and demo fares have none", () => {
  assert.equal(secondSource(["gflights", "serpapi"], [leg(OUT, 1)]), "serpapi");
  assert.equal(secondSource(["gflights", "serpapi"], [leg(OUT, 1, { provider: "serpapi" })]), "gflights");
  assert.equal(secondSource(["mock"], [leg(OUT, 1, { provider: "mock" })]), null);
  assert.equal(secondSource(["gflights"], [leg(OUT, 1)]), null);
});
