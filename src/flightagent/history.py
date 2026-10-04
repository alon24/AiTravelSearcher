from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from .models import SearchRequest


class History:
    """Server-side memory of past searches: request, live progress and the full result."""

    def __init__(self, path: str | Path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS searches (
                id TEXT PRIMARY KEY, created REAL, status TEXT, request TEXT, result TEXT,
                error TEXT, done INT DEFAULT 0, total INT DEFAULT 0, best_price REAL, currency TEXT)"""
        )
        for col in ("next_check REAL", "rechecks INT DEFAULT 0", "updated REAL", "verifications TEXT"):     # added after the first release
            try:
                self.db.execute(f"ALTER TABLE searches ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass
        self.db.execute("UPDATE searches SET status='failed', error='Interrupted by a restart' WHERE status='running'")
        self.db.commit()

    def create(self, sid: str, req: SearchRequest) -> None:
        self.db.execute(
            "INSERT INTO searches (id, created, status, request, currency) VALUES (?,?,?,?,?)",
            (sid, time.time(), "running", req.model_dump_json(), req.currency),
        )
        self.db.commit()

    def progress(self, sid: str, done: int, total: int) -> None:
        self.db.execute("UPDATE searches SET done=?, total=? WHERE id=?", (done, total, sid))
        self.db.commit()

    def finish(self, sid: str, result_json: str, best_price: float | None, next_check: float | None = None) -> None:
        self.db.execute(
            "UPDATE searches SET status='done', result=?, best_price=?, next_check=?, updated=? WHERE id=?",
            (result_json, best_price, next_check, time.time(), sid),
        )
        self.db.commit()

    def replace_result(self, sid: str, result_json: str, best_price: float | None, next_check: float | None, rechecks: int) -> None:
        """A recheck finished: swap in the fresh result and schedule the next one."""
        self.db.execute(
            "UPDATE searches SET result=?, best_price=?, next_check=?, rechecks=?, updated=? WHERE id=? AND status='done'",
            (result_json, best_price, next_check, rechecks, time.time(), sid),
        )
        self.db.commit()

    def update_search(self, sid: str, request_json: str, result_json: str, best_price: float | None, next_check: float | None) -> None:
        """The airline filter changed in place: keep the same history entry, with the new request and its result."""
        self.db.execute(
            "UPDATE searches SET request=?, result=?, best_price=?, next_check=?, updated=? WHERE id=? AND status='done'",
            (request_json, result_json, best_price, next_check, time.time(), sid),
        )
        self.db.commit()

    def add_verifications(self, sid: str, by_trip: dict[str, dict]) -> None:
        """Merge price-verification results (trip key -> TripVerification) into the row. They survive rechecks and
        filter changes because they are keyed by the trip's flights, not by its position in the result."""
        row = self.db.execute("SELECT verifications FROM searches WHERE id=?", (sid,)).fetchone()
        merged = {**(json.loads(row[0]) if row and row[0] else {}), **by_trip}
        self.db.execute("UPDATE searches SET verifications=? WHERE id=?", (json.dumps(merged), sid))
        self.db.commit()

    def postpone(self, sid: str, next_check: float) -> None:
        self.db.execute("UPDATE searches SET next_check=? WHERE id=?", (next_check, sid))
        self.db.commit()

    def due(self, now: float) -> list[str]:
        rows = self.db.execute("SELECT id FROM searches WHERE status='done' AND next_check IS NOT NULL AND next_check <= ? "
                               "ORDER BY next_check LIMIT 20", (now,)).fetchall()
        return [r[0] for r in rows]

    def fail(self, sid: str, error: str) -> None:
        self.db.execute("UPDATE searches SET status='failed', error=? WHERE id=?", (error, sid))
        self.db.commit()

    def delete(self, sid: str) -> bool:
        n = self.db.execute("DELETE FROM searches WHERE id=?", (sid,)).rowcount
        self.db.commit()
        return n > 0

    @staticmethod
    def _row(r, with_result: bool) -> dict:
        d = {
            "id": r[0], "created": r[1], "status": r[2], "request": json.loads(r[3]), "error": r[5],
            "progress": {"done": r[6], "total": r[7]}, "best_price": r[8], "currency": r[9],
            "next_check": r[10], "rechecks": r[11] or 0, "updated": r[12],
        }
        if with_result:
            d["result"] = json.loads(r[4]) if r[4] else None
            d["verifications"] = json.loads(r[13]) if r[13] else {}
        return d

    _COLS = "id, created, status, request, result, error, done, total, best_price, currency, next_check, rechecks, updated, verifications"

    def get(self, sid: str) -> dict | None:
        r = self.db.execute(f"SELECT {self._COLS} FROM searches WHERE id=?", (sid,)).fetchone()
        return self._row(r, True) if r else None

    def list(self, limit: int = 50) -> list[dict]:
        rows = self.db.execute(
            f"SELECT {self._COLS} FROM searches ORDER BY created DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._row(r, False) for r in rows]
