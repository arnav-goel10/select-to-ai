"use strict";
// The holdout suite: its file loads and is sound, it shares no site with
// another suite, and its summary shows numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const T = require("../bench/trial.js");
const J = require("../bench/judge.js");

const ROOT = path.join(__dirname, "../..");
const FILE = path.join(ROOT, "tests/bench/holdout-tasks.json");
const raw = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
const LIVE = /a page that did not load, or shows none of this, is a failure or a block, never a pass/;
const FORM = /harness's list of the final page's form controls/;

test("holdout-tasks.json loads through the same loader as every suite, with its rule beside the tasks", () => {
  const file = raw();
  assert.ok(!Array.isArray(file) && Array.isArray(file.tasks), "an object with the rule and the task list");
  assert.match(file.rule, /Nobody tunes the agent on this file/);
  assert.match(file.rule, /numbers only/);
  assert.match(file.rule, /replaced/);
  const loaded = J.normaliseTasks(file);
  assert.equal(loaded.length, file.tasks.length);
  assert.ok(loaded.length >= 45 && loaded.length <= 50, `${loaded.length} tasks`);
  assert.deepEqual(T.validateTasks(file.tasks), []);
  // A list file still loads as before, and the difficulty survives loading.
  assert.equal(J.normaliseTasks(file.tasks).length, loaded.length);
  assert.ok(loaded.every((t) => T.DIFFICULTIES.includes(t.difficulty)));
  assert.equal(J.taskList({ nothing: 1 }).length, 0);
  // The run plan and a smaller sample work on it as on any suite.
  assert.equal(T.plannedRuns(loaded, { runs: 2 }).length, loaded.length * 2);
  assert.equal(J.sampleTasks(loaded, 12, 1).length, 12);
});

test("the holdout tasks spread over families, difficulties and languages, and each can be judged", () => {
  const { tasks } = raw();
  const per = (k) => tasks.reduce((m, t) => ({ ...m, [t[k]]: (m[t[k]] || 0) + 1 }), {});
  const families = per("level");
  assert.ok(Object.keys(families).length >= 10, JSON.stringify(families));
  assert.ok(families.widgets >= 6, "widgets: hover, drag, sliders, keys, pickers, frames, dialogs");
  assert.ok(!families.fixture);
  const levels = per("difficulty");
  for (const d of T.DIFFICULTIES) assert.ok(levels[d] >= 8, `${d}: ${levels[d]}`);
  // Every family is big enough to get its own line in a sealed summary.
  for (const [f, n] of Object.entries(families)) assert.ok(n >= T.SEALED_MIN_GROUP, `${f}: ${n}`);
  assert.ok(new Set(tasks.filter((t) => t.lang).map((t) => t.lang)).size >= 5);
  assert.ok(tasks.filter((t) => /\.pdf(\b|$)/i.test(t.url)).length >= 4, "PDFs of several origins");
  for (const t of tasks) {
    assert.ok(t.expect, `${t.id}: expect`);
    if (t.pattern) continue;
    assert.ok(LIVE.test(t.expect) || FORM.test(t.expect), `${t.id}: with no pattern, the rubric must say how a live value or a form is judged`);
  }
  for (const t of tasks.filter((x) => x.level === "form-fill")) assert.match(t.expect, FORM, t.id);
  // At most three tasks on one site, so one site that changes cannot move the score much.
  const bySite = {};
  for (const t of tasks) for (const s of T.taskSites(t)) bySite[s] = (bySite[s] || 0) + 1;
  for (const [s, n] of Object.entries(bySite)) assert.ok(n <= 3, `${s}: ${n}`);
});

test("no holdout task uses a site that any other suite uses", () => {
  const suites = T.readSuites(ROOT);
  const { holdout, ...others } = suites;
  assert.deepEqual(Object.keys(others).sort(), ["dev", "everyday", "learn"]);
  assert.deepEqual(T.holdoutProblems(holdout, others), []);
  // The other suites' own sites, by registrable domain.
  const used = new Set(Object.values(others).flat().flatMap(T.taskSites));
  assert.ok(used.has("wikipedia.org") && used.has("nasa.gov"), "subdomains fold into their registrable domain");
  for (const t of holdout) for (const s of T.taskSites(t)) assert.ok(!used.has(s), `${t.id}: ${s}`);
});

test("the overlap rule catches a shared domain by start page, by a named site and by subdomain", () => {
  const others = { everyday: [{ id: "e1", url: "https://en.wikipedia.org/wiki/X", sites: ["britannica.com"] }, { id: "e2", url: "https://the-internet.herokuapp.com/" }, { id: "e3", url: "https://science.nasa.gov/jupiter/" }] };
  const h = (over) => [{ id: "h1", level: "fact-lookup", difficulty: "easy", url: "https://example.org/", task: "x", expect: "y", ...over }];
  assert.deepEqual(T.holdoutProblems(h({}), others), []);
  assert.match(T.holdoutProblems(h({ url: "https://ja.wikipedia.org/wiki/Y" }), others).join(), /wikipedia\.org is also used by everyday \(e1\)/);
  assert.match(T.holdoutProblems(h({ url: "https://www.britannica.com/place/Z" }), others).join(), /britannica\.com/);
  assert.match(T.holdoutProblems(h({ sites: ["https://www.nasa.gov/"] }), others).join(), /nasa\.gov/);
  // Two apps on a shared host suffix are two sites.
  assert.deepEqual(T.holdoutProblems(h({ url: "https://formy-project.herokuapp.com/" }), others), []);
  assert.match(T.holdoutProblems(h({ difficulty: undefined }), others).join(), /needs a difficulty/);
  assert.equal(T.validateTasks(h({ difficulty: "tricky" })).length, 1);
  // The command the workflow runs passes on the real files and prints counts only.
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/trial.js"), "holdout-check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const t of raw().tasks) assert.ok(!r.stdout.includes(t.id), t.id);
});

// Rows as run.js writes them, full of what a sealed summary must not show.
function fakeRows(tasks) {
  const endings = ["finished", "finished", "timed out after 300s", "finished", "browser crashed"];
  return tasks.map((t, i) => {
    const kind = i % 5;
    return {
      id: t.id, slot: `${t.id}#1`, run: 1, family: t.level, level: t.level, startUrl: t.url,
      success: kind === 0 || kind === 3, blocked: kind === 1 && i % 2 === 0, waitKind: kind === 1 && i % 2 === 0 ? "human_check" : "",
      ending: endings[kind], infra: kind === 4, seconds: 30 + i, steps: 5, costUSD: 0.01, judgeCostUSD: 0.02,
      answer: `The answer for ${t.id} at ${t.url} is 42`, reason: `judge on ${t.id}: secret reason`, patternMatch: kind === 3 ? false : null,
      counters: { scriptedInputs: 1, realInputs: 0, typedActions: 1, heldActions: 0 },
    };
  });
}

test("the sealed report holds totals, rates, time, spend and counts by family and difficulty, and nothing that names a task", () => {
  const tasks = T.plannedRuns(J.normaliseTasks(raw()));
  const rows = fakeRows(tasks);
  const report = T.sealedReport(rows, tasks, { suite: "holdout", arm: "shipped", commit: "abcdef0123", armProblems: [], armChecked: true, stopped: ["3 runs in a row were lost (browser crashed)"] });
  const text = T.sealedMarkdown(report);
  const json = JSON.stringify(report);
  assert.deepEqual(T.leaksIn(text, tasks), []);
  assert.deepEqual(T.leaksIn(json, tasks), []);
  for (const s of ["secret reason", "The answer for", "browser crashed", "runs in a row"]) { assert.ok(!text.includes(s), s); assert.ok(!json.includes(s), s); }
  assert.ok(!("runs" in report) && !("notRun" in report));
  // The totals add up, and every run is in one difficulty and one family.
  const t = report.total;
  assert.equal(t.tasks, tasks.length);
  assert.equal(t.passed + t.failed + t.timedOut + t.blocked + t.lost + t.notRun, tasks.length);
  assert.equal(report.byDifficulty.reduce((n, l) => n + l.tasks, 0), tasks.length);
  assert.equal(report.byDifficulty.reduce((n, l) => n + l.passed, 0), t.passed);
  assert.deepEqual(report.byDifficulty.map((l) => l.difficulty), ["easy", "medium", "hard"]);
  assert.equal(report.byFamily.reduce((n, l) => n + l.tasks, 0), tasks.length);
  assert.ok(t.medianSeconds > 0 && t.spendUSD > 0 && t.passRate > 0 && t.passRate < 1);
  assert.equal(report.meta.shardsStoppedEarly, 1);
  for (const s of ["Passed", "Median", "Model spend", "| family |", "| difficulty |", "easy", "hard", "Arm check: passed"]) assert.ok(text.includes(s), s);
  // A smaller sample puts one or two tasks in a family: those families are counted together, never alone.
  const few = T.plannedRuns(J.sampleTasks(J.normaliseTasks(raw()), 12, 1));
  const small = T.sealedReport(fakeRows(few), few, { armProblems: [] });
  for (const l of [...small.byFamily, ...small.byDifficulty]) if (l.family !== "other" && l.difficulty !== "other") assert.ok(l.tasks >= T.SEALED_MIN_GROUP, JSON.stringify(l));
  assert.ok(small.byFamily.some((l) => l.family === "other"));
  assert.equal(small.byFamily.reduce((n, l) => n + l.tasks, 0), few.length);
  assert.match(T.sealedMarkdown(small), /Families of fewer than 3 tasks, together/);
  // A text that names a task is caught, by id or by start page.
  assert.deepEqual(T.leaksIn(`failed: ${tasks[3].id}`, tasks), [tasks[3].id]);
  assert.deepEqual(T.leaksIn(`opened ${tasks[5].url}`, tasks), [tasks[5].id]);
});

test("summary --sealed prints and writes numbers only; the default summary still lists runs", () => {
  const all = J.normaliseTasks(raw());
  const tasks = T.plannedRuns(all);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-"));
  for (const row of fakeRows(tasks)) {
    fs.mkdirSync(path.join(dir, row.id, "run1"), { recursive: true });
    fs.writeFileSync(path.join(dir, row.id, "run1", "run.json"), JSON.stringify(row));
  }
  fs.writeFileSync(path.join(dir, "results-1of1.json"), JSON.stringify({ agent: { provider: "anthropic", model: "claude-haiku-5-5", debuggerAvailable: false }, judge: { model: "claude-sonnet-5-5" }, spentUSD: 1.5, capUSD: 5, stoppedEarly: "" }));
  const run = (...extra) => spawnSync(process.execPath, [path.join(ROOT, "tests/bench/trial.js"), "summary", dir, "--tasks", FILE, "--suite", "holdout", "--arm", "shipped", "--shards", "1", ...extra], { cwd: ROOT, encoding: "utf8" });
  const sealed = run("--sealed");
  assert.equal(sealed.status, 0, sealed.stderr);
  const written = fs.readFileSync(path.join(dir, "trial-summary.json"), "utf8");
  assert.deepEqual(T.leaksIn(sealed.stdout + sealed.stderr, tasks), []);
  assert.deepEqual(T.leaksIn(written, tasks), []);
  assert.ok(!/secret reason|The answer for/.test(sealed.stdout + written));
  assert.equal(JSON.parse(written).sealed, true);
  assert.match(sealed.stdout, /sealed: numbers only/);
  // The leaks command the dry leg runs on a sealed log.
  const log = path.join(dir, "log.txt");
  fs.writeFileSync(log, "run 1 of 50 done\nrun 2 of 50 done\n");
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "tests/bench/trial.js"), "leaks", log, "--tasks", FILE], { encoding: "utf8" }).status, 0);
  fs.appendFileSync(log, `PASS  ${all[0].id}\n`);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "tests/bench/trial.js"), "leaks", log, "--tasks", FILE], { encoding: "utf8" }).status, 1);
  // Without --sealed the same folder gives the open summary, which does name runs: the flag is what seals it.
  const open = run();
  assert.equal(open.status, 0, open.stderr);
  assert.ok(T.leaksIn(fs.readFileSync(path.join(dir, "trial-summary.json"), "utf8"), tasks).length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("run.js prints no task in sealed mode", () => {
  const src = fs.readFileSync(path.join(ROOT, "tests/bench/run.js"), "utf8");
  assert.match(src, /const SEALED = process\.env\.BENCH_QUIET === "sealed";/);
  assert.match(src, /if \(SEALED\) console\.log\(`run \$\{rows\.length\} of \$\{tasks\.length \* RUNS\} done`\);\n\s+else console\.log\(`\$\{markOf\(row\)/);
  assert.match(src, /console\.log\(SEALED \? `run \$\{rows\.length\} of \$\{tasks\.length \* RUNS\} recorded earlier` :/);
});

// The workflow's plan step, run as GitHub runs it (the same way trial.test.js does).
function plan(env) {
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/real-tasks.yml"), "utf8");
  const from = y.indexOf("        run: |\n", y.indexOf("name: Work out what to run")) + "        run: |\n".length;
  const script = y.slice(from, y.indexOf("      - name: The task files are sound")).split("\n").map((l) => l.slice(10)).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
  const out = path.join(dir, "out");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, "summary"), EVENT: "workflow_dispatch", IN_DRY: "false", HAS_ANTHROPIC_KEY: "true", HAS_OPENAI_KEY: "true", ...env },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries((fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, outputs, said: r.stdout + r.stderr };
}

test("the workflow runs suite=holdout sealed: numbers-only summary, per-task files apart, checked on every push", { skip: process.platform === "win32" }, () => {
  const h = plan({ IN_SUITE: "holdout" });
  assert.equal(h.status, 0, h.said);
  assert.deepEqual([h.outputs.tasks, h.outputs.sealed, h.outputs.dry], ["tests/bench/holdout-tasks.json", "true", "false"]);
  assert.equal(plan({ IN_SUITE: "everyday" }).outputs.sealed, "false");
  assert.equal(plan({ IN_SUITE: "holdout", IN_DRY: "true" }).outputs.sealed, "false", "a dry run plays the fixtures, not the holdout");
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/real-tasks.yml"), "utf8");
  assert.match(y, /options: \[everyday, dev, learn, holdout\]/);
  assert.match(y, /BENCH_QUIET: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 'sealed' \|\| '' \}\}/);
  assert.match(y, /format\('holdout-SEALED-per-task-do-not-open-shard-\{0\}', matrix\.shard\) \|\| format\('trial-shard-\{0\}', matrix\.shard\)/);
  assert.match(y, /retention-days: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 1 \|\| 30 \}\}/);
  assert.match(y, /pattern: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 'holdout-SEALED-per-task-do-not-open-shard-\*' \|\| 'trial-shard-\*' \}\}/);
  assert.match(y, /if \[ "\$SEALED" = "true" \]; then check="\$check --sealed"; fi/);
  assert.match(y, /node tests\/bench\/trial\.js holdout-check/);
  assert.match(y, /\{ leg: sealed, .*check: sealed, quiet: sealed \}/);
  assert.match(y, /trial\.js leaks tests\/bench\/out\/leg-run\.log/);
  assert.ok(!y.includes("\u2014"));
  // The rule is written where people working on the agent will see it.
  const readme = fs.readFileSync(path.join(ROOT, "tests/bench/README.md"), "utf8");
  assert.match(readme, /Nobody tunes the agent on/);
  assert.match(readme, /numbers only/);
  assert.match(readme, /replaced, not worked around/);
});
