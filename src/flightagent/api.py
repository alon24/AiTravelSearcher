from __future__ import annotations

import os
from datetime import date

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .cache import OfferCache
from .engine import BudgetExceeded, FlightSearchEngine
from .models import SearchRequest, SearchResult
from .providers import get_provider
from .report import render

load_dotenv()
app = FastAPI(title="Flight Agent")


def build_engine() -> FlightSearchEngine:
    cache = OfferCache(
        os.getenv("FLIGHTAGENT_CACHE_DB", ".cache/offers.sqlite"),
        float(os.getenv("FLIGHTAGENT_CACHE_TTL_HOURS", "6")),
    )
    return FlightSearchEngine(get_provider(), cache)


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
