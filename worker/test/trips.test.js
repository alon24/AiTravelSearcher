import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { SharedTrip, _authCache } from "../src/index.js";
import { LIMITS } from "../src/trips.js";

/** Durable Object storage in memory (get/put/list with prefix and start, sorted like Cloudflare's). */
class Storage {
  constructor() { this.m = new Map(); }
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async list({ prefix = "", start = "" } = {}) {
    return new Map([...this.m].filter(([k]) => k.startsWith(prefix) && k >= start).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)]));
  }
}
function namespace() {
  const objects = new Map();
  return { objects, idFromName: n => n, get: n => {
    if (!objects.has(n)) objects.set(n, new SharedTrip({ storage: new Storage() }));
    return { fetch: (url, init = {}) => objects.get(n).fetch(new Request(url, init)) };
  } };
}

const PEOPLE = { "tok-ilan": "ilan@example.com", "tok-dana": "dana@example.com" };
let env, upstream;
beforeEach(() => {
  _authCache.clear();
  env = { GOOGLE_CLIENT_ID: "client-1", ALLOWED_EMAILS: "ilan@example.com", SERPAPI_API_KEY: "s", OPENROUTER_API_KEY: "o", TRIPS: namespace() };
  upstream = [];
  globalThis.fetch = async url => {
    url = String(url);
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      const email = PEOPLE[new URL(url).searchParams.get("access_token")];
      return new Response(JSON.stringify(email ? { aud: "client-1", email, email_verified: "true", expires_in: "3000" } : { error: "bad" }), { status: email ? 200 : 400 });
    }
    upstream.push(url);
    if (url.startsWith("https://openrouter.ai/")) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    return new Response(JSON.stringify({ best_flights: [] }));
  };
});
const call = (path, token, { method = "GET", body, trip } = {}) => {
  const headers = { Authorization: `Bearer ${token}` };
  if (trip) headers["X-Trip"] = trip;
  return worker.fetch(new Request(`https://w.example${path}`, { method, headers, body: body && JSON.stringify(body) }), env);
};
async function startTrip() {
  const r = await call("/trips", "tok-ilan", { method: "POST", body: { title: "Portugal in November", request: { destinations: ["LIS"] },
    messages: [{ kind: "user", text: "Portugal for a week?" }, { kind: "ai", author: "ai", text: "Lisbon from 400." }] } });
  assert.equal(r.status, 201);
  return (await r.json()).id;
}

test("health tells a guest apart from an allowed account", async () => {
  assert.deepEqual(await (await call("/health", "tok-dana")).json(), { gflights: true, serpapi: true, jev: true, chat: true, sign_in: true, trips: true, links: false, user: null, guest: "dana@example.com" });
  assert.equal((await (await call("/health", "tok-ilan")).json()).user, "ilan@example.com");
});

test("an allowed account starts a trip with the conversation so far; a guest can't start one", async () => {
  const id = await startTrip();
  assert.match(id, /^[a-z0-9]{12}$/);
  const trip = await (await call(`/trips/${id}`, "tok-ilan")).json();
  assert.equal(trip.title, "Portugal in November");
  assert.deepEqual(trip.messages.map(m => [m.seq, m.author, m.text]), [[1, "ilan@example.com", "Portugal for a week?"], [2, "ai", "Lisbon from 400."]]);
  assert.deepEqual(trip.request, { destinations: ["LIS"] });
  assert.equal((await call("/trips", "tok-dana", { method: "POST", body: { title: "x" } })).status, 403);
});

test("anyone signed in with the link joins, posts, and reads only what is new", async () => {
  const id = await startTrip();
  const joined = await (await call(`/trips/${id}`, "tok-dana")).json();
  assert.deepEqual(joined.members, ["ilan@example.com", "dana@example.com"]);
  const posted = await (await call(`/trips/${id}/messages`, "tok-dana", { method: "POST", body: { kind: "user", text: "Porto too!" } })).json();
  assert.equal(posted.author, "dana@example.com");
  const fresh = await (await call(`/trips/${id}?since=2`, "tok-ilan")).json();
  assert.deepEqual(fresh.messages.map(m => m.text), ["Porto too!"]);
  const map = await call(`/trips/${id}/messages`, "tok-ilan", { method: "POST", body: { kind: "map", text: "", data: { id: "m1", title: "Portugal" } } });
  assert.equal(map.status, 200, "a MyMaps AI map made from the trip is a message too");
  assert.equal(fresh.spent, undefined, "the allowance bookkeeping stays private");
  await call(`/trips/${id}`, "tok-dana", { method: "PATCH", body: { title: "Portugal + Porto", brief: { title: "b" } } });
  assert.equal((await (await call(`/trips/${id}`, "tok-ilan")).json()).title, "Portugal + Porto");
});

test("bad trips, kinds and sizes are refused", async () => {
  const id = await startTrip();
  assert.equal((await call("/trips/nope", "tok-ilan")).status, 404);
  assert.equal((await call("/trips/abcdefabcdef", "tok-ilan")).status, 404);
  assert.equal((await call(`/trips/${id}/messages`, "tok-dana", { method: "POST", body: { kind: "system", text: "x" } })).status, 422);
  assert.equal((await call(`/trips/${id}/messages`, "tok-dana", { method: "POST", body: { kind: "user", text: "  " } })).status, 422);
  assert.equal((await call(`/trips/${id}/messages`, "tok-dana", { method: "POST", body: { kind: "search", text: "s", data: "x".repeat(LIMITS.data + 1) } })).status, 413);
  assert.equal((await call(`/trips/${id}`, "nobody")).status, 401);
});

test("a guest uses the AI and real fares only inside a trip, out of its daily allowance", async () => {
  const id = await startTrip();
  const ask = trip => call("/chat", "tok-dana", { method: "POST", trip, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal((await ask()).status, 403, "outside a trip a guest can't spend the keys");
  assert.equal((await ask("abcdefabcdef")).status, 404);
  assert.equal((await ask(id)).status, 200);
  assert.equal((await call("/serpapi?origin=TLV&dest=LIS&date=2026-11-02", "tok-dana", { trip: id })).status, 200);
  for (let i = 1; i < LIMITS.chat; i++) await ask(id);
  assert.equal((await ask(id)).status, 429, "the trip's daily allowance is used up");
  assert.equal((await call("/chat", "tok-ilan", { method: "POST", body: { messages: [{ role: "user", content: "hi" }] } })).status, 200, "the owner is never limited");
  assert.equal((await call("/decide", "tok-dana", { method: "POST", body: {} })).status, 403);
});
