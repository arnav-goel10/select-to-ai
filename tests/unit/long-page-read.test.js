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
//   root, which innerText (the plain reading) does not reach. The plain
//   reading was the one used: the find hits in the trial log carry footer
//   text, which the Markdown walk never reads. The walk did read the
//   component, but lost to the plain reading on the footer's words.
// A rating drawn as icons is read from its accessible name (aria-label,
// aria-labelledby, title), as a screen reader reads it; a class name is not
// read as a meaning. The main content is found from the page's structure,
// with no class or id of any site.
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

const MEANING_SRC = source("markedMeaning");

test("a rating drawn as icons is read from its accessible name, and never from its class", () => {
  const markedMeaning = new Function(`${MEANING_SRC}\nreturn markedMeaning;`)();
  assert.equal(markedMeaning(el("div", { attrs: { role: "img", "aria-label": "4.5 out of 5 stars" } })), "4.5 out of 5 stars");
  assert.equal(markedMeaning(el("span", { attrs: { title: "Supported" } })), "Supported");
  const named = el("p", { attrs: { "aria-labelledby": "r1" } });
  named.ownerDocument = { getElementById: (id) => (id === "r1" ? { textContent: "Rated 3 of 5" } : null) };
  assert.equal(markedMeaning(named), "Rated 3 of 5", "aria-labelledby names it by another element's text");
  // A class is what a site calls its style. It is not read, whatever it says.
  for (const cls of ["star-rating Three", "a-icon a-star-4-5", "rating-45", "icon-star", "score-panel mt-2", "layout main"]) {
    assert.equal(markedMeaning(el("p", { attrs: { class: cls } })), "", cls);
  }
  assert.equal(markedMeaning(el("p", { text: "Three stars", attrs: { "aria-label": "3 stars" } })), "", "words the element shows speak for it");
  assert.equal(markedMeaning(el("div", { attrs: { "aria-hidden": "true", "aria-label": "decoration" } })), "", "what is hidden from a screen reader is not read");
  assert.equal(markedMeaning(el("a", { attrs: { "aria-label": "Home" } })), "", "controls are listed with their names, not read as text");
  assert.equal(markedMeaning(el("img", { attrs: { title: "cover" } })), "", "pictures are read as media");
  assert.doesNotMatch(MEANING_SRC, /class/i, "the function reads no class");
});

// A small DOM for running the Markdown walk itself: elements with child
// nodes, laid-out text (block children on their own lines), attributes,
// open shadow roots, and the few selectors the walk asks for.
const INLINE = new Set(["SPAN", "A", "I", "B", "STRONG", "EM", "CODE", "LABEL", "IMG", "X-WIDGET"]);
function textNode(t) { return { nodeType: 3, textContent: t }; }
function h(tag, attrs, ...kids) {
  const nodes = kids.flat().map((k) => (typeof k === "string" ? textNode(k) : k));
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: nodes, attrs: attrs || {}, shadowRoot: null, parentElement: null,
    get children() { return nodes.filter((n) => n.nodeType === 1); },
    get firstElementChild() { return this.children[0] || null; },
    get className() { return this.attrs.class || ""; },
    get alt() { return this.attrs.alt || ""; },
    get title() { return this.attrs.title || ""; },
    get display() { return this.attrs.display || (INLINE.has(this.tagName) ? "inline" : "block"); },
    get innerText() {
      let out = "";
      for (const n of nodes) {
        if (n.nodeType === 3) { out += n.textContent; continue; }
        const t = n.innerText;
        out += n.display === "block" ? `\n${t}\n` : t;
      }
      return out.replace(/\n+/g, "\n").replace(/^\n|\n$/g, "");
    },
    get textContent() { return this.innerText; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); },
    contains(o) { return o === this || this.descendants().includes(o); },
    closest(sel) { const tags = sel.split(",").map((x) => x.trim().toUpperCase()); for (let n = this; n; n = n.parentElement) if (tags.includes(n.tagName)) return n; return null; },
    querySelectorAll(sel) {
      const all = this.descendants();
      if (sel === "*") return all;
      if (sel === "img") return all.filter((n) => n.tagName === "IMG");
      if (sel === "a") return all.filter((n) => n.tagName === "A");
      if (/:scope > ul/.test(sel)) return this.children.filter((n) => /^(UL|OL)$/.test(n.tagName));
      if (/\[aria-label\]/.test(sel)) return all.filter((n) => n.hasAttribute("aria-label") || n.hasAttribute("aria-labelledby") || n.hasAttribute("title"));
      throw new Error(`selector not in the fake DOM: ${sel}`);
    },
    // Tag and role selectors only: the reader asks for nothing else.
    matches(sel) {
      return sel.split(",").map((x) => x.trim()).some((one) => {
        const role = /^\[role="([a-z]+)"\]$/.exec(one);
        if (role) return this.attrs.role === role[1];
        if (/^\[aria-hidden="true"\]$/.test(one)) return this.attrs["aria-hidden"] === "true";
        if (/^[a-z]+$/.test(one)) return this.tagName === one.toUpperCase();
        throw new Error(`selector not in the fake DOM: ${one}`);
      });
    },
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ width: 200, height: 200, top: 0, bottom: 200, left: 0, right: 200 }),
  };
  for (const k of node.children) k.parentElement = node;
  return node;
}
function withShadow(host, ...kids) { host.shadowRoot = { children: kids }; return host; }
const extractMarkdown = new Function("getComputedStyle", "window", [
  MEANING_SRC,
  constLine("SKIP_TAGS"),
  "const seenText = (el) => el.innerText;",
  "const textUnseeable = () => false;",
  "const boxUnseeable = () => false;",
  "const ownsText = (el) => el.childNodes.some((n) => n.nodeType === 3 && n.textContent.trim());",
  source("extractMarkdown"),
  "return extractMarkdown;",
].join("\n"))((n) => ({ display: n.display, position: "static" }), { scrollX: 0, scrollY: 0 });
const md = (root) => extractMarkdown(root, 100000).markdown;

test("a listing card's rating is read with the card from its accessible name, and a class-only rating is not guessed", () => {
  const card = (title, price, rating) => h("li", { class: "col-xs-6" },
    h("article", { class: "product_pod" },
      h("div", { class: "image_container" }, h("a", { href: "#" }, h("img", { alt: title }))),
      h("p", rating, h("i", { class: "icon-star" }), h("i", { class: "icon-star" })),
      h("h3", {}, h("a", { href: "#" }, title)),
      h("div", { class: "product_price" }, h("p", { class: "price_color" }, price), h("p", { class: "instock availability" }, "In stock"))));
  const text = md(h("section", {}, h("ol", { class: "row" },
    card("A Light in the Attic", "£51.77", { role: "img", "aria-label": "3 out of 5 stars" }),
    card("Tipping the Velvet", "£53.74", { class: "star-rating One" }))));
  const lines = text.split("\n");
  const attic = lines.find((l) => l.includes("A Light in the Attic"));
  assert.ok(attic, text);
  assert.match(attic, /3 out of 5 stars/, `the rating is on the card's own line: ${attic}`);
  const velvet = lines.find((l) => l.includes("Tipping the Velvet"));
  assert.ok(velvet && /53\.74/.test(velvet), text);
  assert.doesNotMatch(text, /star-rating|class "/, "a class name is not read as a rating");
});

test("a label on an element does not hide what is inside it", () => {
  const gallery = md(h("div", {}, h("div", { "aria-label": "Product images" }, h("img", { alt: "Front cover of the book" }))));
  assert.match(gallery, /\[Product images\]/, "the label is read");
  assert.match(gallery, /\[image: Front cover of the book\]/, "and so are the pictures under it");

  const widget = withShadow(h("x-widget", { "aria-label": "Usage" }), h("ul", {}, h("li", {}, h("h4", {}, "Global"), h("span", { class: "support", title: "96.09% Supported" }, "96.09%"))));
  const usage = md(h("div", {}, widget));
  assert.match(usage, /Global 96\.09%/, `a labelled web component's shadow content is read: ${usage}`);

  const stars = md(h("div", {}, h("p", { role: "img", "aria-label": "4 out of 5 stars" }, h("i", { class: "icon-star" }))));
  assert.equal((stars.match(/4 out of 5 stars/g) || []).length, 1, `an empty rating is read once: ${stars}`);
});

// What the walk reads does not depend on a class: a box of links, a list of
// notes, a block a site calls "reference" or "toc" is read like any other,
// and a number in brackets is the page's own text.
test("the Markdown walk reads blocks whatever their class, and keeps bracketed numbers", () => {
  const text = md(h("div", {},
    h("p", {}, "Index ", h("code", {}, "a[12]"), " is the thirteenth item."),
    h("div", { class: "reference noprint" }, h("p", {}, "Notes and sources for this page.")),
    h("div", { class: "navbox toc sidebar" }, h("p", {}, "Related reading on the same subject.")),
    h("p", {}, "The value was 42 [3] in that year.")));
  assert.match(text, /a\[12\]/, "an array index in documentation is kept");
  assert.match(text, /42 \[3\]/, "a bracketed number is the page's text");
  assert.match(text, /Notes and sources for this page\./);
  assert.match(text, /Related reading on the same subject\./);
});

// The main content from structure: a document's own landmark, or where the
// text is. The fixtures give the parts misleading ids and classes, so a
// reader that went by names would pick the wrong part.
const pickMain = new Function([
  ...["BOILERPLATE", "INLINE_TAGS", "CONTROL_TAGS", "UNREAD_TAGS", "DATA_TAGS"].map(constLine),
  source("textBlocks"), source("pickMain"), "return pickMain;",
].join("\n"))();
const page = (...kids) => { const body = h("body", {}, ...kids); return { body, querySelector: (sel) => body.descendants().find((n) => n.matches(sel)) || null }; };
const words = (n, w) => Array.from({ length: n }, (_, i) => `${w} ${i}.`).join(" ");

test("the main content is found from the page's structure, not from its names", () => {
  // A page that marks its <main> says so itself.
  const declared = h("main", {}, h("p", {}, words(60, "Main text")));
  assert.equal(pickMain(page(h("div", { id: "content" }, h("p", {}, words(400, "Other"))), declared)), declared);

  // No landmark: a content column beside a sidebar of links, under a wrapper.
  // The sidebar is the one called "content"; the column is called "sidebar".
  const column = h("div", { class: "sidebar" }, h("h1", {}, "Mosses"), h("p", {}, words(200, "Mosses grow on stone")), h("p", {}, words(100, "Spores travel far")));
  const links = h("div", { id: "content", class: "main-content" }, ...Array.from({ length: 40 }, (_, i) => h("a", { href: `/p/${i}` }, `Related page number ${i}`)));
  const wrapped = page(h("header", {}, h("a", { href: "/" }, "Home")), h("div", { id: "main" }, links, column), h("footer", {}, "Footer text"));
  assert.equal(pickMain(wrapped), column, "the text column, not the links called content");

  // A long document whose sections take their ids from their titles: one
  // section called "Content" holds a small share, and is not the page.
  const sections = Array.from({ length: 6 }, (_, i) => h("section", i === 3 ? { id: "content" } : {}, h("h2", {}, `Section ${i}`), h("p", {}, words(80, `Section ${i} text`))));
  const doc = h("div", {}, ...sections);
  const rfc = page(doc);
  const picked = pickMain(rfc);
  assert.notEqual(picked, sections[3], "the section with id=content is not taken for the page");
  assert.ok(picked === doc || picked === null, "the document as a whole, or the whole page");

  // A listing: one <article> per card is a card, not the page.
  const cards = h("ol", {}, ...Array.from({ length: 12 }, (_, i) => h("li", {}, h("article", {}, h("p", {}, words(8, `Card ${i}`))))));
  const listing = page(cards);
  assert.ok(listing.querySelector("article"));
  assert.notEqual(pickMain(listing), listing.querySelector("article"), "the first card is not the page");

  // A short status line above a long list is part of the page: words beside
  // the list, however few, keep the reading at the level that holds both.
  const rows = h("div", {}, ...Array.from({ length: 30 }, (_, i) => h("div", {}, `Person ${i}: Notes about item ${i}`)));
  const inbox = page(h("h1", {}, "Mail"), h("p", {}, "Opened: Lunch on Friday"), rows);
  assert.notEqual(pickMain(inbox), rows, "the status line is not cut off");
  assert.doesNotMatch(source("pickMain"), /['"][#.][a-z]/i, "no class or id selector");
});

test("the Markdown reading is not judged by the menu and footer words it leaves out on purpose", () => {
  const keptShare = new Function(`${source("keptShare")}\nreturn keptShare;`)();
  // A page whose main area wraps the header menu and the footer, with the
  // content itself drawn inside web components (seen in the 17 Nov trial).
  const nav = "Home\nNews\nCompare browsers\nAbout\nMarch 5, 2026 - New feature: Lazy loading via attribute for video & audio";
  const footer = "Can I use...\nBrowser support tables for modern web technologies\nCreated & maintained by @Fyrd, design by @Lensco.\nSupport data contributions by the GitHub community.\nUsage share statistics by StatCounter GlobalStats for October, 2026\nLocation detection provided by ipinfo.io.\nSupport via Patreon\nBecome a caniuse Patron to support the site and disable ads for only $1/month!\nSite links\nHome\nFeature index\nBrowser usage table\nFeature suggestion list\nCaniuse data on GitHub\nLegend\nGreen\n= Supported\nRed\n= Not supported";
  const shadow = ":has() CSS relational pseudo-class\nSelect elements containing specific content.\nUsage\n% of\nGlobal\n96.09%\nChrome\n4 - 104\n105 - 147";
  const plain = `${nav}\nCan I use\nSearch\n?\nSettings\n${footer}\n${shadow}`;
  const markdown = "Can I use Search ?\n### :has() CSS relational pseudo-class\nSelect elements containing specific content.\nUsage % of\n- Global 96.09%\n#### Chrome\n- 4 - 104\n- 105 - 147";
  assert.ok(keptShare(markdown, plain, []) < 0.85, "counting the footer's words, the walk loses to the plain reading");
  assert.ok(keptShare(markdown, plain, [nav, footer]) >= 0.85, "leaving out what the walk skips by design, the walk is used");
  // A page whose content the walk misses still falls back.
  assert.ok(keptShare("Can I use Search ?", plain, [nav, footer]) < 0.85);
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

test("the section the address points to takes its room from the page budget", () => {
  const page = {
    url: "https://www.rfc-editor.org/rfc/rfc9110.html#name-418-unused", innerText: LONG, anchor: "15.5.19. 418 (Unused)",
    outline: Array.from({ length: 40 }, (_, i) => ({ level: 2, text: `Section ${i} heading text`, where: "below" })),
    visibleText: "On screen words. ".repeat(80),
  };
  const shown = PROMPT.composePageText(page, "status code 418", 3000, {});
  const block = (/The part of the page the address points to[^\n]*\n([\s\S]*?)(?:\n\n|$)/.exec(shown) || [])[1] || "";
  assert.ok(block.length > 0 && block.length <= 520, `the anchored section fits what the budget leaves (${block.length})`);
  assert.match(shown, /Main content \(from the top, first \d+ of/);
  const tight = PROMPT.composePageText({ ...page, visibleText: "x ".repeat(600) }, "status code 418", 2200, {});
  assert.doesNotMatch(tight, /The part of the page the address points to/, "no room left: no anchored section, the main content keeps its minimum");
});
