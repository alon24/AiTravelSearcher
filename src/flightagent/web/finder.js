"use strict";
/* Airline finder: which airlines fly between an origin and a country's airports? Asks the API, which checks one date for
   every airport, then more dates only for airports that have flights. Uses helpers from app.js. */
const Finder = (() => {
  let originAc, airportsAc, busy = false, last = null;

  const routeChip = r => h("span", { class: "rt" + (r.nonstop ? " ns" : ""), title: tx("Seen on {dates}", { dates: r.dates.map(d => fmtShort(day(d))).join(", ") }) + (r.flights.length ? " · " + r.flights.join(", ") : "") },
    `${r.airport} · ${tr(r.nonstop ? "nonstop" : "with a stop")}${r.cheapest != null ? ` · ${tx("from {p}", { p: money(r.cheapest, currentCurrency) })}` : ""}`);
  let currentCurrency = "ILS";

  function showResult(host, res, label) {
    last = { host, res, label };
    currentCurrency = res.currency;
    const dates = res.dates.map(d => fmtShort(day(d))).join(", ");
    const head = h("div", { class: "res-sub" },
      h("span", { class: "badge ok" }, tx("{n} found", { n: plural(res.airlines.length, "airline") })),
      h("span", {}, tx("{label} · dates checked: {dates} · {n} airports asked, {m} with flights", { label, dates, n: res.airports_checked.length, m: res.airports_with_flights.length })),
      h("span", { class: "badge run" }, `${res.elapsed_s}s`));
    const notes = [];
    if (res.trimmed) notes.push(tr("This country has many airports, so only the well-known ones were checked. List airports to check others."));
    if (res.airports_with_flights.length) notes.push(tx("Airports with flights: {list}.", { list: res.airports_with_flights.join(", ") }));
    notes.push(tr("Based on what Google Flights lists for those dates. An airline that flies other days may not appear."));
    host.replaceChildren(head, h("p", { class: "air-help" }, notes.join(" ")),
      res.airlines.length ? h("div", { class: "air-list" }, res.airlines.map(a => h("div", { class: "fnd-row" },
        h("span", { class: "air-name" }, h("span", { class: "an" }, a.name), h("span", { class: "ac2" }, a.code)),
        h("span", { class: "routes" }, a.routes.map(routeChip)),
        h("button", { type: "button", class: "btn small ghost", title: "Use only this airline in the search form", onclick: () => {
          ac.air.set([a.code]); ($$("input[name=airmode]").find(r => r.value === "only") || {}).checked = true; onFormChange(); window.scrollTo({ top: 0, behavior: "smooth" }); toast(tx("Search form set to {name} only", { name: a.name })); } }, "Only this")))) 
        : h("div", { class: "note" }, "No flights were listed for those airports on those dates."));
  }
  const toast = msg => { const t = h("div", { class: "toast", role: "status" }, msg); document.body.append(t); setTimeout(() => t.classList.add("show"), 10); setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2400); };

  async function init() {
    const body = $("#finder-body");
    let countries = [];
    try { countries = await api("/api/countries"); } catch { /* finder just stays without suggestions */ }
    document.body.append(h("datalist", { id: "country-list" }, countries.map(c => h("option", { value: c.name }))));
    const originBox = h("div", { class: "ac" }), airBox = h("div", { class: "ac" });
    originAc = autocomplete(originBox, { id: "fnd-origin", placeholder: "City or airport", multi: false, onChange: () => {} });
    airportsAc = autocomplete(airBox, { id: "fnd-airports", placeholder: "Optional: specific airports", multi: true, onChange: () => {} });
    originAc.set(readForm().from);
    const country = h("input", { type: "text", id: "fnd-country", list: "country-list", placeholder: "Romania", autocomplete: "off" });
    const date = h("input", { type: "date", id: "fnd-date", value: readForm().start });
    const out = h("div", { class: "fnd-out", "aria-live": "polite" });
    const go = h("button", { type: "submit", class: "btn primary small-primary" }, "Find airlines");
    const dir = h("div", { class: "seg", role: "radiogroup", "aria-label": "Direction" },
      h("label", {}, h("input", { type: "radio", name: "fnd-dir", value: "to", checked: true }), "Flying to"), h("label", {}, h("input", { type: "radio", name: "fnd-dir", value: "from" }), "Flying from"));
    const form = h("form", { class: "fnd-form", novalidate: true, onsubmit: async e => {
      e.preventDefault();
      if (busy) return;
      const airports = airportsAc.get(), c = country.value.trim(), origin = originAc.get()[0];
      if (!origin) { out.replaceChildren(h("div", { class: "note bad" }, "Pick your origin airport.")); return; }
      if (!c && !airports.length) { out.replaceChildren(h("div", { class: "note bad" }, "Type a country (for example Romania) or pick some airports.")); return; }
      busy = true; go.disabled = true;
      out.replaceChildren(h("div", { class: "tb-loading" }, h("span", { class: "plane", "aria-hidden": "true" }, "✈️"), "Asking Google Flights for every airport… this can take up to a minute."));
      const direction = $$("input[name=fnd-dir]").find(r => r.checked).value, f = readForm();
      try {
        const res = await post("/api/explore", { origin, country: airports.length ? "" : c, airports, direction, date: date.value, adults: f.adults, currency: f.currency });
        const where = airports.length ? airports.join(", ") : c;
        showResult(out, res, direction === "to" ? `${origin} → ${where}` : `${where} → ${origin}`);
      } catch (err) { out.replaceChildren(h("div", { class: "note bad" }, tw(err.message))); }
      busy = false; go.disabled = false;
    } },
      h("div", { class: "fnd-fields" },
        h("div", { class: "field" }, h("label", {}, "Direction"), dir),
        h("div", { class: "field" }, h("label", {}, "Your airport"), originBox),
        h("div", { class: "field" }, h("label", { for: "fnd-country" }, "Country"), h("div", { class: "input" }, country)),
        h("div", { class: "field" }, h("label", {}, "…or airports"), airBox),
        h("div", { class: "field" }, h("label", { for: "fnd-date" }, "Around this date"), h("div", { class: "input" }, date)),
        go));
    body.replaceChildren(form, out);
  }
  return { init, refresh: () => { if (last && last.host.isConnected) showResult(last.host, last.res, last.label); } };
})();
