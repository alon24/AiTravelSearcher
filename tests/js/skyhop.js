// Loads the Pages build's engine (src/flightagent/web/local/*.js) into Node the way the page does: each file attaches
// itself to globalThis.SkyhopLocal. Also the builders the tests share: one-way offers, a fake provider, a request.
"use strict";
const path = require("path"), fs = require("fs");

const LOCAL = path.join(__dirname, "..", "..", "src", "flightagent", "web", "local");
for (const f of ["models", "rng", "mock", "geo", "itinerary", "polling", "engine", "db", "sites", "serpapi", "gflights", "verify", "backend"]) {
  require(path.join(LOCAL, `${f}.js`));
}
const L = globalThis.SkyhopLocal, M = L.models;
const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8"));
L.geo.setZones(read("src", "flightagent", "data", "airport_tz.json"));      // the page loads these on first use

const pad = n => String(n).padStart(2, "0");
/** Local time on `day` ("YYYY-MM-DD"), as the engine's naive datetimes. */
const at = (day, h = 10, m = 0) => `${day}T${pad(h)}:${pad(m)}:00`;
const seg = (o, d, dep, mins, code = "LY", num = "1") =>
  M.segment({ airline_code: code, flight_number: num, origin: o, destination: d, departs: dep, arrives: M.addMinutes(dep, mins) });
/** A one-way ticket; one 3h flight unless `segments` is given. */
const offer = (o, d, dep, price, code = "LY", extra = {}) =>
  M.offer({ origin: o, destination: d, price, currency: "USD", segments: [seg(o, d, dep, 180, code)], ...extra });

/** Provider driven by fn(origin, dest, day) -> offers; remembers every lookup and the last options it was given. */
function fake(fn, name = "fake") {
  const p = { name, calls: [], opts: null };
  p.oneWay = async (o, d, day, opts) => { p.calls.push([o, d, day]); p.opts = opts; return fn(o, d, day); };
  return p;
}

const req = (over = {}) => M.searchRequest({ destinations: ["ROM"], window_start: "2026-10-01", window_end: "2026-10-10",
  min_nights: 3, max_nights: 4, ...over });
const search = (provider, over = {}, cache = null) => new L.engine.Engine(provider, cache).search(req(over));
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { L, M, read, at, seg, offer, fake, req, search, sleep };
