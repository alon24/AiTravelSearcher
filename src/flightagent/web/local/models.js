/* The search request and flight shapes of models.py, as plain objects. Dates are "YYYY-MM-DD" strings and times are
   naive local "YYYY-MM-DDTHH:MM:SS" strings, exactly as the server's JSON carries them, so results from the server and
   from the browser are interchangeable. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});

  class ValidationError extends Error {}

  // ----------------------------------------------------------------- dates and times (naive, so computed in UTC)
  const pad = n => String(n).padStart(2, "0");
  const ms = s => Date.parse(s.length === 10 ? s + "T00:00:00Z" : s + "Z");
  const isoDay = t => new Date(t).toISOString().slice(0, 10);
  const isoTime = t => new Date(t).toISOString().slice(0, 19);
  const addDays = (day, n) => isoDay(ms(day) + n * 86400000);
  const addMinutes = (dt, n) => isoTime(ms(dt) + n * 60000);
  const minutesBetween = (a, b) => Math.floor((ms(b) - ms(a)) / 60000);
  const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / 86400000);
  const weekday = day => (new Date(ms(day)).getUTCDay() + 6) % 7;    // Python: Monday = 0
  const dayOf = dt => dt.slice(0, 10);
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function* days(start, end) { for (let d = start; d <= end; d = addDays(d, 1)) yield d; }

  // Python's round(x, 2): toFixed rounds the exact binary value, as Python does (x * 100 can drift first).
  const round2 = x => Number(x.toFixed(2));

  // ----------------------------------------------------------------- SearchRequest
  const DEFAULTS = {
    origin: "TLV", destinations: undefined, return_airports: [], open_jaw: true, connect_destinations: false,
    window_start: undefined, window_end: undefined, min_nights: undefined, max_nights: undefined,
    allow_connections: true, max_stops_per_leg: 1, min_layover_min: 90, max_layover_min: 72 * 60, max_travel_min_per_direction: null,
    allow_mixed_airlines: true, allow_self_transfer: false, self_transfer_hubs: [], self_transfer_buffer_min: 240, min_nights_per_stop: 1,
    stale_ok: false, refresh_unpriced: false, airlines_include: [], airlines_exclude: [], carry_on_bags: 0, checked_bags: 0,
    adults: 1, children_ages: [], currency: "USD", value_of_time_per_hour: 10.0, self_transfer_penalty: 40.0, top_n: 5, max_api_calls: 400,
  };
  const BOUNDS = { min_nights: [1], max_nights: [1], max_stops_per_leg: [0, 3], carry_on_bags: [0, 3], checked_bags: [0, 3], adults: [1, 9] };
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** Fill defaults and validate like SearchRequest does; throws ValidationError listing every problem. */
  function searchRequest(body) {
    const r = {}, errors = [];
    for (const [k, def] of Object.entries(DEFAULTS)) {
      const v = body[k];
      if (v === undefined || (v === null && def !== null)) {
        if (def === undefined) errors.push(`${k}: Field required`);
        r[k] = Array.isArray(def) ? [] : def;
      } else r[k] = v;
    }
    if (errors.length) throw new ValidationError(errors.join("; "));
    for (const k of ["window_start", "window_end"]) if (!DAY_RE.test(r[k]) || Number.isNaN(ms(r[k]))) errors.push(`${k}: Input should be a valid date`);
    for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
      if (!Number.isInteger(r[k])) errors.push(`${k}: Input should be a valid integer`);
      else if (r[k] < lo) errors.push(`${k}: Input should be greater than or equal to ${lo}`);
      else if (hi !== undefined && r[k] > hi) errors.push(`${k}: Input should be less than or equal to ${hi}`);
    }
    if (!Array.isArray(r.destinations) || !r.destinations.length) errors.push("destinations: List should have at least 1 item after validation, not 0");
    if (errors.length) throw new ValidationError(errors.join("; "));

    const up = list => list.map(d => String(d).toUpperCase());
    const codes = list => [...new Set(list.map(a => String(a).trim().toUpperCase()).filter(Boolean))].sort();
    r.origin = String(r.origin).toUpperCase();
    r.destinations = up(r.destinations);
    r.return_airports = up(r.return_airports);
    r.self_transfer_hubs = up(r.self_transfer_hubs);
    r.airlines_include = codes(r.airlines_include);
    r.airlines_exclude = codes(r.airlines_exclude);
    if (r.window_end <= r.window_start) throw new ValidationError("window_end must be after window_start");
    if (r.max_nights < r.min_nights) throw new ValidationError("max_nights must be >= min_nights");
    if (!r.allow_connections) r.max_stops_per_leg = 0;
    if (r.children_ages.some(a => !(a >= 0 && a <= 17))) throw new ValidationError("children_ages must be between 0 and 17");
    if (r.adults + r.children_ages.length > 9) throw new ValidationError("At most 9 travellers per search");
    if (pax(r).infants > pax(r).adults) throw new ValidationError("Each infant under 2 needs their own adult (one lap infant per adult)");
    return r;
  }

  function pax(r) {
    return {
      adults: r.adults + r.children_ages.filter(a => a >= 12).length,
      children: r.children_ages.filter(a => a >= 2 && a <= 11).length,
      infants: r.children_ages.filter(a => a < 2).length,
    };
  }
  const s = n => (n !== 1 ? "s" : "");
  function bagsLabel(r) {
    const parts = r.carry_on_bags ? [`${r.carry_on_bags} cabin bag${s(r.carry_on_bags)}`] : [];
    if (r.checked_bags) parts.push(`${r.checked_bags} checked bag${s(r.checked_bags)}`);
    return parts.join(" + ");
  }
  function paxLabel(r) {
    let label = `${r.adults} adult${s(r.adults)}`;
    if (r.children_ages.length) label += ", children aged " + [...r.children_ages].sort((a, b) => a - b).join(", ");
    return label;
  }

  // ----------------------------------------------------------------- Offer (a one-way ticket, or a self-transfer bundle)
  function offer(o) {
    return { origin: o.origin, destination: o.destination, price: o.price, currency: o.currency, segments: o.segments,
      deep_links: o.deep_links || [], provider: o.provider || "", priced: o.priced ?? true, self_transfer: !!o.self_transfer, hub: o.hub ?? null };
  }
  const departs = o => o.segments[0].departs;
  const arrives = o => o.segments[o.segments.length - 1].arrives;
  const stops = o => o.segments.length - 1;
  const layovers = o => o.segments.slice(1).map((b, i) => minutesBetween(o.segments[i].arrives, b.departs));
  /** Door-to-door minutes: real flight times plus layovers; local-time difference when a flight time is unknown. */
  const duration = o => o.segments.reduce((t, x) => t + (x.duration_min ?? minutesBetween(x.departs, x.arrives)), 0)
    + layovers(o).reduce((a, b) => a + b, 0);
  const airlines = o => [...new Set(o.segments.map(x => x.airline_code))];
  const label = o => o.segments.map(x => `${x.airline_code}${x.flight_number}`).join("+");

  function legView(o) {
    return { origin: o.origin, destination: o.destination, airlines: airlines(o), segments: o.segments, stops: stops(o),
      layovers_min: layovers(o), duration_min: duration(o), price: o.price, self_transfer: o.self_transfer, deep_links: o.deep_links, priced: o.priced };
  }

  function segment(x) {
    return { airline_code: x.airline_code, airline: x.airline || "", flight_number: x.flight_number, origin: x.origin,
      destination: x.destination, departs: x.departs, arrives: x.arrives, duration_min: x.duration_min ?? null };
  }

  L.models = {
    ValidationError, searchRequest, pax, bagsLabel, paxLabel, offer, segment, departs, arrives, stops, layovers, duration, airlines,
    label, legView, round2, ms, isoDay, isoTime, addDays, addMinutes, minutesBetween, daysBetween, weekday, dayOf, today, days,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = L.models;
})(typeof window !== "undefined" ? window : globalThis);
