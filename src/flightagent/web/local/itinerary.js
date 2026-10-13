/* The gaps between consecutive flights of a trip, whether the airports differ, the
   estimated ground transfer and whether it all fits. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});

  const SAME_AIRPORT_MIN = 90, SAME_AIRPORT_RECOMMENDED = 180, CHECKIN_BUFFER_MIN = 120;
  const DIFFERENT_CITY_TIGHT_MIN = 360, LONG_WAIT_MIN = 8 * 60, DAY_MIN = 24 * 60;

  function fmtDur(minutes) {
    minutes = Math.abs(minutes);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }

  /** [minutes between landing and the next departure, whether both time zones were known]. */
  function gapMinutes(arr, arrCode, dep, depCode) {
    const G = L.geo, aTz = G.tzOf(arrCode), dTz = G.tzOf(depCode);
    if (aTz && dTz) return [Math.floor((G.utcOf(dep, dTz) - G.utcOf(arr, aTz)) / 60000), true];
    return [L.models.minutesBetween(arr, dep), false];
  }

  function gapText(arr, dep, gap) {
    const nights = L.models.daysBetween(arr.slice(0, 10), dep.slice(0, 10));
    if (gap >= 18 * 60 && nights >= 1) return `${nights} night${nights !== 1 ? "s" : ""}`;
    return fmtDur(gap);
  }

  function checkGap(index, a, b) {
    const land = a.segments[a.segments.length - 1], take = b.segments[0];
    const A = land.destination, B = take.origin;
    const [gap, tzKnown] = gapMinutes(land.arrives, A, take.departs, B);
    const text = gapText(land.arrives, take.departs, gap);
    const multiNight = gap >= DAY_MIN;
    const transfer = L.geo.transferBetween(A, B);
    let kind, tMin = null, how = "", hard = null, needed = null;
    if (A === B) { kind = "same_airport"; hard = SAME_AIRPORT_MIN; needed = SAME_AIRPORT_RECOMMENDED; }
    else if (transfer) { kind = "same_city"; [tMin, how] = transfer; hard = tMin; needed = tMin + CHECKIN_BUFFER_MIN; }
    else kind = "different_city";

    let status;
    if (gap < 0 || (hard !== null && gap < hard)) status = "impossible";
    else if ((needed !== null && gap < needed) || (kind === "different_city" && gap < DIFFERENT_CITY_TIGHT_MIN)) status = "tight";
    else status = "ok";
    const longWait = kind !== "different_city" && gap >= LONG_WAIT_MIN && gap < DAY_MIN;

    const where = A !== B ? `landing at ${A} and leaving from ${B}` : `flights at ${A}`;
    let headline;
    if (gap < 0) headline = `Not enough time: the next flight leaves ${fmtDur(gap)} before this one lands.`;
    else if (status === "impossible") headline = `Not enough time: only ${text} between ${where}.`;
    else if (status === "tight") headline = `Tight connection: only ${text} between ${where}.`;
    else if (longWait) headline = `Long wait: ${text} between ${where}.`;
    else headline = `${text} between ${where}.`;

    let detail;
    if (kind === "same_airport") {
      detail = multiNight ? "" : "Same airport but separate tickets: collect bags, re-check in and clear security again. Plan at least 3h.";
    } else if (kind === "same_city") {
      detail = `You land at ${A} but the next flight leaves from ${B}: getting between them takes about ${tMin} min (${how}; estimate, traffic varies).`;
      if (!multiNight) detail += ` With about 2h to check in, you need at least ${fmtDur(needed)} between landing and departure.`;
    } else {
      detail = `${A} and ${B} are in different cities. No transfer estimate is available, so allow for your own ground travel.`;
    }
    if (!tzKnown) detail = (detail + " Time zones unknown, so the gap is approximate.").trim();

    return { index, arrive_airport: A, depart_airport: B, arrives: land.arrives, departs: take.departs, gap_min: gap, gap_text: text,
      kind, transfer_min: tMin, transfer_how: how, needed_min: needed, status, long_wait: longWait, tz_known: tzKnown, headline, detail };
  }

  function analyse(legs, currency = "USD") {
    const gaps = legs.slice(1).map((b, i) => checkGap(i, legs[i], b));
    const warnings = legs.length > 1 ? ["Each flight is a separate ticket: a delay or cancellation on one is not covered by the others, and bags are not checked through."] : [];
    return { total_price: L.models.round2(legs.reduce((t, l) => t + l.price, 0)), currency, gaps, warnings };
  }

  /** A gap worth mentioning in search results: airports differ, it is tight, or the wait is long. */
  function gapWarning(g) {
    if (g.kind === "same_airport" && g.status === "ok" && !g.long_wait) return null;
    return `${g.headline} ${g.detail}`.trim();
  }

  L.itinerary = { analyse, checkGap, gapWarning, fmtDur };
  if (typeof module !== "undefined" && module.exports) module.exports = L.itinerary;
})(typeof window !== "undefined" ? window : globalThis);
