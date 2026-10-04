"""The flat, all-string search shape and the engine that serves it -- used by the HTTP API (`/search/simple`) and by
the built-in chat (`chat.py`). Split out from `api.py` so `chat.py` can call it without importing the whole FastAPI
app (avoiding a circular import: `api.py` mounts chat.py's router)."""
from __future__ import annotations

import os
from datetime import date
from functools import lru_cache

from pydantic import BaseModel, ValidationError

from .cache import OfferCache
from .engine import BudgetExceeded, FlightSearchEngine
from .models import SearchRequest
from .providers import get_provider
from .report import render


@lru_cache
def _provider(name: str):
    return get_provider(name)


@lru_cache
def _cache(cache_db: str, ttl: str) -> OfferCache:
    return OfferCache(cache_db, float(ttl))


def _shared_cache() -> OfferCache:
    """One provider + cache for the process, so rate limits and the cache are global."""
    return _cache(os.getenv("FLIGHTAGENT_CACHE_DB", ".cache/offers.sqlite"), os.getenv("FLIGHTAGENT_CACHE_TTL_HOURS", "6"))


def build_engine() -> FlightSearchEngine:
    return FlightSearchEngine(_provider(os.getenv("FLIGHTAGENT_PROVIDER", "mock")), _shared_cache())


def verifier_name() -> str | None:
    """FLIGHTAGENT_VERIFIER: the independent provider that re-checks prices (docs/DESIGN.md section 8). Unset = off."""
    name = os.getenv("FLIGHTAGENT_VERIFIER", "").strip().lower()
    if not name:
        return None
    if "," in name:
        raise RuntimeError("FLIGHTAGENT_VERIFIER takes one provider name, not a fallback list")
    primary = os.getenv("FLIGHTAGENT_PROVIDER", "mock").split(",")[0].strip().lower()
    if name == primary:
        raise RuntimeError(f"FLIGHTAGENT_VERIFIER={name} is the search provider itself; a verifier must be independent")
    return name


def build_verifier() -> FlightSearchEngine | None:
    """An engine on the verifier provider, sharing the offer cache (cache keys carry the provider name)."""
    name = verifier_name()
    return FlightSearchEngine(_provider(name), _shared_cache()) if name else None


class SimpleSearch(BaseModel):
    """Flat, all-string form of SearchRequest for LLM tool calls (the built-in chat, chat.py). Blank means default."""

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


async def run_simple_search(s: SimpleSearch) -> dict[str, str]:
    """Never raises for bad input or budget errors: returns {"error": ...} so an LLM (or a human) can react."""
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
