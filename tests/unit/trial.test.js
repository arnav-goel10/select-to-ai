"use strict";
// The real-task trial: its task files are sound, and its report adds up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("../bench/trial.js");
const J = require("../bench/judge.js");

const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "../bench", name), "utf8"));

test("everyday-tasks.json is sound: about 90 tasks over at least 9 families and 4 languages", () => {
  const list = load("everyday-tasks.json");
  assert.deepEqual(T.validateTasks(list), []);
  assert.ok(list.length >= 85 && list.length <= 100, `${list.length} tasks`);
  const per = {};
  for (const t of list) per[t.level] = (per[t.level] || 0) + 1;
  assert.ok(Object.keys(per).length >= 9);
  for (const [family, n] of Object.entries(per)) assert.ok(n >= 8, `${family} has ${n}`);
  assert.ok(!per.fixture);
  assert.ok(new Set(list.filter((t) => t.lang).map((t) => t.lang)).size >= 4);
  // Every field the trial adds survives loading.
  const loaded = J.normaliseTasks(list);
  assert.equal(loaded.length, list.length);
  assert.ok(loaded.every((t) => t.expect || t.pattern));
});

test("fixture-tasks.json names scenarios the scripted server has, on the dry port", () => {
  const list = load("fixture-tasks.json");
  assert.deepEqual(T.validateTasks(list), []);
  const { createE2EServer } = require("../e2e/server.js");
  const server = createE2EServer(T.DRY_PORT);
  for (const t of list) {
    assert.ok(server.scenarios[t.scenario], `${t.id}: scenario ${t.scenario}`);
    assert.equal(t.task, server.scenarios[t.scenario].task, `${t.id}: the task is the scenario's own`);
    assert.equal(new URL(t.url).port, String(T.DRY_PORT));
    assert.ok(t.dry);
  }
});

test("a task file is refused for a repeated id, an unknown family, no way to check it, or an action a trial may not take", () => {
  const ok = { id: "a", level: "developer", url: "https://a.example/", task: "What licence?", pattern: "MIT" };
  assert.deepEqual(T.validateTasks([ok]), []);
  assert.equal(T.validateTasks([ok, ok]).length, 1);
  assert.equal(T.validateTasks([{ ...ok, level: "misc" }]).length, 1);
  assert.equal(T.validateTasks([{ ...ok, pattern: undefined }]).length, 1);
  assert.equal(T.validateTasks([{ ...ok, pattern: "(" }]).length, 1);
  assert.equal(T.validateTasks([{ ...ok, task: "Fill the form and place the order." }]).length, 1);
  assert.deepEqual(T.validateTasks([{ ...ok, task: "Fill the form. Do not place the order." }]), []);
});

test("the pattern stands in for the judge in dry mode, and a human check counts as blocked", () => {
  const task = { pattern: "\\$19" };
  assert.equal(T.patternVerdict(task, { ending: "finished", answer: "It costs $19." }).success, true);
  assert.equal(T.patternVerdict(task, { ending: "finished", answer: "It costs $21." }).success, false);
  assert.equal(T.patternVerdict(task, { ending: "timed out", answer: "It costs $19." }).success, false);
  const waiting = T.patternVerdict(task, { ending: "asked the user", waitKind: "human_check", answer: "" });
  assert.deepEqual([waiting.success, waiting.blocked], [false, true]);
  assert.equal(T.patternMatch({}, "x"), null);
});

test("counters: scripted and real inputs, held actions, and what the judge cost", () => {
  const c = T.countersOf({ timing: { pointer: { real: 1, synthetic: 4 } }, held: [{ kind: "send", allowed: false }, { kind: "site", allowed: true }], checkIns: 2, history: [{ ok: true }, { ok: false }] });
  assert.deepEqual(c, { scriptedInputs: 4, realInputs: 1, heldActions: 2, heldRefused: 1, heldKinds: ["send", "site"], checkIns: 2, failedActions: 1 });
  assert.deepEqual(T.countersOf({}).scriptedInputs, 0);
  const cost = T.judgeCostUSD({ model: "m", input: 2000, output: 1000 }, () => [0.002, 0.01]);
  assert.ok(Math.abs(cost - 0.014) < 1e-12);
  assert.equal(T.judgeCostUSD(undefined, () => [1, 1]), 0);
});

test("the family table sorts every run into one column and counts what never ran", () => {
  const tasks = [
    { id: "a", level: "developer" }, { id: "b", level: "developer" }, { id: "c", level: "developer" },
    { id: "d", level: "shopping" }, { id: "e", level: "shopping" }, { id: "f", level: "shopping" },
  ];
  const rows = [
    { id: "a", family: "developer", success: true, ending: "finished", seconds: 20, costUSD: 0.01, judgeCostUSD: 0.02, counters: { scriptedInputs: 3, realInputs: 0, heldActions: 0 }, patternMatch: true },
    { id: "b", family: "developer", success: false, ending: "timed out", seconds: 300, costUSD: 0.03, counters: { scriptedInputs: 1, realInputs: 0, heldActions: 2 }, patternMatch: null },
    { id: "c", family: "developer", success: false, ending: "finished", seconds: 40, costUSD: 0.01, patternMatch: true },
    { id: "d", family: "shopping", success: false, blocked: true, ending: "finished", seconds: 10 },
    { id: "e", family: "shopping", success: false, ending: "harness error: gone", seconds: 0 },
  ];
  const { lines, total } = T.familyTable(rows, tasks);
  const dev = lines.find((l) => l.family === "developer");
  assert.deepEqual([dev.tasks, dev.passed, dev.failed, dev.timedOut, dev.blocked, dev.lost, dev.notRun], [3, 1, 1, 1, 0, 0, 0]);
  assert.equal(dev.medianSeconds, 40);
  assert.equal(dev.scriptedInputs, 4);
  assert.equal(dev.heldActions, 2);
  assert.equal(dev.patternDisagrees, 1);
  const shop = lines.find((l) => l.family === "shopping");
  assert.deepEqual([shop.passed, shop.failed, shop.timedOut, shop.blocked, shop.lost, shop.notRun], [0, 0, 0, 1, 1, 1]);
  assert.equal(total.passed + total.failed + total.timedOut + total.blocked + total.lost + total.notRun, tasks.length);
  assert.ok(Math.abs(total.agentUSD - 0.05) < 1e-12);
  const text = T.markdown({ lines, total }, { capUSD: 5, capReached: true, arm: "shipped" });
  assert.match(text, /\| Developer tasks \| 3 \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 40 \|/);
  assert.match(text, /Passed 1 of 3 scored runs/);
  assert.match(text, /spend cap stopped the run/);
  assert.ok(!text.includes("—"));
});

test("a run ended by the spend cap is lost, not failed, and the judge is told what a right result holds", () => {
  assert.equal(T.bucketOf({ success: false, ending: "spend cap reached" }), "lost");
  assert.equal(T.bucketOf({ success: false, ending: "asked the user", waitKind: "human_check" }), "blocked");
  const msg = J.judgeMessage({ task: "t", startUrl: "https://a.example/x", sites: ["b.example"], expect: "42 widgets", answer: "42", history: [], finalUrl: "https://a.example/x", finalText: "42 widgets" });
  assert.match(msg, /the sites the task names: a\.example, b\.example/);
  assert.match(msg, /right result holds[^\n]*42 widgets/);
  const plain = J.judgeMessage({ task: "t", startUrl: "https://a.example/x", answer: "42", history: [], finalUrl: "https://a.example/x", finalText: "x" });
  assert.match(plain, /\(the site the task names: a\.example\)/);
  assert.ok(!/right result holds/.test(plain));
});

test("the dry check fails when a fixture run ends another way or a counter is missing", () => {
  const tasks = [{ id: "fx", level: "fixture", dry: "passed" }, { id: "held", level: "fixture", dry: "failed|timed out", dryHeld: 1 }];
  const row = (id, more) => ({ id, family: "fixture", steps: 1, seconds: 2, costUSD: 0, counters: { heldActions: 0 }, ending: "finished", history: [], ...more });
  const shards = [{ agent: { debuggerAvailable: false } }];
  assert.deepEqual(T.checkDry([row("fx", { success: true }), row("held", { success: false, ending: "timed out", counters: { heldActions: 3 } })], tasks, shards), []);
  assert.equal(T.checkDry([row("fx", { success: false }), row("held", { success: false, counters: { heldActions: 3 } })], tasks, shards).length, 1);
  assert.equal(T.checkDry([row("fx", { success: true }), row("held", { success: false })], tasks, shards).length, 1);
  assert.equal(T.checkDry([row("fx", { success: true })], tasks, shards).length, 1);
  assert.equal(T.checkDry([row("fx", { success: true }), row("held", { success: false, counters: { heldActions: 1 } })], tasks, []).length, 1);
});
