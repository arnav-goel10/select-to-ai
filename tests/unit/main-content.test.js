"use strict";
// The main content of a page with no landmark, found from structure alone:
// a part is taken only when it holds at least 80 percent of all the text a
// reader can see on the page, link text counted as text, and otherwise the
// whole page is read. The pages are whole HTML files
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
// The seeable test is the content script's own (drawnState). The small DOM
// has no layout, so a box is unseeable when its inline style folds it to no
// height, and no text is drawn in invisible ink.
const pickMain = new Function("getComputedStyle", [
  ...["UNREAD_TAGS"].map(constLine),
  "const boxUnseeable = (el) => !!el.folded;",
  "const textUnseeable = () => false;",
  source("drawnState"), source("seenTextCounts"), source("pickMain"), "return pickMain;",
].join("\n"))((el) => ({ display: (el.style && el.style.display) || "block" }));
const seenTextCounts = new Function("getComputedStyle", [
  constLine("UNREAD_TAGS"),
  "const boxUnseeable = (el) => !!el.folded;",
  "const textUnseeable = () => false;",
  source("drawnState"), source("seenTextCounts"), "return seenTextCounts;",
].join("\n"))((el) => ({ display: (el.style && el.style.display) || "block" }));
// The share of the page's seeable text a part holds.
const seen = (doc, part) => { const { chars } = seenTextCounts(doc.body); return (chars.get(part) || 0) / (chars.get(doc.body) || 1); };

const flat = (s) => String(s || "").replace(/\s+/g, " ");

for (const c of CASES) {
  test(`main content with no landmark: ${c.shape}`, () => {
    const doc = parseHTML(html(c.file));
    assert.ok(doc.body, `${c.file} has a body`);
    assert.equal(doc.querySelector("main, [role=\"main\"], article"), null, `${c.file} has no landmark to go by`);
    const main = pickMain(doc);
    if (c.whole) assert.equal(main, null, `${c.file}: no part holds 80 percent of the page, so the whole page is read (${main && main.tagName})`);
    else assert.ok(main, `${c.file}: a main area is found`);
    if (main) assert.ok(seen(doc, main) >= 0.8, `${c.file}: the part taken holds 80 percent of the seeable text`);
    // A page that hides text is read as it is drawn, as the reader reads it.
    const reading = flat(c.drawn ? (main || doc.body).innerText : (main || doc.body).textContent);
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
  for (const name of ["seenTextCounts", "pickMain"]) assert.doesNotMatch(source(name), /['"][#.][a-z]/i, `${name} has no class or id selector`);
  // The extension's own badge layer is the one id it knows, and it is its own.
  const ids = [...source("seenTextCounts").matchAll(/\.id\s*===\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["select-to-ai-overlay-container"]);
});

test("text that is not drawn weighs nothing: a hidden dialog with more words than the story is never the page", () => {
  const doc = parseHTML(html("hidden-dialog.html"));
  const dialog = doc.querySelector("[role=\"dialog\"]");
  const story = doc.querySelector(".story");
  assert.ok(dialog && /Consent purpose 24/.test(dialog.textContent), "the fixture's dialog holds its text");
  assert.ok(dialog.textContent.length > story.textContent.length, "and more of it than the story");
  const main = pickMain(doc);
  assert.ok(!main || (!dialog.contains(main) && !main.contains(dialog)), `the reading is not taken from the hidden dialog (${main && main.tagName})`);
  assert.match(flat((main || doc.body).innerText), /opened again on Saturday morning/);
  // The same page with the dialog shown: its words are seen now, and the
  // story no longer holds most of the page, so the whole page is read.
  const shown = parseHTML(html("hidden-dialog.html").replace('style="display:none" role="dialog"', 'role="dialog"'));
  const picked = pickMain(shown);
  assert.ok(!picked || picked.contains(shown.querySelector("[role=\"dialog\"]")), `a shown dialog is weighed as text (${picked && picked.tagName})`);
});

test("a part is taken only when it holds 80 percent of what can be seen, link text counted, and never a paragraph beside a listing", () => {
  // Each link-led page through pickMain: whatever is picked holds 80 percent
  // of the page's drawn text, or the whole page is read.
  for (const file of ["link-aggregator.html", "board-index.html", "category-grid.html", "file-directory.html", "cart.html"]) {
    const doc = parseHTML(html(file));
    const main = pickMain(doc);
    if (!main) continue;
    assert.notEqual(main.tagName, "P", `${file}: a lone paragraph is not the page`);
    assert.ok(seen(doc, main) >= 0.8, `${file}: the part read holds 80 percent of the page (${main.tagName}.${main.className})`);
  }
  // A stray paragraph beside a long list of bare links: the list is the page.
  const links = Array.from({ length: 40 }, (_, i) => `<li><a href="/t/${i}">Thread title number ${i} about the spring sowing</a></li>`).join("");
  const para = `<p>${"Please read the house rules before posting, and keep to one question per topic so others can find it. ".repeat(3)}</p>`;
  const listing = parseHTML(`<html><body>${para}<ul>${links}</ul></body></html>`);
  const main = pickMain(listing);
  assert.ok(!main || /Thread title number 39/.test(main.textContent), "the listing is read");
  // A paragraph longer than a list of links beside it is not the page
  // either, unless it holds 80 percent of the text: the links count.
  const few = Array.from({ length: 12 }, (_, i) => `<li><a href="/s/${i}">Section ${i}: plot letting and the waiting list</a></li>`).join("");
  const longer = `<p>${"Members share a tool shed, two water troughs and a compost bay through the summer months. ".repeat(6)}</p>`;
  assert.equal(pickMain(parseHTML(`<html><body>${longer}<ul>${few}</ul></body></html>`)), null, "a paragraph at about half the page is not taken");
  // Cart lines in boxes or in a table, beside a terms paragraph.
  const terms = `<div class="legal"><p>${"Prices include tax and orders before two ship the same day, with a full refund at any time before it is sent. ".repeat(2)}</p></div>`;
  const boxes = [1, 2, 3].map((i) => `<div class="line"><a href="/p${i}">Enamel kettle ${i}</a> <span>Qty</span> <input value="1"> <span>$${i}9.00</span> <button>Remove</button></div>`).join("");
  const cells = [1, 2, 3].map((i) => `<tr><td><a href="/p${i}">Enamel kettle ${i}</a></td><td><input value="1"></td><td>$${i}9.00</td><td><button>Remove</button></td></tr>`).join("");
  for (const lines of [boxes, `<table>${cells}</table>`]) {
    const cart = parseHTML(`<html><body><div><a href="/">Shop</a></div><div class="cart">${lines}<div>Total $87.00</div><button>Checkout</button></div>${terms}</body></html>`);
    const picked = pickMain(cart);
    assert.ok(!picked || /Total \$87\.00/.test(picked.textContent), `the cart lines and total are read (${picked && picked.tagName})`);
  }
});

test("a column holding 80 percent of the page is taken, and nothing but the text a reader sees is weighed", () => {
  // The same list of links is left out beside a long column of text that
  // holds 80 percent of the page, and keeps the whole page when it is more
  // than a fifth of it.
  const column = `<div>${Array.from({ length: 10 }, (_, i) => `<p>Paragraph ${i} of a long article about field drains and the way water finds the lowest ground in a wet season.</p>`).join("")}</div>`;
  const list = `<div>${Array.from({ length: 8 }, (_, i) => `<div><a href="/a/${i}">Archive month ${i}</a></div>`).join("")}</div>`;
  const prose = parseHTML(`<html><body>${column}${list}</body></html>`);
  const main = pickMain(prose);
  assert.ok(main && /Paragraph 9/.test(main.textContent) && !/Archive month 3/.test(main.textContent), "beside a column holding 80 percent, the list is left out");
  const bigList = `<div>${Array.from({ length: 40 }, (_, i) => `<div><a href="/a/${i}">Archive month ${i}</a></div>`).join("")}</div>`;
  assert.equal(pickMain(parseHTML(`<html><body>${column}${bigList}</body></html>`)), null, "a list more than a fifth of the page keeps the whole page");
  for (const name of ["seenTextCounts", "pickMain"]) {
    assert.equal(source(name).includes("className"), false, `${name} reads no class`);
    assert.doesNotMatch(source(name), /menu|links\.get|controls|setAside|widen/i, `${name} sets nothing aside`);
  }
});
