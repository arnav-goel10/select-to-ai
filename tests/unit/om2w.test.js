"use strict";
// Online-Mind2Web as a trial suite: the split by site, the census classifier,
// the counts a sealed part may write, the batch judge's hold on the spend cap,
// and the workflow that runs it. No browser and no network here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const O = require("../bench/om2w.js");
const T = require("../bench/trial.js");
const J = require("../bench/judge.js");
const { JudgeBatch } = require("../bench/judge-call.js");
const { findModelRates } = require("../../extension/defaults.js");

const ROOT = path.join(__dirname, "../..");

// A made-up dataset in Online-Mind2Web's own format: 300 tasks on 136 sites,
// 1 to 11 tasks a site, some on subdomains of one registrable domain.
function fakeDataset() {
  const out = [];
  let n = 0;
  for (let s = 0; s < 136; s++) {
    const per = s < 20 ? 6 + (s % 6) : s < 70 ? 2 : 1;
    for (let k = 0; k < per && out.length < 300; k++) out.push({ task_id: `id${String(n++).padStart(4, "0")}`, website: `https://${k % 2 ? "shop." : "www."}site${s}.example.com/`, confirmed_task: `Task ${n} on site ${s}`, level: ["easy", "medium", "hard"][n % 3], reference_length: 3 + (n % 12) });
  }
  while (out.length < 300) out.push({ task_id: `id${String(n++).padStart(4, "0")}`, website: `https://www.site${n % 70}.example.com/more`, confirmed_task: `Task ${n}`, level: "medium", reference_length: 7 });
  return out;
}
const siteOf = (u) => new URL(u).hostname.split(".").slice(-3).join(".");

test("the loader reads Online-Mind2Web's own fields, and the difficulty is kept apart from the family", () => {
  const tasks = O.om2wTasks([{ task_id: "a1b2_20251103", website: "https://www.example.com/", confirmed_task: "Find the opening hours", level: "hard", reference_length: 12 }, { task_id: "x", website: "not a url", confirmed_task: "y", level: "easy" }]);
  assert.deepEqual(tasks, [{ id: "a1b2_20251103", task: "Find the opening hours", url: "https://www.example.com/", level: "om2w", difficulty: "hard" }]);
  assert.ok(T.FAMILIES.om2w, "the family table knows the suite");
});

test("the split is by site: stable, no site in two parts, sizes near the targets", () => {
  const tasks = O.om2wTasks(fakeDataset());
  const a = O.splitBySite(tasks, { siteOf });
  const b = O.splitBySite([...tasks].reverse(), { siteOf });
  const ids = (s) => Object.fromEntries(O.PARTS.map((p) => [p, s.parts[p].map((t) => t.id).sort()]));
  assert.deepEqual(ids(a), ids(b), "the order of the file does not move a task");
  assert.deepEqual(ids(a), ids(O.splitBySite(tasks, { siteOf })), "the same input gives the same split");
  // Every task in exactly one part, every site in exactly one part.
  const all = O.PARTS.flatMap((p) => a.parts[p]);
  assert.equal(all.length, tasks.length);
  assert.equal(new Set(all.map((t) => t.id)).size, tasks.length);
  const partOfSite = new Map();
  for (const p of O.PARTS) for (const t of a.parts[p]) {
    const s = siteOf(t.url);
    assert.ok(!partOfSite.has(s) || partOfSite.get(s) === p, `${s} is in ${partOfSite.get(s)} and ${p}`);
    partOfSite.set(s, p);
  }
  // Sizes: within a site's worth of tasks of each target.
  for (const p of O.PARTS) assert.ok(Math.abs(a.parts[p].length - O.CONFIG.split.targets[p]) <= 12, `${p} has ${a.parts[p].length}`);
  // Another seed gives another split.
  assert.notDeepEqual(ids(a), ids(O.splitBySite(tasks, { siteOf, seed: "another" })));
});

test("the clash rules: a read suite's site goes to dev, a holdout site to the sealed side, and the holdout rule wins", () => {
  const tasks = O.om2wTasks(fakeDataset());
  const devSites = new Set(["site3.example.com", "site40.example.com", "site99.example.com"]);
  const sealedSites = new Set(["site5.example.com", "site99.example.com"]);
  const s = O.splitBySite(tasks, { siteOf, devSites, sealedSites });
  assert.equal(s.siteParts.get("site3.example.com"), "dev");
  assert.equal(s.siteParts.get("site40.example.com"), "dev");
  for (const site of sealedSites) assert.ok(O.CONFIG.split.sealedParts.includes(s.siteParts.get(site)), site);
  assert.deepEqual(s.moved, { toDev: 2, toSealed: 2 });
  // The rules come from the suites themselves: WebVoyager's sites and every open suite to dev, the holdout's to the sealed side.
  const c = O.clashSites({ everyday: [{ url: "https://en.wikipedia.org/wiki/X" }], holdout: [{ url: "https://www.sealed-site.example/", sites: ["https://other.example/"] }] }, (u) => new URL(u).hostname.replace(/^www\./, "").replace(/^en\./, ""));
  assert.ok(c.devSites.has("wikipedia.org") && c.devSites.has("github.com"));
  assert.ok(c.sealedSites.has("sealed-site.example") && c.sealedSites.has("other.example"));
  assert.ok(!c.devSites.has("sealed-site.example"));
});

test("the config pins the dataset revision, the seed, the cap and the policy, and commits no task", () => {
  const c = O.CONFIG;
  assert.match(c.dataset.revision, /^[0-9a-f]{40}$/);
  assert.match(c.dataset.gitBlobSha1, /^[0-9a-f]{40}$/);
  assert.ok(c.split.seed);
  assert.deepEqual(c.split.targets, { dev: 60, gate: 100, vault: 100, reserve: 40 });
  assert.equal(c.baseline.timeoutS, 600);
  assert.equal(c.baseline.allow, "site,address");
  assert.deepEqual(c.split.runnableParts, ["dev", "gate", "vault"]);
  // No task text and no task id anywhere in the repository's bench folder for this suite.
  const text = fs.readFileSync(path.join(ROOT, "tests/bench/om2w-config.json"), "utf8");
  assert.ok(!/task_id|confirmed_task/.test(text));
  assert.ok(!fs.readdirSync(path.join(ROOT, "tests/bench")).some((f) => /mind2web/i.test(f) && /\.json$/.test(f) && f !== "om2w-config.json"));
});

test("the fetched file must be the pinned one, by size and git blob hash", () => {
  // git hash-object of "hello\n"
  assert.equal(O.gitBlobSha1(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  const pinned = { size: 6, gitBlobSha1: "ce013625030ba8dba906f756967f9e9ca394464a" };
  assert.deepEqual(O.checkDataset(Buffer.from("hello\n"), pinned), []);
  const off = O.checkDataset(Buffer.from("hello!\n"), pinned);
  assert.equal(off.length, 2);
  assert.ok(!off.join(" ").includes("hello"), "a problem names nothing of the content");
});

test("the fetch needs HF_TOKEN and never prints it", async () => {
  await assert.rejects(O.fetchDataset(path.join(os.tmpdir(), "never.json"), {}), /HF_TOKEN is not set/);
  const real = globalThis.fetch;
  let header = "";
  globalThis.fetch = async (_url, init) => { header = init.headers.authorization; return { ok: false, status: 403 }; };
  try {
    await assert.rejects(O.fetchDataset(path.join(os.tmpdir(), "never.json"), { HF_TOKEN: "hf_secretvalue123" }), (e) => /HTTP 403/.test(e.message) && !e.message.includes("hf_secretvalue123"));
    assert.equal(header, "Bearer hf_secretvalue123", "the token goes in the header only");
  } finally { globalThis.fetch = real; }
});

test("the census classes a start page by the engine's own human-check detection", () => {
  const rich = "Welcome to the shop. ".repeat(200);
  const c = (o) => O.censusClass(o);
  assert.equal(c({ status: 200, title: "Shop", text: rich, elements: 20 }), "reachable");
  assert.equal(c({ status: 403, title: "Just a moment...", text: "Checking your browser", elements: 1 }), "blocked");
  assert.equal(c({ status: 200, title: "Shop", text: rich, elements: 20, widget: true }), "blocked");
  assert.equal(c({ status: 403, title: "Access Denied", text: "You don't have permission to access this server.", elements: 0 }), "blocked");
  assert.equal(c({ status: 429, title: "", text: "", elements: 0 }), "blocked");
  assert.equal(c({ status: 403, title: "Shop", text: rich, elements: 20 }), "error");
  assert.equal(c({ status: 404, title: "Not found", text: rich, elements: 20 }), "error");
  assert.equal(c({ navError: true, text: "" }), "error");
  assert.equal(c({ timedOut: true, text: "" }), "timeout");
  assert.equal(c({ timedOut: true, status: 200, title: "Slow", text: rich, elements: 20 }), "reachable");
  // The widget list is the build's own, read from its content script.
  const sel = O.engineWidgetSelectors(path.join(ROOT, "extension"));
  assert.ok(sel.length >= 5 && sel.some((s) => /recaptcha/.test(s)), sel.join(" "));
  assert.throws(() => O.engineWidgetSelectors(os.tmpdir()));
});

test("the census report names dev sites only and counts the sealed parts", () => {
  const r = O.censusReport([{ counts: { dev: { reachable: 2, blocked: 1, error: 0, timeout: 0 }, gate: { reachable: 5, blocked: 2, error: 1, timeout: 0 } }, devSites: [{ site: "open.example", class: "blocked", status: 403 }] }, { counts: { gate: { reachable: 1, blocked: 0, error: 0, timeout: 1 } }, devSites: [] }]);
  assert.deepEqual(r.byPart.gate, { reachable: 6, blocked: 2, error: 1, timeout: 1 });
  const md = O.censusMarkdown(r);
  assert.match(md, /\| gate \| 10 \| 6 \| 2 \| 1 \| 1 \| 20\.0% \|/);
  assert.match(md, /open\.example \| blocked \| 403/);
});

const row = (o) => ({ id: "t", task: "secret words", startUrl: "https://sealed.example/x", seconds: 50, calls: 4, modelCalls: [{ prompt: 1000, cached: 400, completion: 50 }], costUSD: 0.01, judgeCostUSD: 0.005, judgeUsage: { input: 900, cacheWrite: 0, cacheRead: 800, output: 100, calls: 1 }, ending: "finished", held: [], ...o });

test("outcomes: passed, failed, blocked, timed out, held, declined and lost, and the two rates", () => {
  const rows = [
    row({ success: true }),
    row({ success: true, seconds: 130, calls: 8 }),
    row({ success: false }),
    row({ success: false, blocked: true }),
    row({ success: false, ending: "timed out" }),
    row({ success: false, waitKind: "sign_in", ending: "asked the user" }),
    row({ success: false, held: [{ kind: "pay", allowed: false }], ending: "stopped at a confirmation (pay)" }),
    row({ success: false, ending: "harness error: browser gone" }),
  ];
  assert.deepEqual(rows.map(O.outcomeOf), ["passed", "passed", "failed", "blocked", "timed out", "held", "declined", "lost"]);
  const r = O.report(O.countsOf(rows), { planned: 10 });
  assert.deepEqual([r.passed, r.failed, r.blocked, r.timedOut, r.held, r.declined, r.lost, r.notRun], [2, 1, 1, 1, 1, 1, 1, 2]);
  assert.equal(r.strictRate, 2 / 10);
  assert.equal(r.scoredRate, 2 / 6);
  assert.equal(r.medianSecondsSolved, 50 - (50 % O.SECONDS_BIN));
  assert.equal(r.medianCallsSolved, 4);
  assert.deepEqual(r.agentTokens, { prompt: 8000, cached: 3200, completion: 400, uncached: 4800 });
  assert.equal(r.judgeTokens.cacheRead, 6400);
  assert.ok(Math.abs(r.spendUSD - 8 * 0.015) < 1e-9);
  const md = O.reportMarkdown(r, { part: "gate", sealed: true });
  for (const s of ["strict rate", "scored rate", "Real spend", "cached", "not comparable"]) assert.ok(md.includes(s), s);
});

test("a sealed part's counts and report hold no task id, text, address or order", () => {
  const rows = [row({ id: "taskAAA", success: true }), row({ id: "taskBBB", success: false })];
  const counts = O.countsOf(rows);
  const text = JSON.stringify(counts) + O.reportMarkdown(O.report(counts, { planned: 2 }), { part: "gate", sealed: true });
  assert.deepEqual(T.leaksIn(text, [{ id: "taskAAA", url: "https://sealed.example/x" }, { id: "taskBBB", url: "https://sealed.example/x" }]), []);
  assert.ok(!text.includes("secret words") && !text.includes("sealed.example"));
  // Merging shards adds up, and the histograms keep no order.
  const m = O.mergeCounts([counts, counts]);
  assert.equal(m.runs, 4);
  assert.deepEqual(m.solvedSeconds, { 50: 2 });
});

test("the summary reads counts files only, never a run's own file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-sum-"));
  try {
    fs.writeFileSync(path.join(dir, "om2w-counts-1of2.json"), JSON.stringify({ debuggerAvailable: false, counts: O.countsOf([row({ success: true })]) }));
    fs.writeFileSync(path.join(dir, "om2w-counts-2of2.json"), JSON.stringify({ debuggerAvailable: false, counts: O.countsOf([row({ success: false })]) }));
    fs.mkdirSync(path.join(dir, "x", "run1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "x", "run1", "run.json"), JSON.stringify({ id: "taskZZZ", task: "do not show me", success: true }));
    const r = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/om2w.js"), "summary", dir, "--part", "gate", "--planned", "4", "--arm", "shipped", "--shards", "2"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| 4 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \| 25\.0% \| 50\.0% \|/);
    assert.ok(!r.stdout.includes("taskZZZ") && !r.stdout.includes("do not show me"));
    const short = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/om2w.js"), "summary", dir, "--part", "gate", "--planned", "4", "--shards", "3"], { encoding: "utf8" });
    assert.equal(short.status, 1, "a shard that left no counts file fails the summary");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("run.js refuses a run with no files that is not sealed, and a batch judge with learning or recipes", () => {
  const go = (env) => spawnSync(process.execPath, [path.join(ROOT, "tests/bench/run.js")], { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 20000 });
  const a = go({ BENCH_NO_FILES: "1", BENCH_DRY: "1" });
  assert.equal(a.status, 1);
  assert.match(a.stderr, /BENCH_NO_FILES needs BENCH_QUIET=sealed/);
  const b = go({ BENCH_JUDGE_BATCH: "1", BENCH_LEARN: "on", BENCH_DRY: "1" });
  assert.equal(b.status, 1);
  assert.match(b.stderr, /batch judge takes no learning/);
  const c = go({ BENCH_JUDGE_BATCH: "1", BENCH_RECIPES: "1", BENCH_DRY: "1" });
  assert.equal(c.status, 1);
});

// A stand-in for the Message Batches endpoints: each batch ends at the first poll.
function fakeBatches(reply) {
  const batches = new Map();
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      sent.push(body);
      const id = `b${batches.size + 1}`;
      batches.set(id, body.requests);
      return { ok: true, status: 200, json: async () => ({ id, processing_status: "in_progress" }) };
    }
    const res = /\/batches\/(\w+)\/results$/.exec(u);
    if (res) return { ok: true, status: 200, text: async () => batches.get(res[1]).map((r, i) => JSON.stringify({ custom_id: r.custom_id, result: reply(r, i) })).join("\n") };
    const one = /\/batches\/(\w+)$/.exec(u);
    return { ok: true, status: 200, json: async () => ({ id: one[1], processing_status: "ended", results_url: `${u}/results` }) };
  };
  return { fetchImpl, sent };
}
const cfg = { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-5-5", key: "k", isAnthropic: true, vision: false, shots: 0 };
const judgedRun = { task: "t", startUrl: "https://a.example/", answer: "x", history: [], finalUrl: "https://a.example/", finalText: "x".repeat(2000) };
const ok = (usage) => ({ type: "succeeded", message: { content: [{ type: "text", text: '{"key_points":["x"],"met":[true],"success":true,"blocked":false,"reason":"ok"}' }], usage } });

test("the batch judge holds the most each verdict can cost until it is in, then counts what it cost at half price", async () => {
  const f = fakeBatches(() => ok({ input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800 }));
  const b = new JudgeBatch(cfg, { flushEvery: 2, pollMs: 0, ratesFor: findModelRates, fetchImpl: f.fetchImpl });
  const h1 = b.add("r1", judgedRun);
  assert.ok(h1 > 0);
  assert.equal(await b.tick().then((x) => x.length), 0, "one run waits for a second");
  assert.equal(f.sent.length, 0);
  b.add("r2", judgedRun);
  assert.ok(Math.abs(b.reservedUSD - 2 * h1) < 1e-12);
  const done = await b.tick();
  assert.equal(f.sent.length, 1);
  // The fixed instructions go in a one-hour cache block, and the custom ids name no task.
  assert.deepEqual(f.sent[0].requests[0].params.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(f.sent[0].requests.map((r) => r.custom_id), ["r1", "r2"]);
  assert.equal(done.length, 2);
  assert.equal(b.reservedUSD, 0, "the hold is released once the verdict is in");
  const usage = done[0].verdict.judgeUsage;
  assert.deepEqual([usage.input, usage.cacheRead, usage.output, usage.calls, usage.batch], [1200, 800, 300, 1, true]);
  const batchCost = T.judgeCostUSD(usage, findModelRates);
  const direct = T.judgeCostUSD({ ...usage, batch: false }, findModelRates);
  assert.ok(Math.abs(batchCost - direct / 2) < 1e-12);
  // The hold is never below the real price of the dearest reply: every input token written to the cache and every output token used.
  const params = f.sent[0].requests[0].params;
  const inTokens = Math.ceil(JSON.stringify(params.messages).length / 3) + Math.ceil(J.JUDGE_SYSTEM.length / 3);
  const worst = T.judgeCostUSD({ model: cfg.model, input: 0, cacheWrite: inTokens, cacheRead: 0, output: params.max_tokens, batch: true, cacheTtl: "1h" }, findModelRates);
  assert.ok(h1 >= worst, `hold ${h1} under the worst case ${worst}`);
});

test("the batch judge asks again once for an unreadable or errored request, then gives up as a judge failure", async () => {
  const f = fakeBatches((r) => (r.custom_id === "r1" ? { type: "errored", error: { type: "api_error" } } : { type: "succeeded", message: { content: [{ type: "text", text: "no verdict" }], usage: { input_tokens: 10, output_tokens: 5 } } }));
  const b = new JudgeBatch(cfg, { flushEvery: 1, pollMs: 0, ratesFor: findModelRates, fetchImpl: f.fetchImpl });
  b.add("r1", judgedRun);
  b.add("r2", judgedRun);
  const done = await b.drain(5000, 0);
  assert.equal(f.sent.length, 2, "one resend of both");
  assert.equal(done.length, 2);
  for (const d of done) assert.equal(d.verdict.judgeFailed, true);
  assert.equal(done.find((d) => d.id === "r2").verdict.judgeUsage.calls, 2);
  assert.equal(b.reservedUSD, 0);
  assert.ok(J.isInfra({ judgeFailed: true }), "a judge failure is counted as lost, never as a pass or a fail");
});

test("judge prices: cache writes, cache reads and the batch discount", () => {
  const [input, output] = findModelRates("claude-sonnet-5-5");
  const u = { model: "claude-sonnet-5-5", input: 1000, cacheWrite: 1000, cacheRead: 1000, output: 1000 };
  const want = (1000 * input + 1000 * input * 1.25 + 1000 * input * 0.05 + 1000 * output) / 1000;
  assert.ok(Math.abs(T.judgeCostUSD(u, findModelRates) - want) < 1e-12);
  assert.ok(Math.abs(T.judgeCostUSD({ ...u, batch: true, cacheTtl: "1h" }, findModelRates) - (want + 1000 * input * 0.75 / 1000) / 2) < 1e-12);
  // The old shape still prices as before.
  assert.ok(Math.abs(T.judgeCostUSD({ model: "claude-sonnet-5-5", input: 10, output: 10 }, findModelRates) - (10 * input + 10 * output) / 1000) < 1e-12);
});

const WF = () => fs.readFileSync(path.join(ROOT, ".github/workflows/om2w.yml"), "utf8");

test("the om2w workflow: its secrets, where each goes, and nothing of the task file in an upload", () => {
  const y = WF();
  const named = [...new Set([...y.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(named, ["ANTHROPIC_API_KEY", "HF_TOKEN", "HOLDOUT_KEY"]);
  // HF_TOKEN only reaches the fetch steps.
  for (const m of y.matchAll(/HF_TOKEN: \$\{\{ secrets\.HF_TOKEN \}\}\n\s+run: (.*)/g)) assert.match(m[1], /^node tests\/bench\/om2w\.js fetch --out "\$RUNNER_TEMP\/om2w\/dataset\.json"$/);
  assert.equal(y.split("secrets.HF_TOKEN }}").length - 1, y.split("om2w.js fetch --out").length - 1);
  // The task file and the split stay in the runner's temporary folder.
  for (const m of y.matchAll(/--out "([^"]+)"/g)) assert.match(m[1], /^\$RUNNER_TEMP\//);
  for (const m of y.matchAll(/^\s+path: (.+)$/gm)) assert.ok(!/RUNNER_TEMP|runner\.temp|dataset/.test(m[1]), m[1]);
  // A sealed part uploads its counts folder only, and writes no file of a run.
  assert.match(y, /BENCH_NO_FILES: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && '1' \|\| '' \}\}/);
  assert.match(y, /BENCH_QUIET: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 'sealed' \|\| '1' \}\}/);
  assert.match(y, /path: \$\{\{ needs\.plan\.outputs\.sealed == 'true' && 'tests\/bench\/out\/om2w-counts' \|\| 'tests\/bench\/out\/trial' \}\}/);
  assert.match(y, /node tests\/bench\/trial\.js leaks "\$RUNNER_TEMP\/om2w\/run\.log"/);
  // The baseline: batch judge, headful under xvfb, the cap per task from the config, a canary before a paid run.
  assert.match(y, /BENCH_JUDGE_BATCH: "1"/);
  assert.match(y, /xvfb-run -a/);
  assert.match(y, /BENCH_TIMEOUT_S: \$\{\{ needs\.plan\.outputs\.timeout_s \}\}/);
  assert.match(y, /needs: \[plan, build, canary\]/);
  assert.match(y, /needs\.canary\.result == 'success'/);
  for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
  assert.ok(!y.includes("\u2014"));
});

function plan(env) {
  const y = WF();
  const from = y.indexOf("        run: |\n", y.indexOf("name: Work out what to run")) + "        run: |\n".length;
  const script = y.slice(from, y.indexOf("\n\n", from)).split("\n").map((l) => l.slice(10)).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-plan-"));
  const out = path.join(dir, "out");
  const summary = path.join(dir, "summary");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: ROOT, env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, EVENT: "workflow_dispatch", IN_DRY: "false", HAS_ANTHROPIC_KEY: "true", HAS_HF_TOKEN: "true", ...env }, encoding: "utf8" });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const res = { status: r.status, said: `${r.stdout}${r.stderr}${read(summary)}`, outputs: Object.fromEntries(read(out).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test("the om2w plan step: the baseline by default, the reserve never, and no real run without its secrets", { skip: process.platform === "win32" }, () => {
  const census = plan({});
  assert.equal(census.status, 0, census.said);
  assert.deepEqual([census.outputs.mode, census.outputs.part, census.outputs.model, census.outputs.judge_model, census.outputs.timeout_s], ["census", "dev", "claude-haiku-5-5", "claude-sonnet-5-5", "600"]);
  const gate = plan({ IN_MODE: "run", IN_PART: "gate", IN_RUNS: "2", IN_SHARDS: "16", IN_MAX_USD: "40" });
  assert.equal(gate.status, 0, gate.said);
  assert.deepEqual([gate.outputs.sealed, gate.outputs.shard_count, gate.outputs.cap_per_shard], ["true", "16", "2.5000"]);
  for (const env of [{ IN_PART: "reserve" }, { IN_MODE: "run", HAS_ANTHROPIC_KEY: "false" }, { HAS_HF_TOKEN: "false" }, { IN_MODEL: "gpt-5.4-mini" }, { IN_MODEL: "claude-sonnet-5-5" }, { IN_PART: "vault", IN_LIMIT: "2" }, { IN_MAX_USD: "0" }, { IN_SHARDS: "21" }]) {
    const r = plan(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.outputs.dry, undefined);
  }
  // The census needs no model key; a push is dry and needs nothing.
  assert.equal(plan({ HAS_ANTHROPIC_KEY: "false" }).status, 0);
  const push = plan({ EVENT: "push", HAS_ANTHROPIC_KEY: "false", HAS_HF_TOKEN: "false" });
  assert.deepEqual([push.status, push.outputs.dry], [0, "true"]);
});

test("the canary is three fixture tasks, and a real trial run waits for it", () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/bench/fixture-canary-tasks.json"), "utf8"));
  assert.equal(list.length, 3);
  assert.deepEqual(T.validateTasks(list), []);
  assert.ok(list.every((t) => t.level === "fixture" && t.dry));
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/real-tasks.yml"), "utf8");
  assert.match(y, /needs: \[plan, build, canary\]/);
  assert.match(y, /needs\.canary\.result == 'success' \|\| \(needs\.canary\.result == 'skipped' && needs\.plan\.outputs\.dry == 'true'\)/);
});
