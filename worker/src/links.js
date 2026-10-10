/* Airline search links the desktop extension learned (browser-extension/background.js learnFrom), shared through
   the Worker so a phone, which can't run the extension, can open an airline's own results page for a flight. A link
   is a URL template: {origin} {dest} {destcity} {date:PATTERN}. One Durable Object holds them all, since every
   template applies to everyone using this Worker. Only allowed accounts write; anyone signed in reads. */

export const LINK_LIMITS = { airlines: 200, perAirline: 100, url: 2000 };
const CODE_RE = /^[A-Z0-9]{2}$/, DEST_RE = /^[A-Z]{3}$/;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Why `url` can't be a search link, or null: an https address that names the route and the date. */
export function badTemplate(url) {
  if (typeof url !== "string" || url.length > LINK_LIMITS.url) return "not a short enough string";
  let u;
  try { u = new URL(url.replace(/[{}]/g, "")); } catch { return "not a URL"; }
  if (u.protocol !== "https:") return "not https";
  if (!/\{origin(:l)?\}/.test(url) || !/\{(dest|destcity)(:l)?\}/.test(url) || !/\{date(:[A-Za-z\-/.]+)?\}/.test(url)) return "doesn't hold {origin}, {dest} and {date}";
  return null;
}

/** {CODE: {generic?, byDest?: {DEST: url}}} checked; returns {links} or {error}. */
export function checkLinks(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "send {airline code: {generic, byDest}}" };
  const out = {};
  for (const [code, e] of Object.entries(body)) {
    if (!CODE_RE.test(code) || !e || typeof e !== "object") return { error: `bad airline code or entry: ${code}` };
    const item = {};
    if (e.generic != null) { const bad = badTemplate(e.generic); if (bad) return { error: `${code}: ${bad}` }; item.generic = e.generic; }
    if (e.byDest != null) {
      const dests = Object.entries(e.byDest);
      if (dests.length > LINK_LIMITS.perAirline) return { error: `${code}: too many destinations` };
      item.byDest = {};
      for (const [d, url] of dests) {
        const bad = DEST_RE.test(d) ? badTemplate(url) : "bad destination code";
        if (bad) return { error: `${code} ${d}: ${bad}` };
        item.byDest[d] = url;
      }
    }
    out[code] = item;
  }
  return { links: out };
}

/** The Durable Object: GET answers every link; POST merges new ones in (a newer template replaces the old one). */
export class SearchLinks {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    const all = (await this.storage.get("links")) || {};
    if (request.method === "GET") return reply(all);
    const { links, error } = checkLinks(await request.json().catch(() => null));
    if (error) return reply({ error }, 422);
    for (const [code, e] of Object.entries(links)) {
      const cur = all[code] || {};
      all[code] = { ...cur, ...(e.generic ? { generic: e.generic } : {}), byDest: { ...(cur.byDest || {}), ...(e.byDest || {}) } };
    }
    if (Object.keys(all).length > LINK_LIMITS.airlines) return reply({ error: "too many airlines" }, 413);
    await this.storage.put("links", all);
    return reply({ ok: true, airlines: Object.keys(all).length });
  }
}

/** GET or POST /links on the one SearchLinks object. */
export async function links(request, env, who, { json, error }) {
  if (!env.LINKS) return error("shared search links are not set up on this Worker", 503);
  if (request.method === "POST" && !who.allowed) return error("only an allowed account can add search links", 403);
  if (request.method !== "GET" && request.method !== "POST") return error("not found", 404);
  const r = await env.LINKS.get(env.LINKS.idFromName("all")).fetch("https://links/", request.method === "GET" ? {} : { method: "POST", body: await request.text() });
  return json(await r.json(), r.status);
}
