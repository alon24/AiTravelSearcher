"use strict";
/* Travel Hub link (alon24/travel-hub): the hub opens Skyhop with a search filled in, and Skyhop sends the flights
   the person picked back to the hub's Trip.
     in:  ?from=TLV&to=LIS&back=OPO&start=2026-11-13&end=2026-11-22&nights=3&adults=3&children=7,9&trip=<id>&hub=<hub url>
     out: <hub url>#/handoff/<base64url JSON>   (contract v1; the hub validates it with zod, see its src/model/handoff.ts)
   Pure functions here (tested by hub.test.js under node); app.js wires them to the form and the result cards. */
(function (root) {
  const KEY = "skyhop.hub";
  const DEFAULT_HUB = "https://alon24.github.io/travel-hub/";
  const IATA = /^[A-Z]{3}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;

  /** Only a real web address may receive the flights (never javascript: or data:). */
  function safeHub(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.origin + u.pathname;
    } catch { /* not a URL */ }
    return null;
  }

  /** The hub's search parameters → a partial form plus the trip context, or null when the link has none. */
  function fromParams(search) {
    const q = new URLSearchParams(search);
    const code = k => (q.get(k) || "").toUpperCase();
    if (!IATA.test(code("from")) || !IATA.test(code("to")) || !DAY.test(q.get("start") || "") || !DAY.test(q.get("end") || "")) return null;
    const nights = Math.max(1, Math.min(60, parseInt(q.get("nights"), 10) || 0));
    const adults = Math.max(1, Math.min(9, parseInt(q.get("adults"), 10) || 1));
    const kids = (q.get("children") || "").split(",").filter(Boolean).map(Number).filter(a => Number.isInteger(a) && a >= 0 && a <= 17);
    const form = { from: [code("from")], to: [code("to")], back: IATA.test(code("back")) ? [code("back")] : [], start: q.get("start"), end: q.get("end"), adults, kids };
    if (q.get("nights")) Object.assign(form, { nmin: nights, nmax: nights, lenMode: "exact", unit: "nights" });
    const trip = (q.get("trip") || "").match(/^[\w-]{1,64}$/) ? q.get("trip") : null;
    return { form, context: { trip, hub: safeHub(q.get("hub") || "") || DEFAULT_HUB } };
  }

  function base64url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = ""; bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Picked one-way flights (Skyhop offers) → the hub's handoff JSON. Prices are totals for everyone travelling. */
  function payload(offers, { trip = null, searchId = null, adults = 1, kids = [], currency = "USD", cityOf = () => "" } = {}) {
    const names = {};
    const legs = offers.map(o => {
      const first = o.segments[0], last = o.segments[o.segments.length - 1];
      [o.origin, o.destination].forEach(c => { const city = cityOf(c); if (city) names[c] = city; });
      return {
        origin: o.origin, destination: o.destination, departs: first.departs, arrives: last.arrives,
        airlines: [...new Set(o.segments.map(s => s.airline || s.airline_code))], flightNumbers: o.segments.map(s => `${s.airline_code}${s.flight_number}`),
        stops: o.segments.length - 1,
        ...(o.priced !== false && o.currency === currency ? { price: o.price } : {}),
        ...((o.deep_links || [])[0] ? { bookingUrl: o.deep_links[0] } : {}),
      };
    });
    return { v: 1, kind: "flights", source: "skyhop", ...(trip ? { tripId: trip } : {}), ...(searchId ? { searchId } : {}),
      currency, adults, childrenAges: kids, names, legs };
  }

  const handoffUrl = (hub, data) => `${safeHub(hub) || DEFAULT_HUB}#/handoff/${base64url(JSON.stringify(data))}`;

  const context = () => { try { return JSON.parse(root.localStorage.getItem(KEY)); } catch { return null; } };
  const remember = ctx => { try { root.localStorage.setItem(KEY, JSON.stringify(ctx)); } catch { /* private mode */ } };

  const api = { KEY, DEFAULT_HUB, safeHub, fromParams, payload, handoffUrl, context, remember };
  root.SkyhopHub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
