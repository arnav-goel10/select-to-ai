"use strict";
// Reading what a page shows when it is long, drawn by web components, or
// carried by attributes. In the 17 Nov trial the agent could see these on
// screen and not read them as text:
// - RFC 9110: the section ids come from the titles, so section 6.4
//   "Content" has id="content", and that one section was taken for the
//   page's main content. The text was also cut at 80,000 characters, and
//   section 15.5.19 starts near character 387,000. find matched only the
//   table of contents, and a hit on a heading gave 360 characters of it.
// - caniuse: "Global 96.09%" is drawn inside a web component's shadow
//   root, which innerText (the plain reading) does not reach.
// - Books to Scrape: a book's rating is only the class "star-rating Three"
//   on an empty paragraph of star icons.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PAGE = require("../../extension/pageSearch.js");
const PROMPT = require("../../extension/agentPrompt.js");

const CONTENT = fs.readFileSync(path.join(__dirname, "../../extension/agentContentScript.js"), "utf8");

/** The source of one top-level function of the content script, by name. */
function source(name) {
  const start = CONTENT.indexOf(`    function ${name}(`);
  assert.ok(start > 0, `${name} is in agentContentScript.js`);
  const end = CONTENT.indexOf("\n    }\n", start);
  return CONTENT.slice(start, end + 6);
}

/** One top-level const line of the content script, by name. */
function constLine(name) {
  const m = new RegExp(`^    const ${name} = .*$`, "m").exec(CONTENT);
  assert.ok(m, `${name} is in agentContentScript.js`);
  return m[0];
}

/** A fake element with the parts of the DOM these helpers use. */
function el(tag, o = {}) {
  const attrs = o.attrs || {};
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), innerText: o.text || "", textContent: o.text || "",
    className: attrs.class || "", shadowRoot: o.shadowRoot || null, children: o.children || [],
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    querySelectorAll: () => o.all || [],
    querySelector: (sel) => (o.find ? o.find(sel) : null),
    closest: (sel) => (o.closest ? o.closest(sel) : null),
  };
  return node;
}

test("a guessed main area that holds a small share of the page is not taken for the page", () => {
  const pickMain = new Function(`${constLine("MAIN_SELECTORS")}\n${source("pickMain")}\nreturn pickMain;`)();
  const section = el("div", { text: "6.4. Content ".repeat(400) });
  const doc = { body: { innerText: "x".repeat(500000) }, querySelector: (sel) => (sel === "#content" ? section : null) };
  assert.equal(pickMain(doc), null, "the RFC's section 6.4 (id=content) is not the main content");

  const main = el("main", { text: "short main ".repeat(30) });
  const declared = { body: { innerText: "x".repeat(500000) }, querySelector: (sel) => (sel === "main" ? main : null) };
  assert.equal(pickMain(declared), main, "a page's own <main> is still taken");

  const wiki = el("div", { text: "article text ".repeat(3000) });
  const article = { body: { innerText: "y".repeat(50000) }, querySelector: (sel) => (sel === "#mw-content-text" ? wiki : null) };
  assert.equal(pickMain(article), wiki, "a guessed area holding most of the page is still taken");
});

test("the page text kept for find and read reaches deep into a long document", () => {
  const limit = Number((/const PAGE_TEXT_LIMIT = (\d+);/.exec(CONTENT) || [])[1]);
  assert.ok(limit >= 600000, `kept text is at least 600,000 characters (is ${limit})`);
  const extract = source("extractPageContent");
  assert.ok(!/80000/.test(extract), "no 80,000 character cap is left in extractPageContent");
});

test("text drawn inside open shadow roots is part of the plain reading", () => {
  const shadowText = new Function("seenText", `${source("shadowText")}\nreturn shadowText;`)((n) => n.innerText);
  const innerHost = el("ciu-feature-usage", { shadowRoot: { children: [el("style", { text: ":host{}" }), el("ul", { text: "Global usage\n96.09%" })], querySelectorAll: () => [] } });
  const outerRoot = { children: [el("header", { text: ":has() CSS relational pseudo-class" })], querySelectorAll: () => [innerHost] };
  const outerHost = el("ciu-feature", { shadowRoot: outerRoot });
  const body = el("body", { all: [outerHost] });
  const text = shadowText(body);
  assert.match(text, /96\.09%/, "the usage figure inside a nested component is read");
  assert.match(text, /relational pseudo-class/, "the outer component's own text is read");
  assert.doesNotMatch(text, /:host/, "style sheets inside a shadow root are not text");
});

test("a rating carried only by an attribute is read as text", () => {
  const markedMeaning = new Function(`${constLine("RATING_CLASS")}\n${constLine("VALUE_TOKEN")}\n${source("markedMeaning")}\nreturn markedMeaning;`)();
  assert.equal(markedMeaning(el("p", { attrs: { class: "star-rating Three" } })), 'class "star-rating Three"');
  assert.equal(markedMeaning(el("i", { attrs: { class: "a-icon a-star-4-5" } })), 'class "a-icon a-star-4-5"');
  assert.equal(markedMeaning(el("div", { attrs: { role: "img", "aria-label": "4.5 out of 5 stars" } })), "4.5 out of 5 stars");
  assert.equal(markedMeaning(el("span", { attrs: { title: "Supported" } })), "Supported");
  assert.equal(markedMeaning(el("i", { attrs: { class: "icon-star" } })), "", "a star icon with no value says nothing");
  assert.equal(markedMeaning(el("p", { text: "Three stars", attrs: { class: "star-rating Three" } })), "", "words the element shows speak for it");
  assert.equal(markedMeaning(el("a", { attrs: { "aria-label": "Home" } })), "", "controls are listed with their names, not read as text");
  assert.equal(markedMeaning(el("img", { attrs: { title: "cover" } })), "", "pictures are read as media");
  assert.equal(markedMeaning(el("div", { attrs: { class: "layout main" } })), "");
});

test("the markdown walk uses the attribute meaning for empty elements", () => {
  const walk = source("extractMarkdown");
  assert.match(walk, /markedMeaning\(el\)/, "a block with no words but a meaning is pushed");
  assert.match(walk, /inlineOrMarked\(child\)/, "an inline child with no words but a meaning joins its line");
});

test("the address's #fragment names the heading of the section it points to", () => {
  const anchorHeading = new Function(`${source("anchorHeading")}\nreturn anchorHeading;`)();
  const h4 = el("h4", { text: "15.5.19. 418 (Unused)" });
  const doc = { getElementById: (id) => (id === "name-418-unused" ? h4 : null), getElementsByName: () => [] };
  assert.equal(anchorHeading(doc, "#name-418-unused"), "15.5.19. 418 (Unused)");
  const section = el("section", { find: () => h4 });
  const byId = { getElementById: (id) => (id === "section-15.5.19" ? section : null), getElementsByName: () => [] };
  assert.equal(anchorHeading(byId, "#section-15.5.19"), "15.5.19. 418 (Unused)", "a section's id leads to its heading");
  assert.equal(anchorHeading(doc, ""), "");
  assert.equal(anchorHeading(doc, "#nothing-here"), "");
});

// A long document's reading, shaped like RFC 9110: a table of contents, a
// great deal of text, then the section that was asked about.
const SECTION = [
  "#### 15.5.19. 418 (Unused)",
  "[RFC2324] was an April 1 RFC that lampooned the various ways HTTP was abused; one such abuse was the definition of an application-specific 418 status code, which has been deployed as a joke often enough for the code to be unusable for any future use.",
  "Therefore, the 418 status code is reserved in the IANA HTTP Status Code Registry. This indicates that the status code cannot be assigned to other applications currently. If future circumstances require its use (e.g., exhaustion of 4NN status codes), it can be re-assigned to another use.",
].join("\n");
const LONG = [
  "# HTTP Semantics",
  "## Table of Contents",
  "- 15.5.18. 417 (Expectation Failed)",
  "- 15.5.19. 418 (Unused)",
  "- 15.5.20. 421 (Misdirected Request)",
  ...Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} about message semantics, fields, and content negotiation in general terms.`),
  "#### 15.5.18. 417 (Expectation Failed)",
  "The 417 (Expectation Failed) status code indicates that the expectation could not be met.",
  SECTION,
  "#### 15.5.20. 421 (Misdirected Request)",
  "The 421 (Misdirected Request) status code indicates that the request was directed at a server that is unable to produce a response.",
].join("\n");

test("find on a heading gives the whole section under it, not only its first lines", () => {
  const hits = PAGE.findInText(LONG, "418 (Unused)", { maxHits: 4, budget: 2400 });
  const section = hits.find((h) => h.includes("#### 15.5.19. 418 (Unused)"));
  assert.ok(section, "the section heading is one of the hits");
  assert.match(section, /cannot be assigned to other applications currently/, "the section's second paragraph comes with it");
  assert.doesNotMatch(section, /421 \(Misdirected Request\) status code/, "it stops at the next section");
  assert.ok(hits.some((h) => h.includes("- 15.5.19. 418 (Unused)")), "the contents entry is still a hit");
});

test("a heading that shares only some of the words is not expanded into its section", () => {
  const text = [
    "# Garden Supplies",
    `## ${"Everything for the outdoor season, from planting and pruning to watering and storage. ".repeat(3)}`,
    `${"Our yard range is chosen for long use in all weather. ".repeat(3)}Garden Hose, 30 m, $24.99. ${"Every item ships within two working days. ".repeat(6)}`,
  ].join("\n");
  const hits = PAGE.findInText(text, "Garden Hose", { maxHits: 4, budget: 2400 });
  assert.ok(hits.some((h) => h.includes("Garden Hose, 30 m, $24.99")), "the passage with both words is a hit");
  assert.ok(!hits.some((h) => h.includes("# Garden Supplies") && h.includes("$24.99")), "the top heading was not widened into the whole page");
});

test("a page opened at a #fragment shows the section it points to, however far down", () => {
  const page = { url: "https://www.rfc-editor.org/rfc/rfc9110.html#name-418-unused", innerText: LONG, anchor: "15.5.19. 418 (Unused)" };
  const shown = PROMPT.composePageText(page, "What does this document say about status code 418?", 3600, {});
  assert.match(shown, /The part of the page the address points to \(#name-418-unused\)/);
  assert.match(shown, /reserved in the IANA HTTP Status Code Registry/);
  assert.equal(PROMPT.anchorSection(LONG, "no such heading", 1600), "");
  const cut = PROMPT.anchorSection(LONG, "15.5.19. 418 (Unused)", 1600);
  assert.ok(!cut.includes("421"), "the anchored section stops at the next heading of its level");
});
