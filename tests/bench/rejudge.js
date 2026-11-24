/**
 * Judges the runs of an existing benchmark folder again, with the current
 * judge, into a new results file. The runs' own records and the folder's
 * results files are left as they are.
 *
 *   BENCH_JUDGE_KEY=nvapi-... node tests/bench/rejudge.js <run folder> [options]
 *
 * Options:
 *   --out FILE        where to write (default <folder>/rejudged-<model>.json).
 *                     Verdicts already in it are kept, so a stopped rejudge
 *                     carries on where it left off.
 *   --only a,b        only these task ids
 *   --labels FILE     verdicts established by hand (default
 *                     tests/bench/data/judge-labels.json when present):
 *                     {"labels": [{"folder", "id", "run", "verdict": "pass" |
 *                     "fail" | "blocked", "why"}]}. Only labels whose folder
 *                     is this folder's name are used.
 *   --concurrency N   judge calls at once (default 3)
 *
 * The judge is configured as in run.js (see judge-call.js).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarise, isInfra } = require("./judge.js");
const { judgeConfig, judgeRun } = require("./judge-call.js");

/** pass, fail or blocked, from a row's verdict fields. */
const outcomeOf = (r) => (r.success ? "pass" : r.blocked ? "blocked" : r.judgeFailed ? "not judged" : "fail");

/** Every run.json under a folder, as {dir, run}. */
function recordedRuns(folder) {
  const out = [];
  for (const task of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!task.isDirectory() || task.name.startsWith(".")) continue;
    for (const r of fs.readdirSync(path.join(folder, task.name), { withFileTypes: true })) {
      const file = path.join(folder, task.name, r.name, "run.json");
      if (r.isDirectory() && fs.existsSync(file)) out.push({ dir: path.dirname(file), run: JSON.parse(fs.readFileSync(file, "utf8")) });
    }
  }
  return out.sort((a, b) => a.run.id.localeCompare(b.run.id) || a.run.run - b.run.run);
}

/** Agreement between two verdict lists keyed by id and run: counts and the cases that differ. */
function agreement(rows, other, pick) {
  let same = 0;
  let total = 0;
  const differ = [];
  for (const r of rows) {
    const want = other.get(`${r.id}#${r.run}`);
    if (!want) continue;
    total++;
    const a = pick(r);
    if (a === want.verdict) same++;
    else differ.push({ id: r.id, run: r.run, judged: a, expected: want.verdict, why: want.why || "" });
  }
  return { same, total, differ };
}

function parseArgs(argv) {
  const opts = { folder: "", out: "", only: [], labels: path.join(__dirname, "data", "judge-labels.json"), concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--only") opts.only = argv[++i].split(",").filter(Boolean);
    else if (a === "--labels") opts.labels = argv[++i];
    else if (a === "--concurrency") opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else opts.folder = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.folder || !fs.existsSync(opts.folder)) { console.error("Usage: node tests/bench/rejudge.js <run folder> [--out file] [--only ids] [--labels file] [--concurrency n]"); process.exit(1); }
  const cfg = judgeConfig();
  if (!cfg.key) { console.error(cfg.problem || "Set BENCH_JUDGE_KEY."); process.exit(1); }
  const folder = path.resolve(opts.folder);
  const name = path.basename(folder);
  const out = opts.out || path.join(folder, `rejudged-${cfg.model.replace(/[^\w.-]+/g, "_")}.json`);
  let runs = recordedRuns(folder);
  if (opts.only.length) runs = runs.filter((x) => opts.only.includes(x.run.id));
  const done = new Map();
  if (fs.existsSync(out)) for (const r of JSON.parse(fs.readFileSync(out, "utf8")).rows || []) if (!r.judgeFailed) done.set(`${r.id}#${r.run}`, r);
  console.log(`Rejudging ${runs.length} run(s) in ${folder}\nJudge: ${cfg.model} at ${cfg.url}${cfg.vision ? `, with the last ${cfg.shots} screenshots` : ", text only"}\nOutput: ${out}${done.size ? ` (${done.size} verdict(s) kept from before)` : ""}\n`);

  const rows = new Map(done);
  const save = () => {
    const list = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
    fs.writeFileSync(out, JSON.stringify({ source: folder, judge: { model: cfg.model, url: cfg.url, vision: cfg.vision, shots: cfg.vision ? cfg.shots : 0 }, summary: summarise(list), rows: list }, null, 2));
    return list;
  };
  const queue = runs.filter((x) => !done.has(`${x.run.id}#${x.run.run}`));
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const run = { ...x.run, screenshots: (x.run.screenshots || []).map((s) => path.join(x.dir, path.basename(s))) };
      const old = { success: !!run.success, blocked: !!run.blocked, judgeFailed: !!run.judgeFailed };
      // A run lost before the agent acted is not judged, as in run.js.
      const verdict = isInfra({ ending: run.ending }) ? { success: false, reason: "not judged: the run was lost before the agent could act" } : await judgeRun(run, cfg);
      const row = {
        id: run.id, level: run.level, run: run.run, ending: run.ending, steps: run.steps, seconds: run.seconds, costUSD: run.costUSD, history: run.history,
        success: verdict.success, blocked: !!verdict.blocked, judgeFailed: !!verdict.judgeFailed, reason: verdict.reason, keyPoints: verdict.keyPoints, met: verdict.met,
        screenshotsSeen: verdict.screenshotsSeen || 0, judgeReply: verdict.judgeReply,
        old: { outcome: outcomeOf(old), reason: run.reason },
      };
      rows.set(`${row.id}#${row.run}`, row);
      save();
      console.log(`${outcomeOf(row).padEnd(10)} (was ${row.old.outcome.padEnd(7)}) ${row.id.padEnd(28)} run ${row.run}  | ${String(row.reason).slice(0, 120)}`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const list = save();

  const s = summarise(list);
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  console.log(`\nNew judge: ${s.passed} of ${s.runs} scored runs passed (${pct(s.success)}); ${pct(s.successAllRuns)} with ${s.blocked} blocked and ${s.lost} lost counted as failures.`);
  const oldMap = new Map(list.map((r) => [`${r.id}#${r.run}`, { verdict: r.old.outcome }]));
  const vsOld = agreement(list.filter((r) => !r.judgeFailed), oldMap, outcomeOf);
  console.log(`Agreement with the old verdicts: ${vsOld.same} of ${vsOld.total}.`);
  for (const d of vsOld.differ) console.log(`  ${d.id} run ${d.run}: old ${d.expected}, new ${d.judged}`);

  if (opts.labels && fs.existsSync(opts.labels)) {
    const labels = (JSON.parse(fs.readFileSync(opts.labels, "utf8")).labels || []).filter((l) => l.folder === name);
    if (labels.length) {
      const byKey = new Map(labels.map((l) => [`${l.id}#${l.run}`, l]));
      const judged = list.filter((r) => !r.judgeFailed);
      const newer = agreement(judged, byKey, outcomeOf);
      const older = agreement(judged, byKey, (r) => r.old.outcome);
      console.log(`\nHand labels for ${name}: ${labels.length}.`);
      console.log(`Old judge agrees with them on ${older.same} of ${older.total}; new judge on ${newer.same} of ${newer.total}.`);
      for (const d of newer.differ) console.log(`  new judge differs: ${d.id} run ${d.run}: judged ${d.judged}, hand label ${d.expected} (${d.why})`);
      for (const d of older.differ) console.log(`  old judge differed: ${d.id} run ${d.run}: judged ${d.judged}, hand label ${d.expected}`);
    }
  }
  const failed = list.filter((r) => r.judgeFailed).length;
  if (failed) console.log(`\n${failed} run(s) got no verdict from the judge; run again to retry them.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { recordedRuns, agreement, outcomeOf };
