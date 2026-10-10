"use strict";
/* Trip builder ("mix & match"): assemble any legs by hand, pick a flight for each, and see the gap, airport-transfer
   estimate and total between them. Always reachable (floating button + sidebar); saved in localStorage.
   Uses helpers from app.js (h, $, api, post, money, legEnds, ...). All API text goes through textContent via h(). */
const Builder = (() => {
  const KEY = "skyhop.builder";
  let legs = [], editingId = null, check = null, checkSeq = 0, opened = false, els = {};
  const drafts = {}, options = {}, filters = {};
  const uid = () => Math.random().toString(36).slice(2, 9);
  // Legs may have been priced in different currencies: total them in the currency being shown.
  // "₪776" or "₪500 + $80": what the legs cost in the currencies they were searched in (only when that differs from what is shown).
  const originalTotals = fl => {
    const by = {};
    fl.forEach(l => { if (l.flight.priced !== false) by[l.currency] = (by[l.currency] || 0) + l.flight.price; });
    return Object.keys(by).some(c => isConverted(c)) ? Object.entries(by).map(([c, v]) => fmtMoney(v, c)).join(" + ") : "";
  };
  const totalOf = fl => fl.reduce((s, l) => s + (l.flight.priced === false ? 0 : toShown(l.flight.price, l.currency)), 0);
  const flightLegs = () => legs.filter(l => l.flight);
  const save = () => store.set(KEY, { legs });
  const cityOf = code => { const a = airport(code); return a ? a.city : ""; };
  const place = code => `${code}${cityOf(code) ? ` · ${cityOf(code)}` : ""}`;

  // ---------------------------------------------------------------- state
  function addLeg(data = {}) {
    const leg = { id: uid(), from: "", to: "", date: "", flight: null, pax: "", currency: "USD", ...data };
    legs.push(leg); sortLegs(); save(); return leg;
  }
  function sortLegs() { legs.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999")); }
  function removeLeg(id) { legs = legs.filter(l => l.id !== id); delete options[id]; if (editingId === id) editingId = null; save(); runCheck(); render(); }
  function toast(msg) {
    const t = h("div", { class: "toast", role: "status" }, msg); document.body.append(t); setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2600);
  }

  // Called from search results: put an exact flight into the builder.
  function addFlight(view, meta = {}) {
    const first = view.segments[0];
    addLeg({ from: view.origin, to: view.destination, date: first.departs.slice(0, 10), flight: view, pax: meta.pax || "", currency: meta.currency || "USD" });
    afterChange(); toast("Added to Trip builder");
  }
  function addTrip(trip, meta = {}) { trip.legs.forEach(v => addLeg({ from: v.origin, to: v.destination, date: v.segments[0].departs.slice(0, 10), flight: v, pax: meta.pax || "", currency: meta.currency || "USD" })); afterChange(); toast(`Added ${plural(trip.legs.length, "flight")} to Trip builder`); }
  function afterChange() { save(); runCheck(); render(); }

  // ---------------------------------------------------------------- analysis (server owns time zones + transfer estimates)
  async function runCheck() {
    const seq = ++checkSeq, fl = flightLegs();
    if (fl.length < 2) { check = null; render(); return; }
    try {
      const r = await post("/api/itinerary/check", { legs: fl.map(l => l.flight), currency: fl[0].currency || "USD" });
      if (seq === checkSeq) { check = r; render(); }
    } catch (e) { if (seq === checkSeq) { check = { error: e.message }; render(); } }
  }
  const gapBetween = (a, b) => {
    if (!check || check.error) return null;
    const fl = flightLegs(), i = fl.indexOf(a);
    if (i < 0 || fl[i + 1] !== b) return null;   // only when neither is missing a flight in between
    return check.gaps[i] || null;
  };

  // ---------------------------------------------------------------- flight options for one leg
  async function findFlights(leg) {
    const d = drafts[leg.id];
    if (!d.from || !d.to || !d.date) { options[leg.id] = { error: "Pick where from, where to and a date." }; render(); return; }
    Object.assign(leg, { from: d.from, to: d.to, date: d.date });
    options[leg.id] = { loading: true }; render();
    const f = readForm();
    const qs = new URLSearchParams({ origin: d.from, dest: d.to, date: d.date, adults: f.adults, children_ages: f.kids.join(","), currency: f.currency, max_stops: 2 });
    try { options[leg.id] = await api(`/api/flights?${qs}`); }
    catch (e) { options[leg.id] = { error: e.message }; }
    render();
  }
  function choose(leg, flight) {
    const o = options[leg.id] || {};
    Object.assign(leg, { flight, pax: o.travellers || "", currency: o.currency || "USD", from: flight.origin, to: flight.destination });
    editingId = null; sortLegs(); afterChange();
  }
  const filt = id => (filters[id] ||= { sort: "price", nonstop: false, hidden: new Set() });
  function visibleOptions(leg) {
    const o = options[leg.id]; if (!o || !o.flights) return [];
    const f = filt(leg.id);
    const list = o.flights.filter(x => (!f.nonstop || x.stops === 0) && !x.airlines.some(a => f.hidden.has(a)));
    const key = { price: x => (x.priced === false ? Infinity : x.price), time: x => x.duration_min, early: x => legEnds(x).dep.getTime() }[f.sort];
    return list.sort((a, b) => key(a) - key(b));
  }

  // ---------------------------------------------------------------- rendering
  function flightSummary(f, cur) {
    const e = legEnds(f), sh = dayShift(e.dep, e.arr), names = [...new Set(f.segments.map(s => airlineName(s.airline_code, s.airline)))];
    return h("div", { class: "fs" },
      h("div", { class: "fs-times" },
        h("div", {}, h("div", { class: "big" }, fmtTime(e.dep)), h("div", { class: "ap" }, e.from), h("div", { class: "dt" }, fmtDay(e.dep))),
        h("div", { class: "lt-mid" }, h("span", {}, hm(f.duration_min)), h("span", { class: "line", "aria-hidden": "true" }), h("span", {}, f.stops === 0 ? "direct" : plural(f.stops, "stop"))),
        h("div", { class: "r" }, h("div", { class: "big" }, fmtTime(e.arr), sh > 0 ? h("sup", {}, `+${sh}`) : null), h("div", { class: "ap" }, e.to), h("div", { class: "dt" }, fmtDay(e.arr)))),
      h("div", { class: "fs-meta" }, h("span", { class: "fs-air" }, names.join(" · ")), h("span", { class: "fs-codes" }, f.segments.map(s => `${s.airline_code}${s.flight_number}`).join(" + ")),
        f.layovers_min.length ? h("span", { class: "badge ok" }, f.layovers_min.map((m, i) => `${hm(m)} in ${f.segments[i].destination}`).join(", ")) : null),
      cur ? h("div", { class: "fs-price" + (f.priced === false ? " np" : "") }, f.priced === false ? "No price shown" : money(f.price, cur), f.priced === false ? null : origNote(f.price, cur, "orig block")) : null);
  }

  function gapBlock(g) {
    if (!g) return h("div", { class: "gap idle" }, "Pick a flight for both legs to check the time between them.");
    const label = { ok: "OK", tight: "Tight", impossible: "Not enough time" }[g.status];
    return h("div", { class: `gap ${g.status}` },
      h("div", { class: "gap-h" }, h("span", { class: "pill" }, label), h("span", {}, g.headline)),
      g.detail ? h("div", { class: "gap-d" }, g.detail) : null,
      h("div", { class: "gap-m" }, h("span", {}, `⏱ ${g.gap_text}`),
        g.transfer_min != null ? h("span", {}, `🚕 ~${g.transfer_min} min between airports (estimate)`) : null,
        g.needed_min != null && g.gap_min < 1440 ? h("span", {}, `needs ≥ ${hm(g.needed_min)}`) : null,
        g.arrive_airport !== g.depart_airport ? h("span", {}, `${g.arrive_airport} → ${g.depart_airport}`) : null));
  }

  function editor(leg) {
    const d = (drafts[leg.id] ||= { from: leg.from, to: leg.to, date: leg.date });
    const fromBox = h("div", { class: "ac" }), toBox = h("div", { class: "ac" });
    const fromAc = autocomplete(fromBox, { id: `tb-from-${leg.id}`, placeholder: "From…", multi: false, onChange: () => { d.from = fromAc.get()[0] || ""; } });
    const toAc = autocomplete(toBox, { id: `tb-to-${leg.id}`, placeholder: "To…", multi: false, onChange: () => { d.to = toAc.get()[0] || ""; } });
    fromAc.set(d.from ? [d.from] : []); toAc.set(d.to ? [d.to] : []);
    const date = h("input", { type: "date", value: d.date, "aria-label": "Date", onchange: e => { d.date = e.target.value; } });
    const o = options[leg.id];
    return h("div", { class: "tb-edit" },
      h("div", { class: "tb-fields" },
        h("div", { class: "field" }, h("label", {}, "From"), fromBox), h("div", { class: "field" }, h("label", {}, "To"), toBox),
        h("div", { class: "field" }, h("label", {}, "Date"), h("div", { class: "input" }, date)),
        h("button", { type: "button", class: "btn primary small-primary", onclick: () => findFlights(leg) }, "Find flights")),
      o ? optionsList(leg, o) : h("div", { class: "hint" }, "Choose the route and date, then find flights."));
  }

  function optionsList(leg, o) {
    if (o.loading) return h("div", { class: "tb-loading" }, h("span", { class: "plane", "aria-hidden": "true" }, "✈️"), "Looking for flights…");
    if (o.error) return h("div", { class: "note bad" }, o.error);
    const f = filt(leg.id), airlines = new Map();
    o.flights.forEach(x => x.segments.forEach(s => airlines.set(s.airline_code, airlineName(s.airline_code, s.airline))));
    const list = visibleOptions(leg);
    return h("div", { class: "tb-opts" },
      h("div", { class: "tb-opt-tools" },
        h("select", { class: "input mini", "aria-label": "Sort", onchange: e => { f.sort = e.target.value; render(); } },
          [["price", "Cheapest first"], ["time", "Fastest first"], ["early", "Earliest first"]].map(([v, t]) => h("option", { value: v, selected: f.sort === v }, t))),
        h("label", { class: "switch mini-sw" }, h("input", { type: "checkbox", checked: f.nonstop, onchange: e => { f.nonstop = e.target.checked; render(); } }), "Nonstop only")),
      h("div", { class: "tb-air" }, [...airlines].map(([code, name]) => h("button", { type: "button", class: "pill" + (f.hidden.has(code) ? " off" : ""), "aria-pressed": String(!f.hidden.has(code)),
        title: f.hidden.has(code) ? "Excluded: click to include" : "Click to exclude", onclick: () => { f.hidden.has(code) ? f.hidden.delete(code) : f.hidden.add(code); render(); } }, name))),
      h("div", { class: "hint" }, `${plural(list.length, "flight")} · ${o.travellers} · prices are totals`),
      list.length ? list.map((x, i) => h("button", { type: "button", class: "opt", onclick: () => choose(leg, x) }, flightSummary(x, o.currency),
        i === 0 && f.sort === "price" ? h("span", { class: "badge ok tag" }, "cheapest") : null)) : h("div", { class: "note" }, "No flights match these filters."));
  }

  function legBlock(leg, i) {
    const editing = editingId === leg.id;
    return h("div", { class: "tb-leg" + (editing ? " editing" : "") },
      h("div", { class: "tb-leg-h" },
        h("span", { class: "num" }, i + 1),
        h("div", { class: "route" }, `${leg.from ? place(leg.from) : "Where from?"} → ${leg.to ? place(leg.to) : "Where to?"}`, h("small", {}, leg.date ? fmtDay(day(leg.date)) : "No date yet")),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn small", onclick: () => { editingId = editing ? null : leg.id; delete drafts[leg.id]; render(); } }, editing ? "Close" : leg.flight ? "Change" : "Pick a flight"),
          h("button", { type: "button", class: "btn small ghost", "aria-label": `Remove leg ${i + 1}`, onclick: () => removeLeg(leg.id) }, "✕"))),
      leg.flight && !editing ? h("div", { class: "tb-chosen" }, flightSummary(leg.flight, leg.currency),
        h("div", { class: "actions" }, airlinesOfSegments(leg.flight.segments).map(([code, name, segs]) => siteButton(code, name, segs)), (leg.flight.deep_links || []).map((u, k) => h("a", { class: "btn small", href: u, target: "_blank", rel: "noopener noreferrer" }, leg.flight.deep_links.length > 1 ? `Google Flights · ticket ${k + 1} ↗` : "Google Flights ↗")))) : null,
      editing ? editor(leg) : null);
  }

  function summaryText() {
    const fl = flightLegs(), pax = [...new Set(fl.map(l => l.pax).filter(Boolean))];
    const lines = [`Skyhop trip${pax.length ? ` · ${pax.join(" / ")}` : ""} · total ${fmtMoney(totalOf(fl), displayCurrency)}${originalTotals(fl) ? ` (originally ${originalTotals(fl)})` : ""}${fl.some(l => l.flight.priced === false) ? " + unpriced flight(s)" : ""}`];
    fl.forEach((l, i) => {
      const f = l.flight, e = legEnds(f);
      lines.push(`${i + 1}) ${fmtDay(e.dep)}  ${e.from} ${fmtTime(e.dep)} → ${e.to} ${fmtTime(e.arr)}  ${[...new Set(f.segments.map(s => airlineName(s.airline_code, s.airline)))].join(" + ")} ${f.segments.map(s => s.airline_code + s.flight_number).join("+")}  ${f.priced === false ? "price not shown" : money(f.price, l.currency)}`);
      const g = fl[i + 1] ? gapBetween(l, fl[i + 1]) : null;
      if (g) lines.push(`   ↳ ${g.headline}${g.detail ? " " + g.detail : ""}`);
    });
    return lines.join("\n");
  }

  function render() {
    if (!els.body) return;
    const fl = flightLegs(), total = totalOf(fl), unp = fl.filter(l => l.flight.priced === false).length;
    $("#tb-count").textContent = fl.length; $("#tb-launch").classList.toggle("has", fl.length > 0);
    const body = [];
    if (!legs.length) {
      const f = readForm(), canStart = f.from[0] && f.to[0] && f.start;
      body.push(h("div", { class: "tb-intro" },
        h("h3", {}, "Build your own trip"),
        h("p", {}, "Pick any flight for any leg: Wizz out on one day, El Al back on another, or land in Rome and leave from a different airport. Skyhop checks the time between flights and any airport transfer."),
        h("div", { class: "actions" },
          canStart ? h("button", { type: "button", class: "btn primary small-primary", onclick: () => {
            const back = new Date(day(f.start)); back.setDate(back.getDate() + Math.max(1, f.nmin || 4));
            const a = addLeg({ from: f.from[0], to: f.to[0], date: f.start }), b = addLeg({ from: f.to[0], to: f.from[0], date: iso(back) });
            editingId = a.id; render(); } }, `Round trip ${f.from[0]} ⇄ ${f.to[0]} from my search`) : null,
          h("button", { type: "button", class: "btn", onclick: () => { const l = addLeg({ from: f.from[0] || "" }); editingId = l.id; render(); } }, "Start with an empty leg"))));
    }
    legs.forEach((leg, i) => {
      body.push(legBlock(leg, i));
      if (legs[i + 1]) body.push(gapBlock(gapBetween(leg, legs[i + 1])));
    });
    if (legs.length) {
      const last = legs[legs.length - 1];
      body.push(h("button", { type: "button", class: "btn add-leg", onclick: () => {
        const l = addLeg({ from: last.flight ? last.flight.destination : last.to, to: legs[0].from || "", date: last.date ? (() => { const d = new Date(day(last.date)); d.setDate(d.getDate() + 3); return iso(d); })() : "" });
        editingId = l.id; render();
      } }, "＋ Add another leg"));
    }
    if (check && check.error) body.push(h("div", { class: "note bad" }, `Could not check the gaps: ${check.error}`));
    els.body.replaceChildren(...body);
    const pax = [...new Set(fl.map(l => l.pax).filter(Boolean))];
    els.foot.replaceChildren(
      h("div", { class: "tb-total" }, h("div", { class: "k" }, `Total for ${plural(fl.length, "flight")}`), h("div", { class: "v" }, fl.length ? fmtMoney(total, displayCurrency) : "—"),
        originalTotals(fl) ? h("div", { class: "pax" }, `originally ${originalTotals(fl)}`) : null,
        unp ? h("div", { class: "pax" }, `+ ${plural(unp, "flight")} with no price shown: check the airline's site`) : null,
        pax.length ? h("div", { class: "pax" }, pax.join(" / ") + (pax.length > 1 ? " (legs priced for different travellers!)" : "")) : null),
      check && !check.error && check.warnings.length ? h("div", { class: "warn info" }, h("span", { "aria-hidden": "true" }, "ℹ"), check.warnings[0]) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn small accent hub-save", disabled: !fl.length, title: "Put these flights on your trip in Travel Hub", onclick: () => saveToHub(fl.map(l => ({ ...l.flight, currency: l.currency }))) }, hubLabel()),
        h("button", { type: "button", class: "btn small", disabled: !fl.length, onclick: async () => { try { await navigator.clipboard.writeText(summaryText()); toast("Trip summary copied"); } catch { toast("Could not copy"); } } }, "Copy summary"),
        h("button", { type: "button", class: "btn small ghost", disabled: !legs.length, onclick: () => { if (confirm("Remove all legs from the Trip builder?")) { legs = []; check = null; editingId = null; save(); render(); } } }, "Clear all")));
  }

  // ---------------------------------------------------------------- open / close
  function open() {
    opened = true; $("#tb").hidden = false; $("#tb-scrim").hidden = false; $("#tb-launch").setAttribute("aria-expanded", "true");
    void $("#tb").offsetWidth;            // force layout so the slide-in transition runs (no rAF: it pauses in background tabs)
    $("#tb").classList.add("open"); render(); $("#tb-close").focus();
  }
  function close() {
    opened = false; $("#tb").classList.remove("open"); $("#tb-scrim").hidden = true; $("#tb-launch").setAttribute("aria-expanded", "false");
    setTimeout(() => { if (!opened) $("#tb").hidden = true; }, 220); $("#tb-launch").focus();
  }
  function init() {
    const v = store.get(KEY);
    if (v && Array.isArray(v.legs)) legs = v.legs.filter(l => l && l.id && l.from && l.to);
    els = { body: $("#tb-body"), foot: $("#tb-foot") };
    $("#tb-launch").addEventListener("click", () => (opened ? close() : open()));
    $$(".open-builder").forEach(b => b.addEventListener("click", () => { closeSidebar(); open(); }));
    $("#tb-close").addEventListener("click", close); $("#tb-scrim").addEventListener("click", close);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && opened) close(); });
    render(); runCheck();
  }
  // Open the builder on one route and day, with every flight listed (including those without a price).
  function browse(from, to, date) {
    const leg = addLeg({ from, to, date });
    drafts[leg.id] = { from, to, date };
    editingId = leg.id;
    open();
    findFlights(leg);
  }
  return { init, open, close, addFlight, addTrip, browse, refresh: () => render() };
})();
