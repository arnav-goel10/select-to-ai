"use strict";
// Test-only. Rewrites a source with every name in it (variables,
// parameters, functions, and the page globals such as document and
// location) renamed to neutral ones: card, part, block, cur, c, h, at, then
// card2, part2 and so on. Property names are left as they are, since they
// are what a page or an address is read through. The hygiene scan must find
// the same shapes whatever their names are.
const acorn = require("acorn");

const NEUTRAL = ["card", "part", "block", "cur", "c", "h", "at"];
// JavaScript's own built-ins: renaming one would change what the code does.
const BUILTINS = new Set(["Set", "Map", "WeakSet", "WeakMap", "URL", "URLSearchParams", "RegExp", "String", "Object", "Array", "Number", "Boolean", "JSON", "Math", "CSS", "Reflect", "Symbol", "Promise", "Date", "Error", "undefined", "NaN", "Infinity", "decodeURIComponent", "decodeURI", "encodeURIComponent", "encodeURI", "parseInt", "parseFloat", "isNaN", "arguments"]);

/** Every name in a source that renameIdentifiers renames. */
function namesIn(src) {
  const out = new Set();
  walk(acorn.parse(src, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), (node, what) => { if (what) out.add(node.name); });
  return [...out];
}

/** Calls `use` on every Identifier that is a name, not a property name or a label. */
function walk(ast, use) {
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Identifier" && !BUILTINS.has(node.name)) {
      const propertyKey = parent && ((parent.type === "MemberExpression" && key === "property" && !parent.computed) || ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key" && !parent.computed));
      const label = parent && (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") && key === "label";
      use(node, propertyKey && parent.type === "Property" && parent.shorthand ? "shorthand" : propertyKey || label ? "" : "name");
    }
    for (const k of Object.keys(node)) {
      if (k === "loc") continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => visit(x, node, k));
      else if (v && typeof v.type === "string") visit(v, node, k);
    }
  };
  visit(ast, null, "");
}

function renameIdentifiers(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
  const edits = [];
  const names = new Map();
  const nameFor = (old) => {
    if (!names.has(old)) { const i = names.size; names.set(old, `${NEUTRAL[i % NEUTRAL.length]}${i >= NEUTRAL.length ? Math.floor(i / NEUTRAL.length) + 1 : ""}`); }
    return names.get(old);
  };
  walk(ast, (node, what) => {
    // { id } stands for { id: id }: the key stays, the name is renamed.
    if (what === "shorthand") edits.push([node.start, node.end, `${node.name}: ${nameFor(node.name)}`]);
    else if (what === "name") edits.push([node.start, node.end, nameFor(node.name)]);
  });
  // A shorthand property visits its key and its value, which are the same node span: keep the one edit.
  const seen = new Set();
  const unique = edits.filter(([s]) => (seen.has(s) ? false : seen.add(s)));
  let out = src;
  for (const [s, e, text] of unique.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
  return out;
}

module.exports = { renameIdentifiers, namesIn, NEUTRAL };
