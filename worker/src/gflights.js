/* Free Google Flights fares for the page, like providers/gflights.py does for Docker: the Worker asks Google Flights
   for one one-way search and hands back the result groups Google embeds in the page; the page parses them
   (web/local/gflights.js). No key and no credits, but Google may refuse or change the page, so the page falls back
   to SerpApi when this fails. The query is the `tfs` protobuf that providers/gflights.py builds. */

import { isCityOnly } from "./airports.js";

const URL_BASE = "https://www.google.com/travel/flights";
const CODE_RE = /^[A-Z]{3}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Passenger wire values as gflights.tfs sends them (3 is what Google prices as a lap infant).
const ADULT = 1, CHILD = 2, LAP_INFANT = 3;
const ECONOMY = 1, ONE_WAY = 2, AIRPORT = 1;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cookie": "CONSENT=YES+",   // skips the EU cookie wall that some Cloudflare locations would get
};

// ------------------------------------------------------------------------------------------------ protobuf
const varint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const tag = (field, wire) => varint((field << 3) | wire);
const int = (field, v) => [...tag(field, 0), ...varint(v)];
const bytes = (field, b) => [...tag(field, 2), ...varint(b.length), ...b];
const str = (field, s) => bytes(field, [...new TextEncoder().encode(s)]);

const place = code => [...(isCityOnly(code) ? [] : int(1, AIRPORT)), ...str(2, code)];

/** The `tfs` query for one one-way search, byte for byte what gflights.tfs encodes (tested from pytest). An airport
    carries its type (1): Google answers a bare airport code with its landing page (measured 2026-10-11). City codes
    (ROM) stay bare as before: how Google wants them typed is not measured yet. */
export function tfs({ origin, dest, day, adults = 1, children = 0, infants = 0, maxStops = 1, carryOn = 0, checked = 0 }) {
  const flight = [...str(2, day), ...(maxStops < 3 ? int(5, maxStops) : []), ...bytes(13, place(origin)), ...bytes(14, place(dest))];
  const pax = [...Array(adults).fill(ADULT), ...Array(children).fill(CHILD), ...Array(infants).fill(LAP_INFANT)];
  const info = [...bytes(3, flight), ...bytes(8, pax.flatMap(varint)), ...int(9, ECONOMY),
    ...(carryOn || checked ? bytes(13, [...int(2, carryOn), ...int(3, checked)]) : []), ...int(19, ONE_WAY)];
  return btoa(String.fromCharCode(...info));
}

/** The query from the page's parameters (same names as /serpapi, plus bags), or an error message. */
export function gflightsQuery(q) {
  const origin = (q.get("origin") || "").toUpperCase(), dest = (q.get("dest") || "").toUpperCase(), day = q.get("date") || "";
  const num = (k, def, lo, hi) => { const v = q.has(k) ? Number(q.get(k)) : def; return Number.isInteger(v) && v >= lo && v <= hi ? v : NaN; };
  const query = { origin, dest, day, adults: num("adults", 1, 1, 9), children: num("children", 0, 0, 8), infants: num("infants", 0, 0, 8),
    maxStops: num("max_stops", 1, 0, 3), carryOn: num("carry_on_bags", 0, 0, 2), checked: num("checked_bags", 0, 0, 4) };
  const currency = (q.get("currency") || "USD").toUpperCase();
  if (!CODE_RE.test(origin) || !CODE_RE.test(dest)) return { error: "origin and dest must be 3-letter codes" };
  if (!DAY_RE.test(day)) return { error: "date must be YYYY-MM-DD" };
  if (!CODE_RE.test(currency)) return { error: "currency must be a 3-letter code" };
  if (Object.values(query).some(v => Number.isNaN(v))) return { error: "passengers, max_stops or bags out of range" };
  return { url: `${URL_BASE}?${new URLSearchParams({ tfs: tfs(query), hl: "en-US", curr: currency })}` };
}

/** Google's result groups from the page (gflights.parse_html): "best flights" then "other flights". Throws with a
    reason when the page holds no results, e.g. a consent wall or a robot check. */
export function resultGroups(html) {
  const script = /<script[^>]*class="ds:1"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!script) {
    const why = /unusual traffic|recaptcha/i.test(html) ? "a robot check" : /consent\.google|before you continue/i.test(html) ? "a cookie wall" : "an unexpected page";
    throw new Error(`Google returned no result data (${why})`);
  }
  const at = script[1].indexOf("data:");
  const raw = script[1].slice(at + 5, script[1].lastIndexOf(","));
  if (at < 0 || raw.endsWith("errorHasStatus: true")) return [];
  const payload = JSON.parse(raw);
  const groups = [2, 3].flatMap(i => (payload[i] && payload[i][0]) || []);
  if (!groups.length && /<title[^>]*>\s*Find Cheap Flights/.test(html))   // Google's start page (gflights.LANDING_TITLE)
    throw new Error("Google returned its landing page instead of results (it did not understand the query)");
  return groups;
}

/** GET /gflights: one lookup, tried twice. Answers {groups, url} for the page to parse: `url` is the Google Flights
    page the fares came from, so the page's "Google Flights" link opens that very search. */
export async function gflights(url, { json, error }, wait) {
  const { url: target, error: bad } = gflightsQuery(url.searchParams);
  if (bad) return error(bad, 400);
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await wait(1500);
    try {
      const r = await fetch(target, { headers: HEADERS });
      if (!r.ok) throw new Error(`Google Flights answered ${r.status}`);
      return json({ groups: resultGroups(await r.text()), url: target });
    } catch (e) { last = e; }
  }
  return error(last.message, 502);
}
