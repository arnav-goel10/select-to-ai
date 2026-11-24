/**
 * Online-Mind2Web as a suite of the real-task trial: the fetch, the split by
 * site, the census classifier and the counts a sealed part may report.
 * The rules and every pinned value are in om2w-config.json.
 *
 *   node tests/bench/om2w.js fetch --out <file>
 *   node tests/bench/om2w.js split --dataset <file> --part dev|gate|vault|reserve|all --out <file> --digest-key-file <file> [--bootstrap] [--excluded-out <file>] [--no-holdout]
 *   node tests/bench/om2w.js summary <dir> --part <part> --planned <runs> --planned-tasks <tasks> [--excluded N] [--arm shipped] [--shards N] [--commit sha] [--census]
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
const { normaliseTasks, isInfra } = require("./judge.js");
const { approvedHold } = require("./approver.js");

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

/** A number in [0, 1) from a hash of some text: the same text, the same number, on any machine. */
function unitOf(text) {
  return parseInt(crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 13), 16) / 2 ** 52;
}

/** The part a number in [0, 1) falls in: the first whose cut is above it. `cuts` is [[part, cut], ...], rising, ending at 1. */
function partByCut(u, cuts) {
  for (const [part, cut] of cuts) if (u < cut) return part;
  return cuts[cuts.length - 1][0];
}

/** The cuts of the sealed parts alone, with their shares of the whole kept in proportion. */
function sealedCuts(cuts, sealedParts) {
  let prev = 0;
  const widths = [];
  for (const [part, cut] of cuts) { if (sealedParts.includes(part)) widths.push([part, cut - prev]); prev = cut; }
  const total = widths.reduce((a, [, w]) => a + w, 0);
  let at = 0;
  return widths.map(([part, w], i) => [part, i === widths.length - 1 ? 1 : (at += w / total)]);
}

/**
 * One site's part, from the seed, the site and the two clash sets only: no
 * other site and no other task moves it. Rule 2 (a holdout site) goes to a
 * sealed part by a second hash, and wins over rule 1 (a read suite's site),
 * which goes to dev. Every other site falls by its own hash against the cuts.
 * Returns {part, rule}, rule being 1, 2 or 3.
 */
function partOfSite(site, { seed = CONFIG.split.seed, cuts = CONFIG.split.cuts, sealedParts = CONFIG.split.sealedParts, devSites = new Set(), sealedSites = new Set() } = {}) {
  if (sealedSites.has(site)) return { part: partByCut(unitOf(`${seed}:sealed:${site}`), sealedCuts(cuts, sealedParts)), rule: 2 };
  if (devSites.has(site)) return { part: "dev", rule: 1 };
  return { part: partByCut(unitOf(`${seed}:${site}`), cuts), rule: 3 };
}

/** Whether a task is on the never-send list: the first 32 characters of its id, as the upstream issues give them. */
function neverSend(task, ids = CONFIG.neverSend.ids) {
  const head = String(task.id || "").slice(0, 32).toLowerCase();
  return ids.some((x) => String(x).slice(0, 32).toLowerCase() === head);
}

/**
 * The split, by site. `devSites` are sites a read suite uses (rule 1),
 * `sealedSites` the sites of the sealed holdout suite (rule 2, which wins).
 * Each site's part is its own (partOfSite). Tasks on the never-send list are
 * left out of every part and counted in `excluded`; their sites stay in the
 * map. Returns {parts: {dev: [tasks], ...}, siteParts: Map, moved: {toDev,
 * toSealed}, excluded: {dev: n, ...}}. The same input always gives the same split.
 */
function splitBySite(tasks, { seed = CONFIG.split.seed, cuts = CONFIG.split.cuts, devSites = new Set(), sealedSites = new Set(), siteOf = siteOfUrl, never = CONFIG.neverSend.ids } = {}) {
  const parts = Object.fromEntries(PARTS.map((p) => [p, []]));
  const excluded = Object.fromEntries(PARTS.map((p) => [p, 0]));
  const siteParts = new Map();
  const moved = { toDev: 0, toSealed: 0 };
  const sealedParts = CONFIG.split.sealedParts;
  for (const t of tasks) {
    const site = siteOf(t.url) || "(none)";
    if (!siteParts.has(site)) {
      const { part, rule } = partOfSite(site, { seed, cuts, sealedParts, devSites, sealedSites });
      siteParts.set(site, part);
      const byHash = partByCut(unitOf(`${seed}:${site}`), cuts);
      if (rule === 1 && byHash !== "dev") moved.toDev++;
      if (rule === 2 && !sealedParts.includes(byHash)) moved.toSealed++;
    }
    const part = siteParts.get(site);
    if (neverSend(t, never)) excluded[part]++;
    else parts[part].push(t);
  }
  for (const p of PARTS) parts[p].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { parts, siteParts, moved, excluded };
}

/**
 * A keyed digest (HMAC-SHA256) of the site-to-part map and the seed. Keyed,
 * so the committed value says nothing about which site is where, nor lets
 * anyone test a guess at the holdout's sites.
 */
function splitDigest(siteParts, key, seed = CONFIG.split.seed) {
  if (!key || String(key).length < 32) throw new Error("the split digest needs a key of 32 or more characters");
  const map = [...siteParts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHmac("sha256", String(key)).update(JSON.stringify({ seed, map })).digest("hex");
}

/**
 * Whether a split may be used: its digest against the committed one.
 * Committed and equal: ok. Committed and different: refused, always. Not
 * committed: refused, unless this is the one-time bootstrap, which is itself
 * refused once a value is committed. Returns {ok, bootstrap, message}.
 */
function checkSplitDigest(digest, { committed = CONFIG.split.digest, bootstrap = false } = {}) {
  if (committed) {
    if (bootstrap) return { ok: false, message: "The split digest is already committed (om2w-config.json split.digest), so bootstrap_split is refused: it is for the first census only." };
    if (digest === committed) return { ok: true, message: `Split digest ${digest.slice(0, 16)}, the committed one.` };
    return { ok: false, message: `The split is not the committed one: its digest ${digest.slice(0, 16)} is not ${committed.slice(0, 16)}. A read suite, the holdout, the dataset revision, the cuts or the seed changed and moved a site. Nothing was run. Find what changed; commit a new digest only on purpose, before any result of the new split is seen.` };
  }
  if (bootstrap) return { ok: true, bootstrap: true, message: `BOOTSTRAP: the split digest is not committed yet. This split's digest is ${digest}. Commit it as split.digest in tests/bench/om2w-config.json before any run: until then only a bootstrap census can run, and once it is committed bootstrap is refused.` };
  return { ok: false, message: "The split digest is not committed yet (om2w-config.json split.digest is empty). Nothing was run. Run the census once with bootstrap_split ticked, and commit the digest it prints." };
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

/**
 * The outcome had every hold been declined, as the harness did before the
 * simulated approver: a run in which the approver allowed a hold counts as
 * declined, a failure, whatever it went on to do. One run gives both scores.
 */
function outcomeAllDeclined(row) {
  return approvedHold(row) ? "declined" : outcomeOf(row);
}

/** How the held steps went: put to the approver, allowed on its yes, declined, and the runs with a hold it allowed. */
function approvalCounts(rows) {
  const c = { asked: 0, approved: 0, declined: 0, runsApproved: 0 };
  for (const r of rows || []) {
    for (const h of r.held || []) {
      if (!h || h.by !== "approver") continue;
      c.asked++;
      if (h.allowed) c.approved++; else c.declined++;
    }
    if (approvedHold(r)) c.runsApproved++;
  }
  return c;
}

const add = (hist, key) => { hist[key] = (hist[key] || 0) + 1; };

/** The counts of some finished runs: outcomes, histograms of the solved runs' seconds and model calls, tokens and spend. No task id, text or order. */
function countsOf(rows) {
  const c = emptyCounts();
  for (const r of rows || []) {
    c.runs++;
    c.outcomes[outcomeOf(r)]++;
    c.outcomesAllDeclined[outcomeAllDeclined(r)]++;
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
    c.approverUSD += r.approverUSD || 0;
    c.realInputs += (r.counters && r.counters.realInputs) || 0;
  }
  c.holds = approvalCounts(rows);
  return c;
}

function emptyCounts() {
  return {
    runs: 0,
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
    outcomesAllDeclined: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
    holds: { asked: 0, approved: 0, declined: 0, runsApproved: 0 },
    solvedSeconds: {},
    solvedCalls: {},
    agentTokens: { prompt: 0, cached: 0, completion: 0 },
    judgeTokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    agentCalls: 0,
    judgeCalls: 0,
    agentUSD: 0,
    judgeUSD: 0,
    approverUSD: 0,
    realInputs: 0,
  };
}

/** Several shards' counts as one. */
function mergeCounts(list) {
  const c = emptyCounts();
  for (const x of list || []) {
    c.runs += x.runs || 0;
    for (const o of OUTCOMES) c.outcomes[o] += (x.outcomes && x.outcomes[o]) || 0;
    // A counts file from before the approver has no second set: every hold there was declined, so it is the same.
    for (const o of OUTCOMES) c.outcomesAllDeclined[o] += ((x.outcomesAllDeclined || x.outcomes) && (x.outcomesAllDeclined || x.outcomes)[o]) || 0;
    for (const k of Object.keys(c.holds)) c.holds[k] += (x.holds && x.holds[k]) || 0;
    for (const k of ["solvedSeconds", "solvedCalls"]) for (const [b, n] of Object.entries(x[k] || {})) c[k][b] = (c[k][b] || 0) + n;
    for (const k of Object.keys(c.agentTokens)) c.agentTokens[k] += (x.agentTokens && x.agentTokens[k]) || 0;
    for (const k of Object.keys(c.judgeTokens)) c.judgeTokens[k] += (x.judgeTokens && x.judgeTokens[k]) || 0;
    for (const k of ["agentCalls", "judgeCalls", "agentUSD", "judgeUSD", "approverUSD", "realInputs"]) c[k] += x[k] || 0;
  }
  return c;
}

/**
 * Whether a sealed shard may write its counts: only when every run it planned was recorded.
 * A shard the cap or an error stopped early writes nothing, so no run of a few tasks is ever counted.
 */
function sealedShardComplete(rows, plannedRuns) {
  return plannedRuns > 0 && (rows || []).length === plannedRuns;
}

/**
 * Why a sealed report is withheld, or "" when it may be shown. A sealed part is reported only whole:
 * every planned shard left its counts, no shard stopped early, the runs counted are exactly the runs
 * planned, and they cover at least `least` tasks. A report of part of a plan could be differenced
 * against another (a rising cap, a crash) to read one task's outcome, so none is ever shown.
 * The minimum size is waived for a dry run on the fixture pages only; the whole-plan rule is not.
 */
function sealedWithheld({ files = [], counts, planned = 0, plannedTasks = 0, shards = 0, least }) {
  const dry = files.length > 0 && files.every((f) => f.dry);
  const runs = (counts && counts.runs) || 0;
  const perTask = plannedTasks > 0 && planned > 0 && planned % plannedTasks === 0 ? planned / plannedTasks : 0;
  if (!perTask) return `A sealed part is reported only against a plan of whole tasks, and this one gave ${planned} run(s) over ${plannedTasks} task(s): nothing of it is shown.`;
  if (plannedTasks < least && !dry) return `A sealed part is reported only for ${least} tasks or more, and this run planned ${plannedTasks}: nothing of it is shown.`;
  if (!shards || files.length !== shards) return `A sealed part is reported only when every shard left its counts, and ${files.length} of ${shards || "an unknown number of"} did: nothing of it is shown.`;
  if (files.some((f) => f.stoppedEarly || f.capReached)) return "A sealed part is reported only when no shard stopped early, and one did: nothing of it is shown.";
  if (runs !== planned) return `A sealed part is reported only when every planned run was counted, and ${runs} of ${planned} were: nothing of it is shown.`;
  if (runs / perTask < least && !dry) return `A sealed part is reported only for ${least} tasks or more counted: nothing of it is shown.`;
  return "";
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
  const d = counts.outcomesAllDeclined || o;
  const reachedD = counts.runs - d.blocked - d.lost;
  return {
    planned,
    ran: counts.runs,
    notRun: Math.max(0, planned - counts.runs),
    ...Object.fromEntries(OUTCOMES.map((k) => [k === "timed out" ? "timedOut" : k, o[k]])),
    strictRate: planned ? o.passed / planned : null,
    scoredRate: reached > 0 ? o.passed / reached : null,
    // The same run with every hold declined (outcomeAllDeclined).
    allDeclined: {
      ...Object.fromEntries(OUTCOMES.map((k) => [k === "timed out" ? "timedOut" : k, d[k]])),
      strictRate: planned ? d.passed / planned : null,
      scoredRate: reachedD > 0 ? d.passed / reachedD : null,
    },
    holds: { ...(counts.holds || { asked: 0, approved: 0, declined: 0, runsApproved: 0 }) },
    medianSecondsSolved: histMedian(counts.solvedSeconds),
    medianCallsSolved: histMedian(counts.solvedCalls),
    agentTokens: { ...counts.agentTokens, uncached: counts.agentTokens.prompt - counts.agentTokens.cached },
    judgeTokens: counts.judgeTokens,
    agentUSD: counts.agentUSD,
    judgeUSD: counts.judgeUSD,
    approverUSD: counts.approverUSD || 0,
    spendUSD: counts.agentUSD + counts.judgeUSD + (counts.approverUSD || 0),
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
  // Two scores of the same runs: with the simulated approver, and with every hold declined.
  const a = r.allDeclined;
  const h = r.holds || { asked: 0, approved: 0, declined: 0, runsApproved: 0 };
  if (a) {
    out.push("", "| scoring | passed | declined | strict rate | scored rate |", "| --- | --- | --- | --- | --- |");
    out.push(`| with the simulated approver | ${r.passed} | ${r.declined} | ${pct(r.strictRate)} | ${pct(r.scoredRate)} |`);
    out.push(`| every hold declined | ${a.passed} | ${a.declined} | ${pct(a.strictRate)} | ${pct(a.scoredRate)} |`, "");
    out.push(`Held steps put to the approver: ${h.asked}, of which ${h.approved} approved and ${h.declined} declined; ${h.runsApproved} run(s) had a hold approved. With every hold declined those runs count as failed.`);
  }
  out.push(`Per solved run: median ${r.medianSecondsSolved === null ? "-" : `${r.medianSecondsSolved} to ${r.medianSecondsSolved + SECONDS_BIN} s`}, median ${r.medianCallsSolved === null ? "-" : r.medianCallsSolved} model call(s).`);
  out.push(`Agent tokens: ${r.agentTokens.uncached} prompt uncached, ${r.agentTokens.cached} prompt cached, ${r.agentTokens.completion} output. Judge tokens: ${r.judgeTokens.input} input uncached, ${r.judgeTokens.cacheWrite} written to the cache, ${r.judgeTokens.cacheRead} read from it, ${r.judgeTokens.output} output.`);
  out.push(`Real spend: ${usd(r.spendUSD)} (agent ${usd(r.agentUSD)}, judge ${usd(r.judgeUSD)}, approver ${usd(r.approverUSD)})${meta.capUSD ? `, cap $${Number(meta.capUSD).toFixed(2)}` : ""}.`);
  // The never-send list: for dev, how many of its tasks; for a sealed part, the whole set's count only, which says nothing of where they were.
  if (Number.isFinite(meta.excluded)) out.push(`Excluded before the run: ${meta.excluded} task(s) ${meta.sealed ? "of the whole set" : "of this part"} on the never-send list (upstream issues 21, 25, 31 and 34), not run and not in the planned runs.`);
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

/**
 * The two keys a job derives from HOLDOUT_KEY, written to files in `dir`
 * (mode 600) and never printed: `split-digest`, the same in every run, keys
 * the split's digest; `sealed`, one per workflow run, encrypts what a sealed
 * shard or a census shard hands to the summary.
 */
function deriveKeys(dir, env = process.env) {
  const k = env.HOLDOUT_KEY || "";
  if (k.length < 16) throw new Error("HOLDOUT_KEY is not set: the split digest and the sealed counts are keyed from it.");
  const run = String(env.GITHUB_RUN_ID || "");
  if (!/^\d+$/.test(run)) throw new Error("GITHUB_RUN_ID is not set: the sealed key is one workflow run's.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mac = (label) => crypto.createHmac("sha256", k).update(label).digest("hex");
  fs.writeFileSync(path.join(dir, "split-digest"), mac("om2w-split-digest-v1"), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "sealed"), mac(`om2w-sealed-run-v1:${run}`), { mode: 0o600 });
}

async function main(argv) {
  const [cmd, target] = argv;
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
  if (cmd === "keys") {
    deriveKeys(flag("--out"));
    console.log("Keys derived for the split digest and this run's sealed files.");
    return;
  }
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
    const local = argv.includes("--no-holdout");
    if (!suites.holdout && !local) throw new Error("No plain holdout file: rule 2 needs it (the workflow decrypts it). --no-holdout splits without it, for a local look only.");
    const { devSites, sealedSites } = clashSites(suites);
    const { parts, siteParts, moved, excluded } = splitBySite(tasks, { devSites, sealedSites });
    const sites = (p) => [...siteParts.values()].filter((x) => x === p).length;
    const left = PARTS.reduce((n, p) => n + excluded[p], 0);
    console.log(`Split by site (seed ${CONFIG.split.seed}): ${PARTS.map((p) => `${p} ${parts[p].length} tasks on ${sites(p)} sites`).join(", ")}. Rule 1 moved ${moved.toDev} site(s) to dev, rule 2 moved ${moved.toSealed} to the sealed side. The never-send list left out ${left} task(s) of the whole set${part === "dev" ? `, ${excluded.dev} of them in dev` : ""}.`);
    // The digest: every job checks the map against the committed value. Only a local look (--no-holdout) skips it, and its split is not the workflow's.
    if (local) console.log("A local look without the holdout: the digest is not checked, and this split is not the workflow's.");
    else {
      const keyFile = flag("--digest-key-file");
      if (!keyFile) throw new Error("split needs --digest-key-file: every job checks the split against the committed digest.");
      const check = checkSplitDigest(splitDigest(siteParts, fs.readFileSync(keyFile, "utf8").trim()), { bootstrap: argv.includes("--bootstrap") });
      if (!check.ok) { console.error(`::error::${check.message}`); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${check.message}**\n`); process.exit(1); }
      console.log(check.bootstrap ? `::warning::${check.message}` : check.message);
      if (check.bootstrap && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${check.message}**\n`);
    }
    const chosen = part === "all" ? PARTS.flatMap((p) => parts[p].map((t) => ({ ...t, part: p }))) : parts[part].map((t) => ({ ...t, part }));
    fs.mkdirSync(path.dirname(flag("--out")), { recursive: true });
    fs.writeFileSync(flag("--out"), JSON.stringify(chosen), { mode: 0o600 });
    if (flag("--excluded-out")) fs.writeFileSync(flag("--excluded-out"), JSON.stringify({ all: left, dev: excluded.dev }));
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
    // A sealed part is reported only whole, as one group of enough tasks that no task's own result can be read from it.
    const plannedTasks = parseInt(flag("--planned-tasks") || "0", 10);
    const shards = parseInt(flag("--shards") || "0", 10);
    if (sealed) {
      const why = sealedWithheld({ files, counts, planned, plannedTasks, shards, least: CONFIG.split.sealedReportMinTasks });
      if (why) {
        console.log(why);
        fs.writeFileSync(path.join(target, "om2w-summary.json"), JSON.stringify({ part, sealed, withheld: why }, null, 2));
        process.exit(1);
      }
    }
    const r = report(counts, { planned });
    const first = files[0] || {};
    const problems = [];
    if (shards && files.length !== shards) problems.push(`${files.length} of ${shards} shard(s) left a counts file.`);
    if (flag("--arm") === "shipped") {
      if (files.some((f) => f.debuggerAvailable !== false)) problems.push("A shard's build has chrome.debugger, or did not say, in the shipped arm.");
      if (counts.realInputs) problems.push(`${counts.realInputs} real input event(s) in the shipped arm.`);
    }
    const excluded = flag("--excluded") === "" ? null : parseInt(flag("--excluded"), 10);
    const text = reportMarkdown(r, { part, sealed, dry: files.some((f) => f.dry), arm: flag("--arm"), agent: first.agent, tier: first.tier, judge: first.judge, revision: CONFIG.dataset.revision, commit: flag("--commit"), capUSD: files.reduce((a, f) => a + (f.capUSD || 0), 0), excluded, problems });
    console.log(text);
    fs.writeFileSync(path.join(target, "om2w-summary.json"), JSON.stringify({ part, sealed, report: r, problems }, null, 2));
    if (problems.length) process.exit(1);
    return;
  }
  throw new Error("Usage: om2w.js fetch --out <file> | split --dataset <file> --part <part> --out <file> | summary <dir> --part <part> --planned N [--census]");
}

module.exports = { CONFIG, PARTS, OUTCOMES, CENSUS_CLASSES, SECONDS_BIN, siteOfUrl, gitBlobSha1, checkDataset, om2wTasks, unitOf, partByCut, sealedCuts, partOfSite, neverSend, splitBySite, splitDigest, checkSplitDigest, deriveKeys, clashSites, engineWidgetSelectors, censusClass, outcomeOf, outcomeAllDeclined, approvalCounts, countsOf, emptyCounts, mergeCounts, sealedShardComplete, sealedWithheld, histMedian, report, reportMarkdown, censusReport, censusMarkdown, fetchDataset };

if (require.main === module) {
  // Every error here is ours and names no task, but a stack can hold a path: print the message only.
  main(process.argv.slice(2)).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}
