/* airline_sites.py in the browser: an airline's official website from Wikidata (free, no key, answers browsers
   directly), or a plain "not found" -- never a guess. Answers are kept like the server keeps them: a site for 90 days,
   a miss for 3; "couldn't ask right now" is never kept. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const SPARQL = "https://query.wikidata.org/sparql";
  const HIT_TTL = 90 * 86400, MISS_TTL = 3 * 86400;
  const CODE = /^[A-Z0-9]{2,3}$/, NAME = /^[\w .&'-]{2,80}$/;     // nothing that could break out of a SPARQL string
  const FILLER = new Set(["air", "airlines", "airways", "the", "of", "aviation", "flight"]);
  let store = null;
  const remembered = () => (store = store || new L.db.Store("sites"));

  const norm = s => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w)));
  const shared = (a, b) => [...a].filter(w => b.has(w)).length;

  /** Best website among the rows: the label must share a word with the airline's name (an IATA code alone has belonged
      to several airlines); then rows found by code beat rows found by name, then the closest label. */
  function pick(rows, name) {
    const want = norm(name);
    let cands = rows.filter(b => b.site).map(b => ({ byCode: Number((b.byCode || {}).value || 0), label: (b.aLabel || {}).value || "", site: b.site.value }));
    if (want.size) cands = cands.filter(c => shared(want, norm(c.label)));
    if (!cands.length) return null;
    const score = c => [-c.byCode, -shared(want, norm(c.label))];
    return cands.reduce((best, c) => { const [a, b] = [score(c), score(best)]; return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? c : best; }).site;
  }

  async function wikidataSite(code, name) {
    const parts = [];
    if (code && CODE.test(code)) parts.push(`{ ?a wdt:P229 "${code}"; wdt:P856 ?site. BIND(1 AS ?byCode) }`);
    if (name && NAME.test(name)) parts.push(`{ ?a rdfs:label "${name.replace(/"/g, "")}"@en; wdt:P856 ?site. BIND(0 AS ?byCode) }`);
    if (!parts.length) return null;
    const query = `SELECT ?a ?aLabel ?site ?byCode WHERE { ${parts.join(" UNION ")} FILTER NOT EXISTS { ?a wdt:P576 ?e } `
      + "SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". } } LIMIT 12";
    const r = await fetch(`${SPARQL}?${new URLSearchParams({ query, format: "json" })}`, { headers: { Accept: "application/sparql-results+json" } });
    if (!r.ok) throw new Error(`Wikidata answered ${r.status}`);
    return pick((await r.json()).results.bindings, name);
  }

  /** https on a public-looking host, or null (a browser can't resolve names, so IP literals and localhost are refused). */
  function publicHttps(url) {
    try {
      const u = new URL(url.trim());
      if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".") || u.username || u.password) return null;
      if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith("[") || /(^|\.)localhost$/.test(u.hostname)) return null;
      return `https://${u.host}${u.pathname || "/"}`;
    } catch { return null; }
  }

  /** Does the site exist? An opaque no-cors answer is enough: any HTTP answer, bot walls included, counts. */
  async function answers(url) {
    try { await fetch(url, { mode: "no-cors", method: "HEAD" }); return true; } catch { return false; }
  }

  /** {url, source, [unavailable]} like the server's /api/airline-site. Only asked for airlines the page has no address for
      (config.airline_sites), so there is no list to check first. */
  async function resolve(code, name) {
    code = (code || "").trim().toUpperCase(); name = (name || "").trim();
    if (!(code && CODE.test(code)) && !(name && NAME.test(name))) return { url: null, source: null };
    const key = `${code}|${name.toLowerCase()}`, now = Date.now() / 1000;
    const hit = await remembered().get(key);
    if (hit && now - hit.at < (hit.url ? HIT_TTL : MISS_TTL)) return { url: hit.url, source: hit.url ? "cache" : null };
    let url;
    try {
      const found = await wikidataSite(code, name);
      const safe = found && publicHttps(found);
      url = safe && (await answers(safe)) ? safe : null;
    } catch {
      return { url: null, source: null, unavailable: true };     // could not ask: not remembered as "no website"
    }
    await remembered().put(key, { url, at: now, name });
    return { url, source: url ? "wikidata" : null };
  }

  L.sites = { resolve, pick };
  if (typeof module !== "undefined" && module.exports) module.exports = L.sites;
})(typeof window !== "undefined" ? window : globalThis);
