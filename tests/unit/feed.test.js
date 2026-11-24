"use strict";
// What the engine sends the agent page as a run goes (extension/core/feed.js):
// a reply being written in parts that join back whole, however long, and the
// trace as what changed since the last batch.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const FEED = require("../../extension/core/feed.js");

const read = (name) => fs.readFileSync(path.resolve(__dirname, "../../extension", name), "utf8");

test("a long reply written in parts reaches the page whole, past 6,000 characters", () => {
  const answer = `{"do":"done","answer":"${"The fare is S$248 on ZIPAIR. ".repeat(900)}"}`;
  assert.ok(answer.length > 20000);
  let shown = "";
  let page = "";
  for (let n = 50; n < answer.length + 400; n += 397) {
    const text = answer.slice(0, Math.min(n, answer.length));
    const part = FEED.streamPart(shown, text);
    shown = text;
    page = FEED.joinStream(page, part);
    assert.equal(page, text, `the page has what was written at ${n}`);
    if (n > 2000) assert.ok(part.text.length < 1000, "only what was added is sent");
  }
  assert.equal(page, answer);
  assert.match(page, /^\{"do":"done","answer":/, "the start of the reply is still there to read the answer from");
});

test("a reply that starts again is sent afresh, and a part that does not follow on is not joined", () => {
  assert.deepEqual(FEED.streamPart("abc", "xy"), { at: 0, text: "xy" });
  assert.deepEqual(FEED.streamPart("", "hello"), { at: 0, text: "hello" });
  assert.equal(FEED.joinStream("hello", { at: 0, text: "" }), "");
  assert.equal(FEED.joinStream("hel", { at: 5, text: "lo" }), null);
  // A message from before parts (the whole text) still works.
  assert.equal(FEED.joinStream("anything", { text: "whole" }), "whole");
});

test("the trace goes as what changed, and joins back to the same trace", () => {
  const h = (step, outcome) => ({ step, ok: true, action: `click [${step}]`, outcome });
  const a = { id: "r1", steps: 2, activeMs: 1000, running: true, waitKind: "", history: [h(1, "done"), h(2, "")] };
  const b = { id: "r1", steps: 3, activeMs: 1800, running: true, history: [h(1, "done"), h(2, "Opened the page"), h(3, "")] };
  const d = FEED.traceDelta(a, b);
  assert.deepEqual(Object.keys(d).sort(), ["activeMs", "gone", "history", "steps"]);
  assert.deepEqual(d.gone, ["waitKind"]);
  assert.equal(d.history.from, 1, "the history from the first entry that changed");
  assert.equal(d.history.items.length, 2);
  assert.deepEqual(FEED.applyTrace(a, d), b);
  assert.equal(FEED.traceDelta(b, JSON.parse(JSON.stringify(b))), null, "nothing changed, nothing sent");
  // A long run: a new step sends one entry, not the whole history.
  const long = { id: "r1", steps: 40, history: Array.from({ length: 120 }, (_, i) => h(i, "done")) };
  const more = { ...long, steps: 41, history: [...long.history, h(120, "")] };
  const step = FEED.traceDelta(long, more);
  assert.equal(step.history.items.length, 1);
  assert.ok(JSON.stringify(step).length < JSON.stringify(more).length / 20);
  assert.deepEqual(FEED.applyTrace(long, step), more);
});

test("the engine sends parts and the page joins them", () => {
  const engine = read("engine.js");
  assert.doesNotMatch(engine, /slice\(-6000\)/, "the reply being written is not cut to its last 6,000 characters");
  assert.match(engine, /FEED\.streamPart\(/);
  assert.match(engine, /traceDelta: FEED\.traceDelta\(/);
  assert.doesNotMatch(engine, /entries: fresh, trace: RUN\.trace\(run\)/, "the whole trace is not sent with every batch");
  const page = read("agent.js");
  assert.match(page, /FEED\.joinStream\(/);
  assert.match(page, /FEED\.applyTrace\(engineTrace, m\.traceDelta\)/);
  const html = read("agent.html");
  assert.ok(html.indexOf('src="core/feed.js"') > 0 && html.indexOf('src="core/feed.js"') < html.indexOf('src="agent.js"'));
  assert.match(read("background.js"), /'core\/feed\.js'/);
});
