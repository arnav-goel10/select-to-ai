"use strict";
// Test-only. Parses an HTML page into a small DOM, so a unit test reads the
// same page a browser fixture loads: every text node (whitespace between
// tags included), scripts and styles in the body, comments, attributes,
// void tags and hidden elements, as the parser leaves them. It knows tag,
// #id, .class and [attr] / [attr="value"] selectors, joined by commas,
// with no combinators. innerText is approximate: hidden and unread parts are
// left out and block elements go on their own lines. Nothing is laid out,
// and no style sheet is read: only an inline style attribute is, so a page
// that hides a part with style="display:none", "visibility:hidden" or a
// box folded to no height (height:0 with overflow:hidden) is seen as a
// browser draws it. checkVisibility() and style follow the same rule.

const VOID = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "SOURCE", "TRACK", "WBR"]);
const RAW = new Set(["SCRIPT", "STYLE", "TEXTAREA", "TITLE"]);
const INLINE = new Set(["A", "ABBR", "B", "BDI", "BDO", "BR", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "IMG", "INS", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "TT", "U", "VAR", "WBR", "BUTTON", "INPUT", "SELECT"]);
const UNDRAWN = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
// A <p> or <li> left open ends where the next block begins, as the parser closes it.
const CLOSES = { P: /^(P|DIV|UL|OL|TABLE|H[1-6]|PRE|BLOCKQUOTE|SECTION|DL|FORM|HR)$/, LI: /^LI$/, TD: /^(TD|TH|TR)$/, TH: /^(TD|TH|TR)$/, TR: /^TR$/, DT: /^(DT|DD)$/, DD: /^(DT|DD)$/, OPTION: /^OPTION$/ };

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", copy: "©", rsaquo: "›", laquo: "«", raquo: "»", hellip: "…", ndash: "–", pound: "£", euro: "€" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
});

class Text {
  constructor(text) { this.nodeType = 3; this.textContent = text; this.parentElement = null; }
}

class Element {
  constructor(tag, attrs) {
    this.nodeType = 1;
    this.tagName = tag;
    this.attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
    this.shadowRoot = null;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get id() { return this.attrs.id || ""; }
  get className() { return this.attrs.class || ""; }
  get hidden() { return this.hasAttribute("hidden"); }
  /** The inline style attribute as property: value pairs. */
  get style() {
    const out = {};
    for (const part of String(this.attrs.style || "").split(";")) {
      const at = part.indexOf(":");
      if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim().toLowerCase();
    }
    return out;
  }
  /** Folded to no height with what is inside clipped. */
  get folded() { const st = this.style; return /^0(px)?$/.test(st.height || "") && /hidden|clip/.test(st.overflow || ""); }
  checkVisibility(opts) {
    for (let n = this; n; n = n.parentElement) if (n.hidden || n.style.display === "none") return false;
    if (opts && opts.visibilityProperty) {
      for (let n = this; n; n = n.parentElement) if (n.style.visibility) return n.style.visibility !== "hidden";
    }
    return true;
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  get innerText() {
    if (UNDRAWN.has(this.tagName) || this.hidden || this.folded || !this.checkVisibility({ visibilityProperty: true })) return "";
    let out = "";
    for (const n of this.childNodes) {
      if (n.nodeType === 3) { out += n.textContent.replace(/\s+/g, " "); continue; }
      if (n.tagName === "BR") { out += "\n"; continue; }
      const t = n.innerText;
      out += INLINE.has(n.tagName) ? t : `\n${t}\n`;
    }
    return out.replace(/[ \t]*\n[ \t\n]*/g, "\n").replace(/^\s+|\s+$/g, "");
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  descendants() { const out = []; for (const c of this.children) out.push(c, ...c.descendants()); return out; }
  contains(o) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
  matches(list) { return parseSelectors(list).some((one) => one(this)); }
  querySelectorAll(list) { const tests = parseSelectors(list); return this.descendants().filter((n) => tests.some((one) => one(n))); }
  querySelector(list) { return this.querySelectorAll(list)[0] || null; }
  closest(list) { const tests = parseSelectors(list); for (let n = this; n; n = n.parentElement) if (tests.some((one) => one(n))) return n; return null; }
}

/** A selector list of simple compound selectors, as tests for an element. */
function parseSelectors(list) {
  return String(list).split(",").map((one) => {
    const sel = one.trim();
    if (sel === "*") return () => true;
    const parts = sel.match(/^[a-z][a-z0-9-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/gi) || [];
    if (!sel || parts.join("") !== sel) throw new Error(`selector not in the small DOM: ${sel}`);
    const checks = parts.map((p) => {
      if (p[0] === "#") return (n) => n.id === p.slice(1);
      if (p[0] === ".") return (n) => n.className.split(/\s+/).includes(p.slice(1));
      if (p[0] === "[") {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p);
        if (!m) throw new Error(`attribute selector not in the small DOM: ${p}`);
        return m[2] === undefined ? (n) => n.hasAttribute(m[1]) : (n) => n.getAttribute(m[1]) === m[2];
      }
      return (n) => n.tagName === p.toUpperCase();
    });
    return (n) => checks.every((c) => c(n));
  });
}

/** Parses a whole page. Returns a document with body, documentElement and selectors. */
function parseHTML(html) {
  const root = new Element("#ROOT", {});
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const append = (node) => { node.parentElement = top() === root ? null : top(); top().childNodes.push(node); };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) { const end = html.indexOf("-->", i + 4); i = end < 0 ? html.length : end + 3; continue; }
    if (html.startsWith("<!", i)) { i = html.indexOf(">", i) + 1 || html.length; continue; }
    if (html[i] === "<" && html[i + 1] === "/") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i + 2, end).trim().toUpperCase();
      const at = stack.map((n) => n.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      i = end + 1;
      continue;
    }
    if (html[i] === "<" && /[a-z]/i.test(html[i + 1] || "")) {
      const m = /^<([a-z][a-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/i.exec(html.slice(i));
      if (!m) { append(new Text(html[i])); i++; continue; }
      const tag = m[1].toUpperCase();
      const attrs = {};
      for (const a of m[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      while (CLOSES[top().tagName] && CLOSES[top().tagName].test(tag)) stack.pop();
      if (tag === "TR") while (top().tagName === "TD" || top().tagName === "TH") stack.pop();
      const node = new Element(tag, attrs);
      append(node);
      i += m[0].length;
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag.toLowerCase()}`, i);
        const body = html.slice(i, end < 0 ? html.length : end);
        if (body) { const t = new Text(tag === "TEXTAREA" || tag === "TITLE" ? decode(body) : body); t.parentElement = node; node.childNodes.push(t); }
        i = end < 0 ? html.length : html.indexOf(">", end) + 1;
        continue;
      }
      if (!VOID.has(tag) && !m[3]) stack.push(node);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const end = next < 0 ? html.length : next;
    append(new Text(decode(html.slice(i, end))));
    i = end;
  }
  const htmlEl = root.children.find((n) => n.tagName === "HTML") || root;
  const body = htmlEl.descendants().find((n) => n.tagName === "BODY") || null;
  return {
    documentElement: htmlEl,
    body,
    querySelector: (sel) => htmlEl.querySelector(sel),
    querySelectorAll: (sel) => htmlEl.querySelectorAll(sel),
  };
}

module.exports = { parseHTML, parseSelectors };
