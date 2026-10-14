// Run: node src/flightagent/web/hub.test.js   (from the repo root)
// Pins the Travel Hub handoff: tests/fixtures/travel-hub-handoff.json is the same file as the hub's
// src/test/fixtures/skyhop-handoff.json, so a change on either side breaks a test.
const fs = require("fs"), path = require("path"), assert = require("assert");
const H = require("./hub.js");

const seg = (code, name, no, o, d, dep, arr) => ({ airline_code: code, airline: name, flight_number: no, origin: o, destination: d, departs: dep, arrives: arr });
const offers = [
  { origin: "TLV", destination: "LIS", price: 378, currency: "ILS", deep_links: ["https://www.ryanair.com/"], priced: true,
    segments: [seg("FR", "Ryanair", "3561", "TLV", "BUD", "2026-11-16T09:30:00", "2026-11-16T12:56:00"), seg("PC", "Pegasus", "3363", "BUD", "LIS", "2026-11-16T22:56:00", "2026-11-17T00:58:00")] },
  { origin: "OPO", destination: "TLV", price: 414, currency: "ILS", deep_links: [], priced: true,
    segments: [seg("OS", "Austrian", "2798", "OPO", "FRA", "2026-11-19T16:00:00", "2026-11-19T19:57:00"), seg("PC", "Pegasus", "8425", "FRA", "TLV", "2026-11-19T21:57:00", "2026-11-20T00:18:00")] },
];
const cities = { LIS: "Lisbon", OPO: "Porto", TLV: "Tel Aviv", FRA: "Frankfurt" };

// payload() produces exactly the contract fixture
const want = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../tests/fixtures/travel-hub-handoff.json"), "utf8"));
const got = H.payload(offers, { searchId: "s_portugal", adults: 3, kids: [], currency: "ILS", cityOf: c => cities[c] });
assert.deepStrictEqual(got, want);

// a price in another currency is left out rather than mislabelled
assert.strictEqual(H.payload([{ ...offers[0], currency: "USD" }], { currency: "ILS" }).legs[0].price, undefined);

// the link carries base64url JSON that decodes back, Unicode included
const url = H.handoffUrl("https://alon24.github.io/travel-hub/", { ...got, names: { ZRH: "Zürich" } });
assert.ok(url.startsWith("https://alon24.github.io/travel-hub/#/handoff/"));
const b64 = url.split("#/handoff/")[1].replace(/-/g, "+").replace(/_/g, "/");
const back = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0))));
assert.strictEqual(back.names.ZRH, "Zürich");

// only http(s) hubs: never javascript:, data: or a remote plain-http host
assert.strictEqual(H.safeHub("javascript:alert(1)"), null);
assert.strictEqual(H.safeHub("data:text/html,x"), null);
assert.strictEqual(H.safeHub("http://evil.example/"), null);
assert.strictEqual(H.safeHub("http://localhost:4173/travel-hub/?x=1#y"), "http://localhost:4173/travel-hub/");
assert.ok(H.handoffUrl("javascript:alert(1)", got).startsWith(H.DEFAULT_HUB));

// the hub's search link fills the form
const p = H.fromParams("?from=tlv&to=LIS&back=OPO&start=2026-11-13&end=2026-11-22&nights=3&adults=3&children=7,x,30&trip=trip_ab12&hub=https%3A%2F%2Fexample.org%2Fhub%2F");
assert.deepStrictEqual(p.form, { from: ["TLV"], to: ["LIS"], back: ["OPO"], start: "2026-11-13", end: "2026-11-22", adults: 3, kids: [7],
  nmin: 3, nmax: 3, lenMode: "exact", unit: "nights" });
assert.deepStrictEqual(p.context, { trip: "trip_ab12", hub: "https://example.org/hub/" });
// A whole country from the hub: several airports to fly into (and home from)
const many = H.fromParams("?from=TLV&to=LIS,opo,%20FAO,LIS&back=MAD,BCN&start=2026-11-13&end=2026-11-22");
assert.deepStrictEqual([many.form.to, many.form.back], [["LIS", "OPO", "FAO"], ["MAD", "BCN"]]);
assert.deepStrictEqual(H.fromParams("?from=TLV&to=LIS&back=MAD,xx1&start=2026-11-13&end=2026-11-22").form.back, []);
assert.strictEqual(H.fromParams("?from=TLV&to=LIS,BAD1&start=2026-11-13&end=2026-11-22"), null);
assert.strictEqual(H.fromParams("?app-sign-in=1"), null);
assert.strictEqual(H.fromParams("?from=TLV&to=LIS&start=2026-11-13&end=bad"), null);
assert.strictEqual(H.fromParams("?from=TLV&to=LIS&start=2026-11-13&end=2026-11-22&hub=javascript:x").context.hub, H.DEFAULT_HUB);
console.log("hub.js ok");
