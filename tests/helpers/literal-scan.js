"use strict";
// Test-only. Finds what in a JavaScript source could be a rule for one site
// or one page. The source is parsed (acorn), so a literal is found however
// the patch is spelled: in a regex with or without a dot, in an array, a Set
// or an object, behind a name, in a selector with a tag before it.
//
// Findings, each { kind, what, line }:
// - "host": a dotted name ending in a real top-level domain (the Public
//   Suffix List), in any literal or comment.
// - "site name": a name from the site-name dictionary
//   (tests/hygiene/site-names.txt), as a word, as two words written apart
//   ("Hacker News"), or as a name in code, in any literal or comment.
// - "markup test": any string or regex literal compared with, tested
//   against, searched in or switched on what a page's markup names: an
//   element's id, name, className, classList, dataset or its class, id,
//   name and data-* attributes, or a custom element's tag.
// - "address test": any string or regex literal compared with, tested
//   against, searched in or switched on a location, host, hostname, origin
//   or URL value.
// - "title test": any string or regex literal held against a page's or a
//   tab's title, which says which page it is.
// - "selector": a selector handed to the page, or written anywhere, that
//   picks by a class, an id, a name or data attribute's value, or a custom
//   element's tag; and the literals a selector is built from at run time.
// - "class test": a page's class handed to a function of the file to read a
//   meaning from.
// - "unused data": a list of strings that nothing in the file reads, which
//   is either dead or waiting to be used.
// Values are followed through simple names, destructuring, for-of loops,
// iteration callbacks (forEach, some, map ...) and the constants they are
// bound to. The extension's own class and id names are not findings.

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const ROOT = path.join(__dirname, "../..");
const TLDS = new Set(require(path.join(ROOT, "extension/publicSuffixes.js")).split("\n").map((l) => l.split(":")[0]).filter(Boolean));

/** The site-name dictionary: { names, words }. */
function readNames(file = path.join(ROOT, "tests/hygiene/site-names.txt")) {
  const names = new Set();
  const words = new Set();
  let into = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#")) continue;
    if (line === "[names]") { into = names; continue; }
    if (line === "[words]") { into = words; continue; }
    if (into) into.add(line);
  }
  for (const w of words) names.delete(w);
  return { names, words };
}

// Names kept for examples, tests and private networks, never a real site
// (RFC 2606, RFC 6761, RFC 6762, RFC 8375, and ICANN's .internal).
const RESERVED_HOST = /(?:^|\.)(?:example|test|invalid|localhost|local|internal|lan|onion|home\.arpa)$|(?:^|\.)example\.(?:com|net|org)$/;
// The extension's own elements and settings carry this prefix.
const OWN = /select-?to-?ai/i;
const HTML_TAGS = new Set("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr math".split(" "));

const HOST_RE = /(?<![\w.@-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}))(?![\w-])/gi;
const words = (text) => String(text).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
const flatWords = (text) => String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

/** The text a regex literal's pattern spells, with escapes for punctuation undone and class escapes dropped. */
function regexText(pattern) {
  return pattern.replace(/\\[bBdDsSwWnrtfv0]/g, " ").replace(/\\(.)/g, "$1");
}

/** A custom element's tag (it has a hyphen), not the extension's own. */
const customTag = (t, own = () => false) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(String(t)) && !OWN.test(t) && !own(String(t).toLowerCase());

/** The selector compounds a string spells, when the whole string reads as a selector list; else null. */
function selectorCompounds(text, bareTags = false) {
  const s = String(text).trim();
  if (!s || s.length > 400 || (!bareTags && !/[.#[]/.test(s))) return null;
  const out = [];
  for (const part of s.split(",")) {
    const compounds = part.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    if (!compounds.length) return null;
    for (const c of compounds) {
      const m = /^(\*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?((?:[.#][A-Za-z_-][\w-]*|\[[^\]]+\]|::?[a-z-]+(?:\([^)]*\))?)*)$/.exec(c);
      if (!m || (!m[1] && !m[2])) return null;
      if (m[1] && m[1] !== "*" && !HTML_TAGS.has(m[1].toLowerCase()) && !m[1].includes("-")) return null;
      out.push({ tag: m[1] || "", rest: m[2] || "" });
    }
  }
  return out;
}

// Attributes whose values name a site's own markup, not a value a standard defines.
const MARKUP_ATTR = (a) => /^(class|id|name|for|form|list|headers|itemid|data-.+)$/i.test(a);

/**
 * What a selector string picks by a site's own names: classes, ids, the
 * values of attributes a site names (class, id, name, data-*), and custom
 * elements' tags. `bareTags` reads a plain tag list too (a selector call's
 * argument), so "ytd-app" is found there.
 */
function selectorNames(text, own = () => false, bareTags = false) {
  const compounds = selectorCompounds(text, bareTags);
  if (!compounds) return [];
  const out = [];
  for (const { tag, rest } of compounds) {
    if (tag && customTag(tag, own)) out.push(tag.toLowerCase());
    for (const m of rest.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").matchAll(/([.#])([A-Za-z_-][\w-]*)/g)) {
      // A colour written #rrggbb is not an id.
      if (m[1] === "#" && /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m[2])) continue;
      out.push(`${tag}${m[1]}${m[2]}`);
    }
    for (const m of rest.matchAll(/\[\s*([\w-]+)\s*([~^$*|]?=)\s*["']?([^"'\]]*)["']?\s*\]/g)) {
      if (MARKUP_ATTR(m[1])) out.push(`${tag}[${m[1]}${m[2]}${m[3]}]`);
    }
  }
  return out.filter((n) => !OWN.test(n) && !own(n));
}

function parse(src) {
  const comments = [];
  const opts = { ecmaVersion: "latest", locations: true, allowHashBang: true, allowReturnOutsideFunction: true, onComment: comments };
  let ast;
  try { ast = acorn.parse(src, { ...opts, sourceType: "script" }); } catch (_e) { comments.length = 0; ast = acorn.parse(src, { ...opts, sourceType: "module" }); }
  return { ast, comments };
}

/** Every node, with its parent. */
function nodesOf(ast) {
  const out = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    node.parent = parent;
    out.push(node);
    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "loc") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const x of v) visit(x, node);
      else if (v && typeof v.type === "string") visit(v, node);
    }
  };
  visit(ast, null);
  return out;
}

const isFn = (n) => n && /Function/.test(n.type);
const propName = (m) => (m && m.type === "MemberExpression" ? (m.computed ? (m.property.type === "Literal" ? String(m.property.value) : "") : m.property.name) : "");
const isLiteral = (n) => n && ((n.type === "Literal" && (typeof n.value === "string" || n.regex)) || n.type === "TemplateLiteral");
const literalText = (n) => (n.type === "TemplateLiteral" ? n.quasis.map((q) => q.value.cooked || "").join(" ") : n.regex ? regexText(n.regex.pattern) : n.value);
/** How a literal is written down in a finding: a string as itself, a regex as /pattern/flags. */
const shown = (n) => (n.regex ? `/${n.regex.pattern}/${n.regex.flags}` : n.type === "TemplateLiteral" ? n.quasis.map((q) => q.value.cooked || "").join("${}") : String(n.value));

// Words that are an address's syntax, the same for every site.
const URL_SYNTAX = new Set(["http", "https", "s", "www", "ws", "wss", "file", "ftp", "data", "blob", "about", "javascript", "mailto", "tel", "chrome", "extension", "null"]);
// How a page's markup is read, and how an address or a host is.
const CLASS_PROPS = new Set(["className", "classList", "dataset"]);
// Read off an element: its id and name are the site's.
const ELEMENT_NAME_PROPS = new Set(["id", "name"]);
const TAG_PROPS = new Set(["tagName", "nodeName", "localName"]);
const HOST_PROPS = new Set(["host", "hostname", "origin", "domain"]);
const URL_PROPS = new Set(["href", "url", "pathname", "search", "pendingUrl", "baseURI", "documentURI", "referrer", "searchParams"]);
const HOST_CALLS = new Set(["siteOf", "hostOf", "registrable", "registrableDomain"]);
const HOST_NAME = /^(?:host|hostname|domain|site|origin)s?$|(?:Host|Hostname|Domain|Origin)s?$/;
const URL_NAME = /^(?:url|href|pathname|address)s?$|(?:Url|URL|Href)s?$/;
const COMPARE = new Set(["test", "exec", "match", "matchAll", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "has", "search", "contains", "some", "every", "find", "findIndex", "filter", "replace", "replaceAll", "localeCompare"]);
// Calls that walk a list and hand each item to a callback.
const ITERATE = new Set(["forEach", "some", "every", "find", "findIndex", "filter", "map", "flatMap", "reduce"]);
const SELECTOR_CALLS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "webkitMatchesSelector", "getElementById", "getElementsByClassName", "getElementsByTagName", "getElementsByName"]);
// Calls that only convert or take apart a value: not a function reading it for a meaning.
const BUILTIN_CALLS = new Set(["String", "Number", "Boolean", "Array", "from", "trim", "toLowerCase", "toUpperCase", "split", "slice", "replace", "replaceAll", "concat", "join", "push", "add", "set", "get", "has", "delete", "includes", "test", "match", "matchAll", "exec", "startsWith", "endsWith", "indexOf", "contains", "some", "every", "filter", "map", "find", "toggle", "remove", "item", "forEach", "log", "warn", "error", "stringify", "assign", "keys", "values", "entries", "max", "min", "trimStart", "trimEnd", "padStart", "substring", "substr", "charAt", "at", "search"]);
// Constants that say what they hold is classes or ids: SKIP_CLASS, ROW_CLASSES, HIDE_IDS.
const CLASSY_NAME = /(?:^|_)(?:CLASS(?:ES|NAMES?)?|IDS)(?:_|$)/;
const ATTR_CALLS = new Set(["getAttribute", "hasAttribute", "getAttributeNode", "toggleAttribute"]);
// Names and reads that hold a page element: el, node, link, row, box.parentElement, querySelector(...).
const ELEMENT_NAME = /^(?:el|elem|element|node|kid|child|cand|link|anchor|btn|img|li|td|tr)$|(?:El|Elem|Element|Node)s?$/;
const ELEMENT_PROPS = new Set(["parentElement", "parentNode", "firstElementChild", "lastElementChild", "nextElementSibling", "previousElementSibling", "target", "currentTarget", "relatedTarget", "activeElement", "body", "documentElement", "offsetParent", "firstChild", "lastChild", "nextSibling", "previousSibling", "assignedSlot", "labels", "form", "control"]);
const ELEMENT_CALLS = new Set(["querySelector", "closest", "getElementById", "elementFromPoint", "elementsFromPoint", "item", "namedItem", "deepElementAt", "composedPath"]);

/**
 * Findings for one source: [{ kind, what, line }]. `names` is the
 * dictionary from readNames, with any extra names joined in.
 */
function findings(src, names = readNames(), own = () => false) {
  const { ast, comments } = parse(src);
  const all = nodesOf(ast);
  const out = [];
  const seen = new Set();
  const report = (kind, what, line) => { const key = `${kind}|${what}|${line}`; if (!seen.has(key)) { seen.add(key); out.push({ kind, what, line }); } };
  // Names used in code before a dot ("profile.email", "chrome.tabs"): code, not a host, where a string or comment spells them.
  const objects = new Set(["chrome", "self", "window", "document", "globalThis", "location", "navigator"]);
  for (const n of all) if (n.type === "MemberExpression" && n.object.type === "Identifier") objects.add(n.object.name);

  const hostsIn = (text) => {
    const found = [];
    for (const m of String(text).matchAll(HOST_RE)) {
      const host = m[1].toLowerCase();
      if (!TLDS.has(m[2].toLowerCase()) || objects.has(m[1].split(".")[0]) || RESERVED_HOST.test(host)) continue;
      found.push(host);
    }
    return found;
  };
  // A whole host is reported as a host; the names are looked for in what is
  // left, as single words and as two words written apart ("Hacker News").
  const namesIn = (text) => {
    const rest = String(text).replace(HOST_RE, " ");
    const flat = flatWords(rest);
    const pairs = flat.slice(1).map((w, i) => flat[i] + w);
    return [...new Set([...words(rest), ...flat, ...pairs])].filter((w) => names.names.has(w));
  };

  // Anywhere: hosts and dictionary names.
  const literals = all.filter(isLiteral);
  for (const n of literals) {
    const text = literalText(n);
    const line = n.loc.start.line;
    for (const h of hostsIn(text)) report("host", h, line);
    for (const w of namesIn(text)) report("site name", w, line);
  }
  for (const c of comments) {
    for (const h of hostsIn(c.value)) report("host", h, c.loc.start.line);
    for (const w of namesIn(c.value)) report("site name", w, c.loc.start.line);
  }

  // What each name is bound to: the value it is given, in the function that
  // declares it (blocks are not told apart, which can only find more). A
  // constant reached through an object (TOOLS.SKIP, { SKIP: [...] }) is
  // bound by its name file-wide. Destructured names are bound to the read
  // they stand for, loop variables to what they loop over, and a callback's
  // first parameter to the list it is called on.
  const CONSTANT = /^[A-Z][A-Z0-9_]*$/;
  const scopeOf = (n) => { for (let p = n.parent; p; p = p.parent) if (isFn(p) || p.type === "Program") return p; return null; };
  const scopes = new Map();
  const declared = (scope) => { if (!scopes.has(scope)) scopes.set(scope, new Map()); return scopes.get(scope); };
  const declareIn = (n, name) => {
    for (let s = scopeOf(n); s; s = scopeOf(s)) if (scopes.has(s) && scopes.get(s).has(name)) return s;
    return scopeOf(n);
  };
  const constants = new Map();
  const add = (map, name, node) => { if (!name || !node || isFn(node)) return; if (!map.has(name)) map.set(name, []); map.get(name).push(node); };
  // A synthetic read: `from.key`, or one item of `from` (key null).
  const readOf = (from, key, at) => ({ type: key ? "MemberExpression" : "ItemOf", object: from, property: key ? { type: "Identifier", name: key } : null, computed: false, start: at.start, end: at.end, loc: at.loc, parent: at.parent });
  const bindPattern = (scope, pattern, value) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") { add(declared(scope), pattern.name, value); return; }
    if (pattern.type === "AssignmentPattern") { bindPattern(scope, pattern.left, value); return; }
    if (pattern.type === "ObjectPattern") {
      for (const p of pattern.properties) {
        if (p.type === "RestElement") { bindPattern(scope, p.argument, value); continue; }
        const key = !p.computed && p.key ? (p.key.name || String(p.key.value)) : "";
        bindPattern(scope, p.value, key ? readOf(value, key, p) : value);
      }
      return;
    }
    if (pattern.type === "ArrayPattern") { for (const e of pattern.elements) bindPattern(scope, e && e.type === "RestElement" ? e.argument : e, readOf(value, null, pattern)); }
  };
  for (const n of all) {
    if (n.type === "VariableDeclarator") {
      if (n.id.type === "Identifier") add(declared(scopeOf(n)), n.id.name, n.init || { type: "Empty" });
      else if (n.init) bindPattern(scopeOf(n), n.id, n.init);
    }
    // for (const c of el.classList): c is one item of el.classList.
    if ((n.type === "ForOfStatement" || n.type === "ForInStatement") && n.left) {
      const target = n.left.type === "VariableDeclaration" ? n.left.declarations[0].id : n.left;
      const scope = scopeOf(n.body) || scopeOf(n);
      if (n.type === "ForOfStatement") bindPattern(scope, target, readOf(n.right, null, n.right));
    }
    // el.classList.forEach((c) => ...): c is one item of el.classList.
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && ITERATE.has(propName(n.callee))) {
      const fn = n.arguments[0];
      if (isFn(fn) && fn.params.length) {
        const at = propName(n.callee) === "reduce" ? 1 : 0;
        if (fn.params[at]) bindPattern(fn, fn.params[at], readOf(n.callee.object, null, n.callee.object));
      }
    }
  }
  for (const n of all) {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") add(declared(declareIn(n, n.left.name)), n.left.name, n.right);
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && CONSTANT.test(propName(n.left))) add(constants, propName(n.left), n.right);
    if (n.type === "Property" && !n.computed && n.key && n.key.type === "Identifier" && CONSTANT.test(n.key.name)) add(constants, n.key.name, n.value);
  }
  const isPropertyKey = (n) => n.parent && n.parent.type === "MemberExpression" && n.parent.property === n && !n.parent.computed;
  const isObjectKey = (n) => n.parent && n.parent.type === "Property" && n.parent.key === n && !n.parent.computed && !n.parent.shorthand;
  /** The binding a name or a constant member resolves to: { key, values }, or null. */
  const binding = (n) => {
    if (n.type === "Identifier" && !isPropertyKey(n)) {
      for (let s = scopeOf(n); s; s = scopeOf(s)) {
        const m = scopes.get(s);
        if (m && m.has(n.name)) return { key: m.get(n.name), values: m.get(n.name) };
      }
      // A callback's own parameter: its scope is the function itself.
      for (let p = n.parent; p; p = p.parent) if (isFn(p) && scopes.has(p) && scopes.get(p).has(n.name)) return { key: scopes.get(p).get(n.name), values: scopes.get(p).get(n.name) };
      if (constants.has(n.name)) return { key: constants.get(n.name), values: constants.get(n.name) };
      return null;
    }
    if (n.type === "MemberExpression" && !n.computed && CONSTANT.test(n.property.name) && constants.has(n.property.name)) return { key: constants.get(n.property.name), values: constants.get(n.property.name) };
    return null;
  };

  /**
   * Whether an expression is a page element: a name that says so (el,
   * node, link), a read that gives one (parentElement, event.target,
   * querySelector()), an item of a list of them, or a name bound to one.
   */
  const elementish = (n, depth = 0) => {
    if (!n || depth > 8) return false;
    if (n.type === "Identifier") {
      if (ELEMENT_NAME.test(n.name)) return true;
      const b = binding(n);
      return !!b && b.values.some((v) => v !== n && elementish(v, depth + 1));
    }
    if (n.type === "MemberExpression") {
      if (ELEMENT_PROPS.has(propName(n))) return true;
      if (n.computed && /^(children|childNodes|elements|labels)$/.test(propName(n.object))) return true;
      return false;
    }
    if (n.type === "ItemOf") return /querySelectorAll|getElementsBy|children|childNodes|elements|composedPath/.test(src.slice(n.object.start, n.object.end));
    if (n.type === "CallExpression") return ELEMENT_CALLS.has(n.callee.type === "Identifier" ? n.callee.name : propName(n.callee));
    if (n.type === "LogicalExpression" || n.type === "ConditionalExpression") return elementish(n.right || n.consequent, depth + 1) || elementish(n.alternate || n.left, depth + 1);
    return false;
  };
  const rootLike = (n) => /getRootNode|shadowRoot|[Rr]oot$/.test(src.slice(n.object.start, n.object.end));

  /** Whether a member read, on its own, gives one of the kinds. */
  const memberKind = (n, kind) => {
    const p = propName(n);
    if (kind === "class") return CLASS_PROPS.has(p) || (n.object.type === "MemberExpression" && propName(n.object) === "dataset");
    if (kind === "id") return ELEMENT_NAME_PROPS.has(p) && elementish(n.object);
    if (kind === "tag") return TAG_PROPS.has(p);
    // A page's or a tab's title says which page it is.
    if (kind === "title") return p === "title" && !elementish(n.object);
    // A shadow root's host is an element, not an address's.
    if (kind === "host") return HOST_PROPS.has(p) && !(p === "host" && rootLike(n));
    if (kind === "url") return URL_PROPS.has(p) || (p === "src" && elementish(n.object)) || (n.object.type === "Identifier" && n.object.name === "location");
    return false;
  };
  const attrKind = (n, kind) => {
    const a = n.arguments[0] && n.arguments[0].type === "Literal" ? String(n.arguments[0].value).toLowerCase() : "";
    return (kind === "class" && (a === "class" || a.startsWith("data-"))) || (kind === "id" && MARKUP_ATTR(a) && a !== "class" && !a.startsWith("data-")) || (kind === "url" && (a === "href" || a === "src" || a === "action"));
  };

  /**
   * Whether an expression reads a page's markup ("class", "tag"), a host
   * ("host") or an address ("url"): directly, or through a name that holds
   * such a read. Callbacks are looked into; other functions are not.
   */
  const holds = { class: new Set(), id: new Set(), tag: new Set(), host: new Set(), url: new Set(), title: new Set() };
  const KINDS = Object.keys(holds);
  const held = (n, kind) => { const b = binding(n); return !!b && holds[kind].has(b.key); };
  const reads = (node, kind, intoFns = true) => {
    let hit = false;
    const stack = [node];
    while (stack.length && !hit) {
      const n = stack.pop();
      if (!n || typeof n.type !== "string") continue;
      if (!intoFns && isFn(n)) continue;
      if (n.type === "UnaryExpression" && n.operator === "typeof") continue;
      if (n.type === "CallExpression" && ATTR_CALLS.has(propName(n.callee)) && n.arguments[0] && n.arguments[0].type === "Literal") { if (attrKind(n, kind)) hit = true; continue; }
      if (n.type === "MemberExpression" && memberKind(n, kind)) hit = true;
      if (n.type === "CallExpression" && kind === "host" && HOST_CALLS.has(n.callee.type === "Identifier" ? n.callee.name : propName(n.callee))) hit = true;
      if ((n.type === "Identifier" && !isPropertyKey(n)) || n.type === "MemberExpression") if (held(n, kind)) hit = true;
      // A function's name is not a value read: addressOrigin(u) is not an origin.
      if (n.type === "Identifier" && !isPropertyKey(n) && !isObjectKey(n) && !(n.parent && n.parent.type === "CallExpression" && n.parent.callee === n)) {
        if (kind === "host" && HOST_NAME.test(n.name)) hit = true;
        if (kind === "url" && URL_NAME.test(n.name)) hit = true;
      }
      for (const key of Object.keys(n)) {
        if (key === "parent" || key === "loc") continue;
        const v = n[key];
        if (Array.isArray(v)) stack.push(...v);
        else if (v && typeof v.type === "string") stack.push(v);
      }
    }
    return hit;
  };
  /**
   * Whether a value is itself markup, a host or an address, or is carried
   * over from one: a property read off one, an item of one, a conversion of
   * one (String(), trim, toLowerCase, a template, a + join), one branch of a
   * condition. What a function of the file returns when handed one is not.
   */
  const carries = (n, kind) => {
    if (!n || typeof n.type !== "string") return false;
    switch (n.type) {
      case "Identifier":
        if (isPropertyKey(n)) return false;
        return held(n, kind) || (kind === "host" && HOST_NAME.test(n.name)) || (kind === "url" && (URL_NAME.test(n.name) || n.name === "location"));
      case "ItemOf": return carries(n.object, kind);
      case "MemberExpression": {
        if (memberKind(n, kind)) return true;
        const p = propName(n);
        // A part of an address other than its host is not a host: url.pathname, url.protocol.
        if (kind === "host" && /^(pathname|search|hash|protocol|port|href|searchParams|username|password)$/.test(p)) return held(n, kind);
        if (n.computed && n.property.type !== "Literal" && !/^\d/.test(String(n.property.value))) return held(n, kind) || carries(n.object, kind);
        return held(n, kind) || (!/^(length|size)$/.test(p) && carries(n.object, kind));
      }
      case "CallExpression": {
        const callee = n.callee.type === "Identifier" ? n.callee.name : propName(n.callee);
        if (ATTR_CALLS.has(callee)) return attrKind(n, kind);
        if (kind === "host" && HOST_CALLS.has(callee)) return true;
        if (n.callee.type === "Identifier" && /^(String|decodeURIComponent|decodeURI)$/.test(callee)) return carries(n.arguments[0], kind);
        if (n.callee.type === "MemberExpression" && /^(toLowerCase|toUpperCase|trim|trimStart|trimEnd|toString|normalize|replace|replaceAll|slice|substring|substr|split|from|item|at|get|getAll|keys|values|entries)$/.test(callee)) return callee === "from" ? carries(n.arguments[0], kind) : carries(n.callee.object, kind);
        // A function of the file that hands back a page's markup: tokens(el) returning el's classes.
        if (n.callee.type === "Identifier" && MARKUP_KINDS.has(kind)) return returnsKind(n.callee.name, kind);
        return false;
      }
      // new URL(x) is an address; its host is read off it by name (.hostname).
      case "NewExpression": return n.callee.type === "Identifier" && n.callee.name === "URL" && kind === "url";
      case "ConditionalExpression": return carries(n.consequent, kind) || carries(n.alternate, kind);
      case "LogicalExpression": return carries(n.left, kind) || carries(n.right, kind);
      case "BinaryExpression": return n.operator === "+" && (carries(n.left, kind) || carries(n.right, kind));
      case "TemplateLiteral": return n.expressions.some((e) => carries(e, kind));
      case "AwaitExpression": case "SpreadElement": case "ChainExpression": return carries(n.argument || n.expression, kind);
      case "ArrayExpression": return n.elements.some((e) => carries(e, kind));
      case "AssignmentExpression": return carries(n.right, kind);
      default: return false;
    }
  };
  // What the file's own named functions return, read once each.
  const MARKUP_KINDS = new Set(["class", "id", "tag"]);
  const functionsNamed = new Map();
  for (const n of all) {
    if (!isFn(n)) continue;
    const name = n.id ? n.id.name : n.parent && n.parent.type === "VariableDeclarator" && n.parent.id.type === "Identifier" ? n.parent.id.name : "";
    if (name) functionsNamed.set(name, n);
  }
  const returning = new Map();
  const returnsKind = (name, kind) => {
    const fn = functionsNamed.get(name);
    const key = `${name}|${kind}`;
    if (!fn) return false;
    if (returning.has(key)) return returning.get(key);
    returning.set(key, false);
    let out = false;
    if (fn.body.type !== "BlockStatement") out = carries(fn.body, kind);
    else {
      const stack = [fn.body];
      while (stack.length && !out) {
        const x = stack.pop();
        if (!x || typeof x.type !== "string" || (isFn(x) && x !== fn)) continue;
        if (x.type === "ReturnStatement" && x.argument && carries(x.argument, kind)) out = true;
        for (const k of Object.keys(x)) { if (k === "parent" || k === "loc") continue; const c = x[k]; if (Array.isArray(c)) stack.push(...c); else if (c && typeof c.type === "string") stack.push(c); }
      }
    }
    returning.set(key, out);
    return out;
  };
  /** A side of a comparison reads one: a callback is looked into, any other value must carry one. */
  const side = (n, kind) => (isFn(n) ? reads(n.body, kind) : carries(n, kind));

  // Names that hold what such a read gave: `const cls = String(el.className)`.
  const allBindings = [...[...scopes.values()].flatMap((m) => [...m.values()]), ...constants.values()];
  for (let round = 0, grew = true; grew && round < 8; round++) {
    grew = false;
    for (const values of allBindings) for (const kind of KINDS) if (!holds[kind].has(values) && values.some((v) => carries(v, kind))) { holds[kind].add(values); grew = true; }
  }

  /**
   * The literals one side of a comparison holds: the literal itself, or the
   * data a name is bound to (a string, a regex, an array, a Set, an object
   * of them, followed through other names). A literal built into a longer
   * expression (a message, a call's other arguments) is not one.
   */
  const operandLiterals = (node, seenBindings = new Set(), keys = false) => {
    const out = [];
    const visit = (n) => {
      if (!n) return;
      if (isLiteral(n)) { if (n.type !== "TemplateLiteral" || !n.expressions.length) out.push(n); else n.expressions.forEach(visit); return; }
      if (n.type === "ArrayExpression") { n.elements.forEach(visit); return; }
      if (n.type === "SpreadElement" || n.type === "ChainExpression") { visit(n.argument || n.expression); return; }
      if (n.type === "ItemOf") { visit(n.object); return; }
      if (n.type === "ObjectExpression") { for (const p of n.properties) if (p.type === "Property") { visit(p.value); if (!p.computed && p.key.type === "Literal") visit(p.key); if (keys && !p.computed && p.key.type === "Identifier") out.push({ type: "Literal", value: p.key.name, loc: p.key.loc, start: p.key.start, end: p.key.end }); } return; }
      if (n.type === "NewExpression" && n.callee.type === "Identifier" && /^(Set|Map|RegExp)$/.test(n.callee.name)) { n.arguments.forEach(visit); return; }
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && /^(RegExp|String)$/.test(n.callee.name)) { n.arguments.forEach(visit); return; }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && /^(from|of|concat|join|flat|map|toLowerCase|toUpperCase|trim)$/.test(propName(n.callee))) { visit(n.callee.object); n.arguments.forEach(visit); return; }
      if (n.type === "ConditionalExpression" || n.type === "LogicalExpression") { visit(n.consequent || n.left); visit(n.alternate || n.right); return; }
      if (n.type === "BinaryExpression" && n.operator === "+") { visit(n.left); visit(n.right); return; }
      // A callback brings the data it holds the item against: SKIP in (c) => SKIP.has(c).
      if (isFn(n)) {
        const inner = [n.body];
        while (inner.length) {
          const x = inner.pop();
          if (!x || typeof x.type !== "string" || isFn(x)) continue;
          if (x.type === "CallExpression" && x.callee.type === "MemberExpression" && COMPARE.has(propName(x.callee))) { visit(x.callee.object); x.arguments.forEach(visit); }
          if (x.type === "BinaryExpression" && /^[!=]==?$/.test(x.operator)) { visit(x.left); visit(x.right); }
          for (const k of Object.keys(x)) { if (k === "parent" || k === "loc") continue; const c = x[k]; if (Array.isArray(c)) inner.push(...c); else if (c && typeof c.type === "string") inner.push(c); }
        }
        return;
      }
      const b = binding(n);
      if (b && !seenBindings.has(b.key)) { seenBindings.add(b.key); b.values.forEach(visit); }
    };
    visit(node);
    return out;
  };

  /** Whether an expression is a page's class itself (not something worked out from it). */
  const isClassValue = (a) => {
    let n = a;
    for (let i = 0; n && i < 6; i++) {
      if (n.type === "SpreadElement") { n = n.argument; continue; }
      if (n.type === "ArrayExpression" && n.elements.length === 1) { n = n.elements[0]; continue; }
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && /^(String|Array)$/.test(n.callee.name)) { n = n.arguments[0]; continue; }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && /^(from|toLowerCase|toUpperCase|trim|toString)$/.test(propName(n.callee))) { n = propName(n.callee) === "from" ? n.arguments[0] : n.callee.object; continue; }
      if (n.type === "LogicalExpression") { n = n.right; continue; }
      break;
    }
    if (!n) return false;
    if (n.type === "MemberExpression" && /^(className|classList)$/.test(propName(n))) return true;
    if (n.type === "CallExpression" && ATTR_CALLS.has(propName(n.callee)) && n.arguments[0] && /^(class|id)$/i.test(String(n.arguments[0].value))) return true;
    return (n.type === "Identifier" || n.type === "MemberExpression") && held(n, "class");
  };
  const snippet = (n) => src.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 100);
  // The extension's own name, or nothing at all, is not a site's.
  const ownText = (t) => { const s = String(t).trim(); return !s || s.split(/[\s,]+/).every((x) => !x || OWN.test(x) || own(x)); };

  // Literals held against a host or an address: parts of an address, not selectors.
  const addressParts = new Set();
  // A literal that spells no name at all (punctuation, whitespace, digits,
  // an address's syntax: a scheme, "www") cannot be one site's.
  const namesNothing = (n) => {
    const t = n.regex ? regexText(n.regex.pattern.replace(/\[(?:\\.|[^\]])*\]/g, " ")) : String(literalText(n));
    return flatWords(t).every((w) => /^\d+$/.test(w) || URL_SYNTAX.has(w));
  };
  const judge = (kind, lits) => {
    for (const n of lits) {
      const line = n.loc.start.line;
      if (namesNothing(n)) continue;
      if (kind === "class" || kind === "id") {
        if (!n.regex && ownText(literalText(n))) continue;
        if (n.regex && OWN.test(n.regex.pattern) && !/[|]/.test(n.regex.pattern)) continue;
        report("markup test", shown(n), line);
        continue;
      }
      if (kind === "tag") {
        // A standard tag is the same on every site; a custom element's is one site's.
        const tokens = n.regex ? regexText(n.regex.pattern).match(/[A-Za-z][\w-]*/g) || [] : [String(literalText(n))];
        if (tokens.some((t) => customTag(t, own))) report("markup test", shown(n), line);
        continue;
      }
      if (kind === "title") { report("title test", shown(n), line); continue; }
      addressParts.add(n);
      report("address test", shown(n), line);
    }
  };
  const compareMarkup = (kind, lits, n) => {
    judge(kind, lits);
    if (kind === "class" && !lits.length) report("class test", snippet(n), n.loc.start.line);
  };

  for (const n of all) {
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const method = propName(n.callee);
      // Selectors handed to the page: by a site's class, id, named attribute or custom tag.
      if (SELECTOR_CALLS.has(method)) {
        for (const a of n.arguments) {
          const lits = operandLiterals(a);
          // A selector built at run time ("." + name): the names it is built from are a site's.
          // A selector built at run time from names: each bare name it is built from is a class or id it picks by.
          const built = a.type !== "Literal" && !(a.type === "TemplateLiteral" && !a.expressions.length);
          for (const lit of lits) {
            const text = literalText(lit);
            if (method === "getElementById" || method === "getElementsByClassName" || method === "getElementsByName") { for (const t of String(text).split(/\s+/)) if (t && !OWN.test(t) && !own(t)) report("selector", t, lit.loc.start.line); continue; }
            if (method === "getElementsByTagName") { if (customTag(text, own)) report("selector", String(text).toLowerCase(), lit.loc.start.line); continue; }
            for (const s of selectorNames(text, own, true)) report("selector", s, lit.loc.start.line);
            const bare = String(text).trim();
            if (built && /^[A-Za-z_-][\w-]*$/.test(bare) && !HTML_TAGS.has(bare.toLowerCase()) && !ownText(bare)) report("selector", bare, lit.loc.start.line);
          }
        }
      }
      // One thing held against another: x.test(y), x.includes(y), SET.has(y), xs.some(cb).
      if (COMPARE.has(method)) {
        const sides = method === "replace" || method === "replaceAll" ? [n.callee.object, n.arguments[0]] : [n.callee.object, ...n.arguments];
        for (const kind of KINDS) {
          const tainted = sides.filter((s) => s && side(s, kind));
          if (!tainted.length) continue;
          const lits = sides.filter((s) => s && !tainted.includes(s)).flatMap((s) => operandLiterals(s));
          if (kind === "class" && method === "has" && !lits.length) continue;
          compareMarkup(kind, lits, n);
        }
      }
    }
    if (n.type === "BinaryExpression" && /^[!=]==?$/.test(n.operator)) {
      for (const kind of KINDS) {
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
          if (!side(a, kind) || side(b, kind)) continue;
          judge(kind, operandLiterals(b));
        }
      }
    }
    // M[c] with c a page's class: the keys of M are what it is held against.
    if (n.type === "MemberExpression" && n.computed && n.property.type !== "Literal") {
      for (const kind of KINDS) if (carries(n.property, kind) && !carries(n.object, kind)) judge(kind, operandLiterals(n.object, new Set(), true));
    }
    // "navbox" in M, with the page's class on the left.
    if (n.type === "BinaryExpression" && n.operator === "in") for (const kind of KINDS) if (carries(n.left, kind)) judge(kind, operandLiterals(n.right, new Set(), true));
    if (n.type === "SwitchStatement") {
      for (const kind of KINDS) if (carries(n.discriminant, kind)) judge(kind, n.cases.filter((c) => c.test).flatMap((c) => operandLiterals(c.test)));
    }
    // A page's class handed to a function of the file's own, to be read for a meaning.
    if (n.type === "CallExpression" && !BUILTIN_CALLS.has(n.callee.type === "Identifier" ? n.callee.name : propName(n.callee)) && n.arguments.some(isClassValue)) {
      report("class test", snippet(n), n.loc.start.line);
    }
  }

  // A helper that hands its parameter to a markup or address test:
  // `const has = (el, c) => el.classList.contains(c)`. What it is called
  // with is what is tested.
  const helpers = new Map();
  for (const n of all) {
    if (!isFn(n) || !n.params.length) continue;
    const name = n.id ? n.id.name : n.parent && n.parent.type === "VariableDeclarator" && n.parent.id.type === "Identifier" ? n.parent.id.name : "";
    if (!name) continue;
    const params = n.params.map((p) => (p.type === "Identifier" ? p.name : ""));
    const tested = new Map();
    const inner = [n.body];
    while (inner.length) {
      const x = inner.pop();
      if (!x || typeof x.type !== "string") continue;
      const sidesOf = x.type === "CallExpression" && x.callee.type === "MemberExpression" && COMPARE.has(propName(x.callee)) ? [x.callee.object, ...x.arguments] : x.type === "BinaryExpression" && /^[!=]==?$/.test(x.operator) ? [x.left, x.right] : null;
      if (sidesOf) for (const kind of KINDS) if (sidesOf.some((s) => side(s, kind))) for (const s of sidesOf) if (s.type === "Identifier" && params.includes(s.name) && !side(s, kind)) tested.set(params.indexOf(s.name), kind);
      for (const k of Object.keys(x)) { if (k === "parent" || k === "loc") continue; const c = x[k]; if (Array.isArray(c)) inner.push(...c); else if (c && typeof c.type === "string") inner.push(c); }
    }
    if (tested.size) helpers.set(name, tested);
  }
  for (const n of all) {
    if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || !helpers.has(n.callee.name)) continue;
    for (const [i, kind] of helpers.get(n.callee.name)) if (n.arguments[i]) judge(kind, operandLiterals(n.arguments[i]));
  }

  // A name that says it holds classes or ids: what it holds is class or id tokens.
  for (const m of scopes.values()) for (const [name, values] of m) if (CLASSY_NAME.test(name)) judge("class", values.flatMap((v) => operandLiterals(v)));
  for (const [name, values] of constants) if (CLASSY_NAME.test(name)) judge("class", values.flatMap((v) => operandLiterals(v)));

  // A list of strings that nothing reads: dead data, or a rule waiting to be used.
  const referenced = new Set();
  for (const n of all) if (n.type === "Identifier" && !(n.parent && n.parent.type === "VariableDeclarator" && n.parent.id === n) && !isPropertyKey(n) && !isObjectKey(n)) referenced.add(n.name);
  for (const n of all) {
    if (n.type !== "VariableDeclarator" || n.id.type !== "Identifier" || !n.init || referenced.has(n.id.name)) continue;
    const init = n.init.type === "NewExpression" && n.init.arguments[0] ? n.init.arguments[0] : n.init;
    if (init.type !== "ArrayExpression" || init.elements.length < 2 || !init.elements.every((e) => e && e.type === "Literal" && typeof e.value === "string")) continue;
    report("unused data", n.id.name, n.loc.start.line);
  }

  // Names in code (a variable, a property, an object's key) that are a site's: { amazon: ..., github: ... }.
  for (const n of all) {
    if (n.type !== "Identifier" && !(n.type === "Literal" && n.parent && n.parent.type === "Property" && n.parent.key === n)) continue;
    const name = n.type === "Identifier" ? n.name : String(n.value);
    for (const w of name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) if (names.names.has(w)) report("site name", w, n.loc.start.line);
  }
  // A selector written anywhere, not only where it is handed to the page.
  // A string held against an address's fragment (location.hash === "#help")
  // is a fragment, not a selector.
  const fragments = new Set();
  for (const n of all) if (n.type === "BinaryExpression" && /^[!=]==?$/.test(n.operator)) for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) if (propName(a) === "hash" && isLiteral(b)) fragments.add(b);
  for (const n of literals) if (!n.regex && !fragments.has(n) && !addressParts.has(n)) for (const s of selectorNames(literalText(n), own)) report("selector", s, n.loc.start.line);
  return out.sort((a, b) => a.line - b.line);
}

module.exports = { findings, readNames, selectorNames, parse };
