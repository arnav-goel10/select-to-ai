/**
 * The demo app: one draft with a note, "Save draft" (asks to confirm) and
 * "Discard". State lives in memory. The demo switches the site between four
 * versions with POST /__site?v=..., and reads the server's own record of
 * what happened with GET /__truth.
 *
 *   original   as recorded
 *   cosmetic   ids renamed, the field relabelled "Your note", the dialog reworded
 *   decoy      "Save draft" removed; "Discard" now sits in its place and has its id
 *   publish    the confirm dialog now publishes the draft to every customer
 */
import http from "node:http";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const SITES = {
  original: { ids: { note: "note", save: "save", confirm: "confirm", discard: "discard", discardConfirm: "discard-confirm" }, noteLabel: "Note", title: "Save this draft?", text: "Your changes are kept as a draft. Only you can see it.", action: "save", saveButton: true },
  cosmetic: { ids: { note: "draft-body", save: "btn-save-v2", confirm: "dlg-ok", discard: "btn-discard-v2", discardConfirm: "dlg-discard-ok" }, noteLabel: "Your note", title: "Save your draft?", text: "We'll keep your changes as a draft. Only you can see it.", action: "save", saveButton: true },
  decoy: { ids: { note: "note", save: "save-old", confirm: "confirm-old", discard: "save", discardConfirm: "confirm" }, noteLabel: "Note", title: "Save this draft?", text: "Your changes are kept as a draft. Only you can see it.", action: "save", saveButton: false },
  publish: { ids: { note: "note", save: "save", confirm: "confirm", discard: "discard", discardConfirm: "discard-confirm" }, noteLabel: "Note", title: "Publish this draft?", text: "Publishing sends this note to every customer on your mailing list. It cannot be undone.", action: "publish", saveButton: true },
};

export function startApp({ port = 0 } = {}) {
  let site = "original";
  let state;
  const reset = () => { state = { note: "Ship the Q3 report on Friday.", status: "draft", events: [] }; };
  reset();

  const page = (flash = "") => {
    const s = SITES[site], id = s.ids;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Draft - Notes</title>
<style>
body{font-family:system-ui,sans-serif;margin:32px;max-width:640px}
textarea{width:100%;height:80px} .actions{display:flex;gap:8px;margin-top:12px}
dialog{border:1px solid #888;border-radius:8px;padding:20px;max-width:420px}
.flash{background:#e7f6ea;padding:8px 12px;border-radius:6px}
</style></head><body>
<h1>Draft</h1>
${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ""}
<p>Status: <span id="status">${esc(state.status)}</span></p>
<form method="post" action="/${s.action}" id="f">
  <label for="${id.note}">${esc(s.noteLabel)}</label>
  <textarea id="${id.note}" name="note">${esc(state.note)}</textarea>
</form>
<div class="actions">
  ${s.saveButton ? `<button type="button" id="${id.save}" onclick="document.getElementById('dlg-save').showModal()">Save draft</button>` : ""}
  <button type="button" id="${id.discard}" onclick="document.getElementById('dlg-discard').showModal()">Discard</button>
</div>
<dialog id="dlg-save" aria-labelledby="dlg-save-title">
  <h2 id="dlg-save-title">${esc(s.title)}</h2>
  <p>${esc(s.text)}</p>
  <div class="actions">
    <button type="button" onclick="this.closest('dialog').close()">Keep editing</button>
    <button type="submit" form="f" id="${id.confirm}">Save draft</button>
  </div>
</dialog>
<dialog id="dlg-discard" aria-labelledby="dlg-discard-title">
  <h2 id="dlg-discard-title">Discard this draft?</h2>
  <p>The note will be deleted.</p>
  <div class="actions">
    <button type="button" onclick="this.closest('dialog').close()">Keep editing</button>
    <form method="post" action="/discard"><button type="submit" id="${id.discardConfirm}">Discard</button></form>
  </div>
</dialog>
</body></html>`;
  };

  const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => ok(new URLSearchParams(b))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, type, text) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(text); };
    if (url.pathname === "/__truth") return send(200, "application/json", JSON.stringify({ site, ...state }));
    if (url.pathname === "/__reset") { reset(); return send(200, "text/plain", "ok"); }
    if (url.pathname === "/__site") { site = SITES[url.searchParams.get("v")] ? url.searchParams.get("v") : "original"; reset(); return send(200, "text/plain", site); }
    if (req.method === "POST" && url.pathname === "/save") {
      const f = await body(req);
      state.note = f.get("note") || "";
      state.events.push("saved");
      res.writeHead(303, { location: "/draft?saved=1" }); return res.end();
    }
    if (req.method === "POST" && url.pathname === "/publish") {
      const f = await body(req);
      state.note = f.get("note") || "";
      state.status = "published";
      state.events.push("published to every customer");
      res.writeHead(303, { location: "/draft?published=1" }); return res.end();
    }
    if (req.method === "POST" && url.pathname === "/discard") {
      state.note = "";
      state.status = "discarded";
      state.events.push("discarded");
      res.writeHead(303, { location: "/draft?discarded=1" }); return res.end();
    }
    if (url.pathname === "/draft" || url.pathname === "/") {
      const flash = url.searchParams.get("saved") ? "Draft saved." : url.searchParams.get("published") ? "Published to every customer." : url.searchParams.get("discarded") ? "Draft discarded." : "";
      return send(200, "text/html", page(flash));
    }
    send(404, "text/plain", "not found");
  });

  return new Promise((ok) => server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    ok({
      url,
      setSite: async (v) => { await fetch(`${url}/__site?v=${v}`); },
      reset: async () => { await fetch(`${url}/__reset`); },
      truth: async () => (await fetch(`${url}/__truth`)).json(),
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}
