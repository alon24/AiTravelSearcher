/* Metro areas, estimated ground-transfer times (typical estimates, NOT measured data) and
   airport time zones. The time-zone table (airport_tz.json, ~130 KB) is handed in with setZones() when first needed. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});

  const METROS = {
    ROM: ["FCO", "CIA"], LON: ["LHR", "LGW", "STN", "LTN", "LCY", "SEN"], PAR: ["CDG", "ORY", "BVA"],
    NYC: ["JFK", "EWR", "LGA"], MIL: ["MXP", "LIN", "BGY"], IST: ["IST", "SAW"], STO: ["ARN", "BMA", "NYO"],
    MOW: ["SVO", "DME", "VKO"], TYO: ["HND", "NRT"], WAS: ["IAD", "DCA", "BWI"], CHI: ["ORD", "MDW"],
    BUH: ["OTP", "BBU"], BJS: ["PEK", "PKX"], OSA: ["KIX", "ITM"], SAO: ["GRU", "CGH", "VCP"],
    BUE: ["EZE", "AEP"], VCE: ["VCE", "TSF"],
  };
  const METRO_OF = {};
  for (const [m, airports] of Object.entries(METROS)) for (const a of airports) METRO_OF[a] = m;

  const PAIRS = [
    ["FCO", "CIA", 60, "taxi, or train via Roma Termini"],
    ["LHR", "LGW", 90, "coach or taxi"], ["LHR", "STN", 100, "coach, or train via central London"],
    ["LHR", "LTN", 90, "coach or taxi"], ["LHR", "LCY", 60, "train or taxi"], ["LGW", "STN", 120, "train via central London"],
    ["LGW", "LTN", 120, "train via central London"], ["STN", "LTN", 90, "taxi or coach"], ["LGW", "LCY", 80, "train or taxi"],
    ["STN", "LCY", 70, "train or taxi"], ["LTN", "LCY", 80, "train or taxi"],
    ["CDG", "ORY", 75, "taxi, or RER + Orlyval"], ["CDG", "BVA", 120, "coach via Paris or taxi"], ["ORY", "BVA", 120, "coach via Paris"],
    ["JFK", "LGA", 50, "taxi"], ["JFK", "EWR", 80, "taxi or train"], ["LGA", "EWR", 70, "taxi"],
    ["MXP", "LIN", 70, "Malpensa Express + metro"], ["MXP", "BGY", 100, "coach or taxi"], ["LIN", "BGY", 60, "bus or taxi"],
    ["IST", "SAW", 100, "taxi or shuttle, traffic varies a lot"],
    ["ARN", "BMA", 50, "taxi or bus"], ["ARN", "NYO", 100, "coach or taxi"], ["BMA", "NYO", 110, "coach or taxi"],
    ["SVO", "DME", 120, "taxi or train, traffic varies a lot"], ["SVO", "VKO", 90, "taxi"], ["DME", "VKO", 90, "taxi"],
    ["HND", "NRT", 100, "limousine bus or train"],
    ["IAD", "DCA", 60, "taxi or metro"], ["IAD", "BWI", 80, "taxi or train"], ["DCA", "BWI", 60, "train or taxi"],
    ["ORD", "MDW", 70, "taxi or train"], ["OTP", "BBU", 50, "taxi"], ["PEK", "PKX", 100, "taxi or train"],
    ["KIX", "ITM", 65, "limousine bus or train"], ["GRU", "CGH", 80, "taxi, traffic varies a lot"],
    ["GRU", "VCP", 130, "coach or taxi"], ["CGH", "VCP", 140, "coach or taxi"], ["EZE", "AEP", 60, "taxi or bus"],
    ["VCE", "TSF", 70, "bus or taxi"],
  ];
  const pairKey = (a, b) => [a, b].sort().join("|");
  const TRANSFER = new Map(PAIRS.map(([a, b, m, how]) => [pairKey(a, b), [m, how]]));
  const DEFAULT_METRO_TRANSFER = [90, "typical estimate"];

  const metroOf = code => METRO_OF[code.toUpperCase()] || null;

  /** Estimated ground minutes between two DIFFERENT airports of the same city, else null. */
  function transferBetween(a, b) {
    a = a.toUpperCase(); b = b.toUpperCase();
    if (a === b || !metroOf(a) || metroOf(a) !== metroOf(b)) return null;
    return TRANSFER.get(pairKey(a, b)) || DEFAULT_METRO_TRANSFER;
  }

  let ZONES = {};
  const setZones = table => { ZONES = table || {}; };
  const zonesLoaded = () => Object.keys(ZONES).length > 0;
  function tzOf(code) {
    const name = ZONES[code.toUpperCase()];
    if (!name) return null;
    try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return name; } catch { return null; }
  }

  const formatters = new Map();
  function offsetAt(utc, zone) {          // minutes the zone is ahead of UTC at that instant
    if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    const p = Object.fromEntries(formatters.get(zone).formatToParts(new Date(utc)).map(x => [x.type, x.value]));
    return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utc) / 60000;
  }
  /** UTC milliseconds of a naive local time in `zone`. A time that occurs twice (clocks going back) or never (clocks
      going forward) takes the offset from before the change, as Python's zoneinfo does (fold=0). */
  function utcOf(local, zone) {
    const t = L.models.ms(local), day = 86400000;
    const before = offsetAt(t - day, zone), after = offsetAt(t + day, zone);
    const early = t - before * 60000;
    if (before === after || offsetAt(early, zone) === before) return early;
    const late = t - after * 60000;
    return offsetAt(late, zone) === after ? late : early;
  }

  L.geo = { metroOf, transferBetween, tzOf, utcOf, setZones, zonesLoaded };
  if (typeof module !== "undefined" && module.exports) module.exports = L.geo;
})(typeof window !== "undefined" ? window : globalThis);
