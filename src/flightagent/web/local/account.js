/* Signing in with Google, and talking to Skyhop's Cloudflare Worker (worker/), which holds the SerpApi and OpenRouter
   keys for the GitHub Pages build. Only active when runtime.js names a Worker and a Google OAuth client (build_pages.py
   writes both from GitHub variables); otherwise the page stays on demo fares. The Google access token is kept until it
   expires (about an hour) so a reload, on a phone too, doesn't ask again. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const KEY = "skyhop.google";
  const GIS = "https://accounts.google.com/gsi/client";
  const REVOKE = "https://oauth2.googleapis.com/revoke";
  const SIGN_IN = "openid email", DRIVE = "https://www.googleapis.com/auth/drive.file";
  const rt = () => root.SKYHOP_RUNTIME || {};
  const configured = () => !!(rt().workerUrl && rt().googleClientId);

  let session = load();     // {token, until, email, scopes}
  let health = null;        // the Worker's /health for this session: {gflights, serpapi, chat, trips, user, guest}
  let trip = null;          // the shared trip on screen (trip.js): a guest's AI and fares are billed to it
  let checked = null;

  function load() {
    try { const s = JSON.parse(root.localStorage.getItem(KEY)); return s && s.until > Date.now() ? s : null; } catch { return null; }
  }
  function save(s) {
    session = s;
    try { s ? root.localStorage.setItem(KEY, JSON.stringify(s)) : root.localStorage.removeItem(KEY); } catch { /* private mode */ }
  }
  const who = () => (session && session.until > Date.now() && health && (health.user || health.guest)) || null;
  const signedIn = () => !!who();
  const allowed = () => signedIn() && !!health.user;     // on ALLOWED_EMAILS: may spend the keys outside a shared trip

  /** The Worker's JSON for `path`, sent with the Google token; a refused token signs the page out. */
  async function get(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (session) headers.Authorization = `Bearer ${session.token}`;
    if (trip) headers["X-Trip"] = trip;
    const r = await fetch(rt().workerUrl.replace(/\/+$/, "") + path, { ...opts, headers });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (r.status === 401 && session) {        // the token expired or was revoked: tell the page once
      save(null);
      if (health) health = { ...health, user: null, guest: null };
      root.dispatchEvent(new CustomEvent("skyhop-signed-out"));
    }
    if (!r.ok) throw new Error(r.status === 401 ? "Sign in again to keep getting live fares" : (j && j.error) || `Skyhop's server answered ${r.status}`);
    return j;
  }

  /** Ask the Worker what it can do and whether it accepts the saved token; once per page load unless forced. */
  function check(force = false) {
    if (!configured()) return Promise.resolve(null);
    if (!checked || force) {
      checked = get("/health").catch(() => null).then(h => {
        health = h;
        if (session && !(h && (h.user || h.guest))) save(null);        // expired or revoked
        return h;
      });
    }
    return checked;
  }

  let gis = null;
  function loadGis() {
    return (gis = gis || new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = GIS; s.async = true; s.onload = ok;
      s.onerror = () => { gis = null; no(new Error("Couldn't load Google sign-in")); };
      document.head.append(s);
    }));
  }

  /** Google's consent popup for these scopes; resolves with {token, until, scopes}. */
  async function requestToken(scope, hint) {
    await loadGis();
    const answer = await new Promise((ok, no) => {
      root.google.accounts.oauth2.initTokenClient({ client_id: rt().googleClientId, scope, ...(hint ? { login_hint: hint } : {}),
        callback: r => (r.error ? no(new Error(r.error_description || r.error)) : ok(r)),
        error_callback: e => no(new Error(e && e.type === "popup_closed" ? "Sign-in was cancelled" : "Google sign-in failed")),
      }).requestAccessToken();
    });
    return { token: answer.access_token, until: Date.now() + ((Number(answer.expires_in) || 3600) - 60) * 1000,
      scopes: String(answer.scope || scope).split(/\s+/) };
  }

  /** Google's sign-in popup, then the Worker's verdict on the token. Resolves with the account's email. */
  async function signIn() {
    save({ ...(await requestToken(SIGN_IN)), email: null });
    const h = await check(true);
    if (!h) { save(null); throw new Error("Couldn't reach Skyhop's server"); }
    if (!h.user && !h.guest) { save(null); throw new Error("Google didn't confirm this account"); }
    save({ ...session, email: h.user || h.guest });
    return session.email;
  }

  /** A token that may also write Skyhop's own files in the user's Google Drive (drive.file: nothing else in their Drive).
      Asks once, from a click (a popup); later calls reuse it until it expires. */
  async function driveToken() {
    if (!signedIn()) throw new Error("Sign in with Google first");
    if (!(session.scopes || []).includes(DRIVE)) {
      const t = await requestToken(`${SIGN_IN} ${DRIVE}`, session.email);
      if (!t.scopes.includes(DRIVE)) throw new Error("Skyhop wasn't given access to Google Drive");
      save({ ...session, ...t });
    }
    return session.token;
  }
  const hasDrive = () => signedIn() && (session.scopes || []).includes(DRIVE);

  function signOut() {
    if (session) fetch(REVOKE, { method: "POST", mode: "no-cors", body: new URLSearchParams({ token: session.token }) }).catch(() => {});
    save(null);
    if (health) health = { ...health, user: null, guest: null };
  }

  L.account = {
    configured, check, signIn, signOut, get, signedIn, driveToken, hasDrive,
    allowed, email: who,
    live: () => (allowed() || (signedIn() && !!trip)) && !!(health.gflights || health.serpapi),   // real fares through the Worker
    has: service => !!(health && health[service]),
    /** Where the Airline Assist extension sends Jev's questions on the web version: this Worker with this token. */
    jevRoute: () => (allowed() && health.jev ? { url: rt().workerUrl.replace(/\/+$/, ""), token: session.token, until: session.until } : null),
    trips: () => !!(health && health.trips),
    setTrip: id => { trip = id || null; },
  };
})(typeof window !== "undefined" ? window : globalThis);
