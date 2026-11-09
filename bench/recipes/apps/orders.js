// Order status lookup: order number + postcode, then status, tracking and
// delivery instructions.
import { h } from "../lib/h.js";
import { page, int, pick } from "../lib/ui.js";

const NUMBERS = ["SO-48213", "SO-48231", "SO-50117", "SO-50171", "SO-61904", "SO-61940", "SO-72215", "SO-72251", "SO-83302", "SO-83320"];
const POSTCODES = ["SW1A 2AA", "SW1A 2AB", "M1 4BT", "M1 4BU", "EH1 1YZ", "EH1 1ZY", "B33 8TH", "B33 8HT", "LS1 5DL", "LS1 5LD"];
export const STATUSES = ["Processing", "Packed", "Shipped", "Out for delivery", "Delivered", "Delayed"];

export const findOrder = (state, number) => state.orders.find((o) => o.number === number);

function seed(rng) {
  return {
    orders: NUMBERS.map((number, i) => ({
      id: `o${i + 1}`,
      number,
      postcode: POSTCODES[i],
      status: pick(rng, STATUSES),
      tracking: `1Z${int(rng, 100000, 999999)}${int(rng, 1000, 9999)}`,
      carrier: pick(rng, ["DPD", "Royal Mail", "Evri"]),
      instructions: "",
    })),
  };
}

const shell = (ctx, title, body) => ({ tree: page({ title: `${title} - Order tracking`, brand: "Track your order", nav: [[`${ctx.base}/`, "Track", "nav-track"], [`${ctx.base}/help`, "Help", "nav-help"]], body }) });

function lookup(ctx, error) {
  return shell(ctx, "Track", [
    h("h1", { _k: "track-title" }, "Track your order"),
    error && h("p", { class: "error", role: "alert" }, error),
    h(
      "form",
      { method: "post", action: `${ctx.base}/lookup`, class: "card lookup", _k: "lookup-form" },
      h("label", { for: "order-no", _k: "order-label" }, "Order number"),
      h("input", { id: "order-no", name: "order", placeholder: "SO-12345", _k: "order-input" }),
      h("label", { for: "postcode", _k: "postcode-label" }, "Delivery postcode"),
      h("input", { id: "postcode", name: "postcode", _k: "postcode-input" }),
      h("p", { _k: "lookup-actions" }, h("button", { type: "submit", class: "btn primary", id: "track", "data-testid": "track", _k: "track-btn" }, "Track order")),
    ),
  ]);
}

function status(ctx, o, flash) {
  return shell(ctx, o.number, [
    flash && h("p", { class: "flash", role: "status" }, flash),
    h("h1", { _k: "order-title" }, `Order ${o.number}`),
    h(
      "dl",
      { class: "card order-facts", _k: "facts" },
      h("dt", { _k: "status-label" }, "Status"),
      h("dd", { id: "status", class: "order-status", "data-testid": "status", _k: "status" }, o.status),
      h("dt", { _k: "carrier-label" }, "Carrier"),
      h("dd", { id: "carrier" }, o.carrier),
      h("dt", { _k: "tracking-label" }, "Tracking number"),
      h("dd", { id: "tracking", class: "tracking-no", "data-testid": "tracking", _k: "tracking" }, o.tracking),
    ),
    h(
      "form",
      { id: "instr-form", method: "post", action: `${ctx.base}/o/${o.id}/instructions`, class: "card", _k: "instr-form" },
      h("label", { for: "instructions", _k: "instr-label" }, "Delivery instructions"),
      h("textarea", { id: "instructions", name: "instructions", rows: 3, _k: "instructions" }, o.instructions),
      ctx.flags.safePlace && [
        h("label", { for: "safe-place", _k: "safe-place-label" }, "Safe place"),
        h("select", { id: "safe-place", name: "safe_place", required: true, _k: "safe-place" }, h("option", { value: "" }, "Choose..."), ["Front door", "Neighbour", "No safe place"].map((s) => h("option", { value: s, selected: s === ctx.flags.safePlace.default }, s))),
      ],
      h(
        "p",
        { class: "row-actions", _k: "instr-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/o/${o.id}/cancel`, id: "cancel-order", _k: "cancel-order" }, "Cancel order"),
        h("button", { type: "submit", class: "btn primary", id: "save-instructions", "data-testid": "save-instructions", _k: "save-instructions" }, "Save instructions"),
      ),
    ),
  ]);
}

export default {
  name: "orders",
  title: "Order status lookup",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    if (p === "/" || p === "/help") return lookup(ctx);
    if (p === "/lookup" && ctx.method === "POST") {
      const o = ctx.state.orders.find((x) => x.number === (ctx.form.order || "").trim().toUpperCase() && x.postcode === (ctx.form.postcode || "").trim().toUpperCase());
      if (!o) {
        ctx.log("fail", { what: "lookup" });
        return lookup(ctx, "We couldn't find an order with those details.");
      }
      ctx.auth[`order:${o.id}`] = true;
      return { redirect: `${ctx.base}/o/${o.id}` };
    }
    const m = p.match(/^\/o\/(o\d+)(?:\/(instructions|cancel))?$/);
    const o = m && ctx.state.orders.find((x) => x.id === m[1]);
    if (!o || !ctx.auth[`order:${o.id}`]) return { redirect: `${ctx.base}/` };
    if (!m[2]) return { ...status(ctx, o, ctx.query.done ? "Saved." : null), shows: [o.number] };
    if (ctx.method !== "POST") return { redirect: `${ctx.base}/o/${o.id}` };
    if (m[2] === "cancel") {
      ctx.change("order", o.number, "status", o.status, "Cancelled");
      o.status = "Cancelled";
    } else {
      if (ctx.flags.safePlace && !ctx.form.safe_place) {
        ctx.log("fail", { what: "instructions-missing-safe-place" });
        return status(ctx, o, null);
      }
      const next = ctx.form.instructions || "";
      if (next !== o.instructions) ctx.change("order", o.number, "instructions", o.instructions, next, { safePlace: ctx.form.safe_place || null });
      o.instructions = next;
    }
    return { redirect: `${ctx.base}/o/${o.id}?done=1` };
  },
};
