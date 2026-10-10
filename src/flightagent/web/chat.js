"use strict";
/* Ask Skyhop: an AI chat that plans a trip with you. You say where, when and your conditions in plain words; the model
   calls `search_flights`, which runs here in the page: it fills the form and shows the results next to the chat, then
   hands the model a short digest to talk about. Conversations are kept on this device (IndexedDB) and can be resumed.
   "Summarize" turns one into a trip brief (kept here, and in Google Drive when signed in on the web version); a brief
   can be continued later in a new chat, e.g. with new dates. The model call goes through /api/chat/complete (the
   server's or, on GitHub Pages, the Worker's), which holds the key. */
const Chat = (() => {
  const chats = new SkyhopLocal.db.Store("chats"), briefs = new SkyhopLocal.db.Store("briefs");
  const LIVE_CONFIRM = 40;       // live searches needing more paid lookups than this are confirmed with the user first
  const MAX_TOOL_ROUNDS = 4;
  let convo = null, opened = false, sending = false, els, driveBriefs = [];

  const strs = { type: "array", items: { type: "string" } };
  const TOOLS = [{ type: "function", function: {
    name: "search_flights",
    description: "Search one-way fares over a flexible date window and combine them into trips. The results also appear "
      + "in the app beside the chat. Returns a digest: the best trips, the cheapest per destination, and warnings.",
    parameters: { type: "object", required: ["destinations", "window_start", "window_end", "min_nights", "max_nights"], properties: {
      origin: { type: "string", description: "Departure airport or city IATA code." },
      destinations: { ...strs, description: "Airport or city IATA codes, all in one call, e.g. [\"LIS\",\"OPO\",\"FAO\"]." },
      window_start: { type: "string", description: "Earliest departure, YYYY-MM-DD." },
      window_end: { type: "string", description: "Latest return, YYYY-MM-DD." },
      min_nights: { type: "integer" }, max_nights: { type: "integer" },
      adults: { type: "integer" }, children_ages: { type: "array", items: { type: "integer" } },
      max_stops_per_leg: { type: "integer", description: "0 = direct only. Default 1." },
      currency: { type: "string" },
      airlines_include: { ...strs, description: "Only these airlines (IATA codes)." },
      airlines_exclude: { ...strs, description: "Never these airlines, e.g. [\"FR\",\"RK\"] for no Ryanair." },
      return_airports: { ...strs, description: "Other airports to fly home from (open jaw)." },
      connect_destinations: { type: "boolean", description: "Also fly between the destinations (multi-city)." },
      allow_mixed_airlines: { type: "boolean", description: "false = same airline both ways." },
      allow_self_transfer: { type: "boolean" }, self_transfer_hubs: strs,
      max_travel_min_per_direction: { type: "integer", description: "Max door-to-door minutes each way." },
      carry_on_bags: { type: "integer" }, checked_bags: { type: "integer" },
      confirmed_lookups: { type: "integer", description: "Only after the user agreed to a search the tool said needs confirmation: that number of lookups." },
    } },
  } }];
  const FIELDS = Object.keys(TOOLS[0].function.parameters.properties).filter(k => k !== "confirmed_lookups");

  // ---------------------------------------------------------------- the model
  function systemPrompt() {
    const f = readForm();
    return `You are Skyhop's trip-planning assistant, inside the Skyhop flight search app. Today is ${new Date().toISOString().slice(0, 10)}.
The user plans trips by talking to you. You search with the search_flights tool; its results also appear in the app beside this chat.
- Unless the user says otherwise: origin ${f.from[0] || "TLV"}, currency ${f.currency}, ${plural(f.adults, "adult")}${f.kids.length ? `, children aged ${f.kids.join(", ")}` : ""}.
- You need destinations, the date window and the trip length in nights. If one is missing, ask ONE short question. Never invent dates. "A week" = 6-8 nights; a month name = that whole month.
- A country or region is several airports: pick 2-6 well-known ones (Portugal: LIS, OPO, FAO). Several destinations always go in ONE call.
- Keep every condition the user gave (stops, airlines, travel time, travellers, bags) across follow-ups: when they change one thing, send the rest again.
- A budget is not a search field: search, then say which trips fit it.
- If the tool answers needs_confirmation, ask whether to spend that many lookups, and only after a yes call again with confirmed_lookups.
- Skyhop never books or takes payment; booking happens on the airline's site from the buttons in the results.
Answer in plain text, 2-5 short lines, no tables or headings: the best pick with price, dates and airline, and why; mention self-transfers or long layovers; if the digest says demo, say the prices are demo data.`;
  }

  async function model(messages, opts = {}) {
    const r = await api("/api/chat/complete", { method: "POST", headers: { "Content-Type": "application/json", "X-Skyhop": "1" },
      body: JSON.stringify({ messages, ...opts }) });
    return r.message;
  }

  // ---------------------------------------------------------------- the tool
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const live = () => config.provider.split(",")[0].trim() !== "mock";
  /** Live searches over the threshold need the user's yes, passed back by the model as confirmed_lookups. */
  const needsConfirm = (toFetch, isLive, confirmed) => isLive && toFetch > LIVE_CONFIRM && (confirmed || 0) < toFetch;

  async function searchFlights(args) {
    const f = readForm(), body = { origin: f.from[0] || "TLV", currency: f.currency, adults: f.adults, children_ages: f.kids };
    for (const k of FIELDS) if (args[k] != null) body[k] = args[k];
    let req;
    try { req = SkyhopLocal.models.searchRequest(body); } catch (e) { return { error: e.message }; }
    const est = await post("/api/estimate", req);
    if (est.to_fetch > req.max_api_calls) return { error: `This needs ${est.to_fetch} lookups, over the limit of ${req.max_api_calls}. Narrow the dates, nights or destinations.` };
    if (needsConfirm(est.to_fetch, live(), args.confirmed_lookups)) {
      return { needs_confirmation: true, lookups: est.to_fetch, note: `Real fares: this search uses ${est.to_fetch} paid lookups.` };
    }
    const { id } = await post("/api/searches", req);
    openSearch(id, { fillForm: true });
    let row;
    for (let i = 0; i < 600; i++) {               // up to ~6 minutes; the page shows progress meanwhile
      row = await api(`/api/searches/${id}`);
      if (row.status !== "running") break;
      await sleep(600);
    }
    if (row.status !== "done") return { error: row.error || "The search did not finish." };
    convo.request = row.request;
    return { search_id: id, ...digest(row.result) };
  }

  /** What the model needs to talk about a result, small enough to keep in the conversation. */
  function digest(r) {
    const cheapest = {};
    for (const c of r.cells || []) {
      if (!(c.destination in cheapest) || c.cheapest.price < cheapest[c.destination]) cheapest[c.destination] = c.cheapest.price;
    }
    return {
      demo: !live(), currency: r.request.currency, lookups: r.api_calls + r.cache_hits,
      trips: r.top.slice(0, 5).map(t => ({ destination: t.destination, depart: t.depart_date, return: t.return_date, nights: t.nights,
        price: t.price, airlines: t.airlines.map(c => (config.airlines || {})[c] || c), stops: t.stops,
        travel_hours: Math.round(t.total_travel_min / 6) / 10, self_transfer: t.self_transfer, warnings: t.warnings.slice(0, 2) })),
      cheapest_by_destination: cheapest, no_price: (r.unpriced || []).length, warnings: (r.warnings || []).slice(0, 3),
    };
  }

  // ---------------------------------------------------------------- conversations
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");
  const visible = m => (m.role === "user" || m.role === "assistant") && m.content && !m.hidden;
  async function persist() {
    if (!convo || !convo.messages.some(m => m.role === "user")) return;
    convo.updated = Date.now();
    convo.title = convo.title || convo.messages.find(m => m.role === "user").content.slice(0, 60);
    await chats.put(convo.id, convo);
  }
  function start(brief) {
    convo = { id: newId(), created: Date.now(), updated: Date.now(), title: brief ? brief.title : "", messages: [], brief: brief ? brief.id : null,
      request: brief ? brief.request : null };
    if (brief) {
      convo.messages.push({ role: "system", content: `The user is continuing from this saved trip brief. Keep its conditions unless they change them.\n\n${briefText(brief)}` },
        { role: "assistant", content: `Continuing "${brief.title}". What has changed? New dates, another city, a different budget?` });
      if (brief.request) { writeForm(requestToForm(brief.request)); onFormChange(); }
    }
  }

  /** The conversation as the model sees it: no brief cards or failed turns, no page-only fields. */
  const forModel = ms => ms.filter(m => !m.briefId && !m.failed).map(({ hidden, card, failed, ...m }) => m);

  async function send(text) {
    text = text.trim();
    if (!text || sending) return;
    if (!convo) start();
    convo.messages.push({ role: "user", content: text });
    sending = true; render(); persist();
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const reply = await model([{ role: "system", content: systemPrompt() }, ...forModel(convo.messages)], { tools: TOOLS });
        convo.messages.push({ role: "assistant", content: reply.content || "", ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) });
        if (!reply.tool_calls || !reply.tool_calls.length) break;
        for (const call of reply.tool_calls) {
          let args = {}, out;
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* answered below */ }
          render(searchingCard(args));
          try { out = call.function.name === "search_flights" ? await searchFlights(args) : { error: `unknown tool ${call.function.name}` }; } catch (e) { out = { error: e.message }; }
          convo.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out), card: { args, out } });
          persist(); render();
        }
      }
    } catch (e) {
      convo.messages.push({ role: "assistant", content: `Sorry, I couldn't answer: ${e.message}`, failed: true });
    } finally { sending = false; persist(); render(); }
  }

  // ---------------------------------------------------------------- briefs
  function briefText(b) {
    const list = (title, xs) => (xs && xs.length ? `\n## ${title}\n${xs.map(x => `- ${x}`).join("\n")}\n` : "");
    return `# ${b.title}\n\n_Skyhop trip brief, ${new Date(b.created).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}_\n\n${b.summary}\n`
      + list("What I'm looking for", b.conditions) + list("Best options found", b.best_options) + list("Next steps", b.next_steps)
      + (b.request ? `\nOpen this search in Skyhop: ${shareLink(b.request)}\n` : "");
  }

  async function summarize() {
    if (!convo || sending) return;
    const transcript = convo.messages.filter(m => visible(m) || m.card).map(m => m.card
      ? `[search ${JSON.stringify(m.card.args)} -> ${m.content.slice(0, 1500)}]` : `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
    sending = true; render();
    try {
      const reply = await model([{ role: "system", content: "Summarize this trip-planning conversation as a JSON object with keys: "
        + "title (short, like \"Portugal, late November\"), summary (2-3 plain sentences: who travels, where, when, what matters), "
        + "conditions (short strings: dates, nights, stops, airlines, budget...), best_options (short strings with price, dates, airline), "
        + "next_steps (0-3 short strings). Use only what the conversation says." }, { role: "user", content: transcript }], { json_mode: true });
      const j = JSON.parse(reply.content);
      const brief = { id: newId(), created: Date.now(), chat: convo.id, title: String(j.title || convo.title || "Trip brief").slice(0, 80),
        summary: String(j.summary || ""), conditions: [].concat(j.conditions || []).map(String), best_options: [].concat(j.best_options || []).map(String),
        next_steps: [].concat(j.next_steps || []).map(String), request: convo.request || null, drive: null };
      await briefs.put(brief.id, brief);
      convo.messages.push({ role: "assistant", content: "", hidden: true, briefId: brief.id });
      if (SkyhopLocal.account.hasDrive()) saveToDrive(brief, false);
    } catch (e) {
      convo.messages.push({ role: "assistant", content: `Sorry, I couldn't summarize: ${e.message}`, failed: true });
    } finally { sending = false; persist(); render(); }
  }

  async function saveToDrive(brief, ask = true) {
    try {
      const token = ask ? await SkyhopLocal.account.driveToken() : await SkyhopLocal.account.driveToken().catch(() => null);
      if (!token) return;
      brief.drive = await SkyhopLocal.drive.save(token, brief, briefText(brief));
      await briefs.put(brief.id, brief);
      toast("Saved to Google Drive");
    } catch (e) { toast(e.message); }
    render();
  }

  async function share(brief) {
    const text = briefText(brief);
    try {
      if (navigator.share) await navigator.share({ title: brief.title, text });
      else { await navigator.clipboard.writeText(text); toast("Brief copied: paste it anywhere"); }
    } catch { /* cancelled */ }
  }

  /** A link that opens Skyhop with this search filled in (app.js reads #search=). */
  function shareLink(req) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(req)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${location.origin}${location.pathname}#search=${b64}`;
  }

  async function allBriefs() {
    const local = await briefs.values(), seen = new Set(local.map(b => b.id));
    return [...local, ...driveBriefs.filter(b => !seen.has(b.id))].sort((a, b) => b.created - a.created);
  }
  async function loadDriveBriefs() {
    if (!SkyhopLocal.account.hasDrive()) return;
    try { driveBriefs = await SkyhopLocal.drive.list(await SkyhopLocal.account.driveToken()); render(); } catch { /* offline: local briefs only */ }
  }

  // ---------------------------------------------------------------- rendering
  const needsSignIn = () => SkyhopLocal.backend.enabled() && !SkyhopLocal.account.signedIn();
  const routeLabel = a => `${a.origin || readForm().from[0] || "TLV"} → ${(a.destinations || []).join(", ")}`;
  const when = a => (a.window_start && a.window_end ? ` · ${fmtShort(day(a.window_start))} – ${fmtShort(day(a.window_end))}` : "")
    + (a.min_nights ? ` · ${a.min_nights === a.max_nights ? plural(a.min_nights, "night") : `${a.min_nights}–${a.max_nights} nights`}` : "");
  function searchingCard(args) { return h("div", { class: "msg tool busy" }, h("b", {}, "🔎 Searching "), routeLabel(args), when(args), "…"); }

  function toolCard({ args, out }) {
    const prices = [...Object.values(out.cheapest_by_destination || {}), ...(out.trips || []).map(t => t.price)];
    const from = prices.length ? Math.min(...prices) : null;
    return h("div", { class: "msg tool" }, h("div", {}, h("b", {}, "🔎 "), routeLabel(args), when(args)),
      out.error ? h("div", { class: "bad" }, out.error)
        : out.needs_confirmation ? h("div", {}, `Needs ${out.lookups} paid lookups: say yes to go ahead.`)
        : h("div", { class: "tool-foot" }, from != null ? h("span", {}, "from ", h("b", {}, money(from, out.currency)), out.demo ? " · demo prices" : "") : "No trips found",
          h("button", { type: "button", class: "btn small", onclick: () => { close(); $("#results").scrollIntoView({ behavior: "smooth" }); } }, "Show results")));
  }

  function briefCard(b, opts = {}) {
    const drive = SkyhopLocal.account.configured();
    return h("div", { class: "msg brief" },
      h("div", { class: "brief-title" }, "📝 ", b.title), opts.full ? h("p", {}, b.summary) : null,
      opts.full && b.best_options.length ? h("ul", {}, b.best_options.map(x => h("li", {}, x))) : null,
      h("div", { class: "brief-meta" }, new Date(b.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        b.drive ? h("a", { href: b.drive.link, target: "_blank", rel: "noopener" }, " · in Google Drive ↗") : " · on this device"),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn small accent", onclick: () => { start(b); render(); els.input.focus(); } }, "Continue"),
        h("button", { type: "button", class: "btn small", onclick: () => share(b) }, "Share"),
        drive && !b.drive && SkyhopLocal.account.signedIn() ? h("button", { type: "button", class: "btn small", onclick: () => saveToDrive(b) }, "Save to Drive") : null,
        opts.full ? null : h("button", { type: "button", class: "btn small ghost", "aria-label": `Delete brief ${b.title}`, onclick: async () => {
          if (!confirm(`Delete the brief "${b.title}" from this device?`)) return;
          await briefs.delete(b.id); driveBriefs = driveBriefs.filter(x => x.id !== b.id); render();
        } }, "Delete")));
  }

  const EXAMPLES = ["A week somewhere warm in late November, direct flights only",
    "Rome or Athens, 4 to 6 nights in December, no Ryanair", "Portugal for 2 adults and a 6-year-old over Hanukkah"];

  async function home() {
    const [bs, cs] = await Promise.all([allBriefs(), chats.values()]);
    const recent = cs.sort((a, b) => b.updated - a.updated).slice(0, 8);
    return [
      h("div", { class: "tb-intro" }, h("h3", {}, "Plan a trip by talking"),
        h("p", {}, "Say where, when and what matters to you. I'll search, show the results beside this chat, and remember the conversation. Press Summarize to keep a trip brief you can continue later."),
        h("div", { class: "chat-examples" }, EXAMPLES.map(x => h("button", { type: "button", class: "chip-btn", onclick: () => send(x) }, x)))),
      bs.length ? h("div", { class: "side-title" }, "Trip briefs") : null, ...bs.map(b => briefCard(b)),
      recent.length ? h("div", { class: "side-title" }, "Recent chats") : null,
      ...recent.map(c => h("button", { type: "button", class: "chat-recent", onclick: () => { convo = c; if (c.request) { writeForm(requestToForm(c.request)); onFormChange(); } render(); } },
        h("span", {}, c.title), h("small", {}, ago(c.updated / 1000)))),
    ];
  }

  let renderSeq = 0;
  async function render(extra) {
    if (!els) return;
    const seq = ++renderSeq;
    $("#chat-summarize").disabled = sending || !convo || !convo.messages.some(m => m.role === "user");
    $("#chat-new").disabled = sending || !convo;
    els.form.hidden = needsSignIn();
    els.signin.hidden = !needsSignIn();
    els.send.disabled = sending;
    let kids;
    if (!convo || !convo.messages.some(visible)) kids = await home();
    else {
      const bs = new Map((await briefs.values()).map(b => [b.id, b]));
      kids = convo.messages.map(m => m.card ? toolCard(m.card)
        : m.briefId ? (bs.has(m.briefId) ? briefCard(bs.get(m.briefId), { full: true }) : null)
        : visible(m) ? h("div", { class: `msg ${m.role === "user" ? "me" : "ai"}${m.failed ? " bad" : ""}` }, m.content) : null);
    }
    if (seq !== renderSeq) return;
    els.body.replaceChildren(...kids.filter(Boolean), extra || (sending ? h("div", { class: "msg ai typing", "aria-label": "Skyhop is thinking" }, "•••") : ""));
    els.body.scrollTop = els.body.scrollHeight;
  }

  // ---------------------------------------------------------------- open / close
  function open() {
    opened = true; $("#chat").hidden = false; $("#chat-scrim").hidden = false; $("#chat-launch").setAttribute("aria-expanded", "true");
    void $("#chat").offsetWidth;
    $("#chat").classList.add("open"); render(); loadDriveBriefs();
    if (!needsSignIn()) els.input.focus();
  }
  function close() {
    opened = false; $("#chat").classList.remove("open"); $("#chat-scrim").hidden = true; $("#chat-launch").setAttribute("aria-expanded", "false");
    setTimeout(() => { if (!opened) $("#chat").hidden = true; }, 220);
  }
  function init() {
    if (SkyhopLocal.backend.enabled() && !SkyhopLocal.account.configured()) return;   // Pages without the Worker: no model to ask
    els = { body: $("#chat-body"), form: $("#chat-form"), input: $("#chat-input"), send: $("#chat-send"), signin: $("#chat-signin") };
    $("#chat-launch").hidden = false;
    $("#chat-launch").addEventListener("click", () => (opened ? close() : open()));
    $("#chat-close").addEventListener("click", close); $("#chat-scrim").addEventListener("click", close);
    $("#chat-new").addEventListener("click", () => { convo = null; render(); els.input.focus(); });
    $("#chat-summarize").addEventListener("click", summarize);
    els.signin.addEventListener("click", async () => { await toggleAccount(); render(); });
    els.form.addEventListener("submit", e => { e.preventDefault(); const t = els.input.value; els.input.value = ""; send(t); });
    els.input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); } });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && opened) close(); });
  }
  return { init, open, send, needsConfirm, shareLink };
})();
