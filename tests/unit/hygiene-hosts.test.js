"use strict";
// The extension works the same on any site. A rule written for one site, or
// for one test's page, is a patch: it does not carry over to the next site,
// and it makes a score better without making the agent better.
//
// This test is there to make the next such patch fail CI in every shape a
// careful reviewer would try. It is a static check, so code review stays
// the backstop for what it cannot see (named below, in OUT_OF_REACH, in LIMITS
// and in the pull request). What decides a finding is what a literal is held
// against, never what a variable is called. Every file the extension ships
// is parsed (tests/helpers/literal-scan.js), and a finding is:
// - any string or regex literal compared with, tested against, searched in,
//   switched on or looked up by a value read through a property named id,
//   name, className, classList, dataset, tagName, role, ariaLabel,
//   placeholder, alt, rel, title, host, hostname, origin, href, pathname or
//   url (and their kin), or through getAttribute, on any receiver, followed
//   through destructuring, names, parameters, Sets, Maps, lists and
//   callbacks;
// - a literal passed as, or built into, an argument of a selector call
//   (querySelector, matches, closest, getElementById, getAttribute and the
//   rest) or a dataset read, a selector made by adding literals, or an
//   element read as window["id"], with the selector parsed fully: classes, ids,
//   every attribute by name, and what is inside :is(), :not(), :has() and
//   :where();
// - a literal used in includes, startsWith, endsWith, indexOf, match or test
//   where the other side is not provably the extension's own text;
// - any host, and any site or brand name from tests/hygiene/site-names.txt
//   (a public top-site list kept for this test only, joined with the hosts
//   of the repository's own task files), in any literal or comment.
// A literal with no letter in it is not a finding. The extension's own
// class, id, name and data attribute names count as its own only where its
// .html and .css files declare them. Every other exception is an entry in
// tests/unit/hygiene-allowlist.json, and an entry is one file, one kind of
// finding and one purpose: a host allowed for the welcome page is not
// allowed in the agent, and a name allowed in text is not allowed when it
// is held against an address. A finding also carries what its literal is
// held against (an id, a class, a tag name, a role or another attribute, a
// host, a path, a query, an address, a title, the selector call it is
// handed to, or text), and an entry lists which of those it allows: an
// entry for a tag name or a role never covers an id or class test with the
// same word.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const { readNames } = require("../helpers/literal-scan.js");
const { renameIdentifiers, namesIn } = require("../helpers/rename-ids.js");
const { FRESH, OUT_OF_REACH, INPLACE, INPLACE_SHARED, SHARED_WORDS, FIFTH_FOUND, LIMITS } = require("../hygiene/reviewer-shapes.js");

const ROOT = path.join(__dirname, "../..");
const EXT = path.join(ROOT, "extension");
const ALLOW = JSON.parse(fs.readFileSync(path.join(__dirname, "hygiene-allowlist.json"), "utf8"));

const { filesIn, taskSiteNames, scanWith } = require("../hygiene/shipped.js");
const { scan, scanFor } = scanWith();
const SHIPPED = filesIn(EXT, /\.js$/);
const WHOLE_FILES = new Set(ALLOW.files.map((f) => f.file));

/** The findings in one file that no entry for that file covers: same file, kind and what it is held against, and the literal listed. */
const covered = (file, f) => ALLOW.entries.some((e) => e.file === file && e.kind === f.kind && e.against.includes(f.against) && e.what.includes(f.what));
const gate = (file, found) => (WHOLE_FILES.has(file) ? [] : found.filter((f) => !covered(file, f)));

// The fifteen shapes a reviewer wrote in the first round to get past the
// earlier, line-based scan.
const ROUND_ONE = {
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

// The 26 one-line shapes from the third round: ids, class lists walked in a
// loop or a callback, destructuring, data attributes, custom elements by
// tag, and bare site labels held against an address.
const ROUND_THREE = [
  'for (const c of el.classList) if (c === "navbox") return;',
  'if (el.id === "mw-content-text") main = el;',
  'if (el.id == "content" || el.id == "bodyContent") main = el;',
  'if (host.includes("toscrape")) x();',
  'if (el.classList.contains("navbox")) return;',
  'if (el.className.indexOf("navbox") >= 0) return;',
  'if (/navbox|infobox/.test(el.className)) return;',
  'if (el.getAttribute("class").includes("navbox")) return;',
  'if (el.dataset.testid === "price") x();',
  'document.getElementsByTagName("ytd-app");',
  'if (/toscrape/.test(url)) x();',
  'if (url.includes("toscrape")) x();',
  'if (tab.url.includes("toscrape")) x();',
  'if (page.title.includes("Hacker News")) x();',
  'el.matches("ytd-rich-item-renderer")',
  'document.querySelector("[id^=mw-]")',
  'const SKIP = ["mw-editsection", "navbox"]; const skip = (el) => SKIP.some((s) => el.matches("." + s));',
  'const SKIP = ["mw-editsection", "navbox"];',
  'const cls = el.className; const parts = cls.split(" "); if (parts.includes("navbox")) return;',
  'const { className } = el; if (className.includes("navbox")) return;',
  'el.classList.forEach((c) => { if (c === "navbox") skip = true; });',
  'if (String(el.id).startsWith("mw-")) return;',
  'if (/^(mw-|toc$)/.test(el.id)) return;',
  'const ID = /^(mw-content-text|bodyContent)$/; if (ID.test(node.id)) main = node;',
  'if (el.name === "field-keywords") search = el;',
  'if (el.getAttribute("name") === "field-keywords") search = el;',
];

// The third round's allowlist bypasses: names allowed for one use (the
// welcome page's suggested tasks, the provider list, the right-click menu)
// written into a rule. Each must fail the full gate in every shipped file.
const BYPASSES = [
  'if (host.includes("wikipedia")) skip = true;',
  'if (/(?:^|\\.)wikipedia\\.org$/.test(location.hostname)) dropCitations = true;',
  'if (siteOf(url) === "github.com") readme = true;',
  'const SITE = /google|github|wikipedia/i; if (SITE.test(url)) fast();',
  'if (location.hostname === "news.ycombinator.com") rows = "tr";',
  'if (host.endsWith("google.com") && location.pathname.startsWith("/app")) x();',
  'if (/chatgpt|claude|gemini|perplexity/.test(host)) x();',
];

// The third round's further shapes that are in this scan's reach: a class
// read through a helper, attribute substrings, selectors built at run time,
// names split or lowered, address parts. The shapes it cannot reach (a
// phrase of page text, found only where it holds a dictionary name, a
// citation pattern in page text, a hash of a host, a name from character
// codes, an aria-label word list, a hint in a prompt, a stop-word list, a
// model name pattern) are page text or prose, not markup or an address;
// review stays the check for those.
const FURTHER = [
  'const SKIP = new Set(["mw-editsection", "navbox", "star-rating"]);\nfunction skip(el) { const names = tokens(el); return names.some((c) => SKIP.has(c)); }\nfunction tokens(el) { return el.getAttribute("class").split(" "); }',
  'if (el.matches("[class*=navbox]")) return;',
  'const PARTS = ["infobox", "navbox"]; const sel = PARTS.map((p) => "." + p).join(","); el.querySelectorAll(sel);',
  'if (/sign in to continue|your basket|prime video/i.test(document.title)) fast();',
  'if (host.includes("wiki" + "pedia")) skip = true;',
  'if (host.includes("booksToScrape".toLowerCase())) x();',
  'if (/toscrape|quotes-site/.test(page.url)) x();',
  'if (el.id === "mw-content-text") main = el;',
  'if (String(el.id).startsWith("mw-")) return;',
  'if (el.getAttribute("data-testid") === "price-box") x();',
  'const M = { "a-price": 1, "navbox": 0 };\nfor (const c of el.classList) if (M[c]) x();',
  'for (const c of el.classList) { switch (c) { case "navbox": return; } }',
  'const re = new RegExp("(^| )(navbox|infobox)( |$)"); if (re.test(el.className)) return;',
  'if (location.pathname.includes("/sorry/")) return true;',
  'if (new URL(u).searchParams.has("gws_rd")) x();',
  'const HINT = "On Amazon, the price is under the title.";',
  'el.querySelector(`div.${"navbox"}`);',
  'if (el.tagName === "YTD-RICH-ITEM-RENDERER") x();',
  'document.querySelector("ytd-app");',
  'const has = (el, c) => el.classList.contains(c);\nif (has(node, "navbox")) return;',
  'const { className } = el; if (className.includes("navbox")) return;',
  'const h = tab.url.split("/")[2]; if (h.indexOf("toscrape") >= 0) x();',
];

const SHAPES = [...Object.values(ROUND_ONE), ...ROUND_THREE, ...BYPASSES, ...FURTHER];
// The fourth round's fresh shapes, apart from the few no static check reaches.
const REACHABLE = FRESH.filter((src) => !(src in OUT_OF_REACH));

test("every shape a reviewer tried is found by the scan on its own", () => {
  assert.equal(Object.keys(ROUND_ONE).length, 15);
  assert.equal(ROUND_THREE.length, 26);
  assert.equal(BYPASSES.length, 7);
  assert.equal(FURTHER.length, 22);
  const missed = SHAPES.filter((src) => !scan(src).length);
  assert.deepEqual(missed, [], "patch shapes the scan does not find");
  // Shapes removed from this repository earlier, as they were written.
  assert.ok(scan("const MAIN_SELECTORS = ['main', '[role=\"main\"]', 'article', '#mw-content-text', '#content', '#main', '.main-content', '#main-content'];").some((f) => f.kind === "selector" && f.what === "#mw-content-text"));
  assert.ok(scan("const MAIN_SELECTORS = ['main', 'article', ':is(#mw-content-text, #content, #main)'];").some((f) => f.kind === "selector" && f.what === "#mw-content-text"), "inside :is()");
  assert.ok(scan("return CHALLENGE_TITLE.test(title) || /\\/sorry\\/index/.test(String(page.url || \"\"));").some((f) => f.kind === "address test"));
  assert.ok(scan("const KNOWN_SITES = { amazon: \"https://www.amazon.com/\", wiki: \"https://en.wikipedia.org/\" };").some((f) => f.kind === "host"));
  assert.ok(scan("// the guessed area (caniuse.com's div#main)").some((f) => f.what === "caniuse.com"), "comments are read too");
});

test("every fresh shape from the fourth round is found, apart from the few named as out of reach", () => {
  assert.equal(FRESH.length, 179);
  assert.equal(new Set(FRESH).size, 179, "no shape twice");
  const missed = REACHABLE.filter((src) => !scan(src).length);
  assert.deepEqual(missed, [], "fresh shapes the scan does not find");
  // The out-of-reach list is exactly true: each one is a fresh shape, has a reason, and is not found.
  for (const [src, why] of Object.entries(OUT_OF_REACH)) {
    assert.ok(FRESH.includes(src), src);
    assert.ok(why.length > 40 && !why.includes("\n"), `${src} has a one-line reason`);
    assert.deepEqual(scan(src), [], `${src} is out of reach, or it would be found`);
  }
  assert.ok(Object.keys(OUT_OF_REACH).length <= 2, "a short list");
  // The second one, bound in a file the way real code binds it, is found.
  assert.ok(scan('const host = location.hostname; if (host.split(".").slice(-2)[0] === "shopdemo") x();').some((f) => f.kind === "address test" && f.what === "shopdemo"));
});

test("every shape is found with every name in it renamed to a neutral one", () => {
  // card, part, block, cur, c, h, at: a shape caught only because a variable
  // was called el, host or url would be lost here.
  const missed = [];
  for (const src of [...SHAPES, ...REACHABLE]) {
    const renamed = renameIdentifiers(src);
    for (const name of namesIn(renamed)) assert.match(name, /^(?:card|part|block|cur|c|h|at)\d*$/, `${src} is renamed: ${renamed}`);
    if (!scan(renamed).length) missed.push(renamed);
  }
  assert.deepEqual(missed, [], "renamed shapes the scan does not find");
  assert.equal(renameIdentifiers('if (el.id === "mw-content-text") main = el;'), 'if (card.id === "mw-content-text") part = card;');
  assert.equal(renameIdentifiers("const { className } = el;"), "const { className: card } = part;");
});

test("every shape a reviewer tried fails the full gate, whichever shipped file it is written into", () => {
  // The gate as CI runs it, with each file's own allowlist entries: a shape
  // must leave a finding no entry for that file covers.
  const passes = [];
  for (const src of [...SHAPES, ...REACHABLE]) {
    const found = scanFor(src);
    for (const file of SHIPPED) if (!WHOLE_FILES.has(file) && !gate(file, found(file)).length) passes.push(`${file}: ${src}`);
  }
  // No file lets one through. The recipes' page script reads the
  // data-testid attribute by name as a stable name for a control, and its
  // entry allows that read only: the same attribute in a selector call or
  // a value held against a test id is a finding there too.
  assert.deepEqual(passes, [], "shapes the gate lets through");
  // Written into the files whose entries come closest (the welcome page, the
  // provider list, the right-click menu, the search hosts) and scanned in
  // place, each shape still adds a finding the file's entries do not cover.
  for (const file of ["welcome.js", "defaults.js", "config.js", "contentScript.js", "agentTools.js", "core/run.js"]) {
    const base = fs.readFileSync(path.join(EXT, file), "utf8");
    const before = gate(file, scan(base, file)).length;
    for (const src of SHAPES) assert.ok(gate(file, scan(`${base}\n${src}\n`, file)).length > before, `${file} lets through: ${src}`);
  }
});

test("the removed rules, written into the content script's own functions, fail the gate", () => {
  // Beside the line that skips the extension's own badge layer by its id, and
  // in pickMain, in the file's own idiom and gated with that file's entries.
  for (const { file, anchor, line } of INPLACE) {
    const base = fs.readFileSync(path.join(EXT, file), "utf8");
    assert.ok(base.includes(anchor), `the anchor is in ${file}: ${anchor}`);
    const before = gate(file, scan(base, file)).length;
    const after = gate(file, scan(base.replace(anchor, `${anchor}\n${line}`), file));
    assert.ok(after.length > before, `${file} lets through: ${line.trim()}`);
  }
  assert.equal(INPLACE.length, 9);
});

test("an id or class test with a word the content script allows for a tag name or a role fails the gate", () => {
  // footer, nav, search, banner, navigation, article, list, row, heading,
  // group, tab and none: in pickMain and in the Markdown walk, held against
  // an id and against a class. The same words held against a tag name or a
  // role are allowed, so only what a literal is held against tells them apart.
  assert.equal(SHARED_WORDS.length, 12);
  assert.equal(INPLACE_SHARED.length, 48);
  const file = "agentContentScript.js";
  const base = fs.readFileSync(path.join(EXT, file), "utf8");
  const before = gate(file, scan(base, file)).length;
  for (const { anchor, line } of INPLACE_SHARED) {
    assert.ok(base.includes(anchor), `the anchor is in ${file}: ${anchor}`);
    const after = gate(file, scan(base.replace(anchor, `${anchor}\n${line}`), file));
    assert.ok(after.length > before, `${file} lets through: ${line.trim()}`);
    assert.ok(after.some((f) => /^(id|class)$/.test(f.against)), `the new finding is held against an id or a class: ${line.trim()}`);
  }
  // At least one of the words is allowed in this file for a tag name or a role, so the test is not empty.
  const allowedElse = ALLOW.entries.filter((e) => e.file === file && e.kind === "markup test" && !e.against.some((a) => /^(id|class)$/.test(a)));
  assert.ok(SHARED_WORDS.filter((w) => allowedElse.some((e) => e.what.some((x) => String(x).toLowerCase() === w))).length >= 6, "most of the words are allowed for a tag name or a role");
});

test("a selector made by adding literals is read whole", () => {
  for (const src of ['doc.querySelector("#" + "nav");', 'document.querySelectorAll("." + "nav" + "box");', 'const id = "#" + "main"; el.closest(id);', 'const sel = "#" + "content";', 'document.getElementById("main" + "-content");']) {
    assert.ok(scan(src).some((f) => f.kind === "selector"), src);
  }
  assert.ok(scan('doc.querySelector("#" + "nav");').some((f) => f.what === "#nav" && f.against === "selector"));
  assert.ok(scan('const sel = "#" + "content";').some((f) => f.what === "#content" && f.against === "written"));
});

test("the fifth round's misses are found, apart from the limits the pull request names", () => {
  for (const [src, against] of Object.entries(FIFTH_FOUND)) assert.ok(scan(src).some((f) => f.against === against), `${src} is found, held against ${against}`);
  for (const [src, why] of Object.entries(LIMITS)) {
    assert.deepEqual(scan(src), [], `${src} is a named limit, or it would be found`);
    assert.ok(why.length > 40 && !why.includes("\n"), `${src} has a one-line reason`);
  }
  assert.equal(Object.keys(LIMITS).length, 3);
  // The reserved-host limit is that and no more: a real host in the same pattern is found.
  assert.ok(scan("chrome.tabs.query({ url: '*://*.reddit.com/*' }, cb);").some((f) => f.kind === "host" && f.what === "reddit.com"));
  assert.ok(scan("chrome.tabs.query({ url: '*://*.smallshop.co.uk/*' }, cb);").some((f) => f.kind === "host" && f.what === "smallshop.co.uk"), "a host no list names");
  // Each fifth-round shape fails the full gate in every shipped file.
  const passes = [];
  for (const src of Object.keys(FIFTH_FOUND)) { const found = scanFor(src); for (const file of SHIPPED) if (!WHOLE_FILES.has(file) && !gate(file, found(file)).length) passes.push(`${file}: ${src}`); }
  assert.deepEqual(passes, []);
});

test("a literal an object holds under a property is held against that property", () => {
  const found = scan('const els = [{ id: -1, tagName: "div" }]; const r = 1; if (els.find((e) => e.id === r)) x();').filter((f) => f.what === "div");
  assert.deepEqual(found.map((f) => [f.kind, f.against]), [["markup test", "tag name"]]);
  const byId = scan('const els = [{ id: "nav-main", tagName: "div" }]; const r = 1; if (els.find((e) => e.id === r)) x();');
  assert.ok(byId.some((f) => f.what === "nav-main" && f.against === "id"), "a value under id is still held against id");
  assert.ok(byId.some((f) => f.what === "div" && f.against === "tag name"));
});

test("a literal held against an attribute property is found, by the attribute it reads", () => {
  for (const [src, against] of [
    ['if (el.placeholder === "Search products") x();', "placeholder"],
    ['if (img.alt === "Company logo") x();', "alt"],
    ['if (el.ariaLabel === "Close dialog") x();', "aria-label"],
    ['if (el.role === "navigation") skip();', "role"],
    ['if (a.rel === "nofollow sponsored") x();', "rel"],
    ['if (el.getAttribute("aria-label") === "Basket") x();', "aria-label"],
  ]) assert.ok(scan(src).some((f) => f.kind === "markup test" && f.against === against), `${src} is held against ${against}`);
});

test("an allowlist entry covers one file and one use", () => {
  // The welcome page's suggested sites and the provider hosts, used anywhere else.
  const elsewhere = (src, file) => gate(file, scan(src, file));
  assert.deepEqual(elsewhere('const t = "Summarise the front page of news.ycombinator.com";', "welcome.js"), [], "the welcome page may suggest the site");
  assert.notDeepEqual(elsewhere('const t = "Summarise the front page of news.ycombinator.com";', "agent.js"), [], "no other file may name it");
  assert.notDeepEqual(elsewhere('const t = "Read wikipedia.org";', "agentContentScript.js"), []);
  assert.notDeepEqual(elsewhere('const u = "https://openrouter.ai/api/v1";', "agentContentScript.js"), [], "a provider host outside the provider files");
  // The same name in text and held against an address are two uses.
  assert.notDeepEqual(elsewhere('if (location.hostname.includes("wikipedia")) x();', "welcome.js"), [], "the welcome page may name the site, not test for it");
  assert.notDeepEqual(elsewhere('if (url.startsWith("https://openrouter.ai")) x();', "defaults.js"), [], "the provider list may name its host, not test an address for it");
  // A name a script gives an element is not the extension's own: only its pages and styles say so.
  assert.notDeepEqual(scan('el.className = "navbox"; if (el.classList.contains("navbox")) x();'), []);
  // The same word held against a tag name and against an id are two uses.
  assert.notDeepEqual(elsewhere('if (el.id === "FOOTER") x();', "agentContentScript.js"), [], "an id test is not a tag name test");
  assert.notDeepEqual(elsewhere('if (el.className === "navigation") x();', "agentContentScript.js"), [], "a class test is not a role test");
  // Each entry: one file that ships, one kind, what it is held against, the literals, one reason.
  const seen = new Map();
  for (const e of ALLOW.entries) {
    assert.ok(SHIPPED.includes(e.file), `${e.file} ships`);
    assert.ok(typeof e.kind === "string" && Array.isArray(e.what) && e.what.length, JSON.stringify(e));
    assert.ok(Array.isArray(e.against) && e.against.length === 1 && typeof e.against[0] === "string", `${JSON.stringify(e)} names the one thing it is held against`);
    assert.ok(typeof e.why === "string" && e.why.trim() && !e.why.includes("\n"), `${JSON.stringify(e)} has a one-line reason`);
    for (const w of e.what) {
      const k = `${e.file}|${e.kind}|${e.against[0]}|${w}`;
      assert.ok(!seen.has(k), `${k} is listed for one purpose, not two`);
      seen.set(k, e.why);
    }
  }
});

test("what spells no site is not reported, and the web's own words are still findings", () => {
  const clean = [
    'const a = "https://shop.example/cart"; const b = TOOLS.siteOf(u); // see chrome.tabs.query',
    'const color = "#1a2b3c"; el.style.color = color;',
    'if (s.includes(":") || /^\\d+$/.test(s) || s.indexOf("/") > 0) x();',
    'el.querySelectorAll("div > p, ul li, table td");',
    'if (el.id === "") return;',
  ];
  for (const src of clean) assert.deepEqual(scan(src), [], src);
  // Standard names (a scheme, a tag, a role, an ARIA attribute) and the
  // extension's own prefix are still findings: each file's allowlist entry
  // says why it is there, and nothing is let through by a built-in list.
  const found = [
    'if (u.protocol === "https:" || /^chrome:\\/\\//.test(url)) return;',
    'const TAGS = new Set(["SCRIPT", "STYLE"]); if (TAGS.has(el.tagName)) skip();',
    'if (/^(button|link|menuitem)$/.test(el.getAttribute("role") || "")) return;',
    "const box = el.closest('[role=\"dialog\"], [aria-modal=\"true\"]');",
    "if (n.id && /^select-to-ai-/.test(n.id)) return null;",
    'if (url.endsWith("/") || /^www\\./.test(host)) x();',
    'if (el.tagName === "INPUT" || el.matches("input, textarea, [contenteditable]")) x();',
    'if (host === "localhost" || host.endsWith(".local")) return true;',
  ];
  for (const src of found) assert.notDeepEqual(scan(src), [], src);
});

test("no file the extension ships holds a finding its allowlist entries do not cover", () => {
  for (const f of ["background.js", "engine.js", "agentTools.js", "agentContentScript.js", "core/context.js", "core/run.js", "pageSearch.js", "defaults.js", "agent.js", "options.js", "welcome.js", "config.js"]) assert.ok(SHIPPED.includes(f), `${f} is scanned`);
  const hits = [];
  const used = new Set();
  for (const file of SHIPPED) {
    if (WHOLE_FILES.has(file)) continue;
    for (const f of scan(fs.readFileSync(path.join(EXT, file), "utf8"), file)) {
      if (covered(file, f)) { used.add(`${file}|${f.kind}|${f.against}|${f.what}`); continue; }
      hits.push(`${file}:${f.line}: ${f.kind} [${f.against}] ${f.what}`);
    }
  }
  assert.deepEqual(hits, []);
  // Every listed literal is still needed.
  const stale = ALLOW.entries.flatMap((e) => e.what.map((w) => `${e.file}|${e.kind}|${e.against[0]}|${w}`)).filter((k) => !used.has(k));
  assert.deepEqual(stale, [], "allowlist literals nothing uses");
});

test("the one whole file allowed is the generated Public Suffix List and nothing else", () => {
  assert.deepEqual([...WHOLE_FILES], ["publicSuffixes.js"]);
  const src = fs.readFileSync(path.join(EXT, "publicSuffixes.js"), "utf8");
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  const data = [];
  (function visit(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Literal" && typeof n.value === "string" && n.value.length > 1000) data.push(n);
    for (const k of Object.keys(n)) { const c = n[k]; if (Array.isArray(c)) c.forEach(visit); else if (c && typeof c.type === "string") visit(c); }
  })(ast);
  assert.equal(data.length, 1, "one data string");
  assert.ok(data[0].value.split("\n").every((l) => /^[a-z0-9-]+:[a-z0-9*!|.-]*$/.test(l)), "the string is the list's lines");
  const code = src.slice(src.indexOf("*/") + 2, data[0].start) + "DATA" + src.slice(data[0].end);
  assert.equal(code, "\n(function initPublicSuffixes(root) {\n  \"use strict\";\n  const data = DATA;\n  root.SELECT_TO_AI_PSL = data;\n  if (typeof module !== \"undefined\" && module.exports) module.exports = data;\n})(typeof globalThis !== \"undefined\" ? globalThis : this);\n");
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
  for (const file of SHIPPED) {
    const src = fs.readFileSync(path.join(EXT, file), "utf8");
    for (const id of ids) if (new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(src)) hits.push(`${file}: ${id}`);
  }
  assert.deepEqual(hits, []);
});
