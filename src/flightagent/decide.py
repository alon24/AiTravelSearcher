"""Typed-decision backends: the small local Laya service, or Jev (TypeSafe's hosted System One model, via OpenRouter).

Both take the same request -- a `state` plus typed `questions` (choice / noul / score) -- and return typed answers with
probabilities, so callers (the browser extension's drivers, `laya_classify.py`) don't care which one answered.

- laya: ~/laya-service on 127.0.0.1:8799 (local, free, needs the service running). The extension calls it directly.
- jev:  POST https://openrouter.ai/api/alpha/decisions with your OpenRouter key. The key stays HERE, server-side (the
        Jev docs say never to ship it in browser code), so the extension calls this server's /api/decide instead.

Choose with FLIGHTAGENT_DECIDER=laya|jev (default laya; used by the Python-side diagnostics). The extension has its own
switch in the Skyhop page header. Key: OPENROUTER_API_KEY, or OPENROUTER_KEY. Model: FLIGHTAGENT_JEV_MODEL
(default typesafe/jev-1.13; ~typesafe/jev-latest tracks the newest release but may change behaviour under you).
Jev bills input tokens only (output is free); the response's usage.cost is returned and summed in `spent_usd()`.
"""
from __future__ import annotations

import os
import threading
from typing import Any

import httpx

JEV_URL = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_JEV_MODEL = "typesafe/jev-1.13"
MAX_STATE_CHARS = 12_000       # Jev's window is 32k tokens; this proxy also bounds what a caller can spend
MAX_QUESTIONS = 8

_lock = threading.Lock()
_spent = 0.0
_calls = 0


def jev_key() -> str | None:
    return os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_KEY") or None


def jev_configured() -> bool:
    return jev_key() is not None


def spent_usd() -> dict[str, float | int]:
    """Cost of Jev calls since this process started."""
    with _lock:
        return {"calls": _calls, "usd": round(_spent, 6)}


def configured_decider() -> str:
    return "jev" if os.environ.get("FLIGHTAGENT_DECIDER", "laya").strip().lower() == "jev" else "laya"


def to_jev_request(state: Any, questions: dict) -> dict:
    """Laya-style request -> Jev's. Jev takes a state object (a bare string is wrapped) and, for noul questions,
    true/false criteria (Laya has defaults for those; spell the same defaults out)."""
    if len(questions) > MAX_QUESTIONS:
        raise ValueError(f"at most {MAX_QUESTIONS} questions per call")
    text = state if isinstance(state, str) else repr(state)
    if len(text) > MAX_STATE_CHARS:
        raise ValueError(f"state is longer than {MAX_STATE_CHARS} characters")
    qs: dict[str, dict] = {}
    for qid, q in questions.items():
        q = dict(q)
        if q.get("type") == "noul" and not q.get("criteria"):
            q["criteria"] = {"true": "Yes, the statement holds.", "false": "No, the statement does not hold."}
        qs[qid] = q
    return {"model": os.environ.get("FLIGHTAGENT_JEV_MODEL", DEFAULT_JEV_MODEL),
            "state": {"text": state} if isinstance(state, str) else state, "questions": qs}


def decide_jev(state: Any, questions: dict, *, timeout: float = 20.0) -> dict:
    """Ask Jev. Returns {"answers": {...}, "cost": usd}. Raises on any failure (callers decide how to degrade)."""
    global _spent, _calls
    key = jev_key()
    if not key:
        raise RuntimeError("no OpenRouter key: set OPENROUTER_API_KEY (or OPENROUTER_KEY) in .env and restart")
    body = to_jev_request(state, questions)
    resp = httpx.post(JEV_URL, json=body, timeout=timeout, headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "X-Title": "Skyhop flightagent",   # OpenRouter app attribution
    })
    if resp.status_code != 200:
        # never echo the request (it carries the key in a header, not the body, but keep errors terse anyway)
        raise RuntimeError(f"Jev/OpenRouter HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    cost = float((data.get("usage") or {}).get("cost") or 0.0)
    with _lock:
        _spent += cost
        _calls += 1
    return {"answers": data["answers"], "cost": cost, "model": data.get("model")}
