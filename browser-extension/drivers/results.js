// Generic results-page driver, injected by background.js into a real, human tab AFTER drivers/laya-agent.js, for every
// airline whose search is a plain URL (airlines.json mode "url", or a template learned from the user's own search).
//
// Nothing here is airline-specific. On the results page the page's elements are located on the fly:
//   - flight cards:   any smallest block holding two clock times, a price and a clickable control (generic shape);
//   - cookie banner:  Laya picks "the button that declines optional cookies" (privacy-preserving choice);
//   - fare buttons:   Laya confirms each button in the matched card is a fare-select control;
//   - page type:      Laya classifies the visible text when no cards appear (consent / captcha / blocked / none).
// Times and prices are read with regexes -- Laya can't read numbers. The flight is matched by its departure time
// (many airlines' cards show no flight number), else by flight number if the card prints it. Like the TAROM driver
// it only OUTLINES the cheapest fare; it never presses a fare's SELECT button and never touches passenger/payment
// fields. Known limit: a card layout that isn't "times + price + button in one block" reports what it found instead.
(async () => {
  const details = window.__skyhopFlightDetails;
  const laya = window.__skyhopLaya;
  if (!details || window.__skyhopResultsRunning) return;
  window.__skyhopResultsRunning = true;
  const { departTime, flightNumber, airlineName = "the airline" } = details;   // departTime: "HH:MM" local at the origin, from Skyhop's result
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let model = "";   // the decision model that answers (Laya or Jev): the ping says which

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
    banner.textContent = `Skyhop Assist${model ? ` (${model})` : ""}: ` + msg;
    console.log("[Skyhop]", msg);
  }
  const log = (m) => console.log("[Skyhop/Laya]", m);

  async function waitFor(check, timeoutMs = 15000, stepMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = check();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  const { norm, priceIn, timesIn, SELECT_WORD } = window.__skyhopParse;   // drivers/parse.js

  // "Controls": anything a person would click as a button. Real buttons/links/role=button, but also plain spans/divs
  // that only LOOK like buttons (Tus Air's "Select" is a <span> in a <div> in an <a>): recognised by a pointer
  // cursor. Short label only (a link wrapping a whole card isn't a button), outermost of nested matches.
  const CONTROL = "button, a, [role=button], input[type=button], input[type=submit]";
  function controlsIn(root) {
    const found = [];
    for (const el of laya.deepAll(root, "*")) {
      const n = (el.textContent || "").trim().length;
      if (!n || n > 40 || !laya.visible(el)) continue;   // cheap checks first: the cursor lookup below is the slow one
      if (el.matches(CONTROL) || getComputedStyle(el).cursor === "pointer") found.push(el);
    }
    return found.filter((c) => !found.some((o) => o !== c && o.contains(c)));
  }

  // Smallest ancestor of each control that reads like a flight: >= 2 clock times and a price.
  function findCards() {
    const cards = [];
    for (const b of controlsIn(document)) {
      let el = b.parentElement;
      for (let i = 0; el && i < 8; i++, el = el.parentElement) {
        const t = el.innerText || "";
        if (timesIn(t).length >= 2 && priceIn(t) !== null) {
          if (!cards.includes(el)) cards.push(el);
          break;
        }
      }
    }
    // Keep only the innermost of nested matches.
    return cards.filter((c) => !cards.some((o) => o !== c && c.contains(o)));
  }

  // Fares in a card, in page order: each control paired with the price on it, else the last price text seen before it.
  function faresOf(card) {
    const controls = new Set(controlsIn(card));
    const fares = [];
    let lastPrice = null;
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (controls.has(n)) {
        const own = priceIn(n.textContent);
        if (own !== null) lastPrice = own;
        if (lastPrice !== null) fares.push({ button: n, price: lastPrice });
      } else if (n.children.length === 0) {
        const p = priceIn(n.textContent);
        if (p !== null) lastPrice = p;
      }
    }
    return fares;
  }

  try {
    status("checking the decision model…");
    const ping = await laya.ping();
    if (!ping.ok) throw new Error("can't ask its decision model: " + ping.error);
    model = ping.decider === "jev" ? "Jev" : "Laya";

    // 1. Cookie banner (the results render behind it, so this is only to leave the page clean).
    if (/privacy settings|cookie|consent/i.test(document.body.innerText + " " + laya.shadowText())) {
      status("cookie banner: asking Laya which button declines optional cookies…");
      const declined = await laya.pick("the button that declines or rejects optional cookies (deny all, reject non-essential)", {
        selector: "button", act: (el) => el.click(), log,
        verify: (el) => !laya.visible(el),   // the banner (and so its button) went away
      });
      log(declined ? `declined cookies via ${declined.text} (${declined.score.toFixed(2)})` : "no confident cookie button, left the banner alone");
    }

    // 2. Cards
    status("looking for the flight list…");
    let cards = await waitFor(() => { const c = findCards(); return c.length ? c : null; }, 25000);
    if (!cards) {
      const kind = await laya.pageType(document.body.innerText);
      const why = { consent: "a consent wall", captcha: "a CAPTCHA / bot check", blocked: "a block or rate limit",
        no_flights: "a page saying there are no flights", results: "a results page whose layout wasn't recognised" }[kind];
      throw new Error("no flights found on the page" + (why ? ` -- Laya says it looks like ${why}` : " (Laya could not classify it)"));
    }
    await sleep(1200);            // let prices settle after the cards first paint
    cards = findCards();

    // 3. Match by departure time.
    const timesOf = (c) => timesIn(c.innerText);
    const listed = cards.map((c) => timesOf(c)[0]).join(", ");
    const card = cards.find((c) => timesOf(c)[0] === departTime)
      || (flightNumber && cards.find((c) => norm(c.innerText).replace(/\s/g, "").toUpperCase().includes(flightNumber.replace(/\s/g, "").toUpperCase())));
    if (!card) throw new Error(departTime
      ? `the ${departTime} departure isn't listed on ${airlineName} (it lists: ${listed})`
      : `Skyhop didn't pass a departure time and the flight number isn't shown on the cards (it lists: ${listed}) -- refresh the Skyhop page and try again`);
    card.scrollIntoView({ block: "center" });

    // 4. Fare buttons: Laya confirms they are fare-select controls (guards against pairing a stray button).
    const fares = faresOf(card);
    if (!fares.length) throw new Error("found the flight but no controls with a price on it");
    // Which control selects a fare? Measured: Laya alone gets this wrong (it scored "Price per person" 0.93 and a
    // <div>Select</div> 0.31), so the code narrows to controls whose label has a select-type word and Laya only
    // confirms among them; with no such word it must be very sure (0.85). Every control is described to Laya as a
    // "button" -- what it functions as -- since it scores a bare <div>/<span> label far too low.
    const VERB = SELECT_WORD;
    const named = fares.filter((f) => VERB.test(laya.labelOf(f.button)));
    const pool = named.length ? named : fares;
    const ranked = await laya.rank("the button that selects this flight and its price (Select, Choose, Book)",
      pool.map((f) => ({ el: f.button, text: `button "${laya.labelOf(f.button)}"` })));
    const okButtons = new Set(ranked.filter((r) => r.score >= (named.length ? 0.5 : 0.85)).map((r) => r.el));
    const good = pool.filter((f) => okButtons.has(f.button));
    if (!good.length) throw new Error("Laya wasn't confident any control in that card selects a fare: " + ranked.map((r) => `${r.score.toFixed(2)} ${r.text}`).join(" | "));
    good.sort((a, b) => a.price - b.price);
    const cheapest = good[0];
    cheapest.button.style.outline = "4px solid #c6007e";
    cheapest.button.style.outlineOffset = "3px";
    const list = good.map((f) => f.price.toFixed(2)).join(" / ");
    status(`${departTime || flightNumber}: cheapest fare ${cheapest.price.toFixed(2)} outlined (fares on this flight: ${list}). ` +
      `A lower price can be a members-only fare. Not pressed -- you choose.`);
  } catch (e) {
    status(String(e?.message || e), true);
  }
})();
