// Injected into a real, human tab by background.js. Runs in TWO phases because El Al's Search
// button does a full page navigation (www.elal.com -> booking.elal.com), which destroys any
// injected script -- so background.js injects the driver again on the results page:
//   phase "search"  (host www.elal.com):     one-way, destination, date, confirm, search
//   phase "select"  (host booking.elal.com): find the flight row and pick its cheapest fare
// Selectors captured from the live site 2026-09-23/24 (same site as providers/elal_verify.py).
// This never touches passenger or payment fields: it stops at the fare/baggage choice.
(async () => {
  // Details are set by background.js right before each injection (once on the search page, once
  // when the results page has loaded). No details = not started by Skyhop: do nothing.
  const details = window.__skyhopFlightDetails;
  if (!details) return;
  const { destination, day, returnDay, flightNumber } = details;
  const HEBREW_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                          "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The banner is re-created on every update: Angular re-renders can drop it.
  function status(msg, isError) {
    window.__skyhopStatus = msg;
    let banner = document.getElementById("skyhop-status-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "skyhop-status-banner";
      document.documentElement.appendChild(banner);
    }
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;color:#fff;" +
      "font:14px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center;direction:ltr;" +
      "background:" + (isError ? "#a11a2b" : "#1a1a2e") + ";";
    banner.textContent = "Skyhop Assist: " + msg;
    console.log("[Skyhop]", msg);
  }

  async function waitFor(check, timeoutMs = 15000, stepMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = check();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  const visible = (el) => el && el.offsetParent !== null;
  const textOf = (el) => (el.textContent || "").trim();

  function dismissCookieBanner() {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => textOf(b).includes("דחה"));
    if (btn) btn.click();
  }

  // ---------------------------------------------------------------- phase: search
  async function chooseOneWay() {
    // The form defaults to round trip; with only one date picked the search silently never runs.
    const link = Array.from(document.querySelectorAll("a")).find((a) => textOf(a) === "כיוון אחד");
    if (!link) throw new Error("Could not find El Al's one-way option");
    link.click();
    await sleep(700);
  }

  async function fillDestination(code) {
    const input = document.querySelectorAll("input.search-ui-input__input")[1];
    if (!input) throw new Error("Destination field not found");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    // The suggestion flyout opens on a real focus event: if the input already has focus (it can
    // after choosing one-way) .focus() alone does nothing, so blur first. It also needs this tab
    // to actually have focus -- fine for the tab the extension just opened and activated.
    input.blur();
    await sleep(200);
    input.focus();
    input.click();
    await sleep(500);
    input.select();
    setValue.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    // The suggestion list only filters on per-keystroke events; one bulk value change is ignored.
    let typed = "";
    for (const ch of code) {
      typed += ch;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      setValue.call(input, typed);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(150);
    }
    // Typed text alone is NOT committed (the site keeps the previous destination and would silently
    // search the wrong airport): the suggestion entry for exactly this airport code must be clicked.
    const entry = await waitFor(() => Array.from(document.querySelectorAll(".search-input-location__item")).find((i) =>
      visible(i) && textOf(i.querySelector(".search-input-location__code") || i) === code), 5000);
    if (!entry) throw new Error(`El Al offered no airport with code ${code} (if this tab was in the background, bring it to the front and try again)`);
    entry.click();
    await sleep(800);
  }

  function monthPanelCells(label) {
    const title = Array.from(document.querySelectorAll(".search-calendar__navtitle")).find((t) => textOf(t) === label);
    if (!title) return null;
    // Walk up to the element that holds exactly one month's day cells.
    let panel = title;
    for (let i = 0; i < 8 && panel; i++) {
      const n = panel.querySelectorAll(".search-calendar-cell__day").length;
      if (n >= 28 && n <= 42) return Array.from(panel.querySelectorAll(".search-calendar-cell__day"));
      panel = panel.parentElement;
    }
    return null;
  }

  async function pickCalendarDay(date, openInputIndex) {
    if (openInputIndex !== null) document.querySelectorAll(".search-ui-input--calendar input")[openInputIndex].click();
    await waitFor(() => document.querySelector(".search-calendar__navtitle"), 6000);
    const label = `${HEBREW_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    let cells = monthPanelCells(label);
    if (!cells) {
      // Jump with the month strip (real links, starts at the current month) -- no arrow hunting.
      const strip = Array.from(document.querySelectorAll(".search-ui-calendar-months-bar__month"));
      const now = new Date();
      const offset = (date.getFullYear() - now.getFullYear()) * 12 + (date.getMonth() - now.getMonth());
      if (strip[offset]) { strip[offset].click(); await sleep(700); }
      cells = monthPanelCells(label);
    }
    if (!cells) throw new Error(`El Al's calendar has no ${label} (too far ahead?)`);
    const cell = cells.find((c) => textOf(c) === String(date.getDate()));
    if (!cell) throw new Error(`Day ${date.getDate()} not found in ${label}`);
    cell.click();
    await sleep(500);
  }

  async function confirmCalendar() {
    const ok = Array.from(document.querySelectorAll("button")).find((b) => textOf(b) === "אישור" && visible(b));
    if (ok) { ok.click(); await sleep(600); }
  }

  async function runSearchPhase() {
    status("Loading El Al...");
    await waitFor(() => document.querySelector("input.search-ui-input__input"), 20000);
    if (!document.querySelector("input.search-ui-input__input")) throw new Error("El Al's search form did not load");
    dismissCookieBanner();
    await sleep(500);
    if (!returnDay) await chooseOneWay();
    status(`Setting destination ${destination}...`);
    await fillDestination(destination);
    status(`Picking ${day}...`);
    const [y, m, d] = day.split("-").map(Number);
    await pickCalendarDay(new Date(y, m - 1, d), 0);
    if (returnDay) {
      const [ry, rm, rd] = returnDay.split("-").map(Number);
      await pickCalendarDay(new Date(ry, rm - 1, rd), null);
    }
    await confirmCalendar();
    const search = Array.from(document.querySelectorAll("button")).find((b) => textOf(b).includes("חיפוש טיסה"));
    if (!search) throw new Error("Search button not found");
    status("Searching flights...");
    search.click();
    // The page now navigates; background.js injects this file again on the results page.
  }

  // ---------------------------------------------------------------- phase: select
  const priceOf = (el) => parseFloat((textOf(el).match(/\$\s?([\d,]+)/) || [])[1]?.replace(/,/g, "")) || Infinity;

  async function runSelectPhase() {
    status("Reading El Al's results...");
    const rows = await waitFor(() => {
      const r = Array.from(document.querySelectorAll(".panel__row"));
      return r.length ? r : null;
    }, 30000);
    if (!rows) throw new Error("No flights appeared on El Al's results page");
    const wanted = (flightNumber || "").replace(/\s/g, "");
    const parsed = rows.map((row) => ({ row, no: ((row.innerText.match(/\bLY ?\d{2,4}\b/) || [])[0] || "").replace(/\s/g, "") }));
    const hit = parsed.find((r) => r.no === wanted);
    if (!hit) {
      status(`${wanted || "That flight"} is not listed by El Al for ${day}. Listed: ${parsed.map((r) => r.no).join(", ")}. Pick one below.`, true);
      return;
    }
    const prices = Array.from(hit.row.querySelectorAll(".ui-bound__price__value")).filter((p) => priceOf(p) !== Infinity);
    const cheapest = prices.sort((a, b) => priceOf(a) - priceOf(b))[0];
    if (!cheapest) throw new Error(`${wanted} has no fare shown`);
    hit.row.scrollIntoView({ block: "center" });
    (cheapest.closest("[role=radio], button, .ui-bound__price") || cheapest).click();
    status(`${wanted} selected (cheapest fare, ${textOf(cheapest)}). Choose LITE / CLASSIC / FLEX below and continue -- you enter passenger and payment details yourself.`);
  }

  try {
    if (location.host.includes("booking.elal.com")) await runSelectPhase();
    else await runSearchPhase();
  } catch (e) {
    status(`Could not finish automatically: ${e.message}. You're on El Al's site, so continue by hand from here.`, true);
  }
})();
