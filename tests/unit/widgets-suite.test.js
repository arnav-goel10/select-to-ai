"use strict";
// The widgets practice suite: an open set on interactive widgets that the
// developers may read and tune on. It loads like any trial file, covers every
// kind of interaction, and shares no site with any other suite, the holdout
// included, and a clash with the holdout names only the practice task.
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
const FILE = path.join(ROOT, T.SUITES.widgets);
const raw = () => JSON.parse(fs.readFileSync(FILE, "utf8"));

test("widgets-tasks.json is sound, shaped as its rule says, and loads through the harness's loader with its kinds", () => {
  const file = raw();
  assert.deepEqual(T.validateTasks(file.tasks), []);
  assert.deepEqual(T.widgetsShapeProblems(file), []);
  const loaded = J.normaliseTasks(file);
  assert.equal(loaded.length, file.tasks.length, "the loader drops no task");
  assert.ok(loaded.length >= 24 && loaded.length <= 30);
  for (const t of loaded) {
    assert.equal(t.level, "widgets");
    assert.ok(T.WIDGET_KINDS[t.widget], `${t.id}: kind kept by the loader`);
    assert.ok(T.DIFFICULTIES.includes(t.difficulty), `${t.id}: difficulty kept by the loader`);
    assert.ok(t.expect, `${t.id}: rubric kept by the loader`);
  }
  assert.deepEqual([...new Set(loaded.map((t) => t.widget))].sort(), Object.keys(T.WIDGET_KINDS).sort(), "every kind is practised");
  assert.equal(T.plannedRuns(loaded, { runs: 2 }).length, loaded.length * 2);
  assert.equal(T.plannedRuns(loaded, { sample: 7, seed: 3 }).length, 7);
  assert.ok(!JSON.stringify(file).includes("\u2014"), "no em dash");
  // It is a suite readSuites knows, beside the others, and not a sealed one.
  assert.equal(T.SUITES.widgets, "tests/bench/widgets-tasks.json");
  assert.ok(!T.SEALED_SUITES.includes("widgets"));
  assert.equal(T.readSuites(ROOT).widgets.length, file.tasks.length);
});

test("no widgets task uses a site that an open suite or a reading check uses", () => {
  const { holdout, ...all } = T.readSuites(ROOT);
  assert.deepEqual(T.siteOverlapProblems("widgets", all.widgets, all), []);
  const used = new Set(Object.entries(all).filter(([k]) => k !== "widgets").flatMap(([, v]) => v.flatMap(T.taskSites)));
  for (const t of all.widgets) for (const s of T.taskSites(t)) assert.ok(!used.has(s), `${t.id}: ${s}`);
});

test("the overlap rule catches a start page, a named site and a subdomain, and names a sealed suite's task never", () => {
  const own = [{ id: "w1", url: "https://demo.example-widgets.org/slider" }, { id: "w2", url: "https://other.example.net/", sites: ["https://maps.shared-site.com/x"] }];
  const others = {
    everyday: [{ id: "e1", url: "https://www.example-widgets.org/" }],
    holdout: [{ id: "secret-holdout-task", url: "https://shared-site.com/page" }],
    widgets: own,
  };
  const problems = T.siteOverlapProblems("widgets", own, others);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^w1: example-widgets\.org is also used by everyday \(e1\)$/);
  assert.match(problems[1], /^w2: shared-site\.com is also used by the holdout suite$/);
  assert.ok(!problems.join("\n").includes("secret-holdout-task"), "a sealed suite's task is not named");
  // Its own tasks are not a clash, and an absent suite (no plain holdout file) is skipped.
  assert.deepEqual(T.siteOverlapProblems("widgets", own, { widgets: own, holdout: null }), []);
  // A site both an open and the sealed suite use is reported as the sealed suite's, so nothing open points at it.
  const both = { everyday: [{ id: "e2", url: "https://shared-site.com/" }], holdout: others.holdout };
  assert.match(T.siteOverlapProblems("widgets", own, both).join(), /the holdout suite/);
});

test("the holdout's overlap rule now counts the widgets suite as another suite", () => {
  const widgets = raw().tasks;
  const site = T.taskSites(widgets[0])[0];
  const h = [{ id: "h1", level: "widgets", difficulty: "easy", url: `https://sub.${site}/x`, task: "x", expect: "y" }];
  assert.match(T.holdoutProblems(h, { widgets }).join(), new RegExp(`${site.replace(/\./g, "\\.")} is also used by widgets`));
  assert.deepEqual(T.holdoutProblems([{ ...h[0], url: "https://unused-standin.example/" }], { widgets }), []);
});

test("the shape check wants every kind, both sources, 24 to 30 widgets tasks, a checkable end state and at most 3 tasks a site", () => {
  const good = raw();
  const tweak = (fn) => { const f = JSON.parse(JSON.stringify(good)); fn(f); return T.widgetsShapeProblems(f).join("\n"); };
  assert.match(tweak((f) => { f.tasks = f.tasks.filter((t) => t.widget !== "long-press"); }), /no task practises long-press/);
  assert.match(tweak((f) => { f.tasks[0].level = "fact-lookup"; }), /not widgets/);
  assert.match(tweak((f) => { f.tasks[0].widget = "telepathy"; }), /widget "telepathy" is not one of/);
  assert.match(tweak((f) => { delete f.tasks[0].difficulty; }), /needs a difficulty/);
  assert.match(tweak((f) => { for (const t of f.tasks) t.source = "library-demo"; }), /0 tasks on real sites, not 5 or more/);
  assert.match(tweak((f) => { f.tasks = f.tasks.slice(0, 20); }), /20 tasks, not 24 to 30/);
  assert.match(tweak((f) => { for (const t of f.tasks.slice(0, 4)) t.url = "https://same.example.net/p"; }), /4 tasks on example\.net, more than 3/);
  assert.match(tweak((f) => { const t = f.tasks.find((x) => x.pattern); delete t.pattern; t.expect = "Some value."; }), /must say how the final page shows the end state/);
  assert.match(tweak((f) => { f.rule = "A set."; }), /PRACTICE SET/);
});

test("suite-check names the practice task and its site on a clash with the holdout, and never the holdout task", () => {
  const widgets = raw().tasks;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widgets-check-"));
  const plain = path.join(dir, "holdout.json");
  fs.writeFileSync(plain, JSON.stringify({ rule: "stand-in", tasks: [{ id: "held-out-stand-in-task", level: "widgets", difficulty: "easy", url: widgets[2].url, task: "x", expect: "y" }] }));
  const r = spawnSync(process.execPath, [TRIAL, "suite-check", "widgets"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, HOLDOUT_TASKS: plain } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^${widgets[2].id}: ${T.taskSites(widgets[2])[0].replace(/\./g, "\\.")} is also used by the holdout suite$`, "m"));
  assert.ok(!(r.stdout + r.stderr).includes("held-out-stand-in-task"));
  assert.ok(!(r.stdout + r.stderr).includes(widgets[2].url), "the clash names a site, not the holdout task's address");
  const clean = spawnSync(process.execPath, [TRIAL, "suite-check", "widgets"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, HOLDOUT_TASKS: path.join(dir, "absent.json") } });
  if (!fs.existsSync(path.join(ROOT, T.SUITES.holdout))) {
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /no site shared with everyday, dev, learn, reading-wild, reading-pdf \(not the holdout: no plain holdout file here\)/);
  }
  assert.equal(spawnSync(process.execPath, [TRIAL, "suite-check", "everyday"], { cwd: ROOT, encoding: "utf8" }).status, 1);
});

test("the summary of a widgets run counts by kind of interaction", () => {
  const tasks = T.plannedRuns(J.normaliseTasks(raw()));
  const rows = tasks.slice(0, 6).map((t, i) => ({ id: t.id, slot: t.slot, run: 1, family: t.level, level: t.level, success: i % 2 === 0, ending: "finished", seconds: 20, counters: {} }));
  const lines = T.groupTable(rows, tasks, "widget");
  assert.equal(lines.reduce((n, l) => n + l.tasks, 0), tasks.length);
  assert.equal(lines.reduce((n, l) => n + l.passed, 0), 3);
  const text = T.kindMarkdown(lines);
  assert.match(text, /### By kind of interaction/);
  for (const k of Object.keys(T.WIDGET_KINDS)) assert.ok(text.includes(T.WIDGET_KINDS[k]), k);
});

test("the workflow offers the widgets suite, maps it to its file, and checks it with the other task files", () => {
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/real-tasks.yml"), "utf8");
  assert.match(y, /options: \[everyday, dev, learn, widgets, holdout\]/);
  assert.match(y, /widgets\) tasks=tests\/bench\/widgets-tasks\.json ;;/);
  assert.match(y, /node tests\/bench\/trial\.js suite-check widgets/);
  const docs = fs.readFileSync(path.join(ROOT, "docs/real-task-trial.md"), "utf8");
  for (const s of ["widgets-tasks.json", "suite-check widgets", "-f suite=widgets"]) assert.ok(docs.includes(s), s);
});
