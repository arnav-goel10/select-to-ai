/**
 * Judge stability: the stored runs of existing benchmark folders judged
 * again, several times, on their frozen key points, by the voting judge.
 * The runs' own files are left as they are.
 *
 *   node tests/bench/stability.js --runs <folder>=<source>... --key-points <file> [--lock <file>]
 *        [--times 3] [--votes 3] [--max-usd 3] [--concurrency 4] --out <dir>
 *
 * Each run that was not lost is judged `times` times. Each judging is the
 * bench's own protocol (judge-call.js judgeRun with cfg.votes): one vote, and
 * on a fail more votes until one side has a majority. All the calls on one
 * run go one after another with the run's message marked for the cache, so
 * every call after the first reads it at the cache price. The judge is
 * configured as in run.js (BENCH_JUDGE_MODEL, BENCH_JUDGE_KEY, ...).
 *
 * Spend is counted from what each call reports and is capped: a run starts
 * only when what is spent, what the runs under way may still spend and the
 * most this run's calls can cost stay under --max-usd.
 *
 * Writes <out>/stability-runs.json (every judging of every run, which names
 * tasks: the workflow encrypts it) and <out>/stability-summary.json and .md
 * (counts only), and prints the Markdown.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isInfra } = require("./judge.js");
const { judgeConfig, judgeRun } = require("./judge-call.js");
const KP = require("./keypoints.js");
const BLOCKS = require("./blocks.js");

// What one call can cost at most, for the cap: the run's message at the cache-write price, every output token used.
const MOST_CALL = Object.freeze({ maxTokens: 8000, imageTokens: 1600, writeShare: 1.25 });

/** Every stored run of some folders, with its folder on disk and its source. */
function loadRuns(specs) {
  const out = [];
  for (const spec of specs) {
    const at = spec.lastIndexOf("=");
    const top = at > 0 ? spec.slice(0, at) : spec;
    const source = at > 0 ? spec.slice(at + 1) : path.basename(path.resolve(top));
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "run.json") {
          try {
            const run = JSON.parse(fs.readFileSync(p, "utf8"));
            out.push({ source, dir: d, run: { ...run, screenshots: (run.screenshots || []).map((s) => path.join(d, path.basename(s))) } });
          } catch (_e) { /* a file cut short */ }
        }
      }
    };
    if (fs.existsSync(top)) walk(top);
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || String(a.run.id).localeCompare(String(b.run.id)) || (a.run.run || 0) - (b.run.run || 0));
}

/** The most one run's calls can cost: `calls` calls, the first writing the cache and the rest reading it. */
function mostUSD(run, calls, rates) {
  const [input, output] = rates || [0, 0];
  const { judgeMessage } = require("./judge.js");
  const tokens = Math.ceil(judgeMessage(run).length / 2) + Math.min(3, (run.screenshots || []).length) * MOST_CALL.imageTokens + 1500;
  const first = tokens * input * MOST_CALL.writeShare + MOST_CALL.maxTokens * output;
  const rest = tokens * input * 0.1 + MOST_CALL.maxTokens * output;
  return (first + Math.max(0, calls - 1) * rest) / 1000;
}

/**
 * The counts of a set of judged runs. `rows` are {source, id, run, stored,
 * blocked, keyPoints, judgings: [{success, judgeFailed, met, keyPoints,
 * votes}]}. Counts only: no id, no text.
 */
function stabilityCounts(rows, times) {
  const judged = rows.filter((r) => r.judgings && r.judgings.length);
  const complete = judged.filter((r) => r.judgings.length === times && r.judgings.every((j) => !j.judgeFailed));
  const same = complete.filter((r) => r.judgings.every((j) => j.success === r.judgings[0].success));
  // With the blocked column: a run the detector calls blocked is blocked whatever the judge says.
  const column = (r, j) => (r.blocked && !j.success ? "blocked" : j.success ? "passed" : "failed");
  const sameColumn = complete.filter((r) => r.judgings.every((j) => column(r, j) === column(r, r.judgings[0])));
  // Key points: every judging must carry the frozen list exactly, and so must every run of one task.
  let changedPoints = 0;
  for (const r of judged) for (const j of r.judgings) if (!j.judgeFailed && JSON.stringify(j.keyPoints) !== JSON.stringify(r.keyPoints)) changedPoints++;
  const byTask = new Map();
  for (const r of judged) {
    const k = JSON.stringify(r.keyPoints);
    if (!byTask.has(r.id)) byTask.set(r.id, new Set());
    byTask.get(r.id).add(k);
  }
  const contradicting = [...byTask.values()].filter((s) => s.size > 1).length;
  // How often one key point's mark changed between judgings of the same run.
  let points = 0;
  let flipped = 0;
  for (const r of complete) for (let i = 0; i < (r.keyPoints || []).length; i++) {
    points++;
    const marks = new Set(r.judgings.map((j) => (j.met || [])[i]));
    if (marks.size > 1) flipped++;
  }
  const majority = (r) => r.judgings.filter((j) => !j.judgeFailed && j.success).length * 2 > r.judgings.filter((j) => !j.judgeFailed).length;
  const withStored = complete.filter((r) => typeof r.stored === "boolean");
  const agreeStored = withStored.filter((r) => majority(r) === r.stored).length;
  const calls = judged.reduce((n, r) => n + r.judgings.reduce((m, j) => m + ((j.votes && j.votes.length) || 1), 0), 0);
  const voted = judged.reduce((n, r) => n + r.judgings.filter((j) => j.votes && j.votes.length > 1).length, 0);
  return {
    stored: rows.length,
    judged: judged.length,
    complete: complete.length,
    sameVerdict: same.length,
    sameColumn: sameColumn.length,
    blocked: rows.filter((r) => r.blocked).length,
    tasks: byTask.size,
    tasksStable: [...byTask.keys()].filter((id) => complete.filter((r) => r.id === id).length === judged.filter((r) => r.id === id).length && same.filter((r) => r.id === id).length === judged.filter((r) => r.id === id).length).length,
    changedPoints,
    contradicting,
    points,
    flipped,
    withStored: withStored.length,
    agreeStored,
    judgings: judged.reduce((n, r) => n + r.judgings.length, 0),
    voted,
    calls,
  };
}

/** The Markdown of the counts, with the acceptance lines. Numbers only. */
function stabilityMarkdown(c, meta = {}) {
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : "-");
  const out = [`## Judge stability on frozen key points${meta.dry ? " (dry)" : ""}`, ""];
  out.push(`Judge ${meta.model || "?"}, ${meta.times} judging(s) of each run, up to ${meta.votes} vote(s) on a fail. Key points ${meta.digest ? String(meta.digest).slice(0, 16) : "?"} (${meta.keyTasks || 0} task(s)), written by ${meta.keyModel || "?"}.${meta.sameModel ? " The judge is the model that drove these runs: it may share their blind spots." : ""}`, "");
  out.push("| stored runs | judged | judged every time | same verdict every time | same outcome with the blocked column | blocked by the detector | tasks | tasks with every run the same |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  out.push(`| ${c.stored} | ${c.judged} | ${c.complete} | ${c.sameVerdict} (${pct(c.sameVerdict, c.judged)}) | ${c.sameColumn} (${pct(c.sameColumn, c.judged)}) | ${c.blocked} | ${c.tasks} | ${c.tasksStable} (${pct(c.tasksStable, c.tasks)}) |`, "");
  out.push(`Key points: ${c.changedPoints} judging(s) carried a list other than the frozen one, and ${c.contradicting} task(s) had different lists between runs or judgings. One key point's mark changed between judgings of the same run on ${c.flipped} of ${c.points} point(s) (${pct(c.flipped, c.points)}).`);
  out.push(`The majority of the judgings agrees with the stored verdict on ${c.agreeStored} of ${c.withStored} run(s) (${pct(c.agreeStored, c.withStored)}). ${c.judgings} judging(s), ${c.voted} of them voted again after a fail, ${c.calls} call(s) in all.`);
  out.push(`Spend: $${Number(meta.usd || 0).toFixed(4)}${meta.capUSD ? ` of a $${Number(meta.capUSD).toFixed(2)} cap` : ""}${meta.stopped ? `. The cap stopped it: ${meta.stopped} run(s) not judged` : ""}.`, "");
  const stable = c.judged ? c.sameVerdict / c.judged : 0;
  out.push(`Acceptance: same verdict on at least 95% of runs, ${pct(c.sameVerdict, c.judged)}: ${stable >= 0.95 && c.complete === c.judged ? "met" : "NOT met"}. No contradicting key points: ${c.changedPoints === 0 && c.contradicting === 0 ? "met" : "NOT met"}.`);
  return out.join("\n");
}

async function main(argv) {
  const flag = (name, d = "") => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
  const specs = [];
  const at = argv.indexOf("--runs");
  for (let j = at + 1; at >= 0 && j < argv.length && !argv[j].startsWith("--"); j++) specs.push(argv[j]);
  const outDir = flag("--out");
  if (!specs.length || !outDir || !flag("--key-points")) throw new Error("Usage: stability.js --runs <folder>=<source>... --key-points <file> --out <dir> [--lock f] [--times 3] [--votes 3] [--max-usd 3]");
  const times = Math.max(1, parseInt(flag("--times", "3"), 10));
  const votes = Math.max(1, parseInt(flag("--votes", "3"), 10));
  const capUSD = Number(flag("--max-usd", "0")) || 0;
  const concurrency = Math.max(1, parseInt(flag("--concurrency", "4"), 10));
  const frozen = KP.loadFrozen(flag("--key-points"), flag("--lock") || KP.LOCK_FILE);
  const keyFile = JSON.parse(fs.readFileSync(flag("--key-points"), "utf8"));
  const cfg = judgeConfig();
  if (!cfg.key) throw new Error(cfg.problem || "Set BENCH_JUDGE_KEY.");
  const { findModelRates } = require("../../extension/defaults.js");
  const { judgeCostUSD } = require("./trial.js");
  const rates = findModelRates(cfg.model);
  const all = loadRuns(specs);
  const rows = [];
  let spent = 0;
  let inFlight = 0;
  let stopped = 0;
  const queue = [...all];
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const run = { ...x.run, frozenKeyPoints: frozen.get(x.run.id) || [] };
      const row = { source: x.source, id: run.id, run: run.run, stored: run.judgeFailed ? null : !!run.success, blocked: BLOCKS.siteBlockOf(run).blocked, keyPoints: run.frozenKeyPoints, judgings: [] };
      rows.push(row);
      // A run lost before the agent acted is not judged, as in run.js; nor is a task with no frozen key points.
      if (isInfra({ ending: run.ending }) || !run.frozenKeyPoints.length) continue;
      const most = mostUSD(run, times * votes, rates);
      if (capUSD && spent + inFlight + most > capUSD) { stopped++; continue; }
      inFlight += most;
      let mine = 0;
      for (let t = 0; t < times; t++) {
        const v = await judgeRun(run, { ...cfg, votes, cacheRun: true, stopRetry: capUSD ? (u) => spent + inFlight + judgeCostUSD(u, findModelRates) >= capUSD + most : undefined });
        const usd = judgeCostUSD(v.judgeUsage, findModelRates);
        mine += usd;
        row.judgings.push({ success: !!v.success, judgeFailed: !!v.judgeFailed, met: v.met || [], keyPoints: v.keyPoints || [], votes: v.votes || [{ success: !!v.success, met: v.met || [] }], reason: v.reason || "", usd });
      }
      inFlight -= most;
      spent += mine;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  rows.sort((a, b) => a.source.localeCompare(b.source) || String(a.id).localeCompare(String(b.id)) || (a.run || 0) - (b.run || 0));
  const counts = stabilityCounts(rows, times);
  const sources = [...new Set(all.map((x) => x.run.models && x.run.models[0]).filter(Boolean))];
  const meta = { model: cfg.model, times, votes, digest: KP.digestOf(keyFile), keyTasks: frozen.size, keyModel: keyFile.model, usd: spent, capUSD, stopped, sameModel: sources.includes(cfg.model) };
  const md = stabilityMarkdown(counts, meta);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "stability-runs.json"), JSON.stringify({ meta, rows }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, "stability-summary.json"), JSON.stringify({ meta, counts }, null, 2));
  fs.writeFileSync(path.join(outDir, "stability-summary.md"), `${md}\n`);
  console.log(md);
}

module.exports = { loadRuns, mostUSD, stabilityCounts, stabilityMarkdown, MOST_CALL };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}
