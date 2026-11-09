/**
 * Runs several benchmark arms at once, a few browsers at a time.
 *
 *   node tests/bench/matrix.js arms.json
 *
 * arms.json: {"concurrency": 4, "out": "dir", "arms": [{"name": "ministral-8b-dev",
 *   "shards": 2, "env": {"BENCH_PROVIDER": "mistral", "BENCH_MODEL": "...",
 *   "BENCH_API_KEY": "$MISTRAL_KEY", "BENCH_TASKS": "..."}}]}
 *
 * A value starting with "$" is read from this process's environment, so keys
 * stay out of the file. Each arm writes to <out>/<name>; its shards share the
 * folder and run as separate browsers. More than four browsers at once has
 * killed all of them, so the cap matters.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { summarise } = require("./judge.js");

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const cap = Math.max(1, config.concurrency || 4);
const outRoot = path.resolve(config.out || path.join(__dirname, "out", "matrix"));
const resolve = (v) => (typeof v === "string" && v.startsWith("$") ? process.env[v.slice(1)] || "" : String(v));

const jobs = [];
for (const arm of config.arms) {
  const shards = Math.max(1, arm.shards || 1);
  for (let i = 1; i <= shards; i++) jobs.push({ arm, shard: shards > 1 ? `${i}/${shards}` : "" });
}
// Interleave arms so one slow provider does not hold every slot.
jobs.sort((a, b) => (a.shard || "1").localeCompare(b.shard || "1"));

const stamp = () => new Date().toTimeString().slice(0, 5);
let running = 0;
const start = (job) => new Promise((done) => {
  const out = path.join(outRoot, job.arm.name);
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, BENCH_OUT: out };
  for (const [k, v] of Object.entries({ ...(config.env || {}), ...(job.arm.env || {}) })) env[k] = resolve(v);
  if (job.shard) env.BENCH_SHARD = job.shard;
  const log = fs.openSync(path.join(out, `log${job.shard ? `-${job.shard.replace("/", "of")}` : ""}.txt`), "a");
  console.log(`${stamp()} start  ${job.arm.name} ${job.shard}`);
  const child = spawn(process.execPath, [path.join(__dirname, "run.js")], { env, stdio: ["ignore", log, log] });
  child.on("exit", (code) => { fs.closeSync(log); console.log(`${stamp()} ${code === 0 ? "done  " : `exit ${code}`} ${job.arm.name} ${job.shard}`); done(); });
});

(async () => {
  const queue = [...jobs];
  await new Promise((allDone) => {
    const pump = () => {
      while (running < cap && queue.length) {
        running++;
        start(queue.shift()).then(() => { running--; if (!queue.length && !running) allDone(); else pump(); });
      }
    };
    pump();
  });

  // One table for every arm, from what its shards recorded.
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  console.log(`\n| arm | scored | passed | success | steps spent finding | median steps (passed) | blocked | lost |\n| --- | --- | --- | --- | --- | --- | --- | --- |`);
  const table = {};
  for (const arm of config.arms) {
    const out = path.join(outRoot, arm.name);
    const rows = [];
    for (const task of fs.existsSync(out) ? fs.readdirSync(out) : []) {
      const dir = path.join(out, task);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const run of fs.readdirSync(dir)) { const f = path.join(dir, run, "run.json"); if (fs.existsSync(f)) rows.push(JSON.parse(fs.readFileSync(f, "utf8"))); }
    }
    const s = summarise(rows);
    table[arm.name] = s;
    console.log(`| ${arm.name} | ${s.runs} | ${s.passed} | ${pct(s.success)} ± ${pct(s.standardError)} | ${pct(s.findingShare)} | ${s.medianSteps} (${s.medianStepsPassed}) | ${s.blocked} | ${s.lost} |`);
  }
  fs.writeFileSync(path.join(outRoot, "summary.json"), JSON.stringify(table, null, 2));
})();
