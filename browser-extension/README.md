# Skyhop Airline Assist (browser extension)

From a flight result in the Skyhop web app, opens a new tab on the airline's own site, searches,
and selects that flight -- so you land on the real fare page ready to finish booking yourself.
We never see payment or passenger details; this only gets you to the selection screen.

**Why an extension, not a backend feature:** El Al's site runs a dedicated anti-bot vendor that
silently blocks server-side automation (Playwright) even with basic fingerprint masking. It does
**not** block a real, extension-driven browser tab -- this is the same trust boundary as you
using the site yourself, not automated scraping. See `docs/DESIGN.md` for the full story.

## Status: works on El Al (one-way, TLV origin); reload the extension after updates

First real test failed ("opened the site but did not find the flight"). Debugging live against
El Al's site found and fixed five real problems in `drivers/elal.js` / `background.js`:

1. The search form defaults to **round trip**; with one date the search silently never ran ->
   the driver now switches to one-way first.
2. The calendar needs its **"אישור" (confirm)** clicked.
3. Day cells were picked by index across a hidden third month -> now scoped to the right month
   panel, and later months are reached with the month strip (real links), not an arrow.
4. **Typed destination text is not committed** -- the site kept the previous destination and
   would silently search the wrong airport. The driver now types per keystroke and clicks the
   suggestion whose code matches exactly, and fails loudly if there is none.
5. Clicking Search **navigates** (www -> booking.elal.com, via an intermediate `/engine` page),
   which destroys the injected script, so "select the flight" could never run. Phase 1 now leaves
   the details in `window.name` (verified to survive the whole redirect chain) and a declarative
   content script re-runs the driver on `/booking/flights`, which reads and consumes them. Phase 2
   picks the row by flight number and clicks its **cheapest fare**; it does not pick a different
   flight if yours isn't listed, it says so in a red banner.
6. (v0.2.0) The first hand-off used `chrome.storage.session`, which needs a new `storage`
   permission -- after reloading, Chrome appears to have **disabled the extension** (the page
   marker `data-skyhop-extension` disappeared, so "nothing changed"). The permission is gone; the
   manifest now asks for exactly what v0.1 did. **If the button doesn't appear, open
   `chrome://extensions` and check Skyhop Airline Assist is enabled and shows no errors.**

Also: the El Al tab must be focused for the destination list to open (it is, for the tab the
extension opens and activates); the driver says so if the list never appears.

Verified live, end to end with the real driver logic: TLV->CDG, one-way, 5 Nov -> search ->
results -> LY323 selected at the cheapest fare with LITE / CLASSIC / FLEX showing. Not verified:
the packaged extension itself (I can't load it), so the first click after reloading is the real test.

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
