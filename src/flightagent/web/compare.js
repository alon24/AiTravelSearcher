"use strict";
/* Compare: "what does each destination cost for each trip length?"
   One search can cover 4, 5 and 6 nights to Rome, Paris and London, so a single "cheapest trip" hides the choices. This draws
   (a) a matrix, trip length x destination, each cell the best total for that pair (heat-tinted, click one or more to filter), and
   (b) a table of trips, grouped by trip length by default (a band per length, every destination under it), with filters, group-by,
   sort and a nonstop switch. Data: res.cells (best trip per destination x nights, from the server) and res.daily (cheapest per day).
   Design: docs/stitch/DESIGN.md, "Results screen rules". Uses app.js globals (h, money, fmtDay, fmtTime, day, hm, plural, tripCard...). */
const Compare = (() => {
  const MAX_LENGTH_ROWS = 12;                        // a wide length range would make a 30-row matrix: keep the 12 cheapest lengths
  const CELL = (dest, n) => `${dest}|${n}`;

  const nameOfCode = (code, s) => airlineName(code, s.airline);
  // Airlines of a trip, in flight order: [[code, name], ...]
  const airlinesOf = t => [...new Map(t.legs.flatMap(l => l.segments).map(s => [s.airline_code, nameOfCode(s.airline_code, s)])).entries()];
  const legNames = leg => [...new Map(leg.segments.map(s => [s.airline_code, nameOfCode(s.airline_code, s)])).values()];
  const lenWord = n => (unit === "days" ? plural(n + 1, "day") : plural(n, "night"));   // `unit` is app.js's nights/days switch
  const heat = (p, lo, hi) => (hi > lo ? (p - lo) / (hi - lo) : 0);

  function toggle(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

  function chipGroup(label, all, options, set, colorOf, onChange) {
    const btn = (text, active, onclick, dot) => h("button", { type: "button", class: "cmp-chip" + (active ? " on" : ""), "aria-pressed": String(active), onclick },
      dot ? h("i", { style: `background:${dot}`, "aria-hidden": "true" }) : null, text);
    return h("div", { class: "cmp-chips", role: "group", "aria-label": label },
      btn(all, set.size === 0, () => { set.clear(); onChange(); }),
      options.map(o => btn(o.text, set.has(o.value), () => { toggle(set, o.value); onChange(); }, o.dot)));
  }
  function segmented(label, options, value, onPick) {
    return h("div", { class: "cmp-seg", role: "group", "aria-label": label },
      options.map(([v, text]) => h("button", { type: "button", "aria-pressed": String(value === v), onclick: () => onPick(v) }, text)));
  }

  function legInfo(leg) {
    const e = legEnds(leg), sh = dayShift(e.dep, e.arr);
    return h("div", { class: "cmp-leg" },
      h("div", { class: "cmp-times" }, `${fmtTime(e.dep)} → ${fmtTime(e.arr)}`, sh > 0 ? h("sup", {}, `+${sh}`) : null),
      h("div", { class: "cmp-air" }, h("b", {}, legNames(leg).join(" + ")), h("span", { class: "code" }, leg.segments.map(s => `${s.airline_code}${s.flight_number}`).join(" + "))));
  }

  // "Check on <airline> site": one readable button per airline in the trip (siteButton in app.js: the extension's search, the airline's site,
  // or a Google search for an airline we have no address for).
  function siteButtons(t) {
    return h("div", { class: "cmp-actions" }, airlinesOfSegments(t.legs.flatMap(l => l.segments)).map(([code, name, segs]) => siteButton(code, name, segs)));
  }

  function render(host, { res, q, cur, pax, state }) {
    const st = state;                                                   // kept by the caller so a re-render keeps your choices
    st.sel ||= new Set(); st.dests ||= new Set(); st.lens ||= new Set();
    st.group ||= "length"; st.show ||= "best"; st.sort ||= "price"; st.nonstop ||= false; st.open ||= new Set(); st.combos ||= false;
    const allCells = res.cells || [], daily = res.daily || [];
    // A search also builds open-jaw / multi-city combinations (ROM→PAR ...). They are extra columns nobody asked for by name, so they are
    // hidden unless switched on; the "best" column and the switch's count still tell you when one of them is the cheapest.
    const isCombo = t => t.kind !== "round_trip";
    const comboCells = allCells.filter(c => isCombo(c.cheapest)).length;
    const showCombos = st.combos || comboCells === allCells.length;
    const cells = showCombos ? allCells : allCells.filter(c => !isCombo(c.cheapest));
    const order = destOrder(q, daily);
    const colorOf = label => { const i = order.indexOf(label); return `var(--series-${i >= 0 && i < 8 ? i + 1 : "other"})`; };
    const present = [...new Set(cells.map(c => c.destination))].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
    const byKey = new Map(cells.map(c => [CELL(c.destination, c.nights), c]));
    let lens = [...new Set(cells.map(c => c.nights))].sort((a, b) => a - b);
    let lensNote = "";
    if (lens.length > MAX_LENGTH_ROWS) {
      const bestOf = n => Math.min(...cells.filter(c => c.nights === n).map(c => c.cheapest.price));
      const keep = new Set([...lens].sort((a, b) => bestOf(a) - bestOf(b)).slice(0, MAX_LENGTH_ROWS));
      lensNote = tx("Showing the {n} cheapest of {m} trip lengths. Use the length chips below to look at any other.", { n: MAX_LENGTH_ROWS, m: lens.length });
      lens = lens.filter(n => keep.has(n));
    }
    const shown = cells.filter(c => lens.includes(c.nights));
    const lo = Math.min(...shown.map(c => c.cheapest.price)), hi = Math.max(...shown.map(c => c.cheapest.price));
    const lowest = shown.reduce((a, b) => (b.cheapest.price < a.cheapest.price ? b : a));

    const matrixHost = h("div", { class: "cmp-matrix-wrap" });
    const tableHost = h("div", { class: "cmp-table-wrap" });
    host.replaceChildren(
      h("div", { class: "card panel cmp-card" },
        h("div", { class: "panel-head" }, h("div", {}, h("h3", {}, "Compare destinations and trip lengths"),
          h("p", {}, "Best total for each trip length and destination. Click one or more cells to filter the list below; click again to clear.")),
          h("div", { class: "cmp-legend", "aria-hidden": "true" }, "Lowest price", h("i", { class: "h0" }), h("i", { class: "h1" }), h("i", { class: "h2" }), h("i", { class: "h3" }), "Higher price")),
        comboCells && comboCells < allCells.length ? h("label", { class: "cmp-check cmp-combos" }, h("input", { type: "checkbox", checked: st.combos,
          onchange: e => { st.combos = e.target.checked; st.dests.clear(); st.sel.clear(); render(host, { res, q, cur, pax, state: st }); } }),
          tx("Also show open-jaw and multi-city combinations ({n})", { n: comboCells })) : null,
        matrixHost, lensNote ? h("div", { class: "note" }, lensNote) : null),
      h("div", { class: "card panel cmp-card" }, tableHost));

    function drawMatrix() {
      const head = h("div", { class: "cmp-row cmp-head", style: `--cols:${present.length}` },
        h("div", { class: "cmp-rh" }, "Trip length"), h("div", { class: "cmp-best-h" }, "Any destination (best)"),
        present.map(d => h("div", { class: "cmp-ch" }, h("i", { style: `background:${colorOf(d)}`, "aria-hidden": "true" }), d)));
      const rows = lens.map(n => {
        const rowCells = present.map(d => byKey.get(CELL(d, n)));
        const best = allCells.filter(c => c.nights === n).reduce((a, b) => (b.cheapest.price < a.cheapest.price ? b : a));   // over EVERYTHING, combos included
        return h("div", { class: "cmp-row", style: `--cols:${present.length}` },
          h("div", { class: "cmp-rh" }, h("b", {}, lenWord(n)), h("span", {}, tx("from {p}", { p: money(best.cheapest.price, cur) }))),
          h("div", { class: "cmp-best" }, h("b", {}, money(best.cheapest.price, cur)), h("span", {}, `${best.destination}${isCombo(best.cheapest) ? ` ${tr("(open-jaw)")}` : ""} · ${airlinesOf(best.cheapest).map(a => a[1]).slice(0, 2).join(" / ")}`)),
          rowCells.map((c, i) => {
            if (!c) return h("div", { class: "cmp-cell empty" }, h("span", {}, "no trip"));
            const t = c.cheapest, key = CELL(c.destination, c.nights), on = st.sel.has(key);
            return h("button", { type: "button", class: "cmp-cell" + (on ? " sel" : "") + (c === lowest ? " lowest" : ""), "aria-pressed": String(on),
              style: `--heat:${heat(t.price, lo, hi).toFixed(3)}`, title: tx("{dest} · {len} · {n} compared", { dest: present[i], len: lenWord(c.nights), n: plural(c.trips, "trip") }),
              onclick: () => { toggle(st.sel, key); drawMatrix(); drawTable(); } },
              h("span", { class: "p" }, money(t.price, cur), c === lowest ? h("em", {}, "lowest") : null),
              h("span", { class: "a" }, airlinesOf(t).map(a => a[1]).slice(0, 2).join(" / "), ` · ${stopsText(t.stops)}`),
              h("span", { class: "d" }, fmtDay(day(t.depart_date))));
          }));
      });
      matrixHost.replaceChildren(head, ...rows);
    }

    function candidateRows() {
      let rows = st.show === "best" ? cells.map(c => c.cheapest) : daily.map(d => d.cheapest).filter(t => showCombos || !isCombo(t));
      if (st.dests.size) rows = rows.filter(t => st.dests.has(t.destination));
      if (st.lens.size) rows = rows.filter(t => st.lens.has(t.nights));
      if (st.sel.size) rows = rows.filter(t => st.sel.has(CELL(t.destination, t.nights)));
      if (st.nonstop) rows = rows.filter(t => t.stops === 0);
      return rows;
    }
    const sorter = { price: (a, b) => a.price - b.price || a.effective_cost - b.effective_cost, best: (a, b) => a.effective_cost - b.effective_cost || a.price - b.price,
      stops: (a, b) => a.stops - b.stops || a.price - b.price, travel: (a, b) => a.total_travel_min - b.total_travel_min || a.price - b.price }[st.sort];

    function tripRow(t, groupMin) {
      const out = t.legs[0], back = t.legs[t.legs.length - 1], open = st.open.has(t);
      const tr = h("tr", { class: "cmp-tr" + (open ? " open" : ""), tabindex: "0", "aria-expanded": String(open), title: "Click for every flight, layover and the Trip builder",
        onclick: () => { toggle(st.open, t); drawTable(); },
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(st.open, t); drawTable(); } } },
        h("td", { class: "c-dest" }, h("i", { style: `background:${colorOf(t.destination)}`, "aria-hidden": "true" }), h("b", {}, t.destination)),
        h("td", { class: "c-dates" }, h("div", {}, `${fmtDay(day(t.depart_date))} → ${fmtDay(day(t.return_date))}`), h("div", { class: "sub" }, lenWord(t.nights))),
        h("td", { class: "c-price" + (t.price === groupMin ? " low" : "") }, money(t.price, cur), origNote(t.price, cur, "orig block")),
        h("td", {}, legInfo(out)), h("td", {}, legInfo(back)),
        h("td", { class: "c-info" }, h("div", { class: t.stops === 0 ? "ok" : "warn" }, t.stops === 0 ? tr("Nonstop") : plural(t.stops, "stop")),
          h("div", { class: "sub" }, `${hm(out.duration_min)} / ${hm(back.duration_min)}`)),
        h("td", { class: "c-act" }, siteButtons(t)));
      return open ? [tr, h("tr", { class: "cmp-detail" }, h("td", { colspan: "7" }, tripCard(t, cur, pax)))] : [tr];
    }

    function drawTable() {
      const rows = candidateRows();
      const groups = new Map();
      const key = { length: t => t.nights, destination: t => t.destination, none: () => "all" }[st.group];
      for (const t of rows) { const k = key(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      const keys = [...groups.keys()];
      if (st.group === "length") keys.sort((a, b) => a - b);
      else if (st.group === "destination") keys.sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
      const body = keys.flatMap(k => {
        const g = groups.get(k).sort(sorter), min = Math.min(...g.map(t => t.price));
        const label = st.group === "length" ? lenWord(k) : st.group === "destination" ? k : null;
        const unitWord = st.group === "length" ? "destination" : "length";
        const count = st.group === "length" ? new Set(g.map(t => t.destination)).size : new Set(g.map(t => t.nights)).size;
        return [label ? h("tr", { class: "cmp-grp" }, h("td", { colspan: "7" },
          st.group === "destination" ? h("i", { style: `background:${colorOf(k)}`, "aria-hidden": "true" }) : h("span", { "aria-hidden": "true" }, "☾"),
          h("b", {}, tx("{label} · from {p}", { label, p: money(min, cur) })), h("span", { class: "n" }, plural(count, unitWord)))) : null,
          ...g.flatMap(t => tripRow(t, min))].filter(Boolean);
      });
      const total = st.show === "best" ? cells.length : daily.length;
      tableHost.replaceChildren(
        h("div", { class: "panel-head" }, h("div", {}, h("h3", {}, "Cheapest trips by destination and length"),
          h("p", {}, st.show === "best" ? "The best trip for every destination and trip length. Click a row for every flight." : "The cheapest trip leaving on each day. Click a row for every flight."))),
        h("div", { class: "cmp-tools" },
          chipGroup("Destinations", "All destinations", present.map(d => ({ text: d, value: d, dot: colorOf(d) })), st.dests, colorOf, () => { drawTable(); }),
          chipGroup("Trip lengths", "All lengths", [...new Set(cells.map(c => c.nights))].sort((a, b) => a - b).map(n => ({ text: lenWord(n), value: n })), st.lens, colorOf, () => { drawTable(); })),
        h("div", { class: "cmp-tools" },
          h("span", { class: "cmp-lbl" }, "Show"), segmented("Which trips", [["best", "Best per destination and length"], ["days", "Cheapest each day"]], st.show, v => { st.show = v; drawTable(); }),
          h("span", { class: "cmp-lbl" }, "Group by"), segmented("Group by", [["none", "None"], ["destination", "Destination"], ["length", "Length"]], st.group, v => { st.group = v; drawTable(); })),
        h("div", { class: "cmp-tools" },
          h("label", { class: "cmp-check" }, h("input", { type: "checkbox", checked: st.nonstop, onchange: e => { st.nonstop = e.target.checked; drawTable(); } }), "Nonstop only"),
          h("label", { class: "cmp-sort" }, tr("Sort by"), " ", h("select", { onchange: e => { st.sort = e.target.value; drawTable(); } },
            [["price", "Price (lowest)"], ["best", "Best value"], ["stops", "Fewest stops"], ["travel", "Shortest travel time"]].map(([v, t]) => h("option", { value: v, selected: st.sort === v }, t)))),
          h("span", { class: "badge run" }, rows.length === total ? plural(rows.length, "trip") : tx("{n} of {m} trips", { n: rows.length, m: total })),
          st.sel.size ? h("button", { type: "button", class: "btn small ghost", onclick: () => { st.sel.clear(); drawMatrix(); drawTable(); } }, tx("Clear {n}", { n: plural(st.sel.size, "selected cell") })) : null),
        rows.length ? h("div", { class: "cmp-scroll" }, h("table", { class: "cmp-table" },
          h("colgroup", {}, ["10%", "14%", "8%", "18%", "18%", "12%", "20%"].map(w => h("col", { style: `width:${w}` }))),
          h("thead", {}, h("tr", {}, ["Destination", "Dates", "Total", "Outbound", "Return", "Trip info", ""].map((t, i) => h("th", { class: i === 2 ? "r" : "" }, t)))),
          h("tbody", {}, body))) : h("div", { class: "note" }, "No trips match these filters. Clear a filter or a selected cell."));
    }

    drawMatrix(); drawTable();
  }
  return { render };
})();
