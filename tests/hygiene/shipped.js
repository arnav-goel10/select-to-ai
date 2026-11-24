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
    for (const m of text.matchAll(/\b(?:class|id|name|for|value)\s*=\s*["']([^"'${}]+)["']/g)) for (const t of m[1].split(/\s+/)) if (t) own.add(t);
    for (const m of text.matchAll(/(?:^|[\s,{}>+~(])[.#]([A-Za-z_-][\w-]*)(?=[\s,{:.#[>+~)]|$)/gm)) own.add(m[1]);
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
    const text = String(x);
    if (PAGES.has(text)) return true;
    // Every name the selector or token picks by: classes, ids, attribute values, or the token itself.
    const named = [
      ...[...text.replace(/\[[^\]]*\]/g, " ").matchAll(/[.#]([A-Za-z_-][\w-]*)/g)].map((m) => m[1]),
      ...[...text.matchAll(/\[\s*[\w-]+\s*[~^$*|]?=\s*["']?([^"'\]]*)["']?\s*\]/g)].map((m) => m[1]),
    ];
    if (!named.length && /^[A-Za-z_-][\w-]*$/.test(text)) named.push(text);
    return named.length > 0 && named.every((t) => OWN.has(t));
  };
  const NAMES = readNames();
  for (const n of taskSiteNames()) if (!NAMES.words.has(n)) NAMES.names.add(n);
  const scan = (src) => findings(src, NAMES, own);
  return { own, NAMES, scan, OWN };
}

module.exports = { filesIn, ownNames, taskSiteNames, scanWith, ROOT, EXT };

