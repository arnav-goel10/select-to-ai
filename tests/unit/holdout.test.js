"use strict";
// The holdout suite: the repository holds it encrypted only, its plain file
// (when one is here) is sound and shares no site with another suite, and
// nothing a sealed run prints, at any limit, names a task, shows one or two
// tasks' own result, or carries a failure's text.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const T = require("../bench/trial.js");
const J = require("../bench/judge.js");

const ROOT = path.join(__dirname, "../..");
const TRIAL = path.join(ROOT, "tests/bench/trial.js");
// The plain task file: decrypted in the workflow, or HOLDOUT_TASKS on the editor's machine. Absent elsewhere.
const PLAIN = T.holdoutFile(ROOT);
const needsPlain = { skip: PLAIN ? false : "no plain holdout file here: the repository holds it encrypted (set HOLDOUT_TASKS to a plain copy to run this)" };
const raw = () => JSON.parse(fs.readFileSync(PLAIN, "utf8"));

// A stand-in with the holdout file's shape, so the sealed paths are tested on every machine.
const SPREAD = { "fact-lookup": 6, "cross-site": 3, "tables-lists": 3, "form-fill": 3, widgets: 6, navigation: 4, "long-docs": 5, "non-english": 6, developer: 3, shopping: 3, "maps-transit": 5, "news-sports": 3 };
function synthetic() {
  const tasks = [];
  const levels = ["easy", "medium", "medium", "hard"];
  const langs = ["de", "es", "nl", "ja", "zh", "fr"];
  for (const [family, n] of Object.entries(SPREAD)) {
    for (let i = 0; i < n; i++) {
      const k = tasks.length;
      const t = { id: `stand-in-${family}-${i}`, level: family, difficulty: levels[k % 4], url: `https://www.standin${k}.org/start`, task: `Read the value on this page (${k}).`, expect: `The value ${k}.`, pattern: `\\b${k}\\b` };
      if (family === "form-fill") { t.url = `https://demo.automationtesting.in/f${k}`; t.task = "Fill in the form but do not submit it."; t.expect = "Judge each value from the harness's list of the final page's form controls."; delete t.pattern; }
      if (family === "non-english") t.lang = langs[i];
      tasks.push(t);
    }
  }
  return { rule: "HELD-OUT SET. Nobody tunes the agent on this file. Results are read as numbers only. A task that breaks is replaced.", tasks };
}

test("the repository holds the holdout tasks encrypted only, with the plain path ignored and the way to edit them written down", () => {
  const enc = fs.readFileSync(path.join(ROOT, T.HOLDOUT_ENCRYPTED));
  assert.equal(enc.subarray(0, 8).toString("latin1"), "Salted__", "openssl enc output");
  assert.ok(enc.length > 4000, `${enc.length} bytes`);
  for (const plainWords of ['"tasks"', '"expect"', "https://"]) assert.ok(!enc.includes(Buffer.from(plainWords)), plainWords);
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", T.SUITES.holdout], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(tracked.status, 0, "the plain file is not tracked");
  assert.equal(spawnSync("git", ["check-ignore", "-q", T.SUITES.holdout], { cwd: ROOT }).status, 0, "the plain path is ignored");
  const readme = fs.readFileSync(path.join(ROOT, "tests/bench/README.md"), "utf8");
  for (const s of ["HOLDOUT_KEY", "openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256", "-d -aes-256-cbc", "holdout-check --detail", "HOLDOUT_TASKS"]) assert.ok(readme.includes(s), s);
  assert.match(readme, /history still holds the first draft/);
});

test("holdout-check needs the plain file and says how to get it, naming no task", () => {
  const r = spawnSync(process.execPath, [TRIAL, "holdout-check"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, HOLDOUT_TASKS: path.join(os.tmpdir(), "no-such-holdout.json") } });
  if (!fs.existsSync(path.join(ROOT, T.SUITES.holdout))) {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /decrypt tests\/bench\/holdout-tasks\.json\.enc/);
  }
});

test("the plain holdout file is sound and shaped as its rule says, and holdout-check prints counts only", needsPlain, () => {
  const file = raw();
  assert.deepEqual(T.holdoutShapeProblems(file), []);
  assert.deepEqual(T.validateTasks(file.tasks), []);
  const loaded = J.normaliseTasks(file);
  assert.equal(loaded.length, file.tasks.length);
  assert.ok(loaded.every((t) => T.DIFFICULTIES.includes(t.difficulty)));
  assert.equal(T.plannedRuns(loaded, { runs: 2 }).length, loaded.length * 2);
  const r = spawnSync(process.execPath, [TRIAL, "holdout-check"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, HOLDOUT_TASKS: PLAIN } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(T.leaksIn(r.stdout + r.stderr, loaded), []);
});

test("no holdout task uses a site that any other suite uses", needsPlain, () => {
  const { holdout, ...others } = T.readSuites(ROOT);
  assert.deepEqual(Object.keys(others).sort(), ["dev", "everyday", "learn"]);
  assert.deepEqual(T.holdoutProblems(holdout, others), []);
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
  assert.deepEqual(T.holdoutProblems(h({ url: "https://formy-project.herokuapp.com/" }), others), []);
  assert.match(T.holdoutProblems(h({ difficulty: undefined }), others).join(), /needs a difficulty/);
  assert.equal(T.validateTasks(h({ difficulty: "tricky" })).length, 1);
});

test("the shape check holds the suite to its spread and fixes no share of PDFs", () => {
  const good = synthetic();
  assert.deepEqual(T.holdoutShapeProblems(good), []);
  // No PDF at all is fine, and so are many: the suite is not shaped around one fix.
  assert.ok(!good.tasks.some((t) => /\.pdf/i.test(t.url)));
  const pdfs = synthetic();
  for (const t of pdfs.tasks.filter((x) => x.level === "long-docs")) t.url += ".pdf";
  assert.deepEqual(T.holdoutShapeProblems(pdfs), []);
  const thin = synthetic();
  thin.tasks = thin.tasks.filter((t, i) => !(t.level === "developer" && i % 2 === 0));
  assert.match(T.holdoutShapeProblems(thin).join("\n"), /family developer has [12] task\(s\), fewer than 3/);
  const crowded = synthetic();
  for (const t of crowded.tasks.slice(0, 4)) t.url = "https://same.example.net/p";
  assert.match(T.holdoutShapeProblems(crowded).join("\n"), /4 tasks on example\.net, more than 3/);
  const ruleless = { ...synthetic(), rule: "" };
  assert.match(T.holdoutShapeProblems(ruleless).join("\n"), /Nobody tunes the agent/);
});

// Rows as run.js writes them, full of what a sealed summary must not show.
function fakeRows(tasks) {
  const endings = ["finished", "finished", "timed out after 300s", "finished", "harness error: net::ERR_ABORTED at chrome-extension://abc/agent.html?task=Find%20the%20price"];
  return tasks.map((t, i) => {
    const kind = i % 5;
    return {
      id: t.id, slot: t.slot || `${t.id}#1`, run: 1, family: t.level, level: t.level, startUrl: t.url,
      success: kind === 0 || kind === 3, blocked: kind === 1 && i % 2 === 0, waitKind: kind === 1 && i % 2 === 0 ? "human_check" : "",
      ending: endings[kind], infra: kind === 4, seconds: 30 + i, steps: 5, costUSD: 0.01, judgeCostUSD: 0.02,
      answer: `The answer for ${t.id} at ${t.url} is 42`, reason: `judge on ${t.id}: secret reason`, patternMatch: kind === 3 ? false : null,
      counters: { scriptedInputs: 1, realInputs: 0, typedActions: 1, heldActions: 0 },
    };
  });
}
const FAILURE_TEXT = ["secret reason", "The answer for", "harness error", "agent.html", "Find%20the%20price", "runs in a row", "timed out after"];

test("the sealed report holds totals, rates, time, spend and counts by family and difficulty, and no task or failure text", () => {
  const tasks = T.plannedRuns(J.normaliseTasks(synthetic()));
  const rows = fakeRows(tasks);
  const report = T.sealedReport(rows, tasks, { suite: "holdout", arm: "shipped", commit: "abcdef0123", armProblems: [], armChecked: true, stopped: ["3 runs in a row were lost (harness error: net::ERR_ABORTED at chrome-extension://abc/agent.html?task=Find%20the%20price)"] });
  const text = T.sealedMarkdown(report);
  const json = JSON.stringify(report);
  assert.deepEqual(T.leaksIn(text, tasks), []);
  assert.deepEqual(T.leaksIn(json, tasks), []);
  for (const s of FAILURE_TEXT) { assert.ok(!text.includes(s), s); assert.ok(!json.includes(s), s); }
  assert.ok(!("runs" in report) && !("notRun" in report));
  const t = report.total;
  assert.equal(t.tasks, tasks.length);
  assert.equal(t.passed + t.failed + t.timedOut + t.blocked + t.lost + t.notRun, tasks.length);
  assert.equal(report.byDifficulty.reduce((n, l) => n + l.tasks, 0), tasks.length);
  assert.equal(report.byDifficulty.reduce((n, l) => n + l.passed, 0), t.passed);
  assert.deepEqual(report.byDifficulty.map((l) => l.difficulty), ["easy", "medium", "hard"]);
  assert.equal(report.byFamily.reduce((n, l) => n + l.tasks, 0), tasks.length);
  assert.ok(t.medianSeconds > 0 && t.spendUSD > 0 && t.passRate > 0 && t.passRate < 1);
  assert.equal(report.meta.shardsStoppedEarly, 1);
  for (const s of ["Passed", "Median", "Model spend", "| family |", "| difficulty |", "easy", "hard", "Arm check: passed", "1 shard(s) stopped early"]) assert.ok(text.includes(s), s);
  assert.deepEqual(T.leaksIn(`failed: ${tasks[3].id}`, tasks), [tasks[3].id]);
  assert.deepEqual(T.leaksIn(`opened ${tasks[5].url}`, tasks), [tasks[5].id]);
});

// Every line of a sealed summary, at every limit, holds 3 tasks or more; below 3 tasks there is no summary at all.
function checkEveryLimit(all) {
  for (const runs of [1, 2]) {
    for (let limit = 1; limit <= all.length; limit++) {
      for (const seed of [1, 2, 3]) {
        const planned = T.plannedRuns(all, { sample: limit, seed, runs });
        const distinct = new Set(planned.map((p) => p.id)).size;
        const rows = fakeRows(planned);
        if (distinct < T.SEALED_MIN_GROUP) { assert.throws(() => T.sealedReport(rows, planned, { armProblems: [] }), /at least 3 tasks/, `limit ${limit}`); continue; }
        const report = T.sealedReport(rows, planned, { armProblems: [] });
        for (const field of ["level", "difficulty"]) {
          const lines = T.groupTable(rows, planned, field, T.SEALED_MIN_GROUP);
          for (const l of lines) assert.ok(l.distinctTasks >= T.SEALED_MIN_GROUP, `limit ${limit} seed ${seed} runs ${runs}: ${field} ${l[field]} holds ${l.distinctTasks} task(s)`);
          assert.equal(lines.reduce((n, l) => n + l.distinctTasks, 0), distinct);
        }
        assert.equal(report.byFamily.reduce((n, l) => n + l.tasks, 0), planned.length);
        assert.equal(report.byDifficulty.reduce((n, l) => n + l.tasks, 0), planned.length);
      }
    }
  }
}

test("at any limit no line of a sealed summary holds one or two tasks, and below three tasks there is no summary", () => {
  checkEveryLimit(J.normaliseTasks(synthetic()));
  // The case the review found: one small family left over goes in with the smallest named one.
  const few = [{ id: "a", level: "x", difficulty: "easy" }, { id: "b", level: "x", difficulty: "easy" }, { id: "c", level: "x", difficulty: "easy" }, { id: "d", level: "y", difficulty: "hard" }].map((t) => ({ ...t, slot: `${t.id}#1` }));
  const lines = T.groupTable([], few, "level", 3);
  assert.deepEqual(lines.map((l) => [l.level, l.distinctTasks]), [["other", 4]]);
  assert.match(T.sealedMarkdown(T.sealedReport([], few, { armProblems: [] })), /Smaller families, together \| 4 \|/);
});

test("the real holdout file at every limit too", needsPlain, () => {
  checkEveryLimit(J.normaliseTasks(raw()));
});

test("summary --sealed prints and writes numbers only, refuses fewer than 3 tasks, and crashes without detail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-"));
  const file = path.join(dir, "tasks.json");
  fs.writeFileSync(file, JSON.stringify(synthetic()));
  const all = J.normaliseTasks(synthetic());
  const tasks = T.plannedRuns(all);
  const out = path.join(dir, "out");
  for (const row of fakeRows(tasks)) {
    fs.mkdirSync(path.join(out, row.id, "run1"), { recursive: true });
    fs.writeFileSync(path.join(out, row.id, "run1", "run.json"), JSON.stringify(row));
  }
  fs.writeFileSync(path.join(out, "results-1of1.json"), JSON.stringify({ agent: { provider: "anthropic", model: "claude-haiku-5-5", debuggerAvailable: false }, judge: { model: "claude-sonnet-5-5" }, spentUSD: 1.5, capUSD: 5, stoppedEarly: "3 runs in a row were lost (harness error: agent.html?task=Find%20the%20price)" }));
  const run = (...extra) => spawnSync(process.execPath, [TRIAL, "summary", out, "--tasks", file, "--suite", "holdout", "--arm", "shipped", "--shards", "1", ...extra], { cwd: ROOT, encoding: "utf8" });
  const sealed = run("--sealed");
  assert.equal(sealed.status, 0, sealed.stderr);
  const written = fs.readFileSync(path.join(out, "trial-summary.json"), "utf8");
  assert.deepEqual(T.leaksIn(sealed.stdout + sealed.stderr, tasks), []);
  assert.deepEqual(T.leaksIn(written, tasks), []);
  for (const s of FAILURE_TEXT) assert.ok(!(sealed.stdout + sealed.stderr + written).includes(s), s);
  assert.equal(JSON.parse(written).sealed, true);
  assert.match(sealed.stdout, /sealed: numbers only/);
  // A limit of 1 or 2: refused, nothing written, nothing named.
  for (const n of ["1", "2"]) {
    fs.rmSync(path.join(out, "trial-summary.json"), { force: true });
    const small = run("--sealed", "--sample", n);
    assert.equal(small.status, 1);
    assert.match(small.stderr, /needs at least 3 tasks/);
    assert.deepEqual(T.leaksIn(small.stdout + small.stderr, tasks), []);
    assert.ok(!fs.existsSync(path.join(out, "trial-summary.json")));
  }
  // A summary that breaks: here the task file's path names a task, as a run's folder would. A sealed summary prints none of it.
  const broken = spawnSync(process.execPath, [TRIAL, "summary", out, "--tasks", path.join(dir, `${all[0].id}.json`), "--suite", "holdout", "--sealed"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /stopped with an error; the detail is withheld/);
  assert.deepEqual(T.leaksIn(broken.stdout + broken.stderr, tasks), []);
  // The leaks command the dry leg runs on a sealed log.
  const log = path.join(dir, "log.txt");
  fs.writeFileSync(log, "run 1 of 50 done\nrun 2 of 50 done\n");
  assert.equal(spawnSync(process.execPath, [TRIAL, "leaks", log, "--tasks", file], { encoding: "utf8" }).status, 0);
  fs.appendFileSync(log, `PASS  ${all[0].id}\n`);
  assert.equal(spawnSync(process.execPath, [TRIAL, "leaks", log, "--tasks", file], { encoding: "utf8" }).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a sealed shard's log lets through run counts and the numbers table, and withholds every other line", () => {
  const allowed = [
    "run 3 of 50 done", "run 4 of 50 recorded earlier", "",
    "Benchmark: 9 task(s) x 1 run(s), agent anthropic / claude-haiku-5-5, judge claude-sonnet-5-5 with the last 3 screenshots",
    "Output: tests/bench/out/trial",
    "| scored tasks | runs each | passed | success | success, blocked and lost as failures | solved at least once | solved every time | median steps (passed) | steps spent finding | median seconds | blocked by site | lost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| 9 | 1 | 5 | 55.6% ± 17.6% | 50.0% of 10 tasks | 55.6% | 55.6% | 7 (6) | 30.0% | 41 | 1 | 0 |",
    "2 run(s) were lost to the browser, the provider or the judge and are left out of the rate.",
    "Success with the 1 blocked and 2 lost run(s) counted as failures: 40.0%.",
    "Stopped early: a shard stopped early.",
    "The harness stopped with an error; a sealed run withholds the detail.",
  ];
  for (const line of allowed) assert.equal(T.sealedLogText(line), line);
  const withheld = [
    "Stopped early: 3 runs in a row were lost (harness error: net::ERR_ABORTED at chrome-extension://abc/agent.html?task=Find%20the%20price); stopping so the rest are not wasted.",
    "FAIL  stand-in-shopping-0 run 1  5 steps  30s finished",
    "How runs ended: passed 3, harness error 2",
    "  [page errors] TypeError at https://site3.example.org/start",
    "Error: ENOENT: no such file or directory, open '/x/tests/bench/out/trial/stand-in-shopping-0/run1/run.json'",
    "    at Object.readFileSync (node:fs:441:20)",
    "| stand-in-shopping-0 | 1 |",
    "ChatGPT plan: someone@example.com, profile copied to /tmp/p",
  ];
  for (const line of withheld) assert.equal(T.sealedLogText(line), T.SEALED_WITHHELD, line);
  // A text of several lines is judged line by line.
  assert.equal(T.sealedLogText("run 1 of 2 done\nFAIL  x-y run 1"), `run 1 of 2 done\n${T.SEALED_WITHHELD}`);
  // sealConsole puts the filter in front of every console method.
  const said = [];
  const con = { log: (s) => said.push(s), info: (s) => said.push(s), warn: (s) => said.push(s), error: (s) => said.push(s) };
  T.sealConsole(con);
  con.log("run 1 of 2 done");
  con.error(new Error("harness error at agent.html?task=Find%20the%20price"));
  con.warn("stand-in-shopping-0 failed");
  assert.equal(said.length, 3);
  assert.equal(said[0], "run 1 of 2 done");
  for (const s of said.slice(1)) for (const line of s.split("\n")) assert.equal(line, T.SEALED_WITHHELD);
});

test("run.js seals its console first thing in a sealed run, and its own sealed lines are the allowed ones", () => {
  const src = fs.readFileSync(path.join(ROOT, "tests/bench/run.js"), "utf8");
  const sealAt = src.indexOf('if (process.env.BENCH_QUIET === "sealed") TRIAL.sealConsole();');
  assert.ok(sealAt > 0);
  // Nothing prints before the console is sealed.
  assert.ok(!/console\.(log|error|warn|info)/.test(src.slice(src.indexOf('"use strict"'), sealAt)));
  assert.match(src, /if \(SEALED\) console\.log\(`run \$\{rows\.length\} of \$\{tasks\.length \* RUNS\} done`\);/);
  assert.match(src, /if \(stoppedEarly\) console\.log\(SEALED \? "Stopped early: a shard stopped early\." :/);
  assert.match(src, /if \(!SEALED\) console\.log\(`\\nHow runs ended/);
  assert.match(src, /\}\)\(\)\.catch\(\(e\) => \{ console\.error\(SEALED \? "The harness stopped with an error; a sealed run withholds the detail\." : e\)/);
  assert.match(src, /if \(SEALED && LEARN\)/);
});

test("run.js in a sealed run prints no task and no error text, even when it fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-run-"));
  const id = "stand-in-shopping-0";
  // The task file's path names a task, and reading it fails: the error would print that path.
  const missing = path.join(dir, `${id}.json`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, BENCH_DRY: "1", BENCH_TASKS: missing, BENCH_OUT: path.join(dir, "out") };
  const sealed = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/run.js")], { cwd: ROOT, encoding: "utf8", env: { ...env, BENCH_QUIET: "sealed" }, timeout: 20000 });
  assert.notEqual(sealed.status, 0);
  assert.ok(!(sealed.stdout + sealed.stderr).includes(id), sealed.stdout + sealed.stderr);
  assert.match(sealed.stderr, /The harness stopped with an error; a sealed run withholds the detail\./);
  // The same failure unsealed names the file: the seal is what hides it.
  const open = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/run.js")], { cwd: ROOT, encoding: "utf8", env, timeout: 20000 });
  assert.ok((open.stdout + open.stderr).includes(id));
  const learning = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/run.js")], { cwd: ROOT, encoding: "utf8", env: { ...env, BENCH_QUIET: "sealed", BENCH_LEARN: "on" }, timeout: 20000 });
  assert.equal(learning.status, 1);
  assert.equal(learning.stderr.trim(), "A sealed run takes no learning.");
  fs.rmSync(dir, { recursive: true, force: true });
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

test("the workflow decrypts the holdout tasks before planning and checks them there, and runs suite=holdout sealed", { skip: process.platform === "win32" }, () => {
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/real-tasks.yml"), "utf8");
  const decrypt = "openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in tests/bench/holdout-tasks.json.enc -out tests/bench/holdout-tasks.json -pass env:HOLDOUT_KEY";
  // In the plan job, on every event, before the plan step and the checks; in the run and summary jobs when sealed.
  assert.equal(y.split(decrypt).length - 1, 3);
  assert.equal(y.split("HOLDOUT_KEY: ${{ secrets.HOLDOUT_KEY }}").length - 1, 3);
  const jobText = (name) => { const start = y.indexOf(`\n  ${name}:\n`, y.indexOf("\njobs:\n")); const rest = y.slice(start + 1); const next = rest.slice(1).search(/\n  [a-z-]+:\n/); return next < 0 ? rest : rest.slice(0, next + 1); };
  const planJob = jobText("plan");
  assert.ok(planJob.indexOf(decrypt) < planJob.indexOf("name: Work out what to run"));
  assert.ok(planJob.indexOf(decrypt) < planJob.indexOf("node tests/bench/trial.js holdout-check"));
  assert.ok(!/name: Decrypt the holdout tasks\n\s+if:/.test(planJob), "the plan job always decrypts: the overlap check runs on every push");
  assert.match(planJob, /if \[ -z "\$HOLDOUT_KEY" \]; then echo "::error::/);
  for (const job of ["run", "summary"]) assert.match(jobText(job), /name: Decrypt the holdout tasks\n\s+if: \$\{\{ needs\.plan\.outputs\.sealed == 'true' \}\}/, job);
  assert.ok(jobText("run").indexOf(decrypt) < jobText("run").indexOf("node tests/bench/run.js"));
  assert.ok(jobText("summary").indexOf(decrypt) < jobText("summary").indexOf("node tests/bench/trial.js summary"));
  assert.ok(!jobText("dry-legs").includes(decrypt), "the dry legs play fixtures and never decrypt");
  // The open validate loop no longer prints the holdout file's problems; holdout-check prints counts only.
  assert.match(y, /for f in everyday-tasks learn-tasks fixture-tasks fixture-learn-tasks; do/);
  assert.ok(!y.includes("\u2014"));

  const here = fs.existsSync(path.join(ROOT, T.SUITES.holdout));
  const h = plan({ IN_SUITE: "holdout" });
  if (here) {
    assert.equal(h.status, 0, h.said);
    assert.deepEqual([h.outputs.tasks, h.outputs.sealed, h.outputs.dry], ["tests/bench/holdout-tasks.json", "true", "false"]);
  } else {
    assert.equal(h.status, 1);
    assert.match(h.said, /is not there: the step before this one decrypts it/);
  }
  assert.equal(plan({ IN_SUITE: "everyday" }).outputs.sealed, "false");
  assert.equal(plan({ IN_SUITE: "holdout", IN_DRY: "true" }).outputs.sealed, "false", "a dry run plays the fixtures, not the holdout");
  assert.match(plan({ IN_SUITE: "holdout", IN_LEARNING: "true" }).said, /runs without learning/);
  assert.match(plan({ IN_SUITE: "holdout", IN_LIMIT: "2" }).said, /needs a limit of 3 or more/);

  assert.match(y, /options: \[everyday, dev, learn, holdout\]/);
  assert.match(y, /BENCH_QUIET: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 'sealed' \|\| '' \}\}/);
  assert.match(y, /format\('holdout-SEALED-per-task-do-not-open-shard-\{0\}', matrix\.shard\) \|\| format\('trial-shard-\{0\}', matrix\.shard\)/);
  assert.match(y, /retention-days: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 1 \|\| 30 \}\}/);
  assert.match(y, /if \[ "\$SEALED" = "true" \]; then check="\$check --sealed"; fi/);
  assert.match(y, /\{ leg: sealed, .*check: sealed, quiet: sealed \}/);
  assert.match(y, /trial\.js leaks tests\/bench\/out\/leg-run\.log/);
  const readme = fs.readFileSync(path.join(ROOT, "tests/bench/README.md"), "utf8");
  assert.match(readme, /Nobody tunes the agent on/);
  assert.match(readme, /numbers only/);
  assert.match(readme, /replaced, not worked around/);
});
