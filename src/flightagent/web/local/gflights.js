/* Free Google Flights fares. A page can't read Google Flights itself (other
   origin), so Skyhop's Cloudflare Worker fetches the page and returns Google's result groups (worker/src/gflights.js);
   they are parsed here. Google may refuse the Worker, so backend.js puts SerpApi
   behind it (fallback()). */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const pad = n => String(n).padStart(2, "0");

  /** Google omits zero components: [8] is 08:00, [null, 31] is 00:31. */
  const time = v => { const [h, m] = [...(v || []), null, null]; return `${pad(h || 0)}:${pad(m || 0)}:00`; };
  /** gflights._at: value[i][j]..., or null where Google left a part out. */
  const at = (value, ...path) => { for (const i of path) { if (!Array.isArray(value) || value.length <= i) return null; value = value[i]; } return value ?? null; };
  const stamp = (ymd, hm) => `${ymd[0]}-${pad(ymd[1])}-${pad(ymd[2])}T${time(hm)}`;

  /** gflights.parse_groups: one Offer per group; a flight Google lists without a fare is kept, marked unpriced.
      `link` is the Google Flights page the fares came from (the Worker's `url`), `usual` its "usually costs" range. */
  function parse(groups, origin, dest, currency, link, usual) {
    return groups.map(entry => {
      const flight = entry[0];
      let price = null;
      try { price = entry[1][0][1]; } catch { /* no fare */ }
      const segments = flight[2].map(s => {
        const [code, number, , airline] = s[22];
        return L.models.segment({ airline_code: code, airline, flight_number: String(number), origin: s[3], destination: s[6],
          departs: stamp(s[20], s[8]), arrives: stamp(s[21], s[10]), duration_min: s[11], aircraft: s[17] || "", legroom: s[14] || "" });
      });
      const co2 = at(flight, 22, 7), typical = at(flight, 22, 8);
      return L.models.offer({ origin: segments[0].origin, destination: segments[segments.length - 1].destination, price: Number(price || 0),
        currency, segments, provider: "gflights", priced: !!price,
        deep_links: [link || L.mock.googleFlightsLink(origin, dest, segments[0].departs.slice(0, 10))],
        co2_g: co2, co2_typical_g: co2 == null ? null : typical, usual_price: usual || null });
    });
  }

  /** gflights._merge: a priced version of a flight replaces an unpriced one. */
  function merge(old, fresh) {
    const key = o => `${L.models.label(o)}|${L.models.departs(o)}`;
    const out = new Map(old.map(o => [key(o), o]));
    for (const o of fresh) { const k = key(o); if (!out.has(k) || (o.priced && !out.get(k).priced)) out.set(k, o); }
    return [...out.values()];
  }

  /** A provider that looks fares up through the Worker's /gflights. `get(path)` resolves with its JSON (account.js). */
  function provider(get, { retryUnpriced = 2, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    async function oneWay(origin, dest, day, { currency, adults, maxStops, children = 0, infants = 0, carryOnBags = 0, checkedBags = 0 }) {
      const q = new URLSearchParams({ origin, dest, date: day, currency, adults, max_stops: maxStops, children, infants,
        carry_on_bags: carryOnBags, checked_bags: checkedBags });
      let fetchedAt = null;     // the Worker may answer from its shared cache: keep the oldest fetch time
      const once = async () => {
        const r = await get(`/gflights?${q}`);
        if (r.fetched_at) fetchedAt = Math.min(fetchedAt ?? r.fetched_at, r.fetched_at);
        return parse(r.groups, origin, dest, currency, r.url, r.usual);
      };
      let offers = await once();
      // Google sometimes omits a fare it shows on the next request: ask again for unpriced flights 
      for (let i = 0; i < retryUnpriced && !offers.every(o => o.priced); i++) { await wait(1000); offers = merge(offers, await once()); }
      offers.fetched_at = fetchedAt;
      return offers;
    }
    return { name: "gflights", oneWay };
  }

  /** providers.FallbackProvider: answer from `backup` when `primary` fails; the engine counts which one answered and warns why. */
  function fallback(primary, backup) {
    async function oneWay(...args) {
      let offers, source = primary.name, why = "";
      try { offers = await primary.oneWay(...args); } catch (e) {     // say why, so a paid answer or a failure is never a mystery
        why = `${primary.name} failed (${e.message || e}), so ${backup.name} answered`;
        try { offers = await backup.oneWay(...args); } catch (e2) { throw new Error(`${primary.name}: ${e.message || e}; ${backup.name}: ${e2.message || e2}`); }
        source = backup.name;
      }
      offers.source = source;
      offers.fallback = why;
      return offers;
    }
    return { name: `${primary.name},${backup.name}`, oneWay };
  }

  L.gflights = { parse, merge, provider, fallback };
  if (typeof module !== "undefined" && module.exports) module.exports = L.gflights;
})(typeof window !== "undefined" ? window : globalThis);
