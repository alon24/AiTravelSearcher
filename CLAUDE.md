# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Skyhop (Python package `flightagent`): flexible-date flight search across many days, destinations and trip
lengths (round trip, open-jaw, multi-stop, mixed airlines, self-transfer). It never books or takes payment;
it hands the user off to the airline's own website. `README.md` covers the user flow; `docs/DESIGN.md` is the
detailed architecture/decision log (read the relevant section before changing a subsystem).

## Commands

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
cp .env.example .env                       # set FLIGHTAGENT_PROVIDER=mock to work offline
.venv/bin/pytest                           # whole suite
.venv/bin/pytest tests/test_engine.py::test_name   # one test
node src/flightagent/web/airport-search.test.js    # JS unit test for the airport typo/alias search
.venv/bin/uvicorn flightagent.api:app      # dev server (Docker serves on 127.0.0.1:8765)
docker compose up -d --build               # production-like run; data in volume flightagent-cache
flightagent --to ROM,PAR --from-date ... --to-date ... --nights 4-7 [--json]   # CLI search
flightagent-chat                           # natural-language REPL (needs OPENROUTER_API_KEY)
python tools/build_airports.py             # regenerate web/airports.json
python tools/sync_assist_manifest.py       # after editing browser-extension/airlines.json (a test runs --check)
```

UI tests (`tests/test_*_ui.py`) drive the real page in Chromium via Playwright and **skip silently** if
Playwright isn't installed: `pip install playwright` (in the cloud container pin `playwright==1.56.0` to
match the preinstalled Chromium in `/opt/pw-browsers`). `tests/conftest.py` starts the real FastAPI app in a
thread with `FLIGHTAGENT_PROVIDER=mock`, a temp SQLite DB and `FLIGHTAGENT_RECHECK=0`; the `page` fixture
clears localStorage and waits for `readForm`/`ac.from`. UI tests call page globals (e.g. `readForm()`) via
`page.evaluate`.

There is no linter or formatter configured.

## Architecture

- **Everything is built from one-way lookups** `(origin, dest, day) -> [Offer]`. `engine.py` plans trip
  shapes for every (depart, return) pair, collects the distinct one-way keys (plus hub legs for
  self-transfer), checks the call budget (`BudgetExceeded`), fetches concurrently through `cache.py`
  (SQLite, TTL 6h, empty results not cached), filters legs, then composes and ranks trips by
  `effective_cost = price + value_of_time x hours (+ self-transfer penalty)`. Because legs are independent,
  cheapest/best-value trips are sums of per-leg picks; only "same airline" needs a product.
- **Providers** (`providers/`) implement `FlightProvider.one_way` (`base.py`). `FLIGHTAGENT_PROVIDER` is a
  comma list used as a fallback chain (default `gflights,serpapi`; `mock` for dev/tests). `gflights` scrapes
  Google Flights using `fast-flights` only for its HTTP client and parses the page itself;
  `tests/fixtures/` holds a real captured payload so a Google layout change fails a test.
  `laya_classify.py`, `elal_verify.py`, `wizzair_verify.py` are optional diagnostics/verification, not search providers.
- **Data model** in `models.py` (pydantic): `SearchRequest` -> `SearchResult` with `Trip`/`LegView`/`Offer`/
  `Segment`. Segment times are naive **local** times; durations come from the provider's flying minutes, never
  from subtracting local times. `Offer.price` is the total for all travellers.
- **API** (`api.py`, FastAPI) serves both the JSON API and the static web UI. The UI flow is async:
  `POST /api/searches` returns an id, the page polls `GET /api/searches/{id}`; results are stored by
  `history.py` (SQLite) and listed as "past searches". Other notable routes: `/search` and `/search/report`
  (sync), `/search/simple` (flat params, used by chat), `/api/chat`, `/api/itinerary/check` (gap checks for
  the trip builder, `itinerary.py`), `/api/airline-site` (`airline_sites.py`, Wikidata lookup), `/api/decide`
  (`decide.py`, proxies the Laya/Jev decision model so the OpenRouter key stays server-side).
- **Chat** (`chat.py`): one OpenRouter call turns a sentence into `simple.py`'s `SimpleSearch`, then the normal
  deterministic search runs. Sessions are in memory only. (The old n8n workflow was removed; don't reintroduce it.)
- **Web UI** (`src/flightagent/web/`): plain JS, no build step, scripts loaded with `defer` from `index.html`
  and sharing globals (`app.js` is the core; `builder.js`, `finder.js`, `mix.js`, `compare.js` add the trip
  builder, airline finder, mix & match and compare matrix). Trip builder / mix state lives in the browser's
  localStorage, not the server. Visual rules come from `docs/stitch/DESIGN.md` (Stitch design system).
- **Browser extension** (`browser-extension/`, Chrome MV3): "Select ... on site" opens the airline's site and
  drives it to the exact flight (never checks out). `airlines.json` is the airline registry; `drivers/` has
  airline-specific drivers (El Al, TAROM) plus a generic results driver assisted by Laya/Jev. The extension
  exists because airline anti-bot blocks server-side automation. Keep `manifest.json` host_permissions in
  sync via `tools/sync_assist_manifest.py`; new host permissions can make Chrome disable an unpacked extension
  on reload. See `browser-extension/README.md` for per-airline history.

## Config

All settings are env vars read from `.env` (see `.env.example`): `FLIGHTAGENT_PROVIDER`, `SERPAPI_API_KEY`,
`FLIGHTAGENT_CACHE_DB`, `FLIGHTAGENT_HISTORY_DB`, `FLIGHTAGENT_CACHE_TTL_HOURS`, `FLIGHTAGENT_RECHECK`,
`FLIGHTAGENT_DECIDER` (`laya`|`jev`), `FLIGHTAGENT_LAYA`/`_URL`, `OPENROUTER_API_KEY`,
`FLIGHTAGENT_JEV_MODEL`, `FLIGHTAGENT_CHAT_MODEL`. docker-compose forces the cache DB onto the `/data` volume
and binds only to 127.0.0.1:8765.
