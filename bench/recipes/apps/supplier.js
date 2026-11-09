// Supplier portal: sign in, find an invoice by client and month, view,
// download its PDF, approve or dispute it.
import { h } from "../lib/h.js";
import { page, confirmDialog, int, money } from "../lib/ui.js";

export const USER = { username: "ap.clerk", password: "ledger-42" };
export const CLIENTS = ["Northwind Traders", "Northwind Trading Co", "Contoso Ltd", "Contoso Logistics", "Fabrikam Inc"];
export const MONTHS = ["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"];
const code = (c) => c.replace(/[^A-Z]/g, "").slice(0, 3) + c.length;

export function findInvoice(state, client, month) {
  return state.invoices.find((i) => i.client === client && i.month === month);
}

function seed(rng) {
  const invoices = [];
  for (const [mi, month] of MONTHS.entries()) {
    for (const client of CLIENTS) {
      invoices.push({ id: `INV-${code(client)}-${2601 + mi}`, client, month, amount: int(rng, 1200, 48000) + int(rng, 0, 99) / 100, status: "Open", reason: "" });
    }
  }
  invoices.reverse();
  return { invoices };
}

const nav = (base) => [[`${base}/invoices`, "Invoices", "nav-invoices"], [`${base}/payments`, "Payments", "nav-payments"]];

function shell(ctx, title, body) {
  return { tree: page({ title: `${title} - Supplier Portal`, brand: "Supplier Portal", nav: ctx.auth.supplier ? nav(ctx.base) : [], body }) };
}

function loginPage(ctx, error) {
  return shell(ctx, "Sign in", [
    h("h1", { _k: "login-title" }, "Sign in"),
    error && h("p", { class: "error" }, error),
    h(
      "form",
      { method: "post", action: `${ctx.base}/login`, class: "card login-form", _k: "login-form" },
      h("label", { for: "username", _k: "username-label" }, "Username"),
      h("input", { id: "username", name: "username", autocomplete: "username", _k: "username" }),
      h("label", { for: "password", _k: "password-label" }, "Password"),
      h("input", { id: "password", name: "password", type: "password", _k: "password" }),
      h("p", {}, h("button", { id: "signin", type: "submit", class: "btn primary", "data-testid": "signin", _k: "signin" }, "Sign in"), " ", h("a", { href: `${ctx.base}/forgot`, _k: "forgot" }, "Forgot password?")),
    ),
  ]);
}

function list(ctx) {
  const { client = "", month = "" } = ctx.query;
  const rows = ctx.state.invoices.filter((i) => (!client || i.client === client) && (!month || i.month === month));
  const opt = (v, sel) => h("option", { value: v, selected: v === sel }, v || "All");
  return shell(ctx, "Invoices", [
    h("h1", { _k: "invoices-title" }, "Invoices"),
    h(
      "form",
      { method: "get", action: `${ctx.base}/invoices`, class: "card filters", _k: "filters" },
      h("label", { for: "client", _k: "client-label" }, "Client"),
      h("select", { id: "client", name: "client", _k: "client-select" }, opt("", client), CLIENTS.map((c) => opt(c, client))),
      h("label", { for: "month", _k: "month-label" }, "Billing month"),
      h("select", { id: "month", name: "month", _k: "month-select" }, opt("", month), MONTHS.map((m) => opt(m, month))),
      h("p", {}, h("button", { id: "filter-btn", type: "submit", class: "btn", _k: "filter-btn" }, "Apply filters")),
    ),
    h(
      "table",
      { id: "invoices", class: "inv-table", _k: "invoice-table" },
      h("thead", {}, h("tr", {}, ["Invoice", "Client", "Month", "Amount", "Status", "Actions"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        rows.map((i) =>
          h(
            "tr",
            { class: "inv-row" },
            h("td", {}, i.id),
            h("td", {}, i.client),
            h("td", {}, i.month),
            h("td", { class: "amount" }, money(i.amount)),
            h("td", {}, i.status),
            h(
              "td",
              { class: "row-actions", _k: "row-actions" },
              h("a", { href: `${ctx.base}/invoices/${i.id}`, class: "btn view-link", "data-testid": "view", _k: "row-view" }, "View"),
              h("a", { href: `${ctx.base}/invoices/${i.id}/pdf`, class: "btn dl-link", "data-testid": "download", _k: "row-download" }, "Download PDF"),
            ),
          ),
        ),
      ),
    ),
  ]);
}

function detail(ctx, inv, flash) {
  return shell(ctx, inv.id, [
    h("p", {}, h("a", { href: `${ctx.base}/invoices`, _k: "back" }, "Back to invoices")),
    flash && h("p", { class: "flash", role: "status" }, flash),
    h("h1", { _k: "detail-title" }, `Invoice ${inv.id}`),
    h(
      "div",
      { class: "card", _k: "detail-card" },
      h("p", {}, "Client: ", h("strong", { id: "client-name" }, inv.client)),
      h("p", {}, "Month: ", h("span", { id: "billing-month" }, inv.month)),
      h("p", { _k: "amount-row" }, h("span", { _k: "amount-label" }, "Amount due: "), h("strong", { id: "amount", class: "amount-due", "data-testid": "amount", _k: "amount" }, money(inv.amount))),
      h("p", {}, "Status: ", h("span", { id: "status" }, inv.status)),
    ),
    h(
      "div",
      { class: "row-actions detail-actions", _k: "detail-actions" },
      h("a", { href: `${ctx.base}/invoices/${inv.id}/pdf`, class: "btn", id: "download-pdf", "data-testid": "download", _k: "detail-download" }, "Download PDF"),
      h("form", { method: "post", action: `${ctx.base}/invoices/${inv.id}/approve`, _k: "approve-form" }, h("button", { class: "btn primary", id: "approve", "data-testid": "approve", _k: "approve" }, "Approve for payment")),
      h("button", { type: "button", class: "btn danger", id: "open-dispute", "data-open": "dispute", "data-testid": "dispute", _k: "dispute-open" }, "Dispute"),
    ),
    h(
      "form",
      { id: "dispute-form", method: "post", action: `${ctx.base}/invoices/${inv.id}/dispute`, _k: "dispute-form" },
      h(
        "div",
        { "data-overlay": "", "data-dialog": "dispute", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Dispute invoice", _k: "dispute-dialog" },
        h(
          "div",
          { class: "dlg" },
          h("h3", {}, "Dispute invoice"),
          h("label", { for: "reason", _k: "reason-label" }, "Reason"),
          h("textarea", { id: "reason", name: "reason", rows: 3, _k: "reason" }),
          ctx.flags.disputeCategory && [
            h("label", { for: "category", _k: "category-label" }, "Category"),
            h("select", { id: "category", name: "category", required: true, _k: "category" }, h("option", { value: "" }, "Choose..."), ...["Pricing", "Quantity", "Duplicate"].map((c) => h("option", { value: c, selected: c === ctx.flags.disputeCategory.default }, c))),
          ],
          h(
            "div",
            { class: "actions", _k: "dispute-actions" },
            h("button", { type: "button", "data-dismiss": "", class: "btn", id: "dispute-cancel", _k: "dispute-cancel" }, "Cancel"),
            h("button", { type: "submit", class: "btn primary", id: "dispute-submit", "data-testid": "dispute-submit", _k: "dispute-submit" }, "Submit dispute"),
          ),
        ),
      ),
    ),
  ]);
}

function pdf(inv) {
  const text = `%PDF-1.4\n% Invoice ${inv.id}\n% Client ${inv.client}\n% Month ${inv.month}\n% Amount ${money(inv.amount)}\n%%EOF\n`;
  return { file: { name: `${inv.id}.pdf`, type: "application/pdf", body: text, entity: "invoice", id: inv.id } };
}

export default {
  name: "supplier",
  title: "Supplier portal",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    if (ctx.flags.reissue && !ctx.state.reissued) {
      // Every invoice now has a corrected re-issue for the same client and month.
      ctx.state.reissued = true;
      ctx.state.invoices = ctx.state.invoices.flatMap((i) => [{ ...i, id: `${i.id}-R`, amount: Math.round(i.amount * 0.93 * 100) / 100 }, i]);
    }
    if (p === "/login" && ctx.method === "POST") {
      if (ctx.form.username === USER.username && ctx.form.password === USER.password) {
        ctx.auth.supplier = true;
        ctx.log("auth", { user: USER.username });
        return { redirect: `${ctx.base}/invoices` };
      }
      ctx.log("fail", { what: "login" });
      return loginPage(ctx, "Incorrect username or password.");
    }
    if (p === "/login" || p === "/forgot") return loginPage(ctx);
    if (!ctx.auth.supplier) return { redirect: `${ctx.base}/login` };
    if (p === "/" || p === "/payments") return { redirect: `${ctx.base}/invoices` };
    if (p === "/invoices") return list(ctx);
    const m = p.match(/^\/invoices\/([\w-]+)(?:\/(pdf|approve|dispute))?$/);
    const inv = m && ctx.state.invoices.find((i) => i.id === m[1]);
    if (!inv) return { status: 404, text: "No such invoice" };
    if (!m[2]) return { ...detail(ctx, inv, ctx.query.done === "1" ? "Your change was saved." : null), shows: [inv.id] };
    if (m[2] === "pdf") return pdf(inv);
    if (ctx.method !== "POST") return { redirect: `${ctx.base}/invoices/${inv.id}` };
    if (m[2] === "approve") {
      ctx.change("invoice", inv.id, "status", inv.status, "Approved");
      inv.status = "Approved";
    } else {
      if (ctx.flags.disputeCategory && !ctx.form.category) {
        ctx.log("fail", { what: "dispute-missing-category" });
        return detail(ctx, inv, null);
      }
      ctx.change("invoice", inv.id, "status", inv.status, "Disputed", { reason: ctx.form.reason || "", category: ctx.form.category || null });
      inv.status = "Disputed";
      inv.reason = ctx.form.reason || "";
    }
    return { redirect: `${ctx.base}/invoices/${inv.id}?done=1` };
  },
};
