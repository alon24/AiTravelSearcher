"use strict";
/* Phone layout (max-width 720px): the desktop page is one long stack of panels, about 30 screens for a two-city search.
   On a phone the search form becomes a 4-step wizard, results open on a few top picks plus a short filterable list of
   compact trip rows (tap one for its flights, full screen), the chart and Mix & match move into tabs, and a bottom bar
   replaces the floating launchers. Desktop is untouched. Uses app.js globals (h, $, $$, money, fmtDay, day, tripCard...). */
const Mobile = (() => {
  const query = matchMedia("(max-width: 720px)");
  const isPhone = () => query.matches;
  const PAGE = 10;   // trip rows shown per "Show more"

  // ---------------------------------------------------------------- trips
  const tripKey = t => t.legs.map(l => l.segments.map(s => `${s.airline_code}${s.flight_number}@${s.departs}`).join("+")).join("|");
  const airlinesText = t => [...new Map(t.legs.flatMap(l => l.segments).map(s => [s.airline_code, airlineName(s.airline_code, s.airline)])).values()].join(" + ");
  const lenWord = n => (unit === "days" ? plural(n + 1, "day") : plural(n, "night"));
  const kindLabel = t => tr({ open_jaw: "Open-jaw", multi_stop: "Multi-city" }[t.kind]);

  /** Every distinct trip the search ranked: the best per destination x length, the cheapest and best value of each day, and the top list. */
  function allTrips(res) {
    const seen = new Map();
    const add = t => { if (t && !seen.has(tripKey(t))) seen.set(tripKey(t), t); };
    (res.cells || []).forEach(c => add(c.cheapest));
    (res.daily || []).forEach(d => { add(d.cheapest); add(d.best_value); });
    (res.top || []).forEach(add);
    return [...seen.values()];
  }

  /** Cheapest, best value, fastest and cheapest direct; one card per trip, carrying every label it earned. */
  function topPicks(trips) {
    if (!trips.length) return [];
    const min = (list, f) => list.reduce((a, b) => (f(b) < f(a) ? b : a));
    const directs = trips.filter(t => t.stops === 0);
    const picks = [
      ["Cheapest", min(trips, t => t.price)],
      ["Best value", min(trips, t => t.effective_cost)],
      ["Fastest", min(trips, t => t.total_travel_min * 1e6 + t.price)],
      directs.length ? ["Cheapest direct", min(directs, t => t.price)] : null,
    ].filter(Boolean);
    const byTrip = new Map();
    for (const [label, t] of picks) byTrip.set(t, [...(byTrip.get(t) || []), label]);
    return [...byTrip.entries()].map(([t, labels]) => ({ t, labels }));
  }

  /** A trip as a two-line row: where, when, price, airlines and stops. Tapping it opens the full trip. */
  function card(t, cur, pax, labels = []) {
    const out = t.legs[0];
    return h("button", { type: "button", class: "m-card" + (labels.length ? " pick" : ""), "aria-haspopup": "dialog", onclick: () => openTrip(t, cur, pax) },
      labels.length ? h("span", { class: "m-labels" }, labels.map(tr).join(" · ")) : null,
      h("span", { class: "m-top" },
        h("span", { class: "m-dest" }, t.destination, kindLabel(t) ? h("span", { class: "badge run" }, kindLabel(t)) : null, t.self_transfer ? h("span", { class: "badge warn" }, "Self-transfer") : null),
        h("span", { class: "m-price" }, money(t.price, cur))),
      h("span", { class: "m-line" }, `${fmtDay(day(t.depart_date))} → ${fmtDay(day(t.return_date))} · ${lenWord(t.nights)}`),
      h("span", { class: "m-line sub" }, tx("{air} · {stops} · {t} out", { air: airlinesText(t), stops: stopsText(t.stops), t: hm(out.duration_min) })),
      origNote(t.price, cur, "orig block"));
  }

  // ---------------------------------------------------------------- trip sheet (full screen, closes with Back)
  let sheet = null;
  function openTrip(t, cur, pax) {
    closeTrip(false);
    const back = h("button", { type: "button", class: "btn", onclick: () => closeTrip() }, "‹ Back");
    sheet = h("div", { class: "m-sheet", role: "dialog", "aria-modal": "true", "aria-label": tx("Trip to {dest}", { dest: t.destination }) },
      h("div", { class: "m-sheet-head" }, back, h("b", {}, `${t.destination} · ${money(t.price, cur)}`)),
      h("div", { class: "m-sheet-body" }, tripCard(t, cur, pax)));
    document.body.append(sheet);
    document.body.classList.add("m-locked");
    history.pushState({ skyhopSheet: true }, "");   // the phone's Back button closes the trip instead of leaving the page
    back.focus();
  }
  function closeTrip(viaHistory = true) {
    if (!sheet) return;
    sheet.remove(); sheet = null;
    document.body.classList.remove("m-locked");
    if (viaHistory && history.state && history.state.skyhopSheet) history.back();
  }

  // ---------------------------------------------------------------- results
  let showTab = () => {};
  /** Results on a phone: tabs for Trips (top picks + filtered list), Days (the price chart) and Mix & match. */
  function results(box, { res, q, cur, pax, state, days, mix }) {
    const st = state;
    st.tab ||= "trips"; st.sort ||= "price"; st.dests ||= new Set(); st.lens ||= new Set(); st.direct ||= false; st.shown ||= PAGE;
    const trips = allTrips(res);
    const tripsPane = h("div", { class: "m-pane", "data-pane": "trips" });
    const daysPane = h("div", { class: "m-pane", "data-pane": "days" }, days);
    const mixPane = h("div", { class: "m-pane", "data-pane": "mix" }, mix);
    const tabs = [["trips", tx("Trips ({n})", { n: trips.length })], ["days", "Days"], ["mix", "Mix & match"]];
    const tabBar = h("div", { class: "m-tabs", role: "tablist" }, tabs.map(([k, label]) =>
      h("button", { type: "button", role: "tab", "data-tab": k, onclick: () => showTab(k) }, label)));
    showTab = k => {
      st.tab = k;
      $$("[data-tab]", tabBar).forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === k)));
      [tripsPane, daysPane, mixPane].forEach(p => { p.hidden = p.dataset.pane !== k; });
      syncNav();
    };
    box.append(h("div", { class: "m-results" }, tabBar, tripsPane, daysPane, mixPane));

    const picks = topPicks(trips);
    const listHost = h("div", { class: "m-list" });
    const order = [...new Set([...q.destinations, ...trips.map(t => t.destination)])].filter(d => trips.some(t => t.destination === d));
    const lens = [...new Set(trips.map(t => t.nights))].sort((a, b) => a - b);
    const sorter = { price: (a, b) => a.price - b.price, best: (a, b) => a.effective_cost - b.effective_cost,
      travel: (a, b) => a.total_travel_min - b.total_travel_min || a.price - b.price, date: (a, b) => a.depart_date.localeCompare(b.depart_date) || a.price - b.price };
    const chip = (text, on, onclick) => h("button", { type: "button", class: "cmp-chip" + (on ? " on" : ""), "aria-pressed": String(on), onclick }, text);
    const toggle = (set, v) => { if (set.has(v)) set.delete(v); else set.add(v); st.shown = PAGE; drawList(); };
    function drawList() {
      const rows = trips.filter(t => (!st.dests.size || st.dests.has(t.destination)) && (!st.lens.size || st.lens.has(t.nights)) && (!st.direct || t.stops === 0)).sort(sorter[st.sort]);
      listHost.replaceChildren(
        h("div", { class: "m-tools" },
          order.length > 1 ? order.map(d => chip(d, st.dests.has(d), () => toggle(st.dests, d))) : null,
          lens.length > 1 ? lens.map(n => chip(lenWord(n), st.lens.has(n), () => toggle(st.lens, n))) : null,
          chip("Direct", st.direct, () => { st.direct = !st.direct; st.shown = PAGE; drawList(); })),
        h("div", { class: "m-tools" },
          h("label", { class: "cmp-sort" }, tr("Sort"), " ", h("select", { onchange: e => { st.sort = e.target.value; drawList(); } },
            [["price", "Price (lowest)"], ["best", "Best value"], ["travel", "Shortest travel"], ["date", "Departure date"]].map(([v, t]) => h("option", { value: v, selected: st.sort === v }, t)))),
          h("span", { class: "badge run m-count" }, rows.length === trips.length ? plural(rows.length, "trip") : tx("{n} of {m} trips", { n: rows.length, m: trips.length }))),
        rows.length ? h("div", { class: "m-rows" }, rows.slice(0, st.shown).map(t => card(t, cur, pax)))
          : h("div", { class: "note" }, "No trips match these filters. Tap a highlighted chip to clear it."),
        rows.length > st.shown ? h("button", { type: "button", class: "btn m-more", onclick: () => { st.shown += PAGE; drawList(); } },
          tx("Show {n} more ({m} left)", { n: Math.min(PAGE, rows.length - st.shown), m: rows.length - st.shown })) : null);
    }
    tripsPane.append(
      h("h3", { class: "m-h" }, "Top picks"),
      h("div", { class: "m-picks" }, picks.map(p => card(p.t, cur, pax, p.labels))),
      h("h3", { class: "m-h" }, "All trips"), listHost);
    drawList();
    showTab(st.tab);
  }

  // ---------------------------------------------------------------- search wizard
  const STEPS = ["Where", "When", "Who", "Review"];
  let at = 1, wzHead, wzNav, wzReview;
  const formError = () => toRequest(readForm());

  function wizardTo(n) {
    if (!wzHead) return;   // writeForm() runs once before init()
    at = Math.max(1, Math.min(STEPS.length, n));
    $("#form").dataset.at = at;
    $("#step-panel").classList.toggle("wz-last", at === STEPS.length);
    $$("button", wzHead).forEach((b, i) => { b.setAttribute("aria-current", String(i + 1 === at)); b.classList.toggle("done", i + 1 < at); });
    $(".wz-title", wzHead).textContent = tx("Step {at} of {n} · {name}", { at, n: STEPS.length, name: tr(STEPS[at - 1]) });
    $(".wz-back", wzNav).hidden = at === 1;
    $(".wz-next", wzNav).hidden = at === STEPS.length;
    $(".wz-now", wzNav).hidden = at === STEPS.length;
    $(".wz-next", wzNav).textContent = tx("Next: {name}", { name: tr(STEPS[at] || "") });
    if (at === STEPS.length) drawReview();
    showFormError("");
  }
  /** Back to the first step that still needs something, or the review when the form is complete (an edit, a link from Travel Hub). */
  function wizardReset() { const e = formError(); wizardTo(e.error ? e.step : STEPS.length); }
  function next() {
    const e = formError();
    if (e.error && e.step <= at) { wizardTo(e.step); showFormError(e.error); return; }
    wizardTo(at + 1);
  }
  function drawReview() {
    const f = readForm();
    const when = `${fmtShort(day(f.start))} – ${fmtShort(day(f.end))} · ${lenMode === "any" ? tr("any length that fits") : lenRange(f.nmin, f.nmax)}`;
    const who = `${plural(f.adults, "adult")}${f.kids.length ? ` + ${plural(f.kids.length, "child")}` : ""} · ${f.stops === 0 ? tr("direct only") : tx("up to {n}", { n: plural(f.stops, "stop") })}`;
    wzReview.replaceChildren(...[[1, `${f.from[0] || "?"} → ${f.to.join(", ") || "?"}`], [2, when], [3, who]].map(([n, text]) =>
      h("button", { type: "button", class: "wz-row", onclick: () => wizardTo(n) }, h("span", { class: "k" }, tr(STEPS[n - 1])), h("span", { class: "v" }, text), h("span", { class: "c" }, "Change"))),
      h("button", { type: "button", class: "btn ghost wz-reset", onclick: () => $("#new-search").click() }, "Start over"));
  }
  function initWizard() {
    const form = $("#form");
    wzHead = h("div", { class: "wz-head" }, h("div", { class: "wz-title" }),
      h("div", { class: "wz-dots" }, STEPS.map((s, i) => h("button", { type: "button", "aria-label": tx("Step {n}: {name}", { n: i + 1, name: tr(s) }), onclick: () => (i + 1 <= at ? wizardTo(i + 1) : next()) }, h("b", {}, i + 1), ` ${tr(s)}`))));
    wzReview = h("div", { class: "wz-review", "data-wstep": "4" });
    wzNav = h("div", { class: "wz-nav" },
      h("button", { type: "button", class: "btn wz-back", onclick: () => wizardTo(at - 1) }, "‹ Back"),
      h("button", { type: "button", class: "btn ghost wz-now", title: "Search with what is filled in now", onclick: () => form.requestSubmit() }, "Search now"),
      h("button", { type: "button", class: "btn primary wz-next", onclick: next }));
    form.prepend(wzHead, wzReview);
    form.after(wzNav);
    form.addEventListener("change", () => { if (at === STEPS.length) drawReview(); });
    const sync = () => { form.classList.toggle("wz", isPhone()); $("#step-panel").classList.toggle("wz-on", isPhone()); };
    query.addEventListener("change", sync);
    sync(); wizardTo(1);   // a fresh load starts at the first step, even with last time's search restored
  }

  // ---------------------------------------------------------------- bottom bar
  let nav;
  function syncNav() {
    if (!nav) return;
    const has = !!$(".m-results");
    $("[data-nav=trips]", nav).disabled = !has; $("[data-nav=days]", nav).disabled = !has;
    $("[data-nav=ask]", nav).hidden = $("#chat-launch").hidden;
    $("[data-nav=trip] b", nav).textContent = $("#tb-count").textContent;
    const formOpen = !$("#step-panel").hidden, tab = has && !formOpen ? $(".m-tabs [aria-selected=true]")?.dataset.tab : null;
    $$("[data-nav]", nav).forEach(b => b.classList.toggle("on", b.dataset.nav === (formOpen ? "search" : tab)));
  }
  function initNav() {
    const go = k => () => { if (!$(".m-results")) return; hideStepPanel(); showTab(k); $("#results").scrollIntoView({ block: "start" }); };
    nav = h("nav", { class: "m-nav", "aria-label": "Skyhop" },
      h("button", { type: "button", "data-nav": "search", onclick: () => { showStep(1); window.scrollTo({ top: 0 }); syncNav(); } }, h("i", { "aria-hidden": "true" }, "🔍"), "Search"),
      h("button", { type: "button", "data-nav": "trips", onclick: go("trips") }, h("i", { "aria-hidden": "true" }, "✈"), "Trips"),
      h("button", { type: "button", "data-nav": "days", onclick: go("days") }, h("i", { "aria-hidden": "true" }, "📅"), "Days"),
      h("button", { type: "button", "data-nav": "ask", onclick: () => $("#chat-launch").click() }, h("i", { "aria-hidden": "true" }, "✨"), "Ask"),
      h("button", { type: "button", "data-nav": "trip", onclick: () => $("#tb-launch").click() }, h("i", { "aria-hidden": "true" }, "🧳"), h("span", { class: "lbl-n" }, "Trip", h("b", {}, "0"))));
    document.body.append(nav);
    // The real launchers stay the source of truth (chat.js shows Ask only when chat works; builder.js keeps the count).
    const watch = new MutationObserver(syncNav);
    watch.observe($("#chat-launch"), { attributes: true, attributeFilter: ["hidden"] });
    watch.observe($("#tb-count"), { childList: true, characterData: true, subtree: true });
    watch.observe($("#step-panel"), { attributes: true, attributeFilter: ["hidden"] });
    watch.observe($("#results"), { childList: true });
    syncNav();
  }

  function init({ onLayoutChange }) {
    initWizard(); initNav();
    addEventListener("popstate", () => closeTrip(false));
    addEventListener("keydown", e => { if (e.key === "Escape" && sheet) closeTrip(); });
    query.addEventListener("change", () => { closeTrip(); onLayoutChange(); });
  }
  return { isPhone, init, results, card, wizardTo, wizardReset, allTrips, topPicks };
})();
