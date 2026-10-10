/* Skyhop's Cloudflare Worker: the only place the SerpApi and OpenRouter keys live when Skyhop runs on GitHub Pages.
   The page signs in with Google and sends that access token; the Worker accepts it only if Google says it was issued
   to Skyhop's OAuth client (and, with ALLOWED_EMAILS set, to one of those accounts). Routes:
     GET  /health                   which services are configured, and whether the caller's token is accepted
     GET  /serpapi?origin&dest&...  one one-way Google Flights lookup through SerpApi (one credit)
     POST /decide                   a typed decision from Jev, as the Python service's /api/decide (decide.py) */

const SERPAPI_URL = "https://serpapi.com/search.json";
const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
const MAX_STATE_CHARS = 12_000;      // as decide.py: bounds what one call can spend
const MAX_QUESTIONS = 8;
const MAX_BODY = 64_000;
const CODE_RE = /^[A-Z]{3}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STOPS = { 0: 1, 1: 2, 2: 3, 3: 0 };   // our max stops -> SerpApi `stops` (0 any, 1 nonstop, 2 up to 1, 3 up to 2)
// Google Flights rejects IATA city codes but accepts comma-separated airports (providers/airports.py).
export const CITY_AIRPORTS = {
  ROM: "FCO,CIA", LON: "LHR,LGW,STN,LTN,LCY", PAR: "CDG,ORY,BVA", NYC: "JFK,EWR,LGA",
  MIL: "MXP,LIN,BGY", BER: "BER", STO: "ARN,BMA,NYO", MOW: "SVO,DME,VKO",
  TYO: "HND,NRT", WAS: "IAD,DCA,BWI", CHI: "ORD,MDW", BUH: "OTP,BBU",
  BJS: "PEK,PKX", OSA: "KIX,ITM", SAO: "GRU,CGH,VCP", BUE: "EZE,AEP",
  MAD: "MAD", BRU: "BRU", IST: "IST,SAW", VCE: "VCE,TSF",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Token",
  "Access-Control-Max-Age": "86400",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const error = (message, status) => json({ error: message }, status);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ who may call
async function tokenMatches(given, expected) {     // constant time: compare SHA-256 digests
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.reduce((diff, v, i) => diff | (v ^ y[i]), 0) === 0;
}

const authCache = new Map();       // token -> {user, until}: one Google round trip per token every few minutes
const AUTH_TTL = 5 * 60_000;

/** The signed-in Google account's email if Google issued this token to our client (and ALLOWED_EMAILS admits it), else null. */
async function googleUser(token, env) {
  if (!token || !env.GOOGLE_CLIENT_ID) return null;
  const hit = authCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  let user = null, ttl = 60_000;
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (r.ok) {
    const t = await r.json();
    const email = String(t.email || "").toLowerCase();
    const allowed = (env.ALLOWED_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    const ours = t.aud === env.GOOGLE_CLIENT_ID || t.azp === env.GOOGLE_CLIENT_ID;
    if (ours && email && String(t.email_verified) === "true" && (!allowed.length || allowed.includes(email))) user = email;
    ttl = Math.min(Math.max(Number(t.expires_in) || 0, 0) * 1000, AUTH_TTL);
  }
  if (authCache.size > 1000) authCache.clear();
  authCache.set(token, { user, until: Date.now() + ttl });
  return user;
}

const bearer = request => (/^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "") || [])[1]?.trim() || "";

async function caller(request, env) {
  if (await tokenMatches(request.headers.get("X-App-Token"), env.APP_TOKEN)) return "app-token";
  return googleUser(bearer(request), env);
}

// ------------------------------------------------------------------------------------------------ routes
async function health(request, env) {
  return json({ serpapi: !!env.SERPAPI_API_KEY, jev: !!env.OPENROUTER_API_KEY, sign_in: !!env.GOOGLE_CLIENT_ID, user: await caller(request, env) });
}

/** The SerpApi query for one one-way lookup, or an error message. */
export function serpapiParams(q) {
  const origin = (q.get("origin") || "").toUpperCase(), dest = (q.get("dest") || "").toUpperCase(), day = q.get("date") || "";
  const int = (k, def, lo, hi) => { const v = q.has(k) ? Number(q.get(k)) : def; return Number.isInteger(v) && v >= lo && v <= hi ? v : NaN; };
  const adults = int("adults", 1, 1, 9), children = int("children", 0, 0, 8), infants = int("infants", 0, 0, 8), stops = int("max_stops", 1, 0, 3);
  const currency = (q.get("currency") || "USD").toUpperCase();
  if (!CODE_RE.test(origin) || !CODE_RE.test(dest)) return { error: "origin and dest must be 3-letter codes" };
  if (!DAY_RE.test(day)) return { error: "date must be YYYY-MM-DD" };
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "currency must be a 3-letter code" };
  if ([adults, children, infants, stops].some(Number.isNaN)) return { error: "adults, children, infants or max_stops out of range" };
  const params = { engine: "google_flights", type: "2", hl: "en", departure_id: CITY_AIRPORTS[origin] || origin,
    arrival_id: CITY_AIRPORTS[dest] || dest, outbound_date: day, currency, adults: String(adults), stops: String(STOPS[stops]) };
  if (children) params.children = String(children);
  if (infants) params.infants_on_lap = String(infants);
  return { params };
}

/** One lookup; retried on SerpApi's rate limit and server errors. Answers only what the page parses. */
async function serpapi(url, env, wait = sleep) {
  if (!env.SERPAPI_API_KEY) return error("SERPAPI_API_KEY is not configured", 503);
  const { params, error: bad } = serpapiParams(url.searchParams);
  if (bad) return error(bad, 400);
  const target = `${SERPAPI_URL}?${new URLSearchParams({ ...params, api_key: env.SERPAPI_API_KEY })}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(target);
    if ([429, 500, 502, 503].includes(r.status) && attempt < 3) { await wait(1000 * 2 ** attempt); continue; }
    let data;
    try { data = await r.json(); } catch { return error(`SerpApi answered ${r.status}`, 502); }
    if (data.error) {     // "hasn't returned any results" is a normal empty answer
      return /hasn't returned any results/.test(data.error) ? json({ best_flights: [], other_flights: [] }) : error(`SerpApi: ${data.error}`, 502);
    }
    if (!r.ok) return error(`SerpApi answered ${r.status}`, 502);
    return json({ best_flights: data.best_flights || [], other_flights: data.other_flights || [],
      google_flights_url: (data.search_metadata || {}).google_flights_url || null });
  }
}

/** Laya-style request -> Jev's (decide.to_jev_request): a bare string state is wrapped; noul questions get default criteria. */
export function jevRequest(body, model) {
  const { state, questions } = body || {};
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return { error: "questions must be an object" };
  if (Object.keys(questions).length > MAX_QUESTIONS) return { error: `at most ${MAX_QUESTIONS} questions per call` };
  const text = typeof state === "string" ? state : JSON.stringify(state ?? null);
  if (text.length > MAX_STATE_CHARS) return { error: `state is longer than ${MAX_STATE_CHARS} characters` };
  const qs = {};
  for (const [id, q] of Object.entries(questions)) {
    qs[id] = q && q.type === "noul" && !q.criteria ? { ...q, criteria: { true: "Yes, the statement holds.", false: "No, the statement does not hold." } } : q;
  }
  return { request: { model, state: typeof state === "string" ? { text: state } : state, questions: qs } };
}

async function decide(request, env) {
  if (!env.OPENROUTER_API_KEY) return error("OPENROUTER_API_KEY is not configured", 503);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return error("body too large", 413);
  let body;
  try { body = JSON.parse(raw); } catch { return error("invalid JSON", 400); }
  const { request: jev, error: bad } = jevRequest(body, env.JEV_MODEL || DEFAULT_JEV_MODEL);
  if (bad) return error(bad, 422);
  const r = await fetch(JEV_URL, { method: "POST", body: JSON.stringify(jev),
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "Skyhop" } });
  if (!r.ok) return error(`Jev/OpenRouter answered ${r.status}`, 502);
  const data = await r.json();
  return json({ answers: data.answers, cost: Number((data.usage || {}).cost) || 0, model: data.model, backend: "jev" });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") return await health(request, env);
      if (!(await caller(request, env))) return error("sign in with an allowed Google account", 401);
      if (url.pathname === "/serpapi" && request.method === "GET") return await serpapi(url, env);
      if (url.pathname === "/decide" && request.method === "POST") return await decide(request, env);
    } catch {
      return error("upstream request failed", 502);
    }
    return error("not found", 404);
  },
};

export { serpapi as _serpapi, authCache as _authCache };
