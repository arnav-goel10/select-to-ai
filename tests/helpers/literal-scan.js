"use strict";
// Test-only. Finds what in a JavaScript source names a site: a host, a site
// or brand name, a site's own class or id, or a path of one site's
// addresses. The source is parsed (acorn) and every string, template and
// regular expression literal and every comment is read, so a name is found
// however the patch is spelled: in a regex with or without a dot, in an
// array, a Set or an object, in a selector with a tag before it.
//
// Two kinds of finding:
// - Anywhere: a host (a dotted name ending in a real top-level domain, from
//   the Public Suffix List), a name from the site-name dictionary
//   (tests/hygiene/site-names.txt), or a selector that picks a class, an id
//   or a data attribute's value.
// - Held against a page's class or id, or against a host or address: every
//   literal that reaches such a comparison, through variables, arrays, Sets
//   and callbacks, in the same file. A class token there is one site's
//   markup; a bare label held against a host is one site; a path held
//   against an address is one site's address.

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
// RFC 6762 Appendix G lists the private names in common use (intranet, internal, private, corp, home, lan).
const SPECIAL = new Set(["example", "test", "invalid", "localhost", "localdomain", "local", "internal", "intranet", "private", "corp", "lan", "home", "arpa", "onion"]);
const RESERVED_HOST = /(?:^|\.)(?:example|test|invalid|localhost|local|internal|lan|onion|home\.arpa)$|(?:^|\.)example\.(?:com|net|org)$/;
// Scheme and address words: an address's parts, not a site.
const ADDRESS_WORDS = new Set(["null", "http", "https", "file", "ftp", "ws", "wss", "data", "blob", "about", "chrome", "edge", "brave", "opera", "vivaldi", "javascript", "mailto", "tel", "view-source", "extension", "chrome-extension", "moz-extension", "devtools", "www"]);
// The extension's own elements and settings carry this prefix.
const OWN = /select-?to-?ai/i;
const HTML_TAGS = new Set("a abbr address article aside audio b blockquote body button canvas caption cite code dd details dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr html i iframe img input label legend li main mark menu nav ol optgroup option p picture pre progress section select small span strong sub summary sup svg table tbody td template textarea tfoot th thead time tr u ul video".split(" "));

const HOST_RE = /(?<![\w.@-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}))(?![\w-])/gi;
const words = (text) => String(text).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
const flatWords = (text) => String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

/** The text a regex literal's pattern spells, with escapes for punctuation undone and class escapes dropped. */
function regexText(pattern) {
  return pattern.replace(/\\[bBdDsSwWnrtfv0]/g, " ").replace(/\\(.)/g, "$1");
}

/** The selector compounds a string spells, when the whole string reads as a selector list; else null. */
function selectorCompounds(text) {
  const s = String(text).trim();
  if (!s || s.length > 400 || !/[.#[]/.test(s)) return null;
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

/** What a selector string picks by a site's own names: classes, ids and attribute values. */
function selectorNames(text, own = () => false) {
  const compounds = selectorCompounds(text);
  if (!compounds) return [];
  const out = [];
  for (const { tag, rest } of compounds) {
    for (const m of rest.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").matchAll(/([.#])([A-Za-z_-][\w-]*)/g)) {
      // A colour written #rrggbb is not an id.
      if (m[1] === "#" && /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m[2])) continue;
      out.push(`${tag}${m[1]}${m[2]}`);
    }
    for (const m of rest.matchAll(/\[\s*([\w-]+)\s*([~^$*|]?=)\s*["']?([^"'\]]*)["']?\s*\]/g)) {
      const attr = m[1].toLowerCase();
      if (attr === "class" || attr === "id" || attr.startsWith("data-")) out.push(`${tag}[${m[1]}${m[2]}${m[3]}]`);
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

// How a page's class or id is read, and how an address or a host is.
const CLASS_PROPS = new Set(["className", "classList"]);
const HOST_PROPS = new Set(["host", "hostname", "origin", "domain"]);
const URL_PROPS = new Set(["href", "url", "pathname", "search", "pendingUrl", "baseURI", "documentURI", "referrer", "src"]);
const HOST_CALLS = new Set(["siteOf", "hostOf", "registrable", "registrableDomain"]);
const HOST_NAME = /^(?:host|hostname|domain|site|origin)s?$|(?:Host|Hostname|Domain|Origin)s?$/;
const URL_NAME = /^(?:url|href|pathname)s?$|(?:Url|URL|Href)s?$/;
const COMPARE = new Set(["test", "exec", "match", "matchAll", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "has", "search", "contains", "some", "every", "find", "findIndex", "filter", "replace", "replaceAll"]);
const SELECTOR_CALLS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "webkitMatchesSelector", "getElementById", "getElementsByClassName"]);
// Calls that only convert or take apart a value: not a function reading it for a meaning.
const BUILTIN_CALLS = new Set(["String", "Number", "Boolean", "Array", "from", "trim", "toLowerCase", "toUpperCase", "split", "slice", "replace", "replaceAll", "concat", "join", "push", "add", "set", "get", "has", "delete", "includes", "test", "match", "matchAll", "exec", "startsWith", "endsWith", "indexOf", "contains", "some", "every", "filter", "map", "find", "toggle", "remove", "item", "forEach", "log", "warn", "error", "stringify", "assign", "keys", "values", "entries", "max", "min", "trimStart", "trimEnd", "padStart", "substring", "substr", "charAt", "at", "search"]);
// Constants that say what they hold is classes or ids: SKIP_CLASS, ROW_CLASSES, HIDE_IDS.
const CLASSY_NAME = /(?:^|_)(?:CLASS(?:ES|NAMES?)?|IDS)(?:_|$)/;
const ATTR_CALLS = new Set(["getAttribute", "hasAttribute", "setAttribute", "removeAttribute", "toggleAttribute"]);

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
  // A whole host is reported as a host; the names are looked for in what is left.
  const namesIn = (text) => { const rest = String(text).replace(HOST_RE, " "); return [...new Set([...words(rest), ...flatWords(rest)])].filter((w) => names.names.has(w)); };

  // Anywhere: hosts, dictionary names, selectors by a site's names. A
  // string held against an address's fragment (location.hash === "#help")
  // is a fragment, not a selector.
  const fragments = new Set();
  for (const n of all) if (n.type === "BinaryExpression" && /^[!=]==?$/.test(n.operator)) for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) if (propName(a) === "hash" && isLiteral(b)) fragments.add(b);
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
  // bound by its name file-wide.
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
  for (const n of all) if (n.type === "VariableDeclarator" && n.id.type === "Identifier") add(declared(scopeOf(n)), n.id.name, n.init || { type: "Empty" });
  for (const n of all) {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") add(declared(declareIn(n, n.left.name)), n.left.name, n.right);
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && CONSTANT.test(propName(n.left))) add(constants, propName(n.left), n.right);
    if (n.type === "Property" && !n.computed && n.key && n.key.type === "Identifier" && CONSTANT.test(n.key.name)) add(constants, n.key.name, n.value);
  }
  const isPropertyKey = (n) => n.parent && n.parent.type === "MemberExpression" && n.parent.property === n && !n.parent.computed;
  /** The binding a name or a constant member resolves to: { key, values }, or null. */
  const binding = (n) => {
    if (n.type === "Identifier" && !isPropertyKey(n)) {
      for (let s = scopeOf(n); s; s = scopeOf(s)) {
        const m = scopes.get(s);
        if (m && m.has(n.name)) return { key: m.get(n.name), values: m.get(n.name) };
      }
      if (constants.has(n.name)) return { key: constants.get(n.name), values: constants.get(n.name) };
      return null;
    }
    if (n.type === "MemberExpression" && !n.computed && CONSTANT.test(n.property.name) && constants.has(n.property.name)) return { key: constants.get(n.property.name), values: constants.get(n.property.name) };
    return null;
  };

  /**
   * Whether an expression reads a page's class or id ("class"), a host
   * ("host") or an address ("url"): directly, or through a name that holds
   * such a read. Callbacks are looked into; other functions are not.
   */
  const holds = { class: new Set(), host: new Set(), url: new Set() };
  const held = (n, kind) => { const b = binding(n); return !!b && holds[kind].has(b.key); };
  const reads = (node, kind, intoFns = true) => {
    let hit = false;
    const stack = [node];
    while (stack.length && !hit) {
      const n = stack.pop();
      if (!n || typeof n.type !== "string") continue;
      if (!intoFns && isFn(n)) continue;
      if (n.type === "UnaryExpression" && n.operator === "typeof") continue;
      if (n.type === "CallExpression" && ATTR_CALLS.has(propName(n.callee)) && n.arguments[0] && n.arguments[0].type === "Literal") {
        const a = String(n.arguments[0].value).toLowerCase();
        if (kind === "class" && (a === "class" || a === "id")) hit = true;
        if (kind === "url" && (a === "href" || a === "src" || a === "action")) hit = true;
        continue;
      }
      if (n.type === "MemberExpression") {
        const p = propName(n);
        if (kind === "class" && CLASS_PROPS.has(p)) hit = true;
        // A shadow root's host is an element, not an address's.
        if (kind === "host" && HOST_PROPS.has(p) && !(p === "host" && /getRootNode|shadowRoot|[Rr]oot$/.test(src.slice(n.object.start, n.object.end)))) hit = true;
        if (kind === "url" && (URL_PROPS.has(p) || (n.object.type === "Identifier" && n.object.name === "location"))) hit = true;
      }
      if (n.type === "CallExpression" && kind === "host" && HOST_CALLS.has(n.callee.type === "Identifier" ? n.callee.name : propName(n.callee))) hit = true;
      if ((n.type === "Identifier" && !isPropertyKey(n)) || n.type === "MemberExpression") if (held(n, kind)) hit = true;
      // A function's name is not a value read: addressOrigin(u) is not an origin.
      if (n.type === "Identifier" && !isPropertyKey(n) && !(n.parent && n.parent.type === "CallExpression" && n.parent.callee === n)) {
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
   * Whether a value is itself a class, a host or an address, or is carried
   * over from one: a property read off one, a conversion of one (String(),
   * trim, toLowerCase, a template, a + join), one branch of a condition.
   * What a function of the file returns when handed one is not.
   */
  const carries = (n, kind) => {
    if (!n || typeof n.type !== "string") return false;
    switch (n.type) {
      case "Identifier":
        if (isPropertyKey(n)) return false;
        return held(n, kind) || (kind === "host" && HOST_NAME.test(n.name)) || (kind === "url" && (URL_NAME.test(n.name) || n.name === "location"));
      case "MemberExpression": {
        const p = propName(n);
        if (kind === "class" && CLASS_PROPS.has(p)) return true;
        if (kind === "host" && HOST_PROPS.has(p) && !(p === "host" && /getRootNode|shadowRoot|[Rr]oot$/.test(src.slice(n.object.start, n.object.end)))) return true;
        if (kind === "url" && (URL_PROPS.has(p) || (n.object.type === "Identifier" && n.object.name === "location"))) return true;
        // A part of an address other than its host is not a host: url.pathname, url.protocol.
        if (kind === "host" && /^(pathname|search|hash|protocol|port|href|searchParams|username|password)$/.test(p)) return held(n, kind);
        return held(n, kind) || (!/^(length|size)$/.test(p) && carries(n.object, kind));
      }
      case "CallExpression": {
        const callee = n.callee.type === "Identifier" ? n.callee.name : propName(n.callee);
        if (ATTR_CALLS.has(callee)) {
          const a = n.arguments[0] && n.arguments[0].type === "Literal" ? String(n.arguments[0].value).toLowerCase() : "";
          return (kind === "class" && (a === "class" || a === "id")) || (kind === "url" && (a === "href" || a === "src" || a === "action"));
        }
        if (kind === "host" && HOST_CALLS.has(callee)) return true;
        if (n.callee.type === "Identifier" && /^(String|decodeURIComponent|decodeURI)$/.test(callee)) return carries(n.arguments[0], kind);
        if (n.callee.type === "MemberExpression" && /^(toLowerCase|toUpperCase|trim|trimStart|trimEnd|toString|normalize|replace|replaceAll|slice|substring|split|from)$/.test(callee)) return callee === "from" ? carries(n.arguments[0], kind) : carries(n.callee.object, kind);
        return false;
      }
      // new URL(x) is an address; its host is read off it by name (.hostname).
      case "NewExpression": return n.callee.type === "Identifier" && n.callee.name === "URL" && kind === "url";
      case "ConditionalExpression": return carries(n.consequent, kind) || carries(n.alternate, kind);
      case "LogicalExpression": return carries(n.left, kind) || carries(n.right, kind);
      case "BinaryExpression": return n.operator === "+" && (carries(n.left, kind) || carries(n.right, kind));
      case "TemplateLiteral": return n.expressions.some((e) => carries(e, kind));
      case "AwaitExpression": case "SpreadElement": return carries(n.argument, kind);
      case "ArrayExpression": return n.elements.some((e) => carries(e, kind));
      case "AssignmentExpression": return carries(n.right, kind);
      default: return false;
    }
  };
  /** A side of a comparison reads one: a callback is looked into, any other value must carry one. */
  const side = (n, kind) => (isFn(n) ? reads(n.body, kind) : carries(n, kind));

  // Names that hold what such a read gave: `const cls = String(el.className)`.
  const allBindings = [...[...scopes.values()].flatMap((m) => [...m.values()]), ...constants.values()];
  for (let round = 0, grew = true; grew && round < 6; round++) {
    grew = false;
    for (const values of allBindings) for (const kind of Object.keys(holds)) if (!holds[kind].has(values) && values.some((v) => carries(v, kind))) { holds[kind].add(values); grew = true; }
  }

  /**
   * The literals one side of a comparison holds: the literal itself, or the
   * data a name is bound to (a string, a regex, an array, a Set, an object
   * of them, followed through other names). A literal built into a longer
   * expression (a message, a call's other arguments) is not one.
   */
  const operandLiterals = (node, seenBindings = new Set()) => {
    const out = [];
    const visit = (n) => {
      if (!n) return;
      if (isLiteral(n)) { if (n.type !== "TemplateLiteral" || !n.expressions.length) out.push(n); return; }
      if (n.type === "ArrayExpression") { n.elements.forEach(visit); return; }
      if (n.type === "SpreadElement") { visit(n.argument); return; }
      if (n.type === "ObjectExpression") { for (const p of n.properties) if (p.type === "Property") { visit(p.value); if (!p.computed && p.key.type === "Literal") visit(p.key); } return; }
      if (n.type === "NewExpression" && n.callee.type === "Identifier" && /^(Set|Map|RegExp)$/.test(n.callee.name)) { n.arguments.forEach(visit); return; }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && /^(from|of|concat|join|flat|map)$/.test(propName(n.callee))) { visit(n.callee.object); n.arguments.forEach(visit); return; }
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
    if (n.type === "MemberExpression" && CLASS_PROPS.has(propName(n))) return true;
    if (n.type === "CallExpression" && ATTR_CALLS.has(propName(n.callee)) && n.arguments[0] && /^(class|id)$/i.test(String(n.arguments[0].value))) return true;
    return (n.type === "Identifier" || n.type === "MemberExpression") && held(n, "class");
  };
  const snippet = (n) => src.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 100);
  // Only the extension's own names, or nothing, may be what a page's class is held against.
  const ownOnly = (lits) => lits.every((n) => { const t = String(n.regex ? regexText(n.regex.pattern) : literalText(n)).trim(); return !t || (n.regex ? false : t.split(/\s+/).every((x) => OWN.test(x) || own(x))); });

  // Literals held against a host or an address: parts of an address (".local"), not selectors.
  const addressParts = new Set();
  const judge = (kind, lits) => {
    for (const n of lits) {
      const line = n.loc.start.line;
      const raw = n.regex ? n.regex.pattern : literalText(n);
      if (kind === "class") {
        const tokens = n.regex ? regexText(raw).match(/[A-Za-z_][\w-]*/g) || [] : String(raw).split(/[\s,]+/);
        for (const t of tokens) if (t && t.length > 1 && !OWN.test(t) && !own(t)) report("class or id token", t, line);
        continue;
      }
      addressParts.add(n);
      const text = n.regex ? regexText(raw.replace(/\[(?:\\.|[^\]])*\]/g, " ")) : String(raw);
      for (const w of words(text.replace(HOST_RE, " "))) if (!ADDRESS_WORDS.has(w) && (names.words.has(w) || names.names.has(w))) report("site name", w, line);
      if (kind === "host") {
        // A whole host is reported as one; the words left are bare labels.
        for (const w of words(text.replace(HOST_RE, " "))) {
          if (w.length < 3 || ADDRESS_WORDS.has(w) || SPECIAL.has(w) || TLDS.has(w) || /^[\d-]+$/.test(w)) continue;
          report("host label", w, line);
        }
      }
      if (kind === "url") for (const m of text.matchAll(/(?<![:/\w])\/([a-z][a-z0-9_-]{2,})/gi)) if (!ADDRESS_WORDS.has(m[1].toLowerCase()) && !own(`/${m[1]}`)) report("address path", `/${m[1]}`, line);
    }
  };

  const KINDS = ["class", "host", "url"];
  for (const n of all) {
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const method = propName(n.callee);
      // Selectors handed to the page: by a site's class, id or data attribute.
      if (SELECTOR_CALLS.has(method)) {
        for (const lit of n.arguments.flatMap((a) => operandLiterals(a))) {
          const text = literalText(lit);
          if (method === "getElementById" || method === "getElementsByClassName") { for (const t of String(text).split(/\s+/)) if (t && !OWN.test(t) && !own(t)) report("class or id token", t, lit.loc.start.line); continue; }
          for (const s of selectorNames(text, own)) report("selector", s, lit.loc.start.line);
        }
      }
      // One thing held against another: x.test(y), x.includes(y), SET.has(y), xs.some(cb).
      if (COMPARE.has(method)) {
        const sides = method === "replace" || method === "replaceAll" ? [n.callee.object, n.arguments[0]] : [n.callee.object, ...n.arguments];
        for (const kind of KINDS) {
          const tainted = sides.filter((s) => s && side(s, kind));
          if (!tainted.length) continue;
          const lits = sides.filter((s) => s && !tainted.includes(s)).flatMap((s) => operandLiterals(s));
          judge(kind, lits);
          if (kind === "class" && !ownOnly(lits.length ? lits : [{ regex: { pattern: "?" } }])) report("class test", snippet(n), n.loc.start.line);
        }
      }
    }
    if (n.type === "BinaryExpression" && /^[!=]==?$/.test(n.operator)) {
      for (const kind of KINDS) {
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
          if (!side(a, kind) || side(b, kind)) continue;
          const lits = operandLiterals(b);
          judge(kind, lits);
          if (kind === "class" && !ownOnly(lits.length ? lits : [{ regex: { pattern: "?" } }])) report("class test", snippet(n), n.loc.start.line);
        }
      }
    }
    if (n.type === "SwitchStatement") {
      for (const kind of KINDS) if (carries(n.discriminant, kind)) judge(kind, n.cases.filter((c) => c.test).flatMap((c) => operandLiterals(c.test)));
    }
    // A page's class handed to a function of the file's own, to be read for a meaning.
    if (n.type === "CallExpression" && !BUILTIN_CALLS.has(n.callee.type === "Identifier" ? n.callee.name : propName(n.callee)) && n.arguments.some(isClassValue)) {
      report("class test", snippet(n), n.loc.start.line);
    }
  }

  // A name that says it holds classes or ids: what it holds is class or id tokens.
  for (const m of scopes.values()) for (const [name, values] of m) if (CLASSY_NAME.test(name)) judge("class", values.flatMap((v) => operandLiterals(v)));
  for (const [name, values] of constants) if (CLASSY_NAME.test(name)) judge("class", values.flatMap((v) => operandLiterals(v)));

  // Names in code (a variable, a property, an object's key) that are a site's: { amazon: ..., github: ... }.
  for (const n of all) {
    if (n.type !== "Identifier" && !(n.type === "Literal" && n.parent && n.parent.type === "Property" && n.parent.key === n)) continue;
    const name = n.type === "Identifier" ? n.name : String(n.value);
    for (const w of name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) if (names.names.has(w)) report("site name", w, n.loc.start.line);
  }
  for (const n of literals) if (!n.regex && !fragments.has(n) && !addressParts.has(n)) for (const s of selectorNames(literalText(n), own)) report("selector", s, n.loc.start.line);
  return out.sort((a, b) => a.line - b.line);
}

module.exports = { findings, readNames, selectorNames, parse };
