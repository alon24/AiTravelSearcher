from __future__ import annotations

import os

from .base import FlightProvider
from .mock import MockProvider
from .serpapi import SerpApiProvider


def get_provider(name: str | None = None) -> FlightProvider:
    name = (name or os.getenv("FLIGHTAGENT_PROVIDER", "mock")).lower()
    if name == "mock":
        return MockProvider()
    if name == "serpapi":
        key = os.getenv("SERPAPI_API_KEY")
        if not key:
            raise RuntimeError("SERPAPI_API_KEY is not set")
        return SerpApiProvider(key)
    raise ValueError(f"unknown provider {name!r} (expected 'mock' or 'serpapi')")


__all__ = ["FlightProvider", "MockProvider", "SerpApiProvider", "get_provider"]
