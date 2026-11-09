#!/usr/bin/env node
// Recipes benchmark harness.
//
//   node bench/recipes/run.js --adapters reference-replay,healwright --sets dev [--label name]
//        [--tasks supplier.,admin.role] [--mutations id-prefix] [--vars 0,1]
//        [--concurrency 4] [--budget-usd 10] [--out dir]
//
// Sets: dev (bench/recipes/mutations/dev), heldout ($RECIPES_HELDOUT_DIR).
// Unmutated cells always run. reference-replay always runs first: its
// failures define the "breaking" cells that repair coverage is measured on.
// Adapters run in a child process that never sees RECIPES_HELDOUT_DIR, the
// truth secret, or which mutation a session carries.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fork, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { TASKS } from "./tasks/index.js";
import { loadMutations } from "./lib/mutations.js";
import { judge } from "./lib/truth.js";
import { summarize, adapterTable, familyTable, curveSvg, priceCalls, cellKey } from "./lib/report.js";
import { APPS } from "./apps/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
export const DEGENERATE = ["do-nothing", "say-done", "click-first-match", "click-everything", "always-stop"];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}

const hashInt = (s) => parseInt(crypto.createHash("sha256").update(s).digest("hex").slice(0, 8), 16);

class Host {
  constructor(spec) {
    const env = { ...process.env };
    delete env.RECIPES_HELDOUT_DIR;
    this.child = fork(path.join(here, "adapter-host.js"), [], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    this.pending = new Map();
    this.n = 0;
    this.spec = spec;
    this.child.on("message", (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.fatal ? p.reject(new Error(m.fatal)) : p.resolve(m);
    });
    this.child.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`adapter host exited (${code})`));
      this.pending.clear();
    });
  }
  send(msg) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, ...msg });
    });
  }
  async close() {
    await this.send({ cmd: "close" }).catch(() => {});
    if (this.child.exitCode == null) this.child.kill("SIGTERM");
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function runBench(opts) {
  const sets = String(opts.sets ?? "dev").split(",").filter((s) => s && s !== "none");
  const heldoutDir = process.env.RECIPES_HELDOUT_DIR;
  if (sets.includes("heldout") && !heldoutDir) throw new Error("--sets heldout needs RECIPES_HELDOUT_DIR");
  const catalogue = loadMutations({ devDir: path.join(here, "mutations", "dev"), heldoutDir: sets.includes("heldout") ? heldoutDir : null, tasks: TASKS, apps: APPS });
  let mutations = catalogue.filter((m) => sets.includes(m.set));
  if (opts.mutations) mutations = mutations.filter((m) => String(opts.mutations).split(",").some((p) => m.id.startsWith(p)));

  let tasks = TASKS;
  if (opts.tasks) tasks = tasks.filter((t) => String(opts.tasks).split(",").some((p) => t.id.startsWith(p)));
  const varIdx = opts.vars != null ? String(opts.vars).split(",").map(Number) : null;

  const adapterSpecs = String(opts.adapters || "reference-replay").split(",").filter(Boolean);
  if (!adapterSpecs.includes("reference-replay")) adapterSpecs.unshift("reference-replay");
  else adapterSpecs.sort((a, b) => (a === "reference-replay" ? -1 : b === "reference-replay" ? 1 : 0));

  // Held-out ids and families never appear in outputs: they get opaque labels,
  // and the mapping is written next to the held-out set, outside the repo.
  const alias = new Map();
  let hn = 0;
  for (const m of mutations.filter((m) => m.set === "heldout")) {
    alias.set(m.id, `H${String(++hn).padStart(2, "0")}`);
    if (!alias.has(`fam:${m.family}`)) alias.set(`fam:${m.family}`, `HF${String(alias.size).padStart(2, "0")}`);
  }
  const pubId = (m) => (m ? (m.set === "heldout" ? alias.get(m.id) : m.id) : null);
  const pubFam = (m) => (m ? (m.set === "heldout" ? alias.get(`fam:${m.family}`) : m.family) : null);

  const cells = [];
  for (const task of tasks) {
    const muts = [null, ...mutations.filter((m) => m.app === task.app && (!m.tasks || m.tasks.includes(task.id)))];
    for (const m of muts) {
      task.runVars.forEach((vars, vi) => {
        if (varIdx && !varIdx.includes(vi)) return;
        const expected = m ? (m.expectedByTask?.[task.id] ?? m.expected) : "none";
        cells.push({ task, m, vars, vi, expected, seed: (hashInt(`${task.id}|${m ? m.id : "none"}|${vi}`) % 900000) + 100 });
      });
    }
  }

  const date = new Date().toLocaleDateString("sv");
  const label = opts.label || `run-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const outDir = path.resolve(opts.out || path.join(repoRoot, "bench-results", "recipes", date, label));
  fs.mkdirSync(outDir, { recursive: true });
  const budget = Number(opts["budget-usd"] ?? 10);
  const spendLog = path.join(repoRoot, "bench-results", "recipes", "spend.jsonl");
  const priorSpend = fs.existsSync(spendLog) ? fs.readFileSync(spendLog, "utf8").split("\n").filter(Boolean).reduce((a, l) => a + JSON.parse(l).usd, 0) : 0;
  const conc = Number(opts.concurrency || 4);
  const quiet = !!opts.quiet;

  const server = await startServer();
  const rows = [];
  const baseline = new Map();
  let spent = 0;
  const log = (...a) => quiet || console.log(...a);
  log(`fixture server ${server.url}; ${tasks.length} tasks, ${mutations.length} mutations (${sets.join("+") || "none"}), ${cells.length} cells per adapter`);

  try {
    for (const spec of adapterSpecs) {
      const host = new Host(spec);
      try {
        const { name } = await host.send({ cmd: "init", adapter: spec, serverUrl: server.url });
        const t0 = Date.now();
        const prepared = new Map();
        const setup = { calls: 0, usd: 0 };
        for (const task of tasks) {
          const sid = await server.newSession({ seed: (hashInt(`${task.id}|record`) % 900000) + 100, mutation: null });
          const r = await host.send({ cmd: "prepare", taskId: task.id, sid });
          await server.drop(sid);
          prepared.set(task.id, r);
          const p = priceCalls(r.calls || []);
          setup.calls += (r.calls || []).length;
          setup.usd += p.usd;
          spent += p.usd;
          if (!r.ok) log(`  [${name}] prepare failed for ${task.id}: ${r.error}`);
        }
        let done = 0;
        await pool(cells, conc, async (c) => {
          if (priorSpend + spent > budget) {
            rows.push({ adapter: name, skipped: "budget", task: c.task.id });
            return;
          }
          const sid = await server.newSession({ seed: c.seed, mutation: c.m });
          let r;
          if (!prepared.get(c.task.id)?.ok) r = { result: { claimedDone: false, answer: null, healed: false, error: "prepare failed" }, calls: [], ms: 0 };
          else r = await host.send({ cmd: "run", taskId: c.task.id, sid, vars: c.vars });
          const truth = await server.truth(sid);
          await server.drop(sid);
          const j = judge(c.task, truth, r.result, c.expected, c.vars);
          const price = priceCalls(r.calls);
          spent += price.usd;
          const row = {
            adapter: name,
            task: c.task.id,
            app: c.task.app,
            reversibility: c.task.reversibility,
            set: c.m ? c.m.set : "none",
            mutation: pubId(c.m),
            family: pubFam(c.m),
            expected: c.expected,
            varIdx: c.vi,
            seed: c.seed,
            ...j,
            answer: r.result.answer,
            error: r.result.error,
            calls: r.calls.length,
            tokIn: r.calls.reduce((a, x) => a + x.inTok, 0),
            tokOut: r.calls.reduce((a, x) => a + x.outTok, 0),
            usd: price.usd,
            unpriced: price.unpriced,
            ms: r.ms,
          };
          rows.push(row);
          if (name === "reference-replay") baseline.set(cellKey(row), row);
          done++;
          if (!quiet && done % 25 === 0) log(`  [${name}] ${done}/${cells.length}  spent $${spent.toFixed(4)}`);
        });
        log(`  [${name}] done in ${((Date.now() - t0) / 1000).toFixed(0)}s; setup calls ${setup.calls} ($${setup.usd.toFixed(4)})`);
        rows.push({ adapter: name, setup: true, calls: setup.calls, usd: setup.usd });
      } finally {
        await host.close();
      }
    }
  } finally {
    await server.close();
  }

  const runRows = rows.filter((r) => !r.setup && !r.skipped);
  const names = [...new Set(runRows.map((r) => r.adapter))];
  const bySet = {};
  for (const set of ["all", ...sets]) {
    const subset = (r) => set === "all" || r.set === "none" || r.set === set;
    bySet[set] = names.map((n) => [n, summarize(runRows.filter((r) => r.adapter === n && subset(r)), baseline)]);
  }

  // Self-checks: the reference must pass every unmutated cell, and no
  // degenerate adapter may succeed on an unmutated or repairable cell.
  const problems = [];
  const refUnmut = runRows.filter((r) => r.adapter === "reference-replay" && !r.mutation);
  for (const r of refUnmut.filter((r) => !r.truthOk)) problems.push(`reference fails unmutated ${r.task} vars#${r.varIdx}: ${r.error || JSON.stringify(r.wrong) || "truth"}`);
  for (const n of names.filter((n) => DEGENERATE.includes(n))) {
    const wins = runRows.filter((r) => r.adapter === n && r.truthOk && r.expected !== "must-stop");
    if (wins.length) problems.push(`degenerate ${n} scored ${wins.length} success(es): ${[...new Set(wins.map((w) => w.task))].join(", ")}`);
    const caught = runRows.filter((r) => r.adapter === n && (r.falseDone || r.wrongAction)).length;
    if (n !== "always-stop" && caught === 0) problems.push(`degenerate ${n} was not caught by false-done or wrong-action`);
  }

  const setupRows = rows.filter((r) => r.setup);
  const skipped = rows.filter((r) => r.skipped).length;
  const totalUsd = runRows.reduce((a, r) => a + r.usd, 0) + setupRows.reduce((a, r) => a + r.usd, 0);
  fs.mkdirSync(path.dirname(spendLog), { recursive: true });
  fs.appendFileSync(spendLog, JSON.stringify({ at: new Date().toISOString(), label, adapters: names, usd: totalUsd }) + "\n");

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot }).toString().trim();
  } catch {}
  const appsUsed = [...new Set(tasks.map((t) => t.app))];
  const results = {
    date,
    label,
    commit,
    sets,
    counts: {
      apps: appsUsed.length,
      tasks: tasks.length,
      mutations: Object.fromEntries(sets.map((s) => [s, mutations.filter((m) => m.set === s).length])),
      cellsPerAdapter: cells.length,
    },
    adapters: names,
    summaries: Object.fromEntries(Object.entries(bySet).map(([k, v]) => [k, Object.fromEntries(v)])),
    setup: setupRows,
    spendUsd: totalUsd,
    priorSpendUsd: priorSpend,
    skippedForBudget: skipped,
    problems,
    rows: runRows,
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1));

  const md = [
    `# Recipes benchmark: ${label}`,
    "",
    `${date}, commit ${commit}. ${appsUsed.length} apps, ${tasks.length} tasks, mutations: ${sets.map((s) => `${s} ${results.counts.mutations[s]}`).join(", ") || "none"}. ${cells.length} cells per adapter (unmutated + each applicable mutation, x variable sets).`,
    "",
    "Every number below comes from the fixture server's state log (`/__truth`). `claimedDone` is used only to detect false \"done\". Rates show a 95% Wilson interval in brackets. Definitions: bench/recipes/ADAPTER.md.",
    "",
    problems.length ? `## Self-check problems\n\n${problems.map((p) => `- ${p}`).join("\n")}\n` : "Self-checks passed: the reference passes every unmutated cell; every degenerate adapter scores 0 and is caught.\n",
  ];
  for (const [set, sums] of Object.entries(bySet)) {
    if (set === "all" && sets.length < 2) continue;
    md.push(`## ${set === "all" ? "All sets" : set === "heldout" ? "Held-out set" : "Dev set"} (unmutated cells included)`, "", adapterTable(sums), "");
    fs.writeFileSync(path.join(outDir, `curve-${set}.svg`), curveSvg(sums, `Coverage vs false heals: ${set}`));
    md.push(`![curve](curve-${set}.svg)`, "");
  }
  for (const set of sets) {
    md.push(`## Per mutation family: ${set}`, "", "Cells: successes/runs; `wa` wrong actions, `fh` false heals.", "", familyTable(runRows.filter((r) => r.set === set), names), "");
  }
  md.push("## Spend", "", `This run: $${totalUsd.toFixed(4)} (${runRows.reduce((a, r) => a + r.calls, 0) + setupRows.reduce((a, r) => a + r.calls, 0)} model calls). All logged runs before it: $${priorSpend.toFixed(4)}. Budget $${budget}.${skipped ? ` ${skipped} runs skipped for budget.` : ""}`, "");
  fs.writeFileSync(path.join(outDir, "report.md"), md.join("\n"));
  if (heldoutDir && sets.includes("heldout")) {
    fs.writeFileSync(path.join(heldoutDir, `aliases-${date}-${label}.json`), JSON.stringify(Object.fromEntries(alias), null, 1));
  }
  log(`wrote ${outDir}`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = args(process.argv.slice(2));
  const res = await runBench(opts);
  for (const [n, s] of Object.entries(res.summaries[res.sets.length > 1 ? "all" : res.sets[0] || "all"] || res.summaries.all)) {
    console.log(`${n.padEnd(26)} unmut ${fmt(s.successUnmutated)}  repairable ${fmt(s.successRepairable)}  coverage ${fmt(s.repairCoverage)}  stop ${fmt(s.correctStop)}  falseHeal ${fmt(s.falseHealRate)}  falseDone ${fmt(s.falseDoneRate)}  wrongAct ${fmt(s.wrongActionRate)}  $${s.usdTotal.toFixed(4)}`);
  }
  if (res.problems.length) {
    console.log("PROBLEMS:\n" + res.problems.join("\n"));
    process.exitCode = 1;
  }
}
function fmt(x) {
  return x.rate == null ? "  n/a" : `${(x.rate * 100).toFixed(0).padStart(3)}%`;
}
