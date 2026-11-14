"use strict";
const test = require("node:test"), assert = require("node:assert");

test("a signed-in account missing from the user list is told so, not shown a generic failure", async () => {
  const L = globalThis.SkyhopLocal || (globalThis.SkyhopLocal = {}), saved = { fetch: globalThis.fetch, rt: globalThis.SKYHOP_RUNTIME, account: L.account };
  globalThis.SKYHOP_RUNTIME = { workerUrl: "https://w.example", googleClientId: "id" };
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "sign in with an allowed Google account" }) });
  try {
    delete require.cache[require.resolve("../../src/flightagent/web/local/account.js")];
    require("../../src/flightagent/web/local/account.js");
    await assert.rejects(L.account.get("/gflights?x=1"), /not on Skyhop's user list.*Ask the owner/);
  } finally {   // the other test files share this process: leave their fetch and account as they were
    globalThis.fetch = saved.fetch; globalThis.SKYHOP_RUNTIME = saved.rt;
    if (saved.account) L.account = saved.account; else delete L.account;
  }
});
