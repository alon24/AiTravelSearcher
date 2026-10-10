/* Typo-tolerant, phonetic airport search. Works in the browser (window.AirportSearch) and in Node (tests).
   Layers, strongest first: exact/prefix code, name/alias prefix, contains, phonetic prefix ("buka" ~ Bucharest),
   edit-distance typos ("praga", "amstrdam"). Popular airports and city groups get a boost so hubs beat obscure
   airports with a similar name. A country name lists that country's airports with scheduled flights. */
(function (root) {
  "use strict";
  const fold = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  // A rough sound-alike key so "bukarest", "bucharest" and "bucarest" collapse to the same string.
  function phon(s) {
    return fold(s).replace(/[^a-z֐-׿ ]/g, "")
      .replace(/sch/g, "sk").replace(/ph/g, "f").replace(/ch/g, "k").replace(/ck/g, "k").replace(/qu?/g, "k")
      .replace(/x/g, "ks").replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/z/g, "s").replace(/y/g, "i")
      .replace(/w/g, "v").replace(/h/g, "").replace(/(.)\1+/g, "$1");
  }

  // Damerau-Levenshtein (adjacent swaps count once), giving up as soon as it must exceed `max`.
  function dl(a, b, max) {
    const al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return max + 1;
    let prev2 = null, prev = Array.from({ length: bl + 1 }, (_, j) => j);
    for (let i = 1; i <= al; i++) {
      const cur = [i]; let rowMin = i;
      for (let j = 1; j <= bl; j++) {
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[bl];
  }

  function prepare(rows) {
    return rows.map(([code, city, name, country, rank, aliases, service = 0]) => {
      const terms = [];
      const add = (text, weight) => { const t = fold(text); if (t) terms.push({ t, p: phon(t), w: weight }); };
      add(city, 0); (aliases || []).forEach(a => add(a, 0));
      // single words of the airport name ("gurion", "heathrow"), a bit weaker, only real words
      fold(name).split(/[^a-z֐-׿]+/).filter(w => w.length >= 4 && !STOP.has(w)).forEach(w => add(w, -12));
      return { code, city, name, country, rank, service, terms, key: fold(`${code} ${city} ${name} ${country} ${(aliases || []).join(" ")}`) };
    });
  }
  const STOP = new Set(["airport", "international", "intl", "regional", "field", "municipal", "airfield", "airbase", "city", "county", "memorial"]);

  const boost = a => (a.rank === 2 ? 30 : a.rank === 1 ? 25 : 0);

  function fuzzy(qp, tp) {
    if (qp.length < 3 || !tp) return null;
    if (tp.startsWith(qp)) return { score: 66, d: 0 };
    if (qp[0] !== tp[0]) return null;                          // typos rarely hit the first letter: keeps junk out
    const allow = qp.length <= 4 ? 1 : qp.length <= 7 ? 2 : 3;
    let best = allow + 1;
    for (const L of [qp.length - 1, qp.length, qp.length + 1]) if (L >= 2 && L <= tp.length) best = Math.min(best, dl(qp, tp.slice(0, L), allow));
    best = Math.min(best, dl(qp, tp, allow));
    return best <= allow ? { score: 62 - 9 * best, d: best } : null;
  }

  // A country typed by name ("portugal", "Port"): its airports with scheduled flights (OurAirports, see
  // tools/build_airports.py) come first, and country() offers its main airports as one pick.
  const COUNTRY_ALIASES = { usa: "united states", us: "united states", uk: "united kingdom", england: "united kingdom", holland: "netherlands" };
  function countryOf(list, q) {
    const want = COUNTRY_ALIASES[q] || q;
    const names = list.countryNames || (list.countryNames = [...new Set(list.map(a => a.country))].map(c => [fold(c), c]));
    // the whole name, or 5+ letters of it: "roma" is Rome, not Romania
    const hit = names.find(([f]) => f === want) || (want.length >= 5 && names.find(([f]) => f.startsWith(want)));
    return hit ? hit[1] : null;
  }
  /** {name, codes}: a country's large airports with scheduled flights (else all with scheduled flights), most popular
      first, at most `max`; `of` is how many there are in all. Null when the query names no country. */
  function country(list, query, max = 8) {
    const name = countryOf(list, fold(query));
    if (!name) return null;
    const served = list.filter(a => a.country === name && a.rank !== 2 && a.service > 0);
    const main = served.some(a => a.service === 2) ? served.filter(a => a.service === 2) : served;
    if (!main.length) return null;
    main.sort((x, y) => y.rank - x.rank || x.city.localeCompare(y.city));
    return { name, codes: main.slice(0, max).map(a => a.code), of: main.length };
  }

  function search(list, query, limit = 8) {
    const q = fold(query);
    if (!q) return [];
    const qp = phon(q), out = [], land = countryOf(list, q);
    for (const a of list) {
      const code = a.code.toLowerCase();
      let sc = 0, kind = "";
      if (code === q) { sc = 100; kind = "code"; }
      else if (q.length <= 3 && code.startsWith(q)) { sc = 80; kind = "code"; }
      for (const t of a.terms) {
        let s = 0, k = "";
        if (t.t.startsWith(q)) { s = 70 + t.w; k = "name"; }
        else if (q.length >= 3 && t.t.includes(q)) { s = 45 + t.w; k = "name"; }
        else { const f = fuzzy(qp, t.p); if (f) { s = f.score + t.w; k = "fuzzy"; } }
        if (s > sc) { sc = s; kind = k; }
      }
      if (land && a.country === land && a.service > 0) { const c = 68 + 10 * a.service; if (c > sc) { sc = c; kind = "country"; } }
      if (!sc && q.length >= 3 && a.key.includes(q)) { sc = 20; kind = "name"; }
      if (sc) out.push({ a, score: sc + boost(a) * (kind === "fuzzy" && sc < 55 ? 0.3 : 1), kind });
    }
    out.sort((x, y) => y.score - x.score || y.a.service - x.a.service || x.a.city.localeCompare(y.a.city));
    return out.slice(0, limit);
  }

  const api = { prepare, search, country, fold, phon, dl };
  root.AirportSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
