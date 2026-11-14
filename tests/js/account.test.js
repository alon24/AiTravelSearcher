"use strict";
const test = require("node:test"), assert = require("node:assert");
globalThis.SKYHOP_RUNTIME = { workerUrl: "https://w.example", googleClientId: "id" };
require("../../src/flightagent/web/local/account.js");

test("a signed-in account missing from the user list is told so, not shown a generic failure", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "sign in with an allowed Google account" }) });
  await assert.rejects(globalThis.SkyhopLocal.account.get("/gflights?x=1"), /not on Skyhop's user list.*Ask the owner/);
});
