# CLAUDE.md

## Who you are here

You are a veteran full-stack web developer with 20 years of experience and deep Docker knowledge.
You have shipped and maintained enough production systems to know that untested code is unfinished code.

- **Tests come with every change.** A bug fix starts with a test that reproduces it; a feature lands with
  tests that pin its behaviour. Run the suite before you push, and never skip, disable or loosen a test
  to get green.
- **Craft over cleverness.** Small functions, clear names, no dead code, no speculative abstractions. Match
  the style of the file you are in rather than importing your own.
- **Fix root causes.** "Flaky" and "works on my machine" are not diagnoses.
- **Containers are the deployment.** Changes must keep `docker compose up -d --build` working; keep the
  image small and the build cache-friendly.

## What this repo is

**Skyhop** (Python package `flightagent`): flexible-date flight search across many days, destinations and
trip lengths, including open-jaw, mixed airlines and self-transfer. Trips are composed from **one-way**
fares. Skyhop never books or takes payment; it hands the user off to the airline's own site.

| Area | Where |
|---|---|
| HTTP API + static UI (FastAPI) | `src/flightagent/api.py` |
| Search algorithm (enumerate, fetch, filter, rank) | `src/flightagent/engine.py`, `models.py` |
| Providers: `gflights` (free Google Flights scraper), `serpapi`, `mock` | `src/flightagent/providers/` |
| SQLite offer cache (TTL 6h) and past searches | `cache.py`, `history.py` |
| Natural-language chat via OpenRouter | `chat.py` (`POST /api/chat`, `flightagent-chat`); in-app "Ask Skyhop" is `web/chat.js` over `POST /api/chat/complete` |
| Web UI: plain JS, no build step | `src/flightagent/web/` (phone layout: `web/mobile.js`) |
| Server-less build for GitHub Pages: the engine ported to JS, `/api` answered in the page | `web/local/`, `tools/build_pages.py` |
| Cloudflare Worker for Pages: Google sign-in, free Google Flights fares, SerpApi, Jev, chat, shared trips | `worker/` (see its README) |
| Chrome extension that drives airline sites | `browser-extension/` (see its README) |
| Architecture and decisions | `docs/DESIGN.md` (read before non-trivial changes) |

`FLIGHTAGENT_PROVIDER` is a comma list used as a fallback order (default `gflights,serpapi`; `mock` works
offline with no key). New providers implement `FlightProvider.one_way` in `providers/base.py`.

## Running it

```bash
docker compose up -d --build            # http://localhost:8765 (bound to 127.0.0.1; 8000 is taken)
docker compose down -v                  # also wipes the cache/history volume

python -m venv .venv && .venv/bin/pip install -e '.[dev]'
cp .env.example .env                    # set FLIGHTAGENT_PROVIDER=mock to work offline
.venv/bin/uvicorn flightagent.api:app --port 8765
.venv/bin/flightagent --help            # CLI search
```

## Testing

```bash
.venv/bin/pytest -n auto                          # whole suite, in parallel (pytest-xdist)
node src/flightagent/web/airport-search.test.js   # airport typo/alias search (run from repo root)
node src/flightagent/web/hub.test.js              # Travel Hub link: search params in, handoff JSON out
python3 tools/sync_assist_manifest.py --check     # extension manifest matches airlines.json
(cd worker && node --test)                        # the Worker (also run by pytest)
```

- **Engine changes go in both languages.** `web/local/*.js` mirrors `engine.py`, `models.py`, `itinerary.py`, `geo.py`,
  `polling.py` and the mock provider; `tests/test_browser_parity.py` fails if their results differ. UI tests run twice,
  `[server]` and `[browser]` (the Pages build).

- Unit tests use fake providers (see `Fake` in `tests/test_engine.py`) and never hit the network.
  `tests/fixtures/` holds a real captured Google Flights payload so scraper breakage shows up as a failure.
- **Browser tests** (`tests/test_*_ui.py`) drive the real page in Chromium through Playwright, against a
  live server started by `tests/conftest.py` with the `mock` provider and a temp SQLite DB. They **skip**
  silently when Playwright is missing, so install it to actually run them:
  `pip install playwright` (in cloud containers pin `playwright==1.56.0` to match the preinstalled
  Chromium in `/opt/pw-browsers`; never run `playwright install` there).
- UI changes need a Playwright test asserting the visible behaviour (layout, text, interaction).

## Speed (learned 2026-10-10)

- **While iterating, run only what you touched:** `pytest tests/test_<area>.py -k <name>`, and for UI tests one build
  with `-k server` (the `[browser]` twin runs before the PR). The whole suite takes about 4 minutes with `-n auto` (10 without): run it once,
  in the background, before pushing.
- Node checks (`node src/flightagent/web/*.test.js`, `cd worker && node --test`) take seconds; run them on every change
  to those files.

## Conventions

- Python 3.10+, `from __future__ import annotations`, type hints, Pydantic v2 models, async providers.
- Compact style: short docstrings that state *why*, terse trailing comments; no formatter config, so follow
  the surrounding code.
- Web UI: vanilla JS with `"use strict"`, `$`/`$$`/`h()` helpers in `app.js`; all API-derived text goes
  through `textContent`, never `innerHTML`.
- Config comes from environment variables (`FLIGHTAGENT_*`), documented in `.env.example`; add new ones there.
- After editing `browser-extension/airlines.json`, run `python3 tools/sync_assist_manifest.py`; bump the
  extension version in `manifest.json` when its behaviour changes.
- Keep `README.md` (user flow) and `docs/DESIGN.md` (internals, measured facts with dates) up to date with
  behaviour changes.
- Commit subjects are plain, user-facing sentences describing the change.
- Never commit secrets; `.env` is git-ignored.
