"use strict";
/* Ask Skyhop: an AI chat that plans a trip with you. You say where, when and your conditions in plain words; the model
   calls `search_flights`, which runs here in the page: it fills the form and shows the results next to the chat, then
   hands the model a short digest to talk about. Conversations are kept on this device (IndexedDB) and can be resumed.
   "Summarize" turns one into a trip brief (kept here, and in Google Drive when signed in on the web version); a brief
   can be continued later in a new chat, e.g. with new dates. The model call goes through /api/chat/complete (the
   server's or, on GitHub Pages, the Worker's), which holds the key. On the web version a conversation can also become a
   shared trip (trip.js): a group chat where friends join by link and anyone can ask Skyhop. */
const Chat = (() => {
  const chats = new SkyhopLocal.db.Store("chats"), briefs = new SkyhopLocal.db.Store("briefs");
  const LIVE_CONFIRM = 40;       // live searches needing more paid lookups than this are confirmed with the user first
  const MAX_TOOL_ROUNDS = 4;
  let convo = null, opened = false, sending = false, els, driveBriefs = [], lastRequest = null, pendingTrip = null;

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
  const GROUP = "\nThis is a group chat about one trip: several people plan it together and each message starts with who wrote it. "
    + "Answer the latest request, keep everyone's conditions in mind, and name people when it helps.";
  function systemPrompt() {
    const f = readForm();
    return `You are Skyhop's trip-planning assistant, inside the Skyhop flight search app. Today is ${new Date().toISOString().slice(0, 10)}.
The user plans trips by talking to you. You search with the search_flights tool; its results also appear in the app beside this chat.
- The user decides where and when. When they name a place, search it right away. Never argue with or second-guess their choice, and never offer other destinations unless they ask.
- If their latest wish clashes with an earlier one ("somewhere warm", then Denmark in November), the latest wish wins: search it, and mention the clash in a few words at most, never as a question. A "no" to your suggestion means: keep what they asked for.
- Answer in the user's language: if they write Hebrew, answer in Hebrew.
- Unless the user says otherwise: origin ${f.from[0] || "TLV"}, currency ${f.currency}, ${plural(f.adults, "adult")}${f.kids.length ? `, children aged ${f.kids.join(", ")}` : ""}.
- You need destinations, the date window and the trip length in nights. If one is missing, ask ONE short question. Never invent dates. "A week" = 6-8 nights; a month name = that whole month.
- A country or region is several airports: pick 2-6 well-known ones (Portugal: LIS, OPO, FAO). Several destinations always go in ONE call.
- Keep every condition the user gave (stops, airlines, travel time, travellers, bags) across follow-ups: when they change one thing, send the rest again.
- A budget is not a search field: search, then say which trips fit it.
- If the tool answers needs_confirmation, ask whether to spend that many lookups, and only after a yes call again with confirmed_lookups.
- After results for a country or several cities, offer once to put them on a map: the "🗺 Map it" button on the search card makes a MyMaps AI map (new, or added to one they have).
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
    lastRequest = row.request;
    return digest(row.result);
  }

  /** What the model needs to talk about a result, small enough to keep in the conversation. */
  function digest(r) {
    const cheapest = {};
    for (const c of r.cells || []) {
      if (!(c.destination in cheapest) || c.cheapest.price < cheapest[c.destination]) cheapest[c.destination] = c.cheapest.price;
    }
    for (const k in cheapest) cheapest[k] = Math.round(cheapest[k]);
    const top = r.top.slice(0, 5), tripWarnings = {};   // a warning that fits several trips is written once
    top.forEach((t, i) => t.warnings.slice(0, 2).forEach(w => (tripWarnings[w] = tripWarnings[w] || []).push(i + 1)));
    return {
      demo: !live(), currency: r.request.currency, lookups: r.api_calls + r.cache_hits,
      trips: top.map(t => ({ destination: t.destination, depart: t.depart_date, return: t.return_date, nights: t.nights,
        price: Math.round(t.price), airlines: t.airlines.map(c => (config.airlines || {})[c] || c), stops: t.stops,
        travel_hours: Math.round(t.total_travel_min / 6) / 10, self_transfer: t.self_transfer })),
      trip_warnings: tripWarnings, cheapest_by_destination: cheapest, no_price: (r.unpriced || []).length, warnings: (r.warnings || []).slice(0, 3),
    };
  }

  /** An older search as the model sees it: every turn resends the whole conversation, so only the latest search is
      kept in full. The best trip and the cheapest price per destination are enough to compare against. */
  function earlier(out) {
    if (!out || !out.trips) return out;
    const b = out.trips[0];
    return { earlier_search: true, currency: out.currency, demo: out.demo, cheapest_by_destination: out.cheapest_by_destination,
      best: b && { destination: b.destination, depart: b.depart, return: b.return, price: b.price, airlines: b.airlines } };
  }
  function shrinkOlderSearches(msgs) {
    const last = msgs.map(m => m.role).lastIndexOf("tool");
    return msgs.map((m, i) => {
      if (m.role !== "tool" || i === last) return m;
      try { return { ...m, content: JSON.stringify(earlier(JSON.parse(m.content))) }; } catch { return m; }
    });
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
  const forModel = ms => ms.filter(m => !m.briefId && !m.map && !m.failed).map(({ hidden, card, failed, ...m }) => m);

  /** Ask the model until it answers in words, running its searches on the way. `history` is the conversation in the
      model's format; `step` gets each new assistant or tool message as it happens (tool messages carry a `card`). */
  async function converse(history, step, group = false) {
    const msgs = [...history];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await model([{ role: "system", content: systemPrompt() + (group ? GROUP : "") }, ...shrinkOlderSearches(msgs)], { tools: TOOLS });
      const said = { role: "assistant", content: reply.content || "", ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) };
      msgs.push(said); await step(said);
      if (!reply.tool_calls || !reply.tool_calls.length) return;
      for (const call of reply.tool_calls) {
        let args = {}, out;
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* answered below */ }
        lastRequest = null;
        render(searchingCard(args));
        try { out = call.function.name === "search_flights" ? await searchFlights(args) : { error: `unknown tool ${call.function.name}` }; } catch (e) { out = { error: e.message }; }
        const result = { role: "tool", tool_call_id: call.id, content: JSON.stringify(out) };
        msgs.push(result); await step({ ...result, card: { args, out, request: lastRequest } });
      }
    }
  }

  async function send(text) {
    text = text.trim();
    if (!text || sending) return;
    if (Trip.active()) return tripSend(text, false);
    if (!convo) start();
    convo.messages.push({ role: "user", content: text });
    sending = true; render(); persist();
    try {
      await converse(forModel(convo.messages), async m => {
        convo.messages.push(m);
        if (m.card && m.card.request) convo.request = m.card.request;
        await persist(); render();
      });
    } catch (e) {
      convo.messages.push({ role: "assistant", content: `Sorry, I couldn't answer: ${e.message}`, failed: true });
    } finally { sending = false; persist(); render(); }
  }

  // ---------------------------------------------------------------- shared trips (trip.js)
  /** Post to the group; with `ask`, Skyhop answers too (its searches and reply are posted for everyone). */
  async function tripSend(text, ask) {
    text = text.trim();
    if ((!text && !ask) || sending) return;
    sending = true; render();
    try {
      if (text) await Trip.post("user", text);
      if (ask) {
        await converse(Trip.history(), async m => {
          if (m.card) await Trip.post("search", "", m.card);
          else if (m.content) await Trip.post("ai", m.content);
        }, true);
      }
    } catch (e) { toast(e.message); } finally { sending = false; render(); }
  }

  /** Turn this conversation into a shared trip and hand out its invite link. */
  async function shareTrip() {
    if (!convo || sending) return;
    sending = true; render();
    try {
      const messages = convo.messages.flatMap(m => m.card ? [{ kind: "search", author: "ai", text: "", data: m.card }]
        : visible(m) && !m.failed ? [{ kind: m.role === "user" ? "user" : "ai", author: m.role === "user" ? "" : "ai", text: m.content }] : []);
      const t = await Trip.create({ title: convo.title || "Shared trip", messages, request: convo.request });
      await invite(t.id);
    } catch (e) { toast(e.message); } finally { sending = false; render(); }
  }

  async function invite(id) {
    const url = Trip.link(id), text = "Plan this trip with me on Skyhop (sign in with Google to join):";
    try {
      if (navigator.share) await navigator.share({ title: "Skyhop trip", text, url });
      else { await navigator.clipboard.writeText(`${text} ${url}`); toast("Invite link copied: anyone with it can join after signing in"); }
    } catch { /* cancelled */ }
  }

  async function openTrip(id) {
    pendingTrip = null;
    if (!SkyhopLocal.account.signedIn()) { pendingTrip = id; open(); return; }
    try { await Trip.join(id); } catch (e) { toast(`Couldn't open that trip: ${e.message}`); Trip.forget(id); }
    open(); refreshMode();
  }

  // ---------------------------------------------------------------- briefs
  function briefText(b) {
    const list = (title, xs) => (xs && xs.length ? `\n## ${title}\n${xs.map(x => `- ${x}`).join("\n")}\n` : "");
    return `# ${b.title}\n\n_Skyhop trip brief, ${new Date(b.created).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}_\n\n${b.summary}\n`
      + list("What I'm looking for", b.conditions) + list("Best options found", b.best_options) + list("Next steps", b.next_steps)
      + (b.request ? `\nOpen this search in Skyhop: ${shareLink(b.request)}\n` : "");
  }

  async function summarize() {
    if (sending || !(Trip.active() || convo)) return;
    const t = Trip.active() ? Trip.current() : null;
    const transcript = t ? Trip.history().map(m => `${m.role === "user" ? "" : "Skyhop: "}${m.content}`).join("\n")
      : convo.messages.filter(m => visible(m) || m.card).map(m => m.card
        ? `[search ${JSON.stringify(m.card.args)} -> ${m.content.slice(0, 1500)}]` : `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
    sending = true; render();
    try {
      const reply = await model([{ role: "system", content: "Summarize this trip-planning conversation as a JSON object with keys: "
        + "title (short, like \"Portugal, late November\"), summary (2-3 plain sentences: who travels, where, when, what matters), "
        + "conditions (short strings: dates, nights, stops, airlines, budget...), best_options (short strings with price, dates, airline), "
        + "next_steps (0-3 short strings). Use only what the conversation says." }, { role: "user", content: transcript }], { json_mode: true });
      const j = JSON.parse(reply.content);
      const request = t ? ([...t.messages].reverse().find(m => m.kind === "search" && m.data.request) || {}).data?.request || t.request : convo.request;
      const brief = { id: newId(), created: Date.now(), chat: t ? `trip:${t.id}` : convo.id, title: String(j.title || (t || convo).title || "Trip brief").slice(0, 80),
        summary: String(j.summary || ""), conditions: [].concat(j.conditions || []).map(String), best_options: [].concat(j.best_options || []).map(String),
        next_steps: [].concat(j.next_steps || []).map(String), request: request || null, drive: null };
      await briefs.put(brief.id, brief);
      if (t) { await Trip.post("brief", brief.title, brief); await Trip.update({ brief, request: brief.request }); }
      else convo.messages.push({ role: "assistant", content: "", hidden: true, briefId: brief.id });
      if (SkyhopLocal.account.hasDrive()) saveToDrive(brief, false);
    } catch (e) {
      if (t) toast(`Couldn't summarize: ${e.message}`);
      else convo.messages.push({ role: "assistant", content: `Sorry, I couldn't summarize: ${e.message}`, failed: true });
    } finally { sending = false; if (!t) persist(); render(); }
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
  const needsSignIn = () => !SkyhopLocal.account.signedIn();
  const routeLabel = a => `${a.origin || readForm().from[0] || "TLV"} → ${(a.destinations || []).join(", ")}`;
  const when = a => (a.window_start && a.window_end ? ` · ${fmtShort(day(a.window_start))} – ${fmtShort(day(a.window_end))}` : "")
    + (a.min_nights ? ` · ${a.min_nights === a.max_nights ? plural(a.min_nights, "night") : `${a.min_nights}–${a.max_nights} nights`}` : "");
  function searchingCard(args) { return h("div", { class: "msg tool busy" }, h("b", {}, "🔎 Searching "), routeLabel(args), when(args), "…"); }

  /** Fill the form with a search from the chat and run it (a shared trip's members each run it on their own page). */
  function showSearch(request) {
    close();
    if (request) { writeForm(requestToForm(request)); onFormChange(); $("#form").requestSubmit(); }
    $("#results").scrollIntoView({ behavior: "smooth" });
  }

  // ---------------------------------------------------------------- MyMaps AI (local/mymaps.js)
  const canMap = () => SkyhopLocal.account.configured() && SkyhopLocal.account.signedIn();

  let picker = null;      // the map picker open under one search card: {card, title, token, maps, which, share, busy}

  /** Open the picker under a search card: a new MyMaps AI map, or one the user already has. */
  async function mapIt(card, title) {
    try { picker = { card, title, token: await SkyhopLocal.account.driveToken(), maps: [], which: "", share: false }; } catch (e) { toast(e.message); return; }
    render();
    const p = picker;
    p.maps = await SkyhopLocal.mymaps.list(p.token).catch(() => []);     // a new map still works without the list
    if (picker === p) render();
  }

  async function makeMap(p) {
    p.busy = true; render();
    try {
      const { args } = p.card, origin = args.origin || readForm().from[0] || "TLV";
      const names = Object.fromEntries([origin, ...(args.destinations || [])].map(c => [c, (airport(c) || {}).city || c]));
      const lyr = await SkyhopLocal.mymaps.layer(p.card, { origin, names, money: fmtMoney });
      const done = p.which ? await SkyhopLocal.mymaps.addTo(p.token, p.which, lyr, { share: p.share })
        : await SkyhopLocal.mymaps.create(p.token, p.title, lyr, { share: p.share });
      const map = { title: p.which ? p.maps.find(m => m.id === p.which).name : p.title, url: done.url, shared: p.share };
      picker = null;
      if (Trip.active()) await Trip.post("map", map.title, map);
      else { convo.messages.push({ role: "assistant", content: "", hidden: true, map }); await persist(); }
    } catch (e) { toast(e.message); p.busy = false; }
    render();
  }

  function pickerView(p) {
    return h("div", { class: "map-pick" },
      h("select", { "aria-label": "Which map", onchange: e => { p.which = e.target.value; } },
        h("option", { value: "" }, `New map: ${p.title}`), p.maps.map(m => h("option", { value: m.id, selected: m.id === p.which }, `Add to: ${m.name}`))),
      h("label", {}, h("input", { type: "checkbox", checked: p.share, onchange: e => { p.share = e.target.checked; } }), " Anyone with the link can view it"),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn small accent", disabled: p.busy, onclick: () => makeMap(p) }, p.busy ? "Making the map…" : "Make map"),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { picker = null; render(); } }, "Cancel")));
  }

  function mapCard(m) {
    return h("div", { class: "msg tool" }, h("div", {}, "🗺 ", h("b", {}, m.title), m.shared ? " · anyone with the link can view" : ""),
      h("a", { class: "btn small", href: m.url, target: "_blank", rel: "noopener" }, "Open in MyMaps AI ↗"));
  }

  function toolCard(card, shared = false) {
    const { args, out, request } = card;
    const prices = [...Object.values(out.cheapest_by_destination || {}), ...(out.trips || []).map(t => t.price)];
    const from = prices.length ? Math.min(...prices) : null;
    return h("div", { class: "msg tool" }, h("div", {}, h("b", {}, "🔎 "), routeLabel(args), when(args)),
      out.error ? h("div", { class: "bad" }, out.error)
        : out.needs_confirmation ? h("div", {}, `Needs ${out.lookups} paid lookups: say yes to go ahead.`)
        : h("div", { class: "tool-foot" }, from != null ? h("span", {}, "from ", h("b", {}, money(from, out.currency)), out.demo ? " · demo prices" : "") : "No trips found",
          h("span", { class: "actions" },
            canMap() && (args.destinations || []).length && !(picker && picker.card === card) ? h("button", { type: "button", class: "btn small",
              onclick: () => mapIt(card, Trip.active() ? Trip.current().title : (convo && convo.title) || `Trip to ${args.destinations.join(", ")}`) }, "🗺 Map it") : null,
            h("button", { type: "button", class: "btn small", onclick: () => showSearch(shared ? request : null) }, shared ? "Open results" : "Show results"))),
      picker && picker.card === card ? pickerView(picker) : null);
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
      Trip.remembered().length && SkyhopLocal.account.trips() ? h("div", { class: "side-title" }, "Shared trips") : null,
      ...(SkyhopLocal.account.trips() ? Trip.remembered() : []).map(t => h("button", { type: "button", class: "chat-recent", onclick: () => openTrip(t.id) },
        h("span", {}, "👥 ", t.title), h("small", {}, ago(t.at / 1000)))),
      recent.length ? h("div", { class: "side-title" }, "Recent chats") : null,
      ...recent.map(c => h("button", { type: "button", class: "chat-recent", onclick: () => { convo = c; if (c.request) { writeForm(requestToForm(c.request)); onFormChange(); } render(); } },
        h("span", {}, c.title), h("small", {}, ago(c.updated / 1000)))),
    ];
  }

  function tripView(t) {
    const me = SkyhopLocal.account.email(), url = Trip.link(t.id);
    return [h("label", { class: "invite-link" }, "Invite link · anyone with it can join after signing in with Google",
      h("input", { readonly: true, value: url, "aria-label": "Invite link", onfocus: e => e.target.select() })), ...t.messages.map(m => m.kind === "search" ? toolCard(m.data, true)
      : m.kind === "brief" ? briefCard({ ...m.data, drive: null }, { full: true })
      : m.kind === "map" ? mapCard(m.data)
      : h("div", { class: `msg ${m.author === me ? "me" : "ai"}${m.kind === "user" && m.author !== me ? " them" : ""}` },
        m.author === me ? null : h("span", { class: "who" }, Trip.name(m.author)), m.text))];
  }

  function header() {
    const t = Trip.active() ? Trip.current() : null, canShare = SkyhopLocal.account.allowed() && SkyhopLocal.account.trips();
    $("#chat-title").textContent = t ? `👥 ${t.title}` : pendingTrip ? "Join a shared trip" : "Ask Skyhop";
    $("#chat-sub").textContent = t ? `With ${t.members.map(Trip.name).join(", ")}. Write to the group, or press ✨ to ask Skyhop.`
      : "Tell me where, when and what matters. I search, show the results beside this chat, and remember it all.";
    $("#chat-summarize").disabled = sending || !(t ? t.messages.length : convo && convo.messages.some(m => m.role === "user"));
    $("#chat-new").hidden = !!t; $("#chat-new").disabled = sending || !convo;
    $("#chat-share").hidden = !!t || !canShare; $("#chat-share").disabled = sending || !convo || !convo.messages.some(m => m.role === "user");
    $("#chat-invite").hidden = $("#chat-leave").hidden = !t;
    els.ask.hidden = !t;
    els.input.placeholder = t ? "Message the group, or press ✨ to ask Skyhop" : "e.g. Portugal for a week in late November, direct only, under ₪2000";
    els.signin.textContent = pendingTrip ? "Sign in with Google to join" : "Sign in with Google to chat";
  }

  let renderSeq = 0;
  async function render(extra) {
    if (!els) return;
    const seq = ++renderSeq;
    header();
    els.form.hidden = needsSignIn();
    els.signin.hidden = !needsSignIn();
    els.send.disabled = els.ask.disabled = sending;
    let kids;
    if (Trip.active()) kids = tripView(Trip.current());
    else if (pendingTrip) kids = [h("div", { class: "tb-intro" }, h("h3", {}, "You're invited to plan a trip"),
      h("p", {}, "Sign in with Google to join the group chat. Everyone in it sees the same conversation and searches, and anyone can ask Skyhop."))];
    else if (!convo || !convo.messages.some(visible)) kids = await home();
    else {
      const bs = new Map((await briefs.values()).map(b => [b.id, b]));
      kids = convo.messages.map(m => m.card ? toolCard(m.card)
        : m.briefId ? (bs.has(m.briefId) ? briefCard(bs.get(m.briefId), { full: true }) : null)
        : m.map ? mapCard(m.map)
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
    if (!SkyhopLocal.account.configured()) return;   // no Worker configured: no model to ask
    els = { body: $("#chat-body"), form: $("#chat-form"), input: $("#chat-input"), send: $("#chat-send"), ask: $("#chat-ask"), signin: $("#chat-signin") };
    $("#chat-launch").hidden = false;
    $("#chat-launch").addEventListener("click", () => (opened ? close() : open()));
    $("#chat-close").addEventListener("click", close); $("#chat-scrim").addEventListener("click", close);
    $("#chat-new").addEventListener("click", () => { convo = null; render(); els.input.focus(); });
    $("#chat-summarize").addEventListener("click", summarize);
    $("#chat-share").addEventListener("click", shareTrip);
    $("#chat-invite").addEventListener("click", () => invite(Trip.current().id));
    $("#chat-leave").addEventListener("click", () => { Trip.leave(); convo = null; refreshMode(); render(); });
    els.signin.addEventListener("click", async () => {
      try { await SkyhopLocal.account.signIn(); } catch (e) { toast(e.message); return render(); }
      if (pendingTrip) await openTrip(pendingTrip); else { await refreshMode(); render(); }
    });
    const take = () => { const t = els.input.value; els.input.value = ""; return t; };
    els.form.addEventListener("submit", e => { e.preventDefault(); send(take()); });
    els.ask.addEventListener("click", () => tripSend(take(), true));
    els.input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); } });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && opened) close(); });
    Trip.watch(() => render(), () => opened);
    const m = /^#trip=([a-z0-9]{12})$/.exec(location.hash);
    if (m) { history.replaceState(null, "", location.pathname + location.search); openTrip(m[1]); }
  }
  return { init, open, send, needsConfirm, shareLink, openTrip, earlier };
})();
