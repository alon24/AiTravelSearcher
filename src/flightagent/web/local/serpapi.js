/* providers/serpapi.py in the browser: real Google Flights fares through SerpApi. The page never sees the SerpApi key;
   it asks Skyhop's Cloudflare Worker (worker/), which adds the key, and parses the answer exactly as the Python provider. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});

  const localTime = s => `${s.replace(" ", "T")}:00`;      // SerpApi's "2026-10-05 08:30" -> our naive local datetime

  /** SerpApiProvider.parse: priced items with flights, best first, each a one-way Offer. */
  function parse(data, origin, dest, day, currency) {
    const link = (data.search_metadata || {}).google_flights_url || data.google_flights_url || L.mock.googleFlightsLink(origin, dest, day);
    const offers = [];
    for (const item of [...(data.best_flights || []), ...(data.other_flights || [])]) {
      if (!("price" in item) || !(item.flights || []).length) continue;
      const segments = item.flights.map(f => {
        const num = f.flight_number ?? "??  ", at = num.indexOf(" ");
        return L.models.segment({ airline_code: at < 0 ? num : num.slice(0, at), airline: f.airline || "", flight_number: at < 0 ? "" : num.slice(at + 1),
          origin: f.departure_airport.id, destination: f.arrival_airport.id, departs: localTime(f.departure_airport.time),
          arrives: localTime(f.arrival_airport.time), duration_min: f.duration ?? null });
      });
      offers.push(L.models.offer({ origin: segments[0].origin, destination: segments[segments.length - 1].destination,
        price: Number(item.price), currency, segments, deep_links: [link], provider: "serpapi" }));
    }
    return offers;
  }

  /** A provider that looks fares up through the Worker. `get(path)` resolves with the Worker's JSON (see account.js). */
  function provider(get) {
    async function oneWay(origin, dest, day, { currency, adults, maxStops, children = 0, infants = 0 }) {   // bags: not used, as in Python
      const q = new URLSearchParams({ origin, dest, date: day, currency, adults, max_stops: maxStops, children, infants });
      return parse(await get(`/serpapi?${q}`), origin, dest, day, currency);
    }
    return { name: "serpapi", oneWay };
  }

  L.serpapi = { parse, provider };
  if (typeof module !== "undefined" && module.exports) module.exports = L.serpapi;
})(typeof window !== "undefined" ? window : globalThis);
