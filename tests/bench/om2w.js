/**
 * Online-Mind2Web as a suite of the real-task trial: the fetch, the split by
 * site, the census classifier and the counts a sealed part may report.
 * The rules and every pinned value are in om2w-config.json.
 *
 *   node tests/bench/om2w.js fetch --out <file>
 *   node tests/bench/om2w.js split --dataset <file> --part dev|gate|vault|reserve|all --out <file> [--no-holdout]
 *   node tests/bench/om2w.js summary <dir> --part <part> --planned <runs> [--arm shipped] [--shards N] [--commit sha] [--census]
 *
 * `fetch` reads the gated task file from Hugging Face at the pinned revision
 * with HF_TOKEN, checks its size and git blob hash against the config, and
 * writes it to --out, which must be outside the repository's artifact paths.
 * It prints the number of tasks and nothing of their text.
 *
 * `split` writes the tasks of one part, in run.js's format, to --out. It
 * prints counts only: how many tasks and sites each part holds, and how many
 * sites the clash rules moved. It needs the plain holdout file (the workflow
 * decrypts it) so that rule 2 can be applied; --no-holdout is for a machine
 * that has none, and the split it prints there is not the workflow's.
 *
 * `summary` reads the counts files the shards wrote (om2w-counts-*.json, or
 * om2w-census-*.json with --census) and prints the table. It never reads a
 * per-task file, so a sealed part's summary cannot name a task.
 *
 * Nothing here prints a token, a task's text, its id or its address, for any
 * part. Dev sites are named only by the census, and only for dev.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hashUnit, normaliseTasks, isInfra } = require("./judge.js");

const CONFIG = require("./om2w-config.json");
const PARTS = Object.freeze(["dev", "gate", "vault", "reserve"]);

/** The registrable domain of a start page, by the extension's own rule (agentTools.js siteOf). */
function siteOfUrl(url, siteOf = require("../../extension/agentTools.js").siteOf) {
  try { return siteOf(new URL(String(url)).href) || new URL(String(url)).hostname; } catch (_e) { return ""; }
}

/** The git blob hash of some bytes: what the Hugging Face tree API reports as a file's oid. */
function gitBlobSha1(bytes) {
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Whether downloaded bytes are the pinned file. Problems as sentences, naming nothing of the content. */
function checkDataset(bytes, dataset = CONFIG.dataset) {
  const problems = [];
  if (bytes.length !== dataset.size) problems.push(`the file has ${bytes.length} bytes, the pinned revision's has ${dataset.size}`);
  const sha = gitBlobSha1(bytes);
  if (sha !== dataset.gitBlobSha1) problems.push("the file's git blob hash is not the pinned one");
  return problems;
}

/** The Online-Mind2Web tasks in run.js's format: family "om2w", the dataset's level as the difficulty. */
function om2wTasks(list) {
  return normaliseTasks(list).map((t) => ({
    id: String(t.id).replace(/[^A-Za-z0-9_-]/g, "_"),
    task: t.task,
    url: t.url,
    level: "om2w",
    difficulty: ["easy", "medium", "hard"].includes(t.level) ? t.level : "unknown",
  }));
}

/**
 * The split, by site. `devSites` are sites a read suite uses (rule 1),
 * `sealedSites` the sites of the sealed holdout suite (rule 2, which wins).
 * The rest go, in the order of hashUnit(seed:site), to the part least full
 * against its target. Returns {parts: {dev: [tasks], ...}, siteParts: Map,
 * moved: {toDev, toSealed}}. The same input always gives the same split.
 */
function splitBySite(tasks, { seed = CONFIG.split.seed, targets = CONFIG.split.targets, devSites = new Set(), sealedSites = new Set(), siteOf = siteOfUrl } = {}) {
  const bySite = new Map();
  for (const t of tasks) {
    const site = siteOf(t.url) || "(none)";
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(t);
  }
  const order = [...bySite.keys()].sort((a, b) => hashUnit(`${seed}:${a}`) - hashUnit(`${seed}:${b}`) || a.localeCompare(b));
  const parts = Object.fromEntries(PARTS.map((p) => [p, []]));
  const siteParts = new Map();
  const put = (site, part) => { siteParts.set(site, part); parts[part].push(...bySite.get(site)); };
  const leastFull = (names) => names.reduce((best, p) => (parts[p].length / (targets[p] || 1) < parts[best].length / (targets[best] || 1) ? p : best), names[0]);
  const sealedParts = CONFIG.split.sealedParts;
  const moved = { toDev: 0, toSealed: 0 };
  for (const site of order) if (sealedSites.has(site)) { put(site, leastFull(sealedParts)); moved.toSealed++; }
  for (const site of order) if (!siteParts.has(site) && devSites.has(site)) { put(site, "dev"); moved.toDev++; }
  for (const site of order) if (!siteParts.has(site)) put(site, leastFull(PARTS));
  return { parts, siteParts, moved };
}

/** The sites of every read suite (rule 1) and of the holdout (rule 2), from trial.js readSuites. */
function clashSites(suites, siteOf = siteOfUrl) {
  const T = require("./trial.js");
  const devSites = new Set(CONFIG.split.webvoyagerSites);
  const sealedSites = new Set();
  for (const [name, list] of Object.entries(suites || {})) {
    for (const t of list || []) for (const s of [t.url, ...(t.sites || [])].map((u) => siteOf(u)).filter(Boolean)) (T.SEALED_SUITES.includes(name) ? sealedSites : devSites).add(s);
  }
  return { devSites, sealedSites };
}

// ---- Census: is the start page there for an ordinary browser on this runner?

const CENSUS_CLASSES = Object.freeze(["reachable", "blocked", "error", "timeout"]);

/**
 * The human-check widget selectors of a build's own content script
 * (HUMAN_CHECK_WIDGETS in agentContentScript.js), read from the file so the
 * census sees what the engine sees and keeps no copy of its own.
 */
function engineWidgetSelectors(extDir) {
  const src = fs.readFileSync(path.join(extDir, "agentContentScript.js"), "utf8");
  const m = /const HUMAN_CHECK_WIDGETS = \[([\s\S]*?)\]\.join/.exec(src);
  if (!m) throw new Error("agentContentScript.js has no HUMAN_CHECK_WIDGETS list: the census cannot use the engine's own detection");
  const list = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2]);
  if (!list.length) throw new Error("HUMAN_CHECK_WIDGETS is empty");
  return list;
}

/**
 * One start page's class, from what the page showed: `obs` is {navError,
 * timedOut, status, title, url, text, elements, widget}. Blocked: the
 * engine's own human-check test (agentTools.js isChallengePage) says so, a
 * human-check widget is in view, or the server refused the visit (401, 403,
 * 429) with a page as thin as a challenge page. Error: the page did not load
 * or answered 400 or more otherwise. Timeout: nothing had loaded at the
 * deadline. Anything else is reachable.
 */
function censusClass(obs, isChallengePage = require("../../extension/agentTools.js").isChallengePage) {
  const o = obs || {};
  const text = String(o.text || "");
  const elements = Math.max(0, Number(o.elements) || 0);
  if (o.timedOut && !text.trim()) return "timeout";
  if (o.navError && !text.trim()) return "error";
  const page = { title: o.title || "", url: o.url || "", innerText: text, elements: Array.from({ length: elements }, () => ({})) };
  if (isChallengePage(page) || o.widget) return "blocked";
  const thin = text.length <= 1500 && elements <= 12;
  if ([401, 403, 429].includes(Number(o.status)) && thin) return "blocked";
  if (o.navError || Number(o.status) >= 400) return "error";
  return "reachable";
}

// ---- Counts: what a part's shard reports, and the only thing a sealed shard writes

const SECONDS_BIN = 10;

/**
 * One of passed, failed, blocked, timed out, held, declined, lost. Declined:
 * the harness refused a confirmation the run asked for (pay, send, delete and
 * every other kind outside BENCH_ALLOW). Held: the run ended waiting on the
 * user for something only a person can give (a sign-in, a code, a payment, an
 * answer).
 */
function outcomeOf(row) {
  if (row.success) return "passed";
  if (isInfra(row)) return "lost";
  if (row.blocked || row.waitKind === "human_check") return "blocked";
  if ((row.held || []).some((h) => h && h.allowed === false) || /^stopped at a confirmation/.test(String(row.ending || ""))) return "declined";
  if (row.waitKind || /^asked the user/.test(String(row.ending || ""))) return "held";
  if (/^timed out/.test(String(row.ending || ""))) return "timed out";
  return "failed";
}
const OUTCOMES = Object.freeze(["passed", "failed", "blocked", "timed out", "held", "declined", "lost"]);

const add = (hist, key) => { hist[key] = (hist[key] || 0) + 1; };

/** The counts of some finished runs: outcomes, histograms of the solved runs' seconds and model calls, tokens and spend. No task id, text or order. */
function countsOf(rows) {
  const c = emptyCounts();
  for (const r of rows || []) {
    c.runs++;
    c.outcomes[outcomeOf(r)]++;
    const calls = r.calls || (r.modelCalls || []).length || 0;
    if (r.success) {
      add(c.solvedSeconds, String(Math.floor((r.seconds || 0) / SECONDS_BIN) * SECONDS_BIN));
      add(c.solvedCalls, String(calls));
    }
    for (const m of r.modelCalls || []) {
      c.agentTokens.prompt += m.prompt || 0;
      c.agentTokens.cached += m.cached || 0;
      c.agentTokens.completion += m.completion || 0;
    }
    c.agentCalls += calls;
    const u = r.judgeUsage || {};
    c.judgeTokens.input += u.input || 0;
    c.judgeTokens.cacheWrite += u.cacheWrite || 0;
    c.judgeTokens.cacheRead += u.cacheRead || 0;
    c.judgeTokens.output += u.output || 0;
    c.judgeCalls += u.calls || 0;
    c.agentUSD += (r.costUSD || 0) + (r.longPromptUSD || 0) + (r.lostAttemptsUSD || 0);
    c.judgeUSD += r.judgeCostUSD || 0;
    c.realInputs += (r.counters && r.counters.realInputs) || 0;
  }
  return c;
}

function emptyCounts() {
  return {
    runs: 0,
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
    solvedSeconds: {},
    solvedCalls: {},
    agentTokens: { prompt: 0, cached: 0, completion: 0 },
    judgeTokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    agentCalls: 0,
    judgeCalls: 0,
    agentUSD: 0,
    judgeUSD: 0,
    realInputs: 0,
  };
}

/** Several shards' counts as one. */
function mergeCounts(list) {
  const c = emptyCounts();
  for (const x of list || []) {
    c.runs += x.runs || 0;
    for (const o of OUTCOMES) c.outcomes[o] += (x.outcomes && x.outcomes[o]) || 0;
    for (const k of ["solvedSeconds", "solvedCalls"]) for (const [b, n] of Object.entries(x[k] || {})) c[k][b] = (c[k][b] || 0) + n;
    for (const k of Object.keys(c.agentTokens)) c.agentTokens[k] += (x.agentTokens && x.agentTokens[k]) || 0;
    for (const k of Object.keys(c.judgeTokens)) c.judgeTokens[k] += (x.judgeTokens && x.judgeTokens[k]) || 0;
    for (const k of ["agentCalls", "judgeCalls", "agentUSD", "judgeUSD", "realInputs"]) c[k] += x[k] || 0;
  }
  return c;
}

/** The median of a histogram {value: count}, as the value of the middle entry (a bin's lower edge for seconds). */
function histMedian(hist) {
  const entries = Object.entries(hist || {}).map(([k, n]) => [Number(k), n]).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) return null;
  let seen = 0;
  for (const [k, n] of entries) { seen += n; if (seen * 2 >= total) return k; }
  return null;
}

/** The report of a part from its merged counts. `planned` is the number of runs meant to happen. */
function report(counts, { planned = 0 } = {}) {
  const o = counts.outcomes;
  const reached = counts.runs - o.blocked - o.lost;
  return {
    planned,
    ran: counts.runs,
    notRun: Math.max(0, planned - counts.runs),
    ...Object.fromEntries(OUTCOMES.map((k) => [k === "timed out" ? "timedOut" : k, o[k]])),
    strictRate: planned ? o.passed / planned : null,
    scoredRate: reached > 0 ? o.passed / reached : null,
    medianSecondsSolved: histMedian(counts.solvedSeconds),
    medianCallsSolved: histMedian(counts.solvedCalls),
    agentTokens: { ...counts.agentTokens, uncached: counts.agentTokens.prompt - counts.agentTokens.cached },
    judgeTokens: counts.judgeTokens,
    agentUSD: counts.agentUSD,
    judgeUSD: counts.judgeUSD,
    spendUSD: counts.agentUSD + counts.judgeUSD,
  };
}

/** The report as Markdown. Numbers only. */
function reportMarkdown(r, meta = {}) {
  const pct = (x) => (x === null || x === undefined ? "-" : `${(100 * x).toFixed(1)}%`);
  const usd = (x) => `$${Number(x || 0).toFixed(4)}`;
  const out = [`## Online-Mind2Web, part ${meta.part || "?"}${meta.dry ? " (dry mode)" : ""}${meta.sealed ? ", sealed: numbers only" : ""}`, ""];
  out.push([meta.arm ? `arm ${meta.arm}` : "", meta.agent ? `agent ${meta.agent}` : "", meta.tier ? `tier ${meta.tier}` : "", meta.judge ? `judge ${meta.judge}` : "", meta.revision ? `dataset ${String(meta.revision).slice(0, 12)}` : "", meta.commit ? `commit ${String(meta.commit).slice(0, 7)}` : ""].filter(Boolean).join(", "), "");
  out.push("Our number on this runner. It is not comparable with the Online-Mind2Web leaderboard, which uses other browsers and another judge.", "");
  out.push("| planned runs | passed | failed | blocked | timed out | held | declined | lost | not run | strict rate | scored rate |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  out.push(`| ${r.planned} | ${r.passed} | ${r.failed} | ${r.blocked} | ${r.timedOut} | ${r.held} | ${r.declined} | ${r.lost} | ${r.notRun} | ${pct(r.strictRate)} | ${pct(r.scoredRate)} |`);
  out.push("");
  out.push("Strict rate: passes over all planned runs, with blocked, declined, lost and not-run counted as failures. Scored rate: passes over the runs that reached the site (not blocked, not lost).");
  out.push(`Per solved run: median ${r.medianSecondsSolved === null ? "-" : `${r.medianSecondsSolved} to ${r.medianSecondsSolved + SECONDS_BIN} s`}, median ${r.medianCallsSolved === null ? "-" : r.medianCallsSolved} model call(s).`);
  out.push(`Agent tokens: ${r.agentTokens.uncached} prompt uncached, ${r.agentTokens.cached} prompt cached, ${r.agentTokens.completion} output. Judge tokens: ${r.judgeTokens.input} input uncached, ${r.judgeTokens.cacheWrite} written to the cache, ${r.judgeTokens.cacheRead} read from it, ${r.judgeTokens.output} output.`);
  out.push(`Real spend: ${usd(r.spendUSD)} (agent ${usd(r.agentUSD)}, judge ${usd(r.judgeUSD)})${meta.capUSD ? `, cap $${Number(meta.capUSD).toFixed(2)}` : ""}.`);
  if (meta.problems && meta.problems.length) out.push("", `**Check failed.** ${meta.problems.join(" ")}`);
  return out.join("\n");
}

/** Census counts: one per class, for a part. */
function censusReport(list) {
  const byPart = {};
  const devSites = [];
  for (const x of list || []) {
    for (const [part, counts] of Object.entries(x.counts || {})) {
      byPart[part] = byPart[part] || Object.fromEntries(CENSUS_CLASSES.map((k) => [k, 0]));
      for (const k of CENSUS_CLASSES) byPart[part][k] += counts[k] || 0;
    }
    devSites.push(...(x.devSites || []));
  }
  return { byPart, devSites: devSites.sort((a, b) => String(a.site).localeCompare(String(b.site))) };
}

function censusMarkdown(r, meta = {}) {
  const out = [`## Online-Mind2Web block census${meta.dry ? " (dry mode, fixture pages)" : ""}`, ""];
  out.push("Each start page loaded once in headful Chrome under xvfb with the packed extension and the browser's own user agent, no model call. Classes by the engine's own human-check detection. Sealed parts are counts only.", "");
  out.push("| part | pages | reachable | blocked | error | timeout | blocked share |", "| --- | --- | --- | --- | --- | --- | --- |");
  let all = Object.fromEntries(CENSUS_CLASSES.map((k) => [k, 0]));
  for (const part of [...PARTS, "fixture"]) {
    const c = r.byPart[part];
    if (!c) continue;
    const n = CENSUS_CLASSES.reduce((a, k) => a + c[k], 0);
    all = Object.fromEntries(CENSUS_CLASSES.map((k) => [k, all[k] + c[k]]));
    out.push(`| ${part} | ${n} | ${c.reachable} | ${c.blocked} | ${c.error} | ${c.timeout} | ${n ? `${(100 * c.blocked / n).toFixed(1)}%` : "-"} |`);
  }
  const n = CENSUS_CLASSES.reduce((a, k) => a + all[k], 0);
  out.push(`| **all** | **${n}** | **${all.reachable}** | **${all.blocked}** | **${all.error}** | **${all.timeout}** | **${n ? `${(100 * all.blocked / n).toFixed(1)}%` : "-"}** |`);
  if (r.devSites.length) {
    out.push("", "Dev sites (dev only is named):", "", "| site | class | HTTP status |", "| --- | --- | --- |");
    for (const s of r.devSites) out.push(`| ${s.site} | ${s.class} | ${s.status || "-"} |`);
  }
  out.push("", "The plan's rule: under about 30% blocked, run from GitHub Actions; over it, probe the cluster first. Blocked tasks stay in the set.");
  return out.join("\n");
}

const readJsonFiles = (dir, re) => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) { try { out.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch (_e) { /* a file cut short */ } }
    }
  };
  walk(dir);
  return out;
};

async function fetchDataset(out, env = process.env) {
  const token = env.HF_TOKEN || "";
  if (!token) throw new Error("HF_TOKEN is not set: the repository needs the HF_TOKEN secret (a read token of an account that accepted the dataset's conditions).");
  const d = CONFIG.dataset;
  const url = `https://huggingface.co/datasets/${d.repo}/resolve/${d.revision}/${d.file}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "follow", signal: AbortSignal.timeout(60000) }).catch(() => null);
  if (!res) throw new Error("Hugging Face did not answer.");
  if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status} for the pinned task file${res.status === 401 || res.status === 403 ? ": the token is not accepted, or its account has not accepted the dataset's conditions" : ""}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const problems = checkDataset(bytes, d);
  if (problems.length) throw new Error(`The fetched file is not the pinned one: ${problems.join("; ")}.`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes, { mode: 0o600 });
  return om2wTasks(JSON.parse(bytes.toString("utf8"))).length;
}

async function main(argv) {
  const [cmd, target] = argv;
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
  if (cmd === "fetch") {
    const out = flag("--out");
    if (!out) throw new Error("fetch needs --out");
    const n = await fetchDataset(out);
    console.log(`Online-Mind2Web: ${n} tasks at revision ${CONFIG.dataset.revision.slice(0, 12)}, size and hash as pinned.`);
    return;
  }
  if (cmd === "split") {
    const part = flag("--part");
    if (![...PARTS, "all"].includes(part)) throw new Error(`--part is one of ${PARTS.join(", ")} or all`);
    const tasks = om2wTasks(JSON.parse(fs.readFileSync(flag("--dataset"), "utf8")));
    const T = require("./trial.js");
    const suites = T.readSuites();
    if (!suites.holdout && !argv.includes("--no-holdout")) throw new Error("No plain holdout file: rule 2 needs it (the workflow decrypts it). --no-holdout splits without it, for a local look only.");
    const { devSites, sealedSites } = clashSites(suites);
    const { parts, siteParts, moved } = splitBySite(tasks, { devSites, sealedSites });
    const sites = (p) => [...siteParts.values()].filter((x) => x === p).length;
    console.log(`Split by site (seed ${CONFIG.split.seed}): ${PARTS.map((p) => `${p} ${parts[p].length} tasks on ${sites(p)} sites`).join(", ")}. Rule 1 moved ${moved.toDev} site(s) to dev, rule 2 moved ${moved.toSealed} to the sealed side.`);
    const chosen = part === "all" ? PARTS.flatMap((p) => parts[p].map((t) => ({ ...t, part: p }))) : parts[part].map((t) => ({ ...t, part }));
    fs.mkdirSync(path.dirname(flag("--out")), { recursive: true });
    fs.writeFileSync(flag("--out"), JSON.stringify(chosen), { mode: 0o600 });
    return;
  }
  if (cmd === "summary") {
    const part = flag("--part");
    const sealed = CONFIG.split.sealedParts.includes(part);
    if (argv.includes("--census")) {
      const r = censusReport(readJsonFiles(target, /^om2w-census-.*\.json$/));
      const shards = parseInt(flag("--shards") || "0", 10);
      const got = readJsonFiles(target, /^om2w-census-.*\.json$/).length;
      console.log(censusMarkdown(r, { dry: argv.includes("--dry") }));
      fs.writeFileSync(path.join(target, "om2w-census-summary.json"), JSON.stringify(r, null, 2));
      if (shards && got !== shards) { console.error(`\n${got} of ${shards} census shard(s) left a counts file.`); process.exit(1); }
      return;
    }
    const files = readJsonFiles(target, /^om2w-counts-.*\.json$/);
    const counts = mergeCounts(files.map((f) => f.counts));
    const planned = parseInt(flag("--planned") || "0", 10);
    const r = report(counts, { planned });
    const first = files[0] || {};
    const problems = [];
    const shards = parseInt(flag("--shards") || "0", 10);
    if (shards && files.length !== shards) problems.push(`${files.length} of ${shards} shard(s) left a counts file.`);
    if (flag("--arm") === "shipped") {
      if (files.some((f) => f.debuggerAvailable !== false)) problems.push("A shard's build has chrome.debugger, or did not say, in the shipped arm.");
      if (counts.realInputs) problems.push(`${counts.realInputs} real input event(s) in the shipped arm.`);
    }
    const text = reportMarkdown(r, { part, sealed, dry: files.some((f) => f.dry), arm: flag("--arm"), agent: first.agent, tier: first.tier, judge: first.judge, revision: CONFIG.dataset.revision, commit: flag("--commit"), capUSD: files.reduce((a, f) => a + (f.capUSD || 0), 0), problems });
    console.log(text);
    fs.writeFileSync(path.join(target, "om2w-summary.json"), JSON.stringify({ part, sealed, report: r, problems }, null, 2));
    if (problems.length) process.exit(1);
    return;
  }
  throw new Error("Usage: om2w.js fetch --out <file> | split --dataset <file> --part <part> --out <file> | summary <dir> --part <part> --planned N [--census]");
}

module.exports = { CONFIG, PARTS, OUTCOMES, CENSUS_CLASSES, SECONDS_BIN, siteOfUrl, gitBlobSha1, checkDataset, om2wTasks, splitBySite, clashSites, engineWidgetSelectors, censusClass, outcomeOf, countsOf, emptyCounts, mergeCounts, histMedian, report, reportMarkdown, censusReport, censusMarkdown, fetchDataset };

if (require.main === module) {
  // Every error here is ours and names no task, but a stack can hold a path: print the message only.
  main(process.argv.slice(2)).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}
