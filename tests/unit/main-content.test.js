"use strict";
// The main content of a page with no landmark, found from structure alone:
// how much of each part is links, controls or a label stamped on every item,
// against how much is the page's own words. The pages are whole HTML files
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
const constLine = (name) => {
  const m = new RegExp(`^    const ${name} = .*$`, "m").exec(CONTENT);
  assert.ok(m, `${name} is in agentContentScript.js`);
  return m[0];
};
const pickMain = new Function([
  ...["BOILERPLATE", "INLINE_TAGS", "CONTROL_TAGS", "UNREAD_TAGS", "DATA_TAGS"].map(constLine),
  source("textBlocks"), source("pickMain"), "return pickMain;",
].join("\n"))();

const flat = (s) => String(s || "").replace(/\s+/g, " ");

for (const c of CASES) {
  test(`main content with no landmark: ${c.shape}`, () => {
    const doc = parseHTML(html(c.file));
    assert.ok(doc.body, `${c.file} has a body`);
    assert.equal(doc.querySelector("main, [role=\"main\"], article"), null, `${c.file} has no landmark to go by`);
    const main = pickMain(doc);
    if (c.notRead.length) assert.ok(main, `${c.file}: a main area is found`);
    const reading = flat((main || doc.body).textContent);
    for (const phrase of c.read) assert.ok(reading.includes(phrase), `${c.file}: "${phrase}" is in the main content (${main ? `${main.tagName}.${main.className}` : "whole page"})`);
    for (const phrase of c.notRead) assert.ok(!reading.includes(phrase), `${c.file}: "${phrase}" is not in the main content (${main ? `${main.tagName}.${main.className}` : "whole page"})`);
  });
}

test("words added beside the page, by the extension or by the site, do not widen the reading to the whole page", () => {
  // The scan puts its numbered badges in a layer at the end of the body, and
  // sites add banners and status lines there too. The browser fixture failed
  // on exactly this while a stripped fake page passed.
  const badges = `<div id="select-to-ai-overlay-container">${Array.from({ length: 40 }, (_, i) => `<div class="select-to-ai-badge">${i + 1}</div>`).join("")}</div>`;
  const stray = "<div>You are reading this page as a guest.</div>";
  const doc = parseHTML(html("wrapped-column.html").replace("</body>", `${badges}\n${stray}\n</body>`));
  const main = pickMain(doc);
  assert.ok(main, "a main area is found");
  assert.match(flat(main.textContent), /Mosses grow on stone 120\./);
  assert.doesNotMatch(flat(main.textContent), /Related page number 7\b|reading this page as a guest/);
});

test("the small DOM keeps what a browser's parser keeps", () => {
  // A unit test that strips whitespace, scripts and stray words passes on a
  // page no browser ever shows. These are the parts the reader must cope with.
  const doc = parseHTML(html("blog-sidebar.html"));
  const body = doc.body;
  assert.ok(body.childNodes.some((n) => n.nodeType === 3 && !n.textContent.trim()), "whitespace text between tags is kept");
  assert.ok(body.children.some((n) => n.tagName === "SCRIPT"), "a script in the body is kept");
  assert.ok(body.children.some((n) => /cookie/.test(n.textContent)), "the cookie notice after the page is kept");
  assert.match(body.textContent, /Bees at the bottom of the lane/);
});

test("the reader goes by structure, with no class or id of any site", () => {
  for (const name of ["textBlocks", "pickMain"]) assert.doesNotMatch(source(name), /['"][#.][a-z]/i, `${name} has no class or id selector`);
  // The extension's own badge layer is the one id it knows, and it is its own.
  const ids = [...source("textBlocks").matchAll(/\.id\s*===\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["select-to-ai-overlay-container"]);
});
