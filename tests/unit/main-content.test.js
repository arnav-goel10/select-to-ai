"use strict";
// A page with no landmark (no <main>, no role="main") is read whole, as on
// main: no part of it is taken from a guess, so no short line beside a
// larger part is lost. The pages are whole HTML files
// (tests/fixtures/main-content), parsed as a browser parses them, with the
// whitespace, scripts, cookie notices and stray words real pages carry. The
// browser test reads the same files through the real content script.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("../helpers/mini-dom.js");
const { CASES, html } = require("../fixtures/main-content/cases.js");

const CONTENT = fs.readFileSync(path.join(__dirname, "../../extension/agentContentScript.js"), "utf8");
const source = (name) => {
  const start = CONTENT.indexOf(`    function ${name}(`);
  assert.ok(start > 0, `${name} is in agentContentScript.js`);
  return CONTENT.slice(start, CONTENT.indexOf("\n    }\n", start) + 6);
};
const pickMain = new Function(`${source("pickMain")}\nreturn pickMain;`)();

const flat = (s) => String(s || "").replace(/\s+/g, " ");

test("the fixtures cover every shape the lead and the reviewer named", () => {
  assert.equal(CASES.length, 30);
  assert.equal(new Set(CASES.map((c) => c.file)).size, CASES.length, "no page twice");
  for (const c of CASES) assert.ok(c.read.length >= 3, `${c.file} names the lines it must read`);
});

for (const c of CASES) {
  test(`with no landmark the whole page is read: ${c.shape}`, () => {
    const doc = parseHTML(html(c.file));
    assert.ok(doc.body, `${c.file} has a body`);
    assert.equal(doc.querySelector("main, [role=\"main\"]"), null, `${c.file} has no landmark to go by`);
    assert.equal(pickMain(doc), null, `${c.file}: no part is taken, so the whole page is read`);
    const reading = flat(doc.body.innerText);
    for (const phrase of [...c.read, ...(c.controls || [])]) assert.ok(reading.includes(phrase), `${c.file}: "${phrase}" is read`);
    for (const phrase of c.hidden || []) assert.ok(!reading.includes(phrase), `${c.file}: "${phrase}" is not drawn, so it is not read`);
  });
}

test("a short line beside a part that holds nearly all the page is still read", () => {
  // The /pinned-header shape: a status line above thirty rows. The rows hold
  // more than 90 percent of the text, and the line is what tells the agent
  // its click worked.
  const doc = parseHTML(html("status-line.html"));
  const rows = doc.querySelector(".rows");
  assert.ok(flat(rows.textContent).length > 0.9 * flat(doc.body.textContent).trim().length, "the rows hold nearly all of it");
  assert.equal(pickMain(doc), null);
  assert.match(flat(doc.body.innerText), /Opened: Lunch on Friday/);
});

test("a page's own <main> or role=\"main\" is still taken, as on main", () => {
  const long = "The council meets on the first Monday of each month in the old school hall, and anyone may come. ".repeat(4);
  const declared = parseHTML(`<html><body><div>Menu</div><main><p>${long}</p></main><div>Footer</div></body></html>`);
  assert.equal(pickMain(declared), declared.querySelector("main"));
  const role = parseHTML(`<html><body><div>Menu</div><div role="main"><p>${long}</p></div></body></html>`);
  assert.equal(pickMain(role), role.querySelector("[role=\"main\"]"));
  // A landmark with almost nothing in it is passed over, as on main, and
  // then the whole page is read.
  const tiny = parseHTML(`<html><body><main><p>Loading</p></main><div><p>${long}</p></div></body></html>`);
  assert.equal(pickMain(tiny), null);
});

test("with no landmark nothing is guessed: no article, no id or class, no share of the text", () => {
  const long = "Paragraph text about the society's water butts and the rota for the shared shed. ".repeat(6);
  // An <article> is not a landmark: a listing has one per card.
  const cards = parseHTML(`<html><body><p>3 cards shown</p><article><p>${long}</p></article><article><p>Card two</p></article></body></html>`);
  assert.equal(pickMain(cards), null);
  // Names a site gives its parts are not read.
  const named = parseHTML(`<html><body><div>Saved.</div><div id="content" class="main-content"><p>${long}</p></div></body></html>`);
  assert.equal(pickMain(named), null);
  const src = source("pickMain");
  assert.doesNotMatch(src, /['"][#.][a-z]/i, "no class or id selector");
  assert.doesNotMatch(src, /article|className|\.id\b|0\.\d|percent|innerText\.length\s*\//, "no guess from structure or share");
  assert.deepEqual([...src.matchAll(/querySelector\(/g)].length, 1, "one landmark lookup");
});
