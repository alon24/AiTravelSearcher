/* Fare answers shared between everyone through Cloudflare's edge cache (caches.default), so two people searching the
   same route and day cost one Google lookup or one SerpApi credit, not two. Each answer carries `fetched_at` (Unix
   seconds) and the page shows how old its fares are, so a shared answer is never passed off as a fresh one. */

/** Seconds an answer is shared: as polling.fareTtl, shorter close to departure when fares move fast. */
export function fareTtl(day, now = Date.now()) {
  const daysOut = (Date.parse(`${day}T00:00:00Z`) - Date.parse(new Date(now).toISOString().slice(0, 10))) / 864e5;
  return daysOut <= 2 ? 15 * 60 : daysOut <= 14 ? 3600 : 3 * 3600;
}

/** Only full answers are shared: "no flights" may be a hiccup, and a Google answer with an unpriced flight is asked
    again by the page (web/local/gflights.js), which a shared copy would defeat. */
export function shareable(path, body) {
  if (path === "/gflights") return !!(body.groups || []).length && body.groups.every(g => typeof g?.[1]?.[0]?.[1] === "number");
  return !!((body.best_flights || []).length || (body.other_flights || []).length);
}

/** The cache key: the route and its parameters in a fixed order, so the same search always finds the same entry. */
export function cacheKey(url) {
  const params = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Request(`https://fare-cache.skyhop${url.pathname}?${new URLSearchParams(params)}`);
}

/** A shared answer for this lookup, or `fresh()` (which may spend) with `fetched_at` added and, when full, shared. */
export async function cachedFares(url, json, fresh) {
  const cache = globalThis.caches && globalThis.caches.default, key = cacheKey(url);
  const hit = cache && await cache.match(key);
  if (hit) return json(await hit.json());
  const r = await fresh();
  if (!r.ok) return r;
  const body = { ...(await r.json()), fetched_at: Math.floor(Date.now() / 1000) };
  if (cache && shareable(url.pathname, body)) {
    await cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json",
      "Cache-Control": `max-age=${fareTtl(url.searchParams.get("date"))}` } }));
  }
  return json(body);
}
