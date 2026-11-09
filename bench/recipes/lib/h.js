// Tiny element tree used by the fixture apps. Attributes that start with "_"
// are internal keys (mutation targets) and never reach the browser.
const VOID = new Set(["input", "br", "img", "meta", "link", "hr"]);

export function h(tag, attrs, ...children) {
  return { tag, attrs: { ...(attrs || {}) }, children: flat(children) };
}
export const raw = (html) => ({ raw: String(html) });

function flat(list) {
  const out = [];
  for (const c of list) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) out.push(...flat(c));
    else if (typeof c === "number") out.push(String(c));
    else out.push(c);
  }
  return out;
}

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function render(node, rewriteUrl = (u) => u) {
  if (typeof node === "string") return esc(node);
  if (node.raw != null) return node.raw;
  const attrs = Object.entries(node.attrs)
    .filter(([k, v]) => !k.startsWith("_") && v != null && v !== false)
    .map(([k, v]) => {
      if (v === true) return ` ${k}`;
      let val = String(v);
      if (["href", "action", "formaction", "data-href", "src"].includes(k)) val = rewriteUrl(val);
      return ` ${k}="${esc(val)}"`;
    })
    .join("");
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map((c) => render(c, rewriteUrl)).join("")}</${node.tag}>`;
}

export function walk(node, fn, parent = null) {
  if (!node || typeof node === "string" || node.raw != null) return;
  fn(node, parent);
  for (const c of [...node.children]) walk(c, fn, node);
}

export function textOf(node) {
  if (typeof node === "string") return node;
  if (!node || node.raw != null) return "";
  return node.children.map(textOf).join("");
}
