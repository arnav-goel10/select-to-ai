"use strict";
// The extension works the same on any site. A rule written for one site, or
// for one test's page, is a patch: it does not carry over to the next site,
// and it makes a score better without making the agent better.
//
// So no file the extension ships may name a site, a brand, a host, or a
// site's own class or id, except the few a person has reviewed: provider
// endpoints, the assistants the right-click menu opens, human-check vendors,
// search engines and the browser's own pages (tests/unit/hygiene-allowlist.json,
// each with its reason). The files are parsed (tests/helpers/literal-scan.js)
// and every string, template and regex literal, every comment and every name
// in code is read:
// - a host is any dotted name whose last label is a real top-level domain
//   (the Public Suffix List says which);
// - a site or brand name is any word in tests/hygiene/site-names.txt, a
//   public list of the most visited sites kept for this test only, joined
//   with the hosts of the repository's own task files;
// - a class or id is any selector that picks one, any token held against a
//   page's class, and any page class handed to code to read a meaning from;
// - a bare label held against a host, and a path held against an address,
//   are one site's.
// The extension's own class and id names (from its pages, styles and the
// elements it makes) are its own, not a site's.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readNames } = require("../helpers/literal-scan.js");

const ROOT = path.join(__dirname, "../..");
const EXT = path.join(ROOT, "extension");
const ALLOW = JSON.parse(fs.readFileSync(path.join(__dirname, "hygiene-allowlist.json"), "utf8"));

const { filesIn, ownNames, taskSiteNames, scanWith } = require("../hygiene/shipped.js");
const { own, NAMES, scan } = scanWith();

// The fifteen shapes a reviewer wrote to get past the earlier, line-based
// scan. Each must be found on its own, with nothing else around it.
const PATCHES = {
  "a bare site name in a string": 'if (host.includes("wikipedia")) skip = true;',
  "a host regex with alternation of two engines": "const H = /(?:^|\\.)(?:google|bing)\\.[a-z]+$/;",
  "a regex of names with no dot": "const SITE = /amazon|booking|github/i; if (SITE.test(url)) fast();",
  "tag-qualified selectors in an array": 'const MAIN = ["div#mw-content-text", "table.infobox", "div.navbox"];',
  "the original SKIP_CLASS regex definition": "const SKIP_CLASS = /(?:^|\\s)(?:mw-editsection|reference|navbox)(?:\\s|$)/i;",
  "a class read into a variable and tested on the next line": "const cls = String(el.className);\nif (SKIP.test(cls)) return;",
  "a class list searched through a Set": "if ([...el.classList].some((c) => SKIP.has(c))) return;",
  "class tokens in a Set, held against a page's class": 'const SKIP = new Set(["mw-editsection", "navbox", "star-rating"]);\nif ([...el.classList].some((c) => SKIP.has(c))) return;',
  "a path of one site's addresses": "if (/\\/sorry\\/index/.test(url)) return true;",
  "an attribute selector by a test id": 'if (el.matches("[data-testid=price]")) x();',
  "a host's name built from pieces": 'if (new URL(u).hostname.endsWith("wikipedia" + ".org")) x();',
  "closest with a tag-qualified class": 'if (el.closest("span.mw-editsection")) return;',
  "a plain class selector": 'el.querySelector(".navbox")',
  "site nicknames as an object's keys": "const NICK = { amazon: 1, github: 1, arxiv: 1 };",
  "a page's class handed to a function to read a meaning": "const RATING_WORD = /^(?:rating|ratings|rated|stars?|score)$/i;\nfunction markedMeaning(el) { const cls = el.className; const byClass = cls && ratingClass(cls) ? 1 : 0; }",
};

test("the scan finds every shape of site patch it is there to stop", () => {
  assert.equal(Object.keys(PATCHES).length, 15);
  const missed = Object.entries(PATCHES).filter(([, src]) => !scan(src).length).map(([name]) => name);
  assert.deepEqual(missed, [], "patch shapes the scan does not find");
  // A Set of class tokens on its own line is found through the line that uses it.
  const set = scan(PATCHES["class tokens in a Set, held against a page's class"]);
  for (const t of ["mw-editsection", "navbox", "star-rating"]) assert.ok(set.some((f) => f.what === t && f.line === 1), `${t} is reported where it is written`);
  // Shapes removed from this repository earlier, as they were written.
  assert.ok(scan("const MAIN_SELECTORS = ['main', '[role=\"main\"]', 'article', '#mw-content-text', '#content', '#main', '.main-content', '#main-content'];").some((f) => f.kind === "selector" && f.what === "#mw-content-text"));
  assert.ok(scan("return CHALLENGE_TITLE.test(title) || /\\/sorry\\/index/.test(String(page.url || \"\"));").some((f) => f.kind === "address path"));
  assert.ok(scan("const KNOWN_SITES = { amazon: \"https://www.amazon.com/\", wiki: \"https://en.wikipedia.org/\" };").some((f) => f.kind === "host"));
  assert.ok(scan("// the guessed area (caniuse.com's div#main)").some((f) => f.what === "caniuse.com"), "comments are read too");
});

test("what is not a site is not reported", () => {
  const clean = [
    'const a = "https://shop.example/cart"; const b = TOOLS.siteOf(u); // see chrome.tabs.query',
    "if (u.protocol === \"https:\" || /^chrome:\\/\\//.test(url)) return;",
    "const TAGS = new Set([\"SCRIPT\", \"STYLE\"]); if (TAGS.has(el.tagName)) skip();",
    "if (/^(button|link|menuitem)$/.test(el.getAttribute(\"role\") || \"\")) return;",
    "const box = el.closest('[role=\"dialog\"], [aria-modal=\"true\"]');",
    "if (n.id && /^select-to-ai-/.test(n.id)) return null;",
    "const color = \"#1a2b3c\"; el.style.color = color;",
    "const root = node.getRootNode(); if (root.host === el) return;",
    "if (host === \"localhost\" || host.endsWith(\".local\")) return true;",
  ];
  for (const src of clean) assert.deepEqual(scan(src), [], src);
});

const allowedFiles = new Set(ALLOW.files.map((f) => f.file));
// A name may be reviewed once, whether it is written as a word or held against a host.
// Class tokens and class tests have no entries: no site's markup is ever allowed.
const allowedKey = (f) => ({ host: "host", "site name": "name", "host label": "name", "address path": "path", selector: "selector" }[f.kind] || f.kind) + `:${f.what}`;
const allowed = new Set([
  ...ALLOW.hosts.map((h) => `host:${h.host}`),
  ...ALLOW.names.map((n) => `name:${n.name}`),
  ...ALLOW.paths.map((p) => `path:${p.path}`),
  ...ALLOW.selectors.map((s) => `selector:${s.selector}`),
]);

test("no file the extension ships names a site, a host or a site's class outside the reviewed allowlist", () => {
  const files = filesIn(EXT, /\.js$/);
  for (const f of ["background.js", "engine.js", "agentTools.js", "agentContentScript.js", "core/context.js", "core/run.js", "pageSearch.js", "defaults.js", "agent.js", "options.js"]) assert.ok(files.includes(f), `${f} is scanned`);
  const hits = [];
  const used = new Set();
  for (const file of files) {
    if (allowedFiles.has(file)) { used.add(`file:${file}`); continue; }
    for (const f of scan(fs.readFileSync(path.join(EXT, file), "utf8"))) {
      const key = allowedKey(f);
      if (allowed.has(key)) { used.add(key); continue; }
      hits.push(`${file}:${f.line}: ${f.kind} ${f.what}`);
    }
  }
  assert.deepEqual(hits, []);
  // Every entry is still needed, and says why it is there in one line.
  const stale = [...ALLOW.files.map((f) => `file:${f.file}`), ...allowed].filter((k) => !used.has(k));
  assert.deepEqual(stale, [], "allowlist entries nothing uses");
  for (const e of [...ALLOW.files, ...ALLOW.hosts, ...ALLOW.names, ...ALLOW.paths, ...ALLOW.selectors]) assert.ok(typeof e.why === "string" && e.why.trim() && !e.why.includes("\n"), `${JSON.stringify(e)} has a one-line reason`);
});

test("the site-name list is test data: no shipped file reads it", () => {
  for (const file of filesIn(EXT, /\.(js|json|html)$/)) assert.doesNotMatch(fs.readFileSync(path.join(EXT, file), "utf8"), /site-names/, file);
  const { names } = readNames();
  assert.ok(names.size > 250, `the list holds the top sites (${names.size})`);
  assert.ok(taskSiteNames().size >= 5, "the task files' own sites are joined in");
});

test("no file the extension ships names a decision case or a bench task", () => {
  const { CASES } = require("../decisions/cases.js");
  const { PRESS_CASES } = require("../decisions/press-cases.js");
  const smoke = JSON.parse(fs.readFileSync(path.join(__dirname, "../bench/smoke-tasks.json"), "utf8"));
  const recipes = fs.readFileSync(path.join(ROOT, "bench/recipes/tasks/index.js"), "utf8");
  const ids = new Set([...CASES.map((c) => c.name), ...PRESS_CASES.map((c) => c.name), ...smoke.map((t) => t.id), ...[...recipes.matchAll(/\bid:\s*["']([\w-]+)["']/g)].map((m) => m[1])]
    .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(id)));
  assert.ok(ids.size > 50, `the task ids were read (${ids.size})`);
  const hits = [];
  for (const file of filesIn(EXT, /\.js$/)) {
    const src = fs.readFileSync(path.join(EXT, file), "utf8");
    for (const id of ids) if (new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(src)) hits.push(`${file}: ${id}`);
  }
  assert.deepEqual(hits, []);
});
