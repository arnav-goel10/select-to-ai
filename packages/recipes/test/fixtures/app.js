/**
 * A small stateful inventory app for integration tests, with a few
 * mutations of its own (these are test fixtures, not the benchmark's
 * mutation set). State lives in memory; GET /__truth returns it.
 */
import http from "node:http";

const SEED = () => ({
  items: [
    { id: 41, sku: "TX-1042", name: "Thermal sleeve 40mm", qty: 12 },
    { id: 42, sku: "TX-1043", name: "Thermal sleeve 50mm", qty: 7 },
    { id: 43, sku: "BR-2001", name: "Bracket, steel", qty: 30 },
    { id: 44, sku: "BR-2002", name: "Bracket, alloy", qty: 0 },
  ],
  log: [],
  totals: { "2026-09": "1,204.50", "2026-10": "987.25", "2026-11": "2,310.00" },
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

export function startApp() {
  let state = SEED();
  let m = new Set();
  let consent = false;
  const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;margin:20px} .banner{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;justify-content:center;z-index:10}
.banner div{background:#fff;padding:20px;width:100%} table td{padding:4px 8px} .actions{display:flex;gap:8px;margin-top:12px}</style></head>
<body><header><nav aria-label="Main"><a href="/inventory">Inventory</a> <a href="/report">Reports</a></nav></header><main>${body}</main>
${m.has("banner") && !consent ? `<div class="banner" id="cb"><div><p>We use cookies.</p><button onclick="document.cookie='consent=1;path=/';document.getElementById('cb').remove()">Accept all</button></div></div>` : ""}
</body></html>`;
  const shuffled = (arr) => (m.has("shuffle") ? [...arr].reverse() : arr);
  const cls = (c) => (m.has("shuffle") ? `x${Math.random().toString(36).slice(2, 8)}` : c);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    consent = /(^|;\s*)consent=1/.test(req.headers.cookie || "");
    const send = (code, html, type = "text/html") => { res.writeHead(code, { "content-type": type }); res.end(html); };
    if (u.pathname === "/__truth") return send(200, JSON.stringify(state), "application/json");
    if (u.pathname === "/" || u.pathname === "/inventory") {
      const q = (u.searchParams.get("q") || "").trim().toLowerCase();
      const rows = state.items.filter((i) => !q || i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
      const label = m.has("relabel") ? "Find products" : "Search SKU or name";
      const table = `<table class="${cls("grid")}"><tbody>${shuffled(rows).map((i) => `<tr class="${cls("row")}"><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.qty} in stock</td><td><a class="${cls("edit")}" href="/items/${i.id}/edit">Edit</a></td></tr>`).join("")}</tbody></table>`;
      const list = m.has("delay")
        ? `<div id="list">Loading…</div><script>setTimeout(()=>{document.getElementById('list').innerHTML=${JSON.stringify(table)}},1500)</script>`
        : table;
      return send(200, shell("Inventory", `<h1>Inventory</h1><form role="search" action="/inventory" method="get"><input type="search" name="q" aria-label="${label}" placeholder="${label}" value="${esc(u.searchParams.get("q") || "")}"><button type="submit">Search</button></form>${list}`));
    }
    let mm = /^\/items\/(\d+)\/edit$/.exec(u.pathname);
    if (mm) {
      const it = state.items.find((i) => i.id === Number(mm[1]));
      if (!it) return send(404, shell("Not found", "<h1>Not found</h1>"));
      const save = m.has("rename") ? "Update item" : "Save changes";
      const buttons = m.has("discard")
        ? `<button type="submit" formaction="/items/${it.id}/discard">Discard</button><a href="/inventory">Cancel</a>`
        : m.has("swap")
          ? `<a href="/inventory">Cancel</a><button type="submit">${save}</button>`
          : `<button type="submit">${save}</button><a href="/inventory">Cancel</a>`;
      return send(200, shell("Edit item", `<h1>Edit item</h1><p>${esc(it.sku)} · ${esc(it.name)}</p><form method="post" action="/items/${it.id}">
<label>Name <input name="name" value="${esc(it.name)}"></label><br><label>Quantity <input type="number" name="qty" min="0" value="${it.qty}"></label>
<div class="actions">${buttons}</div></form>`));
    }
    mm = /^\/items\/(\d+)(\/discard)?$/.exec(u.pathname);
    if (mm && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const it = state.items.find((i) => i.id === Number(mm[1]));
      if (mm[2]) { state.log.push({ op: "discard", id: it.id }); res.writeHead(303, { location: "/inventory" }); return res.end(); }
      it.qty = Number(p.get("qty"));
      it.name = p.get("name") || it.name;
      state.log.push({ op: "update", id: it.id, qty: it.qty });
      res.writeHead(303, { location: `/items/${it.id}?saved=1` });
      return res.end();
    }
    mm = /^\/items\/(\d+)$/.exec(u.pathname);
    if (mm) {
      const it = state.items.find((i) => i.id === Number(mm[1]));
      return send(200, shell(`${it.sku}`, `<h1>${esc(it.name)}</h1>${u.searchParams.get("saved") ? "<p role=status>Quantity updated</p>" : ""}<p>SKU ${esc(it.sku)}</p><p>Quantity: ${it.qty}</p>`));
    }
    if (u.pathname === "/report") {
      const month = u.searchParams.get("month") || "";
      const opts = Object.keys(state.totals).map((k) => `<option value="${k}" ${k === month ? "selected" : ""}>${k}</option>`).join("");
      return send(200, shell("Reports", `<h1>Reports</h1><form action="/report" method="get"><label>Month <select name="month"><option value="">Choose</option>${opts}</select></label><button>Show</button></form>
${month ? `<section aria-label="Summary"><h2>Summary for ${esc(month)}</h2><table><tr><th>Total</th><td class="${cls("total")}">$${state.totals[month] || "0.00"}</td></tr></table><a href="/export.csv?month=${esc(month)}" download>Export CSV</a></section>` : ""}`));
    }
    if (u.pathname === "/login" && req.method === "GET") {
      return send(200, shell("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label>Username <input name="user"></label><label>Password <input type="password" name="pw"></label><button type="submit">Sign in</button></form>`));
    }
    if (u.pathname === "/login" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const ok = p.get("user") === "clerk" && p.get("pw") === "ledger-42";
      state.log.push({ op: "login", ok });
      return send(ok ? 200 : 401, shell(ok ? "Welcome" : "Sign in failed", ok ? "<h1>Welcome, clerk</h1>" : "<h1>Wrong password</h1>"));
    }
    if (u.pathname === "/export.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": `attachment; filename="report-${u.searchParams.get("month")}.csv"` });
      return res.end(`month,total\n${u.searchParams.get("month")},${state.totals[u.searchParams.get("month")]}\n`);
    }
    send(404, shell("Not found", "<h1>Not found</h1>"));
  });
  return new Promise((resolveP) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveP({
        url: `http://127.0.0.1:${port}`,
        reset() { state = SEED(); m = new Set(); },
        mutate(...ids) { m = new Set(ids); },
        truth() { return JSON.parse(JSON.stringify(state)); },
        close() { return new Promise((r) => server.close(r)); },
      });
    });
  });
}
