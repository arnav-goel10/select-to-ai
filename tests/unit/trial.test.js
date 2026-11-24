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
  const c = T.countersOf({ timing: { pointer: { real: 1, synthetic: 4 } }, held: [{ kind: "send", allowed: false }, { kind: "site", allowed: true }], checkIns: 2, history: [{ ok: true, action: "fill [3] with \"blue widget\"" }, { ok: false, action: "click [4]" }, { ok: true, action: "press Enter" }] });
  assert.deepEqual(c, { scriptedInputs: 4, realInputs: 1, typedActions: 2, heldActions: 2, heldRefused: 1, heldKinds: ["send", "site"], checkIns: 2, failedActions: 1 });
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
  assert.match(text, /\| Developer tasks \| 3 \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 40 \| \$0\.0500 \| \$0\.0200 \| 4 \| 0 \| 0 \| 2 \|/);
  assert.match(text, /Passed 1 of 3 scored runs/);
  assert.match(text, /spend cap stopped the run/);
  assert.match(text, /cap \$5\.00/);
  assert.match(T.markdown({ lines, total }, { capUSD: 0.0005 }), /cap \$0\.0005/);
  assert.ok(!text.includes("\u2014"));
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
  // A row as run.js writes it now: the form controls read back, the grounding check, the judge stub's counted call, and the picture the browser would give.
  const row = (id, more) => ({ id, family: "fixture", steps: 1, seconds: 2, costUSD: 0, counters: { heldActions: 0 }, ending: "finished", history: [], formState: { controls: [], total: 0 }, grounding: { numbers: 0, found: 0, missing: [] }, judgeUsage: { calls: 1 }, judgeCostUSD: 0.001, picture: { granted: true }, ...more });
  const shards = [{ agent: { debuggerAvailable: false } }];
  assert.deepEqual(T.checkDry([row("fx", { success: true }), row("held", { success: false, ending: "timed out", counters: { heldActions: 3 } })], tasks, shards), []);
  assert.equal(T.checkDry([row("fx", { success: false }), row("held", { success: false, counters: { heldActions: 3 } })], tasks, shards).length, 1);
  assert.equal(T.checkDry([row("fx", { success: true }), row("held", { success: false })], tasks, shards).length, 1);
  assert.equal(T.checkDry([row("fx", { success: true })], tasks, shards).length, 1);
  assert.equal(T.checkDry([row("fx", { success: true })], [{ id: "fx", level: "fixture", dry: "passed", dryScripted: 1, dryTyped: 1 }], shards).length, 2);
  assert.equal(T.checkDry([row("fx", { success: true }), row("held", { success: false, counters: { heldActions: 1 } })], tasks, []).length, 1);
});

test("the judge never gets a key that belongs to another provider's endpoint", () => {
  const C = require("../bench/judge-call.js");
  // An OpenAI agent key with no judge key: nothing is sent anywhere.
  const leak = C.judgeConfig({ BENCH_PROVIDER: "openai", BENCH_API_KEY: "agent-key" });
  assert.equal(leak.key, "");
  assert.match(leak.problem, /never sent to another provider/);
  // The same agent with the judge's own key and address: the judge's key, on Anthropic.
  const own = C.judgeConfig({ BENCH_PROVIDER: "openai", BENCH_API_KEY: "agent-key", BENCH_JUDGE_KEY: "judge-key", BENCH_JUDGE_URL: C.ANTHROPIC_URL });
  assert.deepEqual([own.key, own.isAnthropic, own.problem], ["judge-key", true, ""]);
  // An Anthropic agent may share its key with a judge on Anthropic, and only there.
  const same = C.judgeConfig({ BENCH_PROVIDER: "anthropic", BENCH_API_KEY: "agent-key" });
  assert.deepEqual([same.key, same.url, same.problem], ["agent-key", C.ANTHROPIC_URL, ""]);
  const moved = C.judgeConfig({ BENCH_PROVIDER: "anthropic", BENCH_API_KEY: "agent-key", BENCH_JUDGE_URL: "https://integrate.api.nvidia.com/v1" });
  assert.equal(moved.key, "");
  assert.ok(moved.problem);
  // A look-alike host is not the provider.
  assert.equal(C.judgeConfig({ BENCH_PROVIDER: "anthropic", BENCH_API_KEY: "agent-key", BENCH_JUDGE_URL: "https://api.anthropic.com.evil.example/v1/messages" }).key, "");
  assert.equal(C.judgeConfig({}).problem, "Set BENCH_JUDGE_KEY for the judge.");
});

test("a provider's error text is saved without anything shaped like a key", () => {
  const { scrub } = require("../bench/judge-call.js");
  const out = scrub('{"error":"Incorrect API key provided: sk-proj-abc123def456ghi789. Authorization: Bearer abcdefghijklmnop"}');
  assert.ok(!/abc123def456|abcdefghijklmnop/.test(out), out);
  assert.match(out, /Incorrect API key provided/);
});

test("the dry check wants the form read back and the judge stub counted", () => {
  const tasks = [{ id: "form", level: "fixture", dry: "failed", dryForm: "Ada Lovelace" }];
  const row = (more) => ({ id: "form", family: "fixture", success: false, steps: 1, seconds: 2, costUSD: 0, counters: {}, ending: "asked the user", history: [], formState: { controls: [{ type: "text", label: "Name", value: "Ada Lovelace" }], total: 1 }, grounding: { numbers: 0, found: 0, missing: [] }, judgeUsage: { calls: 1 }, judgeCostUSD: 0.001, picture: { granted: true }, ...more });
  const shards = [{ agent: { debuggerAvailable: false } }];
  assert.deepEqual(T.checkDry([row()], tasks, shards), []);
  assert.match(T.checkDry([row({ formState: { controls: [{ type: "text", label: "Name", value: "" }], total: 1 } })], tasks, shards)[0], /no form control of the final page holds "Ada Lovelace"/);
  assert.match(T.checkDry([row({ judgeUsage: { calls: 0 }, judgeCostUSD: 0 })], tasks, shards)[0], /judge stub was not called/);
});

test("handing something in is refused, except in a form task on a practice site; a form task must be on one", () => {
  const read = { id: "a", level: "developer", url: "https://a.example/", task: "What licence?", pattern: "MIT" };
  for (const task of ["Fill the form and submit it.", "Subscribe to the newsletter.", "Book a table for two on Friday.", "Apply for the job on this page.", "Upload the file report.pdf.", "Comment on the first story.", "Reply to the top comment.", "Leave a comment saying hello."]) {
    assert.equal(T.validateTasks([{ ...read, task }]).length, 1, task);
  }
  // The nouns a read-only task is full of are not requests.
  for (const task of ["Open that book and tell me its UPC.", "What is the first sentence of this book?", "What line length for comments and docstrings?", "Fill the form. Do not submit it.", "Which books apply the discount?"]) {
    assert.deepEqual(T.validateTasks([{ ...read, task }]), [], task);
  }
  const form = { id: "f", level: "form-fill", url: "https://httpbin.org/forms/post", task: "Fill in the name Ada and submit the form.", expect: "x" };
  assert.deepEqual(T.validateTasks([form]), [], "a practice form goes nowhere");
  assert.match(T.validateTasks([{ ...form, url: "https://shop.example/contact" }]).join("\n"), /only on a practice site/);
  assert.equal(T.validateTasks([{ ...form, url: "https://shop.example/contact" }]).length, 2);
  // Paying, signing up and the rest stay refused on a practice site too.
  assert.equal(T.validateTasks([{ ...form, task: "Fill the form and place the order." }]).length, 1);
  assert.equal(T.validateTasks([{ ...form, url: "https://nothttpbin.org/forms/post" }]).length, 2, "a look-alike host is not a practice site");
});

test("the arm is enforced: every shard's build must be the arm's, and the shipped arm makes no real input", () => {
  const off = { shard: "shard 1 of 2", agent: { debuggerAvailable: false } };
  const on = { shard: "shard 2 of 2", agent: { debuggerAvailable: true } };
  assert.deepEqual(T.armProblems("shipped", [off, off], []), []);
  assert.deepEqual(T.armProblems("debugger-on", [on, on], [{ id: "a", counters: { realInputs: 3 } }]), []);
  assert.match(T.armProblems("shipped", [off, on], [])[0], /shard 2 of 2 loaded a build with chrome\.debugger in the shipped arm/);
  assert.match(T.armProblems("debugger-on", [off, on], [])[0], /shard 1 of 2 loaded a build without chrome\.debugger/);
  assert.match(T.armProblems("shipped", [off, { agent: {} }], [])[0], /did not record/);
  assert.match(T.armProblems("shipped", [off], [{ id: "a", counters: { realInputs: 2 } }, { id: "b", counters: { realInputs: 0 } }])[0], /1 run\(s\) made real input events in the shipped arm.*a \(2\)/);
  // A shard that left no results file cannot be vouched for.
  assert.deepEqual(T.armProblems("shipped", [off, off], [], 2), []);
  assert.match(T.armProblems("debugger-on", [on], [], 2)[0], /1 of 2 shard\(s\) left a results file/);
  const text = T.markdown(T.familyTable([], []), { arm: "shipped", armChecked: true, armProblems: ["shard 2 of 2 loaded a build with chrome.debugger in the shipped arm."] });
  assert.match(text, /Arm check failed/);
});

test("spend counts lost attempts, long prompts, every judge call, learning and replays", () => {
  const rates = (m) => (/haiku/.test(m) ? [0.0001, 0.0005] : [0.002, 0.01]);
  // A Haiku 5.5 prompt over 100,000 tokens costs five times the base rate: four more shares of the base price.
  const extra = T.longPromptSurchargeUSD([{ model: "claude-haiku-5-5", prompt: 150000, completion: 1000 }, { model: "claude-haiku-5-5", prompt: 90000, completion: 1000 }, { model: "claude-sonnet-5-5", prompt: 150000, completion: 1000 }], rates);
  assert.ok(Math.abs(extra - 4 * (150000 * 0.0001 + 1000 * 0.0005) / 1000) < 1e-12, String(extra));
  assert.equal(T.longPromptSurchargeUSD(undefined, rates), 0);
  const row = { costUSD: 0.01, longPromptUSD: 0.002, lostAttemptsUSD: 0.003, judgeCostUSD: 0.02, learnAllowanceUSD: 0.004, recipe: { replay: { usd: 0.005 } } };
  assert.ok(Math.abs(T.spendOf(row) - 0.044) < 1e-12);
  assert.equal(T.spendOf({}), 0);
  // The table's agent column holds everything the agent side cost.
  const { total } = T.familyTable([{ id: "a", family: "developer", success: true, ending: "finished", ...row }], [{ id: "a", level: "developer" }]);
  assert.ok(Math.abs(total.agentUSD - 0.019) < 1e-12);
  assert.ok(Math.abs(total.replayUSD - 0.005) < 1e-12);
  // Every answered judge call is counted, readable verdict or not.
  assert.ok(Math.abs(T.judgeCostUSD({ model: "claude-sonnet-5-5", input: 3000, output: 300, calls: 3 }, rates) - (3000 * 0.002 + 300 * 0.01) / 1000) < 1e-12);
});

test("the judge call counts the tokens of every attempt and stops asking when the cap says so", async () => {
  const { judgeRun } = require("../bench/judge-call.js");
  const real = globalThis.fetch;
  let calls = 0;
  let sent = null;
  globalThis.fetch = async (_url, init) => { calls++; sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: calls < 3 ? "no verdict here" : '{"key_points":["x"],"met":[true],"success":true,"blocked":false,"reason":"ok"}' }], usage: { input_tokens: 100, output_tokens: 10, ...(calls > 1 ? { cache_read_input_tokens: 50 } : { cache_creation_input_tokens: 50 }) } }) }; };
  try {
    const run = { task: "t", startUrl: "https://a.example/", answer: "x", history: [], finalUrl: "https://a.example/", finalText: "x" };
    const cfg = { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-5-5", key: "k", isAnthropic: true, vision: false, shots: 0, retryMs: 1 };
    const v = await judgeRun(run, cfg);
    assert.equal(v.success, true);
    assert.deepEqual(v.judgeUsage, { model: "claude-sonnet-5-5", input: 300, output: 30, cacheWrite: 50, cacheRead: 100, calls: 3 });
    // The judge's fixed instructions go as one cached block, the same bytes on every call.
    assert.deepEqual(sent.system, [{ type: "text", text: J.JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }]);
    calls = 0;
    const capped = await judgeRun(run, { ...cfg, stopRetry: (u) => u.calls >= 1 });
    assert.equal(calls, 1);
    assert.deepEqual([capped.judgeFailed, capped.judgeUsage.calls, capped.judgeUsage.input], [true, 1, 100]);
  } finally { globalThis.fetch = real; }
});

test("the judge is given the form controls as read from the page, and the grounding of the answer's numbers", () => {
  const run = { task: "Fill the form", startUrl: "https://httpbin.org/forms/post", answer: "Done, 2 toppings", history: [{ step: 1, ok: true, action: 'fill [3] with "Priya Raman"', outcome: "typed" }], finalUrl: "https://httpbin.org/forms/post", finalText: "Customer name",
    formState: { total: 5, controls: [
      { type: "text", label: "Customer name:", name: "custname", value: "" },
      { type: "radio", label: "Medium", name: "size", value: "medium", checked: true },
      { type: "checkbox", label: "Bacon", name: "topping", value: "bacon", checked: false },
      { type: "select", label: "Dropdown", name: "pick", value: "2", selected: ["Two"] },
      { type: "password", label: "Password", name: "pw", value: "" },
    ] } };
  run.grounding = T.answerGrounding({ ...run, answer: "The total is 1,234.50 and 77 items" , finalText: "Total 1234.50" });
  const msg = J.judgeMessage(run);
  assert.match(msg, /Form controls on the final page, read back from the page by the harness/);
  assert.match(msg, /\[text\] "Customer name:" name=custname: \(empty\)/, "a fill that did not stick shows as empty");
  assert.match(msg, /\[radio\] "Medium" name=size: TICKED/);
  assert.match(msg, /\[checkbox\] "Bacon" name=topping: not ticked/);
  assert.match(msg, /\[select\] "Dropdown" name=pick: chosen: "Two"/);
  // What holds something is listed before what is empty.
  assert.ok(msg.indexOf('"Medium"') < msg.indexOf('"Customer name:"'));
  assert.match(msg, /1 of 2 appear there; not found: 77/);
  assert.match(J.JUDGE_SYSTEM, /Form controls:/);
  assert.equal(J.formStateText({ controls: [], total: 0 }), "");
  // Digits of other scripts count as the numbers they are.
  assert.deepEqual(T.answerGrounding({ answer: "٨٢٨ متر", finalText: "828 m", pages: [] }), { numbers: 1, found: 1, missing: [] });
  assert.equal(T.answerGrounding({ answer: "about 95 moons", finalText: "", pages: [{ text: "Access denied" }] }).found, 0);
});

test("learn-tasks.json is sound: about 12 tasks to run twice and about 6 pairs of neighbours on one site", () => {
  const list = load("learn-tasks.json");
  assert.deepEqual(T.validateTasks(list), []);
  const pairs = T.learnPlan(J.normaliseTasks(list));
  const repeat = pairs.filter((p) => p.a.id === p.b.id);
  const near = pairs.filter((p) => p.a.id !== p.b.id);
  assert.ok(repeat.length >= 10 && repeat.length <= 14, `${repeat.length} repeats`);
  assert.ok(near.length >= 5 && near.length <= 8, `${near.length} pairs`);
  for (const p of near) assert.equal(new URL(p.a.url).hostname, new URL(p.b.url).hostname);
  // Two runs of each pair are planned, in slots a row can be matched to.
  const planned = T.plannedRuns(J.normaliseTasks(list), { learn: "pairs" });
  assert.equal(planned.length, 2 * pairs.length);
  assert.equal(new Set(planned.map((t) => t.slot)).size, planned.length);
  // A pair is refused when its second task is on another site or is missing.
  const a = { id: "a", level: "developer", url: "https://a.example/x", task: "What licence?", pattern: "MIT", then: "b" };
  assert.equal(T.validateTasks([a, { ...a, id: "b", then: undefined, url: "https://b.example/" }]).length, 1);
  assert.equal(T.validateTasks([a]).length, 1);
  const fixture = load("fixture-learn-tasks.json");
  assert.deepEqual(T.validateTasks(fixture), []);
  const kinds = T.learnPlan(J.normaliseTasks(fixture)).map((p) => (p.a.id === p.b.id ? "repeat" : "neighbour")).sort();
  assert.deepEqual(kinds, ["neighbour", "repeat"]);
});

test("the learn table sets run 1 against run 2: outcome, steps, seconds and tokens", () => {
  const run = (id, phase, pair, more) => ({ id, run: 1, family: "developer", ending: "finished", success: true, steps: 5, seconds: 30, tokens: { prompt: 900, completion: 100 }, learn: { pair, phase, memoryAtStart: { count: phase === "B" ? 2 : 0 }, shownAtFirstStep: phase === "B" ? { ids: ["m1"] } : null }, ...more });
  const rows = [
    run("x", "A", "x", { steps: 8, seconds: 60, tokens: { prompt: 1900, completion: 100 } }), run("x", "B", "x", { steps: 4 }),
    run("y", "A", "y"), run("z", "B", "y", { success: false, steps: 9 }),
    run("w", "A", "w"), run("w", "B", "w", { ending: "harness error: gone", success: false }),
  ];
  const t = T.learnTable(rows);
  assert.equal(t.lines.length, 3);
  const rep = t.totals.find((x) => x.kind === "repeat");
  assert.deepEqual([rep.pairs, rep.scored, rep.passed, rep.steps, rep.seconds, rep.tokens, rep.fewerSteps, rep.bothPassed, rep.startedKnowing, rep.shown], [2, 1, [1, 1], [8, 4], [60, 30], [2000, 1000], 1, 1, 1, 1]);
  const near = t.totals.find((x) => x.kind === "neighbour");
  assert.deepEqual([near.pairs, near.scored, near.passed], [1, 1, [1, 0]]);
  const text = T.learnMarkdown(t);
  assert.match(text, /The same task twice \(2\) \| 1 \| 1 \| 1 \| 8 \/ 4 \| 60 \/ 30 \| 2000 \/ 1000 \| 1 of 1/);
  assert.match(text, /\| y \| z \| passed \/ failed \| 5 \/ 9 /);
  assert.equal(T.learnTable([{ id: "a", success: true }]), null);
  assert.ok(!text.includes("\u2014"));
});

test("the recipe table reports the saveable rate with reasons, replay success and model calls per replay", () => {
  const rows = [
    { id: "a", success: true, recipe: { saveable: true, id: "r1", replay: { ok: true, state: "done_proven", modelCalls: 0, usd: 0, seconds: 12 } } },
    { id: "b", success: true, recipe: { saveable: true, id: "r2", replay: { ok: true, state: "stopped", modelCalls: 2, usd: 0.001, seconds: 20 } } },
    { id: "c", success: true, recipe: { saveable: false, why: "it worked in more than one tab" } },
    { id: "d", success: true, recipe: { saveable: false, why: "the run did nothing on a page to repeat" } },
    { id: "e", success: true, recipe: { saveable: false, why: "the run did nothing on a page to repeat" } },
    { id: "f", success: false, recipe: { saveable: true, id: "r3" } },
  ];
  const t = T.recipeTable(rows);
  assert.deepEqual([t.passed, t.saveable, t.replayed, t.replayOk, t.meanModelCalls], [5, 2, 2, 1, 1]);
  assert.deepEqual(t.notSaveable[0], { reason: "the run did nothing on a page to repeat", runs: 2 });
  const text = T.recipeMarkdown(t);
  assert.match(text, /Saveable: 2 of 5 \(40\.0%\) passed runs/);
  assert.match(text, /proven done: 1 of 2/);
  assert.match(text, /Model calls per replay: 1\.00 on average \(1 of 2 replays made none\)/);
  assert.equal(T.recipeTable([{ id: "a", success: true }]), null);
  assert.deepEqual(T.checkLeg("recipes", { rows, planned: [], shards: [{}], recipes: t }), []);
  assert.equal(T.checkLeg("recipes", { rows: [{ id: "a", success: true, ending: "finished", recipe: { saveable: false } }], planned: [], shards: [{}], recipes: t }).length, 1);
});

test("the cap leg fails unless the cap stopped the run and spend was counted", () => {
  const planned = [{ id: "a", slot: "a#1" }, { id: "b", slot: "b#1" }];
  const rows = [{ id: "a", slot: "a#1", ending: "finished" }];
  const stopped = { capReached: true, spentUSD: 0.002, stoppedEarly: "the spend cap of $0.00 was reached" };
  assert.deepEqual(T.checkLeg("cap", { rows, planned, shards: [stopped] }), []);
  assert.ok(T.checkLeg("cap", { rows, planned, shards: [{ capReached: false, spentUSD: 0.002 }] }).length >= 1);
  assert.ok(T.checkLeg("cap", { rows: [...rows, { id: "b", slot: "b#1", ending: "finished" }], planned, shards: [stopped] }).length >= 1);
  assert.ok(T.checkLeg("cap", { rows, planned, shards: [{ ...stopped, spentUSD: 0 }] }).length >= 1);
});

test("repeat runs are planned and counted one by one", () => {
  const tasks = [{ id: "a", level: "developer" }, { id: "b", level: "developer" }];
  const planned = T.plannedRuns(tasks, { runs: 2 });
  assert.deepEqual(planned.map((t) => t.slot), ["a#1", "a#2", "b#1", "b#2"]);
  const rows = [{ id: "a", slot: "a#1", run: 1, family: "developer", success: true, ending: "finished" }, { id: "a", slot: "a#2", run: 2, family: "developer", success: false, ending: "finished" }];
  const { total } = T.familyTable(rows, planned);
  assert.deepEqual([total.tasks, total.passed, total.failed, total.notRun], [4, 1, 1, 2]);
});

test("the tightened patterns take the right answer and turn away a near miss", () => {
  const by = Object.fromEntries(load("everyday-tasks.json").map((t) => [t.id, t]));
  const hit = (id, answer) => T.patternMatch(by[id], answer);
  assert.equal(hit("dev-github-vscode-licence", "It is under the MIT licence and mostly TypeScript."), true);
  assert.equal(hit("dev-github-vscode-licence", "I hit a rate limit on the TypeScript repository."), false);
  assert.equal(hit("map-osm-directions-cambridge-oxford", "About 135 km, 2 hours 5 minutes."), true);
  assert.equal(hit("map-osm-directions-cambridge-oxford", "It takes about 120 minutes."), false);
  assert.equal(hit("cross-has-mdn-caniuse", "It is supported for 94.5% of users."), true);
  assert.equal(hit("cross-has-mdn-caniuse", "I could not load caniuse.com, 0% done."), false);
  assert.equal(hit("lang-fr-permis-age", "On peut passer le permis B à partir de 17 ans."), true);
  assert.equal(hit("lang-fr-permis-age", "Voir l'article 17 du code."), false);
  assert.equal(hit("doc-pdf-attention-paper", "The encoder has 6 layers and uses 8 attention heads."), true);
  assert.equal(hit("doc-pdf-attention-paper", "Section 6 on page 8 covers this."), false);
  assert.equal(hit("nav-w3c-wcag22", "It became a Recommendation on 5 October 2023."), true);
  assert.equal(hit("nav-w3c-wcag22", "Some time in 2023 or 2024."), false);
  assert.equal(hit("doc-rfc9110-418", "418 is (Unused): it is reserved."), true);
  assert.equal(hit("doc-rfc9110-418", "It says I'm a teapot; no section is reserved for it."), false);
  assert.equal(hit("lang-zh-forbidden-city", "故宫于1420年建成。"), true);
  assert.equal(hit("lang-zh-forbidden-city", "面积约为714200平方米。"), false);
  // A status word says nothing: a run that could not read the page uses the same words.
  assert.equal(by["map-tfl-victoria-line"].pattern, undefined);
  // No rubric lets an empty or blocked page pass.
  for (const t of Object.values(by)) assert.ok(!/out of season|no games have been played/i.test(t.expect), t.id);
  for (const t of Object.values(by).filter((x) => x.level === "form-fill")) assert.match(t.expect, /harness's list of the final page's form controls/, t.id);
  for (const t of Object.values(by).filter((x) => !x.pattern && x.level !== "form-fill")) assert.match(t.expect, /a page that did not load, or shows none of this, is a failure or a block, never a pass/, t.id);
});

test("the workflow pairs each provider with its own key and gives the judge Anthropic's, with no dry fallback for a real run", () => {
  const y = fs.readFileSync(path.join(__dirname, "../../.github/workflows/real-tasks.yml"), "utf8");
  assert.match(y, /BENCH_API_KEY: \$\{\{ needs\.plan\.outputs\.dry != 'true' && \(needs\.plan\.outputs\.provider == 'anthropic' && secrets\.ANTHROPIC_API_KEY \|\| needs\.plan\.outputs\.provider == 'openai' && secrets\.OPENAI_API_KEY\) \|\| '' \}\}/);
  assert.match(y, /BENCH_JUDGE_KEY: \$\{\{ needs\.plan\.outputs\.dry != 'true' && secrets\.ANTHROPIC_API_KEY \|\| '' \}\}/);
  assert.match(y, /BENCH_JUDGE_URL: https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(y, /BENCH_KEY_PROVIDER: \$\{\{ needs\.plan\.outputs\.provider \}\}/);
  // Only the two paired secrets and the holdout tasks' passphrase are named anywhere, and none of the others the repository holds.
  const named = [...y.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), ["ANTHROPIC_API_KEY", "HOLDOUT_KEY", "OPENAI_API_KEY"]);
  // The passphrase only ever reaches openssl, as HOLDOUT_KEY in a decrypt step.
  for (const m of y.matchAll(/secrets\.HOLDOUT_KEY/g)) assert.match(y.slice(m.index - 40, m.index), /HOLDOUT_KEY: \$\{\{ $/);
  assert.equal(y.split("-pass env:HOLDOUT_KEY").length - 1, y.split("secrets.HOLDOUT_KEY").length - 1);
  assert.ok(!/has no BENCH_API_KEY|dry=true; why="the repository has no/.test(y), "a missing key never turns a real run into a dry one");
  assert.match(y, /Nothing was run\. Tick dry for a dry run\./);
  assert.match(y, /provider must be anthropic or openai/);
  // Every action is pinned to a commit.
  for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
  assert.ok(!y.includes("\u2014"));
});

// The plan step itself, run as GitHub runs it, with nothing but environment values.
function plan(env) {
  const y = fs.readFileSync(path.join(__dirname, "../../.github/workflows/real-tasks.yml"), "utf8");
  const from = y.indexOf("        run: |\n", y.indexOf("name: Work out what to run")) + "        run: |\n".length;
  const script = y.slice(from, y.indexOf("      - name: The task files are sound")).split("\n").map((l) => l.slice(10)).join("\n");
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "plan-"));
  const out = path.join(dir, "out");
  const summary = path.join(dir, "summary");
  const r = require("node:child_process").spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: path.join(__dirname, "../.."),
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, EVENT: "workflow_dispatch", IN_DRY: "false", HAS_ANTHROPIC_KEY: "true", HAS_OPENAI_KEY: "true", ...env },
    encoding: "utf8",
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const res = { status: r.status, said: `${r.stdout}${r.stderr}${read(summary)}`, outputs: Object.fromEntries(read(out).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test("the plan step fails a real run with a missing key or a pairing that is not written out, and never makes it dry", { skip: process.platform === "win32" }, () => {
  const ok = plan({});
  assert.equal(ok.status, 0, ok.said);
  assert.deepEqual([ok.outputs.dry, ok.outputs.provider, ok.outputs.model, ok.outputs.judge_model], ["false", "anthropic", "claude-haiku-5-5", "claude-sonnet-5-5"]);
  const openai = plan({ IN_PROVIDER: "openai" });
  assert.deepEqual([openai.status, openai.outputs.dry, openai.outputs.model], [0, "false", "gpt-5.4-mini"]);

  // A missing key fails the job, and no output says dry.
  for (const env of [{ HAS_ANTHROPIC_KEY: "false" }, { HAS_ANTHROPIC_KEY: "" }, { IN_PROVIDER: "openai", HAS_OPENAI_KEY: "false" }, { IN_PROVIDER: "openai", HAS_ANTHROPIC_KEY: "false" }]) {
    const r = plan(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.said, /has no (ANTHROPIC|OPENAI)_API_KEY secret/);
    assert.equal(r.outputs.dry, undefined);
  }
  assert.match(plan({ IN_PROVIDER: "openai", HAS_OPENAI_KEY: "false" }).said, /no OPENAI_API_KEY secret, which provider openai needs/);
  assert.match(plan({ IN_PROVIDER: "openai", HAS_ANTHROPIC_KEY: "false" }).said, /no ANTHROPIC_API_KEY secret, which the judge needs/);

  // A provider with no key paired to it, a model of another provider, a judge that is not Claude.
  for (const env of [{ IN_PROVIDER: "nvidia" }, { IN_PROVIDER: "custom" }, { IN_PROVIDER: "openai", IN_MODEL: "claude-haiku-5-5" }, { IN_PROVIDER: "anthropic", IN_MODEL: "gpt-5.4-mini" }, { IN_JUDGE_MODEL: "gpt-5.5" }, { IN_MODEL: "claude-sonnet-5-5" }, { IN_MAX_USD: "0" }, { IN_RUNS: "9" }]) {
    const r = plan(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.outputs.dry, undefined);
  }

  // Dry only when asked for, or on a push; then no key is needed.
  const dry = plan({ IN_DRY: "true", HAS_ANTHROPIC_KEY: "false", HAS_OPENAI_KEY: "false" });
  assert.deepEqual([dry.status, dry.outputs.dry, dry.outputs.tasks], [0, "true", "tests/bench/fixture-tasks.json"]);
  const push = plan({ EVENT: "push", IN_DRY: "", HAS_ANTHROPIC_KEY: "false", HAS_OPENAI_KEY: "false" });
  assert.deepEqual([push.status, push.outputs.dry], [0, "true"]);

  // The learn suite is counted in pairs, with learning on; the inputs for learning, repeats and recipes pass through.
  const learn = plan({ IN_SUITE: "learn", IN_SHARDS: "12" });
  assert.deepEqual([learn.status, learn.outputs.learn, learn.outputs.tasks], [0, "pairs", "tests/bench/learn-tasks.json"]);
  assert.match(learn.said, /18 pair\(s\)/);
  const more = plan({ IN_LEARNING: "true", IN_RUNS: "2", IN_RECIPES: "true", IN_MAX_USD: "3", IN_SHARDS: "6" });
  assert.deepEqual([more.outputs.learn, more.outputs.runs, more.outputs.recipes, more.outputs.cap_per_shard], ["on", "2", "true", "0.5000"]);
});

// A books page as the harness's innerText sees it (no ratings) and as the engine read it (the class-carried rating shown).
function booksRun() {
  const filler = Array.from({ length: 400 }, (_, i) => `Filler book ${i} £${(30 + (i % 50)).toFixed(2)} In stock Add to basket`).join("\n");
  const inner = `Mystery\n32 results\n${filler}\nThe Girl You Lost\n£12.29\nIn stock\nAdd to basket`;
  const engine = `Mystery\n32 results\n${filler}\n[class "star-rating Five"]\nThe Girl You Lost\n£12.29\nIn stock\nAdd to basket`;
  const url = "https://books.toscrape.com/catalogue/category/books/mystery_3/page-2.html";
  return {
    run: {
      task: "Find the five-star Mystery books under £20.", startUrl: "https://books.toscrape.com/", ending: "finished",
      answer: 'Only one: "The Girl You Lost": £12.29, rated five stars.',
      history: [{ step: 1, ok: true, action: "navigate", outcome: "Opened page 2", goal: "MODEL GOAL do not show", note: "MODEL NOTE do not show" }],
      notes: "MODEL NOTES do not show", finalUrl: url, finalTitle: "Mystery", finalText: inner, pages: [{ url, title: "Mystery", text: inner }],
    },
    reading: { url, title: "Mystery", text: engine },
  };
}

test("the engine's reading grounds a class-carried rating the innerText capture lacks, and the judge is shown its passage", () => {
  const { run, reading } = booksRun();
  assert.ok(!/star-rating/.test(J.judgeMessage(run)), "without the reading the judge sees no rating");
  // The worker side: what the engine kept, model text left behind.
  const prev = globalThis.self;
  globalThis.self = { SELECT_TO_AI_ENGINE: { sessions: new Map([[1, { run: { id: "r1", memory: "MODEL NOTES", answers: ["MODEL ANSWER"], seen: [{ ...reading, digest: "d" }], children: [{ run: { seen: [{ url: "https://books.toscrape.com/sub", title: "Sub", text: "sub page text" }] } }] }, runners: new Map() }]]) } };
  let got;
  try { got = T.engineReadingsInWorker("r1", {}); assert.equal(T.engineReadingsInWorker("other", {}).length, 0); assert.ok(T.engineReadingsInWorker("r1", { [reading.url]: reading.text.length })[0].same); } finally { globalThis.self = prev; }
  assert.deepEqual(got.map((p) => Object.keys(p).sort().join(",")), ["text,title,url", "text,title,url"], "page text only, nothing the model wrote");
  const readings = [...T.mergeReadings(new Map(), got).values()];
  run.engineReadings = T.engineExcerpts(readings, run.answer);
  run.grounding = T.answerGrounding({ ...run, readings, finalText: "", pages: [] });
  assert.deepEqual(run.grounding, { numbers: 1, found: 1, missing: [] });
  const msg = J.judgeMessage(run);
  assert.match(msg, /The engine's reading of the pages visited/);
  assert.ok(msg.includes(`Page: Mystery | ${reading.url} (excerpt of`));
  assert.match(msg, /\[class "star-rating Five"\]\nThe Girl You Lost\n£12\.29/, "the passage around the answer's values");
  assert.match(msg, /"The Girl You Lost": on .*\(engine's reading\)/);
  assert.match(J.JUDGE_SYSTEM, /engine's reading/);
  for (const s of ["MODEL GOAL", "MODEL NOTE", "MODEL ANSWER"]) assert.ok(!msg.includes(s), s);
});

test("the engine's readings given to the judge stay within their bounds", () => {
  const big = (i) => ({ url: `https://a.example/${i}`, title: `P${i}`, text: `${"x".repeat(5000)} value 4242 ${"y".repeat(300000)} value 4242 again ${"z".repeat(300000)} 4242` });
  const out = T.engineExcerpts(Array.from({ length: 30 }, (_, i) => big(i)), "It is 4242, see **value**");
  assert.ok(out.length <= T.READING.pages);
  for (const p of out) { assert.ok(p.text.length <= T.READING.perPage, `${p.text.length}`); assert.ok(p.chars > p.text.length); }
  assert.ok(out.reduce((n, p) => n + p.text.length, 0) <= T.READING.total);
  assert.ok(out[0].text.includes("value 4242 again"), "a later passage holding the value is kept");
  assert.ok(J.engineReadingText(out).length < T.READING.total + 3000);
  assert.equal(J.engineReadingText([]), "");
  // With nothing to look for, each page still shows its opening only.
  assert.ok(T.engineExcerpts([big(0)], "done")[0].text.length <= T.READING.head);
});
