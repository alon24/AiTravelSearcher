from __future__ import annotations

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from .cache import OfferCache
from .engine import BudgetExceeded, FlightSearchEngine, leg_view
from .explore import ExploreResult, explore
from .geo import airports_by_country, country_airports
from .history import History
from .itinerary import ItineraryCheck, analyse
from .links import AIRLINE_SITES, KNOWN_AIRLINES
from .models import LegView, SearchRequest, SearchResult
from .polling import next_check_time
from .providers import get_provider
from .report import render

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
def _shared(provider: str, cache_db: str, ttl: str):
    """One provider + cache for the process, so rate limits and the cache are global."""
    return get_provider(provider), OfferCache(cache_db, float(ttl))


def build_engine() -> FlightSearchEngine:
    provider, cache = _shared(
        os.getenv("FLIGHTAGENT_PROVIDER", "mock"),
        os.getenv("FLIGHTAGENT_CACHE_DB", ".cache/offers.sqlite"),
        os.getenv("FLIGHTAGENT_CACHE_TTL_HOURS", "6"),
    )
    return FlightSearchEngine(provider, cache)


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


class SimpleSearch(BaseModel):
    """Flat, all-string form of SearchRequest for LLM tool calls (n8n). Blank means default."""

    origin: str = "TLV"
    destinations: str
    from_date: str
    to_date: str
    nights: str  # "5" or "4-7"
    return_airports: str = ""
    direct_only: str = ""
    max_stops: str = ""
    max_travel_hours: str = ""
    same_airline: str = ""
    self_transfer_hubs: str = ""
    connect_destinations: str = ""
    currency: str = ""
    top: str = ""
    adults: str = ""
    children_ages: str = ""  # comma-separated ages, e.g. "5,8"
    exclude_airlines: str = ""  # comma-separated IATA codes, e.g. "FR,W4"
    only_airlines: str = ""


def _csv(s: str) -> list[str]:
    return [x.strip().upper() for x in s.split(",") if x.strip()]


def _flag(s: str) -> bool:
    return s.strip().lower() in ("1", "true", "yes", "y")


def to_request(s: SimpleSearch) -> SearchRequest:
    lo, _, hi = s.nights.strip().partition("-")
    hubs = _csv(s.self_transfer_hubs)
    kw: dict = {}
    if s.max_stops.strip():
        kw["max_stops_per_leg"] = int(s.max_stops)
    if s.max_travel_hours.strip():
        kw["max_travel_min_per_direction"] = int(float(s.max_travel_hours) * 60)
    if s.top.strip():
        kw["top_n"] = int(s.top)
    return SearchRequest(
        origin=s.origin.strip() or "TLV", destinations=_csv(s.destinations),
        return_airports=_csv(s.return_airports),
        window_start=date.fromisoformat(s.from_date.strip()),
        window_end=date.fromisoformat(s.to_date.strip()),
        min_nights=int(lo), max_nights=int(hi or lo),
        allow_connections=not _flag(s.direct_only), allow_mixed_airlines=not _flag(s.same_airline),
        allow_self_transfer=bool(hubs), self_transfer_hubs=hubs,
        connect_destinations=_flag(s.connect_destinations),
        adults=int(s.adults) if s.adults.strip() else 1,
        children_ages=[int(x) for x in s.children_ages.replace(",", " ").split()],
        airlines_exclude=_csv(s.exclude_airlines), airlines_include=_csv(s.only_airlines),
        currency=s.currency.strip().upper() or "USD", **kw,
    )


@app.post("/search/simple")
async def search_simple(s: SimpleSearch) -> dict[str, str]:
    """Never raises for bad input or budget errors: returns {"error": ...} so an LLM can react."""
    try:
        req = to_request(s)
        result = await build_engine().search(req)
    except ValidationError as e:
        return {"error": "; ".join(err["msg"].removeprefix("Value error, ") for err in e.errors())}
    except (ValueError, BudgetExceeded, RuntimeError) as e:
        return {"error": str(e)}
    text = render(result)
    if os.getenv("FLIGHTAGENT_PROVIDER", "mock").lower() == "mock":
        text = "*** DEMO DATA (mock provider) - prices are fake ***\n\n" + text
    return {"report": text}


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
    return {"provider": os.getenv("FLIGHTAGENT_PROVIDER", "mock"), "airline_sites": AIRLINE_SITES, "airlines": KNOWN_AIRLINES}


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


@app.post("/api/searches/{sid}/recheck")
async def recheck_search(sid: str) -> dict:
    """Ask again about flights that had no price. Returns how many were unpriced before and after."""
    try:
        changed = await _recheck(sid)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"changed": changed, "search": history().get(sid)}


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
