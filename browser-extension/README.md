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
   which destroys the injected script, so "select the flight" could never run. The `window.name` +
   declarative-content-script hand-off (v0.2) worked by hand but never ran in the packaged
   extension, so since v0.3.0 `background.js` watches the tab and injects the driver again
   (`executeScript`, same details) once the URL is `/booking/flights` and loaded. Phase 2
   picks the row by flight number and clicks its **cheapest fare**; it does not pick a different
   flight if yours isn't listed, it says so in a red banner.
6. (v0.2.0) The first hand-off used `chrome.storage.session`, which needs a new `storage`
   permission -- after reloading, Chrome appears to have **disabled the extension** (the page
   marker `data-skyhop-extension` disappeared, so "nothing changed"). The permission is gone; the
   manifest now asks for exactly what v0.1 did. **If the button doesn't appear, open
   `chrome://extensions` and check Skyhop Airline Assist is enabled and shows no errors.**

Also: the El Al tab must be focused for the destination list to open (it is, for the tab the
extension opens and activates); the driver says so if the list never appears.

Verified end to end in the packaged v0.3.0 extension (user's Chrome): TLV->FCO one-way ->
results -> LY383 selected at the cheapest fare, banner shown.

**Diagnostics without DevTools:** the toolbar icon shows a green stage number -- 1 airline tab
loaded, 2 search form driven, 3 results page reached and selection injected -- or a red `ERR`
with the reason in the tooltip. Chrome's per-site "Site access" toggles must be on for
www.elal.com, booking.elal.com and the Skyhop origin (`localhost:8765` / `127.0.0.1:8765`).

## TAROM (RO) -- v0.4.0

TAROM's own search widget just opens `digital.tarom.ro/booking?search=<JSON>` (origin, destination,
date; no token), so `background.js` opens that URL directly -- no form driving, nothing to break
when they restyle the home page. `drivers/tarom.js` runs on the results page only: it opens each
flight's "See itinerary details" (the flight number is only shown there), finds yours, expands its
Economy fares and outlines the cheapest one. It never presses a fare's SELECT button.
Selectors captured 2026-09-24 (Amadeus "refx" Angular Material UI). Verified by hand in Chrome
against TLV->OTP 15 Oct (RO156, 4 fares, cheapest EUR 145.57); the packaged extension is untested.
**Adding host permissions can make Chrome disable an unpacked extension on reload -- if the Skyhop
page says "Assist off", re-enable it in `chrome://extensions`.**

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

## Wizz Air (W6) -- v0.5.0, elements found on the fly with Laya

Wizz's results are a plain URL, so `background.js` opens it directly and injects `drivers/laya-agent.js` then
`drivers/results.js`. There are **no Wizz selectors**: the driver finds the cookie banner's decline button, the
flight cards and the fare buttons at run time (Laya ranks "is this element ...?", regexes read times/prices),
matches the flight by departure time, and outlines the cheapest fare. It never presses SELECT.
**Needs the Laya service running** (`~/laya-service/start.sh`); it says so in the banner if it isn't.
New permissions: `https://www.wizzair.com/*` and `http://127.0.0.1:8799/*` (the Laya service, called from the
service worker). **Adding host permissions can make Chrome disable an unpacked extension on reload -- if the
Skyhop page says "Assist off", re-enable it in `chrome://extensions`.** Verified end to end in the packaged v0.5.3 extension with the real Laya service
(TLV->FCO 23 Oct, W46044 19:40: cheapest fare outlined, banner shown). Chrome's Site access must be on for
www.wizzair.com and 127.0.0.1:8799 ("Automatically allow access on the following sites"), otherwise injection fails.
The web app must pass `departTime` (all three Select buttons do) because Wizz's cards show no flight number.

## Airline registry, generic driver and learning -- v0.6.0

Airlines live in `airlines.json` (see its `_doc`); `drivers/results.js` is the generic, selector-free results driver
(formerly `wizzair.js`). An airline whose results-page URL isn't known yet (`discover`, i.e. all but Wizz Air, El Al
and TAROM today) is **taught by you once**: the first click opens its home page with a banner asking for one
TLV -> destination search on that date, by hand; the extension remembers the results URL as a template and
the button does it for you from then on. After editing `airlines.json` run `python3 tools/sync_assist_manifest.py`.
**New in 0.6.0: the `storage` permission and ~68 host permissions -- Chrome may disable the extension on reload;
re-enable it, and keep "Automatically allow access on the following sites" on.**

## Jev instead of Laya -- v0.7.0

The header of the Skyhop page has a **🧠 Laya / 🧠 Jev** badge next to "Assist on"; click it to switch which decision model
finds elements on airline pages. Jev (hosted, via OpenRouter) needs `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`) in the
project's `.env` and `docker compose up -d`; the key never leaves the server (the extension calls `/api/decide` there, which
needs the new host permission `http://127.0.0.1:8765/*` -- re-enable the extension if Chrome switches it off). Laya stays free
and offline. Details and measurements: `docs/DESIGN.md`, "Jev as an alternative decision model".

**Health check (v0.7.1):** on every load/refresh of the Skyhop page (and after a switch, and when the tab regains focus)
the page asks the extension to ping the chosen backend. If it's down the badge turns amber and reads "✕ not running",
with a message -- for Laya: "start it with ~/laya-service/start.sh, or switch to Jev"; for Jev: the reason (no key on the
server, server unreachable). It turns green again on its own once the backend answers.

## Jev on the web version -- v0.8.0

The extension now also attaches to the GitHub Pages site (`https://alon24.github.io/AiTravelSearcher/`). There is no
local server there, so when you sign in the page hands the extension its Cloudflare Worker and your Google sign-in, and
Jev's questions go to the Worker's `/decide` (new host permission `https://*.workers.dev/*`). The sign-in is kept only
until the browser closes or the token expires (about an hour); sign in again on the page to renew it. Jev is the
default on the web version until you pick Laya. **New host permissions: re-enable the extension in
`chrome://extensions` if Chrome switches it off after the update.**

**v0.8.1: learned links reach your phone.** When you're signed in on the web version, every results page the extension
learns (and the ones it already knew) is also sent to the Worker (`POST /links`). Phones can't run the extension, so
the site turns those links into **Search on <airline> site** buttons that open the airline's own results for the
flight's route and day. You pick the flight and pay there.
