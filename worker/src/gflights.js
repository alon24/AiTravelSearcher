/* Free Google Flights fares for the page: the Worker asks Google Flights
   for one one-way search and hands back the result groups Google embeds in the page; the page parses them
   (web/local/gflights.js). No key and no credits, but Google may refuse or change the page, so the page falls back
   to SerpApi when this fails. The query is the `tfs` protobuf of Google's own links. */

import { isCityOnly } from "./airports.js";

const URL_BASE = "https://www.google.com/travel/flights";
const CODE_RE = /^[A-Z]{3}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Passenger wire values as gflights.tfs sends them (3 is what Google prices as a lap infant).
const ADULT = 1, CHILD = 2, LAP_INFANT = 3;
const ECONOMY = 1, ROUND_TRIP = 1, ONE_WAY = 2, AIRPORT = 1;
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
export function tfs({ origin, dest, day, adults = 1, children = 0, infants = 0, maxStops = 1, carryOn = 0, checked = 0, returnDay = null }) {
  const leg = (a, b, d) => bytes(3, [...str(2, d), ...(maxStops < 3 ? int(5, maxStops) : []), ...bytes(13, place(a)), ...bytes(14, place(b))]);
  const pax = [...Array(adults).fill(ADULT), ...Array(children).fill(CHILD), ...Array(infants).fill(LAP_INFANT)];
  const info = [...leg(origin, dest, day), ...(returnDay ? leg(dest, origin, returnDay) : []), ...bytes(8, pax.flatMap(varint)), ...int(9, ECONOMY),
    ...(carryOn || checked ? bytes(13, [...int(2, carryOn), ...int(3, checked)]) : []), ...int(19, returnDay ? ROUND_TRIP : ONE_WAY)];
  return btoa(String.fromCharCode(...info));
}

/** The query from the page's parameters (same names as /serpapi, plus bags and an optional return_date, which asks
    for Google's round-trip page: each outbound flight priced as the whole return ticket), or an error message. */
export function gflightsQuery(q) {
  const origin = (q.get("origin") || "").toUpperCase(), dest = (q.get("dest") || "").toUpperCase(), day = q.get("date") || "";
  const num = (k, def, lo, hi) => { const v = q.has(k) ? Number(q.get(k)) : def; return Number.isInteger(v) && v >= lo && v <= hi ? v : NaN; };
  const query = { origin, dest, day, adults: num("adults", 1, 1, 9), children: num("children", 0, 0, 8), infants: num("infants", 0, 0, 8),
    maxStops: num("max_stops", 1, 0, 3), carryOn: num("carry_on_bags", 0, 0, 2), checked: num("checked_bags", 0, 0, 4) };
  const currency = (q.get("currency") || "USD").toUpperCase(), returnDay = q.get("return_date") || null;
  if (!CODE_RE.test(origin) || !CODE_RE.test(dest)) return { error: "origin and dest must be 3-letter codes" };
  if (!DAY_RE.test(day)) return { error: "date must be YYYY-MM-DD" };
  if (returnDay && !(DAY_RE.test(returnDay) && returnDay >= day)) return { error: "return_date must be YYYY-MM-DD, on or after date" };
  query.returnDay = returnDay;
  if (!CODE_RE.test(currency)) return { error: "currency must be a 3-letter code" };
  if (Object.values(query).some(v => Number.isNaN(v))) return { error: "passengers, max_stops or bags out of range" };
  return { url: `${URL_BASE}?${new URLSearchParams({ tfs: tfs(query), hl: "en-US", curr: currency })}` };
}

/** Google's result groups from the page (gflights.parse_html): "best flights" then "other flights", and the range
    Google says the search usually costs (gflights.usual_range) with its fares on nearby days. Throws with a reason when the page holds no results,
    e.g. a consent wall or a robot check. */
export function readPage(html) {
  const script = /<script[^>]*class="ds:1"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!script) {
    const why = /unusual traffic|recaptcha/i.test(html) ? "a robot check" : /consent\.google|before you continue/i.test(html) ? "a cookie wall" : "an unexpected page";
    throw new Error(`Google returned no result data (${why})`);
  }
  const at = script[1].indexOf("data:");
  const raw = script[1].slice(at + 5, script[1].lastIndexOf(","));
  if (at < 0 || raw.endsWith("errorHasStatus: true")) return { groups: [], usual: null, nearby: null };
  const payload = JSON.parse(raw);
  const groups = [2, 3].flatMap(i => (payload[i] && payload[i][0]) || []);
  if (!groups.length && /<title[^>]*>\s*Find Cheap Flights/.test(html))   // Google's start page (gflights.LANDING_TITLE)
    throw new Error("Google returned its landing page instead of results (it did not understand the query)");
  const insight = Array.isArray(payload[5]) ? payload[5] : [];
  const low = insight[4]?.[1], high = insight[5]?.[1];
  // gflights.nearby_dates: payload[6] entries [depart, return or null, [[_, price], ...]]; one-way ones only
  const nearby = (Array.isArray(payload[6]) ? payload[6] : [])
    .filter(e => Array.isArray(e) && typeof e[0] === "string" && e[1] === null && typeof e[2]?.[0]?.[1] === "number")
    .map(e => [e[0], e[2][0][1]]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return { groups, usual: typeof low === "number" && typeof high === "number" ? [low, high] : null, nearby: nearby.length ? nearby : null };
}
export const resultGroups = html => readPage(html).groups;

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
      return json({ ...readPage(await r.text()), url: target });
    } catch (e) { last = e; }
  }
  return error(last.message, 502);
}
