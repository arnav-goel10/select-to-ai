"use strict";
// The approval gate decides from the page's structure and from a check that
// reads a control's names by their meaning. No list of words, and no
// pattern of words, stands in for that decision.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.resolve(__dirname, "../../extension");
const TOOLS_SRC = fs.readFileSync(path.join(EXT, "agentTools.js"), "utf8");
const T = require(path.join(EXT, "agentTools.js"));
const POLICY = require(path.join(EXT, "core/policy.js"));

test("agentTools.js holds no word list made by splitting a string, but the one that picks a request's keywords for reading", () => {
  const lists = [...TOOLS_SRC.matchAll(/const (\w+) = new Set\(\s*["'`][^"'`]*["'`]\s*\.split\(\s*["'`] ["'`]\s*\)\s*\)/g)].map((m) => m[1]);
  // STOPWORDS drops "the", "please" and the like from a request before its
  // words are looked for in a page's text (taskKeywords). It decides nothing about a press.
  assert.deepEqual(lists, ["STOPWORDS"], `word lists in agentTools.js: ${lists.join(", ")}`);
  for (const fn of [T.pressKind, T.pressEntryOf, T.pressEntries, T.pressFor, T.actionRisk, T.readLabels, POLICY.decide]) assert.ok(!String(fn).includes("STOPWORDS"), fn.name);
});

test("the word lists and label patterns the gate once used are gone", () => {
  for (const name of ["MOVING_WORDS", "LOOKING_HEADS", "ACTING_WORDS", "readsPlainly", "RISK_LABELS", "RISK_LABEL_HARMLESS", "labelRisk", "linkActs", "RISK_URL", "SELECT_TO_AI_COMMON_WORDS"]) {
    assert.ok(!TOOLS_SRC.includes(name), `${name} is back in agentTools.js`);
  }
  assert.ok(!fs.existsSync(path.join(EXT, "commonWords.js")), "commonWords.js is back");
  assert.doesNotMatch(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), /commonWords/);
  for (const name of ["readsPlainly", "pressCheckOf", "linkActs"]) assert.equal(T[name], undefined, `${name} is exported again`);
});

test("no function on the gate's path tests a pattern against a control's names", () => {
  // Every function the gate calls to judge a press, from both files.
  const fns = [T.pressKind, T.pressEntryOf, T.pressEntries, T.pressFor, T.actionRisk, T.formSends, T.labelsMessages, T.readLabels, POLICY.decide, POLICY.asRiskAction];
  for (const fn of fns) {
    const src = String(fn);
    // A regular expression literal tested on a name, a label, text or words.
    assert.doesNotMatch(src, /\/[^/\n]{2,}\/[gimsuy]*\.test\(\s*(?:label|labels|name|names|text|words|accName|elementLabel)/, `${fn.name} tests a pattern against words`);
    assert.doesNotMatch(src, /\.test\(\s*(?:TOOLS\.)?elementLabel\(/, `${fn.name} tests a control's label`);
  }
  // contentRisk is not exported: read it from the source.
  const body = TOOLS_SRC.slice(TOOLS_SRC.indexOf("function contentRisk("), TOOLS_SRC.indexOf("function formSends("));
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /\.test\(\s*(?:label|name|text|elementLabel\()/);
  assert.doesNotMatch(body, /RISK_(?!TEXT)|labelRisk/);
});
