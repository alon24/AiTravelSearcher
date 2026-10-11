import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { _authCache } from "../src/index.js";
import { ensureSchema, isAllowed } from "../src/users.js";

/** Just enough of Cloudflare D1 over an in-memory SQLite database. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.run())), raw: db };
}

let DB, email;
beforeEach(async () => {
  _authCache.clear();
  DB = fakeD1();
  await ensureSchema(DB);
  email = "friend@example.com";
  globalThis.fetch = async url => {
    url = String(url);
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo"))
      return new Response(JSON.stringify({ aud: "client-1", email, email_verified: "true", expires_in: "3000" }));
    if (url.startsWith("https://openrouter.ai"))
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { total_tokens: 777 } }));
    return new Response("unexpected", { status: 500 });
  };
});
const env = () => ({ GOOGLE_CLIENT_ID: "client-1", OPENROUTER_API_KEY: "k", DB });
const chat = e => worker.fetch(new Request("https://w.example/chat", { method: "POST", headers: { Authorization: "Bearer t" },
  body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }), e);
const addUser = mail => DB.raw.prepare("INSERT INTO users (email, role, added_at) VALUES (?, 'user', 1)").run(mail);

test("someone added on the Travel Hub admin page may spend the keys at once, and loses that when removed", async () => {
  assert.equal((await chat(env())).status, 403);          // not on the list yet
  addUser("friend@example.com");
  assert.equal((await chat(env())).status, 200);          // no cache in the way: read fresh per request
  DB.raw.prepare("DELETE FROM users").run();
  assert.equal((await chat(env())).status, 403);
});

test("each chat turn is logged with its tokens for the usage view", async () => {
  addUser("friend@example.com");
  await chat(env());
  const rows = DB.raw.prepare("SELECT email, app, action, tokens FROM audit").all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ email: "friend@example.com", app: "skyhop", action: "chat", tokens: 777 }]);
});

test("ADMIN_EMAILS and ALLOWED_EMAILS (plain or hashed) are always allowed; nothing configured means anyone", async () => {
  const hash = "sha256:bb92649b6d5241648bc0d2cba48ea79ea61f022fef80dc20ab6e0d1e0b7d038d";
  assert.equal(await isAllowed("htpcfreak@gmail.com", { DB, ADMIN_EMAILS: hash }), true);
  assert.equal(await isAllowed("Legacy@Example.com", { DB, ALLOWED_EMAILS: "legacy@example.com" }), true);
  assert.equal(await isAllowed("stranger@example.com", { DB, ALLOWED_EMAILS: "legacy@example.com" }), false);
  assert.equal(await isAllowed("anyone@example.com", {}), true);
  assert.equal(await isAllowed("", {}), false);
});

test("a broken database never breaks a lookup that is otherwise allowed", async () => {
  const broken = { prepare: () => { throw new Error("db down"); }, batch: async () => { throw new Error("db down"); } };
  const r = await chat({ ...env(), DB: broken, ALLOWED_EMAILS: "friend@example.com" });
  assert.equal(r.status, 200);
});
