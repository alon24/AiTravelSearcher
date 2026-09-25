"""On-demand Wizz Air check from the server side (Playwright), with page elements located on the fly
instead of by hard-coded selectors -- the server-side twin of browser-extension/drivers/results.js,
kept so the two approaches can be compared (see docs/DESIGN.md, "Wizz Air").

Nothing here is a Wizz Air selector. Wizz's results are a plain URL (no form to drive); on the page:
  - flight cards are found by shape (a block holding two clock times, a price and a button);
  - Laya (laya_classify) says what kind of page came back when there are no cards;
  - times/prices are read with regexes (Laya can't read numbers).

Honest expectation, measured 2026-09-25: an unmodified headless Chromium gets HTTP 405 and a
"Human Verification" page, so `status` is "captcha". This module deliberately does NOT mask
navigator.webdriver, spoof a fingerprint or try to pass the check -- unlike elal_verify.py's one
confirmed exception, nothing was agreed for Wizz Air, so a bot check is reported as the answer. The
browser extension (a real, human-driven tab) is the route that works. Needs `pip install
flightagent[verify]` + `playwright install chromium`; Laya is optional (FLIGHTAGENT_LAYA=1).
"""
from __future__ import annotations

import re
from datetime import date

from .elal_verify import AirlineVerification, FareOption, FlightCheck
from .laya_classify import classify_page

# Smallest block around each button that holds >= 2 clock times and a price = one flight card.
# Fares are the buttons in it, each paired with the last price text seen before it (page order).
_CARDS_JS = r"""() => {
  const TIME = /\b([01]\d|2[0-3]):[0-5]\d\b/g, PRICE = /[€£$₪]\s?(\d[\d,]*(?:\.\d+)?)/;
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const cards = [];
  for (const b of document.querySelectorAll("button")) {
    if (!vis(b)) continue;
    let el = b.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      const t = el.innerText || "";
      if ((t.match(TIME) || []).length >= 2 && PRICE.test(t)) { if (!cards.includes(el)) cards.push(el); break; }
    }
  }
  return cards.filter((c) => !cards.some((o) => o !== c && c.contains(o))).map((card) => {
    const times = card.innerText.match(TIME), fares = [];
    let last = null;
    const w = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
    for (let n = w.currentNode; n; n = w.nextNode()) {
      if (n.children.length === 0 && n.tagName !== "BUTTON") { const m = PRICE.exec(n.textContent); if (m) last = parseFloat(m[1].replace(/,/g, "")); }
      if (n.tagName === "BUTTON" && vis(n) && last !== null) fares.push(last);
    }
    return { dep: times[0], arr: times[times.length - 1], fares };
  });
}"""

_URL = "https://www.wizzair.com/en-gb/booking/select-flight/{o}/{d}/{day}/null/1/0/0/null"
_CURRENCY = {"€": "EUR", "£": "GBP", "$": "USD", "₪": "ILS"}
_STATUS = {"consent": "consent", "captcha": "captcha", "blocked": "blocked"}


def verify(dest: str, day: date, origin: str = "TLV", *, headless: bool = True) -> AirlineVerification:
    """One-way, one adult. Site problems (bot check, consent wall, no flights) come back as `status`,
    never raised; only setup errors (Playwright missing) raise."""
    from playwright.sync_api import sync_playwright

    result = AirlineVerification(airline_code="W6", origin=origin.upper(), destination=dest.upper(), day=day, status="ok")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)   # unmodified: no fingerprint masking, see module docstring
        page = browser.new_page(viewport={"width": 1366, "height": 900})
        try:
            resp = page.goto(_URL.format(o=origin.upper(), d=dest.upper(), day=day.isoformat()), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(8000)
            cards = page.evaluate(_CARDS_JS)
            if not cards:
                text = page.inner_text("body")
                label = classify_page(text)   # None when Laya is off/unreachable
                http = f"HTTP {resp.status}" if resp else "no response"
                if label in _STATUS:
                    result.status, result.reason = _STATUS[label], f"Laya: {label} ({http})"
                elif page.title().lower().startswith("human verification") or "not a bot" in text.lower():
                    result.status, result.reason = "captcha", f"human-verification page ({http}); Laya off, matched the page title"
                else:
                    result.status, result.reason = "no_flights", f"no flight cards found ({http}, page type: {label or 'unclassified'})"
                return result
            sym = re.search(r"[€£$₪]", page.inner_text("body"))
            currency = _CURRENCY[sym.group(0)] if sym else "EUR"   # the page shows one currency for the whole list
            for c in cards:
                result.outbound.append(FlightCheck(
                    flight_number="", departs=c["dep"], arrives=c["arr"],
                    fares=[FareOption(name=f"fare {i + 1}", price=f, currency=currency, baggage_text="") for i, f in enumerate(c["fares"])],
                ))
            return result
        except Exception as e:
            result.status, result.reason = "error", str(e)[:300]
            return result
        finally:
            browser.close()
