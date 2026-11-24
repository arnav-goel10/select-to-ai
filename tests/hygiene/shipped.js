"use strict";
// Test-only. What the hygiene scan reads and what it counts as the
// extension's own: the shipped files, the class and id names the extension
// itself defines, and the sites of the repository's own task files.
const fs = require("node:fs");
const path = require("node:path");
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

/**
 * The class, id, name and value names the extension itself declares, in its own
 * pages (.html) and style sheets (.css). Nothing a script writes counts: a
 * name a script gives an element could be any site's, so it is not taken
 * on trust.
 */
function ownNames() {
  const own = new Set();
  for (const f of filesIn(EXT, /\.(html|css)$/)) {
    const text = fs.readFileSync(path.join(EXT, f), "utf8");
    for (const m of text.matchAll(/\b(?:class|id|name|for|value|data-[\w-]+)\s*=\s*["']([^"'${}]+)["']/g)) for (const t of m[1].split(/\s+/)) if (t) own.add(t);
    for (const m of text.matchAll(/(?:^|[\s,{}>+~(])[.#]([A-Za-z_-][\w-]*)(?=[\s,{:.#[>+~)]|$)/gm)) own.add(m[1]);
  }
  return own;
}

/** The data attributes the extension's own pages (.html) and style sheets (.css) declare. */
function ownAttributes() {
  const own = new Set();
  for (const f of filesIn(EXT, /\.(html|css)$/)) for (const m of fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/\b(data-[a-z][\w-]*)/g)) own.add(m[1]);
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

/**
 * The scripts that run only on the extension's own pages: loaded by its
 * .html files, and neither a content script in the manifest nor a file it
 * injects into a tab. Only in these do the extension's own names count as
 * its own; a script that runs on web pages reads a site's markup, where a
 * name the extension also uses ("main", "card") is the site's.
 */
function ownPageScripts() {
  const loaded = new Set();
  for (const f of filesIn(EXT, /\.html$/)) for (const m of fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) loaded.add(m[1].replace(/^\.?\//, ""));
  const onPages = new Set();
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) onPages.add(js);
  for (const f of filesIn(EXT, /\.js$/)) for (const m of fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/\bfiles:\s*\[([^\]]*)\]/g)) for (const q of m[1].matchAll(/["']([^"']+\.js)["']/g)) onPages.add(q[1]);
  return new Set([...loaded].filter((f) => !onPages.has(f)));
}

/** The scan as the tests run it: the dictionary with the task sites joined, and the extension's own names left out in its own pages' scripts. */
function scanWith() {
  const OWN = ownNames();
  const OWN_ATTRS = ownAttributes();
  // A selector or token is the extension's own when every class and id it names is.
  // The extension's own pages, by the path an address of one would have: /sidepanel for sidepanel.html.
  const PAGES = new Set(filesIn(EXT, /\.html$/).map((f) => `/${f.replace(/\.html$/, "")}`));
  const own = (x) => {
    const text = String(x);
    if (PAGES.has(text) || OWN_ATTRS.has(text)) return true;
    // Every name the selector or token picks by: classes, ids, attributes and their values, or the token itself.
    const attrs = [...text.matchAll(/\[\s*([\w-]+)\s*(?:[~^$*|]?=\s*["']?([^"'\]]*)["']?)?\s*\]/g)];
    const named = [
      ...[...text.replace(/\[[^\]]*\]/g, " ").matchAll(/[.#]([A-Za-z_-][\w-]*)/g)].map((m) => m[1]),
      ...attrs.filter((m) => m[2] !== undefined).map((m) => m[2]),
    ];
    if (!named.length && !attrs.length && /^[A-Za-z_-][\w-]*$/.test(text)) named.push(text);
    return (named.length > 0 || attrs.length > 0) && named.every((t) => OWN.has(t)) && attrs.every((m) => OWN_ATTRS.has(m[1]));
  };
  const NAMES = readNames();
  for (const n of taskSiteNames()) if (!NAMES.words.has(n)) NAMES.names.add(n);
  const OWN_PAGE_SCRIPTS = ownPageScripts();
  const none = () => false;
  // `file` is the shipped file the source is, or is written into; with none, nothing counts as the extension's own.
  const scan = (src, file) => findings(src, NAMES, file && OWN_PAGE_SCRIPTS.has(file) ? own : none);
  /** A source's findings for each shipped file it could be written into: (file) => findings. */
  const scanFor = (src) => { const strict = findings(src, NAMES, none); const owned = findings(src, NAMES, own); return (file) => (OWN_PAGE_SCRIPTS.has(file) ? owned : strict); };
  return { own, NAMES, scan, scanFor, OWN, OWN_ATTRS, OWN_PAGE_SCRIPTS };
}

module.exports = { filesIn, ownNames, ownAttributes, ownPageScripts, taskSiteNames, scanWith, ROOT, EXT };

