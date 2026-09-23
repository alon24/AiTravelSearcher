// Receives "select-flight" requests relayed by content-bridge.js from the Skyhop web app,
// opens a new tab on the airline's site, and injects that airline's driver script.
// Only El Al is wired up (v1). Add more airlines by registering their start URL + driver file
// here and adding a matching entry to drivers/ and host_permissions in manifest.json.
const DRIVERS = {
  LY: { startUrl: "https://www.elal.com/heb/israel", file: "drivers/elal.js" },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "select-flight") return false;
  handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // keep the message channel open for the async response
});

async function handle({ airline, destination, day, returnDay, flightNumber }) {
  const driver = DRIVERS[airline];
  if (!driver) return { ok: false, error: `No driver yet for airline ${airline}` };

  const tab = await chrome.tabs.create({ url: driver.startUrl });
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (d) => { window.__skyhopFlightDetails = d; },
    args: [{ destination, day, returnDay, flightNumber }],
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [driver.file] });

  return { ok: true, tabId: tab.id };
}
