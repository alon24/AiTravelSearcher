# Skyhop / Flight Agent: Design

Status: implemented except section 8 (price verification), which is a proposal.
Audience: a maintainer, a reviewer, or anyone plugging in a **third-party flight-data provider**.

## 1. Goal

Given an origin, one or more destinations, a date window and a trip length, find the cheapest
(and best value) trips. The engine supports round trips, open-jaw, multi-stop between destinations,
mixed airlines, self-transfer connections and layover/duration limits. Output is JSON for machines and a
readable report or web UI for people.

Non-goals: booking, payment, fare rules, baggage pricing, seat selection.

## 2. Architecture

```
 Browser UI ──┐                                   ┌── gflights   (free scrape of Google Flights)
 n8n agent ───┼─►  FastAPI (api.py)  ─►  Engine ──┼── serpapi    (Google Flights via SerpApi, paid quota)
 CLI ─────────┘        │                  │       └── mock       (deterministic fake data)
                       │                  └─► OfferCache (SQLite, per one-way lookup)
                       └─► History (SQLite, past searches + results)
```

- **One Python service** (`src/flightagent/`), one Docker container, on the `n8n_default` network.
  The web UI is static files served by the same service (`web/`, no build step).
- **n8n** is only a chat front-end: Chat Trigger → AI Agent → HTTP tool → `POST /search/simple`.
  The LLM turns words into parameters; all search logic is deterministic Python.
- **Everything is composed from one-way lookups**: `(origin, destination, day) -> offers`. Round trips,
  open-jaw, mixed airlines and self-transfer are built by combining one-way offers. That is why any
  provider that can price a one-way flight can be plugged in.

## 3. Data model (`models.py`)

| Type | Meaning |
|---|---|
| `SearchRequest` | Validated input. Codes are upper-cased. `allow_connections=false` forces `max_stops_per_leg=0`. |
| `Segment` | One flight: airline code/name, flight number, origin, destination, local dep/arr time, `duration_min` (real flying time). |
| `Offer` | One purchasable one-way ticket, or a self-transfer bundle (`self_transfer=True`, `hub` set). `price` is the **total for all travellers**, in `currency`. |
| `LegView`, `Trip` | A leg as presented, and a full itinerary (2 legs, or 3 for multi-stop) with total price, stops, travel time, warnings and `effective_cost`. |
| `DailyBest` | For one departure day: the cheapest trip and the best-value trip. |
| `SearchResult` | `daily`, `top`, `api_calls`, `cache_hits`, `sources` (provider -> lookups served), `elapsed_s`, `warnings`. |

Time rules: segment times are **local** to each airport (naive datetimes). Durations use the provider's
real flying minutes plus layovers, because subtracting local times is wrong across time zones.

## 4. Search algorithm (`engine.py`)

1. **Plan shapes.** For every (depart, return) pair in the window with `min..max` nights:
   round trip to each destination, open-jaw (each destination x each of destinations + `return_airports`),
   and with `connect_destinations` multi-stop `O→D1→D2→O` for every night split.
2. **Collect required lookups.** The set of distinct `(origin, dest, day)` keys. With self-transfer,
   add `(O,H,day)`, `(H,D,day)`, `(H,D,day+1)` for each hub `H`.
3. **Budget and estimate.** Uncached lookups above `max_api_calls` raise `BudgetExceeded` before any call.
   `estimate()` returns `{lookups, cached, to_fetch}`.
4. **Fetch.** Concurrently (semaphore 8), through the cache. A failing lookup becomes a warning; if every
   lookup fails the search fails. Empty results are **not cached**.
5. **Per-leg options.** Build self-transfer bundles (gap >= `max(buffer, min_layover)` and <= `max_layover`),
   then filter: stops, every layover within `[min, max]`, total time <= cap. Keep the 6 best per leg by leg cost.
6. **Compose trips.** Legs are independent, so the cheapest trip is the sum of per-leg minima and the best-value
   trip is the sum of per-leg best-value picks. Only "same airline" couples outbound and return and needs a product.
7. **Rank.** `effective_cost = price + value_of_time_per_hour * hours_in_transit (+ self_transfer_penalty)`.
   Lower is better. Daily table = cheapest and best value per departure day; `top` = best N by `effective_cost`.

Warnings are attached to trips: self-transfer (separate tickets, baggage, no protection), layover >= 8 h,
open-jaw ground transport, different airlines out/back.

## 5. Provider contract (`providers/base.py`)

```python
class FlightProvider(Protocol):
    name: str
    async def one_way(self, origin: str, dest: str, day: date, *,
                      currency: str, adults: int, max_stops: int,
                      children: int = 0, infants: int = 0) -> list[Offer]: ...
```

A provider **must**:

1. Return every itinerary the source shows for that route and day, not only "top" ones. (The `fast-flights`
   library silently dropped Google's "best flights" block, which contained the cheapest fares.)
2. Return `[]` when the source says there are no flights, and **raise** on anything else (blocked, timeout,
   quota, layout change, bad credentials). The engine treats an exception as "unknown", not "none".
   Never return `[]` for an error: it hides failures and would be treated as a real answer.
3. Fill `Segment.duration_min` with real flying minutes when the source has it.
4. Return `price` as the total for all travellers (`adults` + `children` + lap `infants`) in the requested
   `currency`, and set `Offer.provider`. Ages are mapped by the engine: under 2 infant, 2-11 child, 12+ adult.
5. Use local departure/arrival times and IATA airport codes in segments.
6. Honour `max_stops` (0 to 3) or tolerate the engine filtering afterwards. The engine re-filters anyway.
7. Cope with **city codes** (`ROM`, `LON`, `PAR`, `NYC`). Either accept them (gflights) or expand them to
   airports (`providers/airports.py`, used by serpapi).
8. Be safe under concurrency: bound its own request rate (gflights: 3 in flight plus a 0.2-0.7 s jitter).

Composition: `FallbackProvider(primary, backup)` uses the backup only when the primary **raises**.
`FLIGHTAGENT_PROVIDER=gflights,serpapi` builds that chain. Results carry `.source` so reports show which provider
served each lookup.

### Adding a provider (checklist)
1. `providers/<name>.py` implementing `one_way`; keep the network code and the pure parser separate.
2. Save a **real captured response** under `tests/fixtures/` and unit-test the parser (see
   `test_gflights_parses_best_and_other_groups`).
3. Register it in `providers/__init__.py::_one`.
4. Compare against an existing provider on the same routes and dates (section 8) before trusting it.
5. Add rate limits, a timeout, and an error message that names the route and day.

### Airline coverage and passengers (measured, Sept 2026)
- The engine searches **routes and days, never airlines**: Google returns every carrier it sells for that route.
  Observed on real queries: Ryanair (FR, RK), Wizz Air (W4/W6), easyJet (U2), Jet2 (LS), JetBlue (B6), Southwest (WN),
  Frontier (F9), Bluebird Airways (BZ), Israir, El Al, Aegean, ITA and more. A carrier is only missing if Google does
  not sell it on that route.
- Prices are **totals for all travellers**. Children are priced by age (under 2 infant, 2-11 child, 12+ adult).
  Some airlines price children like adults; others (e.g. Swiss) charge less.
- **Infants:** fast-flights swaps the wire values for lap and seat infants. Measured against Google, value 3 is a lap
  infant (fare equals the adult-only fare) and 4 an infant with its own seat, so the scraper sends raw values.
  With a lap infant Google returned about half as many itineraries: airlines that do not carry infants are hidden.
- Google lists some flights **without a price**; the parser skips them (a crash here once forced whole route-days onto the paid fallback).
- The cache key is versioned (`v2|`) so a provider-semantics change never serves stale prices.

### Unpriced flights, rechecks and the cache (measured, Sept 2026)
- Google lists some flights **without a fare**. It is intermittent: HiSky (H4236, TLV-OTP) was priced on 8 of 8 fetches,
  then on 0 of 12 half an hour later, and it showed the fare in a real browser. Euroairlines is unpriced every time
  (Google shows "Price unavailable"). So the parser **keeps** unpriced flights (`Offer.priced=False`): they are never
  ranked or counted as fares, but they are listed (results panel, trip builder, report) and counted as "flies here".
- **Cache lifetime is per entry** (`polling.py`): results with unpriced flights expire after 15 min when the flight is
  within 14 days, 1 h to 60 days, 3 h beyond; priced fares expire after 1 h within 2 days and 3 h within 14 days.
  `refresh_unpriced` makes a search ignore cached "no price" entries.
- **Recheck**: `POST /api/searches/{id}/recheck`, plus a background loop (every minute) that re-runs searches whose
  `next_check` is due, on the schedule above, backing off x2 after 4 fruitless rechecks (cap 6 h) and stopping when the
  flight has departed. `FLIGHTAGENT_RECHECK=0` disables the loop.
- **Last seen fare**: the cache remembers the last price per flight (`fares` table), so a flight Google later shows
  without a price is listed as "last seen ₪505, 2h ago" (may be out of date).
- The scraper asks again (twice, 1 s apart) when it sees an unpriced flight. That rarely helps, since the fare comes
  back minutes later, which is what the scheduled recheck is for.

### Airline finder, trip builder, airline filters
- `POST /api/explore`: which airlines fly between an origin and a country's airports (or listed airports). One date for
  every airport, then 2 more dates only for airports with flights. Per airline: airports served, nonstop or not, cheapest fare.
- Trip builder (`web/builder.js`, `GET /api/flights`, `POST /api/itinerary/check`): hand-built legs; `itinerary.py`
  computes gaps with airport time zones, flags tight or impossible connections, and mentions the estimated ground transfer
  between airports of one city (`geo.py`; estimates supplied by us, not measured data).
- Airline include/exclude filters apply after fetching, so changing them costs no lookups.

### Currency display
- A search runs in one currency (the button's value at that time) and results are stored in it. The currency button
  changes the whole screen at once by **converting displayed prices** with `GET /api/rates` (ECB via frankfurter.dev,
  cached 6 h, approximate fallback), so nothing is re-fetched. `money()` in `app.js` is the single place that converts.
- Whenever a price is converted it is labelled: a "Converted from ILS" badge, an "originally ₪194" line on pick cards, trip
  and builder prices, and a **Show original currency** switch. Original amounts are what Google quoted for that search; we cannot
  know the currency an airline itself sells in, so search in a currency to see Google's price for it.

### Current providers
| Name | Source | Cost | Notes |
|---|---|---|---|
| `gflights` | Scrapes Google Flights (`fast-flights` HTTP client, own parser) | free | Accepts city codes. May break or be blocked; scraping may violate Google's terms. |
| `serpapi` | SerpApi `engine=google_flights` | 1 credit per lookup; free plan 250/month | Needs `SERPAPI_API_KEY`. City codes are expanded to airport lists. |
| `mock` | Deterministic fake fares | free | UI and reports are labelled DEMO DATA. |

Candidates (research as of Sept 2026, **not verified with our data**): Travelpayouts/Aviasales data API,
FlightAPI.io, Skyscanner via RapidAPI. Not viable: Amadeus Self-Service (shut down 2026-07-17), Kiwi Tequila
(invite-only), Duffel (sellers only).

## 6. API (`api.py`)

| Endpoint | Purpose |
|---|---|
| `POST /search`, `/search/report` | Structured search; JSON or text report. |
| `POST /search/simple` | Flat all-string form for LLM tool calls. Returns `{report}` or `{error}`, never an HTTP error for bad input. |
| `POST /api/estimate` | Lookup count and cache state for a request. |
| `POST /api/searches` | Start a background search, returns `{id}`. 422 if over budget. |
| `GET /api/searches`, `/api/searches/{id}` | History list (light), or one search with progress, request and full result. |
| `DELETE /api/searches/{id}` | Remove from history. |
| `GET /api/config`, `/health` | Active provider chain and airline booking links; liveness. |

Jobs run as asyncio tasks; progress (`done/total` lookups) is written to `History`. Searches still `running`
at startup are marked failed. The cache key is `provider|origin|dest|day|currency|adults|max_stops`, TTL 6 h.

## 7. Configuration

`.env` (loaded by Docker Compose): `FLIGHTAGENT_PROVIDER` (comma list = fallback order), `SERPAPI_API_KEY`,
`FLIGHTAGENT_CACHE_TTL_HOURS`. The compose file pins `FLIGHTAGENT_CACHE_DB=/data/offers.sqlite` so the cache and
`history.sqlite` live on the `flightagent-cache` volume. Never commit `.env`.

## 8. Proposal: price verification by an independent provider

**Problem.** A provider can be wrong in ways we cannot see (a parser bug hid the cheapest fares for the
scraper). A trip shown as "cheapest" is only trustworthy if a second, independent source agrees.
Manually comparing `gflights` and `serpapi` on TLV→FCO (2026-10-05) matched on all shared flights
(9 itineraries, identical prices) only after the parser fix, which is the case for automating this check.

**Design.**
1. New setting `FLIGHTAGENT_VERIFIER=<provider name>` (must differ from the search provider).
2. `verify(trip)` for each leg: call the verifier's `one_way(origin, dest, day)` and find the same flight by
   airline code + flight number + departure time (all segments must match). Do not match on price.
3. Per-leg result `Verification{status, seen_price, delta, provider, checked_at}` with:
   - `confirmed`: found, price within tolerance (default max(3 %, 5 in currency));
   - `price_differs`: found, outside tolerance (show both prices);
   - `not_found`: the verifier does not list that flight (inconclusive, not proof of error);
   - `error`: verifier failed.
4. A trip's overall status is the worst leg status. Only cheap checks run: the top N trips plus the selected day,
   not the whole grid, so cost is about `2 x N` lookups.
5. API: `POST /api/searches/{id}/verify?trip=<index>` (on demand from the UI) storing results in the history row.
6. UI: a badge on each trip card ("Verified by serpapi", "Price differs: $161 vs $175", "Not found"), plus a
   "Verify" button that spends verifier quota only when pressed.
7. Provider conformance test (`tests/provider_contract.py`): for a fixed set of routes and dates, run any new
   provider against a reference provider and report matching rate, price deltas and dropped flights. A new
   provider must reach >= 95 % flight overlap and price agreement within tolerance on the sample before it is enabled.

**Acceptance criteria.**
- With a verifier set, the top 5 trips show a status within one request cycle.
- A deliberately corrupted fixture (price changed by 20 %) is reported as `price_differs`.
- A flight missing from the verifier is `not_found`, never `confirmed`.
- With no verifier configured nothing changes and no extra lookups are made.

## 9. Risks and open questions

- **Scraping fragility and terms.** `gflights` can be blocked or break on a layout change. The fixture test should
  fail loudly, and the fallback chain covers outages but spends quota.
- **Quota.** Free SerpApi = 250 lookups per month; a wide multi-city search needs about 250. The estimate and
  `max_api_calls` protect it. A two-stage search (coarse scan then refine) would cut cost about 3x. Not built.
- **One-way sums.** Round-trip fares from one airline can be cheaper than two one-ways. The engine never sees them.
- **Timezones.** Local times are shown as returned; durations come from the provider.
- **Prices are indicative.** No booking flow: deep links go to Google Flights or airline home pages.
- **Open:** which second provider to verify against (candidates in section 5), and the tolerance rule.

## 10. Reviewer checklist

- [ ] Can a provider return `[]` for an error anywhere? (It must raise.)
- [ ] Are empty results ever cached? (They must not be.)
- [ ] Do durations use real minutes and not local time differences?
- [ ] Do city codes work for every provider on the default path?
- [ ] Is a secret ever logged, stored in history, or committed?
- [ ] Does a failed job always end as `failed` with a readable error?

## 11. Layout

```
src/flightagent/  api.py engine.py models.py history.py cache.py report.py cli.py links.py
                  providers/{base,gflights,serpapi,mock,airports}.py   web/{index.html,style.css,app.js,airports.json}
tests/            test_engine.py  fixtures/gflights_tlv_fco_2026-10-05.json
n8n/              build_workflow.py -> flight-agent-chat.json
docs/DESIGN.md    this file
```
Airport data: OpenFlights (ODbL), `web/airports.json`.
