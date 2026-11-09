/**
 * Test helpers: snapshot elements and a fake in-memory driver, so the pure
 * core can be tested without a browser.
 */

let n = 0;
/** A snapshot element with sensible defaults. */
export function el(o) {
  n++;
  return {
    ref: o.ref || `f0e${n}`, tag: "button", kind: "button", name: "", label: "", text: "", placeholder: "", title: "",
    nameAttr: "", htmlId: "", testId: "", autocomplete: "", inputType: "", href: "", group: "", groupKind: "", groupKey: "",
    heading: "", ancestors: [], siblings: [], rect: { x: 100, y: 100, w: 80, h: 30 }, onTop: true, disabled: false,
    sensitive: "", editable: false, submits: false, form: null, frame: 0,
    ...o,
  };
}

export function snap(o) {
  return { url: "https://shop.example/", title: "Shop", outline: [], text: "", viewport: { w: 1280, h: 800 }, elements: [], texts: [], ...o };
}

/**
 * A fake driver over a tiny state machine of pages.
 * pages: { name: (world) => snapshot }, onAct: (world, action, el) => void
 */
export class FakeDriver {
  constructor({ pages, start, onAct, world }) {
    this.pages = pages;
    this.world = { page: start, ...(world || {}) };
    this.onAct = onAct;
    this.acts = [];
  }
  async snapshot() { return this.pages[this.world.page](this.world); }
  async act(a) {
    this.acts.push(a);
    const s = await this.snapshot();
    const target = a.ref ? s.elements.find((e) => e.ref === a.ref) : null;
    if (a.ref && !target) return { ok: false, error: "gone" };
    if (target && target.onTop === false && a.do === "click") return { ok: false, error: "intercepted by an overlay" };
    const r = this.onAct(this.world, a, target) || {};
    return { ok: r.ok !== false, error: r.error, settleMs: 100, downloads: r.downloads || [], requests: r.requests || [] };
  }
  async waitForState(check, { deadlineMs }) {
    const s = await this.snapshot();
    return { held: !!check(s), snapshot: s, elapsedMs: check(s) ? 0 : deadlineMs };
  }
  async locate(target) {
    const s = await this.snapshot();
    const e = s.elements.find((x) => x.ref === target.ref) || (s.texts || []).find((x) => x.ref === target.ref);
    return { ref: e ? e.ref : null, el: e || null };
  }
}

/** A shop with a search box, results with Edit links, an edit form with Save. */
export function shop(opts = {}) {
  const items = [{ id: 1, sku: "A-100", qty: 3 }, { id: 2, sku: "B-200", qty: 5 }];
  const saveLabel = opts.saveLabel || "Save";
  const pages = {
    home: (w) => snap({
      url: "https://shop.example/", title: "Shop", text: "Shop\nSearch",
      elements: [
        el({ ref: "f0e1", tag: "input", kind: "searchbox", name: "Search", inputType: "search", value: w.q || "", form: { action: "https://shop.example/", method: "get", search: true, fields: 1 } }),
      ],
    }),
    results: (w) => snap({
      url: `https://shop.example/?q=${w.q}`, title: "Results", text: `Results\n${items.filter((i) => i.sku === w.q).map((i) => `${i.sku} ${i.qty} in stock`).join("\n")}`,
      elements: [
        el({ ref: "f0e1", tag: "input", kind: "searchbox", name: "Search", inputType: "search", value: w.q, form: { action: "https://shop.example/", method: "get", search: true, fields: 1 } }),
        ...items.map((i) => el({ ref: `f0e${10 + i.id}`, tag: "a", kind: "link", name: "Edit", text: "Edit", href: `https://shop.example/items/${i.id}/edit`, group: `${i.sku} ${i.qty} in stock Edit`, groupKind: "item", rect: { x: 400, y: 100 + i.id * 30, w: 40, h: 20 } })),
      ],
    }),
    edit: (w) => snap({
      url: `https://shop.example/items/${w.item}/edit`, title: "Edit item", text: `Edit item\n${items.find((i) => i.id === w.item).sku}`,
      elements: [
        el({ ref: "f0e20", tag: "input", kind: "spinbutton", name: "Quantity", inputType: "number", value: String(w.qtyField ?? ""), form: { action: `https://shop.example/items/${w.item}`, method: "post", search: false, fields: 1 } }),
        el({ ref: "f0e21", tag: "button", kind: "button", name: saveLabel, text: saveLabel, submits: true, form: { action: `https://shop.example/items/${w.item}`, method: "post", search: false, fields: 1 }, rect: { x: 100, y: 300, w: 80, h: 30 } }),
        el({ ref: "f0e22", tag: "button", kind: "button", name: "Cancel", text: "Cancel", rect: { x: 200, y: 300, w: 80, h: 30 } }),
      ],
    }),
    saved: (w) => snap({ url: `https://shop.example/items/${w.item}?saved=1`, title: "Item", text: `Saved\nQuantity: ${items.find((i) => i.id === w.item).qty}`, elements: [] }),
  };
  if (opts.banner) {
    for (const [k, f] of Object.entries(pages)) {
      pages[k] = (w) => {
        const s = f(w);
        if (w.consent) return s;
        s.elements = [...s.elements.map((e) => ({ ...e, onTop: false })), el({ ref: "f0e9", kind: "button", name: "Accept cookies", text: "Accept cookies", groupKind: "dialog", group: "Cookies", rect: { x: 600, y: 700, w: 120, h: 30 } })];
        return s;
      };
    }
  }
  const onAct = (w, a, t) => {
    if (a.do === "navigate") { w.page = "home"; w.q = ""; return; }
    if (a.do === "click" && t && t.name === "Accept cookies") { w.consent = true; return; }
    if (a.do === "fill" && t && t.kind === "searchbox") { w.q = a.value; return; }
    if (a.do === "press" && a.key === "Enter" && w.page === "home") { w.page = "results"; return; }
    if (a.do === "click" && t && t.name === "Edit") { w.page = "edit"; w.item = Number(/items\/(\d+)/.exec(t.href)[1]); w.qtyField = items.find((i) => i.id === w.item).qty; return; }
    if (a.do === "fill" && t && t.name === "Quantity") { w.qtyField = a.value; return; }
    if (a.do === "click" && t && t.name === saveLabel) { items.find((i) => i.id === w.item).qty = Number(w.qtyField); w.page = "saved"; w.saves = (w.saves || 0) + 1; return { requests: [{ method: "POST", url: "x" }] }; }
    if (a.do === "click" && t && t.name === "Cancel") { w.page = "home"; return; }
  };
  return { pages, onAct, items };
}
