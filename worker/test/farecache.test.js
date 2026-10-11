import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { fareTtl, shareable, cacheKey } from "../src/farecache.js";

const ENV = { GOOGLE_CLIENT_ID: "client-1", SERPAPI_API_KEY: "serp-key", APP_TOKEN: "app-secret" };
let upstream;

/** caches.default as Cloudflare's: match/put by URL, keeping the Cache-Control it was given. */
function fakeCache() {
  const store = new Map();
  globalThis.caches = { default: {
    match: async req => { const e = store.get(req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
    put: async (req, res) => { store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); },
  } };
  return store;
}
function serp(body) {
  upstream = 0;
  globalThis.fetch = async url => { upstream++; assert.match(String(url), /^https:\/\/serpapi\.com\//); return new Response(JSON.stringify(body)); };
}
const call = (path, headers = { "X-App-Token": "app-secret" }) => worker.fetch(new Request(`https://w.example${path}`, { headers }), ENV);
const LOOKUP = "/serpapi?origin=TLV&dest=FCO&date=2030-05-01&currency=USD";

afterEach(() => { delete globalThis.caches; });

test("the same lookup twice costs one SerpApi credit and the second answer says how old it is", async () => {
  const store = fakeCache();
  serp({ best_flights: [{ price: 99, flights: [{}] }] });
  const first = await (await call(LOOKUP)).json();
  const again = await call("/serpapi?currency=USD&date=2030-05-01&dest=FCO&origin=TLV");    // same search, other order
  assert.equal(upstream, 1);
  assert.deepEqual(await again.json(), first);
  assert.equal(again.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal([...store.values()][0].headers["cache-control"], "max-age=10800");
});

test("a cached answer still needs a signed-in caller", async () => {
  fakeCache();
  serp({ best_flights: [{ price: 99 }] });
  await call(LOOKUP);
  assert.equal((await call(LOOKUP, {})).status, 401);
});

test("empty answers and failures are not shared", async () => {
  const store = fakeCache();
  serp({ best_flights: [], other_flights: [] });
  await call(LOOKUP); await call(LOOKUP);
  assert.equal(upstream, 2);
  serp({ error: "Invalid API key." });
  assert.equal((await call(LOOKUP)).status, 502);
  assert.equal(store.size, 0);
});

test("a Google answer is shared only when every flight has a price (the page asks again for missing ones)", () => {
  const priced = [[{}, [[null, 120]]]], unpriced = [[{}, [[null, 120]]], [{}, null]];
  assert.equal(shareable("/gflights", { groups: priced }), true);
  assert.equal(shareable("/gflights", { groups: unpriced }), false);
  assert.equal(shareable("/gflights", { groups: [] }), false);
});

test("answers are shared for less time close to departure", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(fareTtl("2026-10-12", now), 15 * 60);
  assert.equal(fareTtl("2026-10-20", now), 3600);
  assert.equal(fareTtl("2026-12-01", now), 3 * 3600);
  assert.equal(cacheKey(new URL("https://w/gflights?b=2&a=1")).url, "https://fare-cache.skyhop/gflights?a=1&b=2");
});
