"use strict";
/* Mix & match on the main page: every outbound flight on the selected day and every return flight on a chosen day,
   any outbound with any return. Lists come from /api/searches/{id}/flights (the cache the search filled), bag-fee
   estimates from /api/searches/{id}/bagfees (only where Google has fee data). Helpers come from app.js. */
const MixMatch = (() => {
  // Airline filtering here is the ONE shared filter (rail Step 2 in index.html), same as everywhere
  // else in the app -- no separate local hide-list. S.showAll is the one deliberate, clearly-labeled
  // escape hatch (peek at what the filter is hiding), not a second filter system.
  let S = { key: "", showAll: false, filters: { sort: "price", nonstop: false } };
  const labelOf = f => f.segments.map(s => `${s.airline_code}${s.flight_number}`).join("+");
  const sameFlight = (a, b) => a && b && labelOf(a) === labelOf(b) && a.segments[0].departs === b.segments[0].departs;
  const lk = (o, d, date) => `${o}>${d}|${date}`;
  // Lists differ with/without the showAll bypass AND with the shared airline filter itself (Step 2
  // in the rail) -- include its signature so a filter change (same day, no key change) invalidates
  // the cache instead of silently showing flights fetched under the previous filter.
  const filterSig = q => (q ? `${(q.airlines_include || []).join(",")}>${(q.airlines_exclude || []).join(",")}` : "");
  const lkl = (o, d, date) => lk(o, d, date) + (S.showAll ? "|all" : "") + "|" + filterSig(S.q);

  function route(trip) {
    if (trip.kind === "open_jaw") { const [a, b] = trip.destination.split("→"); return { dest: a, back: b }; }
    if (trip.kind === "multi_stop") { const [a, b] = trip.destination.split("+"); return { dest: a, back: b }; }
    return { dest: trip.destination, back: trip.destination };
  }

  function render(host, ctx) {
    const { row, q, trip } = ctx;
    if (!trip) { host.replaceChildren(h("div", { class: "note" }, "Pick a day on the chart to see every flight for it.")); return; }
    const key = `${row.id}|${ctx.outDate}`;
    if (S.key !== key) {
      const r = route(trip);
      S = { ...S, key, row, q, dest: r.dest, back: r.back, retDate: trip.return_date, out: null, ret: null, lists: {}, fees: {}, check: null, pre: trip };
    }
    // row/q refresh on every render, not just when the day changes -- the shared airline filter
    // (rail Step 2) can change without the selected day changing, and S.row/S.q must reflect that
    // immediately (lkl() above already invalidates the affected list cache entries).
    S.row = row; S.q = q; S.ctx = ctx; S.cur = q.currency;
    draw(host);
  }

  function ensure(host, o, d, date) {
    const k = lkl(o, d, date);
    if (S.lists[k]) return S.lists[k];
    S.lists[k] = { loading: true };
    const start = S.key;
    api(`/api/searches/${S.row.id}/flights?${new URLSearchParams({ origin: o, dest: d, date, ...(S.showAll ? { all: 1 } : {}) })}`)
      .then(r => { S.lists[k] = r; }).catch(e => { S.lists[k] = { error: e.message }; })
      .finally(() => { if (S.key === start) draw(host); });
    return S.lists[k];
  }

  async function loadFees(host, o, d, date) {
    const k = lk(o, d, date), start = S.key;
    S.fees[k] = { loading: true }; draw(host);
    try { S.fees[k] = await api(`/api/searches/${S.row.id}/bagfees?${new URLSearchParams({ origin: o, dest: d, date })}`); }
    catch (e) { S.fees[k] = { error: e.message }; }
    if (S.key === start) draw(host);
  }

  function visible(list) {
    const f = S.filters, sort = { price: x => (x.priced === false ? Infinity : x.price), time: x => x.duration_min, early: x => legEnds(x).dep.getTime() }[f.sort];
    return list.flights.filter(x => !f.nonstop || x.stops === 0).sort((a, b) => sort(a) - sort(b));
  }

  function bagChips(f, fees) {
    const chips = [], note = (config.bag_notes || {})[f.segments[0].airline_code];
    const e = fees && fees.fees ? fees.fees[labelOf(f)] : null;
    if (e && fees.available) {
      // 0 means "Google added nothing": the bag may be included, or Google has no fee for it. Never show that as "free".
      for (const [name, v] of [["cabin bag", e.cabin], ["checked bag", e.checked]]) {
        chips.push(v > 0 ? h("span", { class: "bag" }, `🧳 ${name} +${money(v, fees.currency)}`)
          : h("span", { class: "bag dim", title: "Google added no fee for this bag: it may be included in the fare, or Google may have no fee data for this airline. Check the airline's baggage page." }, `🧳 ${name}: no estimate`));
      }
    }
    if (note) chips.push(h("span", { class: "bag dim", title: `${note} General policy from published summaries, not from Google and not per fare: confirm on the airline's site.` }, `🧳 ${(config.bag_short || {})[f.segments[0].airline_code] || "bags usually extra"}`));
    return chips;
  }

  // "Check on <airline> site": the airline's own site, to confirm the fare and bags (readable 44px button, docs/stitch/DESIGN.md).
  const siteLinks = f => airlinesOfSegments(f.segments).map(([code, name, segs]) => siteButton(code, name, segs));   // every airline, known or new
  function row(f, cur, picked, onPick, fees) {
    const e = legEnds(f), sh = dayShift(e.dep, e.arr), names = [...new Set(f.segments.map(s => airlineName(s.airline_code, s.airline)))];
    // Auto-select on the airline's own site (browser-extension/), whichever direction this leg flies (assistFor knows which origins each
    // airline's driver actually supports). The row itself needs to stay clickable for "pick this flight", so this is a real nested <button> --
    // that means the row can no longer be a <button> itself (invalid HTML), hence role="button" below.
    const autoCode = extensionAvailable() ? [...new Set(f.segments.map(sg => sg.airline_code))].find(code => assistFor(code, f.segments)) : null;
    const autoSearch = autoCode ? assistFor(autoCode, f.segments) : null;
    const autoSeg = autoCode ? f.segments.find(sg => sg.airline_code === autoCode) : null;
    return h("div", { class: "mm-row" + (picked ? " picked" : ""), role: "button", tabindex: "0", "aria-pressed": String(!!picked),
        onclick: onPick, onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPick(); } } },
      h("div", { class: "mm-times" }, h("b", {}, fmtTime(e.dep)), h("span", { class: "ap" }, e.from), h("span", { class: "arrow" }, "→"), h("b", {}, fmtTime(e.arr), sh > 0 ? h("sup", {}, `+${sh}`) : null), h("span", { class: "ap" }, e.to)),
      h("div", { class: "mm-meta" }, h("span", { class: "mm-air" }, names.join(" · ")), h("span", { class: "mm-code" }, f.segments.map(s => `${s.airline_code}${s.flight_number}`).join(" + ")),
        h("span", {}, `${hm(f.duration_min)} · ${f.stops === 0 ? "direct" : plural(f.stops, "stop")}`),
        f.layovers_min.length ? h("span", { class: "badge ok" }, f.layovers_min.map((m, i) => `${hm(m)} in ${f.segments[i].destination}`).join(", ")) : null),
      h("div", { class: "mm-bags" }, bagChips(f, fees)),
      h("div", { class: "mm-price" }, f.priced === false ? h("span", { class: "np" }, "No price shown") : [money(f.price, cur), origNote(f.price, cur, "orig block")]),
      siteLinks(f).length || autoSeg ? h("div", { class: "mm-actions" }, siteLinks(f), autoSeg ? h("button", { type: "button", class: "btn small accent", title: "Opens a new tab, searches and selects this flight on the airline's own site (you finish the booking there)",
        onclick: ev => { ev.stopPropagation(); autoSearch(); } },
        `✈ Select ${autoSeg.airline_code}${autoSeg.flight_number} on site ↗`) : null) : null);
  }

  function column(host, title, o, d, date, kind) {
    const list = ensure(host, o, d, date), k = lk(o, d, date), fees = S.fees[k];
    const head = h("div", { class: "mm-head" }, h("div", {}, h("div", { class: "mm-title" }, title), h("div", { class: "mm-sub" }, `${fmtDay(day(date))} · ${o} → ${d}`)),
      h("button", { type: "button", class: "btn small", disabled: !!(fees && fees.loading), title: "Asks Google what it would add for a cabin bag and a checked bag. Only available where Google has fee data.",
        onclick: () => loadFees(host, o, d, date) }, fees && fees.loading ? "Checking bags…" : fees && fees.fees ? "Bag fees ✓" : "Show bag fees"));
    let body;
    if (list.loading) body = h("div", { class: "tb-loading" }, h("span", { class: "plane", "aria-hidden": "true" }, "✈️"), "Loading flights…");
    else if (list.error) body = h("div", { class: "note bad" }, list.error);
    else {
      const items = visible(list);
      if (kind === "out" && !S.out && S.pre) S.out = list.flights.find(f => sameFlight(f, S.pre.legs[0])) || null;
      if (kind === "ret" && !S.ret && S.pre && date === S.pre.return_date) S.ret = list.flights.find(f => sameFlight(f, S.pre.legs[S.pre.legs.length - 1])) || null;
      const cur = S.cur;
      body = h("div", { class: "mm-list" }, items.length ? items.map(f => row(f, cur, sameFlight(f, kind === "out" ? S.out : S.ret), () => { S[kind] = sameFlight(f, S[kind]) ? null : f; S.check = null; draw(host); }, fees)) : h("div", { class: "note" }, "No flights match these filters."));
    }
    const noData = fees && fees.fees && !fees.available ? h("div", { class: "note" }, "Google has no bag-fee estimates for this route (common outside the US and Europe). A bag may still cost extra: check the airline's baggage page before booking.") : null;
    const errNote = fees && fees.error ? h("div", { class: "note bad" }, fees.error) : null;
    return h("div", { class: "mm-col" }, head, noData, errNote, body);
  }

  function summary(host) {
    const { out, ret } = S, cur = S.cur;
    if (!out || !ret) return h("div", { class: "mm-sum idle" }, out || ret ? "Pick the other flight to see the total and the time between them." : "Pick an outbound and a return flight.");
    const priced = [out, ret].filter(f => f.priced !== false), total = priced.reduce((s, f) => s + toShown(f.price, cur), 0), orig = priced.reduce((s, f) => s + f.price, 0);
    if (!S.check) {
      const start = S.key, pair = [out, ret];
      S.check = { loading: true };
      post("/api/itinerary/check", { legs: pair, currency: cur }).then(r => { if (S.key === start && S.out === pair[0] && S.ret === pair[1]) S.check = r; }).catch(() => { S.check = { error: true }; }).finally(() => { if (S.key === start) draw(host); });
    }
    const g = S.check && S.check.gaps ? S.check.gaps[0] : null;
    const label = f => `${[...new Set(f.segments.map(s => airlineName(s.airline_code, s.airline)))].join("+")} ${tmShort(f)}`;
    return h("div", { class: "mm-sum" },
      h("div", { class: "mm-total" }, h("div", { class: "k" }, "Your combination"), h("div", { class: "v" }, fmtMoney(total, shownCur(cur)), isConverted(cur) ? h("small", { class: "orig block" }, `originally ${fmtMoney(orig, cur)}`) : null),
        priced.length < 2 ? h("div", { class: "pax" }, "One flight has no price shown: check the airline's site") : null),
      h("div", { class: "mm-pick" }, h("div", {}, h("b", {}, "Out "), label(out)), h("div", {}, h("b", {}, "Back "), label(ret)),
        g ? h("div", { class: `gap ${g.status}` }, h("div", { class: "gap-h" }, h("span", { class: "pill" }, { ok: "OK", tight: "Tight", impossible: "Not enough time" }[g.status]), h("span", {}, g.headline)), g.detail ? h("div", { class: "gap-d" }, g.detail) : null) : null),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn small", onclick: () => { Builder.addFlight(out, { pax: S.ctx.paxLabel, currency: cur }); Builder.addFlight(ret, { pax: S.ctx.paxLabel, currency: cur }); } }, "＋ Add both to Trip builder"),
        (out.deep_links || []).slice(0, 1).map(u => h("a", { class: "btn small", href: u, target: "_blank", rel: "noopener noreferrer" }, "Google Flights (out) ↗")),
        (ret.deep_links || []).slice(0, 1).map(u => h("a", { class: "btn small", href: u, target: "_blank", rel: "noopener noreferrer" }, "Google Flights (back) ↗"))));
  }

  function draw(host) {
    const { q, ctx } = S, retFroms = [...new Set([...q.destinations, ...(q.return_airports || [])])];
    const outDate = ctx.outDate, minRet = addDays(outDate, q.min_nights), maxRet = addDays(outDate, q.max_nights);
    const retDates = []; for (let d = minRet; d <= maxRet && d <= q.window_end; d = addDays(d, 1)) retDates.push(d);
    if (!retDates.includes(S.retDate)) retDates.push(S.retDate);
    retDates.sort();
    const select = (opts, value, onChange, label) => h("select", { class: "input mini", "aria-label": label, onchange: e => onChange(e.target.value) }, opts.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
    const F = S.filters;
    const controls = h("div", { class: "mm-controls" },
      q.destinations.length > 1 ? h("label", {}, "Fly out to ", select(q.destinations.map(d => [d, d]), S.dest, v => { S.dest = v; S.out = null; S.check = null; draw(host); }, "Destination")) : null,
      h("label", {}, "Outbound day ", select((ctx.days || [outDate]).map(d => [d, fmtDay(day(d))]), outDate, v => ctx.onPickDay(v), "Outbound day")),
      retFroms.length > 1 ? h("label", {}, "Fly home from ", select(retFroms.map(d => [d, d]), S.back, v => { S.back = v; S.ret = null; S.check = null; draw(host); }, "Return airport")) : null,
      h("label", {}, "Return day ", select(retDates.map(d => [d, `${fmtDay(day(d))} · ${tripLen(Math.round((day(d) - day(outDate)) / 864e5))}`]), S.retDate, v => { S.retDate = v; S.ret = null; S.check = null; draw(host); }, "Return day")));
    const filters = h("div", { class: "mm-filters" },
      select([["price", "Cheapest first"], ["time", "Fastest first"], ["early", "Earliest first"]], F.sort, v => { F.sort = v; draw(host); }, "Sort"),
      h("label", { class: "switch mini-sw" }, h("input", { type: "checkbox", checked: F.nonstop, onchange: e => { F.nonstop = e.target.checked; draw(host); } }), "Nonstop only"));
    const cols = h("div", { class: "mm-cols" }, column(host, "Outbound", q.origin, S.dest, outDate, "out"), column(host, "Return", S.back, q.origin, S.retDate, "ret"));
    const inc = q.airlines_include || [], exc = q.airlines_exclude || [], nameOf = c => (config.airlines || {})[c] || c;
    const hidden = [lkl(q.origin, S.dest, outDate), lkl(S.back, q.origin, S.retDate)].reduce((n, k) => n + ((S.lists[k] || {}).hidden_by_filter || 0), 0);
    // The one deliberate escape hatch from the shared filter (rail Step 2) -- a real .switch, not
    // a pill that could be mistaken for a second filter control.
    const banner = inc.length || exc.length ? h("div", { class: "note af-banner" },
      h("label", { class: "switch mini-sw" }, h("input", { type: "checkbox", checked: S.showAll, onchange: e => { S.showAll = e.target.checked; draw(host); } }), "Ignore my airline filter for this comparison"),
      S.showAll ? " Showing every airline, including ones your filter removes from the results above."
        : ` Airline filter on (${inc.length ? "only " + inc.map(nameOf).join(", ") : "excluding " + exc.map(nameOf).join(", ")}, set in Step 2 on the left). ${hidden ? `${plural(hidden, "flight")} from other airlines ${hidden === 1 ? "is" : "are"} hidden here.` : "Nothing is hidden on these days."}`) : null;
    host.replaceChildren(...[banner, controls, filters, cols, summary(host)].filter(Boolean));
  }
  return { render };
})();
