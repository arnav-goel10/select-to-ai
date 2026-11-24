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

test("agentTools.js and pageSearch.js hold no word list made by splitting a string, and no list of words to skip", () => {
  const PAGE_SRC = fs.readFileSync(path.join(EXT, "pageSearch.js"), "utf8");
  for (const [file, src] of [["agentTools.js", TOOLS_SRC], ["pageSearch.js", PAGE_SRC]]) {
    const split = [...src.matchAll(/const (\w+) = new Set\(\s*["'`][^"'`]*["'`]\s*\.split\(/g)].map((m) => m[1]);
    assert.deepEqual(split, [], `word lists in ${file}`);
    // The words of a request or a query are skipped by how common they are on the page, never by a list.
    assert.doesNotMatch(src, /new Set\(\[\s*"(?:what|the|and|which|does)"/, `a list of common words in ${file}`);
  }
  assert.ok(!/STOPWORDS|\bSTOP\b/.test(TOOLS_SRC + PAGE_SRC), "the stop lists are gone");
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
