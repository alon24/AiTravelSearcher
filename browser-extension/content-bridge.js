// Runs on the Skyhop web app page (see manifest.json's content_scripts.matches). Its only job:
// let app.js know this extension is installed, and relay its "please select this flight on the
// airline's site" requests to the background script -- without app.js ever needing to know the
// extension's id (no externally_connectable, no manual pairing).

// Marks the page so app.js can detect the extension without messaging races on load.
document.documentElement.setAttribute("data-skyhop-extension", "1");

const reply = (detail) => window.dispatchEvent(new CustomEvent("skyhop-select-flight-result", { detail }));

window.addEventListener("skyhop-select-flight", (e) => {
  const detail = e.detail || {};
  // After the extension is reloaded, this (already injected) script is orphaned and
  // chrome.runtime.sendMessage throws "Extension context invalidated" -- report it instead of
  // failing silently; the fix is to reload the Skyhop page.
  try {
    chrome.runtime.sendMessage({ type: "select-flight", ...detail }, (response) => {
      reply(response || { ok: false, error: chrome.runtime.lastError?.message || "no response" });
    });
  } catch (err) {
    reply({ ok: false, error: "the extension was reloaded -- refresh this Skyhop page (F5) and try again" });
  }
});

// Progress from the background script (stage number + text), shown by the page as a toast.
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "progress")
      window.dispatchEvent(new CustomEvent("skyhop-progress", { detail: { stage: msg.stage, text: msg.text } }));
  });
} catch (err) { /* orphaned after an extension reload */ }

// Which airlines the extension covers (and whether each is verified / bespoke / learned / still to be learned),
// published on the page so app.js needn't keep its own copy of the list. Re-published on focus so an airline learned
// in another tab shows up without a reload.
function publishAirlines(retries = 2) {
  try {
    chrome.runtime.sendMessage({ type: "list-airlines" }, (r) => {
      if (chrome.runtime.lastError || !r?.ok) { if (retries) setTimeout(() => publishAirlines(retries - 1), 1000); return; }
      document.documentElement.setAttribute("data-skyhop-airlines", JSON.stringify(r.airlines));
    });
  } catch (err) { /* orphaned after an extension reload */ }
}
publishAirlines();
window.addEventListener("focus", () => publishAirlines(0));
