"use strict";
// Which tab the user sees while a run works (extension/core/view.js): reading
// never brings a tab to front, an action does only when the user follows the
// run, and the end of a run takes them back to the agent's page unless they
// used the page they were brought to.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../../extension/core/view.js");

const HOME = 1; // the agent's page, in a tab of its own
const WORK = 5; // the tab the run works in
const OTHER = 9; // a tab of the user's own

test("only actions on a page need it in front; reading, opening and moving between tabs do not", () => {
  for (const d of ["click", "click_at", "hover", "drag", "fill", "fill_details", "press", "scroll"]) assert.equal(V.needsFront({ do: d }), true, d);
  for (const d of ["look", "read", "find", "recall", "wait", "navigate", "back", "tabs", "done", "ask", "note"]) assert.equal(V.needsFront({ do: d }), false, d);
  assert.equal(V.needsFront(null), false);
});

test("an action brings the run's tab to front when the user follows the run from the agent's page", () => {
  const base = { action: { do: "click" }, tabId: WORK, home: HOME, tabs: [WORK] };
  assert.equal(V.bringToFront({ ...base, front: HOME }), true, "the agent's page is in front: the user is watching the agent");
  assert.equal(V.bringToFront({ ...base, front: WORK }), false, "already in front");
  assert.equal(V.bringToFront({ ...base, front: OTHER }), false, "the user went to a tab of their own: left there");
  assert.equal(V.bringToFront({ ...base, front: HOME, action: { do: "look" } }), false, "a picture is taken where the tab is");
  assert.equal(V.bringToFront({ ...base, front: HOME, action: { do: "read" } }), false);
  assert.equal(V.bringToFront({ ...base, front: HOME, action: { do: "tabs", op: "switch", tab: WORK } }), false, "switching works in the tab, it does not show it");
  assert.equal(V.bringToFront({ ...base, front: HOME, background: true }), false, "a sub-task never takes the user's tab");
});

test("from the side panel, an action follows the run to a tab it opened only if the user was on the run's tab", () => {
  const opened = 6;
  const base = { action: { do: "fill" }, tabId: opened, home: null, tabs: [WORK, opened] };
  assert.equal(V.bringToFront({ ...base, front: WORK }), true, "the user was on the tab the run started in");
  assert.equal(V.bringToFront({ ...base, front: OTHER }), false, "the user moved to a tab of their own");
  assert.equal(V.bringToFront({ ...base, front: null }), false);
});

test("a tab a page opens is left in front only for a user who follows the run", () => {
  assert.equal(V.restoreAfterOpen({ before: OTHER, after: 7, home: HOME, tabs: [WORK] }), OTHER, "the user's own tab comes back");
  assert.equal(V.restoreAfterOpen({ before: WORK, after: 7, home: HOME, tabs: [WORK] }), null, "they were watching the run's tab");
  assert.equal(V.restoreAfterOpen({ before: HOME, after: 7, home: HOME, tabs: [WORK] }), null);
  assert.equal(V.restoreAfterOpen({ before: OTHER, after: OTHER, home: HOME, tabs: [WORK] }), null, "nothing moved");
});

test("when the run ends, a user the agent brought to a page goes back to the agent's page", () => {
  assert.deepEqual(V.onSettle({ home: HOME, front: WORK, tabs: [WORK], touched: false, wait: "" }), { focus: "home", bar: "remove" });
});

test("when the run ends, a user who clicked, typed or scrolled on that page stays, and the bar says how it ended", () => {
  assert.deepEqual(V.onSettle({ home: HOME, front: WORK, tabs: [WORK], touched: true, wait: "" }), { focus: null, bar: "outcome" });
});

test("a run that ends while the user is on the agent's page or a tab of their own moves nothing", () => {
  assert.deepEqual(V.onSettle({ home: HOME, front: HOME, tabs: [WORK], touched: false, wait: "" }), { focus: null, bar: "remove" });
  assert.deepEqual(V.onSettle({ home: HOME, front: OTHER, tabs: [WORK], touched: false, wait: "" }), { focus: null, bar: "remove" });
});

test("a side panel run never moves the user when it ends", () => {
  assert.deepEqual(V.onSettle({ home: null, front: WORK, tabs: [WORK], touched: false, wait: "" }), { focus: null, bar: "remove" });
});

test("what is asked on the agent's page (approval, a question, a check-in) takes the user back there unless they used the page", () => {
  for (const wait of ["approval", "question", "check_in", "site_access"]) {
    assert.deepEqual(V.onSettle({ home: HOME, front: WORK, tabs: [WORK], touched: false, wait }), { focus: "home", bar: "remove" }, wait);
    assert.deepEqual(V.onSettle({ home: HOME, front: WORK, tabs: [WORK], touched: true, wait }), { focus: null, bar: "keep" }, wait);
  }
});

test("what only the user can do on the page itself (sign in, a check, a code, paying) keeps them on that page", () => {
  for (const wait of ["sign_in", "human_check", "code", "payment"]) {
    assert.deepEqual(V.onSettle({ home: HOME, front: WORK, tabs: [WORK], touched: false, wait }), { focus: null, bar: "keep" }, wait);
    assert.deepEqual(V.onSettle({ home: HOME, front: HOME, tabs: [WORK], touched: false, wait }), { focus: null, bar: "remove" }, wait);
  }
});

test("a pause for the provider moves nothing", () => {
  assert.deepEqual(V.onSettle({ home: HOME, front: WORK, tabs: [WORK], touched: false, wait: "pause" }), { focus: null, bar: "keep" });
});

test("the bar is on the run's own tab only, while it is in front and the run is live or left there", () => {
  const base = { home: HOME, tabId: WORK, front: WORK };
  assert.equal(V.showBar({ ...base, live: true }), true);
  assert.equal(V.showBar({ ...base, live: false, kept: true }), true, "the outcome stays for a user left there");
  assert.equal(V.showBar({ ...base, live: false, kept: false }), false, "gone when the run ends");
  assert.equal(V.showBar({ ...base, front: HOME, live: true }), false, "not in front");
  assert.equal(V.showBar({ ...base, home: null, live: true }), false, "a side panel run has the panel instead");
});

test("the bar says what the run is doing in the agent page's words, with its state", () => {
  assert.deepEqual(V.barLine({ status: "running", current: { goal: "Search for flights to Lisbon" }, journal: [] }), { state: "working", text: "Search for flights to Lisbon" });
  assert.deepEqual(V.barLine({ status: "running", current: null, journal: [{ k: "status", text: "Waiting 9 s for the provider…" }] }), { state: "working", text: "Waiting 9 s for the provider…" });
  assert.deepEqual(V.barLine({ status: "waiting", wait: { kind: "approval" }, journal: [] }), { state: "needs", text: "Waiting for your go-ahead" });
  assert.deepEqual(V.barLine({ status: "waiting", wait: { kind: "pause" }, journal: [] }).state, "working");
  assert.equal(V.barLine({ status: "done", outcome: { state: "success" } }).state, "done");
  assert.equal(V.barLine({ status: "done", outcome: { state: "error" } }).state, "failed");
  assert.equal(V.barLine({ status: "stopped", outcome: { state: "idle" } }).text, "Stopped.");
});

test("the bar's words and the facts about tabs behind others have no em dashes", () => {
  const all = [...Object.values(V.WAIT_WORDS), ...["success", "unconfirmed", "error", "limit", "idle"].map((s) => V.barLine({ outcome: { state: s } }).text)];
  const C = require("../../extension/core/context.js");
  all.push(C.behindFact("follow"), C.behindFact("user"), C.behindFact("subtask"));
  const bar = fs.readFileSync(path.join(__dirname, "../../extension/agentBar.js"), "utf8");
  for (const t of [...all, bar]) assert.ok(!t.includes("—"), t.slice(0, 80));
});

test("the engine brings a tab to front only through the view's decision, and never for a picture", () => {
  const engine = fs.readFileSync(path.join(__dirname, "../../extension/engine.js"), "utf8");
  // Every place a tab is made active: for an action the user follows, the
  // user's own tab put back, the agent's page, and the user's own "go to the tab".
  const activations = engine.split("\n").filter((l) => /active:\s*true/.test(l) && !/query\(/.test(l));
  for (const l of activations) assert.match(l, /chrome\.tabs\.update\((tab\.id|back|v\.home|home\.id|wait\.tabId)|agent\.html/, l.trim());
  assert.ok(!/captureVisibleTab[\s\S]{0,400}tabs\.update/.test(engine), "a picture never brings a tab forward");
  assert.ok(!/tabs\.create\(\{[^}]*active:\s*!session\.background/.test(engine), "tabs the run opens open behind");
});
