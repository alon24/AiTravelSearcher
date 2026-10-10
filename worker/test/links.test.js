import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { SearchLinks, _authCache } from "../src/index.js";
import { badTemplate } from "../src/links.js";

const PEOPLE = { "tok-ilan": "ilan@example.com", "tok-dana": "dana@example.com" };
const WIZZ = "https://www.wizzair.com/en-gb/booking/select-flight/{origin}/{dest}/{date}/null/1/0/0/null";
let env;
beforeEach(() => {
  _authCache.clear();
  const store = new Map(), obj = new SearchLinks({ storage: { get: async k => structuredClone(store.get(k)), put: async (k, v) => store.set(k, structuredClone(v)) } });
  env = { GOOGLE_CLIENT_ID: "client-1", ALLOWED_EMAILS: "ilan@example.com", LINKS: { idFromName: n => n, get: () => ({ fetch: (url, init = {}) => obj.fetch(new Request(url, init)) }) } };
  globalThis.fetch = async url => {
    const email = PEOPLE[new URL(String(url)).searchParams.get("access_token")];
    return new Response(JSON.stringify(email ? { aud: "client-1", email, email_verified: "true", expires_in: "3000" } : {}), { status: email ? 200 : 400 });
  };
});
const call = (token, body) => worker.fetch(new Request("https://w.example/links", { method: body ? "POST" : "GET",
  headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), env);

test("links learned on the desktop are shared with everyone signed in", async () => {
  assert.equal((await call("tok-ilan", { W6: { generic: WIZZ }, IZ: { byDest: { ATH: "https://www.arkia.com/r?f={origin}&t={dest}&d={date:DD/MM/YYYY}&id=7" } } })).status, 200);
  await call("tok-ilan", { IZ: { byDest: { LCA: "https://www.arkia.com/r?f={origin}&t={dest}&d={date:DD/MM/YYYY}&id=9" } } });
  const all = await (await call("tok-dana")).json();
  assert.equal(all.W6.generic, WIZZ);
  assert.deepEqual(Object.keys(all.IZ.byDest).sort(), ["ATH", "LCA"], "new destinations add to the ones already known");
});

test("only an allowed account adds links, and only real templates", async () => {
  assert.equal((await call("tok-dana", { W6: { generic: WIZZ } })).status, 403);
  for (const bad of [{ W6: { generic: "http://x.com/{origin}/{dest}/{date}" } }, { W6: { generic: "https://x.com/{origin}/{dest}" } },
                     { W6: { generic: "javascript:alert(1)//{origin}{dest}{date}" } }, { wizz: { generic: WIZZ } }, { W6: { byDest: { rome: WIZZ } } }])
    assert.equal((await call("tok-ilan", bad)).status, 422, JSON.stringify(bad));
  assert.match((await (await call("tok-ilan", { W6: { generic: "https://x.com/a" } })).json()).error, /\{origin\}, \{dest\} and \{date\}/);
  assert.deepEqual(await (await call("tok-ilan")).json(), {});
});

test("a template must be an https address naming the route and the date", () => {
  assert.equal(badTemplate(WIZZ), null);
  assert.equal(badTemplate("https://x.com/{origin:l}-{destcity:l}/{date:DDMMYYYY}"), null);
  assert.equal(badTemplate("https://x.com/" + "a".repeat(2000) + "{origin}{dest}{date}"), "not a short enough string");
});
