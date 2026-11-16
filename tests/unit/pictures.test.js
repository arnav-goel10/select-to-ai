"use strict";
// A picture of the page the browser will not give. Chrome gives an
// extension one only with access to every address, or on a tab where the
// user opened the extension; a build granted one site at a time has
// neither. The refusal is said to the model as a fact, and to the user
// once, in place of a failure with no reason.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CONTEXT = require("../../extension/core/context.js");
const RUN = require("../../extension/core/run.js");

const ENGINE = fs.readFileSync(path.join(__dirname, "../../extension/engine.js"), "utf8");

test("the browser's refusal for want of a permission is said as what it is, and as lasting", () => {
  const got = CONTEXT.noPicture("Either the '<all_urls>' or 'activeTab' permission is required.", false);
  assert.equal(got.lasting, true);
  assert.match(got.why, /^The browser refused: it gives an extension a picture of a tab only with access to every address, or on a tab where the user opened the extension themselves, and neither holds on this tab\.$/);
});

test("any other refusal is passed on in the browser's words, and may not come again", () => {
  assert.deepEqual(CONTEXT.noPicture("Failed to capture tab: image readback failed", false), { why: "The browser refused: Failed to capture tab: image readback failed", lasting: false });
  assert.deepEqual(CONTEXT.noPicture("", false), { why: "", lasting: false });
});

test("a tab behind another is said to be behind, whatever else", () => {
  const got = CONTEXT.noPicture("", true);
  assert.equal(got.lasting, false);
  assert.match(got.why, /^It is behind another tab, and a tab can be pictured only while it is the one in front\.$/);
});

test("once refused, the model is told as a fact of the browser that no picture can be taken on this tab", () => {
  const run = RUN.newRun({ id: "r1", task: "what does the chart show?", tabId: 7, startUrl: "https://a.example/", marker: "PAGE-abcd1234", now: 1 });
  const page = { url: "https://a.example/", title: "A", elements: [], innerText: "A", visibleText: "A" };
  const why = CONTEXT.noPicture("Either the '<all_urls>' or 'activeTab' permission is required.", false).why;
  const told = CONTEXT.stepMessages(run, page, { noPictures: why }).user;
  assert.match(told, /Facts from the browser:[\s\S]*- No picture of the page can be taken on this tab\. The browser refused: [^\n]* look fails the same way each time/);
  assert.ok(!/No picture of the page can be taken/.test(CONTEXT.stepMessages(run, page, {}).user));
});

test("the engine keeps what the browser said, tells the user once, and says it only for that run and tab", () => {
  // The browser's own words are caught, not swallowed.
  assert.match(ENGINE, /captureVisibleTab\(tab\.windowId, \{ format: "jpeg", quality: 60 \}\)\)\.catch\(\(e\) => \{ refused = String\(\(e && e\.message\) \|\| e\); return null; \}\);/);
  assert.match(ENGINE, /return CONTEXT\.noPicture\(refused, !tab\.active\);/);
  assert.match(ENGINE, /if \(shot\.lasting && !told\) \{\s*session\.noPictures = \{ run: run\.id, tabId, why: shot\.why \};\s*run\.journal\.push\(\{ k: "note", text: "Chrome did not let the agent take a picture of this page/);
  assert.match(ENGINE, /session\.extras\.noPictures = session\.noPictures && session\.noPictures\.run === run\.id && session\.noPictures\.tabId === tab\.id \? session\.noPictures\.why : "";/);
});
