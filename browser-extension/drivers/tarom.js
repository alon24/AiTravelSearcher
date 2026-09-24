// Injected into a real, human tab by background.js. TAROM needs no form-driving: its own search
// widget just opens digital.tarom.ro/booking?search=<JSON> (origin, destination, date -- no token),
// so background.js opens that URL directly (see DRIVERS.RO.startUrl) and this script only runs on the
// results page: find the flight by number, expand its Economy fares, highlight the cheapest one.
// It never presses a fare's SELECT button and never touches passenger or payment fields.
// Selectors captured from the live site 2026-09-24 (Amadeus "refx" Angular Material UI).
(async () => {
  const details = window.__skyhopFlightDetails;
  if (!details) return;
  const { day, flightNumber } = details;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const norm = (s) => (s || "").replace(/\s/g, "").toUpperCase();
  const priceOf = (el) => parseFloat((textOf(el).match(/EUR\s*([\d,]+(?:\.\d+)?)/i) || [])[1]?.replace(/,/g, "")) || Infinity;
  const cardsNow = () => Array.from(document.querySelectorAll(".basic-flight-card-layout-container"));

  // The flight number is only shown inside each card's "See itinerary details" dialog.
  async function flightNumbersOf(card) {
    const link = Array.from(card.querySelectorAll("button")).find((b) => /itinerary details/i.test(textOf(b)));
    if (!link) return "";
    link.click();
    const dlg = await waitFor(() => Array.from(document.querySelectorAll(".mat-mdc-dialog-container")).find(visible), 6000);
    let nums = "";
    if (dlg) {
      nums = Array.from(dlg.innerText.matchAll(/Flight number\s+([A-Z0-9]{2}\s?\d{1,4})/gi)).map((m) => norm(m[1])).join(",");
      const close = Array.from(dlg.querySelectorAll("button")).find((b) => /close/i.test(textOf(b)));
      if (close) close.click();
      await waitFor(() => !Array.from(document.querySelectorAll(".mat-mdc-dialog-container")).some(visible), 4000);
      await sleep(300);
    }
    return nums;
  }

  async function run() {
    status("Reading TAROM's results...");
    const cards = await waitFor(() => (cardsNow().length ? cardsNow() : null), 30000);
    if (!cards) throw new Error("No flights appeared on TAROM's results page");
    await sleep(500);
    const wanted = norm(flightNumber);
    const listed = [];
    let hit = null;
    for (const card of cardsNow()) {
      const nums = await flightNumbersOf(card);
      listed.push(nums || "?");
      if (nums.split(",").includes(wanted)) { hit = card; break; }
    }
    if (!hit) {
      status(`${wanted || "That flight"} is not listed by TAROM for ${day}. Listed: ${listed.join(", ")}. Pick one below.`, true);
      return;
    }
    hit.scrollIntoView({ block: "center" });
    const fareTabs = Array.from(hit.querySelectorAll("button.flight-card-button-desktop-view")).filter((b) => priceOf(b) !== Infinity);
    const cheapestTab = fareTabs.sort((a, b) => priceOf(a) - priceOf(b))[0];
    if (!cheapestTab) throw new Error(`${wanted} has no fare shown`);
    cheapestTab.click();
    await sleep(1200);

    // The expanded fare cards (LIGHT / SAVER / OPTIM / FLEX ...) sit below the flight card; find the
    // cheapest one via its SELECT button and outline it. We do not press SELECT.
    const scope = hit.closest(".upsell-premium-row-pres") || document;
    const selects = Array.from(scope.querySelectorAll("button")).filter((b) => visible(b) && /^select$/i.test(textOf(b)));
    const fareBoxes = selects.map((btn) => {
      let box = btn;
      while (box.parentElement && box.parentElement !== scope &&
             Array.from(box.parentElement.querySelectorAll("button")).filter((b) => /^select$/i.test(textOf(b))).length === 1) box = box.parentElement;
      return box;
    });
    const cheapestBox = fareBoxes.sort((a, b) => priceOf(a) - priceOf(b))[0];
    if (cheapestBox) {
      cheapestBox.style.outline = "3px solid #6a3df0";
      cheapestBox.style.outlineOffset = "2px";
    }
    status(`${wanted} found${cheapestBox ? ` (cheapest fare, EUR ${priceOf(cheapestBox)}, outlined)` : ""}. Press SELECT on the fare you want -- you enter passenger and payment details yourself.`);
  }

  try {
    await run();
  } catch (e) {
    status(`Could not finish automatically: ${e.message}. You're on TAROM's site, so continue by hand from here.`, true);
  }
})();
