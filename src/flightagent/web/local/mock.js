/* Demo fares: deterministic fake flights (see rng.js), the same on every load, for signed-out visitors and tests.
   Always labelled as demo in the page, never shown as real. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});

  const AIRLINES = {
    LY: "El Al", W6: "Wizz Air", FR: "Ryanair", U2: "easyJet", TK: "Turkish Airlines", A3: "Aegean", OS: "Austrian",
    LH: "Lufthansa", PC: "Pegasus", LO: "LOT",
  };
  const CODES = Object.keys(AIRLINES);
  const HUBS = ["IST", "ATH", "VIE", "FRA", "WAW", "BUD", "LCA", "SAW"];
  const pad = n => String(n).padStart(2, "0");

  function googleFlightsLink(origin, dest, day) {
    return "https://www.google.com/travel/flights?q=" + encodeURIComponent(`Flights from ${origin} to ${dest} on ${day} one way`);
  }

  async function oneWay(origin, dest, day, { currency, adults, maxStops, children = 0, infants = 0, carryOnBags = 0, checkedBags = 0 }) {
    const M = L.models, seeded = L.rng.seeded;
    const route = await seeded("route", ...[origin, dest].sort());
    const base = route.uniform(50, 220);
    const weekdayFactor = { 4: 1.25, 6: 1.2, 5: 1.1 }[M.weekday(day)] ?? 0.95;
    const offers = [];

    function make(hubs, price, dep, r) {
      const points = [origin, ...hubs, dest], segs = [];
      let t = dep;
      for (let i = 0; i < points.length - 1; i++) {
        const code = r.choice(CODES), fly = r.randint(90, 260);
        segs.push(M.segment({ airline_code: code, airline: AIRLINES[code], flight_number: String(r.randint(100, 9999)),
          origin: points[i], destination: points[i + 1], departs: t, arrives: M.addMinutes(t, fly) }));
        t = M.addMinutes(t, fly + r.choice([45, 75, 120, 240, 600, 1080]));
      }
      const bags = ["FR", "W6", "U2"].includes(segs[0].airline_code) ? 25 * carryOnBags + 40 * checkedBags : 0;
      return M.offer({ origin, destination: dest, price: M.round2(price * (adults + children) + 20 * infants + bags),
        currency, segments: segs, provider: "mock", deep_links: [googleFlightsLink(origin, dest, day)] });
    }
    const at = (h, m) => `${day}T${pad(h)}:${pad(m)}:00`;
    const others = HUBS.filter(h => h !== origin && h !== dest);

    if (route.random() < 0.7) {          // direct flights exist on ~70% of routes
      for (let k = 0; k < 2; k++) {
        const r = await seeded("direct", origin, dest, day, k);
        const dep = at(r.randint(5, 22), r.choice([0, 15, 30, 45]));
        offers.push(make([], base * weekdayFactor * r.uniform(0.9, 1.35), dep, r));
      }
    }
    if (maxStops >= 1) {
      for (let k = 0; k < 3; k++) {
        const r = await seeded("stop1", origin, dest, day, k);
        const hub = r.choice(others);
        const dep = at(r.randint(5, 20), r.choice([0, 30]));
        offers.push(make([hub], base * weekdayFactor * r.uniform(0.6, 0.95), dep, r));
      }
    }
    if (maxStops >= 2) {
      const r = await seeded("stop2", origin, dest, day);
      const hubs = r.sample(others, 2);
      const dep = at(r.randint(5, 18), 0);
      offers.push(make(hubs, base * weekdayFactor * 0.55, dep, r));
    }
    return offers;
  }

  L.mock = { name: "mock", oneWay, googleFlightsLink };
  if (typeof module !== "undefined" && module.exports) module.exports = L.mock;
})(typeof window !== "undefined" ? window : globalThis);
