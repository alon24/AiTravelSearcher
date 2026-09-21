from __future__ import annotations

import asyncio
import os
import uuid
from datetime import date
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .cache import OfferCache
from .engine import BudgetExceeded, FlightSearchEngine
from .history import History
from .links import AIRLINE_SITES
from .models import SearchRequest, SearchResult
from .providers import get_provider
from .report import render

load_dotenv()
app = FastAPI(title="Flight Agent")


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
        currency=s.currency.strip().upper() or "USD", **kw,
    )


@app.post("/search/simple")
async def search_simple(s: SimpleSearch) -> dict[str, str]:
    """Never raises for bad input or budget errors: returns {"error": ...} so an LLM can react."""
    try:
        req = to_request(s)
        result = await build_engine().search(req)
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
        hist.finish(sid, result.model_dump_json(), best)
    except Exception as e:  # recorded for the UI instead of vanishing in a background task
        hist.fail(sid, str(e) or type(e).__name__)


@app.get("/api/config")
async def config() -> dict:
    return {"provider": os.getenv("FLIGHTAGENT_PROVIDER", "mock"), "airline_sites": AIRLINE_SITES}


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
app.mount("/", StaticFiles(directory=Path(__file__).parent / "web", html=True), name="web")
