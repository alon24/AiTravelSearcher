// Receives "select-flight" requests relayed by content-bridge.js from the Skyhop web app,
// opens a new tab on the airline's site, and injects that airline's driver script.
// Only El Al is wired up (v1). Add more airlines by registering their start URL + driver file
// here and adding a matching entry to drivers/ and host_permissions in manifest.json.
//
// Multi-phase drivers: El Al's Search button navigates (www -> booking.elal.com), destroying the
// injected script. Phase 1 (injected here) leaves the details in window.name, which survives a
// same-site navigation, and manifest.json's content_scripts re-run the same driver on the results
// page, which picks the details up from window.name. No storage permission, nothing that depends
// on this service worker staying alive.
const DRIVERS = {
  LY: { startUrl: "https://www.elal.com/heb/israel", file: "drivers/elal.js" },
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

async function handle({ airline, destination, day, returnDay, flightNumber }) {
  const driver = DRIVERS[airline];
  if (!driver) return reportError(`No driver yet for airline ${airline}`);
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Skyhop Airline Assist" });

  try {
    const tab = await chrome.tabs.create({ url: driver.startUrl });
    await waitForLoad(tab.id);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (d) => { window.__skyhopFlightDetails = d; },
      args: [{ airline, destination, day, returnDay, flightNumber }],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [driver.file] });
  } catch (e) {
    await reportError(e);
  }
}
