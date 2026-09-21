from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from .models import Offer


class OfferCache:
    """SQLite cache of one-way search results, so re-runs and overlapping windows are free."""

    def __init__(self, path: str | Path = ".cache/offers.sqlite", ttl_hours: float = 6.0):
        self.ttl = ttl_hours * 3600
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS offers (key TEXT PRIMARY KEY, ts REAL, payload TEXT)"
        )

    def get(self, key: str) -> list[Offer] | None:
        row = self.db.execute("SELECT ts, payload FROM offers WHERE key=?", (key,)).fetchone()
        if not row or time.time() - row[0] > self.ttl:
            return None
        return [Offer.model_validate(o) for o in json.loads(row[1])]

    def has(self, key: str) -> bool:
        row = self.db.execute("SELECT ts FROM offers WHERE key=?", (key,)).fetchone()
        return bool(row) and time.time() - row[0] <= self.ttl

    def put(self, key: str, offers: list[Offer]) -> None:
        payload = json.dumps([o.model_dump(mode="json") for o in offers])
        self.db.execute(
            "INSERT OR REPLACE INTO offers VALUES (?, ?, ?)", (key, time.time(), payload)
        )
        self.db.commit()
