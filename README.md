# Flight Agent

Flexible-date flight search: multi-destination, open-jaw, multi-stop between destinations,
mixed airlines out/back and self-transfer connections. Composes trips from **one-way** offers,
so any provider that can price a one-way flight works.

**Web UI:** run `docker compose up -d --build`, then open http://localhost:8765/ (search form, live progress, past searches).

Docs: [`docs/DESIGN.md`](docs/DESIGN.md) architecture, provider contract and a price-verification proposal; [`docs/STITCH_BRIEF.md`](docs/STITCH_BRIEF.md) UI design brief for Google Stitch.

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
cp .env.example .env            # FLIGHTAGENT_PROVIDER=mock works offline, no key needed
.venv/bin/flightagent --to ROM,PAR,LON --return-from BRU \
    --from-date 2026-10-01 --to-date 2026-11-15 --nights 4-7 \
    --self-transfer IST,ATH --connect --top 5        # add --json for machine output
.venv/bin/uvicorn flightagent.api:app                 # POST /search, POST /search/report
.venv/bin/pytest
node src/flightagent/web/airport-search.test.js   # typo/alias airport search (buka -> Bucharest)
python tools/build_airports.py                    # regenerate web/airports.json (OpenFlights + aliases)
```

## Providers
| name | status |
|---|---|
| `gflights` | **free**, scrapes Google Flights (no key). ~0.5 s per lookup at low concurrency |
| `serpapi` | Google Flights via SerpApi (`SERPAPI_API_KEY`); free plan = 250 credits/month, 1 credit per (origin, dest, day) |
| `mock` | deterministic fake fares, for development / tests |

`FLIGHTAGENT_PROVIDER` accepts a comma list as a fallback order. The default `gflights,serpapi`
scrapes for free and only spends SerpApi credits if Google blocks or breaks the scraper.

Scraper notes: it uses the `fast-flights` package for its browser-impersonating HTTP client, but
parses the page itself, because the library drops Google's "best flights" block (often the cheapest
fares). It accepts city codes (`ROM`, `LON`) directly. Scraping may violate Google's terms, can be
rate-limited or break when Google changes the page, so keep volume modest. `tests/fixtures/` holds a
real captured payload so a layout change shows up as a failing test.

Amadeus Self-Service was shut down on 2026-07-17 and Kiwi Tequila is invite-only, so neither is
implemented. Add a provider by implementing `FlightProvider.one_way` (`providers/base.py`).

## How it works
1. Enumerate (depart, return) pairs inside the window for the nights range.
2. For each pair: round trips, open-jaw (`destinations` x (`destinations` + `return_airports`)),
   and with `--connect` multi-stop `ORIGIN→D1→D2→ORIGIN` with every night split.
3. Collect the distinct one-way (origin, dest, day) lookups, check the call budget
   (`--max-calls`), fetch concurrently through a SQLite cache (TTL 6h).
4. Filter each leg (stops, layover min/max, max travel time). Self-transfer bundles two tickets
   through a hub when the gap is at least `--buffer` hours.
5. Rank: `effective_cost = price + value_of_time x hours (+ self-transfer penalty)`. Reported per
   departure day as cheapest and best value, plus top-N with segments, deep links and warnings.

## Limits worth knowing
- Prices are sums of one-way fares; a genuine round-trip fare from one airline can be cheaper.
- Times shown are local. Durations use the provider's real flight times (mock data ignores time zones).
- Deep links go to Google Flights searches; "book direct" links are airline home pages.
- Providers return only what Google Flights shows; some low-cost carriers may be missing.

## n8n chat front-end
`n8n/flight-agent-chat.json` is a chat workflow: Chat Trigger → AI Agent (OpenRouter model + memory)
→ `search_flights` HTTP tool → `POST http://flightagent:8765/search/simple`. The agent asks for
missing dates/nights, calls the API, and summarises the report. Regenerate with `python n8n/build_workflow.py`.

```bash
docker compose up -d --build     # API container on the existing `n8n_default` network (port 8765; 8000 is Portainer)
```
Then in n8n (http://localhost:5678): **Workflows → Import from file** → `n8n/flight-agent-chat.json`,
open the *OpenRouter Model* node and create an OpenRouter credential (paste the key there, not in `.env`; n8n stores it encrypted), then click **Open chat**.

Set `FLIGHTAGENT_PROVIDER=gflights,serpapi` in `.env` (then `docker compose up -d --build`) for real prices;
with `mock` every report is labelled DEMO DATA. `GET /health` shows the active provider.
