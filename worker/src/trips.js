/* Shared trips: a group chat about one trip that anyone with the link can join after signing in with Google. One
   Durable Object per trip holds its title, brief, search, members and messages, so every member sees the same
   conversation. Only an account on ALLOWED_EMAILS can start one; guests then spend the AI and fare lookups out of the
   trip's daily allowance (spend()), which bounds what a shared link can cost its owner. */

export const LIMITS = { messages: 1000, text: 4000, data: 12_000, title: 120, chat: 60, serpapi: 300, gflights: 1000 };  // chat/serpapi/gflights: per trip per UTC day
const KINDS = new Set(["user", "ai", "search", "brief", "map"]);
const ID_RE = /^[a-z0-9]{12}$/;

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clip = (s, n) => String(s ?? "").slice(0, n);
const small = (v, n) => (v == null ? null : JSON.stringify(v).length <= n ? v : undefined);   // undefined = too big
export const newTripId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
export const validTripId = id => ID_RE.test(id || "");

/** The Durable Object. Only the Worker talks to it, and it says who is asking (`who`), already checked with Google. */
export class SharedTrip {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    const url = new URL(request.url), body = request.method === "GET" ? {} : await request.json();
    const meta = await this.storage.get("meta");
    if (url.pathname === "/create") return this.create(meta, body);
    if (!meta) return reply({ error: "no such trip" }, 404);
    if (url.pathname === "/read") return this.read(meta, url.searchParams.get("who"), Number(url.searchParams.get("since")) || 0);
    if (url.pathname === "/post") return this.post(meta, body);
    if (url.pathname === "/update") return this.update(meta, body);
    if (url.pathname === "/spend") return this.spend(meta, body);
    return reply({ error: "not found" }, 404);
  }

  async create(meta, { owner, title, brief, request, messages = [] }) {
    if (meta) return reply({ error: "trip exists" }, 409);
    const m = { owner, title: clip(title, LIMITS.title) || "Shared trip", brief: small(brief, LIMITS.data) ?? null,
      request: small(request, LIMITS.data) ?? null, members: { [owner]: Date.now() }, seq: 0, created: Date.now(), spent: {} };
    await this.storage.put("meta", m);
    for (const x of messages.slice(-200)) await this.append(m, { ...x, who: x.author === "ai" ? "ai" : owner });
    return reply({ ok: true });
  }

  /** Everything after message `since`; reading also joins the trip. */
  async read(meta, who, since) {
    if (who && !meta.members[who]) { meta.members[who] = Date.now(); await this.storage.put("meta", meta); }
    const found = await this.storage.list({ prefix: "m:", start: `m:${String(since + 1).padStart(6, "0")}` });
    const { spent, ...shown } = meta;
    return reply({ ...shown, members: Object.keys(meta.members), messages: [...found.values()] });
  }

  async post(meta, msg) {
    if (meta.seq >= LIMITS.messages) return reply({ error: "this trip is full: start a new one" }, 409);
    if (!KINDS.has(msg.kind)) return reply({ error: "unknown message kind" }, 422);
    if (!clip(msg.text, LIMITS.text).trim() && msg.data == null) return reply({ error: "empty message" }, 422);
    if (small(msg.data, LIMITS.data) === undefined) return reply({ error: "message data too large" }, 413);
    if (msg.who !== "ai") meta.members[msg.who] = meta.members[msg.who] || Date.now();
    const saved = await this.append(meta, msg);
    return reply(saved);
  }

  async append(meta, { who, kind, text, data }) {
    const saved = { seq: ++meta.seq, at: Date.now(), author: who, kind: KINDS.has(kind) ? kind : "user",
      text: clip(text, LIMITS.text), data: small(data, LIMITS.data) ?? null };
    await this.storage.put(`m:${String(saved.seq).padStart(6, "0")}`, saved);
    await this.storage.put("meta", meta);
    return saved;
  }

  async update(meta, { who, title, brief, request }) {
    if (!meta.members[who]) return reply({ error: "open the trip first" }, 403);
    if (title != null) meta.title = clip(title, LIMITS.title) || meta.title;
    if (brief !== undefined) { if (small(brief, LIMITS.data) === undefined) return reply({ error: "brief too large" }, 413); meta.brief = brief; }
    if (request !== undefined) { if (small(request, LIMITS.data) === undefined) return reply({ error: "search too large" }, 413); meta.request = request; }
    await this.storage.put("meta", meta);
    return reply({ ok: true });
  }

  /** Take `n` of today's `kind` allowance (chat turns or fare lookups) for a guest; false once it is used up. */
  async spend(meta, { kind, n = 1 }) {
    const today = new Date().toISOString().slice(0, 10), cap = LIMITS[kind];
    if (!cap) return reply({ error: "unknown allowance" }, 422);
    const used = meta.spent[today]?.[kind] || 0;
    if (used + n > cap) return reply({ ok: false, left: cap - used });
    meta.spent = { [today]: { ...(meta.spent[today] || {}), [kind]: used + n } };     // only today's count is kept
    await this.storage.put("meta", meta);
    return reply({ ok: true, left: cap - used - n });
  }
}

/** The Durable Object for a trip id, as a function that sends it one call. */
export function tripStub(env, id) {
  const stub = env.TRIPS.get(env.TRIPS.idFromName(id));
  return (path, body) => stub.fetch(`https://trip${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
}
