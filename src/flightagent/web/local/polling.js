/* polling.py in the browser: how long fetched fares stay fresh, and when unpriced flights are worth asking about again. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const MAX_INTERVAL_S = 6 * 3600;

  /** Seconds before a route/day that has unpriced flights is worth asking about again. */
  const unpricedInterval = daysOut => (daysOut <= 14 ? 15 * 60 : daysOut <= 60 ? 3600 : 3 * 3600);

  /** Cache lifetime for priced results: shorter right before departure, when fares change quickly. */
  function fareTtl(daysOut, def) {
    if (daysOut <= 2) return Math.min(def, 3600);
    if (daysOut <= 14) return Math.min(def, 3 * 3600);
    return def;
  }

  /** Unix time of the next recheck (backing off after fruitless ones), or null when there is nothing to recheck. */
  function nextCheckTime(unpricedDates, rechecks, now, today = L.models.today()) {
    const future = unpricedDates.filter(d => d >= today).sort();
    if (!future.length) return null;
    const base = unpricedInterval(L.models.daysBetween(today, future[0]));
    return now + Math.min(base * (1 + Math.floor(rechecks / 4)), MAX_INTERVAL_S);
  }

  L.polling = { unpricedInterval, fareTtl, nextCheckTime };
  if (typeof module !== "undefined" && module.exports) module.exports = L.polling;
})(typeof window !== "undefined" ? window : globalThis);
