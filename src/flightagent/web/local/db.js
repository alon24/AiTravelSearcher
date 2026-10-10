/* Browser storage for the in-browser backend: the offer cache (cache.py), past searches (history.py) and airline sites, kept in
   IndexedDB because a few searches' fares outgrow localStorage. Falls back to memory when IndexedDB is unavailable
   (private windows, Node tests), so the app still works for the session. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const now = () => Date.now() / 1000;
  const STORES = ["offers", "fares", "searches", "sites", "chats", "briefs"];

  /** A tiny async key-value store: one IndexedDB object store, or a Map. */
  class Store {
    constructor(name) { this.name = name; this.mem = null; this.db = null; }

    async open() {
      if (this.db || this.mem) return;
      try {
        this.db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("skyhop", 2);           // v2 added the AI chat's conversations and trip briefs
          r.onupgradeneeded = () => {
            for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
          };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      } catch { this.mem = new Map(); }
    }

    tx(mode, fn) {
      return new Promise((resolve, reject) => {
        const t = this.db.transaction(this.name, mode), out = fn(t.objectStore(this.name));
        t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
        t.onerror = () => reject(t.error);
      });
    }

    async get(key) { await this.open(); return this.mem ? this.mem.get(key) : this.tx("readonly", s => s.get(key)); }
    async put(key, value) { await this.open(); return this.mem ? void this.mem.set(key, value) : this.tx("readwrite", s => s.put(value, key)); }
    async delete(key) {
      await this.open();
      if (this.mem) return this.mem.delete(key);
      const had = (await this.get(key)) !== undefined;
      await this.tx("readwrite", s => s.delete(key));
      return had;
    }
    async values() { await this.open(); return this.mem ? [...this.mem.values()] : this.tx("readonly", s => s.getAll()); }
  }

  /** One-way results with a per-entry expiry, plus the last fare seen per flight (Google sometimes drops a fare). */
  class OfferCache {
    constructor(ttlHours = 6) { this.ttl = ttlHours * 3600; this.offers = new Store("offers"); this.fares = new Store("fares"); }
    fresh(e) { return now() <= (e.expires ?? e.ts + this.ttl); }
    async has(key) { const e = await this.offers.get(key); return !!e && this.fresh(e); }
    /** {offers, ts}; with stale=true an expired entry is still returned. */
    async getEntry(key, stale = false) {
      const e = await this.offers.get(key);
      return e && (stale || this.fresh(e)) ? { offers: e.offers, ts: e.ts } : null;
    }
    async put(key, offers, ttl = null) { const t = now(); await this.offers.put(key, { ts: t, offers, expires: t + (ttl ?? this.ttl) }); }
    async rememberFares(fares) { const t = now(); for (const [k, price] of Object.entries(fares)) await this.fares.put(k, { price, ts: t }); }
    async recallFare(key) { return (await this.fares.get(key)) || null; }
  }

  /** Past searches: request, live progress and the full result, in the row shape /api/searches returns. */
  class History {
    constructor() { this.rows = new Store("searches"); }

    async create(id, req) {
      await this.rows.put(id, { id, created: now(), status: "running", request: req, result: null, error: null,
        progress: { done: 0, total: 0 }, best_price: null, currency: req.currency, next_check: null, rechecks: 0, updated: null });
    }
    async patch(id, fields) {
      const row = await this.rows.get(id);
      if (row) await this.rows.put(id, { ...row, ...fields });
    }
    progress(id, done, total) { return this.patch(id, { progress: { done, total } }); }
    finish(id, result, best, nextCheck) { return this.patch(id, { status: "done", result, best_price: best, next_check: nextCheck, updated: now() }); }
    fail(id, error) { return this.patch(id, { status: "failed", error }); }
    async get(id) { return (await this.rows.get(id)) || null; }
    delete(id) { return this.rows.delete(id); }
    async list(limit = 50) {
      const rows = (await this.rows.values()).sort((a, b) => b.created - a.created).slice(0, limit);
      return rows.map(({ result, ...row }) => row);
    }
    /** A search still "running" when the page was closed never finished: say so instead of spinning forever. */
    async failInterrupted(running) {
      for (const r of await this.rows.values()) if (r.status === "running" && !running.has(r.id)) await this.fail(r.id, "Interrupted: the page was closed");
    }
  }

  L.db = { Store, OfferCache, History };
  if (typeof module !== "undefined" && module.exports) module.exports = L.db;
})(typeof window !== "undefined" ? window : globalThis);
