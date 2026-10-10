from __future__ import annotations

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from functools import lru_cache
from datetime import date, timedelta
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from .airline_sites import resolve as resolve_airline_site
from .chat import ChatError, chat as run_chat
from .decide import configured_decider, decide_jev, jev_configured, spent_usd
from .engine import BudgetExceeded, FlightSearchEngine, leg_view
from .explore import ExploreResult, explore
from .geo import airports_by_country, country_airports
from .history import History
from .itinerary import ItineraryCheck, analyse
from .links import AIRLINE_SITES, BAG_NOTES, BAG_SHORT, KNOWN_AIRLINES
from .models import LegView, SearchRequest, SearchResult, Trip
from .polling import next_check_time
from .report import render
from .simple import SimpleSearch, build_engine, build_verifier, run_simple_search, to_request, verifier_name
from .verify import trip_key, verify_trips

load_dotenv()


async def _recheck_loop() -> None:
    """Every minute, re-poll searches that still have unpriced flights and are due (15 min for near departures)."""
    while True:
        await asyncio.sleep(60)
        if os.getenv("FLIGHTAGENT_RECHECK", "1") == "0":
            continue
        try:
            for sid in history().due(time.time()):
                try:
                    await _recheck(sid)
                except HTTPException:
                    pass
                except Exception:      # provider trouble: try again later instead of hammering it
                    history().postpone(sid, time.time() + 1800)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_recheck_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Flight Agent", lifespan=lifespan)


@lru_cache
def _history(path: str) -> History:
    return History(path)


def history() -> History:
    cache_db = os.getenv("FLIGHTAGENT_CACHE_DB", ".cache/offers.sqlite")
    return _history(os.getenv("FLIGHTAGENT_HISTORY_DB") or str(Path(cache_db).with_name("history.sqlite")))


async def run(req: SearchRequest) -> SearchResult:
    try:
        return await build_engine().search(req)
    except BudgetExceeded as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.post("/search", response_model=SearchResult)
async def search(req: SearchRequest) -> SearchResult:
    return await run(req)


@app.post("/search/report")
async def search_report(req: SearchRequest) -> dict[str, str]:
    return {"report": render(await run(req))}


@app.post("/search/simple")
async def search_simple(s: SimpleSearch) -> dict[str, str]:
    return await run_simple_search(s)


class ChatBody(BaseModel):
    message: str
    session_id: str | None = None


@app.post("/api/chat")
async def chat_endpoint(b: ChatBody) -> dict:
    """Natural-language search, no n8n: see chat.py. Pass back the returned session_id to continue the conversation."""
    try:
        return await run_chat(b.message, b.session_id)
    except ChatError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "provider": os.getenv("FLIGHTAGENT_PROVIDER", "mock")}


# ---------------------------------------------------------------- web UI API

_jobs: set[asyncio.Task] = set()  # strong refs so running searches are not garbage collected


async def _run_job(sid: str, req: SearchRequest) -> None:
    hist = history()
    try:
        result = await build_engine().search(req, on_progress=lambda d, t: hist.progress(sid, d, t))
        best = min((d.cheapest.price for d in result.daily), default=None)
        hist.finish(sid, result.model_dump_json(), best,
                    next_check_time([u.date for u in result.unpriced], 0, time.time()))
    except Exception as e:  # recorded for the UI instead of vanishing in a background task
        hist.fail(sid, str(e) or type(e).__name__)


@app.get("/api/config")
async def config() -> dict:
    try:
        verifier = verifier_name()
    except RuntimeError:
        verifier = None
    return {"provider": os.getenv("FLIGHTAGENT_PROVIDER", "mock"), "verifier": verifier, "airline_sites": AIRLINE_SITES, "airlines": KNOWN_AIRLINES, "bag_notes": BAG_NOTES, "bag_short": BAG_SHORT}


# Typed decisions for the browser extension when it uses Jev: the OpenRouter key lives on this server, never in the
# extension. The custom header makes a browser send a CORS preflight (which this app doesn't answer), so an arbitrary
# web page can't make the user's browser spend the key; size and question limits bound each call.
class DecideBody(BaseModel):
    state: object
    questions: dict


def _require_skyhop_header(x_skyhop: str | None) -> None:
    if x_skyhop != "1":
        raise HTTPException(403, "missing X-Skyhop header")


# The official website of an airline we have no address for (see airline_sites.py): a real https address or null, never a search page.
@app.get("/api/airline-site")
async def airline_site(code: str = "", name: str = "", x_skyhop: str | None = Header(default=None)) -> dict:
    _require_skyhop_header(x_skyhop)
    return await asyncio.to_thread(resolve_airline_site, code, name)


@app.get("/api/decide/health")
def decide_health(x_skyhop: str | None = Header(default=None)) -> dict:
    _require_skyhop_header(x_skyhop)
    return {"jev_configured": jev_configured(), "decider": configured_decider(), "spent": spent_usd()}


@app.post("/api/decide")
async def decide(b: DecideBody, x_skyhop: str | None = Header(default=None)) -> dict:
    _require_skyhop_header(x_skyhop)
    try:
        out = await asyncio.to_thread(decide_jev, b.state, b.questions)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    return {**out, "backend": "jev"}


@app.post("/api/estimate")
async def estimate(req: SearchRequest) -> dict[str, int]:
    return build_engine().estimate(req)


@app.post("/api/searches")
async def create_search(req: SearchRequest) -> dict[str, str]:
    est = build_engine().estimate(req)
    if est["to_fetch"] > req.max_api_calls:
        raise HTTPException(422, str(BudgetExceeded(est["to_fetch"], req.max_api_calls)))
    sid = uuid.uuid4().hex[:12]
    history().create(sid, req)
    task = asyncio.create_task(_run_job(sid, req))
    _jobs.add(task)
    task.add_done_callback(_jobs.discard)
    return {"id": sid}


_rechecking: set[str] = set()


async def _recheck(sid: str) -> dict[str, int]:
    """Re-run a finished search, ignoring cached results that contain unpriced flights. Replaces the stored result."""
    hist = history()
    row = hist.get(sid)
    if not row or row["status"] != "done" or not row.get("result"):
        raise HTTPException(404, "search not found or not finished")
    if sid in _rechecking:
        raise HTTPException(409, "a recheck is already running for this search")
    _rechecking.add(sid)
    try:
        before = len(row["result"].get("unpriced", []))
        result = await build_engine().search(SearchRequest(**{**row["request"], "refresh_unpriced": True}))
        rechecks = row["rechecks"] + 1
        best = min((d.cheapest.price for d in result.daily), default=None)
        hist.replace_result(sid, result.model_dump_json(), best,
                            next_check_time([u.date for u in result.unpriced], rechecks, time.time()), rechecks)
        return {"before": before, "after": len(result.unpriced)}
    finally:
        _rechecking.discard(sid)


class FilterBody(BaseModel):
    airlines_include: list[str] = []
    airlines_exclude: list[str] = []


@app.post("/api/searches/{sid}/filter")
async def filter_search(sid: str, body: FilterBody) -> dict:
    """Change the airline filter of a finished search in place, instantly: the result is recomputed from the flights
    already saved (even ones past their expiry: `data_from` tells the UI how old they are), with no new lookups."""
    hist = history()
    row = hist.get(sid)
    if not row or row["status"] != "done":
        raise HTTPException(404, "search not found or not finished")
    try:
        req = SearchRequest(**{**row["request"], "airlines_include": body.airlines_include, "airlines_exclude": body.airlines_exclude, "stale_ok": True})
        result = await build_engine().search(req)
    except (ValidationError, RuntimeError) as e:
        raise HTTPException(422, str(e))
    stored = req.model_copy(update={"stale_ok": False})
    best = min((d.cheapest.price for d in result.daily), default=None)
    hist.update_search(sid, stored.model_dump_json(), result.model_dump_json(), best,
                       next_check_time([u.date for u in result.unpriced], row["rechecks"], time.time()))
    return hist.get(sid)


@app.post("/api/searches/{sid}/recheck")
async def recheck_search(sid: str) -> dict:
    """Ask again about flights that had no price. Returns how many were unpriced before and after."""
    try:
        changed = await _recheck(sid)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"changed": changed, "search": history().get(sid)}


VERIFY_TOP = 5     # "Verify" without a trip checks this many top trips: about 2 lookups each


@app.post("/api/searches/{sid}/verify")
async def verify_search(sid: str, trip: int | None = None, key: str | None = None) -> dict:
    """Re-check prices on the independent provider set by FLIGHTAGENT_VERIFIER (docs/DESIGN.md section 8). `trip` is
    an index into the result's top list, `key` any trip of the result (as trip_key() writes it); neither = the top 5.
    Spends verifier lookups only when called. Results are stored on the history row under `verifications`."""
    try:
        verifier = build_verifier()
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    if verifier is None:
        raise HTTPException(409, "No verifier configured: set FLIGHTAGENT_VERIFIER to a second provider (e.g. serpapi)")
    row = history().get(sid)
    if not row or row["status"] != "done" or not row.get("result"):
        raise HTTPException(404, "search not found or not finished")
    res = row["result"]
    top = [Trip.model_validate(t) for t in res.get("top", [])]
    if trip is not None:
        if not 0 <= trip < len(top):
            raise HTTPException(404, f"no trip {trip} in this search's top {len(top)}")
        trips = [top[trip]]
    elif key is not None:
        every = top + [Trip.model_validate(t) for d in res.get("daily", []) for t in (d["cheapest"], d["best_value"])] \
            + [Trip.model_validate(c["cheapest"]) for c in res.get("cells", [])]
        trips = [next((t for t in every if trip_key(t) == key), None)]
        if trips[0] is None:
            raise HTTPException(404, "that trip is not part of this search's result")
    else:
        trips = top[:VERIFY_TOP]
    checked = await verify_trips(trips, SearchRequest(**row["request"]), verifier)
    found = {trip_key(t): v.model_dump(mode="json") for t, v in zip(trips, checked)}
    history().add_verifications(sid, found)
    return {"verifier": verifier.provider.name, "checked": found, "lookups": verifier.api_calls, "cache_hits": verifier.cache_hits,
            "search": history().get(sid)}


@app.get("/api/searches")
async def list_searches() -> list[dict]:
    return history().list()


@app.get("/api/searches/{sid}")
async def get_search(sid: str) -> dict:
    row = history().get(sid)
    if not row:
        raise HTTPException(404, "search not found")
    return row


@app.delete("/api/searches/{sid}")
async def delete_search(sid: str) -> dict[str, bool]:
    return {"deleted": history().delete(sid)}


# Static UI last, so it never shadows the API routes.
@app.get("/api/flights")
async def flights(origin: str, dest: str, day: date = Query(alias="date"), adults: int = 1, children_ages: str = "",
                  currency: str = "USD", max_stops: int = 2) -> dict:
    """All one-way flights for one route and day, cheapest first (for the trip builder)."""
    try:
        req = SearchRequest(
            origin=origin, destinations=[dest], window_start=day, window_end=day + timedelta(days=1), min_nights=1, max_nights=1,
            adults=adults, children_ages=[int(x) for x in children_ages.replace(",", " ").split()], currency=currency,
            max_stops_per_leg=max_stops)
    except ValidationError as e:
        raise HTTPException(422, "; ".join(err["msg"].removeprefix("Value error, ") for err in e.errors()))
    try:
        offers = await build_engine().one_way_options(req, req.origin, req.destinations[0], day)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    views = sorted((leg_view(o) for o in offers), key=lambda v: (not v.priced, v.price, v.duration_min))[:40]
    return {"origin": req.origin, "dest": req.destinations[0], "date": day.isoformat(), "travellers": req.pax_label,
            "currency": currency, "flights": [v.model_dump(mode="json") for v in views]}


_RATES: dict = {"at": 0.0, "data": None}
FALLBACK_RATES = {"USD": 1.0, "ILS": 3.0, "GBP": 0.75, "EUR": 0.87}     # rough, measured against Google's own prices


@app.get("/api/rates")
async def rates() -> dict:
    """USD-based rates used to convert prices already on screen. ECB rates via frankfurter.dev, cached for 6 h;
    an approximate fallback (retried after 10 min) if the lookup fails."""
    now = time.time()
    if _RATES["data"] and now - _RATES["at"] < 6 * 3600:
        return _RATES["data"]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://api.frankfurter.dev/v1/latest", params={"base": "USD", "symbols": "ILS,GBP,EUR"})
            r.raise_for_status()
            j = r.json()
        data = {"base": "USD", "rates": {"USD": 1.0, **j["rates"]}, "date": j.get("date"), "source": "ECB via frankfurter.dev"}
        _RATES.update(at=now, data=data)
    except Exception:
        data = {"base": "USD", "rates": FALLBACK_RATES, "date": None, "source": "approximate fallback"}
        _RATES.update(at=now - 6 * 3600 + 600, data=data)
    return data


@app.get("/api/countries")
async def countries() -> list[dict]:
    return sorted(({"name": c, "airports": len(a)} for c, a in airports_by_country().items()), key=lambda x: x["name"])


class ExploreBody(BaseModel):
    origin: str = "TLV"
    country: str = ""
    airports: list[str] = []
    direction: str = "to"                 # "to": origin -> airports, "from": airports -> origin
    date: date
    extra_days: list[int] = [2, 5]        # more dates, tried only for airports that have flights
    adults: int = 1
    currency: str = "ILS"


@app.post("/api/explore", response_model=ExploreResult)
async def explore_airlines(b: ExploreBody) -> ExploreResult:
    """Which airlines fly between the origin and a country's airports (or the given airports)?"""
    trimmed = False
    airports = [a.strip().upper() for a in b.airports if a.strip()]
    if b.country and not airports:
        airports, trimmed = country_airports(b.country)
        if not airports:
            raise HTTPException(422, f"No airports found for country {b.country!r}. Check the spelling, or list airports instead.")
    if not airports:
        raise HTTPException(422, "Give a country or at least one airport.")
    if b.direction not in ("to", "from"):
        raise HTTPException(422, "direction must be 'to' or 'from'")
    try:
        req = SearchRequest(origin=b.origin, destinations=airports[:1], window_start=b.date, window_end=b.date + timedelta(days=1),
                            min_nights=1, max_nights=1, adults=b.adults, currency=b.currency, max_stops_per_leg=2, max_api_calls=400)
        result = await explore(build_engine(), req, req.origin, airports, b.direction, b.date, b.extra_days)
    except ValidationError as e:
        raise HTTPException(422, "; ".join(err["msg"].removeprefix("Value error, ") for err in e.errors()))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    result.trimmed = trimmed
    return result


def _stored_request(sid: str) -> SearchRequest:
    row = history().get(sid)
    if not row:
        raise HTTPException(404, "search not found")
    return SearchRequest(**row["request"])


@app.get("/api/searches/{sid}/flights")
async def search_flights(sid: str, origin: str, dest: str, day: date = Query(alias="date"), show_all: bool = Query(False, alias="all")) -> dict:
    """Every flight on one route and day, priced exactly as this search priced it. Served from the cache the search
    filled, so it is normally instant; a day the search did not cover is fetched live. The search's airline filter
    applies unless all=1; `hidden_by_filter` says how many flights it removed."""
    req = _stored_request(sid)
    try:
        offers = await build_engine().one_way_options(req, origin.upper(), dest.upper(), day)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    kept = offers if show_all else [o for o in offers if FlightSearchEngine._airline_ok(req, o)]
    views = sorted((leg_view(o) for o in kept), key=lambda v: (not v.priced, v.price, v.duration_min))[:60]
    return {"origin": origin.upper(), "dest": dest.upper(), "date": day.isoformat(), "travellers": req.pax_label,
            "currency": req.currency, "bags": req.bags_label, "hidden_by_filter": len(offers) - len(kept),
            "filter": {"include": req.airlines_include, "exclude": req.airlines_exclude}, "flights": [v.model_dump(mode="json") for v in views]}


def _label(o) -> str:
    return "+".join(f"{s.airline_code}{s.flight_number}" for s in o.segments)


@app.get("/api/searches/{sid}/bagfees")
async def bag_fees(sid: str, origin: str, dest: str, day: date = Query(alias="date")) -> dict:
    """Estimated fee for one cabin bag and for one checked bag, per flight, by asking Google for the fare with and
    without the bag. `available` is False when Google returned no difference for any flight (it has no fee data for
    that market: common outside the US and Europe), in which case a zero means unknown, not free."""
    base_req = _stored_request(sid).model_copy(update={"carry_on_bags": 0, "checked_bags": 0})
    engine, o, d = build_engine(), origin.upper(), dest.upper()
    try:
        base = await engine.one_way_options(base_req, o, d, day)
        cabin = await engine.one_way_options(base_req.model_copy(update={"carry_on_bags": 1}), o, d, day)
        hold = await engine.one_way_options(base_req.model_copy(update={"checked_bags": 1}), o, d, day)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    price = lambda offers: {_label(x): x.price for x in offers if x.priced}  # noqa: E731
    b, c, h = price(base), price(cabin), price(hold)
    fees = {}
    for label, p in b.items():
        fees[label] = {"cabin": round(c[label] - p, 2) if label in c else None, "checked": round(h[label] - p, 2) if label in h else None}
    available = any((f["cabin"] or 0) > 0 or (f["checked"] or 0) > 0 for f in fees.values())
    codes = {s.airline_code for x in base for s in x.segments}
    return {"available": available, "fees": fees, "currency": base_req.currency,
            "notes": {code: BAG_NOTES[code] for code in sorted(codes) if code in BAG_NOTES}}


class CheckBody(BaseModel):
    legs: list[LegView]
    currency: str = "USD"


@app.post("/api/itinerary/check", response_model=ItineraryCheck)
async def check_itinerary(body: CheckBody) -> ItineraryCheck:
    """Gaps, airport-transfer estimates and warnings for a hand-built trip."""
    if not body.legs or any(not leg.segments for leg in body.legs):
        raise HTTPException(422, "every leg needs at least one flight segment")
    return analyse(body.legs, body.currency)


class _RevalidatingStatic(StaticFiles):
    """UI files change with every release: make browsers revalidate (cheap 304) instead of heuristically caching."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", _RevalidatingStatic(directory=Path(__file__).parent / "web", html=True), name="web")
