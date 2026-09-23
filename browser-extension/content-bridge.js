// Runs on the Skyhop web app page (see manifest.json's content_scripts.matches). Its only job:
// let app.js know this extension is installed, and relay its "please select this flight on the
// airline's site" requests to the background script -- without app.js ever needing to know the
// extension's id (no externally_connectable, no manual pairing).

// Marks the page so app.js can detect the extension without messaging races on load.
document.documentElement.setAttribute("data-skyhop-extension", "1");

window.addEventListener("skyhop-select-flight", (e) => {
  const detail = e.detail || {};
  chrome.runtime.sendMessage({ type: "select-flight", ...detail }, (response) => {
    window.dispatchEvent(new CustomEvent("skyhop-select-flight-result", {
      detail: response || { ok: false, error: chrome.runtime.lastError?.message || "no response" },
    }));
  });
});
