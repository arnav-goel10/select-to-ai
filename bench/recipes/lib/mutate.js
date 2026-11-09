// Serve-time mutation engine. A mutation is data: a list of ops over the
// element tree (targeting internal `_k` keys, which never reach the page) and
// a `flags` object the apps read for behavioural changes. Nothing here knows
// about any particular app.
import { h, raw, walk } from "./h.js";

function findAll(tree, k) {
  const out = [];
  walk(tree, (node, parent) => {
    if (k === "body" ? node.tag === "body" : node.attrs._k === k) out.push({ node, parent });
  });
  return out;
}

function hash(s) {
  let x = 2166136261;
  for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return (x >>> 0).toString(36);
}

function place(target, parent, items, where) {
  if (where === "append") target.children.push(...items);
  else if (where === "prepend") target.children.unshift(...items);
  else {
    const i = parent.children.indexOf(target);
    parent.children.splice(where === "after" ? i + 1 : i, 0, ...items);
  }
}

function detach(node, parent) {
  const i = parent.children.indexOf(node);
  if (i >= 0) parent.children.splice(i, 1);
}

const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12M8 2v12" stroke="currentColor" fill="none"/></svg>';

const OPS = {
  text(tree, op) {
    for (const { node } of findAll(tree, op.k)) {
      const kids = node.children.filter((c) => typeof c !== "string");
      node.children = [...kids, op.to];
      if (node.tag === "input" && node.attrs.value != null) node.attrs.value = op.to;
    }
  },
  i18n(tree, op) {
    const tr = (s) => {
      const t = s.trim();
      return op.map[t] != null ? s.replace(t, op.map[t]) : s;
    };
    walk(tree, (node) => {
      node.children = node.children.map((c) => (typeof c === "string" ? tr(c) : c));
      for (const a of ["placeholder", "aria-label", "title"]) if (node.attrs[a]) node.attrs[a] = tr(node.attrs[a]);
      if (node.tag === "input" && /submit|button/.test(node.attrs.type || "") && node.attrs.value) node.attrs.value = tr(node.attrs.value);
      if (node.tag === "html" && op.lang) node.attrs.lang = op.lang;
    });
  },
  attr(tree, op) {
    for (const { node } of findAll(tree, op.k)) {
      if (op.value == null) delete node.attrs[op.name];
      else node.attrs[op.name] = op.value;
    }
  },
  wrap(tree, op) {
    for (const { node, parent } of findAll(tree, op.k)) {
      if (!parent) continue;
      let inner = node;
      for (let d = 0; d < (op.depth || 2); d++) inner = h("div", { class: `${op.cls || "wrap"}-${d}` }, inner);
      parent.children[parent.children.indexOf(node)] = inner;
    }
  },
  // Wrap a node in an arbitrary element, optionally with a leading child
  // (e.g. <details><summary>More</summary>...</details>).
  wrapTag(tree, op) {
    for (const { node, parent } of findAll(tree, op.k)) {
      if (!parent) continue;
      const lead = op.lead ? h(op.lead.tag, op.lead.attrs || {}, op.lead.text || "") : null;
      parent.children[parent.children.indexOf(node)] = h(op.tag, { ...(op.attrs || {}) }, lead, node);
    }
  },
  churn(tree, op, seed) {
    const map = (v) => `${v.split(/[-_]/)[0].slice(0, 2)}${hash(`${seed}:${op.salt || ""}:${v}`)}`;
    walk(tree, (node) => {
      const a = node.attrs;
      if (a.id) a.id = map(a.id);
      if (a.class) a.class = a.class.split(/\s+/).filter(Boolean).map(map).join(" ");
      for (const ref of ["for", "aria-labelledby", "aria-describedby", "aria-controls", "form"]) {
        if (a[ref]) a[ref] = a[ref].split(/\s+/).map(map).join(" ");
      }
      if (typeof a.href === "string" && a.href.startsWith("#") && a.href.length > 1) a.href = `#${map(a.href.slice(1))}`;
    });
  },
  stripAttr(tree, op) {
    walk(tree, (node) => {
      delete node.attrs[op.name];
    });
  },
  swap(tree, op) {
    const as = findAll(tree, op.a);
    const bs = findAll(tree, op.b);
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
      const A = as[i], B = bs[i];
      const ia = A.parent.children.indexOf(A.node);
      const ib = B.parent.children.indexOf(B.node);
      A.parent.children[ia] = B.node;
      B.parent.children[ib] = A.node;
    }
  },
  move(tree, op) {
    const src = findAll(tree, op.k);
    const dst = findAll(tree, op.to)[0];
    if (!dst) return;
    for (const { node, parent } of src) detach(node, parent);
    place(dst.node, dst.parent, src.map((s) => s.node), op.where || "append");
  },
  insert(tree, op) {
    for (const dst of findAll(tree, op.to || "body")) place(dst.node, dst.parent, [raw(op.html)], op.where || "prepend");
  },
  iconOnly(tree, op) {
    for (const { node } of findAll(tree, op.k)) {
      node.children = [raw(ICON)];
      node.attrs["aria-label"] = op.label;
      node.attrs.title = op.label;
      if (node.tag === "input") node.attrs.value = "+";
    }
  },
  columns(tree, op) {
    for (const { node } of findAll(tree, op.k)) {
      walk(node, (n) => {
        if (n.tag !== "tr") return;
        const cells = n.children.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
        if (cells.length < op.order.length) return;
        const rest = cells.slice(op.order.length);
        n.children = [...op.order.map((i) => cells[i]), ...rest];
      });
    }
  },
  remove(tree, op) {
    for (const { node, parent } of findAll(tree, op.k)) if (parent) detach(node, parent);
  },
  clone(tree, op) {
    for (const { node, parent } of findAll(tree, op.k)) {
      if (!parent) continue;
      const copy = structuredClone(node);
      delete copy.attrs._k;
      delete copy.attrs.id;
      if (op.as) copy.attrs._k = op.as;
      for (const [name, val] of Object.entries(op.attrs || {})) {
        if (val == null) delete copy.attrs[name];
        else copy.attrs[name] = val;
      }
      for (const [name, [from, to]] of Object.entries(op.replace || {})) {
        if (typeof copy.attrs[name] === "string") copy.attrs[name] = copy.attrs[name].replace(from, to);
      }
      if (op.text != null) copy.children = [op.text];
      place(node, parent, [copy], op.where || "before");
    }
  },
};

export function applyOps(tree, mutation) {
  if (!mutation) return tree;
  for (const op of mutation.ops || []) {
    const fn = OPS[op.op];
    if (!fn) throw new Error(`unknown mutation op ${op.op}`);
    fn(tree, op, mutation.seed ?? 1);
  }
  return tree;
}

export const OP_NAMES = Object.keys(OPS);
