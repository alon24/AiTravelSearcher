/* One user list for all the travel apps (Travel Hub, MyMaps AI, Skyhop), in the shared D1 database "travel-hub-users"
   (binding DB). The owner manages it from the Travel Hub admin page; the MyMaps AI Worker serves that admin API
   (alon24/mymaps-ai worker/src/accounts.js). Keep SCHEMA and the matching rules here in sync with that file.
   - users: who may spend the keys (role 'user' or 'admin').
   - audit: one row per lookup or model call, so the admin page can show usage per person and app.
   ADMIN_EMAILS and ALLOWED_EMAILS (address or sha256:<hex of the lowercased address>, comma separated) are always
   allowed too, so the owner can't be locked out and the old dashboard list keeps working. */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    added_by TEXT,
    added_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    email TEXT NOT NULL,
    app TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    tokens INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)",
  "CREATE INDEX IF NOT EXISTS audit_email_ts ON audit (email, ts)",
];

const ready = new WeakMap();
/** Creates the tables on first use (once per isolate), so a new database needs no migration step. */
export function ensureSchema(db) {
  let p = ready.get(db);
  if (!p) {
    p = db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready.delete(db); throw e; });
    ready.set(db, p);
  }
  return p;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function inList(list, email) {
  const entries = String(list || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return false;
  return entries.includes(email) || entries.includes(`sha256:${await sha256Hex(email)}`);
}

/** May this verified Google account spend the keys? With no database and no lists, anyone may (the old behaviour). */
export async function isAllowed(email, env) {
  email = String(email || "").trim().toLowerCase();
  if (!email) return false;
  if (await inList(env.ADMIN_EMAILS, email) || await inList(env.ALLOWED_EMAILS, email)) return true;
  if (env.DB) {
    await ensureSchema(env.DB);
    if (await env.DB.prepare("SELECT 1 AS ok FROM users WHERE email = ?").bind(email).first()) return true;
  }
  return !env.DB && !env.ADMIN_EMAILS && !env.ALLOWED_EMAILS;
}

/** Records one lookup or model call for the admin page's usage view; never fails the request. */
export async function audit(env, { email, action, detail = null, tokens = null }) {
  if (!env.DB) return;
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare("INSERT INTO audit (ts, email, app, action, detail, tokens) VALUES (?, ?, 'skyhop', ?, ?, ?)")
      .bind(Date.now(), String(email || "unknown").toLowerCase(), action, detail == null ? null : String(detail).slice(0, 500), tokens)
      .run();
  } catch { /* logging is best effort */ }
}
