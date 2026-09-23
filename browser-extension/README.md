# Skyhop Airline Assist (browser extension)

From a flight result in the Skyhop web app, opens a new tab on the airline's own site, searches,
and selects that flight -- so you land on the real fare page ready to finish booking yourself.
We never see payment or passenger details; this only gets you to the selection screen.

**Why an extension, not a backend feature:** El Al's site runs a dedicated anti-bot vendor that
silently blocks server-side automation (Playwright) even with basic fingerprint masking. It does
**not** block a real, extension-driven browser tab -- this is the same trust boundary as you
using the site yourself, not automated scraping. See `docs/DESIGN.md` for the full story.

## Status: built, not yet tested end-to-end

I validated the DOM selectors manually against the live site and the messaging architecture is
standard, but I have not been able to load this extension and click through the actual flow --
loading an unpacked extension needs Chrome's native "Load unpacked" file picker, which is outside
what my browser automation tools can drive. **You'll need to do the first load-and-click test.**

## Load it (development mode)

1. Chrome -> `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. **Load unpacked** -> select this `browser-extension/` folder
4. Open the Skyhop app at `http://localhost:8765` (or `127.0.0.1:8765`) -- reload the tab if it
   was already open, so the content script attaches
5. Run a search, open the "Flights listed without a price" panel (or wherever an El Al flight
   shows) -- if the extension is detected, a **"Select on LY site ↗"** button appears next to the
   existing airline-site link

## If it breaks

El Al's site has no stable `data-testid`s anywhere (confirmed live) -- every selector in
`drivers/elal.js` is a CSS class name or text match captured on 2026-09-23, and will break
silently on a redesign, landing you on a status banner saying "finish by hand from here" rather
than a wrong selection. Keep `drivers/elal.js` and `src/flightagent/providers/elal_verify.py` in
sync -- they automate the same site with the same selectors, just in JS (real browser) vs. Python
(Playwright, currently blocked).

## Adding another airline

1. Add its driver file under `drivers/<code>.js` (copy `elal.js`'s shape: read
   `window.__skyhopFlightDetails`, do the search, click the matching/cheapest fare, show status
   in a banner, never touch passenger/payment fields).
2. Register it in `background.js`'s `DRIVERS` map and add its domain(s) to `manifest.json`'s
   `host_permissions`.
3. Add the airline's code to `EXTENSION_DRIVERS` in `src/flightagent/web/app.js`.
4. Reload the extension (`chrome://extensions` -> refresh icon) and re-test by hand first --
   don't assume a driver written by pattern-matching `elal.js` actually works against a real,
   different site's DOM.
