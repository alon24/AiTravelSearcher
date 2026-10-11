import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { _authCache } from "../src/index.js";
import { gflightsQuery, readPage, resultGroups } from "../src/gflights.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../../tests/fixtures/gflights_tlv_fco_2026-10-05.json", import.meta.url), "utf8"));
/** A Google Flights page as the scraper sees it: the results ride in the `ds:1` script. */
export const page = payload => `<html><body><script class="ds:1" nonce="x">AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify(payload)}, sideChannel: {}});</script></body></html>`;
const PAYLOAD = [null, null, [FIXTURE.best], [FIXTURE.other]];

let google;
beforeEach(() => {
  _authCache.clear();
  google = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo"))
      return new Response(JSON.stringify({ aud: "client-1", email: "ilan@example.com", email_verified: "true", expires_in: "3000" }));
    google.push({ url, init });
    return new Response(google.answer ?? page(PAYLOAD));
  };
});
const call = (path, env = { GOOGLE_CLIENT_ID: "client-1" }) => worker.fetch(new Request(`https://w.example${path}`, { headers: { Authorization: "Bearer t" } }), env);

test("a lookup returns Google's best and other result groups, with no key needed", async () => {
  const r = await call("/gflights?origin=TLV&dest=FCO&date=2026-10-05&currency=eur");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.groups, [...FIXTURE.best, ...FIXTURE.other]);
  assert.equal(body.url, google[0].url);   // the page links each fare to the exact search that priced it
  const url = new URL(google[0].url);
  assert.equal(url.origin + url.pathname, "https://www.google.com/travel/flights");
  assert.equal(url.searchParams.get("curr"), "EUR");
  assert.match(google[0].init.headers["User-Agent"], /Chrome/);
});

test("a page without results says why, after one retry", async () => {
  google.answer = "<html><body>Our systems have detected unusual traffic from your computer network.</body></html>";
  const r = await call("/gflights?origin=TLV&dest=FCO&date=2026-10-05");
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /robot check/);
  assert.equal(google.length, 2);
});

test("the page's price insight gives the range Google says the search usually costs", () => {
  const insight = [5, [null, 124], [null, 66], [null, -59], [null, 60], [null, 110]];
  assert.deepEqual(readPage(page([null, null, [FIXTURE.best], [FIXTURE.other], null, insight])).usual, [60, 110]);
  assert.equal(readPage(page(PAYLOAD)).usual, null);
});

test("Google's landing page is an error, not 'no flights'", () => {
  const script = `<script class="ds:1">AF_initDataCallback({key: 'ds:1', data:[null,null,null,null], sideChannel: {}});</script>`;
  assert.throws(() => resultGroups(`<html><head><title>Find Cheap Flights Worldwide & Track Prices</title></head><body>${script}</body></html>`), /landing page/);
  assert.deepEqual(resultGroups(`<html><head><title>Tel Aviv to Rome</title></head><body>${script}</body></html>`), []);
});

test("Google's own 'no flights' answer is an empty list, not an error", () => {
  const html = `<script class="ds:1">AF_initDataCallback({key: 'ds:1', data:null, errorHasStatus: true, sideChannel: {}});</script>`;
  assert.deepEqual(resultGroups(html), []);
});

test("bad queries are refused before Google is asked", async () => {
  for (const q of ["origin=TL&dest=FCO&date=2026-10-05", "origin=TLV&dest=FCO&date=5.10.2026", "origin=TLV&dest=FCO&date=2026-10-05&adults=0",
                   "origin=TLV&dest=FCO&date=2026-10-05&checked_bags=9"])
    assert.ok(gflightsQuery(new URLSearchParams(q)).error, q);
  assert.equal((await call("/gflights?origin=TLV&dest=FCO&date=bad")).status, 400);
  assert.equal(google.length, 0);
});

test("a guest looks fares up only inside a shared trip", async () => {
  const r = await call("/gflights?origin=TLV&dest=FCO&date=2026-10-05", { GOOGLE_CLIENT_ID: "client-1", ALLOWED_EMAILS: "someone@example.com" });
  assert.equal(r.status, 403);
});
