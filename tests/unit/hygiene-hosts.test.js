"use strict";
// The agent works the same on any site. A rule written for one site, or for
// one test's page, is a patch: it does not carry over to the next site, and
// it makes a score better without making the agent better.
//
// So no file the agent runs may name a host, or a site's own class or id,
// except the few a person has reviewed: provider endpoints, the assistants
// the right-click menu opens, human-check vendors, search engines and the
// public suffix list (tests/unit/hygiene-allowlist.json, each with its
// reason). The check is by structure, not by a list of sites to look for:
// a host is any dotted name whose last label is a real top-level domain (the
// public suffix list says which), and a class or id is any selector a
// string writes. Which files are the agent's is read from the extension
// itself: what the worker loads and what the engine puts into pages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { partsOf } = require("../helpers/source-scan.js");

const EXT = path.join(__dirname, "../../extension");
const ALLOW = JSON.parse(fs.readFileSync(path.join(__dirname, "hygiene-allowlist.json"), "utf8"));
const TLDS = new Set(require(path.join(EXT, "publicSuffixes.js")).split("\n").map((l) => l.split(":")[0]));

/** The agent's files: background.js, everything it loads, and everything the engine injects into pages. */
function agentFiles() {
  const worker = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const engine = fs.readFileSync(path.join(EXT, "engine.js"), "utf8");
  const files = new Set(["background.js"]);
  for (const m of worker.matchAll(/importScripts\(([^)]*)\)/g)) for (const f of m[1].matchAll(/['"]([^'"]+\.js)['"]/g)) files.add(f[1]);
  for (const m of engine.matchAll(/files:\s*\[([^\]]*)\]/g)) for (const f of m[1].matchAll(/['"]([^'"]+\.js)['"]/g)) files.add(f[1]);
  return [...files];
}

// Names kept for examples and tests, never a real site (RFC 2606, RFC 6761).
const RESERVED = /(?:^|\.)(?:example|test|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$/;
// The extension's own elements carry this prefix.
const OWN = /select-to-ai/;

/** What a source holds that names a site: hosts, lists of host labels, selectors, class comparisons. */
function findings(src) {
  const parts = partsOf(src);
  // A name used in code before a dot ("chrome.tabs", "profile.email") is code, not a host, where it is written in a comment.
  const ids = new Set(["chrome", "self", "window", "document", "globalThis", "location", "navigator"]);
  for (const p of parts) if (p.kind === "code") for (const m of p.text.matchAll(/([A-Za-z_$][\w$]*)\s*\??\./g)) ids.add(m[1]);
  const out = [];
  for (const p of parts) {
    if (p.kind === "code") continue;
    let text = p.kind === "regex" ? p.text.replace(/\\\./g, ".") : p.text;
    if (p.kind === "string") text = text.replace(/\$\{[^}]*\}/g, " ");
    for (const m of text.matchAll(/(?<![\w.@-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}))(?![\w-])/gi)) {
      const host = m[1].toLowerCase();
      if (!TLDS.has(m[2].toLowerCase()) || ids.has(m[1].split(".")[0]) || RESERVED.test(host)) continue;
      out.push({ kind: "host", what: host, line: p.line });
    }
    // A regular expression with a list of names before a dot is a list of sites: (?:aa|bb|cc)\.
    if (p.kind === "regex") for (const m of p.text.matchAll(/\((?:\?:)?([a-z0-9-]+(?:\|[a-z0-9-]+){2,})\)\\\./gi)) out.push({ kind: "host list", what: m[1], line: p.line });
    if (p.kind === "string" && !text.includes("{")) {
      for (const m of text.matchAll(/(?:^|[\s,>+~(["'`])([.#][A-Za-z_][\w-]*)/g)) {
        const sel = m[1];
        if (OWN.test(sel) || /^#[0-9a-f]{3,8}$/i.test(sel)) continue;
        out.push({ kind: "selector", what: sel, line: p.line });
      }
      for (const m of text.matchAll(/\[(?:class|id)\s*[~^$*|]?=\s*["']?([^"'\]]+)/g)) if (!OWN.test(m[1])) out.push({ kind: "selector", what: `[class/id=${m[1]}]`, line: p.line });
    }
  }
  // Code that holds a page's class against something it wrote: a class name read as a meaning.
  const code = parts.map((p) => (p.kind === "code" ? p.text : p.text.replace(/[^\n]/g, p.kind === "comment" ? " " : "S"))).join("");
  code.split("\n").forEach((line, i) => {
    const raw = src.split("\n")[i] || "";
    if (/className|getAttribute\(\s*['"]class['"]\s*\)|classList\.contains/.test(line) && /\.(?:test|match|includes|indexOf|contains|startsWith|endsWith)\(/.test(line) && !OWN.test(raw)) {
      out.push({ kind: "class test", what: raw.trim().slice(0, 100), line: i + 1 });
    }
  });
  return out;
}

const allowedFiles = new Set(ALLOW.files.map((f) => f.file));
const allowed = { host: new Set(ALLOW.hosts.map((h) => h.host)), selector: new Set(ALLOW.selectors.map((s) => s.selector)) };

test("the scan finds the kinds of patch it is there to stop", () => {
  const kinds = (src) => findings(src).map((f) => `${f.kind}:${f.what}`);
  assert.ok(kinds('const HOST = /(?:^|\\.)(?:google|bing|duckduckgo)\\.[a-z.]{2,}$/i;').some((k) => k.startsWith("host list:")), "a regex list of engines");
  assert.ok(kinds('const MAIN = ["main", "#mw-content-text", ".main-content"];').includes("selector:#mw-content-text"));
  assert.ok(kinds('const SITES = { x: "https://x.com", nus: "https://www.nus.edu.sg" };').includes("host:www.nus.edu.sg"));
  assert.ok(kinds("if (SKIP.test(el.className)) return;").some((k) => k.startsWith("class test:")));
  assert.ok(kinds("// the guessed area (caniuse.com's div#main)").includes("host:caniuse.com"), "comments too");
  assert.deepEqual(kinds('const a = "https://shop.example/cart"; const b = TOOLS.siteOf(u); // see chrome.tabs.query'), [], "reserved names and code are not hosts");
});

test("no file the agent runs names a host or a site's class outside the reviewed allowlist", () => {
  const files = agentFiles();
  for (const f of ["engine.js", "agentTools.js", "agentContentScript.js", "core/context.js", "pageSearch.js", "defaults.js"]) assert.ok(files.includes(f), `${f} is read as one of the agent's files`);
  const hits = [];
  const used = new Set();
  for (const file of files) {
    if (allowedFiles.has(file)) { used.add(`file:${file}`); continue; }
    for (const f of findings(fs.readFileSync(path.join(EXT, file), "utf8"))) {
      if (allowed[f.kind] && allowed[f.kind].has(f.what)) { used.add(`${f.kind}:${f.what}`); continue; }
      hits.push(`${file}:${f.line}: ${f.kind} ${f.what}`);
    }
  }
  assert.deepEqual(hits, []);
  // Every entry is still needed, and says why it is there in one line.
  const stale = [
    ...ALLOW.files.map((f) => `file:${f.file}`),
    ...ALLOW.hosts.map((h) => `host:${h.host}`),
    ...ALLOW.selectors.map((s) => `selector:${s.selector}`),
  ].filter((k) => !used.has(k));
  assert.deepEqual(stale, [], "allowlist entries nothing uses");
  for (const e of [...ALLOW.files, ...ALLOW.hosts, ...ALLOW.selectors]) assert.ok(typeof e.why === "string" && e.why.trim() && !e.why.includes("\n"), `${JSON.stringify(e)} has a one-line reason`);
});

test("no file the agent runs names a decision case or a bench task", () => {
  const { CASES } = require("../decisions/cases.js");
  const { PRESS_CASES } = require("../decisions/press-cases.js");
  const smoke = JSON.parse(fs.readFileSync(path.join(__dirname, "../bench/smoke-tasks.json"), "utf8"));
  const recipes = fs.readFileSync(path.join(__dirname, "../../bench/recipes/tasks/index.js"), "utf8");
  const ids = new Set([...CASES.map((c) => c.name), ...PRESS_CASES.map((c) => c.name), ...smoke.map((t) => t.id), ...[...recipes.matchAll(/\bid:\s*["']([\w-]+)["']/g)].map((m) => m[1])]
    .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(id)));
  assert.ok(ids.size > 50, `the task ids were read (${ids.size})`);
  const hits = [];
  for (const file of agentFiles()) {
    const src = fs.readFileSync(path.join(EXT, file), "utf8");
    for (const id of ids) if (new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(src)) hits.push(`${file}: ${id}`);
  }
  assert.deepEqual(hits, []);
});
