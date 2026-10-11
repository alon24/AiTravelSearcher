"use strict";
/* Shared trips, the page's side of the Worker's /trips (worker/src/trips.js): a group chat about one trip that anyone
   with the invite link joins after signing in with Google. Messages are people talking, Skyhop's answers, searches
   (with their digest and request, so anyone can open the results) and trip briefs. While a trip is open the page asks
   for new messages every few seconds; chat.js draws it and runs Skyhop's turns. Only on the web version (Worker). */
const Trip = (() => {
  const KEY = "skyhop.trips", POLL_MS = 4000;
  let trip = null, timer = 0, onChange = () => {}, watching = () => false;
  const acct = () => SkyhopLocal.account;
  const call = (path, opts = {}) => acct().get(path, opts.body === undefined ? opts
    : { method: opts.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) });
  const link = id => `${location.origin}${location.pathname}#trip=${id}`;

  const remembered = () => store.get(KEY) || [];
  function remember(t) { store.set(KEY, [{ id: t.id, title: t.title, at: Date.now() }, ...remembered().filter(x => x.id !== t.id)].slice(0, 20)); }
  function forget(id) { store.set(KEY, remembered().filter(x => x.id !== id)); }

  /** Start a trip from a conversation (allowed accounts only) and open it. */
  async function create(fields) {
    const { id } = await call("/trips", { method: "POST", body: fields });
    return join(id);
  }

  async function join(id) {
    leave();
    trip = { id, since: 0, messages: [], members: [], title: "" };
    acct().setTrip(id);
    try { await refresh(); } catch (e) { leave(); throw e; }
    timer = setInterval(() => { if (watching() && !document.hidden) refresh().catch(() => { /* next time */ }); }, POLL_MS);
    return trip;
  }

  function leave() {
    clearInterval(timer); timer = 0; trip = null;
    acct().setTrip(null);
  }

  /** Fetch what's new since the last message we have. */
  async function refresh() {
    if (!trip) return;
    const id = trip.id, r = await call(`/trips/${id}?since=${trip.since}`);
    if (!trip || trip.id !== id) return;
    const { messages, seq, ...meta } = r, fresh = messages.filter(m => m.seq > trip.since);
    const changed = fresh.length || meta.title !== trip.title || meta.members.length !== trip.members.length;
    Object.assign(trip, meta, { messages: [...trip.messages, ...fresh] });
    if (fresh.length) trip.since = fresh[fresh.length - 1].seq;
    remember(trip);
    if (changed) onChange();
  }

  async function post(kind, text, data) {
    await call(`/trips/${trip.id}/messages`, { method: "POST", body: { kind, text, data } });
    await refresh();
  }
  async function update(fields) { await call(`/trips/${trip.id}`, { method: "PATCH", body: fields }); await refresh(); }

  const short = email => (email === "ai" ? "Skyhop" : String(email).split("@")[0]);
  const name = email => (email === acct().email() ? "You" : short(email));

  /** The trip's conversation in the model's format: who said what, Skyhop's answers, and what its searches found. */
  function history() {
    const last = trip.messages.map(m => m.kind).lastIndexOf("search");   // older searches shrink, as in chat.js
    return trip.messages.map((m, i) => m.kind === "user" ? { role: "user", content: `${short(m.author)}: ${m.text}` }
      : m.kind === "ai" ? { role: "assistant", content: m.text }
      : m.kind === "search" ? { role: "assistant", content: `(I searched ${JSON.stringify(m.data.args)} and found: ${JSON.stringify(i === last ? m.data.out : Chat.earlier(m.data.out))})` }
      : m.kind === "map" ? { role: "assistant", content: `(Put on a MyMaps AI map: ${m.data.title})` }
      : { role: "assistant", content: `(Trip brief saved: ${m.data.title}. ${m.data.summary})` });
  }

  return {
    active: () => !!trip, current: () => trip, create, join, leave, refresh, post, update, history, link, name, remembered, forget,
    watch: (changed, visible) => { onChange = changed; watching = visible; },
  };
})();
