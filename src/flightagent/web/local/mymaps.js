/* Put a search on a MyMaps AI map (alon24/mymaps-ai): its destinations as pins with their best fares, and a line from
   home to each. MyMaps keeps maps as JSON files in the user's Google Drive ("MyMaps AI" folder, tagged app=mymaps-ai)
   and opens one at <app>#/m/<fileId>. Skyhop writes files in that same format and place. Because both apps use the
   same Google OAuth client, the drive.file scope lets each see the other's files. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const API = "https://www.googleapis.com/drive/v3/files", UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const FOLDER = "MyMaps AI", FOLDER_TYPE = "application/vnd.google-apps.folder", TAG = "appProperties has { key='app' and value='mymaps-ai' }";
  const PALETTE = ["#1f6f5c", "#d1495b", "#edae49", "#00798c", "#30638e", "#7b2d8e", "#e07a1f", "#3d9a3d", "#5c5c5c", "#c2185b"];   // MyMaps' own
  const base = () => ((root.SKYHOP_RUNTIME || {}).mymapsUrl || "https://alon24.github.io/mymaps-ai/").replace(/\/?$/, "/");
  const link = id => `${base()}#/m/${encodeURIComponent(id)}`;
  const uid = () => crypto.randomUUID();
  const fileName = title => `${(title || "Trip").replace(/[\\/]/g, "_")}.mymap.json`;
  let coords = null;
  const coordsOf = () => (coords = coords || fetch("airport_coords.json").then(r => r.json()));

  const point = (code, [lat, lon], name, description, color, icon) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { id: uid(), name, description, color, icon } });
  const line = (a, b, name, color) => ({ type: "Feature", geometry: { type: "LineString", coordinates: [[a[1], a[0]], [b[1], b[0]]] },
    properties: { id: uid(), name, description: "", color } });

  /** One MyMaps layer for a chat search ({args, out} from chat.js): home, each destination with its best fare, lines between. */
  async function layer({ args, out }, { origin, names = {}, money = (v, c) => `${Math.round(v)} ${c}`, color = PALETTE[1] } = {}) {
    const at = await coordsOf(), from = origin || args.origin;
    const dests = (args.destinations || []).filter(d => at[d]);
    if (!at[from] || !dests.length) throw new Error("No map position for these airports");
    const best = d => (out.trips || []).find(t => t.destination === d);
    const features = [point(from, at[from], `${names[from] || from} (home)`, "", PALETTE[8], "🏠")];
    for (const d of dests) {
      const t = best(d), price = (out.cheapest_by_destination || {})[d];
      const desc = [price != null ? `From ${money(price, out.currency)}` : "No fare found",
        t ? `Best pick: ${t.depart} → ${t.return} (${t.nights} nights), ${t.airlines.join(" / ")}, ${money(t.price, out.currency)}` : ""].filter(Boolean).join("\n");
      features.push(point(d, at[d], names[d] || d, desc, color, "📍"), line(at[from], at[d], `${from} → ${d}`, color));
    }
    const when = args.window_start ? ` · ${args.window_start.slice(5)}–${(args.window_end || "").slice(5)}` : "";
    return { id: uid(), name: `✈ ${from} → ${dests.join(", ")}${when}`, visible: true, color, style: "individual", features };
  }

  const call = (token, url, opts) => L.drive.call(token, url, opts);

  /** MyMaps maps this account can see, newest first: [{id, name}]. */
  async function list(token) {
    const q = `trashed=false and mimeType='application/json' and ${TAG}`;
    const r = await call(token, `${API}?${new URLSearchParams({ q, orderBy: "modifiedTime desc", pageSize: "30", fields: "files(id,name)" })}`);
    return (r.files || []).map(f => ({ id: f.id, name: f.name.replace(/\.mymap\.json$/, "") }));
  }

  async function folder(token) {
    const q = `mimeType='${FOLDER_TYPE}' and name='${FOLDER}' and trashed=false and ${TAG}`;
    const found = await call(token, `${API}?${new URLSearchParams({ q, fields: "files(id)", spaces: "drive" })}`);
    if (found.files && found.files.length) return found.files[0].id;
    return (await call(token, `${API}?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_TYPE, appProperties: { app: "mymaps-ai" } }) })).id;
  }

  async function anyoneCanView(token, id) {
    await call(token, `${API}/${id}/permissions?supportsAllDrives=true`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }) });
  }

  /** A new map holding this layer. Resolves with {id, url}. */
  async function create(token, title, lyr, { share = false } = {}) {
    const doc = { schema: 1, id: uid(), title, description: "Made by Skyhop", layers: [lyr], updatedAt: new Date().toISOString() };
    const meta = { name: fileName(title), mimeType: "application/json", parents: [await folder(token)], appProperties: { app: "mymaps-ai" } };
    const b = `skyhop${Date.now().toString(36)}`;
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(doc)}\r\n--${b}--`;
    const f = await call(token, `${UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
    if (share) await anyoneCanView(token, f.id);
    return { id: f.id, url: link(f.id) };
  }

  /** Add the layer to an existing map (in a colour it doesn't use yet). */
  async function addTo(token, id, lyr, { share = false } = {}) {
    const doc = JSON.parse(await call(token, `${API}/${id}?alt=media&supportsAllDrives=true`, { raw: true }));
    if (!doc || !Array.isArray(doc.layers)) throw new Error("That file isn't a MyMaps AI map");
    const used = new Set(doc.layers.map(l => l.color)), color = PALETTE.find(c => !used.has(c)) || lyr.color;
    doc.layers.push({ ...lyr, color, features: lyr.features.map(f => (f.properties.icon === "🏠" ? f : { ...f, properties: { ...f.properties, color } })) });
    doc.updatedAt = new Date().toISOString();
    await call(token, `${UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
    if (share) await anyoneCanView(token, id);
    return { id, url: link(id) };
  }

  L.mymaps = { layer, list, create, addTo, link };
  if (typeof module !== "undefined" && module.exports) module.exports = L.mymaps;
})(typeof window !== "undefined" ? window : globalThis);
