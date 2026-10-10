/* Trip briefs (chat.js) in the user's Google Drive: a readable Markdown file per brief in a "Skyhop trip briefs" folder,
   so they reach every device and can be shared the normal Drive way. The drive.file scope (account.driveToken) only
   lets Skyhop see files it created. The brief's data rides along in an HTML comment at the end, so a brief opened on
   another device can be continued. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const API = "https://www.googleapis.com/drive/v3/files", UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const FOLDER = "Skyhop trip briefs", FOLDER_TYPE = "application/vnd.google-apps.folder";
  const DATA = /<!-- skyhop-brief (\{[\s\S]*\}) -->\s*$/;

  async function call(token, url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Google Drive refused: sign in again" : `Google Drive answered ${r.status}`);
    return opts.raw ? r.text() : r.json();
  }

  async function folder(token) {
    const q = `name='${FOLDER}' and mimeType='${FOLDER_TYPE}' and trashed=false`;
    const found = await call(token, `${API}?${new URLSearchParams({ q, fields: "files(id)", spaces: "drive" })}`);
    if (found.files && found.files.length) return found.files[0].id;
    return (await call(token, `${API}?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_TYPE }) })).id;
  }

  /** Create the brief's file, or replace its contents if it was saved before. Resolves with {id, link}. */
  async function save(token, brief, markdown) {
    const meta = { name: `${brief.title}.md`, mimeType: "text/markdown", appProperties: { skyhop: "brief" } };
    if (!brief.drive) meta.parents = [await folder(token)];
    const b = `skyhop${Date.now().toString(36)}`;
    const content = `${markdown}\n\n<!-- skyhop-brief ${JSON.stringify({ ...brief, drive: undefined })} -->\n`;
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
    const url = brief.drive ? `${UPLOAD}/${brief.drive.id}?uploadType=multipart&fields=id,webViewLink` : `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`;
    const f = await call(token, url, { method: brief.drive ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
    return { id: f.id, link: f.webViewLink };
  }

  /** Every brief Skyhop saved to this Drive, newest first, read back from the files (for other devices). */
  async function list(token, limit = 20) {
    const q = "appProperties has { key='skyhop' and value='brief' } and trashed=false";
    const found = await call(token, `${API}?${new URLSearchParams({ q, orderBy: "modifiedTime desc", pageSize: String(limit), fields: "files(id,webViewLink)" })}`);
    const out = [];
    for (const f of found.files || []) {
      const m = DATA.exec(await call(token, `${API}/${f.id}?alt=media`, { raw: true }));
      if (!m) continue;
      try { out.push({ ...JSON.parse(m[1]), drive: { id: f.id, link: f.webViewLink } }); } catch { /* not ours to read */ }
    }
    return out;
  }

  L.drive = { save, list, call };
})(typeof window !== "undefined" ? window : globalThis);
