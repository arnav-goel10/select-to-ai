// Inventory table: paginated, with row actions (edit, archive, delete).
import { h } from "../lib/h.js";
import { page, int } from "../lib/ui.js";

const NAMES = ["Hex bolt M6", "Hex bolt M8", "Washer 6mm", "Washer 8mm", "Hinge 75mm", "Hinge 100mm", "Cable tie 200", "Cable tie 300", "Drill bit 5mm", "Drill bit 6mm", "Wall plug 6mm", "Wall plug 8mm", "Wood screw 4x40", "Wood screw 4x50", "Bracket L50", "Bracket L75"];

function seed(rng) {
  const items = [];
  const base = [1018, 1024, 1042, 1103, 1130, 1207, 1270, 1311, 1356, 1365, 1402, 1420, 1517, 1571, 1608, 1680, 1733, 1737, 1801, 1810, 1866, 1902, 1920, 1955];
  for (const [i, n] of base.entries()) {
    items.push({ sku: `SKU-${n}`, name: NAMES[i % NAMES.length], stock: int(rng, 0, 400), reorder: int(rng, 12, 480), status: "Active" });
    if (i % 3 === 2) items.push({ sku: `SKU-${n}-B`, name: `${NAMES[i % NAMES.length]} (bulk)`, stock: int(rng, 0, 400), reorder: int(rng, 12, 480), status: "Active" });
  }
  return { items };
}

export const findItem = (state, sku) => state.items.find((i) => i.sku === sku);

const shell = (ctx, title, body) => ({ tree: page({ title: `${title} - Inventory`, brand: "Stockroom", nav: [[`${ctx.base}/items`, "Items", "nav-items"], [`${ctx.base}/archived`, "Archived", "nav-archived"]], body }) });

function list(ctx, flash) {
  const size = ctx.flags.pageSize || 8;
  const active = ctx.state.items.filter((i) => i.status === "Active");
  const pages = Math.max(1, Math.ceil(active.length / size));
  const n = Math.min(pages, Math.max(1, Number(ctx.query.page) || 1));
  const rows = active.slice((n - 1) * size, n * size);
  const cols = [
    ["SKU", (i) => i.sku],
    ["Name", (i) => i.name],
    ["In stock", (i) => String(i.stock)],
    ["Reorder level", (i) => String(i.reorder)],
  ];
  return { ...shell(ctx, "Items", [
    h("h1", { _k: "items-title" }, "Items"),
    flash && h("p", { class: "flash", role: "status" }, flash),
    h(
      "table",
      { id: "items", class: "items-table", _k: "items-table" },
      h("thead", {}, h("tr", {}, ...cols.map(([t]) => h("th", {}, t)), h("th", {}, "Actions"))),
      h(
        "tbody",
        {},
        rows.map((i) =>
          h(
            "tr",
            { class: "item-row" },
            ...cols.map(([, f]) => h("td", {}, f(i))),
            h(
              "td",
              { class: "row-actions", _k: "row-actions" },
              h("a", { href: `${ctx.base}/items/${i.sku}/edit`, class: "btn edit", "data-testid": "edit", _k: "row-edit" }, "Edit"),
              h("button", { type: "button", class: "btn", "data-open": `archive-${i.sku}`, "data-testid": "archive", _k: "row-archive" }, "Archive"),
              h("form", { method: "post", action: `${ctx.base}/items/${i.sku}/delete`, _k: "row-delete-form" }, h("button", { class: "btn danger", "data-testid": "delete", _k: "row-delete" }, "Delete")),
              h("form", { id: `archive-form-${i.sku}`, method: "post", action: `${ctx.base}/items/${i.sku}/archive` }),
              h(
                "div",
                { "data-overlay": "", "data-dialog": `archive-${i.sku}`, hidden: true, role: "dialog", "aria-label": `Archive ${i.sku}`, _k: "archive-dialog" },
                h(
                  "div",
                  { class: "dlg" },
                  h("p", {}, `Archive ${i.sku}? It will be hidden from the list.`),
                  h(
                    "div",
                    { class: "actions", _k: "archive-actions" },
                    h("button", { type: "button", class: "btn", "data-dismiss": "", _k: "archive-cancel" }, "Cancel"),
                    h("button", { type: "submit", class: "btn primary", form: `archive-form-${i.sku}`, "data-testid": "archive-confirm", _k: "archive-confirm" }, "Archive"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      "nav",
      { class: "pager", "aria-label": "Pagination", _k: "pager" },
      n > 1 && h("a", { href: `${ctx.base}/items?page=${n - 1}`, class: "btn", id: "prev-page", rel: "prev", _k: "prev-page" }, "Previous"),
      h("span", { class: "muted", _k: "page-info" }, `Page ${n} of ${pages}`),
      n < pages && h("a", { href: `${ctx.base}/items?page=${n + 1}`, class: "btn", id: "next-page", rel: "next", _k: "next-page" }, "Next"),
    ),
  ]), shows: rows.map((i) => i.sku) };
}

function edit(ctx, it) {
  return shell(ctx, it.sku, [
    h("h1", { _k: "edit-title" }, `Edit ${it.sku}`),
    h("p", { class: "muted" }, it.name),
    h(
      "form",
      { id: "edit-form", method: "post", action: `${ctx.base}/items/${it.sku}/edit`, class: "card", _k: "edit-form" },
      h("label", { for: "stock", _k: "stock-label" }, "Units in stock"),
      h("input", { id: "stock", name: "stock", type: "number", value: String(it.stock), _k: "stock" }),
      h("label", { for: "reorder", _k: "reorder-label" }, "Reorder level"),
      h("input", { id: "reorder", name: "reorder", type: "number", value: String(it.reorder), _k: "reorder" }),
      ctx.flags.stockReason && [h("label", { for: "reason", _k: "reason-label" }, "Reason for change"), h("select", { id: "reason", name: "reason", required: true, _k: "reason" }, h("option", { value: "" }, "Choose..."), ["Stock count", "Damaged", "Returned"].map((r) => h("option", { value: r, selected: r === ctx.flags.stockReason.default }, r)))],
      h(
        "p",
        { class: "row-actions", _k: "edit-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/items/${it.sku}/delete`, id: "delete-item", _k: "delete-item" }, "Delete item"),
        h("button", { type: "submit", class: "btn primary", id: "save-item", "data-testid": "save", _k: "save-item" }, "Save"),
      ),
    ),
  ]);
}

export default {
  name: "inventory",
  title: "Inventory table",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    if (p === "/" || p === "/archived") return { redirect: `${ctx.base}/items` };
    if (p === "/items") return list(ctx, ctx.query.done ? "Saved." : null);
    const m = p.match(/^\/items\/(SKU-[\w-]+?)\/(edit|archive|delete)$/);
    const it = m && ctx.state.items.find((i) => i.sku === m[1]);
    if (!it) return { status: 404, text: "No such item" };
    if (m[2] === "edit" && ctx.method !== "POST") return edit(ctx, it);
    if (ctx.method !== "POST") return { redirect: `${ctx.base}/items` };
    if (m[2] === "edit") {
      if (ctx.flags.stockReason && !ctx.form.reason) {
        ctx.log("fail", { what: "edit-missing-reason" });
        return edit(ctx, it);
      }
      for (const f of ["stock", "reorder"]) {
        const v = Number(ctx.form[f]);
        if (ctx.form[f] != null && v !== it[f]) {
          ctx.change("item", it.sku, f, it[f], v, { reason: ctx.form.reason || null });
          it[f] = v;
        }
      }
    } else if (m[2] === "archive") {
      ctx.change("item", it.sku, "status", it.status, "Archived");
      it.status = "Archived";
    } else {
      ctx.change("item", it.sku, "deleted", false, true);
      ctx.state.items = ctx.state.items.filter((i) => i !== it);
    }
    return { redirect: `${ctx.base}/items?done=1` };
  },
};
