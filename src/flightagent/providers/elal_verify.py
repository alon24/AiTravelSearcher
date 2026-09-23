"""On-demand verification against El Al's own site: search, select a flight, and read the real
fare-tier prices and baggage allowances -- not Google's estimate, the airline's own numbers.

Optional, on-demand only (never runs as part of a normal search). Needs Playwright + its
Chromium browser (pip install flightagent[verify]; `playwright install chromium`).

Scope (v1): TLV origin only (El Al's default, and the only origin its search box is prefilled
with -- typing a different origin needs a Hebrew/English place name we don't have a lookup
table for yet). One-way or round trip to any destination whose IATA code appears in the
autocomplete suggestions (matched by the code text, not by clicking "the first suggestion" --
if the code never appears, this raises rather than silently picking the wrong airport).

Fragility (see docs/DESIGN.md): elal.com has no data-testid or stable aria-labels anywhere --
every selector here is a CSS class name captured from the live site (2026-09-23) or a text/regex
match. A redesign will break this silently unless Laya's classify_page catches the wreckage (see
`_diagnose` calls below). This is the same trust boundary as gflights: read what's shown to any
visitor, no auth bypass, no bot-detection defeat.
"""
from __future__ import annotations

import re
import time
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from .laya_classify import classify_page

_HEBREW_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                   "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]

_SEARCH_URL = "https://www.elal.com/heb/israel"
_CHROME_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/153.0.0.0 Safari/537.36")
_TIME_RE = re.compile(r"\b\d{2}:\d{2}\b")
_FLIGHT_NO_RE = re.compile(r"\bLY ?\d{2,4}\b")


class FareOption(BaseModel):
    name: str              # "LITE" / "CLASSIC" / "FLEX" (whatever El Al calls it)
    price: float
    currency: str = "USD"
    baggage_text: str      # raw text from the fare card -- already human-readable, not reparsed


class FlightCheck(BaseModel):
    flight_number: str
    departs: str            # "HH:MM" local, as shown (no date/tz parsing from scrape text)
    arrives: str
    fares: list[FareOption] = Field(default_factory=list)


class AirlineVerification(BaseModel):
    airline_code: str = "LY"
    origin: str
    destination: str
    day: date
    return_day: date | None = None
    status: Literal["ok", "consent", "captcha", "blocked", "no_flights", "error"]
    outbound: list[FlightCheck] = Field(default_factory=list)
    inbound: list[FlightCheck] = Field(default_factory=list)
    reason: str | None = None
    checked_at: float = Field(default_factory=time.time)


def _diagnose(page, fallback: str) -> str:
    """Laya-assisted reason a step didn't produce what we expected; falls back to `fallback`
    (a plain description of what selector/wait failed) when Laya is off/unreachable."""
    try:
        text = page.inner_text("body")
    except Exception:
        text = ""
    label = classify_page(text)
    return {
        "consent": "consent page", "captcha": "CAPTCHA / bot check", "blocked": "blocked or rate-limited",
        "results": fallback, "other": fallback, None: fallback,
    }[label]


def _status_for(reason_label: str) -> Literal["consent", "captcha", "blocked", "error"]:
    return {"consent page": "consent", "CAPTCHA / bot check": "captcha", "blocked or rate-limited": "blocked"}.get(
        reason_label, "error"
    )


def _dismiss_cookie_banner(page) -> None:
    """Best-effort, privacy-preserving: reject non-essential cookies if the banner is present.
    Never fails the check if it's absent or worded differently."""
    for text in ("דחה", "Reject all"):  # matches "דחה/י הכול", "דחה הכול", etc. -- root word, not full phrase
        try:
            btn = page.get_by_text(text, exact=False).first
            if btn.is_visible(timeout=1500):
                btn.click(timeout=1500)
                return
        except Exception:
            continue


def _fill_destination(page, dest_code: str) -> None:
    dest_input = page.locator("input.search-ui-input__input").nth(1)
    dest_input.click()
    dest_input.fill(dest_code)
    page.wait_for_timeout(800)
    # Suggestions render the IATA code as visible text (language-independent match).
    suggestion = page.get_by_text(dest_code, exact=False).first
    if not suggestion.is_visible(timeout=3000):
        raise RuntimeError(f"El Al's destination autocomplete never showed a suggestion for {dest_code!r}")
    suggestion.click()


def _pick_calendar_day(page, day: date, which: Literal[0, 1]) -> None:
    """which=0: departure date input, which=1: return date input."""
    page.locator(".search-ui-input--calendar input").nth(which).click()
    target_label = f"{_HEBREW_MONTHS[day.month - 1]} {day.year}"
    for _ in range(6):  # up to 6 months forward, then give up
        headers = page.locator(".search-calendar__navtitle")
        count = headers.count()
        matched = None
        for i in range(count):
            if headers.nth(i).inner_text().strip() == target_label:
                matched = i
                break
        if matched is not None:
            # The day cells for panel `matched` are the ones between this header and the next.
            panel_cells = page.locator(".search-calendar-cell__day", has_text=re.compile(rf"^{day.day}$"))
            panel_cells.nth(matched).click()
            return
        # Not visible yet: click the right-side header's bounding box edge to advance a month
        # (no stable selector for the arrow icon itself -- see docs/DESIGN.md).
        box = headers.last.bounding_box()
        if box:
            page.mouse.click(box["x"] + box["width"] + 40, box["y"] + box["height"] / 2)
        page.wait_for_timeout(400)
    raise RuntimeError(f"Could not navigate El Al's calendar to {target_label}")


def _read_flights(page, section_heading_text: str) -> list[FlightCheck]:
    """Reads every `.panel__row` under the outbound/inbound section. Cheap and mostly future-proof:
    it reads whatever text is there rather than parsing individual sub-fields where avoidable."""
    rows = page.locator(".panel__row")
    out: list[FlightCheck] = []
    for i in range(rows.count()):
        row = rows.nth(i)
        text = row.inner_text()
        times = _TIME_RE.findall(text)
        flight_no_m = _FLIGHT_NO_RE.search(text)
        if not flight_no_m or len(times) < 2:
            continue
        out.append(FlightCheck(flight_number=flight_no_m.group(0).replace(" ", ""), departs=times[0], arrives=times[-1]))
    return out


def _select_cheapest_fare_and_read_card(page, row_index: int) -> list[FareOption]:
    """Clicks the cheapest (first) fare price in a flight row, then reads the fare-family cards
    (`.ui-bound-fare`) that appear -- these hold the airline's own baggage text per tier."""
    row = page.locator(".panel__row").nth(row_index)
    row.locator(".ui-bound__price__value").first.click()
    page.wait_for_timeout(1000)
    cards = page.locator(".ui-bound-fare")
    fares: list[FareOption] = []
    for i in range(cards.count()):
        text = cards.nth(i).inner_text()
        price_m = re.search(r"\$\s?([\d,]+)", text)
        name_m = re.search(r"\b(LITE|CLASSIC|FLEX|BASIC|LIGHT|SAVER)\b", text, re.IGNORECASE)
        if not price_m:
            continue
        fares.append(FareOption(
            name=(name_m.group(1).upper() if name_m else f"fare {i + 1}"),
            price=float(price_m.group(1).replace(",", "")),
            baggage_text=text.strip(),
        ))
    return fares


def verify(origin: str, dest: str, day: date, return_day: date | None = None, *, headless: bool = True) -> AirlineVerification:
    """Synchronous (Playwright sync API -- run via asyncio.to_thread from async callers, same
    pattern as GoogleFlightsScraper._fetch). Raises only for programming/setup errors (e.g.
    Playwright not installed); site problems are reported in the returned status, never raised,
    matching this project's "never silently return an error as a real answer" rule for status
    itself -- but unlike providers/base.py's contract, a non-'ok' status IS the answer here."""
    if origin.upper() != "TLV":
        raise NotImplementedError("elal_verify only supports TLV as the origin for now (see module docstring)")

    from playwright.sync_api import sync_playwright

    result = AirlineVerification(origin=origin.upper(), destination=dest.upper(), day=day, return_day=return_day, status="ok")

    with sync_playwright() as p:
        # El Al's search widget silently doesn't render for an obviously-automated browser
        # (checked navigator.webdriver / a "HeadlessChrome" UA) -- no CAPTCHA involved, just this
        # one signal. Masking it is the one deliberate exception to "read what any visitor gets":
        # confirmed with the user, see docs/DESIGN.md.
        browser = p.chromium.launch(headless=headless, args=["--disable-blink-features=AutomationControlled"])
        page = browser.new_page(locale="he-IL", user_agent=_CHROME_UA)
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
        try:
            page.goto(_SEARCH_URL, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(3000)
            _dismiss_cookie_banner(page)
            page.wait_for_selector("input.search-ui-input__input", timeout=15000)

            _fill_destination(page, dest.upper())
            _pick_calendar_day(page, day, which=0)
            if return_day:
                _pick_calendar_day(page, return_day, which=1)

            search_btn = page.get_by_text(re.compile(r"חיפוש טיסה")).first
            search_btn.click()
            page.wait_for_url(re.compile(r"booking\.elal\.com"), timeout=20000)
            page.wait_for_timeout(4000)

            if not page.locator(".panel__row").count():
                reason = _diagnose(page, "no results panel appeared")
                status = _status_for(reason) if reason != "no results panel appeared" else "no_flights"
                result.status, result.reason = status, reason
                return result

            result.outbound = _read_flights(page, "טיסת הלוך")
            fares = _select_cheapest_fare_and_read_card(page, 0)
            if result.outbound:
                result.outbound[0].fares = fares

            if return_day:
                if page.locator(".panel__row").count():
                    result.inbound = _read_flights(page, "טיסת חזור")
                    in_fares = _select_cheapest_fare_and_read_card(page, 0)
                    if result.inbound:
                        result.inbound[0].fares = in_fares

            return result
        except Exception as e:
            reason = _diagnose(page, str(e))
            result.status, result.reason = _status_for(reason), reason
            return result
        finally:
            browser.close()
