/**
 * The real-task trial: what run.js needs beyond a benchmark run, and the
 * report over what it wrote. No browser and no network here.
 *
 *   node tests/bench/trial.js validate tests/bench/everyday-tasks.json
 *   node tests/bench/trial.js summary <out dir> --tasks <task file> [--sample N] [--check-dry]
 *
 * A trial task file is run.js's own format with a few more fields:
 *   level    the task's family (one of FAMILIES), so BENCH_SAMPLE spreads a
 *            smaller run evenly over the families
 *   expect   what a right result holds, in words, given to the judge
 *   pattern  a regular expression (case-insensitive) the final answer
 *            should match: a second, mechanical signal beside the judge, and
 *            the only verdict in dry mode, which has no judge
 *   sites    the other sites a task names, when it names more than one
 *   lang     the language of the site, when it is not English
 *   scenario (fixture tasks) the scripted model's scenario in tests/e2e/server.js
 *   dry      (fixture tasks) how the run must end for the plumbing to be right
 *   dryHeld  (fixture tasks) the fewest held actions the run must record
 *
 * `summary` reads every run.json under the folder (one per task run, written
 * by run.js), prints a table by family in Markdown, and writes
 * trial-summary.json beside them.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isInfra, normaliseTasks, sampleTasks } = require("./judge.js");

const FAMILIES = Object.freeze({
  "fact-lookup": "Look up a fact on a page",
  "cross-site": "Search and compare across two sites",
  "form-fill": "Fill a form, stop before submit",
  "tables-lists": "Tables and lists",
  "navigation": "Multi-step navigation",
  "long-docs": "Long documents and PDFs",
  "non-english": "Non-English sites",
  "developer": "Developer tasks",
  "shopping": "Shopping research, no checkout",
  "maps-transit": "Maps and transit",
  "news-sports": "News and sports",
  "fixture": "Fixture pages (dry mode)",
});

// The scripted model's server in dry mode. The fixture task file names this port in its addresses.
const DRY_PORT = 8931;

// Words for an action no trial task may ask for. A task may say "do not submit".
const FORBIDDEN = /\b(sign up|sign me up|register an account|create an account|log ?in|buy it|place the order|check ?out and pay|pay for|post a|send the|send a|delete|unsubscribe)\b/i;

/** Problems with a trial task file, as sentences. Empty when it is sound. */
function validateTasks(list) {
  const problems = [];
  const ids = new Set();
  for (const [i, t] of (list || []).entries()) {
    const name = t && t.id ? t.id : `task ${i + 1}`;
    if (!t || !t.id || !t.task || !t.url) { problems.push(`${name}: needs id, task and url`); continue; }
    if (ids.has(t.id)) problems.push(`${name}: id used twice`);
    ids.add(t.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) problems.push(`${name}: id must be lower-case letters, digits and hyphens (it names a folder)`);
    if (!FAMILIES[t.level]) problems.push(`${name}: level "${t.level}" is not a family`);
    if (t.level === "fixture" ? !/^http:\/\/127\.0\.0\.1:\d+\//.test(t.url) : !/^https:\/\//.test(t.url)) problems.push(`${name}: url ${t.url}`);
    if (!t.expect && !t.pattern) problems.push(`${name}: needs expect or pattern`);
    if (t.pattern) { try { new RegExp(t.pattern, "i"); } catch (e) { problems.push(`${name}: pattern does not compile (${e.message})`); } }
    const negated = String(t.task).replace(/\b(do not|don't|without|never|not)\b[^.;]*/gi, "");
    if (t.level !== "fixture" && FORBIDDEN.test(negated)) problems.push(`${name}: asks for something a trial task may not do ("${negated.match(FORBIDDEN)[0]}")`);
    if (/—/.test(JSON.stringify(t))) problems.push(`${name}: has an em dash`);
  }
  return problems;
}

/** Whether the answer matches the task's pattern: true, false, or null when the task has none. */
function patternMatch(task, answer) {
  if (!task || !task.pattern) return null;
  return new RegExp(task.pattern, "i").test(String(answer || ""));
}

/**
 * The verdict in dry mode, where no judge is called: the pattern decides,
 * and a run left waiting at a human check counts as blocked, as the judge
 * would mark it.
 */
function patternVerdict(task, run) {
  const blocked = run.waitKind === "human_check";
  const hit = patternMatch(task, run.answer);
  const success = hit === true && !blocked && /^(finished|answered without acting)$/.test(String(run.ending || ""));
  const reason = blocked ? "the run stopped at a human check and waited for the user"
    : success ? "the answer matches the task's pattern (no judge in dry mode)"
      : hit === null ? "the task has no pattern, and dry mode has no judge"
        : hit ? `the answer matches the pattern, but the run ended as: ${run.ending}` : "the answer does not match the task's pattern";
  return { success, blocked, reason, keyPoints: [], met: [] };
}

/** What a run did that the shipped build does differently from the measured one, and what was held. */
function countersOf(run) {
  const pointer = (run.timing && run.timing.pointer) || {};
  const held = run.held || [];
  return {
    // Pointer actions made by page script (chrome.scripting), as against real input events.
    scriptedInputs: pointer.synthetic || 0,
    realInputs: pointer.real || 0,
    // Steps the engine held for the user's go-ahead, and how many of them the harness refused.
    heldActions: held.length,
    heldRefused: held.filter((h) => !h.allowed).length,
    heldKinds: [...new Set(held.map((h) => h.kind))],
    checkIns: run.checkIns || 0,
    failedActions: (run.history || []).filter((h) => h.ok === false).length,
  };
}

/** What a judge call cost, from its token counts and a rates lookup (defaults.js findModelRates: USD per 1K tokens). */
function judgeCostUSD(usage, ratesFor) {
  if (!usage || !ratesFor) return 0;
  const [input, output] = ratesFor(usage.model) || [0, 0];
  return ((usage.input || 0) * input + (usage.output || 0) * output) / 1000;
}

/** One of: passed, blocked, timed out, lost, failed. */
function bucketOf(row) {
  if (row.success) return "passed";
  if (isInfra(row)) return "lost";
  if (row.blocked || row.waitKind === "human_check") return "blocked";
  if (/^timed out/.test(String(row.ending || ""))) return "timed out";
  return "failed";
}

/** Why a run did not pass, in one line; empty for a pass. */
function failureOf(row) {
  if (row.success) return "";
  return [String(row.ending || "").slice(0, 120), String(row.reason || "").replace(/\s+/g, " ").slice(0, 300)].filter(Boolean).join(" | ");
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * The table: one line per family and a total. `tasks` is every task that
 * was meant to run; a task with no row was not run (the spend cap, or a
 * shard that stopped).
 */
function familyTable(rows, tasks) {
  const families = [...new Set([...(tasks || []).map((t) => t.level), ...rows.map((r) => r.family || r.level)])].filter(Boolean);
  const ran = new Set(rows.map((r) => r.id));
  const line = (name, rs, planned) => {
    const count = (b) => rs.filter((r) => bucketOf(r) === b).length;
    const scored = rs.filter((r) => bucketOf(r) !== "lost");
    return {
      family: name,
      tasks: planned.length,
      passed: count("passed"),
      failed: count("failed"),
      timedOut: count("timed out"),
      blocked: count("blocked"),
      lost: count("lost"),
      notRun: planned.filter((t) => !ran.has(t.id)).length,
      medianSeconds: median(scored.map((r) => r.seconds)),
      agentUSD: rs.reduce((a, r) => a + (r.costUSD || 0), 0),
      judgeUSD: rs.reduce((a, r) => a + (r.judgeCostUSD || 0), 0),
      scriptedInputs: rs.reduce((a, r) => a + ((r.counters && r.counters.scriptedInputs) || 0), 0),
      realInputs: rs.reduce((a, r) => a + ((r.counters && r.counters.realInputs) || 0), 0),
      heldActions: rs.reduce((a, r) => a + ((r.counters && r.counters.heldActions) || 0), 0),
      patternDisagrees: rs.filter((r) => r.patternMatch !== null && r.patternMatch !== undefined && !isInfra(r) && r.patternMatch !== !!r.success).length,
    };
  };
  const lines = families.map((f) => line(f, rows.filter((r) => (r.family || r.level) === f), (tasks || []).filter((t) => t.level === f)));
  return { lines, total: line("All", rows, tasks || []) };
}

const usd = (x) => `$${Number(x || 0).toFixed(4)}`;

/** The table and its notes as Markdown, for a job summary. */
function markdown(table, meta = {}) {
  const out = [];
  out.push(`## Real-task trial${meta.dry ? " (dry mode: scripted model, fixture pages, no judge)" : ""}`);
  out.push("");
  const facts = [
    meta.suite ? `suite ${meta.suite}` : "",
    meta.arm ? `arm ${meta.arm}` : "",
    meta.debuggerAvailable !== undefined ? `chrome.debugger in the loaded build: ${meta.debuggerAvailable ? "yes" : "no"}` : "",
    meta.agent ? `agent ${meta.agent}` : "",
    meta.judge ? `judge ${meta.judge}` : "",
    meta.commit ? `commit ${String(meta.commit).slice(0, 7)}` : "",
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(", "), "");
  out.push("| family | tasks | passed | failed | timed out | blocked by a human check | lost | not run | median s | agent cost | judge cost | scripted inputs | real inputs | held actions |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const cells = (l, bold) => {
    const b = (x) => (bold ? `**${x}**` : String(x));
    return `| ${b(FAMILIES[l.family] || l.family)} | ${b(l.tasks)} | ${b(l.passed)} | ${b(l.failed)} | ${b(l.timedOut)} | ${b(l.blocked)} | ${b(l.lost)} | ${b(l.notRun)} | ${b(l.medianSeconds === null ? "-" : l.medianSeconds)} | ${b(usd(l.agentUSD))} | ${b(usd(l.judgeUSD))} | ${b(l.scriptedInputs)} | ${b(l.realInputs)} | ${b(l.heldActions)} |`;
  };
  for (const l of table.lines) out.push(cells(l, false));
  out.push(cells(table.total, true));
  out.push("");
  const t = table.total;
  const scored = t.passed + t.failed + t.timedOut;
  out.push(`Passed ${t.passed} of ${scored} scored runs${scored ? ` (${(100 * t.passed / scored).toFixed(1)}%)` : ""}; with blocked, lost and not-run tasks counted as failures, ${t.passed} of ${t.tasks}${t.tasks ? ` (${(100 * t.passed / t.tasks).toFixed(1)}%)` : ""}.`);
  out.push(`Model spend: ${usd(t.agentUSD + t.judgeUSD)} (agent ${usd(t.agentUSD)}, judge ${usd(t.judgeUSD)})${meta.capUSD ? `, cap $${Number(meta.capUSD).toFixed(2)}` : ""}.${meta.capReached ? " The spend cap stopped the run: the tasks under \"not run\" were never started." : ""}`);
  if (t.patternDisagrees) out.push(`In ${t.patternDisagrees} run(s) the judge and the task's answer pattern disagree: read those first (trial-summary.json lists them).`);
  if (meta.stopped && meta.stopped.length) out.push(`Stopped early: ${meta.stopped.join(" | ")}`);
  if (meta.notes) for (const n of meta.notes) out.push(n);
  return out.join("\n");
}

/** Every run.json under a folder, newest run of each task last. */
function readRows(dir) {
  const rows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "run.json") { try { rows.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch (_e) { /* a file cut short by a stopped job */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)) || (a.run || 0) - (b.run || 0));
}

/** The shards' own results files: what they ran on, and whether one stopped early. */
function readShards(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^results.*\.json$/.test(e.name)) { try { out.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch (_e) { /* unreadable */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** In dry mode every fixture task must end the way its "dry" field says. Problems as sentences. */
function checkDry(rows, tasks, shards) {
  const problems = [];
  for (const t of tasks) {
    const row = rows.find((r) => r.id === t.id);
    if (!row) { problems.push(`${t.id}: no run.json`); continue; }
    const got = bucketOf(row);
    const want = String(t.dry || "passed").split("|");
    if (!want.includes(got)) problems.push(`${t.id}: ended as "${got}" (${row.ending}), expected ${want.join(" or ")}`);
    if (t.dryHeld && !(row.counters && row.counters.heldActions >= t.dryHeld)) problems.push(`${t.id}: ${row.counters ? row.counters.heldActions : "no"} held action(s) counted, expected at least ${t.dryHeld}`);
    for (const k of ["steps", "seconds", "costUSD", "counters", "family", "ending", "history"]) if (row[k] === undefined) problems.push(`${t.id}: run.json has no "${k}"`);
  }
  if (!shards.length) problems.push("no results file from any shard");
  for (const s of shards) if (!s.agent || typeof s.agent.debuggerAvailable !== "boolean") problems.push("a shard did not record whether the loaded build has chrome.debugger");
  return problems;
}

function main(argv) {
  const [cmd, target, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : ""; };
  if (cmd === "validate") {
    const list = JSON.parse(fs.readFileSync(target, "utf8"));
    const problems = validateTasks(list);
    const per = {};
    for (const t of list) per[t.level] = (per[t.level] || 0) + 1;
    console.log(`${list.length} tasks: ${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    return;
  }
  if (cmd === "summary") {
    const taskFile = flag("--tasks");
    let tasks = taskFile ? normaliseTasks(JSON.parse(fs.readFileSync(taskFile, "utf8"))) : [];
    // The same sample run.js took, so "not run" counts only tasks that were meant to run.
    tasks = sampleTasks(tasks, parseInt(flag("--sample") || "0", 10), parseInt(flag("--seed") || "1", 10));
    const rows = readRows(target);
    const shards = readShards(target);
    const first = shards[0] || {};
    const meta = {
      dry: shards.some((s) => s.dry),
      suite: flag("--suite"),
      arm: flag("--arm"),
      commit: flag("--commit"),
      debuggerAvailable: first.agent ? first.agent.debuggerAvailable : undefined,
      agent: first.agent ? `${first.agent.provider} / ${first.agent.model}` : "",
      judge: first.judge && !first.dry ? first.judge.model : "",
      capUSD: shards.reduce((a, s) => a + (s.capUSD || 0), 0),
      capReached: shards.some((s) => s.capReached),
      stopped: shards.map((s) => s.stoppedEarly).filter(Boolean),
    };
    const table = familyTable(rows, tasks);
    const text = markdown(table, meta);
    console.log(text);
    fs.writeFileSync(path.join(target, "trial-summary.json"), JSON.stringify({
      meta,
      table,
      runs: rows.map((r) => ({ id: r.id, family: r.family || r.level, outcome: bucketOf(r), ending: r.ending, steps: r.steps, seconds: r.seconds, costUSD: r.costUSD || 0, judgeCostUSD: r.judgeCostUSD || 0, patternMatch: r.patternMatch === undefined ? null : r.patternMatch, counters: r.counters || null, failure: failureOf(r) })),
      notRun: tasks.filter((t) => !rows.some((r) => r.id === t.id)).map((t) => t.id),
    }, null, 2));
    if (rest.includes("--check-dry")) {
      const problems = checkDry(rows, tasks, shards);
      if (problems.length) { console.error(`\nDry run check failed:\n${problems.join("\n")}`); process.exit(1); }
      console.error(`\nDry run check: ${tasks.length} fixture task(s) ended as expected.`);
    }
    return;
  }
  console.error("Usage: node tests/bench/trial.js validate <tasks.json> | summary <out dir> --tasks <tasks.json> [--sample N] [--check-dry]");
  process.exit(1);
}

module.exports = { FAMILIES, DRY_PORT, validateTasks, patternMatch, patternVerdict, countersOf, judgeCostUSD, bucketOf, failureOf, familyTable, markdown, readRows, readShards, checkDry };

if (require.main === module) main(process.argv.slice(2));
