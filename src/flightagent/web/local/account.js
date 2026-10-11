/* Signing in with Google, and talking to Skyhop's Cloudflare Worker (worker/), which holds the SerpApi and OpenRouter
   keys for the GitHub Pages build. Only active when runtime.js names a Worker and a Google OAuth client (build_pages.py
   writes both from GitHub variables); otherwise the page stays on demo fares. The Google access token is kept until it
   expires (about an hour) so a reload, on a phone too, doesn't ask again. Skyhop is one of a suite on alon24.github.io
   with Travel Hub AI (alon24/travel-hub) and MyMaps AI, all on the same Google client: whichever app you sign in to,
   the others on this origin use that sign-in (HUB below) until it expires or you sign out. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const KEY = "skyhop.google";
  const HUB = "travel-hub.session";     // Travel Hub AI's sign-in: {token, expires, email, name?, picture?}
  const GIS = "https://accounts.google.com/gsi/client";
  const REVOKE = "https://oauth2.googleapis.com/revoke";
  const DRIVE = "https://www.googleapis.com/auth/drive.file";
  const SIGN_IN = `openid email profile ${DRIVE}`;    // the suite's scopes: a token from any app opens MyMaps AI's maps
  const rt = () => root.SKYHOP_RUNTIME || {};
  const configured = () => !!(rt().workerUrl && rt().googleClientId);

  let session = load();     // {token, until, email, scopes}
  let health = null;        // the Worker's /health for this session: {gflights, serpapi, chat, trips, user, guest}
  let trip = null;          // the shared trip on screen (trip.js): a guest's AI and fares are billed to it
  let checked = null;
  let unreachable = null;   // why the last /health failed (network, DNS, the Worker down), shown instead of a silent demo

  function load() {
    try { const s = JSON.parse(root.localStorage.getItem(KEY)); if (s && s.until > Date.now()) return s; } catch { /* below */ }
    return fromHub();
  }
  /** The suite's sign-in, from Travel Hub AI, while it has more than a minute left (the hub's own rule). */
  function fromHub() {
    try {
      const h = JSON.parse(root.localStorage.getItem(HUB));
      if (!h || typeof h.token !== "string" || typeof h.email !== "string" || !(h.expires > Date.now() + 60_000)) return null;
      return { token: h.token, until: h.expires - 60_000, email: h.email, scopes: Array.isArray(h.scopes) ? h.scopes : ["openid", "email", "profile"] };
    } catch { return null; }
  }
  /** Hand a Skyhop sign-in to the hub, unless it is signed in already (possibly as someone else). */
  function shareWithHub(s) {
    try { if (!fromHub()) root.localStorage.setItem(HUB, JSON.stringify({ token: s.token, expires: s.until, email: s.email, scopes: s.scopes })); } catch { /* private mode */ }
  }
  /** A signed-out or dead token is dead in every app of the suite: drop the hub's copy of it too. */
  function dropFromHub(token) {
    try { const h = JSON.parse(root.localStorage.getItem(HUB)); if (h && h.token === token) root.localStorage.removeItem(HUB); } catch { /* private mode */ }
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
      dropFromHub(session.token);
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
      checked = get("/health").then(h => {
        health = h; unreachable = null;
        if (session && !(h.user || h.guest)) { dropFromHub(session.token); save(null); }    // expired or revoked
        return h;
      }, e => {       // not a verdict on the token: keep the sign-in, say why, and ask again next time
        unreachable = `Couldn't reach Skyhop's server: ${e.message}`; checked = null;
        return null;
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
    if (root.SkyhopNative) return appToken(scope, hint);
    await loadGis();
    const answer = await new Promise((ok, no) => {
      root.google.accounts.oauth2.initTokenClient({ client_id: rt().googleClientId, scope, ...(hint ? { login_hint: hint } : {}),
        callback: r => (r.error ? no(new Error(r.error_description || r.error)) : ok(r)),
        error_callback: e => no(new Error(e && e.type === "popup_closed" ? "Sign-in was cancelled" : `Google sign-in failed (${(e && e.type) || "no reason given"})`)),
      }).requestAccessToken();
    });
    return { token: answer.access_token, until: Date.now() + ((Number(answer.expires_in) || 3600) - 60) * 1000,
      scopes: String(answer.scope || scope).split(/\s+/) };
  }

  /** In the Android app (android/): Google refuses sign-in inside an app's web view, so the app opens this page in the
      phone's browser (?app-sign-in, see appSignIn), which signs in and hands the token back to the app. */
  function appToken(scope, hint) {
    return new Promise((ok, no) => {
      const done = e => {
        root.removeEventListener("skyhop-app-token", done);
        const d = e.detail || {};
        if (d.error) return no(new Error(d.error));
        let t = null;
        try { t = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.raw.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)))); } catch { /* checked below */ }
        if (!t || typeof t.token !== "string" || !(t.until > Date.now()) || !Array.isArray(t.scopes)) return no(new Error("The browser handed the app an unusable Google sign-in; try again"));
        ok({ token: t.token, until: t.until, scopes: t.scopes });
      };
      root.addEventListener("skyhop-app-token", done);
      root.SkyhopNative.signIn(scope, hint || "");
    });
  }
  /** The browser side of appToken: Google's popup, then the token as a skyhop:// link back into the app. */
  async function appSignIn(scope, hint) {
    const t = await requestToken(scope, hint);
    const raw = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(t)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `skyhop://signed-in?t=${raw}`;
  }

  /** Google's sign-in popup, then the Worker's verdict on the token. Resolves with the account's email. */
  async function signIn() {
    save({ ...(await requestToken(SIGN_IN)), email: null });
    const h = await check(true);
    if (!h) { save(null); throw new Error(unreachable); }
    if (!h.user && !h.guest) { save(null); throw new Error("Google didn't confirm this account"); }
    save({ ...session, email: h.user || h.guest });
    shareWithHub(session);
    return session.email;
  }

  /** A token that may also write Skyhop's own files in the user's Google Drive (drive.file: nothing else in their Drive).
      Asks once, from a click (a popup); later calls reuse it until it expires. */
  async function driveToken() {
    if (!signedIn()) throw new Error("Sign in with Google first");
    if (!(session.scopes || []).includes(DRIVE)) {
      const t = await requestToken(SIGN_IN, session.email);     // a sign-in from before the suite asked for Drive
      if (!t.scopes.includes(DRIVE)) throw new Error("Skyhop wasn't given access to Google Drive");
      save({ ...session, ...t });
    }
    return session.token;
  }
  const hasDrive = () => signedIn() && (session.scopes || []).includes(DRIVE);

  function signOut() {
    if (session) {          // revoked, the token is dead in the hub too
      dropFromHub(session.token);
      fetch(REVOKE, { method: "POST", mode: "no-cors", body: new URLSearchParams({ token: session.token }) }).catch(() => {});
    }
    save(null);
    if (health) health = { ...health, user: null, guest: null };
  }

  L.account = {
    configured, check, signIn, signOut, get, signedIn, driveToken, hasDrive,
    allowed, email: who, appSignIn,
    unreachable: () => unreachable,
    live: () => (allowed() || (signedIn() && !!trip)) && !!(health.gflights || health.serpapi),   // real fares through the Worker
    has: service => !!(health && health[service]),
    /** Where the Airline Assist extension sends Jev's questions on the web version: this Worker with this token. */
    jevRoute: () => (allowed() && health.jev ? { url: rt().workerUrl.replace(/\/+$/, ""), token: session.token, until: session.until } : null),
    trips: () => !!(health && health.trips),
    setTrip: id => { trip = id || null; },
  };
})(typeof window !== "undefined" ? window : globalThis);
