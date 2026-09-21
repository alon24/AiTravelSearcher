from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from .models import Offer


class OfferCache:
    """SQLite cache of one-way search results. Each entry carries its own expiry (see polling.py), so results with
    unpriced flights or flights close to departure are rechecked sooner than the default ttl."""

    def __init__(self, path: str | Path = ".cache/offers.sqlite", ttl_hours: float = 6.0):
        self.ttl = ttl_hours * 3600
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.execute("CREATE TABLE IF NOT EXISTS offers (key TEXT PRIMARY KEY, ts REAL, payload TEXT, expires REAL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS fares (key TEXT PRIMARY KEY, price REAL, ts REAL)")
        try:
            self.db.execute("ALTER TABLE offers ADD COLUMN expires REAL")     # caches created before per-entry expiry
        except sqlite3.OperationalError:
            pass

    def _fresh(self, ts: float, expires: float | None) -> bool:
        return time.time() <= (expires if expires is not None else ts + self.ttl)

    def has(self, key: str) -> bool:
        row = self.db.execute("SELECT ts, expires FROM offers WHERE key=?", (key,)).fetchone()
        return bool(row) and self._fresh(*row)

    def get(self, key: str) -> list[Offer] | None:
        row = self.db.execute("SELECT ts, payload, expires FROM offers WHERE key=?", (key,)).fetchone()
        if not row or not self._fresh(row[0], row[2]):
            return None
        return [Offer.model_validate(o) for o in json.loads(row[1])]

    def remember_fares(self, fares: dict[str, float]) -> None:
        """Last price seen per flight. Google sometimes drops a fare it showed earlier, so we keep the last one."""
        if fares:
            now = time.time()
            self.db.executemany("INSERT OR REPLACE INTO fares (key, price, ts) VALUES (?, ?, ?)", [(k, p, now) for k, p in fares.items()])
            self.db.commit()

    def recall_fare(self, key: str) -> tuple[float, float] | None:
        row = self.db.execute("SELECT price, ts FROM fares WHERE key=?", (key,)).fetchone()
        return (row[0], row[1]) if row else None

    def put(self, key: str, offers: list[Offer], ttl: float | None = None) -> None:
        payload = json.dumps([o.model_dump(mode="json") for o in offers])
        now = time.time()
        self.db.execute("INSERT OR REPLACE INTO offers (key, ts, payload, expires) VALUES (?, ?, ?, ?)",
                        (key, now, payload, now + (self.ttl if ttl is None else ttl)))
        self.db.commit()
