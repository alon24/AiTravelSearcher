"""Optional Laya classifier: when the Google Flights scrape doesn't parse, explain *why*
(consent wall, CAPTCHA, rate limit, layout change, ...) instead of one generic message.

Diagnostic only -- never load-bearing. `classify_page` returns None (and the caller falls
back to the original generic message) whenever Laya is disabled, unreachable, or fails for
any reason.

Laya (https://huggingface.co/convaiinnovations/laya) is a fast BERT-style typed-question
classifier, not an LLM -- and its runtime (torch + transformers, ~1GB even CPU-only) is
deliberately kept OUT of this project. It runs as a small shared local service
(~/laya-service, see docs/DESIGN.md) that any project on the machine can call, so the heavy
dependency is installed once, not once per project. This module is just an HTTP client.

Enable with FLIGHTAGENT_LAYA=1 after starting that service (`~/laya-service/start.sh`).
Default URL is http://127.0.0.1:8799, override with FLIGHTAGENT_LAYA_URL.
"""
from __future__ import annotations

import os

# One "choice" question: what kind of page did we actually get back?
_QUESTIONS = {
    "page_type": {
        "type": "choice",
        "instructions": (
            "This text is what a scraper fetched instead of the Google Flights results it "
            "expected. Classify what kind of page it actually is."
        ),
        "criteria": {
            "results": "Flight search results: flight times, prices, airline names, 'nonstop'/'stops'.",
            "consent": "A cookie/privacy consent wall asking to accept or manage cookies before continuing.",
            "captcha": "A CAPTCHA, 'are you a robot', or other bot-verification challenge.",
            "blocked": "An error, rate-limit, quota, or 'unusual traffic' blocking message.",
            "other": "Something else that doesn't match the above.",
        },
    },
}

# Shown to a person/log; keyed by Laya's choice, plus None for "couldn't classify".
REASONS = {
    "results": "page looks like results but the data script was missing -- likely a layout change",
    "consent": "consent page",
    "captcha": "CAPTCHA / bot check",
    "blocked": "blocked or rate-limited",
    "other": "unrecognized page",
    None: "consent page, block or layout change",  # Laya disabled/unreachable: original generic message
}


def classify_page(text: str) -> str | None:
    """Best-effort page classification: 'results' | 'consent' | 'captcha' | 'blocked' | 'other',
    or None if Laya is disabled/unreachable/erroring. Truncates to roughly fit the model's
    context window (512 tokens for the English backbone)."""
    if os.environ.get("FLIGHTAGENT_LAYA", "0") != "1":
        return None
    if os.environ.get("FLIGHTAGENT_DECIDER", "laya").strip().lower() == "jev":   # hosted Jev instead of the local service
        try:
            from ..decide import decide_jev
            return decide_jev(text[:4000], _QUESTIONS)["answers"]["page_type"]["choice"]
        except Exception:
            return None
    url = os.environ.get("FLIGHTAGENT_LAYA_URL", "http://127.0.0.1:8799") + "/classify"
    try:
        import httpx

        resp = httpx.post(url, json={"state": text[:4000], "questions": _QUESTIONS}, timeout=10.0,
                          headers={"X-Laya-Caller": "flightagent"})  # shown on the service dashboard
        resp.raise_for_status()
        return resp.json()["answers"]["page_type"]["choice"]
    except Exception:
        return None


def diagnose(text: str) -> str:
    """Human-readable reason a parse failed, for the RuntimeError message and logs."""
    return REASONS[classify_page(text)]
