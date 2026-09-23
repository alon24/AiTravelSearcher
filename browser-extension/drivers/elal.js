// Injected into a real, human tab (booking.elal.com / www.elal.com) by background.js. This is
// NOT the same trust boundary as the (blocked) server-side Playwright attempt: this runs in the
// user's own real browser, with their own mouse/keyboard input path never touched -- same as
// driving Chrome interactively, which worked cleanly in testing. Selectors match
// src/flightagent/providers/elal_verify.py (same site, captured 2026-09-23) -- keep both in sync.
(async () => {
  const details = window.__skyhopFlightDetails || {};
  const { destination, day, returnDay, flightNumber } = details;
  const HEBREW_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                          "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let banner = document.getElementById("skyhop-status-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "skyhop-status-banner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;" +
      "color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center;direction:ltr;";
    document.body.appendChild(banner);
  }
  const status = (msg) => { window.__skyhopStatus = msg; banner.textContent = "Skyhop Assist: " + msg; console.log("[Skyhop]", msg); };

  function dismissCookieBanner() {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("דחה"));
    if (btn) btn.click();
  }

  async function waitFor(check, timeoutMs = 15000, stepMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = check();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  async function fillDestination(code) {
    const inputs = document.querySelectorAll("input.search-ui-input__input");
    const destInput = inputs[1];
    destInput.focus();
    destInput.value = code;
    destInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(800);
    const suggestion = await waitFor(() =>
      Array.from(document.querySelectorAll("*")).find((el) => el.children.length === 0 && el.textContent.includes(code)));
    if (!suggestion) throw new Error(`No destination suggestion for ${code}`);
    suggestion.click();
  }

  async function pickCalendarDay(date, which) {
    const dateInputs = document.querySelectorAll(".search-ui-input--calendar input");
    dateInputs[which].click();
    const target = `${HEBREW_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    for (let i = 0; i < 6; i++) {
      const headers = Array.from(document.querySelectorAll(".search-calendar__navtitle"));
      const idx = headers.findIndex((h) => h.textContent.trim() === target);
      if (idx !== -1) {
        // A given day-of-month appears at most once per visible month panel, in DOM order
        // matching `headers`' order -- so the `idx`-th match is the one in our target panel.
        const cells = Array.from(document.querySelectorAll(".search-calendar-cell__day"))
          .filter((c) => c.textContent.trim() === String(date.getDate()));
        const cell = cells[idx];
        if (!cell) throw new Error(`Calendar day ${date.getDate()} not found in ${target} panel`);
        cell.click();
        return;
      }
      const last = headers[headers.length - 1];
      if (last) {
        const box = last.getBoundingClientRect();
        document.elementFromPoint(box.right + 40, box.top + box.height / 2)?.click();
      }
      await sleep(400);
    }
    throw new Error(`Could not navigate calendar to ${target}`);
  }

  function readFlightRows() {
    return Array.from(document.querySelectorAll(".panel__row")).map((row) => {
      const text = row.innerText;
      const flightNo = (text.match(/\bLY ?\d{2,4}\b/) || [])[0]?.replace(" ", "");
      return { row, flightNo };
    });
  }

  async function selectFlight(wantedFlightNo) {
    await waitFor(() => document.querySelector(".panel__row"), 20000);
    const rows = readFlightRows();
    if (!rows.length) throw new Error("No flight rows found -- site may have changed, or shows no flights");
    const match = wantedFlightNo && rows.find((r) => r.flightNo === wantedFlightNo);
    const chosen = match || rows[0];
    status(match ? `Selected ${wantedFlightNo}` : `${wantedFlightNo || "requested flight"} not listed -- selected the cheapest instead`);
    const priceEl = chosen.row.querySelector(".ui-bound__price__value");
    if (!priceEl) throw new Error("No fare price found on the matched flight row");
    priceEl.click();
  }

  try {
    status("Loading...");
    await waitFor(() => document.querySelector("input.search-ui-input__input"), 15000);
    dismissCookieBanner();
    await fillDestination(destination);
    if (day) await pickCalendarDay(new Date(day), 0);
    if (returnDay) await pickCalendarDay(new Date(returnDay), 1);

    const searchBtn = await waitFor(() =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("חיפוש טיסה")));
    if (!searchBtn) throw new Error("Search button not found");
    searchBtn.click();

    await waitFor(() => location.host.includes("booking.elal.com"), 20000);
    await sleep(4000);
    await selectFlight(flightNumber);
    status(`Done -- outbound flight selected. Pick a fare tier (LITE/CLASSIC/FLEX) and, if round trip, select the return flight the same way.`);
    if (returnDay) {
      await sleep(1500);
      await selectFlight(null); // return leg: we don't have its flight number from the search result yet
    }
  } catch (e) {
    status(`Could not finish automatically: ${e.message}. You're on El Al's site -- finish the search by hand from here.`);
  }
})();
