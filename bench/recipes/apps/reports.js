// Report export: date range and region filters, a revenue summary, CSV
// export, and scheduled exports.
import { h } from "../lib/h.js";
import { page, confirmDialog, int, money } from "../lib/ui.js";

export const REGIONS = ["North", "Northeast", "South", "East", "West"];

function seed(rng) {
  const sales = [];
  const start = Date.UTC(2026, 0, 1);
  for (let d = 0; d < 181; d++) {
    const date = new Date(start + d * 864e5).toISOString().slice(0, 10);
    for (const region of REGIONS) sales.push({ date, region, orders: int(rng, 3, 30), revenue: int(rng, 400, 9000) + int(rng, 0, 99) / 100 });
  }
  return { sales, schedules: [{ id: "s1", email: "finance@acme.test", region: "West", frequency: "Monthly" }], nextId: 2 };
}

// Region names as the page shows them. flags.regionMap {Original: [shown...]}:
// one name is a rename, several split the region (each split shows part of it).
const shownRegions = (flags) => REGIONS.flatMap((r) => flags.regionMap?.[r] || [r]);
function resolveRegion(flags, shown) {
  for (const [orig, names] of Object.entries(flags.regionMap || {})) {
    const i = names.indexOf(shown);
    if (i >= 0) return names.length === 1 ? { region: orig } : { region: orig, part: i, parts: names.length, label: shown };
  }
  return { region: shown };
}

export function summarize(state, region, from, to, part = null, parts = 1) {
  const rows = state.sales.filter((s, i) => s.region === region && s.date >= from && s.date <= to && (part == null || Number(s.date.slice(-2)) % parts === part));
  return { rows, revenue: Math.round(rows.reduce((a, r) => a + r.revenue, 0) * 100) / 100, orders: rows.reduce((a, r) => a + r.orders, 0) };
}

const shell = (ctx, title, body) => ({
  tree: page({ title: `${title} - Reports`, brand: "Sales Reports", nav: [[`${ctx.base}/`, "Revenue", "nav-revenue"], [`${ctx.base}/schedules`, "Scheduled exports", "nav-schedules"]], body }),
});

function revenue(ctx) {
  const { from = "", to = "", region = "" } = ctx.query;
  const ready = from && to && region;
  const rr = resolveRegion(ctx.flags, region);
  const sum = ready ? summarize(ctx.state, rr.region, from, to, rr.part, rr.parts) : null;
  const qs = `from=${from}&to=${to}&region=${encodeURIComponent(region)}`;
  return shell(ctx, "Revenue", [
    h("h1", { _k: "rev-title" }, "Revenue report"),
    h(
      "form",
      { method: "get", action: `${ctx.base}/`, class: "card filter-bar", _k: "filter-form" },
      h("div", { class: "field", _k: "from-field" }, h("label", { for: "from", _k: "from-label" }, "From"), h("input", { id: "from", name: "from", type: "date", value: from, _k: "from" })),
      h("div", { class: "field", _k: "to-field" }, h("label", { for: "to", _k: "to-label" }, "To"), h("input", { id: "to", name: "to", type: "date", value: to, _k: "to" })),
      h(
        "div",
        { class: "field", _k: "region-field" },
        h("label", { for: "region", _k: "region-label" }, "Region"),
        h("select", { id: "region", name: "region", _k: "region" }, h("option", { value: "" }, "Choose a region"), shownRegions(ctx.flags).map((r) => h("option", { value: r, selected: r === region }, r))),
      ),
      h("p", { _k: "filter-actions" }, h("button", { type: "submit", class: "btn primary", id: "apply", "data-testid": "apply", _k: "apply" }, "Apply")),
    ),
    sum &&
      h(
        "div",
        { class: "card summary", _k: "summary" },
        h("p", { _k: "total-row" }, h("span", { _k: "total-label" }, "Total revenue: "), h("strong", { id: "total", class: "total", "data-testid": "total", _k: "total" }, money(sum.revenue))),
        h("p", {}, "Orders: ", h("span", { id: "orders" }, String(sum.orders))),
        h(
          "p",
          { class: "row-actions", _k: "export-actions" },
          h("a", { href: `${ctx.base}/export/all.csv`, class: "btn", id: "export-all", _k: "export-all" }, "Export full history"),
          h("a", { href: `${ctx.base}/export/report.csv?${qs}`, class: "btn primary", id: "export-csv", "data-testid": "export-csv", _k: "export-csv" }, "Export CSV"),
        ),
      ),
  ]);
}

function schedules(ctx, flash) {
  return shell(ctx, "Scheduled exports", [
    h("h1", { _k: "sched-title" }, "Scheduled exports"),
    flash && h("p", { class: "flash", role: "status" }, flash),
    h(
      "table",
      { id: "schedules", _k: "sched-table" },
      h("thead", {}, h("tr", {}, ["Recipient", "Region", "Frequency", ""].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        ctx.state.schedules.map((s) =>
          h("tr", {}, h("td", {}, s.email), h("td", {}, s.region), h("td", {}, s.frequency), h("td", {}, h("form", { method: "post", action: `${ctx.base}/schedules/${s.id}/delete` }, h("button", { class: "btn danger" }, "Remove")))),
        ),
      ),
    ),
    h(
      "form",
      { id: "sched-form", method: "post", action: `${ctx.base}/schedules`, class: "card", _k: "sched-form" },
      h("h3", { _k: "new-sched-title" }, "New schedule"),
      h("label", { for: "sched-email", _k: "sched-email-label" }, "Send to"),
      h("input", { id: "sched-email", name: "email", type: "email", _k: "sched-email" }),
      h("label", { for: "sched-region", _k: "sched-region-label" }, "Region"),
      h("select", { id: "sched-region", name: "region", _k: "sched-region" }, shownRegions(ctx.flags).map((r) => h("option", { value: r }, r))),
      h("label", { for: "sched-frequency", _k: "sched-frequency-label" }, "Frequency"),
      h("select", { id: "sched-frequency", name: "frequency", _k: "sched-frequency" }, ["Daily", "Weekly", "Monthly"].map((f) => h("option", { value: f, selected: f === "Daily" }, f))),
      ctx.flags.schedFormat && [
        h("label", { for: "sched-format", _k: "sched-format-label" }, "File format"),
        h("select", { id: "sched-format", name: "format", required: true, _k: "sched-format" }, h("option", { value: "" }, "Choose..."), ["CSV", "XLSX"].map((f) => h("option", { value: f, selected: f === ctx.flags.schedFormat.default }, f))),
      ],
      h(
        "p",
        { class: "row-actions", _k: "sched-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/schedules/delete-all`, id: "delete-all", _k: "delete-all" }, "Remove all schedules"),
        h("button", { type: "submit", class: "btn primary", id: "create-schedule", "data-testid": "create-schedule", _k: "create-schedule" }, "Create schedule"),
      ),
    ),
  ]);
}

export default {
  name: "reports",
  title: "Report export",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    if (p === "/") {
      const rr = resolveRegion(ctx.flags, ctx.query.region || "");
      return { ...revenue(ctx), shows: [`${rr.label || rr.region}|${ctx.query.from}|${ctx.query.to}`] };
    }
    if (p === "/export/report.csv") {
      const { from = "", to = "" } = ctx.query;
      const rr = resolveRegion(ctx.flags, ctx.query.region || "");
      const region = rr.label || rr.region;
      const { rows } = summarize(ctx.state, rr.region, from, to, rr.part, rr.parts);
      const body = ["date,region,orders,revenue", ...rows.map((r) => `${r.date},${r.region},${r.orders},${r.revenue.toFixed(2)}`)].join("\n");
      return { file: { name: `revenue-${region}-${from}-${to}.csv`, type: "text/csv", body, entity: "export", id: "report", meta: { from, to, region, rows: rows.length } } };
    }
    if (p === "/export/all.csv") {
      const body = ["date,region,orders,revenue", ...ctx.state.sales.map((r) => `${r.date},${r.region},${r.orders},${r.revenue.toFixed(2)}`)].join("\n");
      return { file: { name: "revenue-all.csv", type: "text/csv", body, entity: "export", id: "all", meta: { rows: ctx.state.sales.length } } };
    }
    if (p === "/schedules" && ctx.method === "POST") {
      const { email = "", frequency = "", format } = ctx.form;
      const rr = resolveRegion(ctx.flags, ctx.form.region || "");
      const region = rr.label || rr.region;
      if (!email || (ctx.flags.schedFormat && !format)) {
        ctx.log("fail", { what: "schedule-invalid" });
        return schedules(ctx, null);
      }
      const s = { id: `s${ctx.state.nextId++}`, email, region, frequency, ...(format ? { format } : {}) };
      ctx.state.schedules.push(s);
      ctx.change("schedule", s.id, "created", null, { email, region, frequency, ...(format ? { format } : {}) }, { op: "create" });
      return { redirect: `${ctx.base}/schedules?done=1` };
    }
    if (p === "/schedules/delete-all" && ctx.method === "POST") {
      for (const s of ctx.state.schedules) ctx.change("schedule", s.id, "deleted", false, true, { op: "delete" });
      ctx.state.schedules = [];
      return { redirect: `${ctx.base}/schedules` };
    }
    const m = p.match(/^\/schedules\/(s\d+)\/delete$/);
    if (m && ctx.method === "POST") {
      ctx.change("schedule", m[1], "deleted", false, true, { op: "delete" });
      ctx.state.schedules = ctx.state.schedules.filter((s) => s.id !== m[1]);
      return { redirect: `${ctx.base}/schedules` };
    }
    if (p === "/schedules") return schedules(ctx, ctx.query.done ? "Schedule created." : null);
    return null;
  },
};
