/* verify.py in the browser: a trip's flights looked up again on the other fare source (Google Flights <-> SerpApi) and
   matched by airline, flight number and departure minute of every segment, never by price. Parity-tested. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const RANK = { confirmed: 0, error: 1, not_found: 2, price_differs: 3 };

  const tolerance = price => Math.max(Math.abs(price) * 0.03, 5);
  const number = n => String(n).replace(/ /g, "").toUpperCase().replace(/^0+/, "") || "0";
  const flightKey = segs => segs.map(s => `${s.airline_code.trim().toUpperCase()}|${number(s.flight_number)}|${s.departs.slice(0, 16)}`).join("/");
  const label = s => `${s.airline_code}${s.flight_number}`.replace(/ /g, "");

  /** The separately bought tickets of a leg: one, or two for a self-transfer, split where they meet at the hub.
      `cities` is providers/airports.py CITY_AIRPORTS (config.json), to read a city hub such as ROM. */
  function tickets(leg, cities = {}) {
    if (!leg.self_transfer) return [leg.segments];
    const hub = leg.hub ? new Set([leg.hub, ...(cities[leg.hub] || leg.hub).split(",")]) : new Set();
    const i = leg.segments.slice(0, -1).findIndex(s => hub.has(s.destination));
    return i < 0 ? null : [leg.segments.slice(0, i + 1), leg.segments.slice(i + 1)];
  }
  const lookupKey = segs => `${segs[0].origin}|${segs[segs.length - 1].destination}|${segs[0].departs.slice(0, 10)}`;
  const lookups = (legs, cities) => [...new Set(legs.flatMap(leg => (tickets(leg, cities) || []).map(lookupKey)))];

  /** {status, price, seen_price, note} for one leg; `found` and `errors` are keyed by lookupKey. */
  function judge(leg, found, errors, source, cities) {
    const out = (status, note = "", seen = null) => ({ status, price: leg.price, seen_price: seen, note });
    const parts = tickets(leg, cities);
    if (!parts) return out("error", "a self-transfer saved without its hub: search again to check it");
    let seen = 0;
    const missing = [];
    for (const segs of parts) {
      const k = lookupKey(segs);
      if (k in errors) return out("error", `${source}: ${errors[k]}`);
      const same = (found[k] || []).filter(o => flightKey(o.segments) === flightKey(segs)), priced = same.filter(o => o.priced).map(o => o.price);
      if (!priced.length) missing.push(segs.map(label).join("+") + (same.length ? " (listed without a price)" : ""));
      else seen += priced.reduce((best, p) => (Math.abs(p - leg.price / parts.length) < Math.abs(best - leg.price / parts.length) ? p : best));
    }
    if (missing.length) return out("not_found", `${source} doesn't list ${missing.join(", ")}`);
    seen = Math.round(seen * 100) / 100;
    return out(Math.abs(seen - leg.price) <= tolerance(leg.price) ? "confirmed" : "price_differs", "", seen);
  }

  const worst = results => results.map(r => r.status).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  /** The real-fare source available that did not price these legs, or null. */
  const secondSource = (available, legs) => available.find(n => ["gflights", "serpapi"].includes(n) && !legs.some(l => l.provider === n)) || null;

  L.verify = { tickets, lookupKey, lookups, judge, worst, secondSource, tolerance };
  if (typeof module !== "undefined" && module.exports) module.exports = L.verify;
})(typeof window !== "undefined" ? window : globalThis);
