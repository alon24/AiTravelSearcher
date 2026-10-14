"use strict";
/* Help: a "?" button on every screen opens a Help panel with a guided tour of the screen you are on, the other tours,
   and quick answers. A first plain visit (not a Travel Hub or shared link) starts the welcome tour once.
   A tour step points at a real element (spotlight + bubble); steps whose element isn't on screen right now are skipped,
   so one script serves desktop and phone, before and after a search. Uses app.js globals (h, $, $$, store, Mobile). */
const Help = (() => {
  const SEEN = "skyhop.tour";   // "seen" once the welcome tour was shown (finished or skipped)
  const byLink = !!(location.search || location.hash);   // read now: the app tidies a Travel Hub or invite link out of the address

  // ---------------------------------------------------------------- the tours
  // el: a selector (the first visible match wins) or a list of them; no el = a centred card.
  const TOURS = {
    search: { title: "Welcome to Skyhop", blurb: "Where everything is, and how a search works", steps: [
      { title: "Welcome to Skyhop", text: "Skyhop checks every day in your dates, mixes airlines and finds the cheapest trip. This short tour shows where everything is. You can reopen it any time from the ? button." },
      { el: [".wz-head"], title: "Four short steps", text: "On a phone the search is a wizard: Where, When, Who, then Review. Tap a step to jump back to it." },
      { el: ["#form .row.two"], title: "Where", text: "From is your home airport. In To, add one or more places: Skyhop compares them all in one search." },
      { el: ["#form .row.dates [data-wstep='2']"], title: "When", text: "Earliest departure and latest return are a flexible window, not exact dates. Skyhop tries every departure day inside it." },
      { el: ["#expert"], target: el => el.closest(".field"), title: "How long", text: "By default any trip length that fits your dates. Turn on Expert mode to ask for, say, exactly 4 nights or 5 to 7." },
      { el: ["#more"], title: "More options", text: "Fly home from another city (open-jaw), travel between your destinations, separate tickets through a hub, and bags." },
      { el: [".wz-nav .wz-next"], title: "Next step", text: "Next moves on to When, Who and a final Review. Search now runs the search with what is filled in so far." },
      { el: ["#go"], title: "Search", text: "When the trip looks right, press Find flights. The results open below the form." },
      { el: ["#steps"], title: "Your steps", text: "1 Trip reopens the search to edit it. 2 Airlines filters airlines after a search. 3 Compare jumps to the results." },
      { el: ["#history", "#menu"], title: "Past searches", text: "Every search is kept here. Click one to open it again instantly, without searching again." },
      { el: [".m-nav"], title: "Getting around", text: "This bar is always here: Search edits the trip, Trips and Days show the results, Ask chats with Skyhop, and Trip opens your Trip builder." },
      { el: ["#tb-launch"], title: "Trip builder", text: "Collect flights from different searches into one trip, any flight for any leg. Skyhop checks the time and airport between them." },
      { el: ["#chat-launch"], title: "Ask Skyhop", text: "Rather type it? Describe the trip in your own words and Skyhop runs the search for you." },
      { el: [".help-btn"], title: "Help is always here", text: "Lost on any screen? Press ? for a tour of that screen and quick answers." },
    ] },
    results: { title: "Reading the results", blurb: "The best picks, the three views, and how to book", steps: [
      { el: [".res-head"], title: "Your search", text: "What you searched, and how many prices were checked. Edit changes the search; Search again fetches fresh prices." },
      { el: [".res-tabs"], title: "Three views", text: "Trips has the best picks and the top trips. Price by day shows the price for each departure day. Mix & match lets you pick each flight yourself." },
      { el: ["#air-sticky .ab", "#air-sticky"], title: "Airlines", text: "The airlines found on this route, cheapest first. Choose Only or Exclude on one to filter the results at once." },
      { el: [".m-tabs"], title: "Three views", text: "Trips lists every trip, Days shows the price for each departure day, and Mix & match lets you pick each flight yourself." },
      { el: [".m-picks .m-card", ".picks", ".cmp"], title: "The best picks", text: "Cheapest, best value (price weighed against travel time) and fastest. Open one to see its flights and the buttons to book them." },
      { el: [".m-tools"], title: "Filter the list", text: "Tap a destination, a trip length or Direct to narrow the list, and sort it the way you like." },
      { el: [".trip-rows"], title: "More trips", text: "The next best trips, one line each. Click a line to open its flights." },
      { el: [".m-nav"], title: "Getting around", text: "Search takes you back to edit the trip, Trips and Days switch views, and Trip opens your Trip builder." },
      { el: [".res-pane:not([hidden]) .card.trip .actions", ".card.trip .actions"], title: "Book it", text: "Skyhop never sells tickets. The airline buttons open the airline's own site with the flight filled in. You can also add the flights to the Trip builder or save them to Travel Hub." },
    ] },
    builder: { title: "Trip builder", blurb: "Build one trip from flights you collect", open: () => Builder.open(), steps: [
      { el: ["#tb .tb-head"], title: "Trip builder", text: "Your own trip, one leg at a time. Add flights from any search with “Add to Trip builder”, or add a leg here and pick from every flight that day." },
      { el: ["#tb-body"], title: "Legs", text: "Each leg shows its chosen flight. Skyhop warns you if the time or the airport between two legs doesn't work." },
      { el: ["#tb-foot"], title: "Total and next steps", text: "The total for the whole trip. Save it to Travel Hub, copy a summary to send, or clear it and start over." },
    ] },
    chat: { title: "Ask Skyhop", blurb: "Search by chatting, then share the trip", open: () => $("#chat-launch").click(), available: () => !$("#chat-launch").hidden, steps: [
      { el: ["#chat-form", "#chat-signin"], title: "Just say it", text: "Write where, when and what matters, like “Portugal for a week in late November, direct only”. Skyhop searches and shows the results beside the chat." },
      { el: ["#chat-summarize"], title: "Summarize", text: "Turns the conversation into a short trip brief you can come back to later." },
      { el: ["#chat-share", "#chat-invite"], title: "Plan together", text: "Share makes it a shared trip: friends join by link and can ask Skyhop too." },
      { el: ["#chat-close"], title: "Back to the search", text: "Close the chat to return to the page. Your conversation is kept." },
    ] },
  };
  const FAQ = [
    ["Are these prices real?", "With the DEMO DATA badge, no: they are made up so you can try Skyhop. Sign in with Google to search real fares."],
    ["Can I buy tickets here?", "No. Skyhop finds the flights; the airline buttons open the airline's own site, where you book and pay."],
    ["What is open-jaw?", "Flying into one city and home from another, like into Lisbon and home from Porto. Set it in More options → Fly home from."],
    ["What is self-transfer?", "Two separate tickets through a hub. It can be much cheaper, but you collect and re-check your bags, and a delay is your risk."],
    ["How do I go back to an earlier search?", "Open Past searches (the side bar, or ☰ on a phone) and click it. It opens instantly from what was saved."],
    ["How do I send flights to Travel Hub?", "Press “Save to Travel Hub” on a trip or in the Trip builder. The flights land on your trip next to its hotels and map."],
  ];

  // ---------------------------------------------------------------- which screen are we on
  function current() {
    if (!$("#tb").hidden) return "builder";
    if (!$("#chat").hidden) return "chat";
    if ($(".res-head") && $("#step-panel").hidden) return "results";
    return "search";
  }

  // ---------------------------------------------------------------- tour engine
  const shown = el => {   // laid out, visible, and not parked off-canvas (the phone's closed side bar)
    if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.left < innerWidth;
  };
  function targetOf(step) {
    if (!step.el) return null;
    for (const sel of step.el) {
      const el = $$(sel).find(shown);
      if (el) return step.target ? step.target(el) : el;
    }
    return undefined;   // the step points at something not on screen now: skip it
  }
  let run = null;   // { name, steps: [{step, el}], i, layer, hole, tip }
  function start(name) {
    close(false);
    const tour = TOURS[name];
    if (tour.open && current() !== name) { tour.open(); setTimeout(() => begin(name), 260); return; }   // after the drawer slides in
    begin(name);
  }
  function begin(name) {
    const steps = TOURS[name].steps.map(step => ({ step, el: targetOf(step) })).filter(s => s.el !== undefined);
    if (!steps.length) return;
    const hole = h("div", { class: "tour-hole", "aria-hidden": "true" });
    const tip = h("div", { class: "tour-tip", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title" });
    const layer = h("div", { class: "tour", "data-tour": name }, hole, tip);
    document.body.append(layer);
    run = { name, steps, i: 0, layer, hole, tip };
    addEventListener("resize", place); addEventListener("scroll", place, true);
    show(0);
  }
  function show(i) {
    run.i = i;
    const { step, el } = run.steps[i], n = run.steps.length, last = i === n - 1;
    run.tip.replaceChildren(
      h("div", { class: "tour-count" }, `${i + 1} of ${n}`),
      h("h3", { id: "tour-title" }, step.title),
      h("p", {}, step.text),
      h("div", { class: "tour-nav" },
        last ? null : h("button", { type: "button", class: "btn ghost tour-skip", onclick: () => close() }, "Skip tour"),
        i > 0 ? h("button", { type: "button", class: "btn tour-back", onclick: () => show(i - 1) }, "‹ Back") : null,
        h("button", { type: "button", class: "btn primary tour-next", onclick: () => (last ? close() : show(i + 1)) }, last ? "Done" : "Next ›")));
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
    place();
    $(".tour-next", run.tip).focus();
  }
  function place() {
    if (!run) return;
    const { el } = run.steps[run.i], { hole, tip } = run, pad = 6, gap = 12, vw = innerWidth, vh = innerHeight;
    run.layer.classList.toggle("centred", !el);
    if (!el) { hole.style.cssText = ""; tip.style.cssText = ""; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const tw = Math.min(360, vw - 24), th = tip.offsetHeight;
    const below = r.bottom + pad + gap, above = r.top - pad - gap - th;
    const top = below + th <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - th - 8);
    const left = Math.max(12, Math.min(vw - tw - 12, r.left + r.width / 2 - tw / 2));
    Object.assign(tip.style, { width: `${tw}px`, left: `${left}px`, top: `${top}px` });
  }
  function close(remember = true) {
    if (!run) return;
    if (remember && run.name === "search") store.set(SEEN, "seen");
    run.layer.remove(); run = null;
    removeEventListener("resize", place); removeEventListener("scroll", place, true);
  }

  // ---------------------------------------------------------------- help panel
  let panel = null;
  function openPanel() {
    closePanel();
    const here = current();
    const others = Object.keys(TOURS).filter(k => k !== here && (!TOURS[k].available || TOURS[k].available()));
    const tourBtn = (k, primary) => h("button", { type: "button", class: "help-tour" + (primary ? " here" : ""), "data-help-tour": k, onclick: () => { closePanel(); start(k); } },
      h("b", {}, primary ? `▶ Tour this screen: ${TOURS[k].title}` : TOURS[k].title), h("span", {}, TOURS[k].blurb));
    panel = h("div", { class: "help-wrap" },
      h("div", { class: "tb-scrim help-scrim", onclick: closePanel }),
      h("aside", { class: "tb help open", role: "dialog", "aria-label": "Help" },
        h("div", { class: "tb-head" }, h("div", {}, h("h2", {}, "Help"), h("p", {}, "A guided tour of this screen, the other tours, and quick answers.")),
          h("button", { type: "button", class: "btn icon-btn help-close", "aria-label": "Close help", onclick: closePanel }, "✕")),
        h("div", { class: "tb-body" },
          tourBtn(here, true),
          h("h3", { class: "help-h" }, "Other tours"), others.map(k => tourBtn(k, false)),
          h("h3", { class: "help-h" }, "Quick answers"),
          FAQ.map(([q, a]) => h("details", { class: "help-faq" }, h("summary", {}, q), h("p", {}, a))))));
    document.body.append(panel);
    $(".help-tour.here", panel).focus();
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function init() {
    $$(".help-btn").forEach(b => b.addEventListener("click", openPanel));
    document.addEventListener("keydown", e => {
      if (run) {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowRight" && run.i < run.steps.length - 1) show(run.i + 1);
        else if (e.key === "ArrowLeft" && run.i > 0) show(run.i - 1);
        else return;
        e.stopImmediatePropagation(); e.preventDefault();
      } else if (panel && e.key === "Escape") { closePanel(); e.stopImmediatePropagation(); }
    }, true);
    // A plain first visit gets the welcome tour once; a Travel Hub or shared link opens straight on its search.
    if (!store.get(SEEN) && !byLink) setTimeout(() => { if (!run && !panel) start("search"); }, 400);
  }
  return { init, start, close, openPanel, current };
})();
