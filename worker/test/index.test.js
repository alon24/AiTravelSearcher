import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { serpapiParams, jevRequest, chatRequest, _serpapi, _authCache } from "../src/index.js";

const ENV = { GOOGLE_CLIENT_ID: "client-1", SERPAPI_API_KEY: "serp-key", OPENROUTER_API_KEY: "or-key", APP_TOKEN: "app-secret" };
let calls;

/** Answers outgoing fetches from `routes` (first matching prefix wins) and records them. */
function stubFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [prefix, answer] of routes) if (String(url).startsWith(prefix)) return answer(String(url), init);
    throw new Error(`unexpected fetch ${url}`);
  };
}
const reply = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
const tokeninfo = over => reply({ aud: "client-1", email: "ilan@example.com", email_verified: "true", expires_in: "3599", ...over });
const call = (path, { token, appToken, method = "GET", body, env = ENV } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (appToken) headers["X-App-Token"] = appToken;
  return worker.fetch(new Request(`https://w.example${path}`, { method, headers, body }), env);
};

beforeEach(() => _authCache.clear());

test("health says what is configured and who is calling, without signing in", async () => {
  stubFetch([["https://oauth2.googleapis.com/tokeninfo", tokeninfo()]]);
  assert.deepEqual(await (await call("/health")).json(), { gflights: true, serpapi: true, jev: true, chat: true, sign_in: true, trips: false, user: null, guest: null });
  assert.equal((await (await call("/health", { token: "t1" })).json()).user, "ilan@example.com");
  assert.equal((await call("/health", { env: {} }).then(r => r.json())).serpapi, false);
});

test("every other route needs an accepted Google token or the app token", async () => {
  stubFetch([["https://oauth2.googleapis.com/tokeninfo", tokeninfo()]]);
  assert.equal((await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02")).status, 401);
  assert.equal((await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02", { appToken: "wrong" })).status, 401);
  assert.equal((await call("/nope", { appToken: "app-secret" })).status, 404);
});

test("a token Google issued to another app, or an unverified email, is refused", async () => {
  for (const [i, over] of [{ aud: "someone-else", azp: "x" }, { email_verified: "false" }, { email: "" }].entries()) {
    stubFetch([["https://oauth2.googleapis.com/tokeninfo", tokeninfo(over)]]);
    assert.equal((await call("/decide", { token: `bad${i}`, method: "POST", body: "{}" })).status, 401);
  }
  stubFetch([["https://oauth2.googleapis.com/tokeninfo", reply({ error: "invalid_token" }, 400)]]);
  assert.equal((await call("/decide", { token: "expired", method: "POST", body: "{}" })).status, 401);
});

test("ALLOWED_EMAILS limits which accounts may use the keys", async () => {
  stubFetch([["https://oauth2.googleapis.com/tokeninfo", tokeninfo({ email: "Stranger@Example.com" })]]);
  const env = { ...ENV, ALLOWED_EMAILS: "ilan@example.com, friend@example.com" };
  assert.equal((await (await call("/health", { token: "s", env })).json()).user, null);
  stubFetch([["https://oauth2.googleapis.com/tokeninfo", tokeninfo({ email: "Friend@Example.com" })]]);
  assert.equal((await (await call("/health", { token: "f", env })).json()).user, "friend@example.com");
});

test("Google is asked once per token while the answer is fresh", async () => {
  stubFetch([["https://oauth2.googleapis.com/tokeninfo", tokeninfo()], ["https://serpapi.com/", reply({ best_flights: [] })]]);
  await call("/health", { token: "same" });
  await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02", { token: "same" });
  assert.equal(calls.filter(c => c.url.includes("tokeninfo")).length, 1);
});

test("serpapi params mirror the Python provider: city codes expand, stops map, kids only when present", () => {
  const { params } = serpapiParams(new URLSearchParams("origin=tlv&dest=ROM&date=2026-11-02&currency=eur&adults=2&max_stops=0&infants=1"));
  assert.deepEqual(params, { engine: "google_flights", type: "2", hl: "en", departure_id: "TLV", arrival_id: "FCO,CIA",
    outbound_date: "2026-11-02", currency: "EUR", adults: "2", stops: "1", infants_on_lap: "1" });
  assert.equal(serpapiParams(new URLSearchParams("origin=TLV&dest=ROM&date=2026-11-02")).params.stops, "2");
  for (const bad of ["origin=TL&dest=ROM&date=2026-11-02", "origin=TLV&dest=ROM&date=tomorrow",
    "origin=TLV&dest=ROM&date=2026-11-02&adults=0", "origin=TLV&dest=ROM&date=2026-11-02&max_stops=7",
    "origin=TLV&dest=ROM&date=2026-11-02&currency=dollars"]) {
    assert.ok(serpapiParams(new URLSearchParams(bad)).error, bad);
  }
});

test("a lookup adds the key, passes back only the flights, and treats 'no results' as empty", async () => {
  stubFetch([["https://serpapi.com/", reply({ best_flights: [{ price: 1 }], other_flights: [], search_metadata: { google_flights_url: "https://g/f" }, extra: "x" })]]);
  const r = await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02", { appToken: "app-secret" });
  assert.deepEqual(await r.json(), { best_flights: [{ price: 1 }], other_flights: [], google_flights_url: "https://g/f" });
  assert.equal(new URL(calls[0].url).searchParams.get("api_key"), "serp-key");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  stubFetch([["https://serpapi.com/", reply({ error: "Google Flights hasn't returned any results for this query." })]]);
  assert.deepEqual(await (await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02", { appToken: "app-secret" })).json(), { best_flights: [], other_flights: [] });
  stubFetch([["https://serpapi.com/", reply({ error: "Invalid API key." }, 401)]]);
  assert.equal((await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02", { appToken: "app-secret" })).status, 502);
});

test("a rate-limited lookup is retried with backoff, then gives up", async () => {
  let n = 0;
  stubFetch([["https://serpapi.com/", () => (++n < 3 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ best_flights: [] })))]]);
  const waits = [];
  const r = await _serpapi(new URL("https://w/serpapi?origin=TLV&dest=ROM&date=2026-11-02"), ENV, async ms => waits.push(ms));
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [1000, 2000]);
  stubFetch([["https://serpapi.com/", () => new Response("{}", { status: 503 })]]);
  assert.equal((await _serpapi(new URL("https://w/serpapi?origin=TLV&dest=ROM&date=2026-11-02"), ENV, async () => {})).status, 502);
  assert.equal(calls.length, 4);
});

test("missing keys answer 503 rather than calling out", async () => {
  stubFetch([]);
  assert.equal((await call("/serpapi?origin=TLV&dest=ROM&date=2026-11-02", { appToken: "a", env: { APP_TOKEN: "a" } })).status, 503);
  assert.equal((await call("/decide", { appToken: "a", method: "POST", body: "{}", env: { APP_TOKEN: "a" } })).status, 503);
});

test("jev requests are shaped like decide.to_jev_request and bounded", () => {
  const { request } = jevRequest({ state: "a page", questions: { ok: { type: "noul", text: "Is it open?" } } }, "m");
  assert.deepEqual(request, { model: "m", state: { text: "a page" },
    questions: { ok: { type: "noul", text: "Is it open?", criteria: { true: "Yes, the statement holds.", false: "No, the statement does not hold." } } } });
  assert.deepEqual(jevRequest({ state: { a: 1 }, questions: { q: { type: "enum", criteria: { x: "y" } } } }, "m").request.state, { a: 1 });
  assert.ok(jevRequest({ state: "x" }, "m").error);
  assert.ok(jevRequest({ state: "x".repeat(12_001), questions: {} }, "m").error);
  assert.ok(jevRequest({ state: "x", questions: Object.fromEntries([...Array(9)].map((_, i) => [i, {}])) }, "m").error);
});

test("decide forwards to Jev with the key and answers like the Python service", async () => {
  stubFetch([["https://openrouter.ai/api/alpha/decisions", reply({ answers: { ok: true }, usage: { cost: 0.0004 }, model: "typesafe/jev-1.13" })]]);
  const r = await call("/decide", { appToken: "app-secret", method: "POST", body: JSON.stringify({ state: "s", questions: { ok: { type: "noul" } } }) });
  assert.deepEqual(await r.json(), { answers: { ok: true }, cost: 0.0004, model: "typesafe/jev-1.13", backend: "jev" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer or-key");
  assert.equal(JSON.parse(calls[0].init.body).model, "typesafe/jev-1.13");
  assert.equal((await call("/decide", { appToken: "app-secret", method: "POST", body: "not json" })).status, 400);
  assert.equal((await call("/decide", { appToken: "app-secret", method: "POST", body: JSON.stringify({ state: "s" }) })).status, 422);
});

test("preflight requests get CORS headers", async () => {
  const r = await call("/serpapi", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("chat relays one turn with the page's tools and the key", async () => {
  stubFetch([["https://openrouter.ai/api/v1/chat/completions", reply({ choices: [{ message: { role: "assistant", content: "Hi" } }] })]]);
  const tools = [{ type: "function", function: { name: "search_flights" } }];
  const r = await call("/chat", { appToken: "app-secret", method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Rome" }], tools }) });
  assert.deepEqual(await r.json(), { message: { role: "assistant", content: "Hi" } });
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.tools, tools);
  assert.equal(sent.model, "openai/gpt-4o-mini");
  assert.equal(calls[0].init.headers.Authorization, "Bearer or-key");
  stubFetch([["https://openrouter.ai/", reply({ error: "x" }, 500)]]);
  assert.equal((await call("/chat", { appToken: "app-secret", method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) })).status, 502);
});

test("chat requests are bounded like the Python relay", () => {
  const user = { role: "user", content: "x" };
  assert.equal(chatRequest({ messages: [user], json_mode: true }, "m").request.response_format.type, "json_object");
  assert.equal(chatRequest({ messages: [user] }, "m").request.tools, undefined);
  for (const bad of [{}, { messages: [] }, { messages: [{ role: "boss" }] }, { messages: Array(81).fill(user) },
    { messages: [{ role: "user", content: "x".repeat(80_001) }] }, { messages: [user], tools: Array(5).fill({}) }]) {
    assert.ok(chatRequest(bad, "m").error, JSON.stringify(bad).slice(0, 60));
  }
});
