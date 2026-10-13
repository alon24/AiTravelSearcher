"use strict";
/* Skyhop UI: no build step. All API-derived text goes through textContent (h()/s() helpers). */

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVGNS = "http://www.w3.org/2000/svg";
function build(el, props, kids) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const h = (tag, props, ...kids) => build(document.createElement(tag), props, kids);
const s = (tag, props, ...kids) => build(document.createElementNS(SVGNS, tag), props, kids);

// Airline codes -> readable names ("W4" -> "Wizz Air"); unknown codes stay as the code.
// The name to show for an airline: the provider's label, unless our own list spells the same name out in full ("ITA" -> "ITA Airways").
const airlineName = (code, label) => {
  const known = (config.airlines || {})[code];
  if (!label) return known || code;
  return known && known.length > label.length && known.toLowerCase().startsWith(label.toLowerCase()) ? known : label;
};
const airlineNames = codes => (codes || []).map(c => (config.airlines || {})[c] || c).join(", ");
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = str => new Date(str.length === 10 ? str + "T00:00:00" : str);
const fmtShort = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
// Built from parts: ICU versions disagree on whether en-GB puts a comma after the weekday ("Tue, 13 Oct" vs "Tue 13 Oct").
const fmtDay = d => `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${fmtShort(d)}`;
const fmtTime = d => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const hm = m => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
// First departure and last arrival of a leg (times are local to each airport).
const legEnds = leg => { const a = leg.segments[0], z = leg.segments[leg.segments.length - 1]; return { dep: day(a.departs), arr: day(z.arrives), from: a.origin, to: z.destination }; };
const dayShift = (dep, arr) => Math.round((new Date(arr.getFullYear(), arr.getMonth(), arr.getDate()) - new Date(dep.getFullYear(), dep.getMonth(), dep.getDate())) / 864e5);
const tmLine = leg => { const e = legEnds(leg), sh = dayShift(e.dep, e.arr); return `${fmtTime(e.dep)} ${e.from} → ${fmtTime(e.arr)} ${e.to}${sh > 0 ? ` +${sh}` : ""}`; };
const tmShort = leg => { const e = legEnds(leg), sh = dayShift(e.dep, e.arr); return `${fmtTime(e.dep)}→${fmtTime(e.arr)}${sh > 0 ? `+${sh}` : ""}`; };
// Money. Prices come in the currency they were searched in; everything on screen is converted to the currency button's
// choice with today's rate (see /api/rates). `money` is the one place that does it. Without live rates nothing is
// converted: a guessed rate would show a price nobody quoted.
let rates = {}, ratesInfo = { source: null, date: null, error: null }, displayCurrency = "ILS", showOriginal = false;
const fmtMoney = (v, cur) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(v);
const shownCur = cur => (showOriginal ? cur || "USD" : rates[cur] && rates[displayCurrency] ? displayCurrency : cur || "USD");
const isConverted = cur => shownCur(cur) !== (cur || "USD");
const toShown = (v, cur) => (isConverted(cur) ? (v / rates[cur]) * rates[displayCurrency] : v);
// "originally ₪194" line for converted prices, so the amount you would pay in the original currency is never hidden.
const origNote = (v, cur, cls = "orig") => (isConverted(cur) ? h("span", { class: cls }, `originally ${fmtMoney(v, cur)}`) : null);
function setShowOriginal(on) {
  showOriginal = !!on; store.set("skyhop.showOriginal", showOriginal);
  const t = $("#orig-toggle"); if (t) t.checked = showOriginal;
  rerenderCurrency();
}
const money = (v, cur) => fmtMoney(toShown(v, cur), shownCur(cur));
/** The results badge for a search made in another currency: the rate and its source in plain sight (phones can't
    hover), or why prices are not converted. */
function currencyBadge(cur) {
  if (!rates[cur] || !rates[displayCurrency]) {
    return h("span", { class: "badge warn conv-off" }, `Prices in ${cur}, as searched · ${ratesInfo.error || `no exchange rate for ${displayCurrency}`}`);
  }
  const rate = `1 ${cur} = ${(rates[displayCurrency] / rates[cur]).toFixed(3)} ${displayCurrency}, ${ratesInfo.source}${ratesInfo.date ? ` ${ratesInfo.date}` : ""}`;
  return h("button", { type: "button", class: "badge warn conv-toggle", onclick: () => setShowOriginal(!showOriginal),
    title: "The airline's own price in that currency may differ a little." },
    showOriginal ? `Showing original ${cur} · tap to convert to ${displayCurrency}` : `≈ Converted from ${cur} (${rate}) · tap for the original`);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function ago(ts) {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function api(path, opts) { return SkyhopLocal.backend.handle(path, opts); }   // /api is answered in the page (local/backend.js)
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Trip length: the form counts nights or days (a 5-night trip spans 6 calendar days); the API always works in nights.
let unit = "nights";
const unitOff = () => (unit === "days" ? 1 : 0);
const tripLen = n => (unit === "days" ? `${plural(n + 1, "day")} (${plural(n, "night")})` : `${plural(n, "night")} (${plural(n + 1, "day")})`);
const lenRange = (a, b) => (a === b ? tripLen(a) : unit === "days" ? `${a + 1}–${b + 1} days (${a}–${b} nights)` : `${a}–${b} nights (${a + 1}–${b + 1} days)`);
let recheckTimer = 0, currentRow = null;
const viewStore = new Map();
function toast(msg, ms = 3200) {
  const t = h("div", { class: "toast", role: "status" }, msg); document.body.append(t); setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
}
let resultsQuery = null;   // the request behind the results on screen (used by the trip builder buttons)
let config = { provider: "mock", airline_sites: {}, airlines: {} };

// ------------------------------------------------------------------ airports + autocomplete
let AIRPORTS = [];
async function loadAirports() {
  AIRPORTS = AirportSearch.prepare(await (await fetch("airports.json")).json());
}
const airport = code => AIRPORTS.find(a => a.code === code);

function autocomplete(root, { id, placeholder, multi, max = 8, onChange }) {
  let values = [], items = [], active = -1;
  const input = h("input", { id, type: "text", placeholder, role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", autocomplete: "off" });
  const list = h("ul", { class: "ac-list", role: "listbox", hidden: true });
  root.append(input, list);

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const chip = code => {
    const a = airport(code);
    return h("span", { class: "chip" }, a ? `${code} · ${a.city}` : code,
      h("button", { type: "button", "aria-label": `Remove ${code}`, onclick: e => { e.stopPropagation(); values = values.filter(v => v !== code); draw(); onChange(); } }, "×"));
  };
  function draw() {
    $$(".chip", root).forEach(c => c.remove());
    values.forEach(code => root.insertBefore(chip(code), input));
    input.placeholder = multi && values.length ? "Add another…" : values.length ? "Change…" : placeholder;
  }
  function pick(code) {
    const codes = [].concat(code).map(c => c.toUpperCase());     // a country pick is several airports
    if (multi) {
      const room = codes.filter(c => !values.includes(c)), added = room.slice(0, max - values.length);
      values.push(...added);
      if (added.length < room.length) toast(`Added ${added.length} of ${room.length} airports: at most ${max} fit here. Remove some to add the rest.`);
    } else values = [codes[0]];
    input.value = ""; close(); draw(); onChange();
  }
  const choice = item => item.codes || item.code;
  function show() {
    const results = AirportSearch.search(AIRPORTS, input.value);
    const land = multi ? AirportSearch.country(AIRPORTS, input.value, max) : null;
    items = [...(land ? [land] : []), ...results.map(r => r.a)];
    const q = input.value.trim();
    const rows = items.map((a, i) => h("li", { role: "option", class: a.codes ? "ac-country" : null, "aria-selected": String(i === active), onmousedown: e => { e.preventDefault(); pick(choice(a)); } },
      ...(a.codes ? [h("span", { class: "ac-code" }, "🌍"),
        h("span", {}, h("div", { class: "ac-city" }, `${a.name}: ${a.of > a.codes.length ? `${a.codes.length} of its ${a.of}` : `all ${a.codes.length}`} main airports`),
          h("div", { class: "ac-sub" }, `${a.codes.join(" · ")} (large airports with scheduled flights)`))]
        : [h("span", { class: "ac-code" }, a.code),
          h("span", {}, h("div", { class: "ac-city" }, a.city), h("div", { class: "ac-sub" }, `${a.name} · ${a.country}`))])));
    if (results.length && results[0].kind === "fuzzy") rows.unshift(h("li", { class: "ac-hint", role: "presentation" }, `No exact match for “${q}”. Did you mean…`));
    if (!results.length && q) rows.push(h("li", { class: "ac-hint", role: "presentation" }, "No match. Try a city, an airport name or a 3-letter code."));
    list.replaceChildren(...rows);
    list.hidden = !rows.length; input.setAttribute("aria-expanded", String(items.length > 0));
  }
  input.addEventListener("input", () => { active = -1; show(); });
  input.addEventListener("focus", show);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (list.hidden) show();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1);
      $$("li[role=option]", list).forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    } else if (e.key === "Enter") {
      const raw = input.value.trim();
      if (active >= 0 && items[active]) { e.preventDefault(); pick(choice(items[active])); }
      else if (/^[A-Za-z]{3}$/.test(raw) && AIRPORTS.some(a => a.code === raw.toUpperCase())) { e.preventDefault(); pick(raw); }
      else if (items[0]) { e.preventDefault(); pick(choice(items[0])); }
      else if (/^[A-Za-z]{3}$/.test(raw)) { e.preventDefault(); pick(raw); }
    } else if (e.key === "Backspace" && !input.value && values.length) { values.pop(); draw(); onChange(); }
    else if (e.key === "Escape") close();
  });
  root.addEventListener("click", () => input.focus());
  return { get: () => [...values], set: arr => { values = [...arr]; draw(); } };
}

// ------------------------------------------------------------------ form state
// The "value of an hour" and self-transfer penalty are money amounts, so their defaults scale with the currency.
const VOT = { ILS: 35, USD: 10, EUR: 10, GBP: 8 }, PENALTY = { ILS: 150, USD: 40, EUR: 40, GBP: 35 };
let lastCurrency = "ILS";
const defaults = () => {
  const t = new Date(), plus = n => { const d = new Date(t); d.setDate(d.getDate() + n); return iso(d); };
  return { from: ["TLV"], to: [], back: [], start: plus(21), end: plus(60), nmin: 4, nmax: 7, lenMode: "any", stops: 1, currency: "ILS", adults: 1,
    airmode: "exclude", airlines: [], kids: [], connect: false, same: false, st: false, hubs: [], buffer: 4, maxtravel: "", laymin: 1.5, laymax: 72, vot: VOT.ILS, top: 5, maxcalls: 400 };
};
let ac = {};
let kids = [];   // ages of the children in the form
const num = (id, fallback) => { const v = parseFloat($(`#${id}`).value); return Number.isFinite(v) ? v : fallback; };

function readForm() {
  unit = $$("input[name=unit]").find(r => r.checked)?.value || "nights";
  return {
    from: ac.from.get(), to: ac.to.get(), back: ac.back.get(), hubs: ac.hubs.get(),
    start: $("#start").value, end: $("#end").value, ...effectiveLength(), lenMode, unit,
    stops: +($$("input[name=stops]").find(r => r.checked)?.value ?? 1), currency: $$("input[name=currency]").find(r => r.checked)?.value || "ILS", adults: num("adults", 1),
    airmode: $$("input[name=airmode]").find(r => r.checked)?.value || "exclude", airlines: ac.air.get(),
    bags: $$("input[name=bags]").find(r => r.checked)?.value || "none",
    kids: [...kids], connect: $("#connect").checked, same: $("#same").checked, st: $("#st").checked, buffer: num("buffer", 4),
    maxtravel: $("#maxtravel").value, laymin: num("laymin", 1.5), laymax: num("laymax", 72), vot: num("vot", 10), top: num("top", 5), maxcalls: num("maxcalls", 400),
  };
}
function writeForm(f) {
  ac.from.set(f.from); ac.to.set(f.to); ac.back.set(f.back); ac.hubs.set(f.hubs);
  unit = f.unit || unit;
  ($$("input[name=unit]").find(r => r.value === unit) || {}).checked = true;
  $("#start").value = f.start; $("#end").value = f.end;
  showLength(f.nmin, f.nmax);
  setLenMode(f.lenMode || inferLenMode(f));
  const r = $$("input[name=stops]").find(x => +x.value === f.stops) || $$("input[name=stops]")[1]; r.checked = true;
  ($$("input[name=currency]").find(r => r.value === f.currency) || $$("input[name=currency]")[0]).checked = true; $("#adults").value = f.adults;
  kids = [...(f.kids || [])]; renderKids();
  ($$("input[name=bags]").find(r => r.value === (f.bags || "none")) || {}).checked = true;
  ac.air.set(f.airlines || []); ($$("input[name=airmode]").find(r => r.value === (f.airmode || "exclude")) || {}).checked = true;
  $("#connect").checked = f.connect; $("#same").checked = f.same; $("#st").checked = f.st; $("#buffer").value = f.buffer;
  $("#maxtravel").value = f.maxtravel; $("#laymin").value = f.laymin; $("#laymax").value = f.laymax;
  displayCurrency = f.currency;
  $("#vot").value = f.vot; $("#vot-out").textContent = money(f.vot, f.currency) + "/h"; $("#top").value = f.top; $("#maxcalls").value = f.maxcalls;
  renderActiveFilters(readForm());
  Mobile.wizardReset();   // a whole new form (a past search, an edit, a link): a phone shows it ready to review
}
function toRequest(f) {
  const err = m => ({ error: m });
  if (!f.from[0]) return err("Pick where you're flying from.");
  if (!f.to.length) return err("Pick at least one destination.");
  if (!f.start || !f.end) return err("Pick your dates.");
  const days = (day(f.end) - day(f.start)) / 864e5;
  if (days <= 0) return err("The return date must be after the departure date.");
  const infants = f.kids.filter(a => a < 2).length, adultsEff = f.adults + f.kids.filter(a => a >= 12).length;
  if (f.adults + f.kids.length > 9) return err("At most 9 travellers per search.");
  if (infants > adultsEff) return err("Each child under 2 needs their own adult (one lap infant per adult).");
  if (f.nmin < 1) return err("Trip length: at least 1 night.");
  if (f.nmax < f.nmin) return err("Trip length: the second number can't be lower than the first (it is between the lower and the higher one).");
  if (days < f.nmin) return err(`Your dates allow at most ${plural(days, "night")} (${plural(days + 1, "day")}), but the trip is ${tripLen(f.nmin)}. Shorten the trip or move the latest return later.`);
  return { req: {
    origin: f.from[0], destinations: f.to, return_airports: f.back, connect_destinations: f.connect,
    window_start: f.start, window_end: f.end, min_nights: f.nmin, max_nights: f.nmax,
    allow_connections: f.stops > 0, max_stops_per_leg: f.stops,
    min_layover_min: Math.round(f.laymin * 60), max_layover_min: Math.round(f.laymax * 60),
    max_travel_min_per_direction: f.maxtravel ? Math.round(parseFloat(f.maxtravel) * 60) : null,
    allow_mixed_airlines: !f.same, allow_self_transfer: f.st && f.hubs.length > 0, self_transfer_hubs: f.hubs,
    self_transfer_buffer_min: Math.round(f.buffer * 60), adults: f.adults, children_ages: f.kids, currency: f.currency,
    airlines_exclude: f.airmode === "exclude" ? f.airlines : [], airlines_include: f.airmode === "only" ? f.airlines : [],
    carry_on_bags: f.bags === "cabin" || f.bags === "both" ? 1 : 0, checked_bags: f.bags === "checked" || f.bags === "both" ? 1 : 0,
    value_of_time_per_hour: f.vot, self_transfer_penalty: PENALTY[f.currency] ?? 40,
    // With several destinations, the flat top_n list needs enough headroom that "cheapest by
    // route" (grouped client-side from res.top, see routePicks()) has a real shot at surfacing
    // every destination, not just whichever ones happen to dominate the top of one global list.
    // Measured limit of this approach: if one destination is cheaper on every single day in the
    // window, no top_n is enough -- that needs the deferred backend _daily() fix (see DESIGN.md).
    top_n: Math.max(f.top, Math.min(30, f.to.length * 8)), max_api_calls: f.maxcalls,
  } };
}
function requestToForm(q) {
  return { from: [q.origin], to: q.destinations, back: q.return_airports, start: q.window_start, end: q.window_end,
    nmin: q.min_nights, nmax: q.max_nights, stops: Math.min(q.max_stops_per_leg, 2), currency: q.currency, adults: q.adults, kids: q.children_ages || [],
    bags: q.carry_on_bags && q.checked_bags ? "both" : q.carry_on_bags ? "cabin" : q.checked_bags ? "checked" : "none",
    airmode: (q.airlines_include || []).length ? "only" : "exclude", airlines: (q.airlines_include || []).length ? q.airlines_include : (q.airlines_exclude || []),
    connect: q.connect_destinations, same: !q.allow_mixed_airlines, st: q.allow_self_transfer, hubs: q.self_transfer_hubs,
    buffer: q.self_transfer_buffer_min / 60, maxtravel: q.max_travel_min_per_direction ? q.max_travel_min_per_direction / 60 : "",
    laymin: q.min_layover_min / 60, laymax: q.max_layover_min / 60, vot: q.value_of_time_per_hour, top: q.top_n, maxcalls: q.max_api_calls };
}

// ------------------------------------------------------------------ travellers
const paxCount = q => q.adults + (q.children_ages || []).length;
function paxLabel(q) {
  const ages = q.children_ages || [];
  return plural(q.adults, "adult") + (ages.length ? `, children aged ${[...ages].sort((a, b) => a - b).join(", ")}` : "");
}
const ageLabel = a => (a === 0 ? "Under 1" : a === 1 ? "1" : a >= 12 ? `${a} (adult fare)` : String(a));
function renderKids() {
  $("#kids-list").replaceChildren(...kids.map((age, i) => h("label", { class: "kid" }, `Child ${i + 1}`,
    h("select", { "aria-label": `Age of child ${i + 1}`, onchange: e => { kids[i] = +e.target.value; renderKids(); onFormChange(); } },
      Array.from({ length: 18 }, (_, a) => h("option", { value: a, selected: a === age }, ageLabel(a)))),
    h("button", { type: "button", "aria-label": `Remove child ${i + 1}`, onclick: () => { kids.splice(i, 1); renderKids(); onFormChange(); } }, "×"))));
  const inf = kids.filter(a => a < 2).length, adult = kids.filter(a => a >= 12).length;
  $("#kids-note").textContent = [
    inf ? `${plural(inf, "infant")} under 2 ${inf === 1 ? "travels" : "travel"} on a lap: fares and airline rules vary, and some airlines may not appear.` : "",
    adult ? `${plural(adult, "child")} aged 12+ counted as adult.` : "",
    !kids.length ? "Children are priced by age; leave empty if you're flying with adults only." : "",
  ].filter(Boolean).join(" ");
}

// Options that change the results but live under "More options" are listed next to the search button, each removable, so a
// filter carried over from an earlier search can never be silently active.
function renderActiveFilters(f) {
  const nameOf = c => (config.airlines || {})[c] || c;
  const chips = [];
  const add = (label, clear) => chips.push(h("button", { type: "button", class: "af-chip", title: "Click to remove this filter", onclick: () => { clear(); onFormChange(); } }, label, h("span", { "aria-hidden": "true" }, " ✕")));
  if (f.airlines.length) add(`${f.airmode === "only" ? "Only" : "Excluding"}: ${f.airlines.map(nameOf).join(", ")}`, () => ac.air.set([]));
  if (f.bags !== "none") add(`Bags in price: ${{ cabin: "cabin bag", checked: "checked bag", both: "cabin + checked" }[f.bags]}`, () => { $$("input[name=bags]")[0].checked = true; });
  if (f.same) add("Same airline both ways", () => { $("#same").checked = false; });
  if (f.st && f.hubs.length) add(`Self-transfer via ${f.hubs.join(", ")}`, () => { $("#st").checked = false; });
  if (f.connect) add("Also flying between destinations", () => { $("#connect").checked = false; });
  if (f.maxtravel) add(`Max travel ${f.maxtravel}h each way`, () => { $("#maxtravel").value = ""; });
  if (f.back.length) add(`Flying home from ${f.back.join(", ")}`, () => ac.back.set([]));
  const box = $("#active-filters");
  box.hidden = !chips.length;
  box.replaceChildren(...(chips.length ? [h("span", { class: "af-label" }, "Active filters:"), ...chips] : []));
}

// The currency button changes the whole screen: results, history, trip builder and airline finder.
function rerenderCurrency() {
  $("#vot-out").textContent = money(readForm().vot, displayCurrency) + "/h";
  if (currentRow && currentRow.id === current && currentRow.status === "done") renderResult(currentRow, { keepScroll: true });
  refreshHistory();
  if (window.Builder) Builder.refresh();
  if (window.Finder) Finder.refresh();
}

// ---- Trip length ------------------------------------------------------------------------------------------------
// Simple ("any"): every length that fits the dates, i.e. the whole timeframe. Expert mode: "exact" (N) or "range" (N to M).
// The dates cap the length (leave on the earliest date, return on the latest = the longest trip), and in a range the second
// number can never be lower than the first. The API always works in nights; the form shows nights or days.
let lenMode = "any";
// The unit the two number inputs are currently written in. It is NOT always `unit`: the radio's "input" event reaches
// readForm (which sets `unit`) before the "change" handler has re-written the numbers, so reading them needs their own unit.
let inputsUnit = "nights";
const inOff = () => (inputsUnit === "days" ? 1 : 0);
let lastExpert = { nmin: 4, nmax: 7, mode: "range" };   // what expert mode returns to after being switched off and on
const addDays = (str, n) => { const d = day(str); d.setDate(d.getDate() + n); return iso(d); };
const windowNights = () => {
  const a = $("#start").value, b = $("#end").value;
  if (!a || !b) return null;
  const n = Math.round((day(b) - day(a)) / 864e5);
  return n >= 1 ? n : null;
};
const lengthCap = () => Math.min(60, windowNights() ?? 60);   // nights

// The length (in nights) the search will use, whatever mode the form is in.
function effectiveLength() {
  if (lenMode === "any") return { nmin: 1, nmax: lengthCap() };
  const nmin = num("nmin", 0) - inOff(), nmax = lenMode === "exact" ? nmin : num("nmax", 0) - inOff();
  return { nmin, nmax };
}
// Which mode a saved search / older draft was in: the whole window is "any", one number is "exact", else "range".
function inferLenMode(f) {
  const n = f.start && f.end ? Math.min(60, Math.max(1, Math.round((day(f.end) - day(f.start)) / 864e5))) : 60;
  return f.nmin <= 1 && f.nmax >= n ? "any" : f.nmin === f.nmax ? "exact" : "range";
}
function setLenMode(mode) {
  lenMode = mode;
  $("#expert").checked = mode !== "any";
  $("#len-any").hidden = mode !== "any"; $("#len-expert").hidden = mode === "any";
  ($$("input[name=lenmode]").find(r => r.value === mode) || {}).checked = mode !== "any";
  $("#nmax-wrap").hidden = $("#len-to").hidden = mode === "exact";
  $("#nights-row").classList.toggle("one", mode === "exact");
  if (mode === "exact") $("#nmax").value = $("#nmin").value;
  if (mode !== "any") lastExpert = { nmin: num("nmin", 4) - inOff(), nmax: num("nmax", 7) - inOff(), mode };
  constrainLength(); updateLengthHint();
}

// Put a night range into the two inputs in the unit being shown.
function showLength(nmin, nmax) {
  const off = unitOff();
  for (const [id, n] of [["nmin", nmin], ["nmax", nmax]]) $(`#${id}`).value = n + off;
  inputsUnit = unit;
  constrainLength();
}

let lengthNote = "";   // why a number was changed for the person ("Adjusted to fit your dates ...")
function constrainLength() {
  const off = inOff(), cap = lengthCap(), before = { min: $("#nmin").value, max: $("#nmax").value }, notes = [];
  if ($("#start").value) $("#end").min = addDays($("#start").value, 1);          // the calendar will not offer a return before the start
  if ($("#end").value) $("#start").max = addDays($("#end").value, -1);
  const clamp = (id, lo, hi) => { const el = $(`#${id}`), v = parseFloat(el.value); el.min = lo; el.max = hi;
    if (Number.isFinite(v)) { const c = Math.min(hi, Math.max(lo, v)); if (c !== v) { el.value = c; return true; } } return false; };
  const fromMoved = clamp("nmin", 1 + off, cap + off);
  // "To" can never be lower than "From": it is between the lower and the higher number.
  const toMoved = clamp("nmax", Math.max(1 + off, num("nmin", 1 + off)), cap + off);
  if ((fromMoved || toMoved) && lenMode !== "any") {   // in simple mode the two numbers are only what expert mode will start from: nothing to tell
    const tooLong = +before.min > cap + off || +before.max > cap + off;
    notes.push(tooLong ? `Your dates allow at most ${tripLen(cap)}, so the length was set to fit.`
      : "The second number can't be lower than the first, so it was raised to match.");
  }
  if (lenMode === "exact") $("#nmax").value = $("#nmin").value;
  if (notes.length) lengthNote = notes.join(" ");   // stays until the person touches the length again
  return notes.length > 0;
}
function updateLengthHint() {
  const wn = windowNights(), cap = lengthCap(), { nmin, nmax } = effectiveLength();
  const ok = nmin >= 1 && nmax >= nmin;
  $("#len-any").textContent = wn ? `Any length that fits your dates: ${lenRange(1, cap)}.` : "Pick your dates: any length that fits them.";
  const what = lenMode === "any" ? "" : ok ? `${lenMode === "exact" ? "Exactly" : "Between"} ${lenMode === "exact" ? tripLen(nmin) : lenRange(nmin, nmax)}. The day you leave and the day you return both count as days.` : "";
  const limit = lenMode !== "any" && wn ? ` Your dates allow up to ${tripLen(cap)}.${nmax >= cap ? " Move the latest return later for longer trips." : ""}` : "";
  const hint = $("#nights-hint");
  hint.textContent = `${lengthNote ? lengthNote + " " : ""}${what}${limit}`.trim();
  hint.classList.toggle("warn", !!lengthNote);
}

// ------------------------------------------------------------------ estimate + submit
let estTimer = 0, estSeq = 0, overBudget = false;
function setEstimate(kind, text) {
  const el = $("#estimate"); el.className = `estimate ${kind}`; $("#estimate-text").textContent = text;
}
function updateGo() { $("#go").disabled = overBudget || busy; }
async function runEstimate() {
  const { req, error } = toRequest(readForm());
  const seq = ++estSeq;
  if (error) { overBudget = false; setEstimate("idle", error); updateGo(); return; }
  try {
    const e = await post("/api/estimate", req);
    if (seq !== estSeq) return;
    overBudget = e.to_fetch > req.max_api_calls;
    const chain = config.provider.split(",").map(x => x.trim()), primary = chain[0];
    const cost = primary === "serpapi" ? `uses ~${e.to_fetch} SerpApi credits` : primary === "mock" ? "demo data, no cost"
      : chain.includes("serpapi") ? `free; up to ${e.to_fetch} SerpApi credits only if Google refuses` : "free";
    setEstimate(overBudget ? "over" : "ok",
      overBudget ? `Too big: ${e.to_fetch} lookups needed, max is ${req.max_api_calls}. Narrow the dates or cities.`
        : `≈ ${e.lookups} lookups · ${e.cached} cached · ${cost}`);
  } catch (err) { if (seq === estSeq) setEstimate("idle", err.message); overBudget = false; }
  updateGo();
}
function onFormChange() {
  let f = readForm();
  if (f.currency !== lastCurrency) {            // keep a custom "value of an hour", but re-scale the untouched default
    if (Math.round(f.vot) === VOT[lastCurrency]) { $("#vot").value = VOT[f.currency]; f = readForm(); }
    lastCurrency = f.currency;
  }
  if (f.currency !== displayCurrency) { displayCurrency = f.currency; rerenderCurrency(); }
  store.set("skyhop.form", f);
  if (lenMode !== "any") lastExpert = { nmin: f.nmin, nmax: f.nmax, mode: lenMode };
  updateLengthHint();
  renderActiveFilters(f);
  $("#vot-out").textContent = money(f.vot, f.currency) + "/h";
  clearTimeout(estTimer); estTimer = setTimeout(runEstimate, 300);
}
let busy = false;
async function submitSearch(req) {
  busy = true; updateGo();
  try { const { id } = await post("/api/searches", req); await openSearch(id); }
  finally { busy = false; updateGo(); }
}
function showFormError(msg) { const el = $("#form-error"); el.textContent = msg || ""; el.hidden = !msg; }

// ------------------------------------------------------------------ history
let current = null, pollTimer = 0;
async function refreshHistory() {
  let rows = [];
  const box = $("#history");
  try { rows = await api("/api/searches"); } catch (e) { box.replaceChildren(h("div", { class: "note bad" }, `Couldn't load your searches: ${e.message}`)); return; }
  box.replaceChildren(...(rows.length ? rows.map(histItem) : [h("div", { class: "empty-hist" }, "Your searches will show up here.")]));
}
function histItem(r) {
  const q = r.request;
  const nights = lenRange(q.min_nights, q.max_nights);
  const p = r.progress, pct = p.total ? Math.round(100 * p.done / p.total) : 0;
  const status = r.status === "running" ? h("span", { class: "badge run" }, p.total ? `${pct}%` : "…")
    : r.status === "failed" ? h("span", { class: "badge fail" }, "Failed")
    : r.best_price != null ? h("span", { class: "hi-price", title: isConverted(r.currency) ? `Searched in ${r.currency}: ${fmtMoney(r.best_price, r.currency)}` : null }, `from ${money(r.best_price, r.currency)}`)
    : h("span", { class: "badge warn" }, "No flights");
  const open = () => { closeSidebar(); openSearch(r.id, { fillForm: true }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return h("div", { class: "hist-item" + (r.id === current ? " active" : ""), role: "button", tabindex: "0", "data-id": r.id,
    onclick: open, onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
    h("div", { class: "hi-route" }, `${q.origin} → ${q.destinations.join(", ")}`),
    h("div", { class: "hi-meta" }, `${fmtShort(day(q.window_start))} – ${fmtShort(day(q.window_end))} · ${nights}${paxCount(q) > 1 ? ` · ${plural(paxCount(q), "traveller")}` : ""}`),
    h("div", { class: "hi-foot" }, status, h("span", {}, ago(r.created))),
    h("button", { class: "hi-del", type: "button", "aria-label": "Delete this search", onclick: async e => {
      e.stopPropagation(); await api(`/api/searches/${r.id}`, { method: "DELETE" });
      if (current === r.id) { current = null; $("#results").replaceChildren(); }
      refreshHistory();
    } }, "×"));
}

async function openSearch(id, opts = {}) {
  clearTimeout(pollTimer); current = id;
  let row;
  try { row = await api(`/api/searches/${id}`); } catch (e) { $("#results").replaceChildren(h("div", { class: "note bad" }, e.message)); return; }
  if (current !== id) return;
  if (opts.fillForm) { writeForm(requestToForm(row.request)); store.set("skyhop.form", readForm()); runEstimate(); }
  refreshHistory();
  syncStep1Summary(row);
  if (row.status === "running") { renderProgress(row); pollTimer = setTimeout(() => openSearch(id), 900); return; }
  renderResult(row);
}
// Step nav: the rail chips are just navigation, the actual editable content (the form, the
// airline picker) lives in #step-panel in the main pane where it has real width. Step 3 has no
// editable content -- clicking it jumps to the comparison instead of opening the panel.
function showStep(n) {
  $$(".step-chip").forEach(c => c.classList.toggle("active", c.dataset.wizardStep === String(n)));
  $("#step-panel").hidden = false;
  $("#step1-panel").hidden = n !== 1;
  $("#step2-panel").hidden = n !== 2;
  if (n === 1) Mobile.wizardReset();
  $("#step-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function hideStepPanel() {
  $("#step-panel").hidden = true;
  $$(".step-chip").forEach(c => c.classList.remove("active"));
}
// Step 1 (Trip) auto-collapses to a one-line summary once a search is running/done -- click it
// to reopen and edit. The step is genuinely finished with its job at that point; this isn't
// decorative collapsing, it's getting the form out of the way so results are visible immediately.
function syncStep1Summary(row) {
  const q = row.request, nights = lenRange(q.min_nights, q.max_nights);
  $("#step-1-summary").textContent = `${q.origin} → ${q.destinations.join(", ")} · ${nights}`;
  hideStepPanel();
}

// ------------------------------------------------------------------ results
// Rail Step 2 (Airlines): the real per-airline list only exists once a search has told us which
// airlines fly this route, so it renders here -- not before a search runs.
function renderStepAirlines(res, q, cur, row) {
  const host = $("#step2-airlines");
  host.replaceChildren();
  const bar = airlineBar(res, q, row);
  const panel = airlinePanel(res, q, cur, row);
  // The quick include/exclude chips live in a sticky strip at the top of the results pane (always
  // reachable while scrolling); the detailed per-airline list stays in rail step 2.
  const sticky = $("#air-sticky");
  sticky.replaceChildren(...(bar ? [bar] : []));
  sticky.hidden = !bar;
  if (panel) host.append(panel);
  const include = q.airlines_include || [], exclude = q.airlines_exclude || [];
  const nameOf2 = c => (config.airlines || {})[c] || c;
  $("#step-2-summary").textContent = include.length ? `Only: ${include.map(nameOf2).join(", ")}`
    : exclude.length ? `Excluding: ${exclude.map(nameOf2).join(", ")}`
    : (res.airlines || []).length ? `${res.airlines.length} airlines found` : "";
}

// Rail Step 3 (Compare): a live summary, not a form -- there's nothing to show until Steps 1-2
// have produced results.
function activateStep3(res, q, cur) {
  // .ready (results exist, worth clicking), not .active (that class means "this chip's content
  // is the one currently open" -- Step 3 has no openable content, so it never gets .active).
  $("#step-3").classList.add("ready");
  const cheapest = (res.top || [])[0];
  // Destination count is q.destinations.length (what was actually searched), NOT derived from
  // res.top -- that list can be entirely one destination when it dominates on price (see
  // routePicks()), which would otherwise make this say "1 destination" even when 2+ were searched.
  $("#step-3-summary").textContent = cheapest
    ? `from ${money(cheapest.price, cur)} · ${plural(q.destinations.length, "destination")} compared` : "";
}

// "Cheapest by route": res.top is a flat, globally-sorted list, but each Trip carries its own
// destination -- group it client-side to show what EVERY searched destination costs, not just
// whichever one dominates the global top-N (see toRequest()'s top_n bump for why this needs
// enough headroom). Deliberately separate from the existing global Cheapest/Best value picks,
// not a replacement for them -- those answer "what's the single best trip", this answers
// "what does each place I searched actually cost".
function routePicks(res, cur, paxN, searchedCount) {
  const top = res.top || [];
  const dests = new Set(top.map(t => t.destination));
  if (searchedCount < 2) return null; // only one destination was searched -- nothing to compare
  if (dests.size < 2) {
    // Measured, real limitation (not a bug): when one destination is cheaper than the others on
    // every single day in the window, the flat top-N list can end up entirely one destination --
    // no client-side top_n bump fixes that. Say so rather than silently showing nothing.
    return h("div", { class: "note" }, `Every one of the top ${top.length} trips found happened to be ${[...dests][0] || "the same destination"} -- the other destinations weren't competitive enough on price to make this list. Narrow the dates or check them individually to compare properly.`);
  }
  const byDest = new Map();
  for (const t of top) if (!byDest.has(t.destination) || t.price < byDest.get(t.destination).price) byDest.set(t.destination, t);
  const detail = h("div", { class: "pick-detail", hidden: true, "aria-live": "polite" });
  let openDest = null;
  const cards = [...byDest.entries()].sort((a, b) => a[1].price - b[1].price).map(([dest, t]) => {
    const btn = h("button", { type: "button", class: "pick compact", "aria-expanded": "false", onclick: () => {
      openDest = openDest === dest ? null : dest;
      cards.forEach(b => b.setAttribute("aria-expanded", String(b === btn && openDest === dest)));
      detail.hidden = !openDest;
      detail.replaceChildren(...(openDest ? [tripCard(t, cur, paxN)] : []));
      if (openDest) detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } },
      h("span", { class: "k" }, dest), h("span", { class: "v" }, money(t.price, cur)), origNote(t.price, cur),
      h("span", { class: "s" }, `${fmtDay(day(t.depart_date))} · ${t.stops === 0 ? "direct" : plural(t.stops, "stop")}`));
    return btn;
  });
  return h("div", { class: "route-picks-wrap" },
    h("div", { class: "af-label" }, byDest.size < dests.size ? `Cheapest by route (${byDest.size} of ${dests.size} destinations shown)` : "Cheapest by route"),
    h("div", { class: "route-picks" }, cards), detail);
}

function renderProgress(row) {
  const { done, total } = row.progress, q = row.request;
  const fill = h("div", { class: "bar-fill" + (total ? "" : " indet"), style: total ? `width:${Math.max(4, Math.round(100 * done / total))}%` : null });
  $("#results").replaceChildren(h("div", { class: "card progress" },
    h("div", { class: "plane", "aria-hidden": "true" }, "✈️"),
    h("div", { class: "txt" }, total ? `Checking flights… ${done} of ${total}` : "Warming up…"),
    h("div", { class: "bar-track", role: "progressbar", "aria-valuenow": total ? done : null, "aria-valuemax": total || null }, fill),
    h("div", { class: "sub" }, `${q.origin} → ${q.destinations.join(", ")} · every day from ${fmtShort(day(q.window_start))} to ${fmtShort(day(q.window_end))}`),
    h("button", { type: "button", class: "btn cancel-search", disabled: cancelling.has(row.id), onclick: () => cancelSearch(row) },
      cancelling.has(row.id) ? "Cancelling…" : "Cancel")));
}
const cancelling = new Set();     // ids whose Cancel was pressed: the progress card is redrawn on every poll
async function cancelSearch(row) {
  cancelling.add(row.id); renderProgress(row);
  try { await post(`/api/searches/${row.id}/cancel`, {}); } catch (e) { cancelling.delete(row.id); toast(`Couldn't cancel: ${e.message}`); }
}

function renderResult(row, opts = {}) {
  clearTimeout(recheckTimer);
  currentRow = row;
  const box = $("#results"), q = row.request;
  resultsQuery = q;
  box.replaceChildren();
  if (row.status === "failed") {
    const cancelled = /^Cancelled\./.test(row.error || "");
    box.append(h("div", { class: cancelled ? "note" : "note bad" }, cancelled ? row.error : `This search failed: ${row.error}`),
      h("div", {}, h("button", { class: "btn", onclick: () => submitSearch(q) }, cancelled ? "Search again" : "Try again")));
    return;
  }
  const res = row.result, cur = q.currency, daily = res.daily;
  const nights = lenRange(q.min_nights, q.max_nights);
  const via = Object.entries(res.sources || {}).map(([k, n]) => `${k} ×${n}`).join(", ");
  const phone = Mobile.isPhone();
  const lookups = `${res.api_calls + res.cache_hits} lookups${via ? ` · ${via}` : ""}${res.cache_hits ? ` · ${res.cache_hits} cached` : ""}`;
  const subLine = (...badges) => (phone   // a phone gets one line with the sources; the rest opens on tap
    ? h("details", { class: "res-sub res-meta" }, h("summary", {}, `${fmtShort(day(q.window_start))} – ${fmtShort(day(q.window_end))} · ${nights} · ${lookups} · ${ago(row.created)}`), badges)
    : h("div", { class: "res-sub" }, `${fmtShort(day(q.window_start))} – ${fmtShort(day(q.window_end))} · ${nights}`, badges));
  box.append(h("div", { class: "res-head" },
    h("div", {},
      h("h2", {}, `${q.origin} → ${q.destinations.join(", ")}`),
      subLine(
        h("span", { class: "badge ok" }, lookups),
        paxCount(q) > 1 && h("span", { class: "badge run" }, `${paxLabel(q)} · totals`),
        (q.airlines_exclude || []).length || (q.airlines_include || []).length ? h("span", { class: "badge warn" }, `${(q.airlines_include || []).length ? "Only" : "Excluding"}: ${((q.airlines_include || []).length ? q.airlines_include : q.airlines_exclude).map(c => (config.airlines || {})[c] || c).join(", ")}`) : null,
        (q.carry_on_bags || q.checked_bags) ? h("span", { class: "badge run", title: "Google adds estimated bag fees only where it has them (mostly US and Europe)" }, `🧳 est. fees for ${[q.carry_on_bags ? "cabin bag" : "", q.checked_bags ? "checked bag" : ""].filter(Boolean).join(" + ")} included`) : null,
        q.currency !== displayCurrency ? currencyBadge(q.currency) : null,
        h("span", { class: "badge run" }, `${res.elapsed_s}s`), h("span", {}, ago(row.created)),
        res.data_from && Date.now() / 1000 - res.data_from > 1800 ? h("span", { class: "badge warn", title: "Filtering reuses saved flights. Press Search again to fetch fresh prices." }, `Flight data from ${ago(res.data_from)} · Search again to refresh`) : null)),
    h("div", { class: "actions" },
      h("button", { class: "btn res-edit", type: "button", onclick: () => { writeForm(requestToForm(q)); onFormChange(); showStep(1); } }, "Edit"),
      h("button", { class: "btn", type: "button", onclick: () => submitSearch(q) }, "Search again"))));
  res.warnings.forEach(w => box.append(h("div", { class: "note" }, w)));
  renderStepAirlines(res, q, cur, row);
  activateStep3(res, q, cur);
  if (!daily.length) {
    // Keep everything needed to change the filter: an airline filter that leaves no trips must not make the controls vanish.
    const filtered = (q.airlines_include || []).length || (q.airlines_exclude || []).length;
    const rest = [
      h("div", { class: "note" }, filtered
        ? "No trips match this airline filter. That airline may fly only one direction on these dates, or its flights may have no price (those are listed but never ranked). Change the filter in Step 2 on the left to continue."
        : "No trips matched. Try more stops, a wider window or a longer layover limit."),
      filtered ? h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => applyAirlineFilter(row, [], []) }, "Remove the airline filter")) : null,
      unpricedPanel(res, row)].filter(Boolean);
    box.append(...rest);
    if ((res.unpriced || []).length) watchRecheck(row);
    return;
  }

  // ---- derived picks
  const byDay = new Map(daily.map(d => [d.depart_date, d]));
  const cheapest = daily.reduce((a, b) => (b.cheapest.price < a.cheapest.price ? b : a));
  const best = daily.reduce((a, b) => (b.best_value.effective_cost < a.best_value.effective_cost ? b : a));
  const directs = daily.flatMap(d => [d.cheapest, d.best_value].map(t => [d, t])).filter(([, t]) => t.stops === 0);
  const direct = directs.length ? directs.reduce((a, b) => (b[1].price < a[1].price ? b : a)) : null;

  const view = viewStore.get(row.id) || { metric: "cheapest", tab: "chart", sel: cheapest.depart_date, pickOpen: null };
  viewStore.set(row.id, view);
  if (!byDay.has(view.sel)) view.sel = cheapest.depart_date;
  const tripOf = d => (view.metric === "cheapest" ? d.cheapest : d.best_value);
  const order = destOrder(q, daily);
  const colorOf = label => { const i = order.indexOf(label); return `var(--series-${i >= 0 && i < 8 ? i + 1 : "other"})`; };

  const pickDetail = h("div", { class: "pick-detail", hidden: true, "aria-live": "polite" });
  const picks = [
    { key: "cheapest", label: "Cheapest", d: cheapest, t: cheapest.cheapest, metric: "cheapest", hero: true },
    { key: "best", label: "Best value", d: best, t: best.best_value, metric: "best", hero: false },
    direct && { key: "direct", label: "Cheapest direct", d: direct[0], t: direct[1], metric: direct[1] === direct[0].cheapest ? "cheapest" : "best", hero: false },
  ].filter(Boolean);
  const pickBtns = picks.map(p => h("button", { type: "button", class: "pick" + (p.hero ? " hero-pick" : ""), "data-pick": p.key, "aria-expanded": "false", onclick: () => openPick(p.key) },
    h("span", { class: "k" }, p.label), h("span", { class: "v" }, money(p.t.price, cur)), origNote(p.t.price, cur),
    h("span", { class: "d" }, `${p.t.destination} · ${fmtDay(day(p.t.depart_date))} → ${fmtDay(day(p.t.return_date))}`),
    h("span", { class: "tm" }, h("b", {}, "Out"), `${fmtDay(day(p.t.legs[0].segments[0].departs))} · ${tmLine(p.t.legs[0])}`),
    h("span", { class: "tm" }, h("b", {}, "Back"), `${fmtDay(day(p.t.legs[p.t.legs.length - 1].segments[0].departs))} · ${tmLine(p.t.legs[p.t.legs.length - 1])}`),
    h("span", { class: "s" }, `${tripLen(p.t.nights)} · ${p.t.stops === 0 ? "direct" : plural(p.t.stops, "stop")} · ${hm(p.t.total_travel_min)} in transit`),
    h("span", { class: "more" }, h("span", { class: "chev", "aria-hidden": "true" }, "▾"), h("span", { class: "more-t" }, "Flight details"))));
  // With several destinations and/or trip lengths there is no single "cheapest trip": show the trip-length x destination matrix
  // and the grouped trips table (compare.js). One combination only (or a search saved before `cells` existed) keeps the three picks.
  const useCompare = (res.cells || []).length > 1;
  if (phone) {
    // Mobile.results() below shows the picks and every trip as compact rows instead
  } else if (useCompare) {
    const cmpHost = h("div", { class: "cmp" });
    box.append(cmpHost);
    Compare.render(cmpHost, { res, q, cur, pax: paxCount(q), state: (view.cmp ||= {}) });
  } else {
    box.append(h("div", { class: "picks" }, pickBtns, direct ? null : h("div", { class: "pick static" }, h("span", { class: "k" }, "Direct flights"), h("span", { class: "v" }, "None"), h("span", { class: "s" }, "No nonstop trips in this window."))), pickDetail);
    const routePicksEl = routePicks(res, cur, paxCount(q), q.destinations.length);
    if (routePicksEl) box.append(routePicksEl);
  }
  function syncPicks() {
    pickBtns.forEach(b => {
      const open = view.pickOpen === b.dataset.pick;
      b.classList.toggle("open", open); b.setAttribute("aria-expanded", String(open));
      $(".chev", b).textContent = open ? "▴" : "▾"; $(".more-t", b).textContent = open ? "Hide details" : "Flight details";
    });
    const p = picks.find(x => x.key === view.pickOpen);
    pickDetail.hidden = !p;
    pickDetail.replaceChildren(...(p ? [tripCard(p.t, cur, paxCount(q))] : []));
  }
  function openPick(key) {
    const p = picks.find(x => x.key === key);
    view.pickOpen = view.pickOpen === key ? null : key;
    if (view.pickOpen) { view.metric = p.metric; view.sel = p.d.depart_date; syncMetric(); }
    syncPicks();
    if (view.pickOpen) pickDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const unpricedPanelEl = unpricedPanel(res, row);
  if (unpricedPanelEl) { box.append(unpricedPanelEl); watchRecheck(row); }

  // ---- chart panel
  const chartHost = h("div", { class: "chart" }), tableHost = h("div", { class: "table-wrap", hidden: true });
  const legendHost = h("div", { class: "legend" });
  const metricBtns = [["cheapest", "Cheapest"], ["best", "Best value"]].map(([m, label]) =>
    h("button", { type: "button", "data-m": m, "aria-pressed": String(view.metric === m), onclick: () => { view.metric = m; syncMetric(); redraw(); drawDetail(); } }, label));
  const tabBtns = [["chart", "Chart"], ["table", "Table"]].map(([t, label]) =>
    h("button", { type: "button", "data-t": t, "aria-pressed": String(view.tab === t), onclick: () => { view.tab = t; syncTabs(); redraw(); } }, label));
  const syncMetric = () => { metricBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === view.metric))); redraw(); drawDetail(); };
  const syncTabs = () => tabBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === view.tab)));
  const chartPanel = h("div", { class: "card panel" },
    h("div", { class: "panel-head" },
      h("div", {}, h("h3", {}, "Price by departure day"),
        h("p", {}, "Each column is the trip leaving that day. Click one for details.")),
      h("div", { class: "actions" }, h("div", { class: "tabs", role: "group", "aria-label": "Metric" }, metricBtns), h("div", { class: "tabs", role: "group", "aria-label": "View" }, tabBtns))),
    legendHost, chartHost, tableHost);

  const mixHost = h("div", { class: "mm" });
  const mixPanel = h("div", { class: "card panel" }, h("div", { class: "panel-head" }, h("div", {}, h("h3", {}, "Mix & match flights"),
    h("p", {}, "Every flight for the day you picked on the chart. Choose any outbound with any return: the total and the time between them update."))));
  const detailHost = h("div", { class: "trips" });
  const selectedDay = h("div", {}, h("h3", { class: "sec-h" }, "Selected day"), detailHost);
  if (phone) Mobile.results(box, { res, q, cur, pax: paxCount(q), state: (view.mobile ||= {}), days: [chartPanel, selectedDay], mix: [mixPanel, mixHost] });
  else {
    box.append(chartPanel, mixPanel, mixHost, selectedDay);
    if (res.top.length) box.append(h("div", {}, h("h3", { class: "sec-h" }, "Top picks overall"),
      h("div", { class: "trips" }, res.top.map(t => tripCard(t, cur, paxCount(q))))));
  }

  function select(date) { view.sel = date; if (view.pickOpen) { view.pickOpen = null; syncPicks(); } redraw(); drawDetail(); }
  function drawDetail() {
    const d = byDay.get(view.sel), trip = d && tripOf(d);
    const extra = trip ? (res.unpriced || []).filter(u => trip.legs.some(l => l.segments[0].departs.slice(0, 10) === u.date && l.origin === u.origin && l.destination === u.destination)) : [];
    detailHost.replaceChildren(...[trip ? (phone ? Mobile.card(trip, cur, paxCount(q)) : tripCard(trip, cur, paxCount(q))) : h("div", { class: "note" }, "Pick a day on the chart."),
      extra.length ? h("div", { class: "note" }, h("b", {}, "Also flying that day, but Google shows no price: "),
        extra.map(u => `${u.flights} ${u.airline} ${fmtTime(day(u.departs))}→${fmtTime(day(u.arrives))} (${u.origin}→${u.destination})`).join("  ·  ")) : null].filter(Boolean));
    MixMatch.render(mixHost, { row, q, res, trip, outDate: view.sel, days: [...byDay.keys()].sort(), onPickDay: date => select(date), paxLabel: paxLabel(q) });
  }
  const days = (() => {
    const first = day(daily[0].depart_date), last = day(daily[daily.length - 1].depart_date), out = [];
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) out.push(iso(d));
    return out;
  })();
  let lastW = 0;
  function redraw() {
    const shown = days.map(dt => ({ date: dt, trip: byDay.has(dt) ? tripOf(byDay.get(dt)) : null }));
    const labels = [...new Set(shown.filter(x => x.trip).map(x => x.trip.destination))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    legendHost.replaceChildren(...(labels.length > 1 ? labels.map(l => h("span", {}, h("i", { style: `background:${colorOf(l)}` }), l)) : []));
    chartHost.hidden = view.tab !== "chart"; tableHost.hidden = view.tab !== "table";
    if (view.tab === "chart") { lastW = chartHost.clientWidth; drawChart(chartHost, shown, view.sel, colorOf, cur, select); }
    else drawTable(tableHost, shown.filter(x => x.trip), view.sel, cur, select);
  }
  new ResizeObserver(() => { if (view.tab === "chart" && chartHost.clientWidth && Math.abs(chartHost.clientWidth - lastW) > 2) redraw(); }).observe(chartHost);
  redraw(); drawDetail(); syncPicks();
  if (!opts.keepScroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Destination order = colour identity: requested destinations first (fixed), then any other route labels.
function destOrder(q, daily) {
  const seen = [...q.destinations];
  for (const d of daily) for (const t of [d.cheapest, d.best_value]) if (!seen.includes(t.destination)) seen.push(t.destination);
  return seen;
}

// ------------------------------------------------------------------ chart (SVG, no libs)
function niceScale(maxVal) {
  const rough = maxVal / 4 || 1, pow = 10 ** Math.floor(Math.log10(rough)), f = rough / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  return { step, max: Math.ceil(maxVal / step) * step };
}
const barPath = (x, top, w, base) => {
  const r = Math.min(4, w / 2, base - top);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
};
function drawChart(host, shown, sel, colorOf, cur, onSelect) {
  host.replaceChildren();
  const W = Math.max(320, host.clientWidth || 640), H = 280, m = { l: 48, r: 8, t: 28, b: 32 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b, N = shown.length, slot = plotW / N, bw = Math.min(24, Math.max(3, slot - 2));
  const target = shownCur(cur), pv = t => toShown(t.price, cur);            // scale and label in the currency being shown
  const prices = shown.filter(x => x.trip).map(x => pv(x.trip)), { step, max } = niceScale(Math.max(...prices));
  const y = v => m.t + plotH - (v / max) * plotH, base = m.t + plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Price by departure day, ${prices.length} days` });
  for (let v = 0; v <= max + 1e-9; v += step) {
    svg.append(s("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }),
      s("text", { class: "tick", x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, fmtMoney(v, target)));
  }
  const cheapestI = shown.findIndex(x => x.trip && pv(x.trip) === Math.min(...prices));
  const every = Math.max(1, Math.ceil(50 / slot));
  host.classList.toggle("has-sel", !!sel);
  const layer = s("g"), hits = s("g");
  shown.forEach((x, i) => {
    const cx = m.l + i * slot + slot / 2;
    if (i % every === 0) svg.append(s("text", { class: "tick", x: cx, y: H - 10, "text-anchor": "middle" }, fmtShort(day(x.date))));
    if (!x.trip) return;
    const bx = cx - bw / 2, bar = s("path", { class: "bar" + (x.date === sel ? " sel" : ""), d: barPath(bx, y(pv(x.trip)), bw, base), fill: colorOf(x.trip.destination) });
    layer.append(bar);
    if (i === cheapestI) layer.append(s("text", { class: "vlabel", x: cx, y: y(pv(x.trip)) - 7, "text-anchor": "middle" }, fmtMoney(pv(x.trip), target)));
    const hit = s("rect", { class: "hit", x: m.l + i * slot, y: m.t, width: slot, height: plotH, tabindex: "0", role: "button",
      "aria-label": `${fmtDay(day(x.date))}: ${money(x.trip.price, cur)} to ${x.trip.destination}, ${x.trip.stops === 0 ? "direct" : plural(x.trip.stops, "stop")}` });
    const on = ev => { bar.classList.add("hot"); showTip(x, colorOf(x.trip.destination), cur, ev, hit); };
    const off = () => { bar.classList.remove("hot"); $("#tooltip").hidden = true; };
    hit.addEventListener("pointerenter", on); hit.addEventListener("pointermove", on); hit.addEventListener("pointerleave", off);
    hit.addEventListener("focus", on); hit.addEventListener("blur", off);
    hit.addEventListener("click", () => onSelect(x.date));
    hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(x.date); } });
    hits.append(hit);
  });
  svg.append(layer, hits);
  host.append(svg);
}
function showTip(x, color, cur, ev, target) {
  const t = x.trip, tip = $("#tooltip");
  tip.replaceChildren(
    h("div", { class: "t-date" }, `${fmtDay(day(t.depart_date))} → ${fmtDay(day(t.return_date))}`),
    h("div", { class: "t-val" }, money(t.price, cur)),
    h("div", { class: "t-row" }, h("span", { class: "key", style: `background:${color}` }), h("b", {}, t.destination), `· ${tripLen(t.nights)}`),
    h("div", { class: "t-row" }, `${airlineNames(t.airlines)} · ${t.stops === 0 ? "direct" : plural(t.stops, "stop")} · ${hm(t.total_travel_min)}`),
    h("div", { class: "t-row" }, h("b", {}, "Out"), tmShort(t.legs[0])), h("div", { class: "t-row" }, h("b", {}, "Back"), tmShort(t.legs[t.legs.length - 1])));
  tip.hidden = false;
  const r = target.getBoundingClientRect(), px = ev && ev.clientX ? ev.clientX : r.left + r.width / 2, py = ev && ev.clientY ? ev.clientY : r.top;
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, px - w / 2))}px`;
  tip.style.top = `${py - hgt - 14 < 8 ? py + 18 : py - hgt - 14}px`;
}
function drawTable(host, rows, sel, cur, onSelect) {
  const head = ["Depart", "Return", "Nights", "Destination", "Out", "Back", "Airlines", "Type", "Travel"].map(t => h("th", {}, t));
  host.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, head, h("th", { class: "r" }, "Price"))),
    h("tbody", {}, rows.map(({ date, trip: t }) => h("tr", { class: date === sel ? "sel" : null, tabindex: "0", onclick: () => onSelect(date),
      onkeydown: e => { if (e.key === "Enter") onSelect(date); } },
      h("td", {}, fmtDay(day(t.depart_date))), h("td", {}, fmtDay(day(t.return_date))), h("td", {}, t.nights), h("td", {}, t.destination),
      h("td", {}, tmShort(t.legs[0])), h("td", {}, tmShort(t.legs[t.legs.length - 1])),
      h("td", { class: "air-names", title: t.airlines.join(", ") }, airlineNames(t.airlines)), h("td", {}, t.stops === 0 ? "Direct" : plural(t.stops, "stop")), h("td", {}, hm(t.total_travel_min)),
      h("td", { class: "price" }, money(t.price, cur)))))));
}

// ------------------------------------------------------------------ airlines
function resolveAirline(text) {
  const t = text.trim(), up = t.toUpperCase(), names = config.airlines || {}, q = t.toLowerCase();
  if (!t) return [];
  if (names[up]) return [up];
  const exact = Object.entries(names).filter(([, n]) => n.toLowerCase() === q).map(([c]) => c);
  if (exact.length) return exact;
  if (q.length >= 3) { const part = Object.entries(names).filter(([, n]) => n.toLowerCase().includes(q)).map(([c]) => c); if (part.length) return part; }
  return /^[A-Z0-9]{2}$/.test(up) ? [up] : [];
}
// Matching airlines for the dropdown, code/name-prefix matches first, then substring matches.
function airlineCandidates(text, max = 8) {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const names = config.airlines || {};
  const starts = [], contains = [];
  for (const [code, name] of Object.entries(names)) {
    const lc = name.toLowerCase();
    if (code.toLowerCase() === q || code.toLowerCase().startsWith(q) || lc.startsWith(q)) starts.push({ code, name });
    else if (lc.includes(q)) contains.push({ code, name });
  }
  return [...starts, ...contains].slice(0, max);
}

function airlineTags(root, { onChange }) {
  let values = [], items = [], active = -1;
  const input = h("input", { id: "air-in", type: "text", placeholder: "Ryanair, FR…", role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", autocomplete: "off" });
  const list = h("ul", { class: "ac-list", role: "listbox", hidden: true });
  const note = h("span", { class: "ac-empty-note" }, "None — all airlines shown");
  root.append(note, input, list);

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const draw = () => {
    $$(".chip", root).forEach(c => c.remove());
    values.forEach(code => root.insertBefore(h("span", { class: "chip" }, config.airlines[code] ? `${code} · ${config.airlines[code]}` : code,
      h("button", { type: "button", "aria-label": `Remove ${code}`, onclick: e => { e.stopPropagation(); values = values.filter(v => v !== code); draw(); onChange(); } }, "×")), input));
    note.hidden = values.length > 0;
    // The note already says "None" when empty; don't also show a placeholder that repeats it.
    input.placeholder = values.length ? "Add another…" : "";
  };
  const pick = (code) => {
    if (!values.includes(code)) values.push(code);
    input.value = ""; close(); draw(); onChange();
  };
  const add = () => {
    const codes = resolveAirline(input.value);
    if (!codes.length) return;
    codes.forEach(c => { if (!values.includes(c)) values.push(c); });
    input.value = ""; close(); draw(); onChange();
  };
  const show = () => {
    note.hidden = values.length > 0 || input.value.length > 0;
    items = airlineCandidates(input.value).filter(a => !values.includes(a.code));
    const rows = items.map((a, i) => h("li", { role: "option", "aria-selected": String(i === active), onmousedown: e => { e.preventDefault(); pick(a.code); } },
      h("span", { class: "ac-code" }, a.code), h("span", {}, h("div", { class: "ac-city" }, a.name))));
    list.replaceChildren(...rows);
    list.hidden = !rows.length; input.setAttribute("aria-expanded", String(rows.length > 0));
  };
  input.addEventListener("input", () => { active = -1; show(); });
  input.addEventListener("focus", show);
  input.addEventListener("blur", () => setTimeout(() => { add(); close(); }, 120));
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (list.hidden) show();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1);
      $$("li[role=option]", list).forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (active >= 0 && items[active]) pick(items[active].code); else add();
    } else if (e.key === "Backspace" && !input.value && values.length) { values.pop(); draw(); onChange(); }
    else if (e.key === "Escape") close();
  });
  root.addEventListener("click", () => input.focus());
  draw();
  return { get: () => [...values], set: arr => { values = [...arr]; draw(); } };
}

// ---- Airline filter. ONE filter state (the form's Airlines field) drives everything: the chips under the results header,
// the airline panel and the next "Find flights". Changing it re-filters the results IN PLACE from the flights already saved
// (no lookups, no progress screen), and says how old that data is.
let filterSeq = 0, airPanelOpen = null;
function syncFormFilter(include, exclude) {
  const only = include.length > 0;
  ($$("input[name=airmode]").find(r => r.value === (only ? "only" : "exclude")) || {}).checked = true;
  ac.air.set(only ? include : exclude);
  onFormChange();
}
async function applyAirlineFilter(row, include, exclude) {
  syncFormFilter(include, exclude);
  const seq = ++filterSeq, box = $("#results");
  box.classList.add("dim");
  try {
    const fresh = await post(`/api/searches/${row.id}/filter`, { airlines_include: include, airlines_exclude: exclude });
    if (seq === filterSeq && current === row.id) { renderResult(fresh, { keepScroll: true }); refreshHistory(); }
  } catch (e) { toast(e.message); }
  finally { if (seq === filterSeq) box.classList.remove("dim"); }
}
const excludeAfterToggle = (list, code) => {
  const sel = new Set(list.filter(a => a.included).map(a => a.code));
  sel.has(code) ? sel.delete(code) : sel.add(code);
  return list.filter(a => !sel.has(a.code)).map(a => a.code);
};

// Chip bar under the results header: click a chip to exclude/include that airline, "only" to keep just it, "Show all" to clear.
function airlineBar(res, q, row) {
  const list = res.airlines || [];
  if (list.length < 1) return null;
  const active = (q.airlines_include || []).length || (q.airlines_exclude || []).length;
  const used = list.filter(a => a.included).length;
  // Row 1: what was searched + Edit search, and the filter state on the right. Row 2: every airline as a chip (they wrap, never clip).
  return h("div", { class: "ab" },
    h("div", { class: "ab-top" },
      h("span", { class: "ab-sum", title: "The search these results are for" }, `✈ ${q.origin} → ${q.destinations.join(", ")} · ${fmtShort(day(q.window_start))} – ${fmtShort(day(q.window_end))} · ${lenRange(q.min_nights, q.max_nights)}`),
      h("button", { type: "button", class: "btn small", onclick: () => { writeForm(requestToForm(q)); onFormChange(); showStep(1); } }, "Edit search"),
      h("span", { class: "ab-fill" }),
      h("span", { class: "hint" }, active ? `Filter on: ${used} of ${list.length} airlines used` : `${list.length} airlines found`),
      active ? h("button", { type: "button", class: "btn small ghost", onclick: () => applyAirlineFilter(row, [], []) }, "Show all") : null),
    h("div", { class: "ab-row" }, h("span", { class: "af-label" }, "Airlines"),
      h("div", { class: "ab-chips" }, list.map(a => h("span", { class: "ab-chip" + (a.included ? "" : " off") },
        h("button", { type: "button", class: "ab-name", "aria-pressed": String(a.included), title: a.included ? `Exclude ${airlineName(a.code, a.name)}` : `Include ${airlineName(a.code, a.name)}`,
          onclick: () => applyAirlineFilter(row, [], excludeAfterToggle(list, a.code)) }, airlineName(a.code, a.name)),
        h("button", { type: "button", class: "ab-solo", title: `Only ${airlineName(a.code, a.name)}`, onclick: () => applyAirlineFilter(row, [a.code], []) }, "only")))))) ;
}

// The detailed airline list (prices and directions). It shares the same filter, and remembers whether you opened it.
function airlinePanel(res, q, cur, row) {
  const list = res.airlines || [];
  if (!list.length) return null;
  const search = h("input", { type: "search", class: "air-search", placeholder: "Does an airline fly here? Type a name or code…", "aria-label": "Find an airline" });
  const host = h("div", { class: "air-list" });
  const routeChip = (a, r) => h("span", { class: "rt" + (a.nonstop.includes(r) ? " ns" : "") }, `${r.replace(">", " → ")} · ${a.nonstop.includes(r) ? "nonstop" : "with a stop"}${(a.no_price_routes || []).includes(r) ? " · no price" : ""}`);
  function draw() {
    const term = search.value.trim().toLowerCase();
    const shown = list.filter(a => !term || airlineName(a.code, a.name).toLowerCase().includes(term) || a.code.toLowerCase().includes(term));
    host.replaceChildren(...(shown.length ? shown.map(a => h("div", { class: "air-row" + (a.included ? "" : " off") },
      h("label", { class: "air-name" }, h("input", { type: "checkbox", checked: a.included, "aria-label": `Include ${airlineName(a.code, a.name)}`, onchange: () => applyAirlineFilter(row, [], excludeAfterToggle(list, a.code)) }),
        h("span", { class: "an" }, airlineName(a.code, a.name)), h("span", { class: "ac2" }, a.code), !a.included ? h("span", { class: "badge fail" }, "excluded") : null),
      h("span", { class: "ap2" + (a.cheapest == null ? " np" : "") }, a.cheapest == null ? "no price shown" : `from ${money(a.cheapest, cur)}`),
      h("span", { class: "routes" }, a.routes.map(r => routeChip(a, r))),
      h("button", { type: "button", class: "btn small ghost", onclick: () => applyAirlineFilter(row, [a.code], []) }, "Only")))
      : [h("div", { class: "note" }, term ? `No airline matching “${search.value.trim()}” was listed for these routes and dates. It may not fly them, or Google may not sell it there.` : "No airlines found.")]));
  }
  search.addEventListener("input", draw);
  const excluded = list.filter(a => !a.included).length;
  draw();
  const summary = h("summary", {}, `Airlines on these routes (${list.length})`, excluded ? h("span", { class: "badge warn" }, `${excluded} excluded`) : null);
  const panel = h("details", { class: "card panel air-panel", open: (airPanelOpen ?? excluded > 0) ? true : null },
    summary,
    h("p", { class: "air-help" }, "Every airline Google listed for these routes and dates. Tick or untick to filter: it applies instantly to everything on this page and to your next search."),
    h("div", { class: "air-tools" }, search), host);
  summary.addEventListener("click", () => { airPanelOpen = !panel.open; });     // remember what you chose across re-renders
  return panel;
}

// Flights Google lists but shows no fare for (often airlines that sell only on their own site, e.g. HiSky).
function nextCheckText(row) {
  const parts = [];
  if (row.next_check) { const m = Math.round((row.next_check * 1000 - Date.now()) / 60000); parts.push(`${m <= 0 ? "Next automatic check: any moment" : `Next automatic check in ${m < 90 ? `${m} min` : `${Math.round(m / 60)} h`}`}, while this search is open`); }
  if (row.rechecks) parts.push(`checked again ${plural(row.rechecks, "time")}`);
  return parts.join(" · ");
}
// While a search with unpriced flights is on screen, the page checks them again when the schedule says (polling.js).
// Nothing runs once the search or the page is closed.
function watchRecheck(row) {
  clearTimeout(recheckTimer);
  if (!row.next_check) return;
  const due = row.next_check * 1000 - Date.now();
  recheckTimer = setTimeout(async () => {
    if (current !== row.id) return;
    if (row.next_check * 1000 > Date.now()) { watchRecheck(row); return; }      // woke early (timers are capped at 20 min)
    try {
      const r = await post(`/api/searches/${row.id}/recheck`, {});
      if (current !== row.id) return;
      const gained = r.changed.before - r.changed.after;
      renderResult(r.search); refreshHistory();
      if (gained > 0) toast(`${plural(gained, "flight")} now ${gained === 1 ? "has" : "have"} a price`);
    } catch { row = { ...row, next_check: Date.now() / 1000 + 60 }; watchRecheck(row); }   // e.g. a manual recheck is running
  }, Math.max(1000, Math.min(due, 20 * 60000)));
}

// Browser-extension bridge (browser-extension/): lets a flight row trigger "search + select
// this exact flight" on the airline's own site, in the user's real browser (not our backend --
// server-side automation is blocked by El Al's bot detection, see docs/DESIGN.md). Optional:
// with no extension installed, buttons using this just don't render, no broken links.
// Airlines the extension covers come FROM the extension (content-bridge.js publishes browser-extension/airlines.json's
// codes on the page): {code: {name, status}}, status = verified | bespoke | learned | discover (first use teaches it).
const assistAirlines = () => { try { return JSON.parse(document.documentElement.dataset.skyhopAirlines || "{}"); } catch { return {}; } };
const EXTENSION_DRIVERS = { has: (code) => code in assistAirlines() };
const assistStatus = (code) => assistAirlines()[code]?.status;
const extensionAvailable = () => document.documentElement.dataset.skyhopExtension === "1";
// What the airline's own site calls a place ("Rome", not FCO) and the other codes it might search by (the city code ROM).
function placeInfo(code) {
  const a = airport(code);
  if (!a) return { name: "", codes: [code] };
  const city = a.city.split(/[- ]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const cityCodes = AIRPORTS.filter(x => x.rank === 2 && x.city === a.city && x.country === a.country).map(x => x.code);
  return { name: city, codes: [code, ...cityCodes] };
}
// "Check on <airline> site": with the extension, search THIS flight on the airline's own site (TLV-origin flights of airlines it
// covers); otherwise null and the caller keeps a plain link to the airline's site.
function assistFor(code, segments) {
  if (!extensionAvailable() || !EXTENSION_DRIVERS.has(code)) return null;
  const sg = segments.find(x => x.airline_code === code);
  if (!sg) return null;
  // Not tied to any one origin: a "url" template or one learned from the user is parameterised by {origin}, so it searches from wherever the
  // flight actually leaves. Only the two bespoke drivers (El Al, TAROM) are origin-locked, and that is THEIR real limit (El Al's own search
  // widget defaults to Tel Aviv; TAROM's direct link hardcodes it) -- not an assumption Skyhop makes about where you fly from.
  if (!assistAirlines()[code]?.anyOrigin && sg.origin !== "TLV") return null;
  return () => selectOnAirlineSite(code, sg.origin, sg.destination, sg.departs.slice(0, 10), `${code}${sg.flight_number}`, sg.departs.slice(11, 16));
}
// "Check on <airline> site": a button for EVERY airline, known or brand new, that takes you to the airline's own website and never to a search engine.
//   - the extension can search this flight on the airline's own site -> it does (opens a new tab, English where the driver can choose);
//   - otherwise the airline's real website opens, and the flight's details (number, route, date, time) are copied so you can paste them into
//     the airline's own search (the site's search can't be driven for airlines outside the extension's list);
//   - an airline we have no address for is looked up (our list, then Wikidata: /api/airline-site); while that runs the button says so, and if no
//     official website exists it says plainly "Couldn't find <airline>'s website" -- it never guesses.
// `segments` = that airline's flights of the trip, first to last.
const siteLookups = new Map();     // "code|name" -> Promise<{url, unavailable}>; a definite answer is kept, "couldn't check" is not (so it can be retried)
function lookupSite(code, name) {
  const key = `${code}|${name}`;
  if (!siteLookups.has(key)) {
    const p = api(`/api/airline-site?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`, { headers: { "X-Skyhop": "1" } })
      .then(j => ({ url: typeof j.url === "string" && /^https:\/\//.test(j.url) ? j.url : null, unavailable: !!j.unavailable }))
      .catch(() => ({ url: null, unavailable: true }));
    siteLookups.set(key, p);
    p.then(r => { if (r.unavailable) siteLookups.delete(key); });
  }
  return siteLookups.get(key);
}
function flightNote(segments) {
  return segments.map(s => `${s.airline_code}${s.flight_number} ${s.origin} → ${s.destination}, ${fmtDay(day(s.departs))} ${fmtTime(day(s.departs))}`).join(" · ");
}
function copyFlightNote(name, segments, searched) {
  const note = flightNote(segments);
  const told = ok => toast(searched ? `Opening ${name}'s own search for this route and day. ${ok ? "Flight copied" : "Flight"}: ${note}. Pick it there, and check the passengers.`
    : `Opening ${name}'s site. ${ok ? "Flight copied" : "Flight"}: ${note}. Search for it there.`);
  try { navigator.clipboard.writeText(`${name}: ${note}`).then(() => told(true), () => told(false)); } catch { told(false); }
}
// Without the extension (phones): an airline whose results page is a plain link opens already searched for this route and
// day. Links are the registry's verified ones (config.airline_search_urls) and the ones the desktop extension learned,
// shared through the Worker (sharedLinks, see loadSharedLinks). Filled like background.js fill().
let sharedLinks = {};
const fmtLinkDate = (iso, pat) => { const [Y, M, D] = iso.split("-"); return pat.replace("YYYY", Y).replace("YY", Y.slice(2)).replace("MM", M).replace("DD", D); };
function searchLink(code, segments) {
  const first = segments[0], dest = segments[segments.length - 1].destination, learned = sharedLinks[code] || {};
  const tpl = (learned.byDest || {})[dest] || learned.generic || (config.airline_search_urls || {})[code];
  if (!tpl) return null;
  const d = { origin: first.origin, dest, destcity: placeInfo(dest).codes.find(c => c !== dest) || dest };
  return tpl.replace(/\{(origin|dest|destcity)(?::(l))?\}/g, (_, k, l) => (l ? d[k].toLowerCase() : d[k]))
    .replace(/\{date(?::([A-Za-z\-\/.]+))?\}/g, (_, pat) => fmtLinkDate(first.departs.slice(0, 10), pat || "YYYY-MM-DD"));
}
async function loadSharedLinks() {
  const acct = SkyhopLocal.account;
  if (!acct.configured() || !acct.signedIn() || !acct.has("links")) return;
  try { sharedLinks = await acct.get("/links"); } catch (e) { toast(`Couldn't load the airline search links learned on your computer: ${e.message}`); }
}
function siteButton(code, name, segments) {
  const known = (config.airline_sites || {})[code];
  const search = assistFor(code, segments), searched = !search && searchLink(code, segments);
  const link = url => h("a", { class: "site-btn", href: url, target: "_blank", rel: "noopener noreferrer", "data-assist": search ? "1" : null,
    onclick: e => { e.stopPropagation(); if (search) { e.preventDefault(); search(); } else copyFlightNote(name, segments, !!searched); },
    title: search ? `Searches this flight on ${name}'s own site (opens a new tab)`
      : searched ? `Opens ${name}'s own results for ${segments[0].origin} → ${segments[segments.length - 1].destination} that day and copies this flight (${flightNote(segments)}); you pick it there`
      : `Opens ${name}'s own site and copies this flight's details (${flightNote(segments)}) to paste into their search` },
    searched ? `Search on ${name} site` : `Check on ${name} site`, h("span", { class: "ext", "aria-hidden": "true" }, "↗"));
  if (searched) return link(searched);
  if (known || search) return link(known || "#");
  const el = h("span", { class: "site-btn checking", role: "status", title: `Looking for ${name}'s official website` }, `Looking for ${name}'s website…`);
  const settle = (node) => {
    lookupSite(code, name).then(({ url, unavailable }) => {
      if (url) { (config.airline_sites ||= {})[code] = url; node.replaceWith(link(url)); }
      else if (unavailable) {
        // Not the same as "no website": the lookup service could not be asked right now. Offer to ask again.
        const retry = h("button", { type: "button", class: "site-btn retry", title: `The website lookup is busy or offline right now, so Skyhop can't say whether ${name} has one. Click to try again.`,
          onclick: e => { e.stopPropagation(); const again = h("span", { class: "site-btn checking", role: "status" }, `Looking for ${name}'s website…`); retry.replaceWith(again); settle(again); } },
          `Couldn't check ${name}'s website right now. Try again`);
        node.replaceWith(retry);
      } else node.replaceWith(h("span", { class: "site-btn missing", role: "note",
        title: `Skyhop could not find an official website for ${name}, so it won't guess. Flight: ${flightNote(segments)}` }, `Couldn't find ${name}'s website`));
    });
  };
  settle(el);
  return el;
}
// The airlines of a list of segments in flight order: [[code, name, [their segments]], ...]
const airlinesOfSegments = segs => [...segs.reduce((m, sg) => (m.has(sg.airline_code) ? m : m.set(sg.airline_code, [airlineName(sg.airline_code, sg.airline), []])), new Map()).entries()]
  .map(([code, [name]]) => [code, name, segs.filter(x => x.airline_code === code)]);
function selectOnAirlineSite(airline_code, origin, destination, dateISO, flightNumber, departTime) {
  const from = placeInfo(origin), to = placeInfo(destination);
  window.dispatchEvent(new CustomEvent("skyhop-select-flight", {
    detail: { airline: airline_code, origin, destination, day: dateISO, flightNumber, departTime,
      originName: from.name, destinationName: to.name, destCodes: to.codes },
  }));
  toast(`Opening ${airline_code} — searching for ${flightNumber || "that flight"}…`);
  // An orphaned content script (extension reloaded, page not) never answers at all.
  extReplyTimer = setTimeout(() => toast("The extension didn't respond — refresh this page (F5) and try again"), 2500);
}
let extReplyTimer;
window.addEventListener("skyhop-progress", (e) => {
  clearTimeout(extReplyTimer);
  const { stage, text } = e.detail || {};
  toast(`Assist ${stage === "ERR" ? "failed" : `step ${stage}`}: ${text}`);
});
window.addEventListener("skyhop-select-flight-result", (e) => {
  clearTimeout(extReplyTimer);
  const r = e.detail || {};
  if (!r.ok) toast(`Couldn't open the airline site automatically: ${r.error || "the extension gave no reason"}`);
});

function unpricedPanel(res, row) {
  const list = res.unpriced || [];
  if (!list.length) return null;
  const btn = h("button", { type: "button", class: "btn small", onclick: async () => {
    btn.disabled = true; btn.textContent = "Checking…";
    try {
      const r = await post(`/api/searches/${row.id}/recheck`, {});
      const gained = r.changed.before - r.changed.after;
      toast(gained > 0 ? `${plural(gained, "flight")} now ${gained === 1 ? "has" : "have"} a price` : "Still no price for those flights");
      renderResult(r.search); refreshHistory();
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Recheck now"; }
  } }, "Recheck now");
  return h("details", { class: "card panel air-panel", open: true },
    h("summary", {}, `Flights listed without a price (${list.length})`, h("span", { class: "hint" }, "Google shows no fare for these")),
    h("p", { class: "air-help" }, "Google lists these flights but shows no fare (sometimes it shows it a few minutes later, so while this search is open Skyhop checks again on a schedule, every 15 minutes for departures within two weeks). They are not included in the prices or rankings above."),
    h("div", { class: "air-tools" }, btn, h("span", { class: "unp-status" }, nextCheckText(row))),
    h("div", { class: "air-list" }, list.map(u => h("div", { class: "unp-row" },
      h("span", { class: "unp-date" }, fmtDay(day(u.date))),
      h("span", { class: "unp-route" }, `${u.origin} → ${u.destination}`),
      h("span", { class: "unp-times" }, `${fmtTime(day(u.departs))} → ${fmtTime(day(u.arrives))}`, dayShift(day(u.departs), day(u.arrives)) > 0 ? ` +${dayShift(day(u.departs), day(u.arrives))}` : ""),
      h("span", { class: "unp-air" }, h("b", {}, u.flights), ` ${u.airline}`, u.stops ? ` · ${plural(u.stops, "stop")}` : " · nonstop",
        u.last_price != null ? h("span", { class: "badge warn", title: "Google showed this fare earlier and has since dropped it, so it may be out of date" }, `last seen ${money(u.last_price, row.request.currency)}, ${ago(u.last_seen)}`) : null),
      h("span", { class: "actions" },
        siteButton(u.airline_code, airlineName(u.airline_code, u.airline), [{ airline_code: u.airline_code, airline: u.airline, flight_number: u.flights.startsWith(u.airline_code) ? u.flights.slice(u.airline_code.length) : u.flights,
          origin: u.origin, destination: u.destination, departs: u.departs, arrives: u.arrives }]),
        h("button", { type: "button", class: "btn small", onclick: () => Builder.browse(u.origin, u.destination, u.date) }, "All flights that day"),
        u.link ? h("a", { class: "btn small", href: u.link, target: "_blank", rel: "noopener noreferrer" }, "Google Flights ↗") : null)))));
}

// ------------------------------------------------------------------ trip card
function tripCard(t, cur, pax = 1) {
  const titles = t.legs.length === 3 ? ["Outbound", "Between cities", "Return"] : ["Outbound", "Return"];
  const kind = { open_jaw: "Open-jaw", multi_stop: "Multi-city" }[t.kind];
  return h("article", { class: "card trip" },
    h("div", { class: "trip-head" },
      h("div", {}, h("div", { class: "trip-dest" }, t.destination, kind && h("span", { class: "badge run" }, kind), t.self_transfer && h("span", { class: "badge warn" }, "Self-transfer")),
        h("div", { class: "trip-dates" }, `${fmtDay(day(t.depart_date))} → ${fmtDay(day(t.return_date))} · ${tripLen(t.nights)}`)),
      h("div", { class: "trip-price" }, h("div", { class: "p" }, money(t.price, cur)), origNote(t.price, cur, "orig block"), h("div", { class: "e" }, pax > 1 ? `total for ${plural(pax, "traveller")}` : `value score ${Math.round(toShown(t.effective_cost, cur))}`))),
    t.legs.map((leg, i) => legCard(leg, titles[i] || "Leg", cur)),
    t.warnings.length ? h("div", { class: "warns" }, t.warnings.map(w => {
      const bad = /^(SELF|Long|Tight|Not enough)/.test(w);
      return h("div", { class: "warn" + (bad ? "" : " info") }, h("span", { "aria-hidden": "true" }, bad ? "⚠" : "ℹ"), w);
    })) : null,
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn small", onclick: () => Builder.addTrip(t, { pax: paxLabel(resultsQuery), currency: cur }) }, "＋ Add all flights to Trip builder"),
      roundTripButton(t, resultsQuery), verifyButton(t, titles),
      h("button", { type: "button", class: "btn small accent hub-save", title: "Put these flights on your trip in Travel Hub, next to its hotels and day-by-day map", onclick: () => saveToHub(t.legs.map(l => ({ ...l, currency: resultsQuery.currency }))) }, hubLabel())));
}
// ------------------------------------------------------------------ price check by a second source
/** Looks the trip's flights up again on the other fare source (local/verify.js). Demo fares have nothing to check against. */
function verifyButton(t, titles) {
  if (t.legs.some(l => l.provider === "mock")) return null;
  const btn = h("button", { type: "button", class: "btn small vf-check",
    title: "Looks these exact flights up again on the other fare source (Google Flights or SerpApi; SerpApi costs one credit per flight)",
    onclick: () => checkPrice(t, titles, btn) }, "Check price with a second source");
  return btn;
}
const VF_HEAD = { confirmed: src => `✓ ${src} shows the same price`, price_differs: src => `⚠ ${src} shows a different price`,
  not_found: src => `${src} doesn't list every flight`, error: src => `Couldn't check with ${src}` };
async function checkPrice(t, titles, btn) {
  const cur = resultsQuery.currency;
  btn.disabled = true; btn.textContent = "Checking…";
  let r;
  try { r = await post("/api/verify", { request: resultsQuery, legs: t.legs }); } catch (e) {
    btn.replaceWith(h("div", { class: "vf error" }, `Couldn't check the price: ${e.message}`));
    return;
  }
  const line = (v, i) => h("li", {}, `${titles[i] || "Leg"}: `, v.seen_price != null
    ? `${money(v.price, cur)} here, ${money(v.seen_price, cur)} on ${r.source}` : v.note);
  btn.replaceWith(h("div", { class: `vf ${r.status}` }, h("b", {}, VF_HEAD[r.status](r.source)), h("ul", {}, r.legs.map(line))));
}
// ------------------------------------------------------------------ Google's own round trip
/* Skyhop prices a trip as two one-way tickets, but an airline may sell the same dates as a cheaper return ticket.
   This opens Google Flights' round-trip search for the trip: the `tfs` query the Worker builds for one way (worker/src/gflights.js),
   with both legs and trip type 1 (the shape of Google's own links, decoded 2026-10-11). */
const pbVarint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const pbInt = (field, v) => [...pbVarint(field << 3), ...pbVarint(v)];
const pbBytes = (field, b) => [...pbVarint((field << 3) | 2), ...pbVarint(b.length), ...b];
const pbStr = (field, s) => pbBytes(field, [...new TextEncoder().encode(s)]);

function googleRoundTripUrl(out, back, q) {
  const place = code => [...pbInt(1, 1), ...pbStr(2, code)];   // 1 = airport
  const leg = (from, to, day) => pbBytes(3, [...pbStr(2, day), ...(q.max_stops_per_leg < 3 ? pbInt(5, q.max_stops_per_leg) : []),
    ...pbBytes(13, place(from)), ...pbBytes(14, place(to))]);
  const ages = q.children_ages || [];
  const pax = [...Array(q.adults + ages.filter(a => a >= 12).length).fill(1), ...Array(ages.filter(a => a >= 2 && a < 12).length).fill(2),
    ...Array(ages.filter(a => a < 2).length).fill(3)];
  const bags = q.carry_on_bags || q.checked_bags ? pbBytes(13, [...pbInt(2, q.carry_on_bags || 0), ...pbInt(3, q.checked_bags || 0)]) : [];
  const info = [...leg(out.origin, out.destination, out.segments[0].departs.slice(0, 10)), ...leg(back.origin, back.destination, back.segments[0].departs.slice(0, 10)),
    ...pbBytes(8, pax.flatMap(pbVarint)), ...pbInt(9, 1), ...bags, ...pbInt(19, 1)];
  return `https://www.google.com/travel/flights?${new URLSearchParams({ tfs: btoa(String.fromCharCode(...info)), hl: "en-US", curr: q.currency })}`;
}

/** Only for there-and-back trips: open-jaw and multi-city trips have no single return ticket to compare with. */
function roundTripButton(t, q) {
  const [out, back] = t.legs;
  if (!q || t.legs.length !== 2 || back.origin !== out.destination || back.destination !== out.origin) return null;
  const check = h("button", { type: "button", class: "btn small rt-check", title: "Asks Google Flights for its cheapest return ticket on these dates (free)",
    onclick: () => checkRoundTrip(t, q, check) }, "Check round-trip price");
  return [h("a", { class: "btn small", href: googleRoundTripUrl(out, back, q), target: "_blank", rel: "noopener noreferrer",
    title: "Skyhop adds up two one-way tickets; the same dates as one return ticket can cost less. Check Google's price." },
    "Compare with a round-trip ticket ↗"), check];
}
/** Puts Google's cheapest return ticket for the trip's dates next to Skyhop's two one-ways, or says why it can't. */
async function checkRoundTrip(t, q, btn) {
  const [out, back] = t.legs, cur = q.currency;
  btn.disabled = true; btn.textContent = "Asking Google…";
  let r;
  try {
    r = await post("/api/roundtrip", { request: q, origin: out.origin, dest: out.destination,
      date: out.segments[0].departs.slice(0, 10), return_date: back.segments[0].departs.slice(0, 10) });
  } catch (e) {
    btn.replaceWith(h("span", { class: "rt-result bad" }, `Couldn't get a round-trip price: ${e.message}`));
    return;
  }
  const said = r.price == null ? "Google showed no round-trip price for these dates"
    : `Google's cheapest return ticket on these dates: ${money(r.price, cur)} (any flights), `
      + (r.price < t.price ? `${money(t.price - r.price, cur)} less than these two one-way tickets` : "so these two one-way tickets are cheaper");
  btn.replaceWith(h("span", { class: "rt-result" + (r.price != null && r.price < t.price ? " cheaper" : "") }, said, " ",
    h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, "See it on Google ↗")));
}

function legTimes(leg) {
  const e = legEnds(leg), sh = dayShift(e.dep, e.arr);
  return h("div", { class: "leg-times" },
    h("div", { class: "lt" }, h("div", { class: "big" }, fmtTime(e.dep)), h("div", { class: "ap" }, e.from), h("div", { class: "dt" }, fmtDay(e.dep))),
    h("div", { class: "lt-mid" }, h("span", {}, hm(leg.duration_min)), h("span", { class: "line", "aria-hidden": "true" }), h("span", {}, leg.stops === 0 ? "direct" : plural(leg.stops, "stop"))),
    h("div", { class: "lt r" }, h("div", { class: "big" }, fmtTime(e.arr), sh > 0 ? h("sup", {}, `+${sh}`) : null), h("div", { class: "ap" }, e.to), h("div", { class: "dt" }, fmtDay(e.arr))));
}

/** Google's CO2 estimate and how it compares with the route's typical flight, worded as Google Flights does. */
function co2Note(leg) {
  if (leg.co2_g == null) return null;
  const kg = Math.round(leg.co2_g / 1000), diff = leg.co2_typical_g ? Math.round(100 * (leg.co2_g / leg.co2_typical_g - 1)) : null;
  const vs = diff == null ? "" : diff === 0 ? " · typical for this route" : ` · ${Math.abs(diff)}% ${diff > 0 ? "above" : "below"} typical`;
  return h("div", { class: "seg-meta co2", title: "Google Flights' estimate per passenger" }, `${kg} kg CO₂${vs}`);
}

function legCard(leg, title, cur) {
  const first = leg.segments[0], seen = new Map();
  leg.segments.forEach(s2 => { if (!seen.has(s2.airline_code)) seen.set(s2.airline_code, airlineName(s2.airline_code, s2.airline)); });
  const rows = leg.segments.flatMap((sg, i) => {
    const dep = day(sg.departs), arr = day(sg.arrives), lay = leg.layovers_min[i];
    const out = [h("div", { class: "seg-row" }, h("span", { class: "al" }, `${sg.airline_code}${sg.flight_number}`),
      h("div", { class: "seg-times" }, h("span", { class: "t" }, fmtTime(dep)), h("span", { class: "a" }, sg.origin), h("span", { class: "arrow" }, "→"),
        h("span", { class: "t" }, fmtTime(arr), arr.getDate() !== dep.getDate() ? " +1" : ""), h("span", { class: "a" }, sg.destination), h("span", { class: "a" }, sg.airline)))];
    const plane = [sg.aircraft, sg.legroom && `${sg.legroom} legroom`].filter(Boolean).join(" · ");
    if (plane) out.push(h("div", { class: "seg-meta" }, plane));
    if (lay != null) out.push(h("div", { class: "layover" }, h("span", { class: "badge " + (lay >= 480 ? "warn" : "ok") }, `${hm(lay)} layover in ${sg.destination}`)));
    return out;
  });
  const links = leg.deep_links.map((u, i) => h("a", { class: "btn small", href: u, target: "_blank", rel: "noopener noreferrer" },
    leg.deep_links.length > 1 ? `Google Flights · ticket ${i + 1} ↗` : "Google Flights ↗"));
  // With the extension on, the airline chip does the same as the "Select ... on site" button
  // (people click the obvious airline link first); it stays a plain link where no driver applies.
  const direct = airlinesOfSegments(leg.segments).map(([code, name, segs]) => siteButton(code, name, segs));   // one button per airline, always
  // Auto-select on the airline's own site (browser-extension/): one button per airline in this leg, whichever direction it flies --
  // assistFor already knows which origins each airline's driver can actually search from (see its comment).
  const autoSelect = extensionAvailable() ? airlinesOfSegments(leg.segments).map(([code, , segs]) => {
    const search = assistFor(code, segs);
    return search ? h("button", { type: "button", class: "btn small accent", title: assistStatus(code) === "discover" ? "First time for this airline: opens its site and learns its results page from ONE search you do by hand; after that this button does the search for you" : "Opens a new tab, searches and selects this flight on the airline's own site (you finish the booking there)",
      onclick: search }, `✈ Select ${code}${segs[0].flight_number} on site ↗`) : null;
  }).filter(Boolean) : [];
  const extra = [   // on a phone these fold under "More": the airline and Google Flights (where the price came from) stay in view
    h("button", { type: "button", class: "btn small", title: "See every flight that day, including ones with no price", onclick: () => Builder.browse(leg.origin, leg.destination, leg.segments[0].departs.slice(0, 10)) }, "All flights that day"),
    h("button", { type: "button", class: "btn small", onclick: () => Builder.addFlight(leg, { pax: paxLabel(resultsQuery), currency: cur }) }, "＋ Trip builder")];
  return h("div", { class: "leg" },
    h("div", { class: "leg-top" },
      h("div", { class: "leg-title" }, title, h("small", {}, [...seen.values()].join(" · "))),
      h("strong", { title: isConverted(cur) ? `Originally ${fmtMoney(leg.price, cur)}` : null }, money(leg.price, cur))),
    leg.usual_price ? h("div", { class: "seg-meta usual", title: "Google Flights' price insight for this search" },
      `Google: this search usually costs ${money(leg.usual_price[0], cur)}–${money(leg.usual_price[1], cur)}`) : null,
    legTimes(leg),
    rows, co2Note(leg), h("div", { class: "actions" }, autoSelect, links, direct, Mobile.isPhone() ? h("details", { class: "more-acts" }, h("summary", {}, "More"), h("div", { class: "actions" }, extra)) : extra));
}

// ------------------------------------------------------------------ chrome: theme, sidebar, init
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; }

const modeBadges = () => [$("#mode-badge"), $("#mode-badge-desk")];
function showMode() {
  const isMock = config.provider.split(",")[0].trim() === "mock";
  modeBadges().forEach(b => {
    b.hidden = false; b.className = "mode-badge " + (isMock ? "demo" : "live");
    b.textContent = isMock ? "⚠ DEMO DATA" : "LIVE";
    b.title = isMock ? "Fake prices from the mock provider -- nothing here is real" : `Live data from ${config.provider}`;
  });
}

// Google sign-in on the GitHub Pages build (local/account.js): signed in, searches use real fares through Skyhop's Worker.
function showAccount() {
  const acct = SkyhopLocal.account, email = acct.email();
  $$(".account-btn").forEach(b => {
    b.hidden = false;
    b.textContent = email ? "Sign out" : "Sign in";
    b.title = email ? `Signed in as ${email}. Searches use real fares.` : "Sign in with Google to search real fares instead of demo data";
  });
}
async function toggleAccount() {
  const acct = SkyhopLocal.account;
  try {
    if (acct.email()) { acct.signOut(); toast("Signed out: back to demo fares"); }
    else {
      const email = await acct.signIn();
      toast(acct.live() ? `Signed in as ${email}: fares are real now`
        : !acct.allowed() ? `Signed in as ${email}. Real fares are for invited accounts; trips shared with you still work.`
        : `Signed in as ${email}, but live fares aren't set up on Skyhop's server yet`);
    }
  } catch (e) { toast(e.message); }
  await refreshMode();
}
/** The phone's browser, opened by the Skyhop Android app to sign in (account.js appToken): Google refuses sign-in inside
    an app's web view, so it happens here and the token goes back to the app as a skyhop:// link. */
const APP_SCOPES = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"]);
function appSignInPage(q) {
  const scope = q.get("scope") || "openid email";
  const msg = h("p", {}, "The Skyhop app needs your Google sign-in. Google doesn't allow signing in inside apps, so you sign in here and go back to the app.");
  const back = h("a", { class: "btn", hidden: true }, "Back to the Skyhop app");
  const go = h("button", { type: "button", class: "btn primary", onclick: async () => {
    go.disabled = true;
    try {
      back.href = await SkyhopLocal.account.appSignIn(scope, q.get("hint") || "");
      go.hidden = true; back.hidden = false; msg.textContent = "Signed in. Tap below if the app didn't open by itself.";
      location.href = back.href;
    } catch (e) { msg.textContent = `Sign-in didn't finish: ${e.message}`; go.disabled = false; }
  } }, "Sign in with Google");
  if (!scope.split(" ").every(x => APP_SCOPES.has(x))) { msg.textContent = `This sign-in link asks for access Skyhop never uses (${scope}), so it was refused.`; go.hidden = true; }
  document.body.append(h("div", { class: "app-sign-in", role: "dialog", "aria-label": "Sign in for the Skyhop app" },
    h("div", { class: "card" }, h("h2", {}, "Sign in for the Skyhop app"), msg, go, back)));
}
/** Demo or real fares can change with sign-in and with joining a shared trip (a guest's fares are billed to it). */
async function refreshMode() {
  try { config = await api("/api/config"); } catch { /* keep */ }
  showMode(); if (SkyhopLocal.account.configured()) { showAccount(); shareJevRoute(); await loadSharedLinks(); } onFormChange();
}
/** On the web version there is no local server for the Airline Assist extension to ask Jev through, so tell it to use
    the Worker with this sign-in (content-bridge.js relays it); null when signed out. */
function shareJevRoute() {
  window.dispatchEvent(new CustomEvent("skyhop-jev-route", { detail: { route: SkyhopLocal.account.jevRoute() } }));
}

// A shared search link (chat.js shareLink): #search=<base64url JSON request> fills the form; the user presses Find flights.
function openSharedSearch() {
  const m = /^#search=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  try {
    const bytes = Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    writeForm(requestToForm(SkyhopLocal.models.searchRequest(JSON.parse(new TextDecoder().decode(bytes)))));
    onFormChange(); showStep(1);
    toast("Shared search loaded: press Find flights to run it");
  } catch { toast("That search link is broken or out of date"); }
  history.replaceState(null, "", location.pathname + location.search);
}

// Opened from Travel Hub (hub.js): the trip fills the form, and "Save to Travel Hub" later sends the picked flights back.
function openHubSearch() {
  const p = SkyhopHub.fromParams(location.search);
  if (!p) return;
  SkyhopHub.remember(p.context);
  writeForm({ ...readForm(), ...p.form }); onFormChange(); showStep(1);
  toast("Your Travel Hub trip is filled in: press Find flights");
  history.replaceState(null, "", location.pathname + location.hash);
  requestAnimationFrame(() => { const go = $("#go"); go.scrollIntoView({ block: "center" }); go.focus({ preventScroll: true }); });
}
const hubLabel = () => ((SkyhopHub.context() || {}).trip ? "✈ Save to my Travel Hub trip" : "✈ Save to Travel Hub");
/** Sends picked flights (leg views with the currency they were priced in, in travel order) to the hub's Trip; prices are totals for everyone in the search. */
function saveToHub(offers) {
  const ctx = SkyhopHub.context() || {}, q = resultsQuery || toRequest(readForm()).req || {};
  const data = SkyhopHub.payload(offers, { trip: ctx.trip, searchId: current ? String(current) : null, adults: q.adults || 1, kids: q.children_ages || [],
    currency: offers[0].currency, cityOf: c => (airport(c) || {}).city || "" });
  location.assign(SkyhopHub.handoffUrl(ctx.hub || SkyhopHub.DEFAULT_HUB, data));
}

async function init() {
  const saved = store.get("skyhop.theme"); if (saved) document.documentElement.dataset.theme = saved;
  $$(".theme-toggle").forEach(b => b.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark"; document.documentElement.dataset.theme = next; store.set("skyhop.theme", next);
  }));
  $("#menu").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; });
  $("#scrim").addEventListener("click", closeSidebar);
  try { config = await api("/api/config"); } catch (e) { toast(`Couldn't load Skyhop's settings: ${e.message}`); }
  showMode();
  if (SkyhopLocal.account.configured()) {
    const down = SkyhopLocal.account.unreachable();
    if (down) toast(`${down}. These are demo fares until it answers; reload to try again.`, 12000);
    showAccount(); shareJevRoute(); loadSharedLinks();
    $$(".account-btn").forEach(b => b.addEventListener("click", toggleAccount));
    window.addEventListener("skyhop-signed-out", async () => {
      toast("Your Google sign-in expired. Sign in again for real fares.");
      try { config = await api("/api/config"); } catch { /* keep */ }
      showMode(); showAccount(); shareJevRoute();
    });
    const q = new URLSearchParams(location.search);
    if (q.has("app-sign-in")) appSignInPage(q);
  }
  modeBadges().forEach(b => {
    // Airline Assist extension status, right next to the mode badge: the purple "Select on site"
    // buttons only exist when the extension is attached to this page, and without this there's no
    // way to tell "extension off" from "extension broken" (the plain "El Al ↗" link opens the
    // airline's homepage and never searches -- easy to mistake for the extension).
    const ext = h("span", { class: "mode-badge ext-badge" });
    b.after(ext);
    // Which decision model finds elements on airline pages: the local Laya service (free) or Jev (hosted, via OpenRouter,
    // the key stays on this server). Kept by the extension; only shown when the extension is attached.
    ext.after(h("button", { type: "button", class: "mode-badge dec-badge", onclick: switchDecider }));
  });
  const syncExtBadge = () => {
    const on = extensionAvailable();
    $$(".ext-badge").forEach(e => {
      e.classList.toggle("live", on); e.classList.toggle("demo", !on);
      e.textContent = on ? "✈ Assist on" : "✈ Assist off";
      e.title = on ? (window.SkyhopNative ? "Airline Assist is built into the app: flights show a purple \"Select on site\" button that opens the airline's site in the app's second tab"
          : "Airline Assist extension detected: flights show a purple \"Select on site\" button")
        : "Extension not detected on this page. Open chrome://extensions, make sure Skyhop Airline Assist is enabled, reload it, then reload this page. Until then only the plain airline homepage link works.";
    });
  };
  const decider = () => document.documentElement.dataset.skyhopDecider === "jev" ? "jev" : "laya";
  let deciderUp = null;   // null = not checked yet, true / false = the chosen backend answered / didn't
  const syncDecider = () => $$(".dec-badge").forEach(e => {
    const name = decider() === "jev" ? "Jev" : "Laya";
    e.hidden = !extensionAvailable();
    e.classList.toggle("live", deciderUp === true); e.classList.toggle("demo", deciderUp === false);
    e.textContent = `🧠 ${name}${deciderUp === false ? " ✕ not running" : ""}`;
    e.title = deciderUp === false ? `${name} isn't reachable, so Assist can't find elements on airline pages. ` + (decider() === "laya" ? "Start it with ~/laya-service/start.sh, or click to switch to Jev." : "Check your sign-in and the OpenRouter key on Skyhop's Worker, or click to switch to Laya.")
      : decider() === "jev" ? "Assist uses Jev (hosted, via OpenRouter, billed per call) to find elements on airline pages. Click to switch to the local Laya service."
      : "Assist uses the local Laya service to find elements on airline pages. Click to switch to Jev (hosted, via OpenRouter).";
  });
  // Is the chosen backend up? Asked on load, after a switch, and when the tab regains focus (so the badge recovers
  // once you start Laya). The answer comes from the extension, which does the real ping the drivers do first.
  let announceDecider = false, lastCheck = 0;
  const checkDecider = (announce) => { announceDecider = announce; lastCheck = Date.now(); window.dispatchEvent(new CustomEvent("skyhop-check-decider")); };
  window.addEventListener("skyhop-decider-status", (e) => {
    const r = e.detail || {}, was = deciderUp;
    deciderUp = !!r.ok; syncDecider();
    if (!r.ok && announceDecider) toast(decider() === "laya"
      ? `Laya isn't running (${r.error}). Start it with ~/laya-service/start.sh, or click the 🧠 badge to switch to Jev.`
      : `Jev isn't usable: ${r.error}`);
    if (r.ok && was === false && !announceDecider) toast(`${decider() === "jev" ? "Jev" : "Laya"} is running again`);
    announceDecider = false;
  });
  window.addEventListener("focus", () => { if (extensionAvailable() && Date.now() - lastCheck > 10000) checkDecider(false); });
  function switchDecider() {
    if (window.SkyhopNative) { toast("The app always uses Jev: Laya runs only on a computer"); return; }
    const next = decider() === "jev" ? "laya" : "jev";
    if (next === "jev" && !SkyhopLocal.account.jevRoute()) {        // Jev runs on Skyhop's Worker, as the signed-in user
      toast("Jev needs you signed in, with an OpenRouter key on Skyhop's Worker"); return;
    }
    window.dispatchEvent(new CustomEvent("skyhop-set-decider", { detail: { value: next } }));
    deciderUp = null; setTimeout(syncDecider, 300);
    toast(next === "jev" ? "Assist now uses Jev (billed per call via OpenRouter)" : "Assist now uses the local Laya service");
    setTimeout(() => checkDecider(true), 500);   // and say at once if the one just chosen isn't up
  }
  syncExtBadge(); setTimeout(syncExtBadge, 1500); // the content script can attach just after load
  syncDecider(); setTimeout(syncDecider, 500); setTimeout(syncDecider, 1500);
  setTimeout(() => { if (extensionAvailable()) checkDecider(true); }, 1200);   // on load / refresh: is the chosen one running?
  try { ratesInfo = await api("/api/rates"); rates = ratesInfo.rates; } catch (e) { ratesInfo.error = `couldn't load exchange rates: ${e.message}`; }
  showOriginal = !!store.get("skyhop.showOriginal");
  $("#orig-toggle").checked = showOriginal;
  $("#orig-toggle").addEventListener("change", e => setShowOriginal(e.target.checked));
  await loadAirports();
  const cfg = { onChange: onFormChange };
  ac = {
    air: airlineTags($("#ac-air"), cfg),
    from: autocomplete($("#ac-from"), { id: "from-in", placeholder: "City or airport", multi: false, ...cfg }),
    to: autocomplete($("#ac-to"), { id: "to-in", placeholder: "Rome, Paris, London…", multi: true, ...cfg }),
    back: autocomplete($("#ac-back"), { id: "back-in", placeholder: "Same as destination", multi: true, ...cfg }),
    hubs: autocomplete($("#ac-hubs"), { id: "hubs-in", placeholder: "IST, ATH, VIE…", multi: true, ...cfg }),
  };
  const draft = store.get("skyhop.form") || {};
  if (!store.get("skyhop.ils-default")) { draft.currency = "ILS"; draft.vot = VOT.ILS; store.set("skyhop.ils-default", true); }
  writeForm({ ...defaults(), ...draft });
  lastCurrency = displayCurrency = readForm().currency;
  if (day($("#end").value) < new Date()) writeForm({ ...readForm(), start: defaults().start, end: defaults().end });
  const lengthField = e => ["nmin", "nmax"].includes(e.target.id);
  $("#form").addEventListener("input", e => { if (e.target.id === "start" || e.target.id === "end") constrainLength(); onFormChange(); });
  $("#form").addEventListener("change", e => { if (lengthField(e)) lengthNote = ""; constrainLength(); onFormChange(); });
  $$("[data-step]").forEach(b => b.addEventListener("click", () => {
    lengthNote = "";
    const el = $(`#${b.dataset.for}`), v = (parseFloat(el.value) || 0) + +b.dataset.step;
    el.value = Math.min(+el.max || 99, Math.max(+el.min || 0, v));
    if (el.id === "nmin" && +$("#nmax").value < +el.value) $("#nmax").value = el.value;   // raising "from" pushes "to" up; "to" never goes below "from"
    constrainLength(); updateLengthHint(); onFormChange();
  }));
  $$("[data-nights]").forEach(b => b.addEventListener("click", () => {
    const [a, z] = b.dataset.nights.split("-"); lengthNote = ""; showLength(+a, +z); setLenMode("range"); onFormChange();
  }));
  $$("input[name=unit]").forEach(r => r.addEventListener("change", () => {
    const min = num("nmin", 1) - inOff(), max = num("nmax", 1) - inOff();       // the numbers are still in the previous unit here
    unit = r.value; lengthNote = ""; showLength(min, max); updateLengthHint(); onFormChange();
    if (currentRow && currentRow.id === current && currentRow.status === "done") renderResult(currentRow, { keepScroll: true });
    refreshHistory();
  }));
  // Expert mode: off = every length that fits the dates; on = the person's own length (back to what they had last time).
  $("#expert").addEventListener("change", () => {
    lengthNote = "";
    if ($("#expert").checked) { showLength(Math.min(lastExpert.nmin, lengthCap()), Math.min(lastExpert.nmax, lengthCap())); setLenMode(lastExpert.mode); }
    else setLenMode("any");
    onFormChange();
  });
  $$("input[name=lenmode]").forEach(r => r.addEventListener("change", () => { lengthNote = ""; setLenMode(r.value); onFormChange(); }));
  $("#add-kid").addEventListener("click", () => { if (kids.length < 8) { kids.push(5); renderKids(); onFormChange(); } });
  $("#new-search").addEventListener("click", () => {
    clearTimeout(pollTimer); current = null;
    $("#results").replaceChildren(h("div", { class: "card empty-state" }, "Fill in your trip above and hit \"Find flights\" to see results here."));
    writeForm({ ...defaults(), from: readForm().from });
    showStep(1); $("#step-1-summary").textContent = "";
    $("#step-2-summary").textContent = ""; $("#step2-airlines").replaceChildren(); $("#air-sticky").replaceChildren(); $("#air-sticky").hidden = true;
    $("#step-3").classList.remove("ready"); $("#step-3-summary").textContent = "Run a search to compare";
    onFormChange(); closeSidebar(); window.scrollTo({ top: 0, behavior: "smooth" }); $("#to-in").focus(); refreshHistory();
  });
  $("#step-1").addEventListener("click", () => showStep(1));
  $("#step-2").addEventListener("click", () => showStep(2));
  $("#step-3").addEventListener("click", () => {
    const picks = $(".picks, .cmp, .m-results");
    if (picks) picks.scrollIntoView({ behavior: "smooth", block: "start" }); else toast("Run a search first.");
  });
  $("#form").addEventListener("submit", async e => {
    e.preventDefault();
    const { req, error } = toRequest(readForm());
    if (error) { showFormError(error); return; }
    showFormError("");
    try { await submitSearch(req); } catch (err) { showFormError(err.message); }
  });
  Builder.init();
  Mobile.init({ onLayoutChange: () => { if (currentRow && currentRow.id === current && currentRow.status === "done") renderResult(currentRow, { keepScroll: true }); } });
  Finder.init();
  Chat.init();
  openSharedSearch();
  openHubSearch();
  refreshHistory(); runEstimate();
  setInterval(() => { if (!document.hidden && !pollTimer) refreshHistory(); }, 60000);
}
init();
