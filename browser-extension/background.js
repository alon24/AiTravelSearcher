// Receives "select-flight" requests relayed by content-bridge.js from the Skyhop web app,
// opens a new tab on the airline's site, and injects that airline's driver script.
// Only El Al is wired up (v1). Add more airlines by registering their start URL + driver file
// here and adding a matching entry to drivers/ and host_permissions in manifest.json.
//
// Multi-phase drivers: El Al's Search button navigates (www -> booking.elal.com), destroying the
// injected script. Phase 1 is injected on the search page; this file then watches the tab and
// injects the same driver again (same details) when the results page has loaded -- see
// injectWhenResultsLoad(). The driver picks its phase from the page it lands on.
const DRIVERS = {
  LY: { startUrl: "https://www.elal.com/heb/israel", file: "drivers/elal.js", resultsMatch: "booking.elal.com/booking/flights" },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "select-flight") return false;
  // Respond immediately instead of awaiting the whole tab-load + injection sequence (can take
  // many seconds) -- MV3 service workers can be killed mid-wait before ever calling sendResponse,
  // which surfaces as "message channel closed before a response was received". The new tab's own
  // status banner (drivers/*.js) already reports progress/errors directly.
  handle(msg).catch((e) => console.error("[Skyhop background]", e));
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
    hint = " -- open chrome://extensions > Skyhop Airline Assist > Site access and allow www.elal.com and booking.elal.com";
  await chrome.action.setBadgeBackgroundColor({ color: "#a11a2b" });
  await chrome.action.setBadgeText({ text: "ERR" });
  await chrome.action.setTitle({ title: `Skyhop Airline Assist failed: ${msg}${hint}` });
}

// Progress trail on the toolbar icon (green number + tooltip), so "it didn't work" can be
// narrowed to a stage without opening DevTools: 1 tab opened+loaded, 2 phase 1 injected,
// 3 results page seen and phase 2 injected. ERR (red) is reportError() above.
async function progress(n, text) {
  await chrome.action.setBadgeBackgroundColor({ color: "#0d6b45" });
  await chrome.action.setBadgeText({ text: String(n) });
  await chrome.action.setTitle({ title: `Skyhop Airline Assist: ${text}` });
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
}

async function inject(tabId, driver, details) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (d) => { window.__skyhopFlightDetails = d; },
    args: [details],
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: [driver.file] });
}

// Phase 2 hand-off: search navigates away and destroys the phase-1 script. Instead of relying on
// the page to carry state across (window.name + a content script -- the search worked but the
// second half never ran in the packaged extension), the background watches the tab and injects
// again with the same executeScript that already proved itself for phase 1. The polling calls are
// also what keep this service worker alive while El Al thinks.
async function injectWhenResultsLoad(tabId, driver, details, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; } // tab was closed
    if (tab.url && tab.url.includes(driver.resultsMatch) && tab.status === "complete") {
      await inject(tabId, driver, details);
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await reportError("El Al's results page never loaded (waited 2 min)");
  return false;
}

async function handle({ airline, destination, day, returnDay, flightNumber }) {
  const driver = DRIVERS[airline];
  if (!driver) return reportError(`No driver yet for airline ${airline}`);
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Skyhop Airline Assist" });
  const details = { airline, destination, day, returnDay, flightNumber };

  try {
    const tab = await chrome.tabs.create({ url: driver.startUrl });
    await waitForLoad(tab.id);
    await progress(1, "airline tab loaded");
    await inject(tab.id, driver, details);            // phase 1: search form
    await progress(2, "search form driven, waiting for El Al's results page");
    if (await injectWhenResultsLoad(tab.id, driver, details)) // phase 2: pick the flight
      await progress(3, "results page reached, flight selection injected");
  } catch (e) {
    await reportError(e);
  }
}
