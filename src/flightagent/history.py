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

    def finish(self, sid: str, result_json: str, best_price: float | None) -> None:
        self.db.execute(
            "UPDATE searches SET status='done', result=?, best_price=? WHERE id=?", (result_json, best_price, sid)
        )
        self.db.commit()

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
        }
        if with_result:
            d["result"] = json.loads(r[4]) if r[4] else None
        return d

    _COLS = "id, created, status, request, result, error, done, total, best_price, currency"

    def get(self, sid: str) -> dict | None:
        r = self.db.execute(f"SELECT {self._COLS} FROM searches WHERE id=?", (sid,)).fetchone()
        return self._row(r, True) if r else None

    def list(self, limit: int = 50) -> list[dict]:
        rows = self.db.execute(
            f"SELECT {self._COLS} FROM searches ORDER BY created DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._row(r, False) for r in rows]
