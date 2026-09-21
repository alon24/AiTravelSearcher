from __future__ import annotations

import os

from .base import FlightProvider, FallbackProvider
from .gflights import GoogleFlightsScraper
from .mock import MockProvider
from .serpapi import SerpApiProvider


def _one(name: str) -> FlightProvider:
    if name == "mock":
        return MockProvider()
    if name == "gflights":
        return GoogleFlightsScraper()
    if name == "serpapi":
        key = os.getenv("SERPAPI_API_KEY")
        if not key:
            raise RuntimeError("SERPAPI_API_KEY is not set")
        return SerpApiProvider(key)
    raise ValueError(f"unknown provider {name!r} (expected mock, gflights or serpapi)")


def get_provider(name: str | None = None) -> FlightProvider:
    """A comma list means fallback order, e.g. "gflights,serpapi": scrape free, use credits if blocked."""
    names = [n.strip().lower() for n in (name or os.getenv("FLIGHTAGENT_PROVIDER", "mock")).split(",")]
    providers = [_one(n) for n in names if n]
    result = providers[0]
    for backup in providers[1:]:
        result = FallbackProvider(result, backup)
    return result


__all__ = ["FlightProvider", "GoogleFlightsScraper", "MockProvider", "SerpApiProvider", "get_provider"]
