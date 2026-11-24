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
const { JudgeBatch, waitForHolds } = require("../bench/judge-call.js");
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
  // Each site falls by its own hash, so the share of sites in each part is near its cut's width.
  let prev = 0;
  const nSites = a.siteParts.size;
  for (const [p, cut] of O.CONFIG.split.cuts) {
    const share = [...a.siteParts.values()].filter((x) => x === p).length / nSites;
    assert.ok(Math.abs(share - (cut - prev)) < 0.12, `${p} has ${share} of the sites against ${cut - prev}`);
    prev = cut;
  }
  // The cuts rise to 1 and their widths are the targets' shares.
  assert.equal(O.CONFIG.split.cuts.at(-1)[1], 1);
  for (const [p, cut] of O.CONFIG.split.cuts) {
    const upTo = O.CONFIG.split.cuts.slice(0, O.CONFIG.split.cuts.findIndex((c) => c[0] === p) + 1).reduce((n, [q]) => n + O.CONFIG.split.targets[q], 0);
    assert.ok(Math.abs(cut - upTo / 300) < 0.001, p);
  }
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
  // Moved: the clash sites whose own hash had put them elsewhere.
  const byHash = O.splitBySite(tasks, { siteOf });
  assert.equal(s.moved.toDev, ["site3.example.com", "site40.example.com"].filter((x) => byHash.siteParts.get(x) !== "dev").length);
  assert.equal(s.moved.toSealed, [...sealedSites].filter((x) => !O.CONFIG.split.sealedParts.includes(byHash.siteParts.get(x))).length);
  // The rules come from the suites themselves: WebVoyager's sites and every open suite to dev, the holdout's to the sealed side.
  const c = O.clashSites({ everyday: [{ url: "https://en.wikipedia.org/wiki/X" }], holdout: [{ url: "https://www.sealed-site.example/", sites: ["https://other.example/"] }] }, (u) => new URL(u).hostname.replace(/^www\./, "").replace(/^en\./, ""));
  assert.ok(c.devSites.has("wikipedia.org") && c.devSites.has("github.com"));
  assert.ok(c.sealedSites.has("sealed-site.example") && c.sealedSites.has("other.example"));
  assert.ok(!c.devSites.has("sealed-site.example"));
});

test("no site's part depends on another site or on another task file: one site added, one task dropped, a read suite edited, nothing else moves", () => {
  const tasks = O.om2wTasks(fakeDataset());
  const base = O.splitBySite(tasks, { siteOf }).siteParts;
  const same = (a, b, except = new Set()) => {
    const moved = [...a.keys()].filter((k) => !except.has(k) && b.has(k) && a.get(k) !== b.get(k));
    assert.deepEqual(moved, []);
  };
  // A site more in the dataset.
  const more = O.splitBySite([...tasks, ...O.om2wTasks([{ task_id: "new1", website: "https://www.brand-new.example.com/", confirmed_task: "x", level: "easy" }])], { siteOf }).siteParts;
  same(base, more);
  // A task fewer: its site keeps its part, and so does every other.
  same(base, O.splitBySite(tasks.slice(1), { siteOf }).siteParts);
  // A read suite starts using one site (rule 1): that site alone moves, to dev.
  const edited = O.splitBySite(tasks, { siteOf, devSites: new Set(["site7.example.com"]) }).siteParts;
  same(base, edited, new Set(["site7.example.com"]));
  assert.equal(edited.get("site7.example.com"), "dev");
  // A site's part is a function of the seed and the site alone.
  for (const [site, part] of base) assert.equal(O.partOfSite(site).part, part);
});

test("the split is pinned by a keyed digest: the same map passes, a moved site fails loudly, and the bootstrap is one-time", () => {
  const tasks = O.om2wTasks(fakeDataset());
  const key = "k".repeat(64);
  const map = O.splitBySite(tasks, { siteOf }).siteParts;
  const d = O.splitDigest(map, key);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(O.splitDigest(new Map([...map].reverse()), key), d, "the order of the map does not change the digest");
  assert.notEqual(O.splitDigest(map, "j".repeat(64)), d, "keyed: another key, another digest");
  assert.throws(() => O.splitDigest(map, "short"));
  // The digest names no site.
  for (const site of map.keys()) assert.ok(!d.includes(site));
  // One site moved by a read-suite edit: refused.
  const moved = O.splitDigest(O.splitBySite(tasks, { siteOf, devSites: new Set(["site7.example.com"]) }).siteParts, key);
  assert.notEqual(moved, d);
  assert.equal(O.checkSplitDigest(d, { committed: d }).ok, true);
  const off = O.checkSplitDigest(moved, { committed: d });
  assert.equal(off.ok, false);
  assert.match(off.message, /not the committed one/);
  // Bootstrap: allowed only while nothing is committed, and it says so loudly; refused once a value is committed.
  const boot = O.checkSplitDigest(d, { committed: "", bootstrap: true });
  assert.deepEqual([boot.ok, boot.bootstrap], [true, true]);
  assert.match(boot.message, /^BOOTSTRAP/);
  assert.ok(boot.message.includes(d), "it prints the value to commit");
  assert.equal(O.checkSplitDigest(d, { committed: "", bootstrap: false }).ok, false, "not committed and no bootstrap: refused");
  assert.equal(O.checkSplitDigest(d, { committed: d, bootstrap: true }).ok, false, "committed: bootstrap refused even when the digest matches");
  // The command checks it: no key file, a wrong digest or no bootstrap all stop it before it writes the tasks.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-dig-"));
  try {
    fs.writeFileSync(path.join(dir, "ds.json"), JSON.stringify(fakeDataset()));
    fs.writeFileSync(path.join(dir, "key"), key);
    const go = (...extra) => spawnSync(process.execPath, [path.join(ROOT, "tests/bench/om2w.js"), "split", "--dataset", path.join(dir, "ds.json"), "--part", "dev", "--out", path.join(dir, "out.json"), ...extra], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const holdout = path.join(ROOT, "tests/bench/holdout-tasks.json");
    if (!fs.existsSync(holdout)) {
      const r = go("--digest-key-file", path.join(dir, "key"));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /No plain holdout file/);
    }
    const local = go("--no-holdout");
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /the digest is not checked/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Every job derives the digest key and the sealed key from HOLDOUT_KEY into files, and prints neither.
  const kdir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-keys-"));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "tests/bench/om2w.js"), "keys", "--out", kdir], { encoding: "utf8", env: { PATH: process.env.PATH, HOLDOUT_KEY: "holdout-key-for-a-test-0123456789", GITHUB_RUN_ID: "42" } });
    assert.equal(r.status, 0, r.stderr);
    const dk = fs.readFileSync(path.join(kdir, "split-digest"), "utf8");
    const sk = fs.readFileSync(path.join(kdir, "sealed"), "utf8");
    assert.match(dk, /^[0-9a-f]{64}$/);
    assert.notEqual(dk, sk);
    assert.ok(!r.stdout.includes(dk) && !r.stdout.includes(sk) && !r.stdout.includes("holdout-key-for-a-test"));
    O.deriveKeys(kdir, { HOLDOUT_KEY: "holdout-key-for-a-test-0123456789", GITHUB_RUN_ID: "43" });
    assert.equal(fs.readFileSync(path.join(kdir, "split-digest"), "utf8"), dk, "the digest key is the same in every run");
    assert.notEqual(fs.readFileSync(path.join(kdir, "sealed"), "utf8"), sk, "the sealed key is one run's");
    assert.throws(() => O.deriveKeys(kdir, { GITHUB_RUN_ID: "1" }), /HOLDOUT_KEY/);
  } finally { fs.rmSync(kdir, { recursive: true, force: true }); }
});

test("the never-send list: the tasks of upstream issues 21, 25, 31 and 34 by id, left out of every part and counted", () => {
  const ids = O.CONFIG.neverSend.ids;
  assert.equal(ids.length, 5);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(O.CONFIG.neverSend.issues.map((u) => Number(u.split("/").pop())), [21, 25, 31, 34]);
  const list = fakeDataset();
  // Two of them in the made-up set, one with a dated suffix as the current file carries it.
  list[0].task_id = ids[0];
  list[5].task_id = `${ids[4]}_070826`;
  const tasks = O.om2wTasks(list);
  const s = O.splitBySite(tasks, { siteOf });
  const all = O.PARTS.flatMap((p) => s.parts[p]);
  assert.equal(all.length, tasks.length - 2);
  assert.ok(!all.some((t) => O.neverSend(t)));
  assert.equal(O.PARTS.reduce((n, p) => n + s.excluded[p], 0), 2);
  // Their sites stay in the map, so leaving them out moves no site.
  assert.deepEqual([...s.siteParts], [...O.splitBySite(O.om2wTasks(fakeDataset()), { siteOf }).siteParts]);
  // The report says how many were left out.
  const md = O.reportMarkdown(O.report(O.emptyCounts(), { planned: 0 }), { part: "dev", excluded: 2 });
  assert.match(md, /Excluded before the run: 2 task\(s\) of this part on the never-send list/);
  assert.match(O.reportMarkdown(O.report(O.emptyCounts(), { planned: 0 }), { part: "gate", sealed: true, excluded: 5 }), /5 task\(s\) of the whole set/);
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
    const sum = (...a) => spawnSync(process.execPath, [path.join(ROOT, "tests/bench/om2w.js"), "summary", dir, ...a], { encoding: "utf8" });
    // Dev: a part of a plan is reported, with what did not run counted as such.
    const r = sum("--part", "dev", "--planned", "20", "--planned-tasks", "10", "--arm", "shipped", "--shards", "2");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| 20 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 18 \| 5\.0% \| 50\.0% \|/);
    assert.ok(!r.stdout.includes("taskZZZ") && !r.stdout.includes("do not show me"));
    const short = sum("--part", "dev", "--planned", "20", "--planned-tasks", "10", "--shards", "3");
    assert.equal(short.status, 1, "a shard that left no counts file fails the summary");
    // Sealed: the same two runs under a plan of 20 are withheld whole, a missing shard too.
    for (const shards of ["2", "3"]) {
      const g = sum("--part", "gate", "--planned", "20", "--planned-tasks", "10", "--shards", shards);
      assert.equal(g.status, 1, shards);
      assert.ok(!/\| \d+ \| \d+ \|/.test(g.stdout), g.stdout);
    }
    // A sealed part of fewer than the minimum tasks is never reported, whatever the limit and the shards.
    for (const n of ["1", "3", "9", ""]) {
      const few = sum("--part", "gate", "--planned", "4", "--planned-tasks", n, "--shards", "2");
      assert.equal(few.status, 1, n);
      assert.ok(!/passed|\| \d+ \| \d+ \|/.test(few.stdout), few.stdout);
      assert.ok(!fs.readFileSync(path.join(dir, "om2w-summary.json"), "utf8").includes("outcomes"));
    }
    // Dev has no minimum.
    assert.equal(sum("--part", "dev", "--planned", "2", "--planned-tasks", "1", "--shards", "2").status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A sealed shard's counts file as run.js writes it, holding `n` runs.
function sealedCountsDir(shardRuns, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-seal-"));
  shardRuns.forEach((n, i) => {
    const rows = Array.from({ length: n }, (_, k) => row({ success: k % 3 === 0 }));
    fs.writeFileSync(path.join(dir, `om2w-counts-${i + 1}of${shardRuns.length}.json`), JSON.stringify({ debuggerAvailable: false, capUSD: 1, spentUSD: 0.1, capReached: false, stoppedEarly: false, ...extra, counts: O.countsOf(rows) }));
  });
  return dir;
}
const sealedSum = (dir, ...a) => spawnSync(process.execPath, [path.join(ROOT, "tests/bench/om2w.js"), "summary", dir, "--part", "gate", ...a], { encoding: "utf8" });
const showsNumbers = (out) => /\| \d+ \| \d+ \|/.test(out) || /passed \d|scored rate|median/i.test(out);

test("the reviewer's case: one run counted under a sealed plan of 10 is withheld, with a non-zero exit", () => {
  const dir = sealedCountsDir([1], { capReached: true, stoppedEarly: true });
  try {
    const r = sealedSum(dir, "--planned", "10", "--planned-tasks", "10", "--shards", "1", "--arm", "shipped");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /nothing of it is shown/);
    assert.ok(!showsNumbers(r.stdout), r.stdout);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "om2w-summary.json"), "utf8"));
    assert.ok(saved.withheld && !("report" in saved));
    // The same run without the cap flags is still withheld: the runs counted, not the flags, decide.
    fs.writeFileSync(path.join(dir, "om2w-counts-1of1.json"), JSON.stringify({ debuggerAvailable: false, counts: O.countsOf([row({ success: true })]) }));
    const r2 = sealedSum(dir, "--planned", "10", "--planned-tasks", "10", "--shards", "1");
    assert.equal(r2.status, 1);
    assert.ok(!showsNumbers(r2.stdout), r2.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sealed runs with a rising cap cannot be differenced: nothing is shown until every planned run is counted", () => {
  // A cap raised a step at a time stops the shards after 1, 2, ... runs. Every one of those is withheld
  // with the same words, so no two outputs differ by one task. Only the whole part is reported.
  const said = new Set();
  for (let k = 1; k < 12; k++) {
    const dir = sealedCountsDir([Math.ceil(k / 2), Math.floor(k / 2)]);
    try {
      const r = sealedSum(dir, "--planned", "12", "--planned-tasks", "12", "--shards", "2");
      assert.equal(r.status, 1, `${k} run(s)`);
      assert.ok(!showsNumbers(r.stdout), r.stdout);
      said.add(r.stdout.replace(/\d+ of 12/, "N of 12"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  assert.equal(said.size, 1, [...said].join("\n"));
  const whole = sealedCountsDir([6, 6]);
  try {
    const r = sealedSum(whole, "--planned", "12", "--planned-tasks", "12", "--shards", "2", "--arm", "shipped");
    assert.equal(r.status, 0, r.stdout);
    assert.ok(showsNumbers(r.stdout));
  } finally { fs.rmSync(whole, { recursive: true, force: true }); }
  // Every planned run counted, but a shard says it stopped early: withheld.
  const flagged = sealedCountsDir([6, 6], { stoppedEarly: true });
  try { assert.equal(sealedSum(flagged, "--planned", "12", "--planned-tasks", "12", "--shards", "2").status, 1); } finally { fs.rmSync(flagged, { recursive: true, force: true }); }
  // The helpers, directly: more runs than planned, a plan of part tasks, and the minimum on the runs counted.
  const C = (n) => ({ runs: n });
  const f = (n) => Array.from({ length: n }, () => ({}));
  assert.equal(O.sealedWithheld({ files: f(1), counts: C(10), planned: 10, plannedTasks: 10, shards: 1, least: 10 }), "");
  assert.notEqual(O.sealedWithheld({ files: f(1), counts: C(11), planned: 10, plannedTasks: 10, shards: 1, least: 10 }), "");
  assert.notEqual(O.sealedWithheld({ files: f(1), counts: C(9), planned: 9, plannedTasks: 9, shards: 1, least: 10 }), "");
  assert.notEqual(O.sealedWithheld({ files: f(1), counts: C(15), planned: 15, plannedTasks: 10, shards: 1, least: 10 }), "");
  assert.notEqual(O.sealedWithheld({ files: f(1), counts: C(10), planned: 10, plannedTasks: 10, shards: 0, least: 10 }), "");
  // A dry run on the fixture pages is let off the minimum size only, never the whole-plan rule.
  assert.equal(O.sealedWithheld({ files: [{ dry: true }], counts: C(7), planned: 7, plannedTasks: 7, shards: 1, least: 10 }), "");
  assert.notEqual(O.sealedWithheld({ files: [{ dry: true }], counts: C(6), planned: 7, plannedTasks: 7, shards: 1, least: 10 }), "");
});

test("a sealed shard that did not finish every run writes no counts, and a sealed part runs whole", () => {
  assert.equal(O.sealedShardComplete(Array(10).fill({}), 10), true);
  for (const n of [0, 1, 4, 9, 11]) assert.equal(O.sealedShardComplete(Array(n).fill({}), 10), false, String(n));
  assert.equal(O.sealedShardComplete([], 0), false);
  // run.js asks it before it writes the counts, and fails the shard when it says no.
  const src = fs.readFileSync(path.join(ROOT, "tests/bench/run.js"), "utf8");
  assert.match(src, /const sealedUnfinished = NO_FILES && !OM2W\.sealedShardComplete\(rows, tasks\.length \* RUNS\);/);
  assert.match(src, /if \(COUNTS_OUT && !sealedUnfinished\) \{/);
  assert.match(src, /if \(sealedUnfinished\) process\.exitCode = 1;/);
  // A sample or a pick of a sealed part is refused before anything runs.
  const go = (env) => spawnSync(process.execPath, [path.join(ROOT, "tests/bench/run.js")], { encoding: "utf8", env: { PATH: process.env.PATH, BENCH_DRY: "1", BENCH_QUIET: "sealed", BENCH_NO_FILES: "1", BENCH_TASKS: path.join(ROOT, "tests/bench/fixture-tasks.json"), BENCH_OUT: path.join(os.tmpdir(), "om2w-never"), ...env }, timeout: 20000 });
  for (const env of [{ BENCH_SAMPLE: "10" }, { BENCH_SAMPLE: "11" }, { BENCH_ONLY: "a,b,c,d,e" }]) {
    const r = go(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.stderr, /A sealed part runs whole/);
  }
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
  // A cap that rounds to nothing is an error, never "no cap".
  for (const cap of ["0", "0.0000", "-1", "ten"]) {
    const z = go({ BENCH_MAX_USD: cap, BENCH_DRY: "1" });
    assert.equal(z.status, 1, cap);
    assert.match(z.stderr, /BENCH_MAX_USD is set but is not an amount above 0/);
  }
  // A sealed shard of too few tasks is refused before anything runs, and says so past the sealed filter.
  const few = go({ BENCH_DRY: "1", BENCH_QUIET: "sealed", BENCH_NO_FILES: "1", BENCH_TASKS: path.join(ROOT, "tests/bench/fixture-canary-tasks.json"), BENCH_OUT: path.join(os.tmpdir(), "om2w-never") });
  assert.equal(few.status, 1);
  assert.match(few.stderr, /A sealed shard needs 5 tasks or more and this one has 3/);
});

test("a capped shard waits for the verdicts still out before it decides it is over the cap", () => {
  // The reviewer's case: $10 over 12 shards, about $0.11 held per verdict still out.
  const cap = 10 / 12;
  assert.equal(waitForHolds({ capUSD: cap, committedUSD: 0.4 + 4 * 0.11, needUSD: 0.06, waiting: 4 }), true, "holds alone would stop it: wait");
  assert.equal(waitForHolds({ capUSD: cap, committedUSD: 0.2, needUSD: 0.06, waiting: 1 }), false, "room enough: no wait");
  assert.equal(waitForHolds({ capUSD: cap, committedUSD: 0.5, needUSD: 0.06, runRoomUSD: 0.3, waiting: 2 }), true, "a run would start cramped: wait");
  assert.equal(waitForHolds({ capUSD: cap, committedUSD: 0.9, needUSD: 0, waiting: 0 }), false, "nothing out: nothing to wait for, the cap decides");
  assert.equal(waitForHolds({ capUSD: 0, committedUSD: 5, waiting: 3 }), false, "no cap: no wait");
  // run.js asks before every run and before a verdict that would not fit.
  const src = fs.readFileSync(path.join(ROOT, "tests/bench/run.js"), "utf8");
  assert.match(src, /await settleHolds\(carried \+ judgeRoom \+ approverRoom\);\n\s+if \(MAX_USD && committed\(\) \+ carried >= MAX_USD\)/);
  assert.match(src, /committed\(\) \+ hold > MAX_USD && batch\.waiting\) for \(const x of await batch\.drain/);
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
  // The hold is never below the real price of the dearest reply: the fixed instructions (the only part with a cache mark)
  // written to the cache, the run's own content at the input price, every output token used.
  const params = f.sent[0].requests[0].params;
  assert.ok(params.messages.every((m) => (Array.isArray(m.content) ? m.content : []).every((part) => !part.cache_control)), "only the fixed instructions can be cached");
  const runTokens = Math.ceil(JSON.stringify(params.messages).length / 3);
  const sysTokens = Math.ceil(J.JUDGE_SYSTEM.length / 3);
  const worst = T.judgeCostUSD({ model: cfg.model, input: runTokens, cacheWrite: sysTokens, cacheRead: 0, output: params.max_tokens, batch: true, cacheTtl: "1h" }, findModelRates);
  assert.ok(h1 >= worst, `hold ${h1} under the worst case ${worst}`);
  // And not far above it: a hold the size of several real verdicts would stop a small shard for nothing.
  assert.ok(h1 < 2.5 * worst, `hold ${h1} is more than 2.5 times the worst case ${worst}`);
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
  assert.deepEqual(named, ["ANTHROPIC_API_KEY", "HF_TOKEN", "HOLDOUT_KEY", "OM2W_DEV_KEY"]);
  // HF_TOKEN only reaches the fetch steps.
  for (const m of y.matchAll(/HF_TOKEN: \$\{\{ secrets\.HF_TOKEN \}\}\n\s+run: (.*)/g)) assert.match(m[1], /^node tests\/bench\/om2w\.js fetch --out "\$RUNNER_TEMP\/om2w\/dataset\.json"$/);
  assert.equal(y.split("secrets.HF_TOKEN }}").length - 1, y.split("om2w.js fetch --out").length - 1);
  // OM2W_DEV_KEY only where dev files are encrypted or opened, and only for dev.
  const dev = [...y.matchAll(/OM2W_DEV_KEY: \$\{\{ (.+) \}\}/g)].map((m) => m[1]);
  assert.deepEqual(dev, ["needs.plan.outputs.part == 'dev' && secrets.OM2W_DEV_KEY || ''", "needs.plan.outputs.mode == 'run' && needs.plan.outputs.part == 'dev' && secrets.OM2W_DEV_KEY || ''"]);
  // The task file and the split stay in the runner's temporary folder.
  for (const m of y.matchAll(/--out "([^"]+)"/g)) assert.match(m[1], /^\$RUNNER_TEMP\//);
  for (const m of y.matchAll(/^\s+path: (.+)$/gm)) assert.ok(!/RUNNER_TEMP|runner\.temp|dataset/.test(m[1]), m[1]);
  // Every upload of a real job is a folder that holds only encrypted files and counts.
  const uploads = [...y.matchAll(/uses: actions\/upload-artifact@\S+[^\n]*\n(?:\s+(?:if|with|name):[^\n]*\n)*\s+path: (.+)\n/g)].map((m) => m[1].trim());
  assert.equal(uploads.length, y.split("uses: actions/upload-artifact@").length - 1, "every upload's path was found");
  for (const u of uploads) assert.ok(["tests/bench/out/upload", "tests/bench/out/om2w", "dist/${{ steps.meta.outputs.artifact }}", "tests/bench/out/leg"].includes(u), u);
  assert.match(y, /om2w-crypt\.sh seal "\$RUNNER_TEMP\/om2w\/counts" "\$up\/om2w-sealed-shard-\$SHARD\.tar\.gz\.enc"/);
  assert.match(y, /om2w-crypt\.sh seal "\$RUNNER_TEMP\/om2w\/dev" "\$up\/om2w-dev-shard-\$SHARD\.tar\.gz\.enc"/);
  assert.match(y, /om2w-crypt\.sh seal "\$RUNNER_TEMP\/om2w\/census" "\$up\/om2w-sealed-census-shard-\$SHARD\.tar\.gz\.enc"/);
  assert.match(y, /om2w-crypt\.sh seal "\$RUNNER_TEMP\/om2w\/devsum" "\$out\/om2w-dev-summary\.tar\.gz\.enc"/);
  // Every file of a run is written to the runner's temporary folder, and a sealed part writes none.
  assert.match(y, /BENCH_OUT: \$\{\{ needs\.plan\.outputs\.part != 'dev' && format\('\{0\}\/om2w\/out', runner\.temp\) \|\| format\('\{0\}\/om2w\/dev', runner\.temp\) \}\}/);
  assert.match(y, /BENCH_NO_FILES: \$\{\{ needs\.plan\.outputs\.part != 'dev' && '1' \|\| '' \}\}/);
  assert.match(y, /BENCH_QUIET: sealed\n/);
  assert.match(y, /node tests\/bench\/trial\.js leaks "\$RUNNER_TEMP\/om2w\/run\.log"/);
  // Sealed is worked out from the part (anything but exactly dev), never read from an output of its own.
  assert.ok(!/outputs\.sealed\b/.test(y), "no job trusts a separate sealed output");
  assert.ok(!/^\s+echo "sealed=/m.test(y));
  for (const m of y.matchAll(/needs\.plan\.outputs\.part (==|!=) 'dev'/g)) assert.ok(m);
  // Every split checks the digest; the bootstrap flag only comes from the plan's own output.
  for (const m of y.matchAll(/om2w\.js split (.*)/g)) assert.match(m[1], /--digest-key-file "\$RUNNER_TEMP\/om2w\/keys\/split-digest"/);
  assert.match(y, /BOOTSTRAP: \$\{\{ needs\.plan\.outputs\.bootstrap == 'true' && '--bootstrap' \|\| '' \}\}/);
  // HOLDOUT_KEY reaches the decrypt steps only, which also derive the digest key and the sealed key into files.
  for (const m of y.matchAll(/HOLDOUT_KEY: \$\{\{ secrets\.HOLDOUT_KEY \}\}\n\s+run: \|\n((?:\s{10}.*\n){3})/g)) assert.match(m[1], /om2w\.js keys --out "\$RUNNER_TEMP\/om2w\/keys"/);
  // The baseline: batch judge, headful under xvfb, the cap per task from the config, a canary before a paid run.
  assert.match(y, /BENCH_JUDGE_BATCH: "1"/);
  assert.match(y, /BENCH_RUN_ROOM_USD: \$\{\{ needs\.plan\.outputs\.run_room \}\}/);
  assert.match(y, /BENCH_SEALED_MIN_TASKS: \$\{\{ needs\.plan\.outputs\.sealed_min \}\}/);
  assert.match(y, /xvfb-run -a/);
  assert.match(y, /BENCH_TIMEOUT_S: \$\{\{ needs\.plan\.outputs\.timeout_s \}\}/);
  assert.match(y, /needs: \[plan, build, canary\]/);
  assert.match(y, /needs\.canary\.result == 'success'/);
  for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
  assert.ok(!y.includes("\u2014"));
});

test("the hand-over files are AES-256 with a key from the passphrase, open again whole, and are not readable without it", { skip: process.platform === "win32" || spawnSync("openssl", ["version"]).status !== 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-crypt-"));
  const sh = path.join(ROOT, "tests/bench/om2w-crypt.sh");
  try {
    fs.mkdirSync(path.join(dir, "in", "t1", "run1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "in", "t1", "run1", "run.json"), JSON.stringify({ task: "a gated task's words", reason: "the judge's reasons" }));
    const pass = "p".repeat(40);
    const go = (args, env) => spawnSync("bash", [sh, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    assert.equal(go(["seal", path.join(dir, "in"), path.join(dir, "x.tar.gz.enc")], { OM2W_PASS: pass }).status, 0);
    const bytes = fs.readFileSync(path.join(dir, "x.tar.gz.enc"));
    assert.equal(bytes.subarray(0, 8).toString("latin1"), "Salted__");
    assert.ok(!bytes.toString("latin1").includes("gated task") && !bytes.toString("latin1").includes("run.json"));
    const open = go(["open", path.join(dir, "x.tar.gz.enc"), path.join(dir, "out")], { OM2W_PASS: pass });
    assert.equal(open.status, 0, open.stderr);
    assert.equal(fs.readFileSync(path.join(dir, "out", "t1", "run1", "run.json"), "utf8"), fs.readFileSync(path.join(dir, "in", "t1", "run1", "run.json"), "utf8"));
    assert.notEqual(go(["open", path.join(dir, "x.tar.gz.enc"), path.join(dir, "out2")], { OM2W_PASS: "q".repeat(40) }).status, 0, "another key opens nothing");
    // No passphrase, or a short one: refused, and the passphrase is never printed.
    assert.equal(go(["seal", path.join(dir, "in"), path.join(dir, "y.enc")], {}).status, 1);
    const short = go(["seal", path.join(dir, "in"), path.join(dir, "y.enc")], { OM2W_PASS: "short" });
    assert.equal(short.status, 1);
    assert.ok(!`${short.stdout}${short.stderr}`.includes("short\n"));
    // The local script downloads with gh and opens into bench-results with the key file; it prints no key.
    const local = fs.readFileSync(path.join(ROOT, "scripts/om2w-dev-results.sh"), "utf8");
    assert.match(local, /\.config\/select-to-ai\/om2w-dev\.key/);
    assert.match(local, /Documents\/select-to-ai-v3\/bench-results/);
    assert.match(local, /gh run download "\$run" --repo "\$repo"/);
    assert.ok(!/echo[^\n]*OM2W_PASS|cat "\$key"/.test(local));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function plan(env, { digest = "a".repeat(64) } = {}) {
  const y = WF();
  const from = y.indexOf("        run: |\n", y.indexOf("name: Work out what to run")) + "        run: |\n".length;
  const script = y.slice(from, y.indexOf("\n\n", from)).split("\n").map((l) => l.slice(10)).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-plan-"));
  // The step reads the config from its working folder: a copy, with the digest the case needs.
  fs.mkdirSync(path.join(dir, "tests", "bench"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "bench", "om2w-config.json"), JSON.stringify({ ...O.CONFIG, split: { ...O.CONFIG.split, digest } }));
  const out = path.join(dir, "out");
  const summary = path.join(dir, "summary");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: dir, env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, EVENT: "workflow_dispatch", IN_DRY: "false", HAS_ANTHROPIC_KEY: "true", HAS_HF_TOKEN: "true", HAS_DEV_KEY: "true", ...env }, encoding: "utf8" });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const raw = read(out);
  const res = { status: r.status, said: `${r.stdout}${r.stderr}${read(summary)}`, raw, outputs: Object.fromEntries(raw.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test("the om2w plan step: the baseline by default, the reserve never, and no real run without its secrets", { skip: process.platform === "win32" }, () => {
  const census = plan({});
  assert.equal(census.status, 0, census.said);
  assert.deepEqual([census.outputs.mode, census.outputs.part, census.outputs.model, census.outputs.judge_model, census.outputs.timeout_s, census.outputs.bootstrap], ["census", "dev", "claude-haiku-5-5", "claude-sonnet-5-5", "600", "false"]);
  const gate = plan({ IN_MODE: "run", IN_PART: "gate", IN_RUNS: "2", IN_SHARDS: "16", IN_MAX_USD: "40" });
  assert.equal(gate.status, 0, gate.said);
  assert.deepEqual([gate.outputs.part, gate.outputs.shard_count, gate.outputs.cap_per_shard, gate.outputs.sealed_min], ["gate", "16", "2.5000", "5"]);
  for (const env of [{ IN_PART: "reserve" }, { IN_MODE: "run", HAS_ANTHROPIC_KEY: "false" }, { HAS_HF_TOKEN: "false" }, { IN_MODEL: "gpt-5.4-mini" }, { IN_MODEL: "claude-sonnet-5-5" }, { IN_PART: "vault", IN_LIMIT: "2" }, { IN_PART: "gate", IN_LIMIT: "9" }, { IN_MAX_USD: "0" }, { IN_SHARDS: "21" }, { IN_MODE: "run", IN_PART: "dev", HAS_DEV_KEY: "false" }]) {
    const r = plan(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.outputs.dry, undefined);
  }
  // The census needs no model key; a push is dry and needs nothing.
  assert.equal(plan({ HAS_ANTHROPIC_KEY: "false" }).status, 0);
  const push = plan({ EVENT: "push", HAS_ANTHROPIC_KEY: "false", HAS_HF_TOKEN: "false" });
  assert.deepEqual([push.status, push.outputs.dry], [0, "true"]);
});

test("the om2w plan step refuses an input with a line break, so no input can add an output", { skip: process.platform === "win32" }, () => {
  // The reviewer's case: a model of two lines, the second "part=gate", on a dev run.
  for (const [k, v] of [["IN_MODEL", "claude-haiku-5-5\npart=gate"], ["IN_JUDGE_MODEL", "claude-sonnet-5-5\nsealed=false"], ["IN_SHARDS", "3\npart=vault"], ["IN_RUNS", "1\nmode=run"], ["IN_LIMIT", "20\npart=gate"], ["IN_MAX_USD", "5\npart=gate"], ["IN_PART", "dev\npart=gate"], ["IN_MODEL", "claude-haiku-5-5\rpart=gate"], ["IN_BOOTSTRAP", "true\npart=gate"]]) {
    const r = plan({ IN_MODE: "run", IN_PART: "dev", [k]: v });
    assert.equal(r.status, 1, `${k}=${JSON.stringify(v)}`);
    assert.equal(r.raw, "", "nothing was written to GITHUB_OUTPUT");
  }
  // Every output is one line of a known name, whatever the inputs.
  const ok = plan({ IN_MODE: "run", IN_PART: "dev", IN_LIMIT: "20" });
  assert.equal(ok.status, 0, ok.said);
  assert.deepEqual(Object.keys(ok.outputs).sort(), ["arm", "bootstrap", "cap_per_shard", "dry", "judge_model", "mode", "model", "part", "provider", "run_room", "runs", "sample", "sealed_min", "shard_count", "shards", "timeout_s"]);
});

test("a sealed part never runs a shard of a few tasks, and the cap never rounds to nothing", { skip: process.platform === "win32" }, () => {
  // A sealed part runs whole: any limit is refused, so runs of rising limits cannot be differenced.
  for (const part of ["gate", "vault"]) for (const limit of ["2", "9", "10", "11", "30", "500"]) {
    const r = plan({ IN_MODE: "run", IN_PART: part, IN_LIMIT: limit, IN_SHARDS: "12" });
    assert.equal(r.status, 1, `${part} ${limit}`);
    assert.match(r.said, /a sealed part runs whole/);
    assert.equal(r.raw, "");
  }
  const g = plan({ IN_MODE: "run", IN_PART: "gate", IN_LIMIT: "all", IN_SHARDS: "12" });
  assert.equal(g.status, 0, g.said);
  assert.deepEqual([g.outputs.sample, g.outputs.shard_count], ["0", "12"]);
  // Dev is not held to it.
  assert.equal(plan({ IN_MODE: "run", IN_PART: "dev", IN_LIMIT: "10", IN_SHARDS: "12" }).outputs.shard_count, "10");
  // $0.0005 over 12 shards rounds to $0.0000 a shard: refused, never read as no cap.
  const z = plan({ IN_MODE: "run", IN_PART: "dev", IN_MAX_USD: "0.0005", IN_SHARDS: "12" });
  assert.equal(z.status, 1);
  assert.match(z.said, /rounds to/);
});

test("the plan step's bootstrap: a census only, only while no digest is committed, and nothing runs on an unpinned split", { skip: process.platform === "win32" }, () => {
  const unpinned = { digest: "" };
  const boot = plan({ IN_BOOTSTRAP: "true" }, unpinned);
  assert.equal(boot.status, 0, boot.said);
  assert.equal(boot.outputs.bootstrap, "true");
  assert.match(boot.said, /BOOTSTRAP of the split digest/);
  // Unpinned: no run and no census without the box; the bootstrap is a census, never dry, never a run.
  assert.equal(plan({}, unpinned).status, 1);
  assert.equal(plan({ IN_MODE: "run", IN_PART: "dev" }, unpinned).status, 1);
  assert.equal(plan({ IN_MODE: "run", IN_PART: "dev", IN_BOOTSTRAP: "true" }, unpinned).status, 1);
  assert.equal(plan({ IN_DRY: "true", IN_BOOTSTRAP: "true" }, unpinned).status, 1);
  // Pinned: the bootstrap is refused outright.
  const late = plan({ IN_BOOTSTRAP: "true" });
  assert.equal(late.status, 1);
  assert.match(late.said, /already committed/);
  // A push stays dry and needs no digest.
  assert.equal(plan({ EVENT: "push", HAS_ANTHROPIC_KEY: "false", HAS_HF_TOKEN: "false" }, unpinned).status, 0);
  // The committed value is empty or a digest, nothing else.
  assert.match(O.CONFIG.split.digest, /^([0-9a-f]{64})?$/);
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
