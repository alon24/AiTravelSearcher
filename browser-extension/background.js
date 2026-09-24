// Receives "select-flight" requests relayed by content-bridge.js from the Skyhop web app,
// opens a new tab on the airline's site, and injects that airline's driver script.
// Only El Al is wired up (v1). Add more airlines by registering their start URL + driver file
// here and adding a matching entry to drivers/ and host_permissions in manifest.json.
//
// Drivers can be multi-phase: a search button that navigates destroys the injected script, so a
// driver declares `resultsMatch` and gets re-injected (same details) once the tab lands there.
const DRIVERS = {
  LY: { startUrl: "https://www.elal.com/heb/israel", file: "drivers/elal.js", resultsMatch: "booking.elal.com/booking/flights" },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "select-flight") return false;
  // Respond immediately instead of awaiting the whole tab-load + injection sequence (can take
  // many seconds) -- MV3 service workers can be killed mid-wait before ever calling sendResponse,
  // which surfaces as "message channel closed before a response was received". The new tab's own
  // status banner (drivers/*.js) already reports progress/errors directly, so nothing needs to
  // wait on handle() finishing.
  handle(msg).catch((e) => console.error("[Skyhop background]", e));
  sendResponse({ ok: true, started: true });
  return false;
});

async function inject(tabId, driver, details) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (d) => { window.__skyhopFlightDetails = d; },
    args: [details],
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: [driver.file] });
}

async function handle({ airline, destination, day, returnDay, flightNumber }) {
  const driver = DRIVERS[airline];
  if (!driver) return { ok: false, error: `No driver yet for airline ${airline}` };
  const details = { airline, destination, day, returnDay, flightNumber };

  const tab = await chrome.tabs.create({ url: driver.startUrl });
  // The service worker can be killed while the page loads, so the hand-off state lives in
  // chrome.storage.session, not in a variable.
  await chrome.storage.session.set({ [`pending:${tab.id}`]: details });

  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  await inject(tab.id, driver, details);
  return { ok: true, tabId: tab.id };
}

// Phase 2: the tab navigated to the airline's results page -> re-inject with the same details.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  const key = `pending:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const details = stored[key];
  if (!details) return;
  const driver = DRIVERS[details.airline];
  if (!driver?.resultsMatch || !tab.url.includes(driver.resultsMatch)) return;
  await chrome.storage.session.remove(key);
  await inject(tabId, driver, details);
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(`pending:${tabId}`); });
