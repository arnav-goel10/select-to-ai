"use strict";
// Test-only. What the hygiene scan reads and what it counts as the
// extension's own: the shipped files, the class and id names the extension
// itself defines, and the sites of the repository's own task files.
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const { findings, readNames } = require("../helpers/literal-scan.js");

const ROOT = path.join(__dirname, "../..");
const EXT = path.join(ROOT, "extension");

/** Every file under a folder, relative to it. */
function filesIn(dir, ext) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (ext.test(e.name)) out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  })(dir);
  return out.sort();
}

/** The class and id names the extension itself defines: in its pages, its styles and the strings it builds elements from. */
function ownNames() {
  const own = new Set();
  const fromMarkup = (text) => {
    for (const m of text.matchAll(/\b(?:class|id)\s*=\s*["']([^"'${}]+)["']/g)) for (const t of m[1].split(/\s+/)) if (t) own.add(t);
    for (const m of text.matchAll(/(?:^|[\s,{}>+~(])[.#]([A-Za-z_-][\w-]*)(?=[\s,{:.#[>+~)]|$)/gm)) own.add(m[1]);
  };
  for (const f of filesIn(EXT, /\.(html|css)$/)) fromMarkup(fs.readFileSync(path.join(EXT, f), "utf8"));
  for (const f of filesIn(EXT, /\.js$/)) {
    if (f === "publicSuffixes.js") continue;
    const src = fs.readFileSync(path.join(EXT, f), "utf8");
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true }); } catch (_e) { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }); }
    const visit = (n) => {
      if (!n || typeof n.type !== "string") return;
      // What the extension sets on elements it makes: el.className = "...", el.id = "...", classList.add("...").
      const setsName = (target) => target && target.type === "MemberExpression" && !target.computed && /^(className|id)$/.test(target.property.name);
      // Every string in the value, a conditional's branches and a template's parts included.
      const strings = (v) => {
        const out = [];
        const walk = (x) => {
          if (!x || typeof x.type !== "string") return;
          if (x.type === "Literal" && typeof x.value === "string") out.push(x.value);
          if (x.type === "TemplateElement") out.push(x.value.cooked || "");
          for (const k of Object.keys(x)) { if (k === "loc") continue; const c = x[k]; if (Array.isArray(c)) c.forEach(walk); else if (c && typeof c.type === "string") walk(c); }
        };
        walk(v);
        return out;
      };
      if (n.type === "AssignmentExpression" && setsName(n.left)) for (const t of strings(n.right).join(" ").split(/\s+/)) if (t) own.add(t);
      if (n.type === "Property" && !n.computed && n.key && /^(className|id)$/.test(n.key.name || n.key.value)) for (const t of strings(n.value).join(" ").split(/\s+/)) if (t) own.add(t);
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed) {
        const m = n.callee.property.name;
        if (/^(add|remove|toggle|replace)$/.test(m) && n.callee.object.type === "MemberExpression" && n.callee.object.property.name === "classList") for (const a of n.arguments) for (const t of strings(a).join(" ").split(/\s+/)) if (t) own.add(t);
        if (m === "setAttribute" && n.arguments[0] && /^(class|id)$/.test(n.arguments[0].value)) for (const t of strings(n.arguments[1]).join(" ").split(/\s+/)) if (t) own.add(t);
      }
      // Markup and style sheets the extension writes as strings.
      if ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateElement") { const t = n.type === "Literal" ? n.value : n.value.cooked || ""; if (/[<{]/.test(t)) fromMarkup(t); }
      for (const k of Object.keys(n)) {
        if (k === "loc") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v.type === "string") visit(v);
      }
    };
    visit(ast);
  }
  return own;
}

/** The registrable label of every host in the repository's own task files: names the scan must catch, whatever the static list holds. */
function taskSiteNames() {
  const sources = [
    "tests/decisions/cases.js", "tests/decisions/press-cases.js", "tests/bench/smoke-tasks.json", "bench/recipes/tasks/index.js",
  ].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const TOOLS = require(path.join(EXT, "agentTools.js"));
  const out = new Set();
  for (const m of sources.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const site = TOOLS.siteOf(`https://${m[1]}/`);
    if (!site || /(?:^|\.)(?:example|test|invalid|localhost)$|(?:^|\.)example\.[a-z.]+$/.test(m[1])) continue;
    const label = site.split(".")[0];
    if (label && label.length > 2 && label !== "www") out.add(label);
  }
  return out;
}

/** The scan as the tests run it: the dictionary with the task sites joined, and the extension's own names left out. */
function scanWith() {
  const OWN = ownNames();
  // A selector or token is the extension's own when every class and id it names is.
  // The extension's own pages, by the path an address of one would have: /sidepanel for sidepanel.html.
  const PAGES = new Set(filesIn(EXT, /\.html$/).map((f) => `/${f.replace(/\.html$/, "")}`));
  const own = (x) => {
    if (PAGES.has(String(x))) return true;
    const tokens = String(x).replace(/\[[^\]]*\]/g, " ").match(/[A-Za-z_-][\w-]*/g) || [];
    const named = [...String(x).matchAll(/[.#]([A-Za-z_-][\w-]*)/g)].map((m) => m[1]);
    return (named.length ? named : tokens.slice(-1)).every((t) => OWN.has(t)) && !/\[/.test(String(x));
  };
  const NAMES = readNames();
  for (const n of taskSiteNames()) if (!NAMES.words.has(n)) NAMES.names.add(n);
  const scan = (src) => findings(src, NAMES, own);
  return { own, NAMES, scan, OWN };
}

module.exports = { filesIn, ownNames, taskSiteNames, scanWith, ROOT, EXT };

