"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../extension/pageSearch.js");
const PROMPT = require("../../extension/agentPrompt.js");
const A = require("../../extension/answerFormat.js");

const doc = [
  "# Lighthouse", "The Brightwater Lighthouse stands on the cliff.",
  "## History", "Built in 1887 by the harbour board. ".repeat(40),
  "## Visiting", "### Hours", "Open to visitors from 9:30 to 16:45 every day except Tuesday.",
  "### Tickets", "Adults pay 12 dollars; children are free.",
  "## References", "- Source one. ".repeat(300),
].join("\n");

test("find works like Ctrl+F: the matching window, labelled with its section", () => {
  const hits = P.findInText(doc, "When does it open to visitors?");
  assert.ok(hits.some((h) => /\[in "Hours"\]/.test(h) && /9:30/.test(h)), hits.join("\n---\n"));
  assert.deepEqual(P.findInText(doc, "What is 17% of 250?"), [], "no page words, no results");
});

test("answers render the same everywhere: tables, continued numbering, nesting, inline lists, escaping", () => {
  const html = A.renderAnswerHtml("| Plan | Price |\n| --- | --- |\n| Team | $4 |\n\n1. a\n\ntext\n\n2. b\n- x\n  - y\n\nDone. - One item. - Two item. - Three.\n<img src=x onerror=alert(1)>", [], { headingShift: 1 });
  assert.match(html, /<table>[\s\S]*<th>Plan<\/th>[\s\S]*<td>\$4<\/td>/);
  assert.match(html, /<ol start="2">/);
  assert.match(html, /<li>x<ul><li>y<\/li><\/ul><\/li>/);
  assert.match(html, /<li>One item\.<\/li>/);
  assert.doesNotMatch(html, /<img/);
});

test("page text says when it is the whole page, and how much was shown when it is not", () => {
  const out = {};
  const short = PROMPT.composePageText({ innerText: "Price: $9." }, "What is the price?", 3600, out);
  assert.match(short, /the whole page; there is nothing more to read/);
  assert.equal(out.truncated, false);
  const cut = {};
  const long = PROMPT.composePageText({ innerText: "word ".repeat(4000) }, "What is the price?", 3600, cut);
  assert.match(long, /read the rest with the read action/);
  assert.equal(cut.truncated, true);
  assert.ok(cut.shown > 0 && cut.shown < 20000);
});
