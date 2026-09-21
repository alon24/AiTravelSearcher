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

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = str => new Date(str.length === 10 ? str + "T00:00:00" : str);
const fmtDay = d => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const fmtShort = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const fmtTime = d => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const hm = m => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
// First departure and last arrival of a leg (times are local to each airport).
const legEnds = leg => { const a = leg.segments[0], z = leg.segments[leg.segments.length - 1]; return { dep: day(a.departs), arr: day(z.arrives), from: a.origin, to: z.destination }; };
const dayShift = (dep, arr) => Math.round((new Date(arr.getFullYear(), arr.getMonth(), arr.getDate()) - new Date(dep.getFullYear(), dep.getMonth(), dep.getDate())) / 864e5);
const tmLine = leg => { const e = legEnds(leg), sh = dayShift(e.dep, e.arr); return `${fmtTime(e.dep)} ${e.from} → ${fmtTime(e.arr)} ${e.to}${sh > 0 ? ` +${sh}` : ""}`; };
const tmShort = leg => { const e = legEnds(leg), sh = dayShift(e.dep, e.arr); return `${fmtTime(e.dep)}→${fmtTime(e.arr)}${sh > 0 ? `+${sh}` : ""}`; };
// Money. Prices come in the currency they were searched in; everything on screen is converted to the currency button's
// choice with today's rate (see /api/rates). `money` is the one place that does it.
let rates = { USD: 1, ILS: 3, GBP: 0.75, EUR: 0.87 }, ratesInfo = { source: "approximate", date: null }, displayCurrency = "ILS", showOriginal = false;
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
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = Array.isArray(j.detail) ? j.detail.map(d => d.msg).join("; ") : j.detail || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return r.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Trip length: the form counts nights or days (a 5-night trip spans 6 calendar days); the API always works in nights.
let unit = "nights";
const unitOff = () => (unit === "days" ? 1 : 0);
const tripLen = n => (unit === "days" ? `${plural(n + 1, "day")} (${plural(n, "night")})` : `${plural(n, "night")} (${plural(n + 1, "day")})`);
const lenRange = (a, b) => (a === b ? tripLen(a) : unit === "days" ? `${a + 1}–${b + 1} days (${a}–${b} nights)` : `${a}–${b} nights (${a + 1}–${b + 1} days)`);
let recheckTimer = 0, currentRow = null;
const viewStore = new Map();
function toast(msg) {
  const t = h("div", { class: "toast", role: "status" }, msg); document.body.append(t); setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
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
    code = code.toUpperCase();
    if (multi) { if (!values.includes(code) && values.length < max) values.push(code); } else values = [code];
    input.value = ""; close(); draw(); onChange();
  }
  function show() {
    const results = AirportSearch.search(AIRPORTS, input.value);
    items = results.map(r => r.a);
    const q = input.value.trim();
    const rows = items.map((a, i) => h("li", { role: "option", "aria-selected": String(i === active), onmousedown: e => { e.preventDefault(); pick(a.code); } },
      h("span", { class: "ac-code" }, a.code),
      h("span", {}, h("div", { class: "ac-city" }, a.city), h("div", { class: "ac-sub" }, `${a.name} · ${a.country}`))));
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
      if (active >= 0 && items[active]) { e.preventDefault(); pick(items[active].code); }
      else if (/^[A-Za-z]{3}$/.test(raw) && AIRPORTS.some(a => a.code === raw.toUpperCase())) { e.preventDefault(); pick(raw); }
      else if (items[0]) { e.preventDefault(); pick(items[0].code); }
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
  return { from: ["TLV"], to: [], back: [], start: plus(21), end: plus(60), nmin: 4, nmax: 7, stops: 1, currency: "ILS", adults: 1,
    airmode: "exclude", airlines: [], kids: [], connect: false, same: false, st: false, hubs: [], buffer: 4, maxtravel: "", laymin: 1.5, laymax: 72, vot: VOT.ILS, top: 5, maxcalls: 400 };
};
let ac = {};
let kids = [];   // ages of the children in the form
const num = (id, fallback) => { const v = parseFloat($(`#${id}`).value); return Number.isFinite(v) ? v : fallback; };

function readForm() {
  unit = $$("input[name=unit]").find(r => r.checked)?.value || "nights";
  return {
    from: ac.from.get(), to: ac.to.get(), back: ac.back.get(), hubs: ac.hubs.get(),
    start: $("#start").value, end: $("#end").value, nmin: num("nmin", 0) - unitOff(), nmax: num("nmax", 0) - unitOff(), unit,
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
  $("#start").value = f.start; $("#end").value = f.end; showLength(f.nmin, f.nmax);
  const r = $$("input[name=stops]").find(x => +x.value === f.stops) || $$("input[name=stops]")[1]; r.checked = true;
  ($$("input[name=currency]").find(r => r.value === f.currency) || $$("input[name=currency]")[0]).checked = true; $("#adults").value = f.adults;
  kids = [...(f.kids || [])]; renderKids();
  ($$("input[name=bags]").find(r => r.value === (f.bags || "none")) || {}).checked = true;
  ac.air.set(f.airlines || []); ($$("input[name=airmode]").find(r => r.value === (f.airmode || "exclude")) || {}).checked = true;
  $("#connect").checked = f.connect; $("#same").checked = f.same; $("#st").checked = f.st; $("#buffer").value = f.buffer;
  $("#maxtravel").value = f.maxtravel; $("#laymin").value = f.laymin; $("#laymax").value = f.laymax;
  displayCurrency = f.currency;
  $("#vot").value = f.vot; $("#vot-out").textContent = money(f.vot, f.currency) + "/h"; $("#top").value = f.top; $("#maxcalls").value = f.maxcalls;
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
  if (f.nmin < 1 || f.nmax < f.nmin) return err("Nights: the minimum must be at least 1 and no more than the maximum.");
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
    value_of_time_per_hour: f.vot, self_transfer_penalty: PENALTY[f.currency] ?? 40, top_n: f.top, max_api_calls: f.maxcalls,
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

// The currency button changes the whole screen: results, history, trip builder and airline finder.
function rerenderCurrency() {
  $("#vot-out").textContent = money(readForm().vot, displayCurrency) + "/h";
  if (currentRow && currentRow.id === current && currentRow.status === "done") renderResult(currentRow, { keepScroll: true });
  refreshHistory();
  if (window.Builder) Builder.refresh();
  if (window.Finder) Finder.refresh();
}

// Put a night range into the two inputs in the unit being shown, and explain what it means in calendar days.
function showLength(nmin, nmax) {
  const off = unitOff();
  for (const [id, n] of [["nmin", nmin], ["nmax", nmax]]) $(`#${id}`).value = n + off;
  constrainLength();
  updateLengthHint(num("nmin", 0) - off, num("nmax", 0) - off);
}

// The dates cap the trip length: leaving on the earliest date and coming back on the latest is the longest trip possible.
const addDays = (str, n) => { const d = day(str); d.setDate(d.getDate() + n); return iso(d); };
const windowNights = () => {
  const a = $("#start").value, b = $("#end").value;
  if (!a || !b) return null;
  const n = Math.round((day(b) - day(a)) / 864e5);
  return n >= 1 ? n : null;
};
let lengthAdjusted = false;
function constrainLength() {
  const off = unitOff(), cap = Math.min(60, windowNights() ?? 60);
  if ($("#start").value) $("#end").min = addDays($("#start").value, 1);          // the calendar will not offer a return before the start
  if ($("#end").value) $("#start").max = addDays($("#end").value, -1);
  let changed = false;
  for (const id of ["nmin", "nmax"]) {
    const el = $(`#${id}`), v = parseFloat(el.value);
    el.min = 1 + off; el.max = cap + off;
    if (Number.isFinite(v)) { const c = Math.min(cap + off, Math.max(1 + off, v)); if (c !== v) { el.value = c; changed = true; } }
  }
  if (+$("#nmin").value > +$("#nmax").value) { $("#nmin").value = $("#nmax").value; changed = true; }
  lengthAdjusted = changed;
  return changed;
}
function updateLengthHint(nmin, nmax) {
  const wn = windowNights();
  const what = nmin >= 1 && nmax >= nmin ? `${lenRange(nmin, nmax)}. The day you leave and the day you return both count as days.` : "";
  const cap = wn ? Math.min(60, wn) : null;
  const limit = cap ? ` Your dates allow up to ${tripLen(cap)}.${nmax >= cap ? " Move the latest return later for longer trips." : ""}` : "";
  $("#nights-hint").textContent = (lengthAdjusted ? "Adjusted to fit your dates. " : "") + what + limit;
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
    const primary = config.provider.split(",")[0].trim();
    const cost = primary === "serpapi" ? `uses ~${e.to_fetch} SerpApi credits` : primary === "mock" ? "demo data, no cost" : "free";
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
  updateLengthHint(f.nmin, f.nmax);
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
  try { rows = await api("/api/searches"); } catch { return; }
  const box = $("#history");
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
  if (row.status === "running") { renderProgress(row); pollTimer = setTimeout(() => openSearch(id), 900); return; }
  renderResult(row);
}

// ------------------------------------------------------------------ results
function renderProgress(row) {
  const { done, total } = row.progress, q = row.request;
  const fill = h("div", { class: "bar-fill" + (total ? "" : " indet"), style: total ? `width:${Math.max(4, Math.round(100 * done / total))}%` : null });
  $("#results").replaceChildren(h("div", { class: "card progress" },
    h("div", { class: "plane", "aria-hidden": "true" }, "✈️"),
    h("div", { class: "txt" }, total ? `Checking flights… ${done} of ${total}` : "Warming up…"),
    h("div", { class: "bar-track", role: "progressbar", "aria-valuenow": total ? done : null, "aria-valuemax": total || null }, fill),
    h("div", { class: "sub" }, `${q.origin} → ${q.destinations.join(", ")} · every day from ${fmtShort(day(q.window_start))} to ${fmtShort(day(q.window_end))}`)));
}

function renderResult(row, opts = {}) {
  clearTimeout(recheckTimer);
  currentRow = row;
  const box = $("#results"), q = row.request;
  resultsQuery = q;
  box.replaceChildren();
  if (row.status === "failed") {
    box.append(h("div", { class: "note bad" }, `This search failed: ${row.error}`),
      h("div", {}, h("button", { class: "btn", onclick: () => submitSearch(q) }, "Try again")));
    return;
  }
  const res = row.result, cur = q.currency, daily = res.daily;
  const nights = lenRange(q.min_nights, q.max_nights);
  const via = Object.entries(res.sources || {}).map(([k, n]) => `${k} ×${n}`).join(", ");
  box.append(h("div", { class: "res-head" },
    h("div", {},
      h("h2", {}, `${q.origin} → ${q.destinations.join(", ")}`),
      h("div", { class: "res-sub" }, `${fmtShort(day(q.window_start))} – ${fmtShort(day(q.window_end))} · ${nights}`,
        h("span", { class: "badge ok" }, `${res.api_calls + res.cache_hits} lookups${via ? ` · ${via}` : ""}${res.cache_hits ? ` · ${res.cache_hits} cached` : ""}`),
        paxCount(q) > 1 && h("span", { class: "badge run" }, `${paxLabel(q)} · totals`),
        (q.carry_on_bags || q.checked_bags) ? h("span", { class: "badge run", title: "Google adds estimated bag fees only where it has them (mostly US and Europe)" }, `🧳 est. fees for ${[q.carry_on_bags ? "cabin bag" : "", q.checked_bags ? "checked bag" : ""].filter(Boolean).join(" + ")} included`) : null,
        q.currency !== displayCurrency ? h("button", { type: "button", class: "badge warn conv-toggle", onclick: () => setShowOriginal(!showOriginal), title: `Searched in ${q.currency}. Shown in ${shownCur(q.currency)} at 1 ${shownCur(q.currency)} = ${(rates[q.currency] / rates[shownCur(q.currency)]).toFixed(3)} ${q.currency} (${ratesInfo.source}${ratesInfo.date ? `, ${ratesInfo.date}` : ""}). The airline's own price in that currency may differ a little.` }, showOriginal ? `Showing original ${q.currency} · click to convert to ${displayCurrency}` : `≈ Converted from ${q.currency} · click to see the original`) : null,
        h("span", { class: "badge run" }, `${res.elapsed_s}s`), h("span", {}, ago(row.created)))),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: () => { writeForm(requestToForm(q)); onFormChange(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "Edit"),
      h("button", { class: "btn", type: "button", onclick: () => submitSearch(q) }, "Search again"))));
  res.warnings.forEach(w => box.append(h("div", { class: "note" }, w)));
  if (!daily.length) { box.append(h("div", { class: "note" }, "No trips matched. Try more stops, a wider window or a longer layover limit.")); return; }

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
  box.append(h("div", { class: "picks" }, pickBtns, direct ? null : h("div", { class: "pick static" }, h("span", { class: "k" }, "Direct flights"), h("span", { class: "v" }, "None"), h("span", { class: "s" }, "No nonstop trips in this window."))), pickDetail);
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

  const airPanel = airlinePanel(res, q, cur);
  if (airPanel) box.append(airPanel);
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
  box.append(h("div", { class: "card panel" },
    h("div", { class: "panel-head" },
      h("div", {}, h("h3", {}, view.metric === "cheapest" ? "Price by departure day" : "Price by departure day"),
        h("p", {}, "Each column is the trip leaving that day. Click one for details.")),
      h("div", { class: "actions" }, h("div", { class: "tabs", role: "group", "aria-label": "Metric" }, metricBtns), h("div", { class: "tabs", role: "group", "aria-label": "View" }, tabBtns))),
    legendHost, chartHost, tableHost));

  const mixHost = h("div", { class: "mm" });
  box.append(h("div", { class: "card panel" }, h("div", { class: "panel-head" }, h("div", {}, h("h3", {}, "Mix & match flights"),
    h("p", {}, "Every flight for the day you picked on the chart. Choose any outbound with any return: the total and the time between them update.")))), mixHost);
  const detailHost = h("div", { class: "trips" });
  box.append(h("div", {}, h("h3", { style: "margin:6px 0 12px;font-size:18px;letter-spacing:-.02em" }, "Selected day"), detailHost));
  if (res.top.length) box.append(h("div", {}, h("h3", { style: "margin:6px 0 12px;font-size:18px;letter-spacing:-.02em" }, "Top picks overall"),
    h("div", { class: "trips" }, res.top.map(t => tripCard(t, cur, paxCount(q))))));

  function select(date) { view.sel = date; if (view.pickOpen) { view.pickOpen = null; syncPicks(); } redraw(); drawDetail(); }
  function drawDetail() {
    const d = byDay.get(view.sel), trip = d && tripOf(d);
    const extra = trip ? (res.unpriced || []).filter(u => trip.legs.some(l => l.segments[0].departs.slice(0, 10) === u.date && l.origin === u.origin && l.destination === u.destination)) : [];
    detailHost.replaceChildren(...[trip ? tripCard(trip, cur, paxCount(q)) : h("div", { class: "note" }, "Pick a day on the chart."),
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
    h("div", { class: "t-row" }, `${t.airlines.join(", ")} · ${t.stops === 0 ? "direct" : plural(t.stops, "stop")} · ${hm(t.total_travel_min)}`),
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
      h("td", {}, t.airlines.join(", ")), h("td", {}, t.stops === 0 ? "Direct" : plural(t.stops, "stop")), h("td", {}, hm(t.total_travel_min)),
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
function airlineTags(root, { onChange }) {
  let values = [];
  const input = h("input", { id: "air-in", type: "text", list: "air-list", placeholder: "Ryanair, FR…", autocomplete: "off" });
  root.append(input);
  const draw = () => {
    $$(".chip", root).forEach(c => c.remove());
    values.forEach(code => root.insertBefore(h("span", { class: "chip" }, config.airlines[code] ? `${code} · ${config.airlines[code]}` : code,
      h("button", { type: "button", "aria-label": `Remove ${code}`, onclick: e => { e.stopPropagation(); values = values.filter(v => v !== code); draw(); onChange(); } }, "×")), input));
  };
  const add = () => {
    const codes = resolveAirline(input.value);
    if (!codes.length) return;
    codes.forEach(c => { if (!values.includes(c)) values.push(c); });
    input.value = ""; draw(); onChange();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !input.value && values.length) { values.pop(); draw(); onChange(); }
  });
  input.addEventListener("change", add); input.addEventListener("blur", add);
  root.addEventListener("click", () => input.focus());
  return { get: () => [...values], set: arr => { values = [...arr]; draw(); } };
}

// All airlines found on the searched routes; untick to exclude, or press "Only". Applying re-uses cached flights (free).
function airlinePanel(res, q, cur) {
  const list = res.airlines || [];
  if (!list.length) return null;
  const sel = new Set(list.filter(a => a.included).map(a => a.code));
  const apply = h("button", { type: "button", class: "btn small", disabled: true }, "Apply filter");
  const search = h("input", { type: "search", class: "air-search", placeholder: "Does an airline fly here? Type a name or code…", "aria-label": "Find an airline" });
  const host = h("div", { class: "air-list" });
  const dirty = () => list.some(a => sel.has(a.code) !== a.included);
  const routeChip = (a, r) => h("span", { class: "rt" + (a.nonstop.includes(r) ? " ns" : "") }, `${r.replace(">", " → ")} · ${a.nonstop.includes(r) ? "nonstop" : "with a stop"}${(a.no_price_routes || []).includes(r) ? " · no price" : ""}`);
  function draw() {
    const term = search.value.trim().toLowerCase();
    const shown = list.filter(a => !term || a.name.toLowerCase().includes(term) || a.code.toLowerCase().includes(term));
    apply.disabled = !dirty();
    host.replaceChildren(...(shown.length ? shown.map(a => {
      const row = h("div", { class: "air-row" + (sel.has(a.code) ? "" : " off") },
        h("label", { class: "air-name" }, h("input", { type: "checkbox", checked: sel.has(a.code), "aria-label": `Include ${a.name}`, onchange: e => {
          e.target.checked ? sel.add(a.code) : sel.delete(a.code); row.classList.toggle("off", !e.target.checked); apply.disabled = !dirty(); } }),
          h("span", { class: "an" }, a.name), h("span", { class: "ac2" }, a.code), !a.included ? h("span", { class: "badge fail" }, "excluded") : null),
        h("span", { class: "ap2" + (a.cheapest == null ? " np" : "") }, a.cheapest == null ? "no price shown" : `from ${money(a.cheapest, cur)}`),
        h("span", { class: "routes" }, a.routes.map(r => routeChip(a, r))),
        h("button", { type: "button", class: "btn small ghost", onclick: () => submitSearch({ ...q, airlines_include: [a.code], airlines_exclude: [] }) }, "Only"));
      return row;
    }) : [h("div", { class: "note" }, term ? `No airline matching “${search.value.trim()}” was listed for these routes and dates. It may not fly them, or Google may not sell it there.` : "No airlines found.")]));
  }
  search.addEventListener("input", draw);
  apply.addEventListener("click", () => submitSearch({ ...q, airlines_include: [], airlines_exclude: list.filter(a => !sel.has(a.code)).map(a => a.code) }));
  const excluded = list.filter(a => !a.included).length;
  draw();
  return h("details", { class: "card panel air-panel", open: excluded > 0 ? true : null },
    h("summary", {}, `Airlines on these routes (${list.length})`, excluded ? h("span", { class: "badge warn" }, `${excluded} excluded`) : null),
    h("p", { class: "air-help" }, "Every airline Google listed for these routes and dates. Untick to exclude, or press Only. Applying reuses the flights already fetched, so it's instant and free."),
    h("div", { class: "air-tools" }, search,
      h("button", { type: "button", class: "btn small", onclick: () => { list.forEach(a => sel.add(a.code)); draw(); } }, "Select all"), apply),
    host);
}

// Flights Google lists but shows no fare for (often airlines that sell only on their own site, e.g. HiSky).
function nextCheckText(row) {
  const parts = [];
  if (row.next_check) { const m = Math.round((row.next_check * 1000 - Date.now()) / 60000); parts.push(m <= 0 ? "Next automatic check: any moment" : `Next automatic check in ${m < 90 ? `${m} min` : `${Math.round(m / 60)} h`}`); }
  if (row.rechecks) parts.push(`checked again ${plural(row.rechecks, "time")}`);
  return parts.join(" · ");
}
// Rechecks run on the server on a schedule; refresh what is on screen when one has finished.
function watchRecheck(row) {
  clearTimeout(recheckTimer);
  const wait = Math.max(45000, (row.next_check ? row.next_check * 1000 - Date.now() : 0) + 20000);
  recheckTimer = setTimeout(async () => {
    if (current !== row.id) return;
    try {
      const fresh = await api(`/api/searches/${row.id}`);
      if (current !== row.id) return;
      if (fresh.updated !== row.updated) { const gained = (row.result.unpriced || []).length - (fresh.result.unpriced || []).length; renderResult(fresh); if (gained > 0) toast(`${plural(gained, "flight")} now ${gained === 1 ? "has" : "have"} a price`); }
      else watchRecheck(row);
    } catch { watchRecheck(row); }
  }, Math.min(wait, 20 * 60000));
}

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
    h("summary", {}, `Flights listed without a price (${list.length})`, h("span", { class: "badge warn" }, "check the airline's site")),
    h("p", { class: "air-help" }, "Google lists these flights but shows no fare (sometimes it shows it a few minutes later, so Skyhop rechecks on a schedule, every 15 minutes for departures within two weeks). They are not included in the prices or rankings above."),
    h("div", { class: "air-tools" }, btn, h("span", { class: "unp-status" }, nextCheckText(row))),
    h("div", { class: "air-list" }, list.map(u => h("div", { class: "unp-row" },
      h("span", { class: "unp-date" }, fmtDay(day(u.date))),
      h("span", { class: "unp-route" }, `${u.origin} → ${u.destination}`),
      h("span", { class: "unp-times" }, `${fmtTime(day(u.departs))} → ${fmtTime(day(u.arrives))}`, dayShift(day(u.departs), day(u.arrives)) > 0 ? ` +${dayShift(day(u.departs), day(u.arrives))}` : ""),
      h("span", { class: "unp-air" }, h("b", {}, u.flights), ` ${u.airline}`, u.stops ? ` · ${plural(u.stops, "stop")}` : " · nonstop",
        u.last_price != null ? h("span", { class: "badge warn", title: "Google showed this fare earlier and has since dropped it, so it may be out of date" }, `last seen ${money(u.last_price, row.request.currency)}, ${ago(u.last_seen)}`) : null),
      h("span", { class: "actions" },
        config.airline_sites[u.airline_code] ? h("a", { class: "btn small", href: config.airline_sites[u.airline_code], target: "_blank", rel: "noopener noreferrer" }, `${u.airline} ↗`) : null,
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
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn small", onclick: () => Builder.addTrip(t, { pax: paxLabel(resultsQuery), currency: cur }) }, "＋ Add all flights to Trip builder")));
}
function legTimes(leg) {
  const e = legEnds(leg), sh = dayShift(e.dep, e.arr);
  return h("div", { class: "leg-times" },
    h("div", { class: "lt" }, h("div", { class: "big" }, fmtTime(e.dep)), h("div", { class: "ap" }, e.from), h("div", { class: "dt" }, fmtDay(e.dep))),
    h("div", { class: "lt-mid" }, h("span", {}, hm(leg.duration_min)), h("span", { class: "line", "aria-hidden": "true" }), h("span", {}, leg.stops === 0 ? "direct" : plural(leg.stops, "stop"))),
    h("div", { class: "lt r" }, h("div", { class: "big" }, fmtTime(e.arr), sh > 0 ? h("sup", {}, `+${sh}`) : null), h("div", { class: "ap" }, e.to), h("div", { class: "dt" }, fmtDay(e.arr))));
}

function legCard(leg, title, cur) {
  const first = leg.segments[0], seen = new Map();
  leg.segments.forEach(s2 => { if (!seen.has(s2.airline_code)) seen.set(s2.airline_code, s2.airline || s2.airline_code); });
  const rows = leg.segments.flatMap((sg, i) => {
    const dep = day(sg.departs), arr = day(sg.arrives), lay = leg.layovers_min[i];
    const out = [h("div", { class: "seg-row" }, h("span", { class: "al" }, `${sg.airline_code}${sg.flight_number}`),
      h("div", { class: "seg-times" }, h("span", { class: "t" }, fmtTime(dep)), h("span", { class: "a" }, sg.origin), h("span", { class: "arrow" }, "→"),
        h("span", { class: "t" }, fmtTime(arr), arr.getDate() !== dep.getDate() ? " +1" : ""), h("span", { class: "a" }, sg.destination), h("span", { class: "a" }, sg.airline)))];
    if (lay != null) out.push(h("div", { class: "layover" }, h("span", { class: "badge " + (lay >= 480 ? "warn" : "ok") }, `${hm(lay)} layover in ${sg.destination}`)));
    return out;
  });
  const links = leg.deep_links.map((u, i) => h("a", { class: "btn small", href: u, target: "_blank", rel: "noopener noreferrer" },
    leg.deep_links.length > 1 ? `Google Flights · ticket ${i + 1} ↗` : "Google Flights ↗"));
  const direct = [...seen].filter(([code]) => config.airline_sites[code]).map(([code, name]) =>
    h("a", { class: "btn small", href: config.airline_sites[code], target: "_blank", rel: "noopener noreferrer" }, `${name} ↗`));
  return h("div", { class: "leg" },
    h("div", { class: "leg-top" },
      h("div", { class: "leg-title" }, title, h("small", {}, [...seen.values()].join(" · "))),
      h("strong", { title: isConverted(cur) ? `Originally ${fmtMoney(leg.price, cur)}` : null }, money(leg.price, cur))),
    legTimes(leg),
    rows, h("div", { class: "actions" }, links, direct,
      h("button", { type: "button", class: "btn small", title: "See every flight that day, including ones with no price", onclick: () => Builder.browse(leg.origin, leg.destination, leg.segments[0].departs.slice(0, 10)) }, "All flights that day"),
      h("button", { type: "button", class: "btn small", onclick: () => Builder.addFlight(leg, { pax: paxLabel(resultsQuery), currency: cur }) }, "＋ Trip builder")));
}

// ------------------------------------------------------------------ chrome: theme, sidebar, init
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; }

async function init() {
  const saved = store.get("skyhop.theme"); if (saved) document.documentElement.dataset.theme = saved;
  $$(".theme-toggle").forEach(b => b.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark"; document.documentElement.dataset.theme = next; store.set("skyhop.theme", next);
  }));
  $("#menu").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; });
  $("#scrim").addEventListener("click", closeSidebar);
  try { config = await api("/api/config"); } catch { /* keep defaults */ }
  try { ratesInfo = await api("/api/rates"); rates = ratesInfo.rates; } catch { /* keep the approximate defaults */ }
  showOriginal = !!store.get("skyhop.showOriginal");
  $("#orig-toggle").checked = showOriginal;
  $("#orig-toggle").addEventListener("change", e => setShowOriginal(e.target.checked));
  await loadAirports();
  const cfg = { onChange: onFormChange };
  document.body.append(h("datalist", { id: "air-list" }, [...new Set(Object.values(config.airlines || {}))].sort().map(n => h("option", { value: n }))));
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
  $("#form").addEventListener("input", e => { if (e.target.id === "start" || e.target.id === "end") constrainLength(); onFormChange(); });
  $("#form").addEventListener("change", () => { constrainLength(); onFormChange(); });
  $$("[data-step]").forEach(b => b.addEventListener("click", () => {
    const el = $(`#${b.dataset.for}`), v = (parseFloat(el.value) || 0) + +b.dataset.step;
    el.value = Math.min(+el.max || 99, Math.max(+el.min || 0, v));
    if (el.id === "nmin" && +$("#nmax").value < +el.value) $("#nmax").value = el.value;
    if (el.id === "nmax" && +$("#nmin").value > +el.value) $("#nmin").value = el.value;
    constrainLength(); onFormChange();
  }));
  $$("[data-nights]").forEach(b => b.addEventListener("click", () => {
    const [a, z] = b.dataset.nights.split("-"); showLength(+a, +z); onFormChange();
  }));
  $$("input[name=unit]").forEach(r => r.addEventListener("change", () => {
    const min = num("nmin", 1) - unitOff(), max = num("nmax", 1) - unitOff();       // still in the previous unit here
    unit = r.value; showLength(min, max); onFormChange();
    if (currentRow && currentRow.id === current && currentRow.status === "done") renderResult(currentRow, { keepScroll: true });
    refreshHistory();
  }));
  $("#add-kid").addEventListener("click", () => { if (kids.length < 8) { kids.push(5); renderKids(); onFormChange(); } });
  $("#new-search").addEventListener("click", () => {
    clearTimeout(pollTimer); current = null; $("#results").replaceChildren(); writeForm({ ...defaults(), from: readForm().from });
    onFormChange(); closeSidebar(); window.scrollTo({ top: 0, behavior: "smooth" }); $("#to-in").focus(); refreshHistory();
  });
  $("#form").addEventListener("submit", async e => {
    e.preventDefault();
    const { req, error } = toRequest(readForm());
    if (error) { showFormError(error); return; }
    showFormError("");
    try { await submitSearch(req); } catch (err) { showFormError(err.message); }
  });
  Builder.init();
  Finder.init();
  refreshHistory(); runEstimate();
  setInterval(() => { if (!document.hidden && !pollTimer) refreshHistory(); }, 60000);
}
init();
