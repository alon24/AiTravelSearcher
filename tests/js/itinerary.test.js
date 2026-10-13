// Connection checks between the flights of a trip (local/itinerary.js) and the airport facts behind them (local/geo.js):
// same airport, same city or another city, real time zones, and the thresholds that make a gap tight or impossible.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, M, seg } = require("./skyhop");
const { analyse, checkGap } = L.itinerary, { transferBetween, metroOf, tzOf } = L.geo;

const leg = (o, d, dep, minutes = 180, price = 100) =>
  M.legView(M.offer({ origin: o, destination: d, price, currency: "USD", segments: [seg(o, d, dep, minutes, "W4", "1")] }));
const T0 = "2026-10-12T10:00:00";
function gap(aDest, bOrigin, waitMin) {
  const a = leg("TLV", aDest, T0);
  return checkGap(0, a, leg(bOrigin, "TLV", M.addMinutes(a.segments[0].arrives, waitMin)));
}

test("airport basics: city transfers, metro areas and time zones", () => {
  assert.deepEqual(transferBetween("FCO", "CIA"), [60, "taxi, or train via Roma Termini"]);
  assert.equal(transferBetween("cia", "fco")[0], 60);                 // order and case do not matter
  assert.equal(transferBetween("LHR", "CDG"), null);
  assert.equal(transferBetween("FCO", "FCO"), null);
  assert.equal(transferBetween("LHR", "STN")[0], 100);
  assert.equal(metroOf("orly"), null);
  assert.equal(metroOf("ORY"), "PAR");
  assert.deepEqual([tzOf("TLV"), tzOf("JFK"), tzOf("ZZZ")], ["Asia/Jerusalem", "America/New_York", null]);
});

test("same airport: under 90 min is impossible, under 3h tight, a long wait and a multi-night stay say so", () => {
  const early = gap("FCO", "FCO", -30);
  assert.equal(early.status, "impossible");
  assert.ok(early.headline.includes("before this one lands"));
  assert.equal(gap("FCO", "FCO", 60).status, "impossible");
  const g = gap("FCO", "FCO", 150);
  assert.equal(g.status, "tight");
  assert.ok(g.headline.startsWith("Tight connection") && g.detail.includes("separate tickets"));
  assert.equal(gap("FCO", "FCO", 240).status, "ok");
  const long = gap("FCO", "FCO", 10 * 60);
  assert.ok(long.long_wait && long.headline.startsWith("Long wait: 10h 00m"));
  const nights = gap("FCO", "FCO", 4 * 24 * 60 + 5 * 60);
  assert.deepEqual([nights.status, nights.gap_text, nights.detail], ["ok", "4 nights", ""]);
});

test("two airports of one city add the transfer time to what a connection needs", () => {
  const tight = gap("FCO", "CIA", 150);                                // needs 60 + 120 = 180
  assert.deepEqual([tight.kind, tight.status, tight.transfer_min, tight.needed_min], ["same_city", "tight", 60, 180]);
  assert.ok(tight.detail.includes("about 60 min") && tight.detail.includes("estimate") && tight.detail.includes("3h 00m"));
  assert.equal(gap("FCO", "CIA", 50).status, "impossible");
  assert.equal(gap("FCO", "CIA", 200).status, "ok");
  const stay = gap("FCO", "CIA", 4 * 24 * 60);                         // a multi-night stay still mentions the transfer, without the hurry
  assert.equal(stay.status, "ok");
  assert.ok(stay.detail.includes("about 60 min") && !stay.detail.includes("check in"));
  assert.ok(stay.headline.includes("landing at FCO and leaving from CIA"));
});

test("different cities have no transfer estimate", () => {
  const g = gap("CDG", "BRU", 3 * 60);
  assert.deepEqual([g.kind, g.status, g.transfer_min], ["different_city", "tight", null]);
  assert.ok(g.detail.includes("different cities"));
  assert.equal(gap("CDG", "BRU", 2 * 24 * 60).status, "ok");
});

test("a gap is measured in real time across time zones, not by the clocks", () => {
  // land at LHR 13:00 BST (12:00 UTC); the next flight leaves CDG 14:30 CEST (12:30 UTC)
  const a = leg("TLV", "LHR", T0), g = checkGap(0, a, leg("CDG", "TLV", "2026-10-12T14:30:00"));
  assert.deepEqual([g.gap_min, g.tz_known], [30, true]);                // clocks say 90 minutes, reality is 30
  assert.equal(checkGap(0, a, leg("ZZZ", "TLV", "2026-10-12T14:30:00")).tz_known, false);
});

test("a clock change between two airports of one time zone is counted", () => {
  // Rome springs forward at 02:00 on 29 March: land FCO 01:00 CET (00:00 UTC), leave CIA 03:00 CEST (01:00 UTC)
  const g = checkGap(0, leg("TLV", "FCO", "2026-03-28T22:00:00"), leg("CIA", "TLV", "2026-03-29T03:00:00"));
  assert.deepEqual([g.gap_min, g.status], [60, "tight"]);              // clocks say 2h, only 1h passes
});

test("analyse totals the legs and warns that they are separate tickets", () => {
  const a = leg("TLV", "FCO", T0, 180, 65), b = leg("CIA", "TLV", M.addMinutes(T0, 4 * 24 * 60), 180, 80);
  const res = analyse([a, b], "USD");
  assert.deepEqual([res.total_price, res.currency, res.gaps.length], [145, "USD", 1]);
  assert.ok(res.warnings[0].includes("separate ticket"));
  assert.deepEqual(analyse([a]).warnings, []);
});

// Pinned from the Python engine (itinerary.py) on 2026-10-13, when both gave identical answers.
const leg99 = (o, d, dep) => ({ ...leg(o, d, dep), price: 99.95 });
const CHECKS = {
  "the night British and French summer time end": [[leg99("TLV", "LHR", "2026-10-24T09:00:00"), leg99("CDG", "TLV", "2026-10-25T02:30:00")], 199.9, [
    { kind: "different_city", status: "ok", gap_min: 810, gap_text: "13h 30m", tz_known: true, long_wait: false, transfer_min: null, needed_min: null,
      headline: "13h 30m between landing at LHR and leaving from CDG.",
      detail: "LHR and CDG are in different cities. No transfer estimate is available, so allow for your own ground travel." }]],
  "the night Rome's summer time starts": [[leg99("TLV", "FCO", "2026-03-28T22:00:00"), leg99("CIA", "TLV", "2026-03-29T03:00:00")], 199.9, [
    { kind: "same_city", status: "tight", gap_min: 60, gap_text: "1h 00m", tz_known: true, long_wait: false, transfer_min: 60, needed_min: 180,
      headline: "Tight connection: only 1h 00m between landing at FCO and leaving from CIA.",
      detail: "You land at FCO but the next flight leaves from CIA: getting between them takes about 60 min (taxi, or train via Roma Termini; "
        + "estimate, traffic varies). With about 2h to check in, you need at least 3h 00m between landing and departure." }]],
  "three legs across New York and a stay in Los Angeles": [[leg99("TLV", "JFK", "2026-11-01T01:00:00"), leg99("EWR", "LAX", "2026-11-01T09:00:00"),
    leg99("LAX", "XYZ", "2026-11-03T08:00:00")], 299.85, [
    { kind: "same_city", status: "ok", gap_min: 300, gap_text: "5h 00m", tz_known: true, long_wait: false, transfer_min: 80, needed_min: 200,
      headline: "5h 00m between landing at JFK and leaving from EWR.",
      detail: "You land at JFK but the next flight leaves from EWR: getting between them takes about 80 min (taxi or train; estimate, traffic varies). "
        + "With about 2h to check in, you need at least 3h 20m between landing and departure." },
    { kind: "same_airport", status: "ok", gap_min: 2640, gap_text: "2 nights", tz_known: true, long_wait: false, transfer_min: null, needed_min: 180,
      headline: "2 nights between flights at LAX.", detail: "" }]],
  "the return leaves before the outbound lands": [[leg99("TLV", "FCO", "2026-10-12T10:00:00"), leg99("FCO", "TLV", "2026-10-12T12:30:00")], 199.9, [
    { kind: "same_airport", status: "impossible", gap_min: -30, gap_text: "30m", tz_known: true, long_wait: false, transfer_min: null, needed_min: 180,
      headline: "Not enough time: the next flight leaves 30m before this one lands.",
      detail: "Same airport but separate tickets: collect bags, re-check in and clear security again. Plan at least 3h." }]],
  "two nights in London, home from another airport": [[leg99("TLV", "LHR", "2026-10-12T10:00:00"), leg99("STN", "TLV", "2026-10-14T20:00:00")], 199.9, [
    { kind: "same_city", status: "ok", gap_min: 3300, gap_text: "2 nights", tz_known: true, long_wait: false, transfer_min: 100, needed_min: 220,
      headline: "2 nights between landing at LHR and leaving from STN.",
      detail: "You land at LHR but the next flight leaves from STN: getting between them takes about 100 min (coach, or train via central London; "
        + "estimate, traffic varies)." }]],
};

for (const [name, [legs, total, gaps]] of Object.entries(CHECKS)) {
  test(`connection check: ${name}`, () => {
    const res = analyse(legs, "EUR");
    assert.deepEqual([res.total_price, res.currency, res.warnings.length], [total, "EUR", 1]);
    assert.deepEqual(res.gaps.map(g => Object.fromEntries(Object.keys(gaps[0]).map(k => [k, g[k]]))), gaps);
  });
}
