/* The Airline Assist extension inside the Skyhop Android app. The app has no extensions, so this gives the extension's
   own scripts (browser-extension/background.js and content-bridge.js, unchanged) the few chrome.* calls they make, on
   top of the app's Java bridge (window.SkyhopNative, android/app/.../MainActivity.java). Both scripts run in the Skyhop
   page; the airline's site is the app's second tab, where drivers are run with SkyhopNative.exec.
   tools/build_android.py bundles this file with the extension's files into the app's skyhop-app.js. */
function skyhopAppShim(FILES, native) {
  "use strict";
  const AIRLINE_TAB = 1, PAGE_TAB = 0;
  const pending = new Map();
  let seq = 0;
  const listeners = { background: [], content: [] };

  /** Hand `msg` to one side's onMessage listeners, as Chrome does: the first one that answers (or says it will, by
      returning true) wins; nobody answering is reported through lastError. */
  function deliver(side, msg, sender, respond) {
    let done = false, waiting = false;
    const sendResponse = r => { if (!done) { done = true; respond(r, null); } };
    for (const l of listeners[side]) {
      if (l(msg, sender, sendResponse) === true) waiting = true;
      if (done || waiting) return;
    }
    done = true; respond(undefined, "The message port closed before a response was received.");
  }

  function makeChrome(side) {
    const runtime = {
      lastError: undefined,
      id: "skyhop-app",
      getURL: path => urls[path] || path,
      onMessage: { addListener: l => listeners[side].push(l) },
      sendMessage(msg, cb) {       // from the page side to the background side, as content scripts do
        return new Promise(ok => setTimeout(() => deliver("background", msg, { tab: { id: PAGE_TAB } }, (r, err) => {
          runtime.lastError = err ? { message: err } : undefined;
          try { if (cb) cb(r); } finally { runtime.lastError = undefined; }
          ok(r);
        }), 0));
      },
    };
    return { runtime, storage, tabs, scripting, action };
  }

  // Assets the extension fetches with chrome.runtime.getURL (airlines.json).
  const urls = {};
  for (const [path, text] of Object.entries(FILES)) if (path.endsWith(".json")) urls[path] = URL.createObjectURL(new Blob([text], { type: "application/json" }));

  // chrome.storage: local in the page's localStorage, session in memory (the page hands it over again after a reload).
  // The app always uses Jev: Laya is a service on a computer, never on a phone.
  const FIXED = { decider: "jev" };
  const LOCAL = "skyhop.assist.";
  const keysOf = k => (k == null ? [] : Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k));
  const session = {};
  const storage = {
    local: {
      async get(k) {
        const out = {};
        for (const key of keysOf(k)) {
          if (key in FIXED) { out[key] = FIXED[key]; continue; }
          const v = localStorage.getItem(LOCAL + key);
          if (v !== null) out[key] = JSON.parse(v);
        }
        return out;
      },
      async set(items) { for (const [k, v] of Object.entries(items)) if (!(k in FIXED)) localStorage.setItem(LOCAL + k, JSON.stringify(v)); },
    },
    session: {
      async get(k) { const out = {}; for (const key of keysOf(k)) if (key in session) out[key] = session[key]; return out; },
      async set(items) { Object.assign(session, items); },
    },
  };

  // chrome.tabs: the one airline tab, and the Skyhop page itself (progress messages for its toasts).
  const tabs = {
    async create({ url }) { native.openTab(String(url)); return { id: AIRLINE_TAB, url }; },
    async get(id) {
      if (id !== AIRLINE_TAB) throw new Error(`No tab with id: ${id}.`);
      return { id, ...JSON.parse(native.tabState()) };
    },
    async sendMessage(id, msg) {
      if (id !== PAGE_TAB) throw new Error("Could not establish connection. Receiving end does not exist.");
      deliver("content", msg, {}, () => {});
    },
  };

  // chrome.scripting.executeScript in the airline tab. The code runs in the page there (an extension would use an
  // isolated world) and comes back as a JSON string: {ok, result} or {ok: false, error}.
  const wrap = body => `(function(){try{${body}}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)})}})()`;
  function run(code) {
    return new Promise((ok, no) => {
      const id = "x" + ++seq;
      pending.set(id, { ok, no });
      native.exec(id, code);
    });
  }
  const scripting = {
    async executeScript({ target, func, args = [], files }) {
      if (target.tabId !== AIRLINE_TAB) throw new Error(`No tab with id: ${target.tabId}.`);
      const code = func
        ? wrap(`var r=(${func}).apply(null,${JSON.stringify(args)});return JSON.stringify({ok:true,result:r===undefined?null:r})`)
        : wrap(["airline-bridge.js", ...files].map(f => {     // each file in its own scope, as separate scripts are
            if (!(f in FILES)) throw new Error(`Could not load file: '${f}'.`);
            return `(function(){\n${FILES[f]}\n})();`;
          }).join("\n") + "\nreturn JSON.stringify({ok:true,result:null})");
      return [{ result: await run(code) }];
    },
  };
  const action = { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} };

  return {
    background: makeChrome("background"),
    content: makeChrome("content"),
    /** SkyhopNative.exec's answer: what the airline page returned, or null when it ran nothing (it was navigating). */
    done(id, value) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      let r;
      try { r = JSON.parse(value); } catch { r = null; }
      if (!r) p.no(new Error("the airline page didn't run the script (it was loading a new page)"));
      else if (!r.ok) p.no(new Error(r.error));
      else p.ok(r.result);
    },
    /** A driver's chrome.runtime.sendMessage from the airline tab (airline-bridge.js). Only Jev's questions are taken:
        the airline's own scripts can call this bridge too. */
    fromAirline(id, json) {
      let msg;
      try { msg = JSON.parse(json); } catch { msg = null; }
      const answer = r => native.toAirline(id, JSON.stringify(r === undefined ? null : r));
      if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("laya-")) return answer({ ok: false, error: "not a Skyhop Assist message" });
      deliver("background", msg, { tab: { id: AIRLINE_TAB } }, r => answer(r));
    },
  };
}
if (typeof module !== "undefined" && module.exports) module.exports = skyhopAppShim;
