// Receives "select-flight" requests relayed by content-bridge.js from the Skyhop web app, opens a new tab
// on the airline's own site and injects a driver that finds the flight and outlines its cheapest fare.
//
// Which airlines exist, and how each one is opened, lives in airlines.json (see its _doc):
//   mode "bespoke"  -- own driver + start page, defined in BESPOKE below (El Al, TAROM);
//   mode "url"      -- results page is a URL template; generic drivers/results.js finds cards/fares on the fly with
//                      Laya (drivers/laya-agent.js), nothing airline-specific in code (Wizz Air is the first);
//   mode "discover" -- template not known yet: open the airline's home page and LEARN it from one search the
//                      user does by hand (discover() below); stored in chrome.storage.local, used next time.
// Adding an airline = an airlines.json entry (+ `python3 tools/sync_assist_manifest.py` for host permissions).
//
// Multi-phase drivers: El Al's Search button navigates (www -> booking.elal.com), destroying the
// injected script. Phase 1 is injected on the search page; this file then watches the tab and
// injects the same driver again (same details) when the results page has loaded -- see
// injectWhenResultsLoad(). Outbound legs from TLV only, for now (all the Skyhop buttons offer).
const AGENT = ["drivers/laya-agent.js", "drivers/parse.js", "drivers/results.js"];
const BESPOKE = {
  LY: { startUrl: "https://www.elal.com/heb/israel", file: "drivers/elal.js", resultsMatch: "booking.elal.com/booking/flights" },
  RO: {
    file: "drivers/tarom.js",
    resultsMatch: "digital.tarom.ro/booking/availability",
    directUrl: (d) => "https://digital.tarom.ro/booking?lang=en-GB&search=" + encodeURIComponent(JSON.stringify({
      travelers: [{ passengerTypeCode: "ADT" }],
      commercialFareFamilies: ["EUROPE"],
      itineraries: [{ departureDateTime: d.day, originLocationCode: "TLV", destinationLocationCode: d.destination }],
    })) + "&portalFacts=" + encodeURIComponent(JSON.stringify([{ key: "currency", value: "EUR" }, { key: "channel", value: "desktop" }])),
  },
};

// ---- registry (airlines.json) + templates learned from the user's own searches ----
let registryPromise;
const registry = () => (registryPromise ||= fetch(chrome.runtime.getURL("airlines.json")).then((r) => r.json()).then((j) => j.airlines));
async function lookup(code) {   // by IATA code or alias ("W4" -> Wizz Air's "W6" entry)
  for (const [key, e] of Object.entries(await registry())) if (key === code || (e.aliases || []).includes(code)) return { key, ...e };
  return null;
}
const getLearned = async () => (await chrome.storage.local.get("learned")).learned || {};

// Template placeholders: {origin} {dest} ({dest:l} lower-case) {date} = YYYY-MM-DD, {date:DD/MM/YYYY} etc.
const DATE_PATTERNS = ["YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "MM/DD/YYYY", "DD.MM.YYYY", "YYYYMMDD", "DDMMYYYY", "DDMMYY", "YYMMDD"];
const fmtDate = (iso, pat) => { const [Y, M, D] = iso.split("-"); return pat.replace("YYYY", Y).replace("YY", Y.slice(2)).replace("MM", M).replace("DD", D); };
// {destcity} is the destination's CITY code (ROM for FCO) for sites that search by city rather than airport.
const fill = (tpl, d) => tpl
  .replace(/\{(origin|dest|destcity)(?::(l))?\}/g, (_, k, l) => { const v = k === "origin" ? d.origin : k === "dest" ? d.destination : (d.destCity || d.destination); return l ? v.toLowerCase() : v; })
  .replace(/\{date(?::([A-Za-z\-\/.]+))?\}/g, (_, pat) => fmtDate(d.day, pat || "YYYY-MM-DD"));

// Turn the URL of a results page the user reached by hand into a template, or explain why it can't be one.
// Returns {url, match} | {rejected: reason} | null (not a results page for this search yet).
function learnFrom(url, d) {
  const code = (c) => new RegExp(`(?<![A-Za-z])${c}(?![A-Za-z])`, "gi");
  const datePat = DATE_PATTERNS.find((p) => url.includes(fmtDate(d.day, p)) || url.includes(encodeURIComponent(fmtDate(d.day, p))));
  // The site may search by the airport code (FCO) or the city code (ROM): accept whichever the URL shows.
  const found = [d.destination, ...(d.destCodes || [])].find((c) => code(c).test(url));
  if (!datePat || !found) return null;
  const casing = (m, ph) => (m === m.toLowerCase() ? ph.replace("}", ":l}") : ph);
  let tpl = url.replace(code(found), (m) => casing(m, found === d.destination ? "{dest}" : "{destcity}")).replace(code(d.origin), (m) => casing(m, "{origin}"));
  const plain = fmtDate(d.day, datePat);
  tpl = tpl.split(plain).join(`{date:${datePat}}`).split(encodeURIComponent(plain)).join(`{date:${datePat}}`);
  // A session token in the query string would be replayed stale (and is not ours to keep): refuse those airlines.
  try {
    for (const [, v] of new URL(url).searchParams) {
      if (/^[A-Za-z0-9_\-=.]{24,}$/.test(v) && !v.includes(found)) return { rejected: "the URL carries a long opaque value (a session token?), so it can't be replayed -- this airline needs a form-driving driver" };
    }
  } catch { /* not a parseable URL: keep going */ }
  const match = tpl.replace(/^https?:\/\//, "").split(/[?{]/)[0];
  return { url: tpl, match, bound: hasOpaqueId(tpl) };
}

// A run of 4+ digits left in the address after the placeholders are taken out is an internal id (Israir's
// "ltravelid":2135 for Rome). Such a template is only right for the destination it was learned with, so it is
// remembered per destination instead of being replayed for every route (which would silently search the wrong city).
const PLACEHOLDER = /\{(?:origin|dest|destcity)(?::l)?\}|\{date(?::[A-Za-z\-\/.]+)?\}/g;
function hasOpaqueId(tpl) {
  let rest = tpl.replace(/^https?:\/\/[^/]+/, "").replace(PLACEHOLDER, "");
  try { rest = decodeURIComponent(rest); } catch { /* keep as is */ }
  return /\d{4,}/.test(rest);
}
// What was learned for this airline, if it applies to this destination: a generic template, else one learned for
// exactly this destination. (Entries saved by v0.6.0-0.6.3 are {url, match}: generic unless they carry an id.)
function pickLearned(l, destination) {
  if (!l) return null;
  if (l.generic) return l.generic;
  if (l.byDest?.[destination]) return l.byDest[destination];
  if (l.url && !hasOpaqueId(l.url)) return l;
  return null;
}

// Laya service calls, made here because an extension service worker may fetch http://127.0.0.1:8799
// (host_permissions) while the airline's page may not. Diagnostic/locating aid only: any failure comes
// back as {ok:false, error} and the driver decides what to do.
const LAYA_URL = "http://127.0.0.1:8799";
// Which decision backend answers: "laya" (the local service, called directly) or "jev" (TypeSafe's hosted model via
// the Skyhop server's /api/decide, which holds the OpenRouter key -- it must never be in the extension). The choice is
// made in the Skyhop page header and kept in chrome.storage.local.
const SKYHOP_URL = "http://127.0.0.1:8765";
// On the web version the page hands over its Cloudflare Worker and Google token instead ({url, token, until}, from
// content-bridge.js); kept in session storage, so it's gone when the browser closes, and used until the token expires.
async function jevRoute() {
  const { jevRoute: r } = await chrome.storage.session.get("jevRoute");
  return r && r.url && r.token && r.until > Date.now() ? r : null;
}
// In the Skyhop Android app (android/) these scripts run in the app's page, with no local server to fall back on.
const IN_APP = !!globalThis.SKYHOP_APP;
const APP_SIGN_IN = "sign in to Skyhop first (Jev needs your Google sign-in, on an invited account)";
// Until one is picked: Jev on the web version (no local Laya there is likely), else Laya.
async function getDecider() {
  const { decider } = await chrome.storage.local.get("decider");
  return decider ? (decider === "jev" ? "jev" : "laya") : (await jevRoute()) ? "jev" : "laya";
}

async function layaClassify(state, questions) {
  if (await getDecider() === "jev") {
    const route = await jevRoute();
    if (route) {
      const r = await fetch(route.url + "/decide", { method: "POST", body: JSON.stringify({ state, questions }),
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + route.token } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("Jev via Skyhop's Worker: " + (body.error || "HTTP " + r.status));
      return body.answers;
    }
    if (IN_APP) throw new Error(APP_SIGN_IN);
    const r = await fetch(SKYHOP_URL + "/api/decide", {
      method: "POST",
      // the custom header is what the Skyhop server requires (a plain web page can't send it cross-origin)
      headers: { "Content-Type": "application/json", "X-Skyhop": "1" },
      body: JSON.stringify({ state, questions }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Jev via the Skyhop server: " + (body.detail || "HTTP " + r.status));
    return body.answers;
  }
  const r = await fetch(LAYA_URL + "/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Laya-Caller": "skyhop-extension" },
    body: JSON.stringify({ state, questions }),
  });
  if (!r.ok) throw new Error("Laya HTTP " + r.status);
  return (await r.json()).answers;
}

// Is the chosen backend reachable? (Jev: also that the server has the OpenRouter key.)
async function deciderPing() {
  if (await getDecider() === "jev") {
    const route = await jevRoute();
    if (route) {
      const r = await fetch(route.url + "/health", { headers: { Authorization: "Bearer " + route.token }, signal: AbortSignal.timeout(5000) });
      const h = r.ok ? await r.json() : {};
      if (!h.jev) throw new Error("Skyhop's Worker has no OpenRouter key for Jev");
      if (!h.user) throw new Error("sign in to Skyhop again (Jev needs an invited Google account)");
      return;
    }
    if (IN_APP) throw new Error(APP_SIGN_IN);
    const r = await fetch(SKYHOP_URL + "/api/decide/health", { headers: { "X-Skyhop": "1" }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("the Skyhop server answered HTTP " + r.status);
    if (!(await r.json()).jev_configured) throw new Error("Jev is selected but the Skyhop server has no OpenRouter key (add OPENROUTER_API_KEY to .env, then docker compose up -d)");
    return;
  }
  const r = await fetch(LAYA_URL + "/health", { signal: AbortSignal.timeout(4000) })   // refused at once when it isn't running
    .catch((e) => { throw new Error(`the local Laya service isn't reachable (${e.message}) -- start it with ~/laya-service/start.sh`); });
  if (!r.ok) throw new Error("the local Laya service answered HTTP " + r.status);
}
const PAGE_TYPES = {
  results: "Flight search results: flight times, prices, airline names, select buttons.",
  consent: "A cookie/privacy consent wall asking to accept or manage cookies before continuing.",
  captcha: "A CAPTCHA, 'are you a robot', or other human-verification challenge.",
  blocked: "An error, rate-limit, quota, or 'unusual traffic' blocking message.",
  no_flights: "A message that no flights are available for the chosen route and date.",
  other: "Something else that doesn't match the above.",
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith("laya-")) return false;
  (async () => {
    if (msg.type === "laya-ping") { await deciderPing(); return { decider: await getDecider() }; }
    if (msg.type === "laya-page") {
      const a = await layaClassify(msg.text, { page_type: { type: "choice", instructions: "Classify what kind of airline web page this text is from.", criteria: PAGE_TYPES } });
      return { choice: a.page_type.choice };
    }
    if (msg.type === "laya-rank") {   // one binary question per candidate element
      const ask = async (state) => (await layaClassify(state, { q: { type: "noul", instructions: "Is this page element " + msg.role + "?" } })).q.noul;
      // Laya's service answers one at a time (a lock), so it is asked one at a time; Jev is a network call, so ask 5 at once.
      const scores = [], width = (await getDecider()) === "jev" ? 5 : 1;
      for (let i = 0; i < msg.states.length; i += width) scores.push(...(await Promise.all(msg.states.slice(i, i + width).map(ask))));
      return { scores };
    }
    throw new Error("unknown laya message " + msg.type);
  })().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;   // async response
});

// Learned search links in the Worker's format ({code: {generic, byDest: {DEST: url}}}), under the airline's code and its
// aliases, so a phone (no extension) can open the same results page (worker/src/links.js).
function linksPayload(learned, reg) {
  const out = {};
  for (const [key, l] of Object.entries(learned)) {
    if (!l.generic && !l.byDest) continue;   // pre-0.6.4 entries
    const entry = { ...(l.generic ? { generic: l.generic.url } : {}), ...(l.byDest ? { byDest: Object.fromEntries(Object.entries(l.byDest).map(([d, r]) => [d, r.url])) } : {}) };
    for (const code of [key, ...((reg[key] || {}).aliases || [])]) out[code] = entry;
  }
  return out;
}
// Share what was learned through the web version's Worker. Signed-in only; a refusal is logged with its reason.
async function shareLearned() {
  const route = await jevRoute(), payload = linksPayload(await getLearned(), await registry());
  if (!route || !Object.keys(payload).length) return;
  const r = await fetch(route.url + "/links", { method: "POST", body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + route.token } });
  if (!r.ok) console.warn("Skyhop: couldn't share learned search links:", (await r.json().catch(() => ({}))).error || "HTTP " + r.status);
}

// The web version's Worker route for Jev (see jevRoute); null signs it out.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "set-jev-route") return false;
  const r = msg.route;
  chrome.storage.session.set({ jevRoute: r && typeof r.url === "string" && /^https:\/\//.test(r.url) ? { url: r.url, token: String(r.token), until: Number(r.until) } : null })
    .then(() => { sendResponse({ ok: true }); return shareLearned(); }).catch((e) => console.warn("Skyhop:", e.message));
  return true;
});

// The Skyhop page header switches the decision backend (laya | jev); content-bridge.js relays it here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "set-decider" && msg?.type !== "get-decider") return false;
  (async () => {
    if (msg.type === "set-decider") await chrome.storage.local.set({ decider: msg.value === "jev" ? "jev" : "laya" });
    return { decider: await getDecider() };
  })().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// The Skyhop page asks which airlines Assist covers (content-bridge.js publishes the answer on the page).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "list-airlines") return false;
  (async () => {
    const learned = await getLearned(), out = {};
    for (const [key, e] of Object.entries(await registry())) {
      const status = e.mode === "discover" ? (learned[key] ? "learned" : "discover") : e.status;
      // Bespoke drivers (El Al, TAROM) only know how to search FROM Tel Aviv (their own home-country widget / a hardcoded originLocationCode);
      // a "url" template or one learned from the user is parameterised by {origin}, so it works from wherever the flight actually leaves.
      const anyOrigin = e.mode !== "bespoke";
      for (const c of [key, ...(e.aliases || [])]) out[c] = { name: e.name, status, anyOrigin };
    }
    return out;
  })().then((airlines) => sendResponse({ ok: true, airlines }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "select-flight") return false;
  // Respond immediately instead of awaiting the whole tab-load + injection sequence (can take
  // many seconds) -- MV3 service workers can be killed mid-wait before ever calling sendResponse,
  // which surfaces as "message channel closed before a response was received". The new tab's own
  // status banner (drivers/*.js) already reports progress/errors directly.
  handle(msg, sender.tab?.id).catch((e) => console.error("[Skyhop background]", e));
  sendResponse({ ok: true, started: true });
  return false;
});

// Failures used to be invisible (the tab opened, nothing happened, nothing said why). Now the
// toolbar icon shows a red ERR badge and its tooltip carries the reason.
async function reportError(e) {
  const msg = String(e?.message || e);
  console.error("[Skyhop background]", msg);
  let hint = "";
  if (/cannot access|permission|host/i.test(msg))
    hint = " -- open chrome://extensions > Skyhop Airline Assist > Site access and allow this airline's site (\"Automatically allow access on the following sites\")";
  if (reportTabId !== null)
    chrome.tabs.sendMessage(reportTabId, { type: "progress", stage: "ERR", text: msg + hint }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: "#a11a2b" });
  await chrome.action.setBadgeText({ text: "ERR" });
  await chrome.action.setTitle({ title: `Skyhop Airline Assist failed: ${msg}${hint}` });
}

// Progress trail on the toolbar icon (green number + tooltip), so "it didn't work" can be
// narrowed to a stage without opening DevTools: 1 tab opened+loaded, 2 phase 1 injected,
// 3 results page seen and phase 2 injected. ERR (red) is reportError() above.
// Diagnostics only: a failure here must never stop the flight selection itself.
// The same trail is also sent to the Skyhop page (content-bridge.js turns it into a toast), because
// the toolbar badge is invisible unless the extension is pinned.
let reportTabId = null;
async function progress(n, text) {
  if (reportTabId !== null)
    chrome.tabs.sendMessage(reportTabId, { type: "progress", stage: String(n), text }).catch(() => {});
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#0d6b45" });
    await chrome.action.setBadgeText({ text: String(n) });
    await chrome.action.setTitle({ title: `Skyhop Airline Assist: ${text}` });
  } catch (e) { console.warn("[Skyhop background] progress failed", e); }
}

// Poll instead of waiting for one onUpdated event: if the page finishes loading before a listener
// is attached (or the worker is restarted), that event never comes and nothing is ever injected.
async function waitForLoad(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    await new Promise((r) => setTimeout(r, 300));
  }
  // Still loading after the timeout: inject anyway rather than doing nothing.
  await progress("1?", "airline tab still loading after 20s, injecting anyway");
}

async function inject(tabId, driver, details) {
  // Each step is labelled so a failure says WHICH one (and a visible marker proves the tab accepted a script at all).
  // The details step returns instantly, so if it hasn't finished in 8 s the tab is not accepting scripts (stuck
  // at "2+" with no banner used to be the only symptom); say so instead of hanging.
  const step = async (label, run, limitMs = 0) => {
    try {
      return await (limitMs ? Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer after ${limitMs / 1000}s (the tab isn't accepting scripts -- check Site access for this site, or that this is the tab the extension opened)`)), limitMs))]) : run());
    } catch (e) { throw new Error(`${label}: ${e?.message || e}`); }
  };
  await step("setting the flight details on the page", () => chrome.scripting.executeScript({
    target: { tabId },
    func: (d) => {
      window.__skyhopFlightDetails = d;
      let b = document.getElementById("skyhop-status-banner");
      if (!b) { b = document.createElement("div"); b.id = "skyhop-status-banner"; document.documentElement.appendChild(b); }
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;color:#fff;font:14px/1.4 system-ui,sans-serif;" +
        "padding:10px 16px;text-align:center;direction:ltr;background:#1a1a2e;";
      b.textContent = "Skyhop Assist: extension injected, starting the driver…";
    },
    args: [details],
  }), 8000);
  for (const file of [].concat(driver.file))
    await step(`running ${file}`, () => chrome.scripting.executeScript({ target: { tabId }, files: [file] }));
}

// Phase 2 hand-off: search navigates away and destroys the phase-1 script. Instead of relying on
// the page to carry state across (window.name + a content script -- the search worked but the
// second half never ran in the packaged extension), the background watches the tab and injects
// again with the same executeScript that already proved itself for phase 1. The polling calls are
// also what keep this service worker alive while El Al thinks.
async function injectWhenResultsLoad(tabId, driver, details, timeoutMs = 120000) {
  const start = Date.now();
  let matchedAt = 0;
  while (Date.now() - start < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; } // tab was closed
    if (tab.url && tab.url.includes(driver.resultsMatch)) {
      if (!matchedAt) { matchedAt = Date.now(); await progress(2, "results page reached, waiting for it to settle"); }
      // Normally wait for "complete", but some sites (TAROM) keep a request open so the tab never
      // reports it -- after 4 s on the results URL inject anyway; the driver waits for its own elements.
      // waitComplete drivers (Wizz Air) insist on "complete" (20 s cap) and then a settle pause: an early inject
      // into a page that reloads afterwards silently loses the driver (no banner, nothing outlined).
      const early = driver.waitComplete ? Date.now() - matchedAt > 20000 : Date.now() - matchedAt > 4000;
      if (tab.status === "complete" || early) {
        if (driver.waitComplete) await new Promise((r) => setTimeout(r, 2500));
        await progress("2+", "driver injected and running -- watch the banner at the top of the airline tab");
        await inject(tabId, driver, details);
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await reportError(`the airline's results page (${driver.resultsMatch}) never showed up (waited 2 min)`);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A banner in the airline tab (same one the drivers use); best effort -- the toolbar/toast still report.
async function tabBanner(tabId, text, isError = false) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, args: [text, isError], func: (t, err) => {
      let b = document.getElementById("skyhop-status-banner");
      if (!b) { b = document.createElement("div"); b.id = "skyhop-status-banner"; document.documentElement.appendChild(b); }
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;color:#fff;font:14px/1.4 system-ui,sans-serif;" +
        "padding:10px 16px;text-align:center;direction:ltr;background:" + (err ? "#a11a2b" : "#1a1a2e") + ";";
      b.textContent = "Skyhop Assist: " + t;
    } });
  } catch (e) { console.warn("[Skyhop background] banner failed", e); }
}

// First use of a "discover" airline: open its home page and learn the results-page URL from ONE search the user
// does by hand, then carry on as a normal "url" airline (this very page included). Only the URL is kept, and only
// as a template with the airport codes and date turned into placeholders (a session token is refused).
// "Tel Aviv (TLV) → Rome (FCO), 2 Oct 2026, one way": the names the airline's own site shows, with the codes we use.
const place = (name, code) => (name ? `${name} (${code})` : code);
const niceDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const ask = (d) => `${place(d.originName, d.origin)} → ${place(d.destinationName, d.destination)} on ${niceDay(d.day)}, one way (either the city or its airport is fine)`;

async function discover(entry, details) {
  const tab = await chrome.tabs.create({ url: `https://www.${entry.hosts[0]}/` });
  await waitForLoad(tab.id);
  await tabBanner(tab.id, `Skyhop doesn't know ${entry.name}'s results page yet. Please search ${ask(details)} here once, any way you like (switch the site to English first if it offers it); ` +
    `Skyhop remembers it and next time the button does the search for you.`);
  await progress("L", `learning ${entry.name}: do one search on its site -- ${ask(details)}`);
  const start = Date.now();
  let lastUrl = "", seenAt = 0, explained = false;
  while (Date.now() - start < 10 * 60000) {
    let t;
    try { t = await chrome.tabs.get(tab.id); } catch { return; }   // tab closed: give up quietly
    const got = t.url && learnFrom(t.url, details);
    if (got?.rejected) { await tabBanner(tab.id, `couldn't learn ${entry.name}: ${got.rejected}`, true); return reportError(`couldn't learn ${entry.name}: ${got.rejected}`); }
    if (got) {
      const learned = await getLearned();
      const rec = { url: got.url, match: got.match, learnedAt: Date.now() };
      const cur = learned[entry.key]?.generic || learned[entry.key]?.byDest ? learned[entry.key] : {};   // drop pre-0.6.4 {url,match}
      if (got.bound) (cur.byDest ||= {})[details.destination] = rec; else cur.generic = rec;
      learned[entry.key] = cur;
      await chrome.storage.local.set({ learned });
      shareLearned().catch((e) => console.warn("Skyhop: couldn't share learned search links:", e.message));
      await tabBanner(tab.id, got.bound
        ? `learned ${entry.name} for ${place(details.destinationName, details.destination)} only (its address holds an id that differs per destination) -- other destinations ask you once each. Looking for your flight…`
        : `learned ${entry.name}'s results page -- from now on the button opens it directly. Looking for your flight…`);
      await progress("L+", `learned ${entry.name}`);
      if (await injectWhenResultsLoad(tab.id, { file: AGENT, waitComplete: true, resultsMatch: got.match }, details))
        await progress(3, "results page reached, flight selection injected");
      return;
    }
    // A new page loads with no banner (the old one died with the old page): say again what is wanted, and once
    // the page has settled without its address showing the search, say why that can't be learned.
    if (t.url && t.url !== lastUrl && t.status === "complete") {
      lastUrl = t.url; seenAt = Date.now(); explained = false;
      await tabBanner(tab.id, `Please search ${ask(details)}. I'm watching this tab's address and will remember the results page.`);
    }
    if (seenAt && !explained && Date.now() - seenAt > 8000 && new URL(lastUrl).pathname.length > 1) {
      explained = true;
      const where = new URL(lastUrl); const shown = where.host + where.pathname;
      await tabBanner(tab.id, `${entry.name}: this page's address (${shown}) doesn't show the airport (${details.destination}) and the date (${details.day}), so I can't learn it from here. ` +
        `If this is the results page, this site hides the search from the address and can't be learned; otherwise carry on with the search for ${place(details.destinationName, details.destination)} on ${niceDay(details.day)}.`, true);
      await progress("L?", `${entry.name}: the address of the page you reached (${shown}) doesn't show the search, so it can't be learned yet`);
    }
    await sleep(1000);
  }
  await reportError(`gave up learning ${entry.name}: no results page for ${details.destination} on ${details.day} in 10 minutes`);
}

async function handle({ airline, origin, destination, day, returnDay, flightNumber, departTime, originName, destinationName, destCodes }, senderTabId) {
  reportTabId = senderTabId ?? null;
  const entry = await lookup(airline);
  if (!entry) return reportError(`${airline} isn't in Skyhop Assist's airline list (browser-extension/airlines.json)`);
  origin = origin || "TLV";        // callers before this version never sent one; TLV was the only origin Skyhop searched from then
  if (entry.mode === "bespoke" && origin !== "TLV")
    return reportError(`${entry.name}'s driver only knows how to search from Tel Aviv (TLV), not ${origin} -- use "Check on ${entry.name} site" instead`);
  await progress(0, "request received, opening the airline tab");
  const destCity = (destCodes || []).find((c) => c !== destination);
  const details = { airline, airlineName: entry.name, origin, originName, destination, destinationName, destCodes, destCity, day, returnDay, flightNumber, departTime };

  try {
    let driver = null;
    if (entry.mode === "bespoke") driver = BESPOKE[entry.key];
    else {
      const t = entry.url ? entry : pickLearned((await getLearned())[entry.key], destination);   // registry template, else one learned from the user
      if (t) driver = { file: AGENT, waitComplete: true, resultsMatch: t.match, directUrl: (d) => fill(t.url, d) };
    }
    if (!driver) return await discover(entry, details);

    const tab = await chrome.tabs.create({ url: driver.directUrl ? driver.directUrl(details) : driver.startUrl });
    await progress(0, `airline tab ${tab.id} opened, waiting for it to load`);
    await waitForLoad(tab.id);
    await progress(1, "airline tab loaded");
    if (!driver.directUrl) {
      await inject(tab.id, driver, details);          // phase 1: search form
      await progress(1, "search form driven, waiting for the results page");
    }
    if (await injectWhenResultsLoad(tab.id, driver, details)) // phase 2: pick the flight
      await progress(3, "results page reached, flight selection injected");
  } catch (e) {
    await reportError(e);
  }
}
