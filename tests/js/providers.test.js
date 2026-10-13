// Fare sources as the page reads them: the demo fares (local/mock.js, local/rng.js), SerpApi answers (local/serpapi.js)
// and Google Flights result groups (local/gflights.js), both fetched through Skyhop's Worker.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, read, offer, at } = require("./skyhop");

const FIXTURE = read("tests", "fixtures", "gflights_tlv_fco_2026-10-05.json");      // a real captured Google Flights answer
const labels = o => o.segments.map(s => `${s.airline_code}${s.flight_number}`).join("+");
const query = path => Object.fromEntries(new URL(path, "http://worker").searchParams);

// Pinned from the Python mock provider on 2026-10-13: the demo shows the same fares the server's mock mode did.
const DEMO = [
  [["TLV", "FCO", "2026-11-06", { currency: "EUR", adults: 2, maxStops: 2, children: 1, infants: 1, carryOnBags: 1, checkedBags: 1 }], [
    [464.48, "OS2591+U2728", "2026-11-06T20:30:00", "2026-11-07T04:30:00"], [589.86, "FR7139+TK9160", "2026-11-06T06:30:00", "2026-11-06T22:18:00"],
    [437.04, "U2511+LO2200", "2026-11-06T06:30:00", "2026-11-07T05:57:00"], [339.58, "OS8122+LO4591+FR2257", "2026-11-06T16:00:00", "2026-11-07T20:16:00"]]],
  [["BUD", "TLV", "2026-11-09", { currency: "USD", adults: 1, maxStops: 1 }], [
    [61.85, "LY2631", "2026-11-09T19:30:00", "2026-11-09T21:09:00"], [75.08, "OS3631", "2026-11-09T12:45:00", "2026-11-09T15:25:00"],
    [46.08, "OS5154+LY1692", "2026-11-09T08:30:00", "2026-11-10T02:44:00"], [49.99, "FR4548+LH756", "2026-11-09T10:00:00", "2026-11-09T19:45:00"],
    [40.07, "LY1882+OS4499", "2026-11-09T09:00:00", "2026-11-09T23:32:00"]]],
  [["IST", "SAW", "2027-01-31", { currency: "ILS", adults: 3, maxStops: 0 }], [
    [582, "A37803", "2027-01-31T14:15:00", "2027-01-31T18:01:00"], [754.99, "LH3130", "2027-01-31T09:15:00", "2027-01-31T10:45:00"]]],
];
for (const [[o, d, day, opts], want] of DEMO) {
  test(`demo fares ${o} to ${d} on ${day} are the server's mock fares`, async () => {
    const offers = await L.mock.oneWay(o, d, day, opts);
    assert.deepEqual(offers.map(x => [x.price, labels(x), x.segments[0].departs, x.segments.at(-1).arrives]), want);
    assert.ok(offers.every(x => x.currency === opts.currency && x.provider === "mock" && x.priced));
    assert.equal(offers[0].deep_links[0], `https://www.google.com/travel/flights?q=Flights%20from%20${o}%20to%20${d}%20on%20${day}%20one%20way`);
  });
}

const flight = (o, d, dep, arr, number = "TK 787", extra = {}) =>
  ({ departure_airport: { id: o, time: dep }, arrival_airport: { id: d, time: arr }, airline: "Turkish Airlines", flight_number: number, ...extra });

test("a SerpApi answer becomes offers: priced items only, real flight times, Google's link", () => {
  const data = {
    search_metadata: { google_flights_url: "https://www.google.com/travel/flights?x=1" },
    best_flights: [{ price: 123, flights: [flight("TLV", "IST", "2026-10-05 08:30", "2026-10-05 11:00", "TK 787", { duration: 190 }),
      flight("IST", "FCO", "2026-10-05 13:00", "2026-10-05 14:30", "TK 1861", { duration: 150 })] }],
    other_flights: [{ flights: [] }, { price: 99, flights: [] },                 // no price, or no flights: skipped
      { price: 87.5, flights: [flight("TLV", "CIA", "2026-10-05 23:10", "2026-10-06 02:05", "W62327")] }],
  };
  const [o, cia, ...rest] = L.serpapi.parse(data, "TLV", "ROM", "2026-10-05", "EUR");
  assert.equal(rest.length, 0);
  assert.deepEqual([o.origin, o.destination, o.price, o.currency, o.provider], ["TLV", "FCO", 123, "EUR", "serpapi"]);
  assert.deepEqual([L.models.stops(o), L.models.airlines(o), L.models.layovers(o), labels(o)], [1, ["TK"], [120], "TK787+TK1861"]);
  // local times say 150 + 90 min flying, but SerpApi reports 190 + 150: time zones
  assert.equal(L.models.duration(o), 190 + 150 + 120);
  assert.deepEqual(o.deep_links, ["https://www.google.com/travel/flights?x=1"]);
  assert.deepEqual([cia.price, cia.segments[0].airline_code, cia.segments[0].flight_number, cia.segments[0].arrives, cia.segments[0].duration_min],
    [87.5, "W62327", "", "2026-10-06T02:05:00", null]);       // a number without a space is read as the airline code, as SerpApi's Python reader did
});

test("a SerpApi answer without a link or a flight number still parses, and an empty one gives nothing", () => {
  const { flight_number, ...noNumber } = flight("TLV", "FCO", "2026-10-05 06:00", "2026-10-05 09:00");
  const [o] = L.serpapi.parse({ best_flights: [{ price: 300, flights: [noNumber] }] }, "TLV", "ROM", "2026-10-05", "EUR");
  assert.deepEqual([o.price, o.segments[0].airline_code, o.segments[0].flight_number], [300, "??", " "]);
  assert.deepEqual(o.deep_links, ["https://www.google.com/travel/flights?q=Flights%20from%20TLV%20to%20ROM%20on%202026-10-05%20one%20way"]);
  assert.deepEqual(L.serpapi.parse({}, "TLV", "ROM", "2026-10-05", "EUR"), []);
});

test("SerpApi lookups send the travellers to the Worker", async () => {
  let asked;
  const p = L.serpapi.provider(async path => { asked = path; return { error: "Google Flights hasn't returned any results for this query." }; });
  const offers = await p.oneWay("TLV", "FCO", "2026-10-05", { currency: "USD", adults: 2, maxStops: 1, children: 1, infants: 1 });
  assert.equal(offers.length, 0);
  assert.ok(asked.startsWith("/serpapi?"));
  assert.deepEqual(query(asked), { origin: "TLV", dest: "FCO", date: "2026-10-05", currency: "USD", adults: "2", max_stops: "1", children: "1", infants: "1" });
});

test("Google's best and other groups all become offers, with aircraft, legroom and CO2", () => {
  const offers = L.gflights.parse([...FIXTURE.best, ...FIXTURE.other], "TLV", "FCO", "USD");
  assert.equal(offers.length, 9);
  const cheapest = offers.reduce((a, b) => (b.price < a.price ? b : a));
  // the $161 Tus Air fare lives in Google's "best flights" block, which fast-flights drops
  assert.deepEqual([cheapest.price, L.models.airlines(cheapest), labels(cheapest)], [161, ["U8"], "U8132"]);
  assert.deepEqual([L.models.duration(cheapest), L.models.stops(cheapest)], [225, 0]);
  assert.deepEqual([cheapest.segments[0].aircraft, cheapest.segments[0].legroom], ["Boeing 737", "30 in"]);
  assert.deepEqual([cheapest.co2_g, cheapest.co2_typical_g], [239000, 200000]);
  const wizz = offers.find(o => labels(o) === "W46044");
  assert.deepEqual([wizz.segments[0].aircraft, wizz.segments[0].legroom], ["Airbus A321neo", ""]);
  const sky = offers.find(o => L.models.airlines(o).join() === "GQ");
  assert.deepEqual([L.models.stops(sky), sky.segments[1].origin], [1, "ATH"]);
  assert.ok(L.models.layovers(sky)[0] > 0);
});

test("a flight Google lists without a fare is kept, flagged unpriced", () => {
  const unpriced = [FIXTURE.best[0][0], [[], "token"]];       // e.g. HiSky, sold only on its own site
  const offers = L.gflights.parse([...FIXTURE.best, ...FIXTURE.other, unpriced], "TLV", "FCO", "USD");
  assert.equal(offers.length, 10);
  const no = offers.filter(o => !o.priced);
  assert.deepEqual(no.map(o => o.price), [0]);
});

// Pinned from the Python reader (gflights.parse_groups) on 2026-10-13.
test("Google's groups read with the page link, usual price range and nearby days' fares, every field as the server read them", () => {
  const groups = [...FIXTURE.best, ...FIXTURE.other];
  groups[1] = [groups[1][0], []];                                       // a flight Google lists without a fare
  const link = "https://www.google.com/travel/flights?tfs=GhoSCjIwMjYtMTAtMDU%3D&hl=en-US&curr=EUR";
  const offers = L.gflights.parse(groups, "TLV", "FCO", "EUR", link, [60, 110], [["2026-10-04", 63]]);
  const M = L.models;
  assert.deepEqual(offers.map(o => [o.priced, o.price, labels(o), M.duration(o), M.layovers(o), o.co2_g]), [
    [true, 161, "U8132", 225, [], 239000], [false, 0, "6H343", 225, [], 187000], [true, 190, "W46044", 230, [], 143000],
    [true, 175, "GQ721+GQ820", 810, [550], 178000], [true, 390, "W46042", 230, [], 143000], [true, 436, "LY285", 220, [], 198000],
    [true, 436, "LY383", 220, [], 198000], [true, 507, "AZ807", 225, [], 200000], [true, 1770, "LY385", 220, [], 304000]]);
  assert.deepEqual(offers[3].segments.map(s => [s.departs, s.arrives, s.duration_min, s.aircraft, s.legroom]), [
    ["2026-10-05T23:30:00", "2026-10-06T01:45:00", 135, "Airbus A320neo", "28 in"], ["2026-10-06T10:55:00", "2026-10-06T12:00:00", 125, "Airbus A320neo", "28 in"]]);
  assert.ok(offers.every(o => o.deep_links.join() === link && o.usual_price.join() === "60,110" && o.co2_typical_g === 200000
    && JSON.stringify(o.nearby_fares) === '[["2026-10-04",63]]' && o.currency === "EUR" && o.provider === "gflights"));
});

test("Google Flights lookups send the whole search to the Worker and link each fare to the page that priced it", async () => {
  const url = "https://www.google.com/travel/flights?tfs=X&hl=en-US&curr=EUR", asked = [];
  const p = L.gflights.provider(async path => { asked.push(path); return { groups: [...FIXTURE.best, ...FIXTURE.other], url, usual: [60, 110], nearby: [["2026-10-06", 99]] }; });
  const offers = await p.oneWay("TLV", "FCO", "2026-10-05", { currency: "EUR", adults: 2, children: 1, maxStops: 0, checkedBags: 1 });
  assert.equal(asked.length, 1);
  assert.deepEqual(query(asked[0]), { origin: "TLV", dest: "FCO", date: "2026-10-05", currency: "EUR", adults: "2", max_stops: "0", children: "1",
    infants: "0", carry_on_bags: "0", checked_bags: "1" });
  assert.ok(offers.length && offers.every(o => o.deep_links[0] === url && o.usual_price.join() === "60,110" && o.nearby_fares[0][1] === 99));
});

test("a fare Google leaves out is asked for twice more, then the priced copy replaces the unpriced one", async () => {
  const merge = L.gflights.merge;
  const priced = offer("TLV", "OTP", at("2026-09-28", 14), 505, "H4"), unpriced = { ...priced, priced: false, price: 0 };
  const other = offer("TLV", "OTP", at("2026-09-28", 16), 415, "W4");
  assert.deepEqual(merge([unpriced, other], [priced]).map(o => [o.segments[0].airline_code, o.priced]), [["H4", true], ["W4", true]]);
  assert.equal(merge([unpriced], [unpriced])[0].priced, false);          // stays unpriced if it never shows up

  const fare = FIXTURE.best[0], bare = [fare[0], []];                       // U8132 at 161, then without its price
  const lookup = answers => {
    const asked = { n: 0 };
    const p = L.gflights.provider(async () => ({ groups: [answers[Math.min(asked.n++, answers.length - 1)]] }), { wait: async () => {} });
    return [p, asked];
  };
  const [flaky, a] = lookup([bare, fare]);
  const got = await flaky.oneWay("TLV", "FCO", "2026-10-05", { currency: "ILS", adults: 1, maxStops: 1 });
  assert.equal(a.n, 2);
  assert.deepEqual([got[0].priced, got[0].price], [true, 161]);
  const [never, b] = lookup([bare]);
  await never.oneWay("TLV", "FCO", "2026-10-05", { currency: "ILS", adults: 1, maxStops: 1 });
  assert.equal(b.n, 3);                                                     // one try + two retries, then gives up
});
