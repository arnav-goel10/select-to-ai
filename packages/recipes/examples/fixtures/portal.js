/**
 * A small local "supplier portal" for the examples: a login, an expense
 * claim form, and a paginated invoice list. State lives in memory.
 *
 *   GET  /login                sign-in form (ada@example.com / correct horse)
 *   GET  /expenses/new         the claim form (needs a session)
 *   GET  /invoices?page=N      23 invoices, 8 per page, with a Next link
 *   GET  /__truth              the server's own record: claims and events
 *   GET  /__site?v=NAME        switch the site version (resets state)
 *
 * Site versions:
 *   original   as recorded
 *   cosmetic   ids renamed, labels reworded, the pager says "Next page"
 *   instant    the claim form now pays out on submit ("Submit and pay")
 *   thousands  the invoice amounts are now shown in thousands
 */
import http from "node:http";

const USER = { email: "ada@example.com", password: "correct horse" };

const SITES = {
  original: { ids: { email: "email", password: "password", login: "login", amount: "amount", category: "category", desc: "desc", submit: "submit" }, emailLabel: "Email", amountLabel: "Amount (USD)", submit: "Submit claim", note: "Claims are reviewed by finance within 5 working days.", action: "/expenses", next: "Next", amountHead: "Amount (USD)", scale: 1 },
  cosmetic: { ids: { email: "user-email-v2", password: "user-pass-v2", login: "btn-login", amount: "claim-amount", category: "claim-cat", desc: "claim-desc", submit: "btn-submit-claim" }, emailLabel: "Email address", amountLabel: "Amount in USD", submit: "Submit claim", note: "Finance reviews every claim within 5 working days.", action: "/expenses", next: "Next page", amountHead: "Amount (USD)", scale: 1 },
  instant: { ids: { email: "email", password: "password", login: "login", amount: "amount", category: "category", desc: "desc", submit: "submit" }, emailLabel: "Email", amountLabel: "Amount (USD)", submit: "Submit and pay", note: "Submitting pays the amount out today from the company account. It cannot be withdrawn.", action: "/expenses/pay", next: "Next", amountHead: "Amount (USD)", scale: 1 },
  thousands: { ids: { email: "email", password: "password", login: "login", amount: "amount", category: "category", desc: "desc", submit: "submit" }, emailLabel: "Email", amountLabel: "Amount (USD)", submit: "Submit claim", note: "Claims are reviewed by finance within 5 working days.", action: "/expenses", next: "Next", amountHead: "Amount (USD thousands)", scale: 1000 },
};

const CUSTOMERS = ["Northwind", "Contoso", "Fabrikam", "Initech", "Globex", "Umbrella", "Hooli", "Vandelay"];
const INVOICES = Array.from({ length: 23 }, (_, i) => ({
  id: `INV-${1001 + i}`,
  customer: CUSTOMERS[(i * 3) % CUSTOMERS.length],
  due: `2026-${String(9 + Math.floor(i / 10)).padStart(2, "0")}-${String(1 + ((i * 5) % 28)).padStart(2, "0")}`,
  amount: 400 + ((i * 1237) % 9000) + 0.5 * (i % 2),
  status: ["Paid", "Open", "Overdue"][i % 3],
}));
const PER_PAGE = 8;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n, scale) => (n / scale).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function startPortal({ port = 0 } = {}) {
  let site = "original";
  let state;
  const sessions = new Set();
  const reset = () => { state = { claims: [], events: [] }; sessions.clear(); };
  reset();

  const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Supplier portal</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;max-width:720px} label{display:block;margin-top:12px}
input,select,textarea{display:block;margin-top:4px;padding:6px;width:320px} button{margin-top:16px;padding:8px 14px}
table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #ddd}
.flash{background:#e7f6ea;padding:8px 12px;border-radius:6px} .error{background:#fde8e8;padding:8px 12px;border-radius:6px}
nav.pager{display:flex;gap:12px;margin-top:12px} .note{color:#555}</style></head>
<body><header><nav aria-label="Main"><a href="/expenses/new">Expenses</a> · <a href="/invoices">Invoices</a></nav></header><main>${body}</main></body></html>`;

  const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => ok(new URLSearchParams(b))); });
  const sid = (req) => (/(?:^|;\s*)sid=([a-z0-9]+)/.exec(req.headers.cookie || "") || [])[1];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const s = SITES[site], id = s.ids;
    const send = (code, html, type = "text/html") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(html); };
    const redirect = (to, extra = {}) => { res.writeHead(303, { location: to, ...extra }); res.end(); };

    if (url.pathname === "/__truth") return send(200, JSON.stringify({ site, ...state }), "application/json");
    if (url.pathname === "/__site") { site = SITES[url.searchParams.get("v")] ? url.searchParams.get("v") : "original"; reset(); return send(200, site, "text/plain"); }

    if (url.pathname === "/" || url.pathname === "/login") {
      if (req.method === "POST") {
        const f = await body(req);
        if (f.get("email") === USER.email && f.get("password") === USER.password) {
          const token = Math.random().toString(36).slice(2);
          sessions.add(token);
          state.events.push("signed in");
          return redirect("/expenses/new", { "set-cookie": `sid=${token}; Path=/; HttpOnly` });
        }
        state.events.push("sign-in failed");
        return send(401, loginPage("That email and password do not match."));
      }
      return send(200, loginPage());
    }

    if (url.pathname.startsWith("/expenses")) {
      if (!sessions.has(sid(req))) return redirect("/login");
      if (req.method === "POST" && (url.pathname === "/expenses" || url.pathname === "/expenses/pay")) {
        const f = await body(req);
        const claim = { ref: `CL-${2001 + state.claims.length}`, amount: f.get("amount"), category: f.get("category"), description: f.get("description"), paidOut: url.pathname === "/expenses/pay" };
        state.claims.push(claim);
        state.events.push(claim.paidOut ? `claim ${claim.ref} paid out` : `claim ${claim.ref} submitted`);
        return redirect(`/expenses?done=${claim.ref}`);
      }
      if (url.pathname === "/expenses") {
        const ref = url.searchParams.get("done") || "";
        const c = state.claims.find((x) => x.ref === ref);
        return send(200, shell("Expenses", `<h1>Expenses</h1>${c ? `<p class="flash" role="status">Claim ${esc(c.ref)} ${c.paidOut ? "paid out" : "submitted"}: ${esc(c.amount)} USD for ${esc(c.category)}.</p>` : ""}<p><a href="/expenses/new">New claim</a></p>`));
      }
      return send(200, shell("New expense claim", `<h1>New expense claim</h1>
<form method="post" action="${s.action}">
  <label for="${id.amount}">${esc(s.amountLabel)}</label><input id="${id.amount}" name="amount" inputmode="decimal" required>
  <label for="${id.category}">Category</label><select id="${id.category}" name="category"><option>Travel</option><option>Meals</option><option>Office supplies</option></select>
  <label for="${id.desc}">Description</label><textarea id="${id.desc}" name="description" rows="3"></textarea>
  <p class="note">${esc(s.note)}</p>
  <button type="submit" id="${id.submit}">${esc(s.submit)}</button>
</form>`));
    }

    if (url.pathname === "/invoices") {
      const pages = Math.ceil(INVOICES.length / PER_PAGE);
      const n = Math.min(pages, Math.max(1, Number(url.searchParams.get("page")) || 1));
      const rows = INVOICES.slice((n - 1) * PER_PAGE, n * PER_PAGE);
      return send(200, shell("Invoices", `<h1>Invoices</h1><p>Page ${n} of ${pages}</p>
<table><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>${esc(s.amountHead)}</th><th>Status</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.customer)}</td><td>${r.due}</td><td>${money(r.amount, s.scale)}</td><td>${r.status}</td></tr>`).join("")}</tbody></table>
<nav class="pager" aria-label="Pages">${n > 1 ? `<a href="/invoices?page=${n - 1}" rel="prev">Previous</a>` : ""}${n < pages ? `<a href="/invoices?page=${n + 1}" rel="next">${esc(s.next)}</a>` : ""}</nav>`));
    }
    send(404, "not found", "text/plain");

    function loginPage(error = "") {
      return shell("Sign in", `<h1>Sign in</h1>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/login">
  <label for="${id.email}">${esc(s.emailLabel)}</label><input id="${id.email}" name="email" type="email" autocomplete="username">
  <label for="${id.password}">Password</label><input id="${id.password}" name="password" type="password" autocomplete="current-password">
  <button type="submit" id="${id.login}">Sign in</button>
</form>`);
    }
  });

  return new Promise((ok) => server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    ok({
      url,
      user: USER,
      invoices: INVOICES.map((r) => ({ ...r, shown: money(r.amount, 1) })),
      setSite: async (v) => { await fetch(`${url}/__site?v=${v}`); },
      truth: async () => (await fetch(`${url}/__truth`)).json(),
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    });
  }));
}

// Run it on its own: node examples/fixtures/portal.js [port]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app = await startPortal({ port: Number(process.argv[2]) || 4317 });
  console.log(`supplier portal on ${app.url} (Ctrl-C to stop)`);
}
