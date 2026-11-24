"use strict";
// Test-only. Finds what in a JavaScript source could be a rule for one site
// or one page. The source is parsed (acorn), so a literal is found however
// the patch is spelled. What decides a finding is what a literal is held
// against, never what a variable or a function is called.
//
// Findings, each { kind, what, line }:
// - "markup test": a string or regex literal compared with, tested against,
//   searched in, switched on or looked up by a value read through a
//   property named id, name, className, classList, dataset, tagName (or
//   nodeName, localName, htmlFor), or an attribute's value (getAttribute),
//   on any receiver whatever it is called.
// - "address test": the same, for a property named host, hostname, origin,
//   href, pathname, url (or URL, domain, search, hash, pendingUrl, baseURI,
//   documentURI, referrer, searchParams), for the global location, and for
//   new URL().
// - "title test": the same, for a property named title.
//   A value counts as read through such a property when it is the read
//   itself, or is carried over from one: destructuring, a name bound to it,
//   a function parameter it is passed as, an item of it, a Set, Map or
//   array built from it, a conversion or a piece of it, a callback walking
//   it, what a function of the file returns from it.
// - "selector": a name a selector picks by, in a literal passed as, or
//   built into, an argument of querySelector, querySelectorAll, matches,
//   closest, getElementById, getElementsByClassName, getElementsByName,
//   hasAttribute, getAttribute and their kin, or written anywhere as a whole
//   selector. The selector is parsed fully: classes, ids, every attribute
//   by name (and value), custom elements' tags, and everything inside
//   :is(), :not(), :has(), :where() and the like. A dataset read
//   (el.dataset.asin, "asin" in el.dataset) is the data attribute it reads.
//   A form's or an attribute list's lookup by name (form.elements["q"],
//   attributes.getNamedItem("id")) and an XPath given to evaluate() are too.
// - "text test": a literal used in includes, startsWith, endsWith, indexOf,
//   lastIndexOf, match, matchAll, test, exec or search where the other side
//   is not provably the extension's own text (a literal, or a name bound
//   only to literals).
// - "host": a dotted name ending in a real top-level domain (the Public
//   Suffix List), in any literal or comment.
// - "site name": a name from the site-name dictionary
//   (tests/hygiene/site-names.txt), as a word, as two words written apart
//   ("Hacker News"), or as a name in code, in any literal or comment.
// - "class test": a page's class handed to a function of the file to read a
//   meaning from.
// - "unused data": a regex, or a list of strings, that nothing in the file
//   reads, which is either dead or waiting to be used.
// A literal with no letter in it (punctuation, digits, white space) spells
// no name and is never a finding. The extension's own class, id and value
// names count as its own only where its .html and .css files declare them
// (the `own` argument). Every other exception is a scoped allowlist entry.

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
const HTML_TAGS = new Set("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr math".split(" "));

const HOST_RE = /(?<![\w.@-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}))(?![\w-])/gi;
const words = (text) => String(text).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
const flatWords = (text) => String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

/** The text a regex literal's pattern spells, with escapes for punctuation undone and class escapes dropped. */
function regexText(pattern) {
  return pattern.replace(/\\[pP]\{[^}]*\}/g, " ").replace(/\\[bBdDsSwWnrtfv0]/g, " ").replace(/\\(.)/g, "$1");
}

/** A custom element's tag (it has a hyphen), not the extension's own. */
const customTag = (t, own = () => false) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(String(t)) && !own(String(t).toLowerCase());

// Pseudo-classes whose argument is itself a selector list.
const SELECTOR_PSEUDO = /^(?:is|not|has|where|matches|-webkit-any|-moz-any|any|host|host-context|slotted|current|past|future|nth-child|nth-last-child)$/i;

/**
 * A selector list parsed fully, or null when the text is not one. Returns
 * the names it picks by: `tag.class`, `tag#id`, `tag[attr]`,
 * `tag[attr=value]` and custom tags, including those inside pseudo-class
 * arguments. `bareTags` accepts a plain tag list ("ytd-app", "div").
 */
function parseSelector(text, bareTags = false) {
  const s = String(text);
  let i = 0;
  const names = [];
  let marked = false;
  const ident = () => {
    const m = /^-?(?:[A-Za-z_]|\\.|[^\x00-\x7f])(?:[\w-]|\\.|[^\x00-\x7f])*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].replace(/\\(.)/g, "$1");
  };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = () => { throw new Error("not a selector"); };
  const list = (relative) => {
    const out = [];
    for (;;) {
      ws();
      out.push(complex(relative));
      ws();
      if (s[i] !== ",") break;
      i++;
    }
    return out;
  };
  const complex = (relative) => {
    ws();
    if (relative && /[>+~]/.test(s[i])) { i++; ws(); }
    compound();
    for (;;) {
      const at = i;
      ws();
      if (i >= s.length || s[i] === "," || s[i] === ")") { i = at; ws(); return; }
      if (/[>+~]/.test(s[i])) { i++; ws(); compound(); continue; }
      if (i === at) fail();
      compound();
    }
  };
  const compound = () => {
    let tag = "";
    let any = false;
    if (s[i] === "*") { i++; tag = "*"; any = true; }
    else if (/[A-Za-z]/.test(s[i] || "")) {
      tag = ident();
      if (!tag) fail();
      if (!HTML_TAGS.has(tag.toLowerCase()) && !tag.includes("-")) fail();
      if (tag.includes("-")) names.push({ name: tag.toLowerCase(), tag: true });
      any = true;
    }
    const t = tag === "*" ? "" : tag.toLowerCase();
    for (;;) {
      const c = s[i];
      if (c === "." || c === "#") {
        i++;
        const n = ident() || (c === "#" ? (/^[\w-]+/.exec(s.slice(i)) || [""])[0] : "");
        if (!n) fail();
        if (c === "#" && !/^[A-Za-z_-]/.test(n)) i += n.length;
        names.push({ name: `${t}${c}${n}`, value: n, colour: c === "#" && /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(n) });
        marked = true;
        any = true;
        continue;
      }
      if (c === "[") {
        i++;
        ws();
        const attr = ident();
        if (!attr) fail();
        ws();
        let op = "";
        let value = null;
        const m = /^[~^$*|]?=/.exec(s.slice(i));
        if (m) {
          op = m[0];
          i += op.length;
          ws();
          if (s[i] === '"' || s[i] === "'") {
            const q = s[i];
            const end = s.indexOf(q, i + 1);
            if (end < 0) fail();
            value = s.slice(i + 1, end);
            i = end + 1;
          } else {
            value = ident();
            if (value === null) { const d = /^[\w-]+/.exec(s.slice(i)); if (!d) fail(); value = d[0]; i += d[0].length; }
          }
          ws();
          if (/^[is]\b/i.test(s.slice(i)) && s[i + 1] !== "-") { i++; ws(); }
        }
        if (s[i] !== "]") fail();
        i++;
        names.push({ name: value === null ? `${t}[${attr}]` : `${t}[${attr}${op}${value}]`, attr, value });
        marked = true;
        any = true;
        continue;
      }
      if (c === ":") {
        i++;
        const element = s[i] === ":";
        if (element) i++;
        const p = ident();
        if (!p) fail();
        if (s[i] === "(") {
          i++;
          if (!element && SELECTOR_PSEUDO.test(p)) {
            if (/^nth-/i.test(p)) {
              const of = /^[^)]*?\bof\b/i.exec(s.slice(i));
              if (of) { i += of[0].length; list(false); } else { const close = s.indexOf(")", i); if (close < 0) fail(); i = close; }
            } else list(/^has$/i.test(p));
          } else {
            let depth = 1;
            while (i < s.length && depth) { if (s[i] === "(") depth++; else if (s[i] === ")") depth--; if (depth) i++; }
            if (depth) fail();
          }
          ws();
          if (s[i] !== ")") fail();
          i++;
        }
        marked = true;
        any = true;
        continue;
      }
      break;
    }
    if (!any) fail();
  };
  try {
    if (!s.trim() || s.length > 2000) return null;
    list(false);
    ws();
    if (i !== s.length) return null;
  } catch (_e) { return null; }
  if (!marked && !bareTags) return null;
  return names;
}

/** What a selector string picks by a site's own names; [] when it is not a selector. */
function selectorNames(text, own = () => false, bareTags = false, colours = true) {
  const parsed = parseSelector(text, bareTags);
  if (!parsed) return [];
  return parsed.filter((n) => !(colours && n.colour)).map((n) => n.name).filter((n) => !own(n));
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
const childrenOf = (x) => {
  const out = [];
  for (const k of Object.keys(x)) { if (k === "parent" || k === "loc") continue; const c = x[k]; if (Array.isArray(c)) out.push(...c); else if (c && typeof c.type === "string") out.push(c); }
  return out;
};

const isFn = (n) => n && /Function/.test(n.type);
const propName = (m) => (m && m.type === "MemberExpression" ? (m.computed ? (m.property.type === "Literal" ? String(m.property.value) : "") : m.property.name) : "");
const calleeName = (n) => (n.callee.type === "Identifier" ? n.callee.name : propName(n.callee));
const isLiteral = (n) => n && ((n.type === "Literal" && (typeof n.value === "string" || n.regex)) || n.type === "TemplateLiteral");
const literalText = (n) => (n.type === "TemplateLiteral" ? n.quasis.map((q) => q.value.cooked || "").join(" ") : n.regex ? regexText(n.regex.pattern) : n.value);
/** How a literal is written down in a finding: a string as itself, a regex as /pattern/flags. */
const shown = (n) => (n.regex ? `/${n.regex.pattern}/${n.regex.flags}` : n.type === "TemplateLiteral" ? n.quasis.map((q) => q.value.cooked || "").join("${}") : String(n.value));
/** A literal with no letter in it spells no name. */
const spellsNothing = (n) => {
  const t = n.regex ? regexText(n.regex.pattern.replace(/\[(?:\\.|[^\]\\])*\]/g, (c) => (/^\[[^\]\\-]\]$/.test(c) ? c.slice(1, -1) : " "))) : String(literalText(n)).replace(/\\[pP]\{[^}]*\}/g, " ");
  return !/\p{L}/u.test(t);
};

// What is compared, by the property it is read through, on any receiver.
const PROPS = {
  markup: new Set(["id", "name", "className", "classList", "dataset", "tagName", "nodeName", "localName", "htmlFor"]),
  address: new Set(["host", "hostname", "origin", "href", "pathname", "url", "URL", "domain", "search", "hash", "pendingUrl", "baseURI", "documentURI", "referrer", "searchParams"]),
  title: new Set(["title"]),
};
const KIND_NAME = { markup: "markup test", address: "address test", title: "title test" };
const KINDS = Object.keys(PROPS);
// Calls that hand back what a host is.
const HOST_CALLS = new Set(["siteOf", "hostOf", "registrable", "registrableDomain"]);
// Ways one value is held against another.
const COMPARE = new Set(["test", "exec", "match", "matchAll", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "has", "search", "contains", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "filter", "replace", "replaceAll", "localeCompare", "get", "hasOwnProperty"]);
// The ones that search one text in another, for "text test".
const TEXT_SEARCH = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "match", "matchAll", "test", "exec", "search"]);
// Calls that walk a list and hand each item to a callback.
const ITERATE = new Set(["forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "filter", "map", "flatMap", "reduce", "sort"]);
// Calls handed a selector, an id, a class or a name.
const SELECTOR_CALLS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "webkitMatchesSelector", "msMatchesSelector"]);
const NAME_CALLS = new Set(["getElementById", "getElementsByClassName", "getElementsByName"]);
const ATTR_CALLS = new Set(["getAttribute", "hasAttribute", "getAttributeNode", "toggleAttribute", "getAttributeNS", "hasAttributeNS", "getNamedItem", "namedItem"]);
// Calls that carry a value over: a conversion, a piece, a list built from it.
const CARRY_METHODS = /^(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|trim|trimStart|trimEnd|toString|valueOf|normalize|replace|replaceAll|slice|substring|substr|split|at|item|get|getAll|keys|values|entries|join|concat|flat|filter|find|findLast|reverse|toSorted|toReversed|match|matchAll|padStart|padEnd|charAt|forEach)$/;
const CARRY_FUNCS = /^(String|decodeURIComponent|decodeURI|encodeURIComponent|encodeURI|escape|unescape)$/;
const STATIC_CARRY = /^(from|of|keys|values|entries|fromEntries|assign|freeze)$/;
// Calls that only convert or take apart a value: not a function reading it for a meaning.
const BUILTIN_CALLS = new Set(["String", "Number", "Boolean", "Array", "from", "trim", "toLowerCase", "toUpperCase", "split", "slice", "replace", "replaceAll", "concat", "join", "push", "add", "set", "get", "has", "delete", "includes", "test", "match", "matchAll", "exec", "startsWith", "endsWith", "indexOf", "contains", "some", "every", "filter", "map", "find", "toggle", "remove", "item", "forEach", "log", "warn", "error", "stringify", "assign", "keys", "values", "entries", "max", "min", "trimStart", "trimEnd", "padStart", "substring", "substr", "charAt", "at", "search"]);

/**
 * Findings for one source: [{ kind, what, line }]. `names` is the
 * dictionary from readNames, with any extra names joined in; `own` says
 * whether a name is one the extension's own pages and styles declare.
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

  // What each name is bound to, in the function that declares it (blocks
  // are not told apart, which can only find more). A constant reached
  // through an object (TOOLS.SKIP, { SKIP: [...] }) is bound by its name
  // file-wide. Destructured names are bound to the read they stand for,
  // loop variables to what they loop over, a callback's parameters to the
  // list it is called on, and a function's parameters to every value the
  // file calls it with.
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
  const readOf = (from, key, at) => ({ type: key ? "MemberExpression" : "ItemOf", object: from, property: key ? { type: "Identifier", name: key } : null, computed: false, start: at.start, end: at.end, loc: at.loc, parent: at.parent, synthetic: true });
  const UNKNOWN = { type: "Unknown" };
  const bindPattern = (scope, pattern, value) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") { add(declared(scope), pattern.name, value); return; }
    if (pattern.type === "AssignmentPattern") { bindPattern(scope, pattern.left, value); add(declared(scope), pattern.left.type === "Identifier" ? pattern.left.name : "", pattern.right); return; }
    if (pattern.type === "RestElement") { bindPattern(scope, pattern.argument, value); return; }
    if (pattern.type === "ObjectPattern") {
      for (const p of pattern.properties) {
        if (p.type === "RestElement") { bindPattern(scope, p.argument, value); continue; }
        const key = !p.computed && p.key ? (p.key.name || String(p.key.value)) : "";
        bindPattern(scope, p.value, key ? readOf(value, key, p) : value);
      }
      return;
    }
    if (pattern.type === "ArrayPattern") { for (const e of pattern.elements) bindPattern(scope, e, readOf(value, null, pattern)); }
  };
  const functionsNamed = new Map();
  const nameOfFn = (n) => (n.id ? n.id.name : n.parent && n.parent.type === "VariableDeclarator" && n.parent.id.type === "Identifier" ? n.parent.id.name : n.parent && n.parent.type === "AssignmentExpression" && n.parent.left.type === "Identifier" ? n.parent.left.name : n.parent && n.parent.type === "Property" && !n.parent.computed && n.parent.key.type === "Identifier" ? n.parent.key.name : "");
  for (const n of all) if (isFn(n)) { const name = nameOfFn(n); if (name) { if (!functionsNamed.has(name)) functionsNamed.set(name, []); functionsNamed.get(name).push(n); } }
  for (const n of all) {
    if (n.type === "VariableDeclarator") {
      if (n.id.type === "Identifier") add(declared(scopeOf(n)), n.id.name, n.init || { type: "Empty" });
      else if (n.init) bindPattern(scopeOf(n), n.id, n.init);
    }
    // Every parameter is a name of its function; a destructured one stands for the reads it makes.
    if (isFn(n)) for (const p of n.params) bindPattern(n, p.type === "RestElement" ? p.argument : p, UNKNOWN);
    if (n.type === "FunctionDeclaration" && n.id) add(declared(scopeOf(n)), n.id.name, UNKNOWN);
    if (n.type === "CatchClause" && n.param) bindPattern(scopeOf(n), n.param, UNKNOWN);
    if (n.type === "ClassDeclaration" && n.id) add(declared(scopeOf(n)), n.id.name, UNKNOWN);
    // for (const c of el.classList): c is one item of el.classList.
    if ((n.type === "ForOfStatement" || n.type === "ForInStatement") && n.left) {
      const target = n.left.type === "VariableDeclaration" ? n.left.declarations[0].id : n.left;
      const scope = scopeOf(n.body) || scopeOf(n);
      bindPattern(scope, target, n.type === "ForOfStatement" ? readOf(n.right, null, n.right) : { type: "KeyOf", object: n.right });
    }
    // el.classList.forEach((c) => ...): c is one item of el.classList.
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && ITERATE.has(propName(n.callee))) {
      const fn = n.arguments[0];
      if (isFn(fn) && fn.params.length) {
        const method = propName(n.callee);
        const at = method === "reduce" ? 1 : 0;
        if (fn.params[at]) bindPattern(fn, fn.params[at], readOf(n.callee.object, null, n.callee.object));
        if (method === "sort" && fn.params[1]) bindPattern(fn, fn.params[1], readOf(n.callee.object, null, n.callee.object));
      }
    }
    // A function of the file called with a value: its parameter holds that value.
    if ((n.type === "CallExpression" || n.type === "NewExpression") && n.callee.type === "Identifier" && functionsNamed.has(n.callee.name)) {
      for (const fn of functionsNamed.get(n.callee.name)) fn.params.forEach((p, i) => { if (n.arguments[i]) bindPattern(fn, p.type === "RestElement" ? p.argument : p, n.arguments[i].type === "SpreadElement" ? readOf(n.arguments[i].argument, null, n.arguments[i]) : n.arguments[i]); });
    }
    // An immediately called function, or a callback handed straight to a call: same.
    if (n.type === "CallExpression" && isFn(n.callee)) n.callee.params.forEach((p, i) => { if (n.arguments[i]) bindPattern(n.callee, p, n.arguments[i]); });
  }
  for (const n of all) {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") add(declared(declareIn(n, n.left.name)), n.left.name, n.right);
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && CONSTANT.test(propName(n.left))) add(constants, propName(n.left), n.right);
    if (n.type === "Property" && !n.computed && n.key && n.key.type === "Identifier" && CONSTANT.test(n.key.name)) add(constants, n.key.name, n.value);
  }
  const isPropertyKey = (n) => n.parent && n.parent.type === "MemberExpression" && n.parent.property === n && !n.parent.computed;
  const isObjectKey = (n) => n.parent && n.parent.type === "Property" && n.parent.key === n && !n.parent.computed && !n.parent.shorthand;
  const isFnParam = (n) => n.parent && isFn(n.parent) && n.parent.params.includes(n);
  /** The binding a name or a constant member resolves to: { key, values }, or null. */
  const binding = (n) => {
    if (n.type === "Identifier" && !isPropertyKey(n)) {
      for (let s = scopeOf(n); s; s = scopeOf(s)) {
        const m = scopes.get(s);
        if (m && m.has(n.name)) return { key: m.get(n.name), values: m.get(n.name) };
      }
      // A function's own parameter: its scope is the function itself.
      for (let p = n.parent; p; p = p.parent) if (isFn(p) && scopes.has(p) && scopes.get(p).has(n.name)) return { key: scopes.get(p).get(n.name), values: scopes.get(p).get(n.name) };
      if (constants.has(n.name)) return { key: constants.get(n.name), values: constants.get(n.name) };
      return null;
    }
    if (n.type === "MemberExpression" && !n.computed && CONSTANT.test(n.property.name) && constants.has(n.property.name)) return { key: constants.get(n.property.name), values: constants.get(n.property.name) };
    return null;
  };
  /** Whether a name is bound in the file (a global such as `location` is not). */
  const bound = (n) => !!binding(n) || [...functionsNamed.keys()].includes(n.name);

  const holds = { markup: new Set(), address: new Set(), title: new Set() };
  const held = (n, kind) => { const b = binding(n); return !!b && holds[kind].has(b.key); };
  const ADDRESS_ATTR = /^(href|src|action|formaction|srcset|cite|data|poster|ping)$/i;
  const attrIsAddress = (n) => n.arguments[0] && n.arguments[0].type === "Literal" && ADDRESS_ATTR.test(String(n.arguments[0].value));
  /**
   * Whether a value is read through one of the kind's properties, or is
   * carried over from such a read.
   */
  const carries = (n, kind, depth = 0) => {
    if (!n || typeof n.type !== "string" || depth > 30) return false;
    const deeper = (x) => carries(x, kind, depth + 1);
    switch (n.type) {
      case "Identifier":
        if (isPropertyKey(n)) return false;
        if (held(n, kind)) return true;
        // The page's own address, as a global.
        return kind === "address" && n.name === "location" && !binding(n);
      case "ItemOf": case "KeyOf": return deeper(n.object);
      case "MemberExpression": {
        if (PROPS[kind].has(propName(n)) && !(n.computed && n.property.type !== "Literal")) return true;
        if (held(n, kind)) return true;
        // An item of such a value, or its value itself (attr.value, classList.value), carries it on.
        if (n.computed || /^(value|nodeValue|baseVal|animVal|input|groups)$/.test(propName(n))) return deeper(n.object);
        return false;
      }
      case "CallExpression": {
        const callee = calleeName(n);
        if (n.callee.type === "MemberExpression" && ATTR_CALLS.has(callee) && /^get/.test(callee)) return kind === "address" ? attrIsAddress(n) : kind === "markup" && !attrIsAddress(n);
        if (kind === "address" && HOST_CALLS.has(callee)) return true;
        if (n.callee.type === "Identifier" && CARRY_FUNCS.test(callee)) return deeper(n.arguments[0]);
        if (n.callee.type === "MemberExpression" && n.callee.object.type === "Identifier" && /^(Object|Array|JSON|Reflect)$/.test(n.callee.object.name) && STATIC_CARRY.test(callee)) return n.arguments.some(deeper);
        if (n.callee.type === "MemberExpression" && callee === "exec") return deeper(n.arguments[0]);
        if (n.callee.type === "MemberExpression" && CARRY_METHODS.test(callee)) return deeper(n.callee.object);
        if (n.callee.type === "MemberExpression" && /^(map|flatMap)$/.test(callee)) return isFn(n.arguments[0]) ? returns(n.arguments[0], kind, depth) : deeper(n.callee.object);
        // CSS.escape(x), x.toString(): the value itself.
        if (n.callee.type === "MemberExpression" && /^(escape)$/.test(callee)) return deeper(n.arguments[0]);
        // A function of the file that hands back such a value.
        if (n.callee.type === "Identifier" && functionsNamed.has(callee)) return functionsNamed.get(callee).some((fn) => returns(fn, kind, depth));
        if (isFn(n.callee)) return returns(n.callee, kind, depth);
        return false;
      }
      case "NewExpression": {
        const c = n.callee.type === "Identifier" ? n.callee.name : "";
        if (kind === "address" && /^(URL|URLSearchParams)$/.test(c)) return true;
        if (/^(Set|Map|WeakSet|WeakMap|Array|String)$/.test(c)) return n.arguments.some(deeper);
        return false;
      }
      case "ConditionalExpression": return deeper(n.consequent) || deeper(n.alternate);
      case "LogicalExpression": return deeper(n.left) || deeper(n.right);
      case "BinaryExpression": return n.operator === "+" && (deeper(n.left) || deeper(n.right));
      case "TemplateLiteral": return n.expressions.some(deeper);
      case "TaggedTemplateExpression": return deeper(n.quasi);
      case "AwaitExpression": case "SpreadElement": case "ChainExpression": case "ParenthesizedExpression": return deeper(n.argument || n.expression);
      case "ArrayExpression": return n.elements.some(deeper);
      case "ObjectExpression": return n.properties.some((p) => (p.type === "SpreadElement" ? deeper(p.argument) : false));
      case "AssignmentExpression": return deeper(n.right);
      case "SequenceExpression": return deeper(n.expressions[n.expressions.length - 1]);
      default: return false;
    }
  };
  const returning = new Map();
  /** Whether a function returns a value carrying the kind. */
  const returns = (fn, kind, depth = 0) => {
    const key = fn;
    if (!returning.has(key)) returning.set(key, {});
    const memo = returning.get(key);
    if (kind in memo) return memo[kind];
    memo[kind] = false;
    let found = false;
    if (fn.body.type !== "BlockStatement") found = carries(fn.body, kind, depth + 1);
    else {
      const stack = [fn.body];
      while (stack.length && !found) {
        const x = stack.pop();
        if (!x || typeof x.type !== "string" || (isFn(x) && x !== fn)) continue;
        if (x.type === "ReturnStatement" && x.argument && carries(x.argument, kind, depth + 1)) found = true;
        stack.push(...childrenOf(x));
      }
    }
    memo[kind] = found;
    return found;
  };
  /** Whether a callback reads the kind anywhere in its body, or another value carries it. */
  const reads = (node, kind) => {
    const stack = [node];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x.type !== "string") continue;
      if (x.type === "UnaryExpression" && x.operator === "typeof") continue;
      if ((x.type === "MemberExpression" || x.type === "Identifier" || x.type === "CallExpression" || x.type === "NewExpression") && carries(x, kind)) return true;
      stack.push(...childrenOf(x));
    }
    return false;
  };
  const side = (n, kind) => (isFn(n) ? reads(n.body, kind) : carries(n, kind));

  // Names that hold what such a read gave: `const cls = String(el.className)`.
  const allBindings = [...[...scopes.values()].flatMap((m) => [...m.values()]), ...constants.values()];
  for (let round = 0, grew = true; grew && round < 12; round++) {
    grew = false;
    returning.clear();
    for (const values of allBindings) for (const kind of KINDS) if (!holds[kind].has(values) && values.some((v) => carries(v, kind))) { holds[kind].add(values); grew = true; }
  }
  returning.clear();

  /**
   * The literals one side of a comparison holds: the literal itself, or the
   * data a name is bound to (a string, a regex, an array, a Set, a Map or
   * an object of them, followed through other names), and the literals a
   * value is built from. `keys` takes an object's keys too.
   */
  const operandLiterals = (node, keys = false, seenBindings = new Set()) => {
    const lits = [];
    const visit = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (isLiteral(n)) { if (n.type !== "TemplateLiteral" || !n.expressions.length) lits.push(n); else { lits.push(...n.quasis.filter((q) => (q.value.cooked || "").trim()).map((q) => ({ type: "Literal", value: q.value.cooked, loc: q.loc, start: q.start, end: q.end }))); n.expressions.forEach(visit); } return; }
      if (n.type === "ArrayExpression") { n.elements.forEach(visit); return; }
      if (n.type === "SpreadElement" || n.type === "ChainExpression" || n.type === "AwaitExpression") { visit(n.argument || n.expression); return; }
      if (n.type === "ItemOf" || n.type === "KeyOf") { visit(n.object); return; }
      if (n.type === "ObjectExpression") { for (const p of n.properties) if (p.type === "Property") { visit(p.value); if (!p.computed && p.key.type === "Literal") visit(p.key); if (keys && !p.computed && p.key.type === "Identifier") lits.push({ type: "Literal", value: p.key.name, loc: p.key.loc, start: p.key.start, end: p.key.end }); } return; }
      if (n.type === "NewExpression" && n.callee.type === "Identifier" && /^(Set|Map|String)$/.test(n.callee.name)) { n.arguments.forEach(visit); return; }
      // A regex built at run time: its pattern, not its flags.
      if ((n.type === "NewExpression" || n.type === "CallExpression") && n.callee.type === "Identifier" && n.callee.name === "RegExp") { visit(n.arguments[0]); return; }
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "String") { n.arguments.forEach(visit); return; }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && /^(from|of|concat|join|flat|map|flatMap|toLowerCase|toUpperCase|trim|split|escape|fromEntries|keys|values|entries|freeze|filter|slice|replace|replaceAll)$/.test(propName(n.callee))) { visit(n.callee.object); n.arguments.forEach(visit); return; }
      if (n.type === "ConditionalExpression" || n.type === "LogicalExpression") { visit(n.consequent || n.left); visit(n.alternate || n.right); return; }
      if (n.type === "BinaryExpression" && n.operator === "+") { visit(n.left); visit(n.right); return; }
      if (n.type === "MemberExpression" && n.computed && n.property.type === "Literal") { visit(n.object); return; }
      if (n.type === "MemberExpression" && !n.computed && !binding(n)) { const b = binding(n.object); if (b && !seenBindings.has(b.key)) { seenBindings.add(b.key); for (const v of b.values) if (v.type === "ObjectExpression") for (const p of v.properties) if (p.type === "Property" && !p.computed && (p.key.name || p.key.value) === n.property.name) visit(p.value); } return; }
      // A callback brings the data it holds the item against: SKIP in (c) => SKIP.has(c).
      if (isFn(n)) {
        const inner = [n.body];
        while (inner.length) {
          const x = inner.pop();
          if (!x || typeof x.type !== "string" || isFn(x)) continue;
          if (x.type === "CallExpression" && x.callee.type === "MemberExpression" && COMPARE.has(propName(x.callee))) { visit(x.callee.object); x.arguments.forEach(visit); }
          if (x.type === "BinaryExpression" && /^[!=]==?$/.test(x.operator)) { visit(x.left); visit(x.right); }
          inner.push(...childrenOf(x));
        }
        return;
      }
      const b = binding(n);
      if (b && !seenBindings.has(b.key)) { seenBindings.add(b.key); b.values.forEach(visit); }
    };
    visit(node);
    return lits;
  };

  /** The keys a lookup table holds: an object's keys, a Map's first items, a Set's or a list's items. */
  const keyLiterals = (node, seenB = new Set()) => {
    const lits = [];
    const visit = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "ObjectExpression") {
        for (const p of n.properties) {
          if (p.type === "SpreadElement") { visit(p.argument); continue; }
          if (p.computed) { lits.push(...operandLiterals(p.key)); continue; }
          lits.push(p.key.type === "Literal" ? p.key : { type: "Literal", value: p.key.name, loc: p.key.loc, start: p.key.start, end: p.key.end });
        }
        return;
      }
      if (n.type === "ArrayExpression") { for (const e of n.elements) if (e) { if (e.type === "ArrayExpression") { if (e.elements[0]) lits.push(...operandLiterals(e.elements[0])); } else if (e.type === "SpreadElement") visit(e.argument); else lits.push(...operandLiterals(e)); } return; }
      if (n.type === "NewExpression" && n.callee.type === "Identifier" && /^(Set|Map|WeakSet|WeakMap)$/.test(n.callee.name)) { visit(n.arguments[0]); return; }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && /^(freeze|fromEntries|assign|from)$/.test(propName(n.callee))) { n.arguments.forEach(visit); return; }
      if (n.type === "ConditionalExpression" || n.type === "LogicalExpression") { visit(n.consequent || n.left); visit(n.alternate || n.right); return; }
      if (isLiteral(n)) { lits.push(...operandLiterals(n)); return; }
      const b = binding(n);
      if (b && !seenB.has(b.key)) { seenB.add(b.key); b.values.forEach(visit); }
    };
    visit(node);
    return lits;
  };

  /** Whether a value is provably the extension's own text: a literal, or built only from literals. */
  const ownTextValue = (n, depth = 0, seenB = new Set()) => {
    if (!n || depth > 20) return false;
    if (isLiteral(n)) return n.type !== "TemplateLiteral" || n.expressions.every((e) => ownTextValue(e, depth + 1, seenB));
    if (n.type === "Literal") return true;
    if (n.type === "ArrayExpression") return n.elements.every((e) => e && ownTextValue(e, depth + 1, seenB));
    if (n.type === "BinaryExpression" && n.operator === "+") return ownTextValue(n.left, depth + 1, seenB) && ownTextValue(n.right, depth + 1, seenB);
    if (n.type === "ConditionalExpression") return ownTextValue(n.consequent, depth + 1, seenB) && ownTextValue(n.alternate, depth + 1, seenB);
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && /^(toLowerCase|toUpperCase|trim|join|slice)$/.test(propName(n.callee))) return ownTextValue(n.callee.object, depth + 1, seenB);
    if (n.type === "Identifier" || n.type === "MemberExpression") {
      const b = binding(n);
      if (!b || seenB.has(b.key)) return false;
      seenB.add(b.key);
      return b.values.length > 0 && b.values.every((v) => ownTextValue(v, depth + 1, seenB));
    }
    return false;
  };

  /** Whether an expression is a page's class itself (not something worked out from it). */
  const isClassValue = (a, seenB = new Set()) => {
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
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && ATTR_CALLS.has(propName(n.callee)) && n.arguments[0] && /^(class|id)$/i.test(String(n.arguments[0].value))) return true;
    if (n.type === "Identifier" || n.type === "MemberExpression") {
      const b = binding(n);
      if (!b || seenB.has(b.key)) return false;
      seenB.add(b.key);
      return b.values.some((v) => v !== n && v.type !== "Unknown" && isClassValue(v, seenB));
    }
    return false;
  };
  const snippet = (n) => src.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 100);
  // The extension's own name, or nothing at all, is not a site's.
  const ownToken = (t) => { const s = String(t).trim(); return !s || s.split(/[\s,]+/).every((x) => !x || own(x)); };

  // Literals held against an address: parts of an address, not selectors.
  const addressParts = new Set();
  const judged = new Set();
  const judge = (kind, lits) => {
    for (const n of lits) {
      judged.add(n);
      if (spellsNothing(n)) continue;
      if (kind === "markup" && !n.regex && ownToken(literalText(n))) continue;
      if (kind === "address") addressParts.add(n);
      report(KIND_NAME[kind], shown(n), n.loc.start.line);
    }
  };
  // Data a page's value is held against that the file never shows: a name
  // bound nowhere in it (SKIP.test(cls), with SKIP from another script).
  const GLOBALS = /^(document|window|self|globalThis|location|navigator|chrome|console|undefined|NaN|Infinity|Set|Map|WeakSet|WeakMap|URL|URLSearchParams|RegExp|String|Object|Array|Number|Boolean|JSON|Math|CSS|Reflect|Symbol|Promise|Date|Error|Node|Element|HTMLElement|SVGElement|Intl|crypto|performance|history|screen|module|require|exports)$/;
  const rootName = (x) => { let r = x; while (r && (r.type === "MemberExpression" || r.type === "ChainExpression")) r = r.type === "ChainExpression" ? r.expression : r.object; return r && r.type === "Identifier" ? r : null; };
  const unseen = (sides, at) => {
    for (const x of sides) {
      if (!x || isFn(x) || !(x.type === "Identifier" || x.type === "MemberExpression")) continue;
      const r = rootName(x);
      if (!r || GLOBALS.test(r.name) || binding(r) || functionsNamed.has(r.name) || (x.type === "MemberExpression" && binding(x))) continue;
      report("unseen data", snippet(at), at.loc.start.line);
    }
  };
  const selectorFinding = (name, line) => { if (name && !own(name)) report("selector", name, line); };
  /** A literal handed to a selector call: every name it picks by, or, as a piece of a built one, its bare name. */
  const selectorLiteral = (lit, built, bareTags) => {
    judged.add(lit);
    const text = String(literalText(lit));
    const parsed = parseSelector(text, bareTags);
    if (parsed) { for (const p of parsed) selectorFinding(p.name, lit.loc.start.line); return; }
    if (built || !parsed) for (const piece of text.split(/[\s,>+~()[\]="'^$*|:]+/)) {
      const bare = piece.replace(/^[.#]/, "");
      if (/\p{L}/u.test(bare) && !HTML_TAGS.has(bare.toLowerCase()) && !own(bare) && !own(piece)) selectorFinding(piece, lit.loc.start.line);
    }
  };
  const kebab = (s) => `data-${String(s).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const isDataset = (n) => n && n.type === "MemberExpression" && propName(n) === "dataset";

  for (const n of all) {
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const method = propName(n.callee);
      // Selectors, ids, classes and attribute names handed to the page.
      if (SELECTOR_CALLS.has(method)) {
        for (const a of n.arguments) {
          const built = !(a.type === "Literal" || (a.type === "TemplateLiteral" && !a.expressions.length));
          for (const lit of operandLiterals(a)) if (!lit.regex) selectorLiteral(lit, built, true);
        }
      }
      if (NAME_CALLS.has(method)) for (const a of n.arguments) for (const lit of operandLiterals(a)) { judged.add(lit); if (!lit.regex) for (const t of String(literalText(lit)).split(/\s+/)) if (t && /\p{L}/u.test(t) && !own(t)) selectorFinding(method === "getElementById" ? `#${t}` : method === "getElementsByClassName" ? `.${t}` : `[name=${t}]`, lit.loc.start.line); }
      if (method === "getElementsByTagName") for (const a of n.arguments) for (const lit of operandLiterals(a)) { judged.add(lit); if (customTag(literalText(lit), own)) selectorFinding(String(literalText(lit)).toLowerCase(), lit.loc.start.line); }
      if (ATTR_CALLS.has(method) && n.arguments[0]) {
        const a = method.endsWith("NS") ? n.arguments[1] : n.arguments[0];
        for (const lit of operandLiterals(a)) { judged.add(lit); if (!lit.regex && /\p{L}/u.test(String(literalText(lit))) && !own(String(literalText(lit)))) selectorFinding(method === "namedItem" ? `[name=${literalText(lit)}]` : `[${literalText(lit)}]`, lit.loc.start.line); }
      }
      // An XPath handed to the page.
      if (method === "evaluate" && n.arguments[0]) for (const lit of operandLiterals(n.arguments[0])) { judged.add(lit); for (const m of String(literalText(lit)).matchAll(/@([\w-]+)\s*(?:=\s*["']([^"']*)["'])?|contains\(\s*@([\w-]+)\s*,\s*["']([^"']*)["']/g)) selectorFinding(`[${m[1] || m[3]}${m[2] || m[4] ? `=${m[2] || m[4]}` : ""}]`, lit.loc.start.line); }
      // One thing held against another: x.test(y), x.includes(y), SET.has(y), MAP.get(y), xs.some(cb).
      if (COMPARE.has(method)) {
        const sides = method === "replace" || method === "replaceAll" ? [n.callee.object, n.arguments[0]] : [n.callee.object, ...n.arguments];
        // A callback is a comparison only where it judges each item.
        const judging = /^(some|every|find|findIndex|findLast|findLastIndex|filter)$/.test(method);
        const keyed = /^(has|get|hasOwnProperty)$/.test(method);
        for (const kind of KINDS) {
          if (keyed) {
            if (n.arguments[0] && !isFn(n.arguments[0]) && carries(n.arguments[0], kind) && !carries(n.callee.object, kind)) { judge(kind, keyLiterals(n.callee.object)); unseen([n.callee.object], n); }
            else if (carries(n.callee.object, kind) && n.arguments[0] && !isFn(n.arguments[0])) judge(kind, operandLiterals(n.arguments[0]));
            continue;
          }
          const tainted = sides.filter((s) => s && (isFn(s) ? judging && side(s, kind) : carries(s, kind)));
          if (!tainted.length) continue;
          const others = sides.filter((s) => s && !tainted.includes(s) && (!isFn(s) || judging));
          judge(kind, others.flatMap((s) => operandLiterals(s)));
          unseen(others, n);
          // A callback's body holding the item against data: (c) => SKIP.has(c).
          for (const fn of sides.filter((s) => isFn(s) && judging)) {
            const stack = [fn.body];
            while (stack.length) { const x = stack.pop(); if (!x || typeof x.type !== "string" || isFn(x)) continue; if (x.type === "CallExpression" && x.callee.type === "MemberExpression" && COMPARE.has(propName(x.callee))) unseen([x.callee.object, ...x.arguments].filter((y) => !carries(y, kind)), n); stack.push(...childrenOf(x)); }
          }
        }
      }
      // Object.hasOwn(T, x), Reflect.has(T, x).
      if (/^(hasOwn|has)$/.test(method) && n.callee.object.type === "Identifier" && /^(Object|Reflect)$/.test(n.callee.object.name) && n.arguments.length === 2) {
        for (const kind of KINDS) if (carries(n.arguments[1], kind)) judge(kind, keyLiterals(n.arguments[0]));
        for (const kind of KINDS) if (carries(n.arguments[0], kind)) judge(kind, operandLiterals(n.arguments[1]));
      }
    }
    if (n.type === "BinaryExpression" && /^[!=]==?$/.test(n.operator)) {
      for (const kind of KINDS) {
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
          if (!side(a, kind) || side(b, kind)) continue;
          judge(kind, operandLiterals(b));
          unseen([b], n);
        }
      }
    }
    if (n.type === "MemberExpression" && n.computed) {
      // M[c] with c such a value: the keys of M are what it is held against.
      if (n.property.type !== "Literal") for (const kind of KINDS) if (carries(n.property, kind) && !carries(n.object, kind)) judge(kind, keyLiterals(n.object));
      // byId["main"], attrs["data-x"], form.elements["q"]: a lookup by a literal in such a value.
      if (n.property.type === "Literal" && typeof n.property.value === "string") {
        if (/^(attributes|elements|all|forms|images|links|anchors|embeds|plugins|scripts)$/.test(propName(n.object)) && /\p{L}/u.test(n.property.value) && !own(n.property.value)) { judged.add(n.property); selectorFinding(propName(n.object) === "attributes" ? `[${n.property.value}]` : `[name=${n.property.value}]`, n.loc.start.line); }
        for (const kind of KINDS) if (carries(n.object, kind) && !PROPS[kind].has(n.property.value)) judge(kind, [n.property]);
      }
    }
    // A dataset read is the data attribute it reads.
    if (n.type === "MemberExpression" && isDataset(n.object) && !(n.parent && n.parent.type === "AssignmentExpression" && n.parent.left === n)) {
      const key = n.computed ? (n.property.type === "Literal" ? String(n.property.value) : "") : n.property.name;
      if (key) { if (n.computed) judged.add(n.property); selectorFinding(kebab(key), n.loc.start.line); }
      else for (const lit of operandLiterals(n.property)) { judged.add(lit); selectorFinding(kebab(literalText(lit)), lit.loc.start.line); }
    }
    if (n.type === "VariableDeclarator" && n.id.type === "ObjectPattern" && isDataset(n.init)) for (const p of n.id.properties) if (p.type === "Property" && !p.computed) selectorFinding(kebab(p.key.name || p.key.value), p.loc.start.line);
    // "navbox" in M, with the page's value on the left; "asin" in el.dataset.
    if (n.type === "BinaryExpression" && n.operator === "in") {
      for (const kind of KINDS) if (carries(n.left, kind)) judge(kind, keyLiterals(n.right));
      if (isDataset(n.right)) for (const lit of operandLiterals(n.left)) { judged.add(lit); selectorFinding(kebab(literalText(lit)), lit.loc.start.line); }
      else for (const kind of KINDS) if (carries(n.right, kind)) judge(kind, operandLiterals(n.left));
    }
    if (n.type === "SwitchStatement") {
      for (const kind of KINDS) if (carries(n.discriminant, kind)) judge(kind, n.cases.filter((c) => c.test).flatMap((c) => operandLiterals(c.test)));
    }
    // A page's class handed to a function of the file's own, to be read for a meaning.
    if (n.type === "CallExpression" && !BUILTIN_CALLS.has(calleeName(n)) && n.arguments.some((a) => isClassValue(a))) {
      report("class test", snippet(n), n.loc.start.line);
    }
  }

  // A literal searched for in, or searching, a text that is not provably the extension's own.
  const searched = new Set();
  for (const n of all) {
    if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || !TEXT_SEARCH.has(propName(n.callee))) continue;
    const pairs = [[n.callee.object, n.arguments[0]], [n.arguments[0], n.callee.object]];
    for (const [litSide, other] of pairs) {
      if (!litSide || !other) continue;
      const lits = operandLiterals(litSide).filter((l) => !judged.has(l));
      if (!lits.length || ownTextValue(other)) continue;
      for (const l of lits) { searched.add(l); if (!spellsNothing(l)) report("text test", shown(l), l.loc.start.line); }
    }
  }

  // A regex, or a list of strings, that nothing reads: dead data, or a rule waiting to be used.
  const referenced = new Set();
  for (const n of all) if (n.type === "Identifier" && !(n.parent && n.parent.type === "VariableDeclarator" && n.parent.id === n) && !isPropertyKey(n) && !isObjectKey(n)) referenced.add(n.name);
  for (const n of all) {
    if (n.type !== "VariableDeclarator" || n.id.type !== "Identifier" || !n.init || referenced.has(n.id.name)) continue;
    const init = n.init.type === "NewExpression" && n.init.arguments[0] ? n.init.arguments[0] : n.init;
    const data = (init.type === "Literal" && init.regex) || (init.type === "ArrayExpression" && init.elements.length >= 2 && init.elements.every((e) => e && e.type === "Literal" && (typeof e.value === "string" || e.regex)));
    if (data) report("unused data", n.id.name, n.loc.start.line);
  }

  // Names in code (a variable, a property, an object's key) that are a site's: { amazon: ..., github: ... }.
  for (const n of all) {
    if (n.type !== "Identifier" && !(n.type === "Literal" && n.parent && n.parent.type === "Property" && n.parent.key === n)) continue;
    const name = n.type === "Identifier" ? n.name : String(n.value);
    for (const w of name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) if (names.names.has(w)) report("site name", w, n.loc.start.line);
  }
  // A selector written anywhere, not only where it is handed to the page.
  // A string held against an address (location.hash === "#help") is part
  // of an address, not a selector.
  for (const n of literals) if (!n.regex && !(n.type === "TemplateLiteral" && n.expressions.length) && !addressParts.has(n) && !judged.has(n) && !searched.has(n)) for (const s of selectorNames(literalText(n), own)) report("selector", s, n.loc.start.line);
  void bound; void isFnParam; void UNKNOWN;
  return out.sort((a, b) => a.line - b.line);
}

module.exports = { findings, readNames, selectorNames, parseSelector, parse };
