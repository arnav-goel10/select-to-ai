/**
 * End-to-end benchmark: whole tasks, on live sites, in a real Chromium with
 * the extension loaded, judged by a model from what the run actually did.
 *
 *   BENCH_API_KEY=sk-or-... node tests/bench/run.js
 *   BENCH_API_KEY=... BENCH_TASKS=online-mind2web.json BENCH_SAMPLE=50 BENCH_RUNS=3 node tests/bench/run.js
 *
 * Tasks: a JSON array in this harness's format ({id, task, url, level}) or
 * Online-Mind2Web's ({task_id, confirmed_task, website, level}). The default,
 * smoke-tasks.json, is twelve read-only questions that check the harness
 * works; it is not a benchmark. For numbers worth quoting, use a public task
 * set, keep a held-out half you do not read while tuning, and run every
 * task three times: one run per task moves by several points on its own.
 *
 * Env:
 *   BENCH_PROVIDER     provider id (default openrouter)
 *   BENCH_MODEL        the agent's model (default openrouter/free)
 *   BENCH_HELPER_MODEL a stronger model on the same provider and key, for the
 *                      steps where the run is in difficulty and for checking
 *                      the answer (default none)
 *   BENCH_API_KEY      key for it
 *   BENCH_CUSTOM_URL   with BENCH_PROVIDER=custom: an OpenAI-compatible base URL
 *                      (NVIDIA NIM: https://integrate.api.nvidia.com/v1)
 *   BENCH_JUDGE_URL, BENCH_JUDGE_MODEL, BENCH_JUDGE_KEY, BENCH_JUDGE_VISION,
 *   BENCH_JUDGE_SHOTS  the judge: see judge-call.js. The default is a vision
 *                      model on NVIDIA's endpoint that drives no run here, so
 *                      BENCH_JUDGE_KEY must be an NVIDIA key when the agent
 *                      runs on another provider.
 *   BENCH_TASKS        task file (default tests/bench/smoke-tasks.json)
 *   BENCH_SAMPLE       use this many tasks, spread across difficulty levels
 *   BENCH_SEED         which sample (default 1)
 *   BENCH_ONLY         comma-separated task ids
 *   BENCH_EXTRA_EXTENSION  path of another unpacked extension to load beside the agent's
 *   BENCH_RUNS         runs per task (default 1)
 *   BENCH_TIMEOUT_S    seconds per run (default 300)
 *   BENCH_ALLOW        confirmations the harness allows, by kind (default
 *                      "site,address": typing on and going to sites the task
 *                      did not name). Everything else is refused, so a run
 *                      never pays, sends or deletes anything on a live site.
 *   BENCH_OUT          output folder (default tests/bench/out/<timestamp>).
 *                      A run already recorded there is reused, so a stopped
 *                      benchmark carries on where it left off.
 *   BENCH_ENGINE       "legacy" runs the old loop in agent.js; anything else
 *                      (the default), the v4 engine in the service worker.
 *                      The harness plays the user at a v4 check-in by
 *                      choosing to keep going, so a run goes on until
 *                      BENCH_TIMEOUT_S; each row records the check-ins and
 *                      the run's working time.
 *   BENCH_SHARD        "2/4": the second of four equal parts of the tasks
 *   BENCH_QUIET        1 for a held-out set: prints how each run ended and
 *                      the totals, never the judge's reasons
 *   BENCH_HEADFUL      1 to watch
 *   BENCH_PROFILE      a browser profile signed in to ChatGPT with
 *                      chatgpt-profile.js (npm run bench:chatgpt-login). The
 *                      agent then runs on that ChatGPT plan: provider
 *                      chatgpt, BENCH_MODEL and BENCH_HELPER_MODEL are slugs
 *                      the account lists, and no BENCH_API_KEY is needed.
 *                      Each shard runs on its own copy of the profile.
 *   BENCH_LEARN        "1" measures whether learning works: learning is on, and
 *                      each task runs twice in a row (A, then B) in a fresh
 *                      browser of its own, so B starts with what A left and
 *                      nothing else. "near" runs B on the next task in the
 *                      task file from the same site instead, to see whether
 *                      what was learned carries over to another request.
 *                      Prints pass, steps and seconds for A against B, and
 *                      what was known and shown at the start of B. Unset,
 *                      learning is off and every run stands alone.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const J = require("./judge.js");
const { summarise, normaliseTasks, sampleTasks, isInfra } = J;
const { judgeConfig, judgeRun } = require("./judge-call.js");
const BENCH_PROFILE_LIB = require("./profile.js");

// BENCH_EXTENSION runs another build of the extension (an older commit's
// checkout) under this same harness, for before-and-after comparisons.
const EXT = process.env.BENCH_EXTENSION ? path.resolve(process.env.BENCH_EXTENSION) : path.resolve(__dirname, "../../extension");
// BENCH_PROFILE: the owner's ChatGPT plan, from a profile he signed in to (profile.js).
let CHATGPT = null;
try { CHATGPT = BENCH_PROFILE_LIB.profileEnv(process.env); } catch (e) { console.error(e.message); process.exit(1); }
const PROVIDER = CHATGPT ? CHATGPT.provider : process.env.BENCH_PROVIDER || "openrouter";
const MODEL = CHATGPT ? CHATGPT.model : process.env.BENCH_MODEL || "openrouter/free";
const HELPER_MODEL = CHATGPT ? CHATGPT.helperModel : process.env.BENCH_HELPER_MODEL || "";
const KEY = process.env.BENCH_API_KEY || "";
const JUDGE = judgeConfig();
const CUSTOM_URL = process.env.BENCH_CUSTOM_URL || "";
const RUNS = Math.max(1, parseInt(process.env.BENCH_RUNS || "1", 10));
const TIMEOUT_MS = Math.max(30, parseInt(process.env.BENCH_TIMEOUT_S || "300", 10)) * 1000;
const ALLOW = new Set((process.env.BENCH_ALLOW || "site,address").split(",").map((s) => s.trim()).filter(Boolean));
const ONLY = (process.env.BENCH_ONLY || "").split(",").filter(Boolean);
const OUT = process.env.BENCH_OUT || path.join(__dirname, "out", new Date().toISOString().replace(/[:.]/g, "-"));
const QUIET = !!process.env.BENCH_QUIET;
const SHARD = (process.env.BENCH_SHARD || "").match(/^(\d+)\/(\d+)$/);
// The browser went away under the harness: nothing to do with the agent.
const BROWSER_GONE = /Connection closed|Target closed|Session closed|detached Frame|Protocol error|browser has disconnected|Navigating frame was detached/i;
// This many runs in a row lost to the browser or the provider ends the
// benchmark: on 1 Oct 2026 seven runs went on failing every task for an hour
// after their browsers had died.
const MAX_LOST_IN_A_ROW = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HEADFUL = !!process.env.BENCH_HEADFUL;
const LEARN = process.env.BENCH_LEARN || "";
if (LEARN && !["1", "near"].includes(LEARN)) { console.error('BENCH_LEARN is "1" or "near".'); process.exit(1); }

/** Chrome's id for the tab showing `url`, asked of the extension itself. */
async function tabIdOf(browser, extensionId, agentPage, url) {
  const find = async (u) => {
    const tabs = await chrome.tabs.query({});
    const web = tabs.filter((t) => /^https?:/.test(t.url || t.pendingUrl || ""));
    const hit = web.find((t) => t.url === u) || web[web.length - 1];
    return hit ? hit.id : null;
  };
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 3000 });
    const worker = await target.worker();
    return await worker.evaluate(find, url);
  } catch (_e) {
    // The worker is asleep: any page of the extension can ask instead.
    await agentPage.goto(`chrome-extension://${extensionId}/agent.html`, { waitUntil: "load" });
    return agentPage.evaluate(find, url).catch(() => null);
  }
}

async function runTask(browser, extensionId, task, runIndex, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // One ordinary tab, as when a person opens the agent on the page they are
  // looking at: the browser's first tab is reused, and no blank tab is left
  // beside it for the agent to mistake for the current one.
  // A fresh tab each task: a handle kept from the last task can belong to a
  // frame that has since gone ("Attempted to use detached Frame").
  const open = await browser.pages();
  const target = await browser.newPage();
  for (const p of open) if (!p.url().startsWith("chrome-extension://")) await p.close().catch(() => {});
  if (!HEADFUL) await target.setViewport({ width: 1280, height: 900 });
  await target.goto(task.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(1500);
  // The agent's panel gets a window of its own, as the side panel sits
  // beside the page in real use. Opened as a tab in the page's window it
  // would put the page in the background, where Chrome stops drawing: a
  // menu or a date picker never finishes opening, and every task that needs
  // one fails for a reason that has nothing to do with the agent.
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const agentTarget = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 15000 });
  const agentPage = await agentTarget.page();
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => ({}));
  if (windowId) await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: HEADFUL ? 1064 : 1300, top: 0, width: HEADFUL ? 440 : 460, height: 900 } }).catch(() => {});
  await cdp.detach().catch(() => {});
  const problems = [];
  agentPage.on("pageerror", (err) => problems.push(String(err.message).slice(0, 300)));
  agentPage.on("console", (msg) => { if (msg.type() === "error") problems.push(`console: ${msg.text().slice(0, 300)}`); });
  const tabId = await tabIdOf(browser, extensionId, agentPage, target.url());
  const t0 = Date.now();
  await agentPage.goto(`chrome-extension://${extensionId}/agent.html?task=${encodeURIComponent(task.task)}&autostart=1&fresh=1${tabId ? `&tabId=${tabId}` : ""}`, { waitUntil: "load" });
  const inView = await target.evaluate(() => document.visibilityState).catch(() => "");
  if (inView !== "visible") problems.push(`the page was not in view while the agent worked (${inView || "unknown"})`);

  const screenshots = [];
  // The text of each page the agent was on, newest last: what it could have
  // read, for the judge.
  const seenPages = new Map();
  const held = [];
  let lastStep = -1;
  let sawRunning = false;
  let ending = "timed out";
  const shot = async (label) => {
    // The page the agent is working on: the newest ordinary tab.
    const pages = (await browser.pages()).filter((p) => /^https?:/.test(p.url()));
    const page = pages[pages.length - 1];
    if (!page) return;
    const file = path.join(dir, `${String(screenshots.length).padStart(2, "0")}-${label}.jpg`);
    try { await page.screenshot({ path: file, type: "jpeg", quality: 60 }); screenshots.push(file); } catch (_e) { /* a closing tab */ }
    const seen = await page.evaluate(() => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 60000) })).catch(() => null);
    if (seen && seen.url) { seenPages.delete(seen.url); seenPages.set(seen.url, seen); }
  };

  while (Date.now() - t0 < TIMEOUT_MS) {
    const state = await agentPage.evaluate((allow) => {
      // The harness plays the user at a confirmation: it allows only what it
      // was told to, and refuses the rest.
      // At a check-in the user says to keep going: the harness's own timeout is the limit.
      const keep = document.querySelector('.confirmation-bubble[data-wait-kind="check_in"] .checkin-keep-btn');
      if (keep) keep.click();
      // A run held for its provider (a spent allowance, a model that stayed
      // busy) is ended with what it has, as it ended by itself before holds.
      const holdStop = document.querySelector(".confirmation-bubble[data-hold] .hold-stop-btn");
      if (holdStop) holdStop.click();
      const bubble = document.querySelector(".confirmation-bubble.risk");
      let asked = null;
      if (bubble) {
        const kind = bubble.dataset.riskKind || "unknown";
        const ok = allow.includes(kind);
        asked = { kind, allowed: ok, text: (bubble.innerText || "").replace(/\s+/g, " ").slice(0, 200) };
        const btn = bubble.querySelector(ok ? ".confirm-risk-btn" : ".abort-risk-btn");
        if (btn) btn.click();
      }
      const trace = globalThis.__selectToAiTrace ? globalThis.__selectToAiTrace() : null;
      // A run at a check-in, or paused for its provider, is still under way.
      const held = !!keep || !!(trace && trace.waitingForUser && ["check_in", "pause"].includes(trace.waitKind));
      const running = held || document.getElementById("actionBtn").classList.contains("stop-btn");
      return { asked, running, steps: trace ? trace.steps : 0 };
    }, [...ALLOW]);
    if (state.asked) held.push(state.asked);
    if (state.running) sawRunning = true;
    if (state.steps !== lastStep) { lastStep = state.steps; if (state.steps > 0) await shot(`step${state.steps}`); }
    if (sawRunning && !state.running) { ending = "finished"; break; }
    // A question answered without starting a run ends when its answer stops changing.
    if (!sawRunning && Date.now() - t0 > 20000) {
      const settled = await agentPage.evaluate(() => { const b = [...document.querySelectorAll(".final-answer-box")].pop(); return !!b && !b.querySelector(".progress-line") && (b.innerText || "").trim().length > 0; });
      if (settled) { ending = "answered without acting"; break; }
    }
    await sleep(700);
  }
  await shot("final");

  const trace = await agentPage.evaluate(() => (globalThis.__selectToAiTrace ? globalThis.__selectToAiTrace() : null)).catch(() => null);
  const shown = await agentPage.evaluate(() => { const b = [...document.querySelectorAll(".final-answer-box")].filter((x) => getComputedStyle(x).display !== "none").pop(); return b ? (b.innerText || "").trim() : ""; }).catch(() => "");
  // The final answer, from the trace: never one shown while it was being checked.
  const answer = J.finalAnswer(trace, shown);
  const log = await agentPage.evaluate(() => [...document.querySelectorAll(".log-item")].map((i) => i.textContent).join("\n")).catch(() => "");
  if (ending === "timed out") await agentPage.evaluate(() => { const b = document.getElementById("actionBtn"); if (b.classList.contains("stop-btn")) b.click(); }).catch(() => {});
  if (trace && trace.waitingForUser && trace.waitKind === "pause") ending = "provider limit (paused, still waiting at the timeout)";
  else if (trace && trace.waitingForUser) ending = "asked the user";
  else if (/aborted by user safety confirmation/i.test(answer)) ending = `stopped at a confirmation (${(held.find((h) => !h.allowed) || {}).kind || "refused"})`;
  else if (/I ran out of steps/i.test(answer)) ending = "ran out of steps";
  else if (/^Task abandoned:|Giving up after/i.test(answer)) ending = "gave up";
  else if (trace && trace.stopState === "limit") ending = "provider limit";
  // The provider was down or overloaded (HTTP 5xx after every retry): says
  // nothing about the agent, so it is reported apart from its failures.
  else if (trace && trace.stopState === "error" && /couldn'?t reach|HTTP 5\d\d|high demand|overloaded|temporarily unavailable|is busy and kept refusing|rate limiting requests|exceeded your current quota|usage limit|out of credit/i.test(answer)) ending = "provider unavailable";
  // A run that stopped on an error is not an answer, whatever the panel shows.
  else if (trace && trace.stopState === "error") ending = `stopped with an error: ${answer.replace(/\s+/g, " ").slice(0, 70)}`;

  const pages = (await browser.pages()).filter((p) => /^https?:/.test(p.url()));
  const finalPage = pages[pages.length - 1];
  const final = finalPage
    ? await finalPage.evaluate(() => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 60000) })).catch(() => ({}))
    : {};

  const run = {
    id: task.id,
    level: task.level,
    run: runIndex,
    task: task.task,
    startUrl: task.url,
    ending,
    answer,
    history: trace ? trace.history : [],
    steps: trace ? trace.steps : 0,
    helperSteps: trace ? trace.helperSteps || 0 : 0,
    seconds: Math.round((Date.now() - t0) / 1000),
    // How often the run asked whether to go on, and how long it worked (not waiting).
    checkIns: trace ? trace.checkIns || 0 : 0,
    activeSeconds: trace && trace.activeMs !== undefined ? Math.round(trace.activeMs / 1000) : null,
    costUSD: trace ? trace.costUSD : 0,
    tokens: trace ? trace.tokens : {},
    timing: trace ? trace.timing : null,
    models: trace ? trace.models : [],
    validated: trace ? trace.validated : false,
    // With BENCH_LEARN: model calls, and what the run was shown from memory.
    calls: trace ? trace.calls || 0 : 0,
    modelCalls: trace ? (trace.modelCalls || []).map((c) => ({ purpose: c.purpose, by: c.by, model: c.model, ms: c.ms, prompt: c.prompt, completion: c.completion, cached: c.cached || 0 })) : [],
    ...(LEARN ? { known: trace ? trace.known || null : null } : {}),
    held,
    problems,
    finalUrl: final.url,
    finalTitle: final.title,
    finalText: final.text,
    pages: [...seenPages.values()].slice(-6),
    screenshots,
  };
  // What the user would be looking at in the agent's panel when the run ended.
  const panel = await agentPage.evaluate(() => (document.body.innerText || "").replace(/\n{2,}/g, "\n").slice(-1500)).catch(() => "");
  fs.writeFileSync(path.join(dir, "log.txt"), `${log}\n\n--- panel at the end ---\n${panel}`);
  await agentPage.close().catch(() => {});
  // Close what this task opened; the next task starts its own tab.
  const left = (await browser.pages()).filter((p) => !p.url().startsWith("chrome-extension://"));
  for (const p of left) await p.close().catch(() => {});
  return run;
}

(async () => {
  if (!KEY && !CHATGPT) { console.error("Set BENCH_API_KEY."); process.exit(1); }
  const profileMeta = CHATGPT ? BENCH_PROFILE_LIB.readMeta(CHATGPT.profile) : null;
  if (CHATGPT && !profileMeta) { console.error(`${CHATGPT.profile} is not a profile made by chatgpt-profile.js. ${BENCH_PROFILE_LIB.LOGIN_HINT}`); process.exit(1); }
  const file = process.env.BENCH_TASKS || path.join(__dirname, "smoke-tasks.json");
  let tasks = normaliseTasks(JSON.parse(fs.readFileSync(file, "utf8")));
  if (ONLY.length) tasks = tasks.filter((t) => ONLY.includes(t.id));
  tasks = sampleTasks(tasks, parseInt(process.env.BENCH_SAMPLE || "0", 10), parseInt(process.env.BENCH_SEED || "1", 10));
  if (SHARD) tasks = tasks.filter((_, i) => i % Number(SHARD[2]) === Number(SHARD[1]) - 1);
  if (!tasks.length) { console.error("No tasks to run."); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Benchmark: ${tasks.length} task(s) x ${RUNS} run(s), agent ${PROVIDER} / ${MODEL}, judge ${JUDGE.model}${JUDGE.vision ? ` with the last ${JUDGE.shots} screenshots` : ""}\nOutput: ${OUT}\n`);

  // A person grants the agent access to a site the first time it is used
  // there, in a prompt a test cannot click. The harness loads a copy of the
  // extension with that access already given for every site, as it is for a
  // user who chose "allow on all sites".
  // One copy per process: a run stopped while another starts in the same
  // folder deleted the new run's copy on its way out.
  const loaded = path.join(OUT, `.extension-${process.pid}`);
  fs.cpSync(EXT, loaded, { recursive: true });
  const manifestPath = path.join(loaded, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "https://*/*", "http://*/*"])];
  // On a ChatGPT profile, the profile's key: the extension gets the id its sign-in is stored under.
  if (profileMeta) manifest.key = profileMeta.key;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // This shard's own copy of the profile, so shards never share a live one.
  const profileCopy = CHATGPT ? BENCH_PROFILE_LIB.copyProfile(CHATGPT.profile) : "";

  const puppeteer = require("puppeteer");
  const { PROVIDER_ENDPOINTS } = require(path.join(EXT, "defaults.js"));
  /** A browser with the extension loaded and set up for this benchmark. */
  const launch = async () => {
    const browser = await puppeteer.launch({
      headless: !HEADFUL,
      // Watched by a person: the page in a window of its own size, on the left.
      ...(HEADFUL ? { defaultViewport: null } : {}),
      ...(profileCopy ? { userDataDir: profileCopy } : {}),
      // A headless browser that says so is turned away by many sites (Cloudflare
      // challenges that never clear, Google's "unusual traffic" page), which
      // a person's own Chrome never sees. Measured 1 Oct 2026: with these two
      // changes Allrecipes, Google search and Booking load as they do for people.
      // BENCH_EXTRA_EXTENSION: another unpacked extension loaded beside the
      // agent's, for measuring what it changes (an ad blocker, say).
      args: [`--disable-extensions-except=${[loaded, process.env.BENCH_EXTRA_EXTENSION].filter(Boolean).join(",")}`, `--load-extension=${[loaded, process.env.BENCH_EXTRA_EXTENSION].filter(Boolean).join(",")}`, "--no-first-run", "--disable-features=DialMediaRouteProvider",
        "--disable-blink-features=AutomationControlled",
        // A window on a desktop can be covered by another one, and Chrome stops drawing a covered window.
        ...(HEADFUL ? ["--window-position=0,0", "--window-size=1060,900", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] : [])],
    });
    const userAgent = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
    const dressed = async (target) => {
      if (target.type() !== "page") return;
      const page = await target.page().catch(() => null);
      if (page) await page.setUserAgent(userAgent).catch(() => {});
    };
    browser.on("targetcreated", dressed);
    for (const target of browser.targets()) await dressed(target);
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 20000 });
    const extensionId = new URL(workerTarget.url()).host;
    const worker = await workerTarget.worker();
    await worker.evaluate((s) => new Promise((r) => chrome.storage.sync.set(s, r)), {
      agentActiveProvider: PROVIDER, agentModel: MODEL, agentHelperModel: HELPER_MODEL, showAgent: true, ...(CUSTOM_URL ? { agentCustomUrl: CUSTOM_URL } : {}), agentRiskConfirmation: true, agentDomainAllowlist: "", openingMode: "tab",
      // Each run is judged on its own: nothing learned in one may help the next,
      // except under BENCH_LEARN, which measures exactly that.
      agentLearning: !!LEARN,
      agentEngine: process.env.BENCH_ENGINE || "v4",
      // Switches for measuring one design choice against another.
      ...(process.env.BENCH_OBSERVE ? { agentObserve: process.env.BENCH_OBSERVE } : {}),
      ...(process.env.BENCH_PRESSABLES ? { agentPressables: process.env.BENCH_PRESSABLES } : {}),
    });
    // ChatGPT has no key: the profile's sign-in is used.
    await worker.evaluate((e) => new Promise((r) => chrome.storage.local.set(e, r)), { onboardingComplete: true, ...(CHATGPT ? { agentProviderPause: null } : { [PROVIDER === "custom" ? "agentCustomKey" : PROVIDER_ENDPOINTS[PROVIDER].keyName]: KEY }) });
    return { browser, extensionId };
  };

  const rows = [];
  let session;
  try {
    session = await launch();
    if (CHATGPT) {
      const account = await BENCH_PROFILE_LIB.checkAccount(session.browser, session.extensionId, profileMeta, CHATGPT);
      console.log(`ChatGPT plan: ${account.email || "signed in"}, profile copied to ${profileCopy}\n`);
    }
  } catch (e) {
    if (session) await session.browser.close().catch(() => {});
    fs.rmSync(loaded, { recursive: true, force: true });
    if (profileCopy) fs.rmSync(profileCopy, { recursive: true, force: true });
    console.error(e.message || e);
    process.exit(1);
  }
  // Before each ChatGPT run: the shared sign-in, renewed under the lock if it
  // would run out during the run (profile.js says why). Null when ready.
  const chatgptNotReady = async () => {
    if (!CHATGPT) return null;
    const r = await BENCH_PROFILE_LIB.syncCredentials(session.browser, session.extensionId, CHATGPT.profile, TIMEOUT_MS + 5 * 60 * 1000).catch((e) => ({ ok: false, why: e.message }));
    return r.ok ? null : `the ChatGPT sign-in is not usable (${r.why}). ${BENCH_PROFILE_LIB.LOGIN_HINT}`;
  };
  /** What the extension knows now, and whether a learning call is still under way (engine.js). */
  async function memoryState() {
    const ask = async () => {
      const target = await session.browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 3000 });
      const worker = await target.worker();
      return worker.evaluate(async () => (globalThis.__selectToAiMemoryState ? globalThis.__selectToAiMemoryState() : null));
    };
    try { return await ask(); } catch (_e) {
      // The worker is asleep: a message from one of the extension's pages wakes it.
      const page = await session.browser.newPage();
      await page.goto(`chrome-extension://${session.extensionId}/options.html`, { waitUntil: "load" }).catch(() => {});
      await page.evaluate(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {})).catch(() => {});
      await page.close().catch(() => {});
      return ask().catch(() => null);
    }
  }

  const describeMemory = (store) => {
    const entries = (store && store.entries) || [];
    const kinds = {};
    for (const e of entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    return { count: entries.length, kinds, entries: entries.map((e) => ({ kind: e.kind, scope: e.scope, source: e.source, text: String(e.text).slice(0, 300), helped: e.helped || 0, hurt: e.hurt || 0 })) };
  };

  /** Runs each task twice in one fresh browser, or a task and the next one from its site. */
  async function learnPairs() {
    const all = normaliseTasks(JSON.parse(fs.readFileSync(file, "utf8")));
    const siteKey = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_e) { return ""; } };
    const pairs = [];
    for (const a of tasks) {
      let b = a;
      if (LEARN === "near") {
        const i = all.findIndex((t) => t.id === a.id);
        b = [...all.slice(i + 1), ...all.slice(0, Math.max(0, i))].find((t) => t.id !== a.id && siteKey(t.url) === siteKey(a.url));
        if (!b) { console.log(`skip  ${a.id}: no other task from ${siteKey(a.url)} in ${path.basename(file)}`); continue; }
      }
      pairs.push({ a, b });
    }
    console.log(`Learning, ${LEARN === "near" ? "a task then the next one from its site" : "each task twice"}: ${pairs.length} pair(s) x ${RUNS}\n`);
    const done = [];
    const judged = async (run) => {
      const lost = isInfra(run);
      const verdict = lost ? { success: false, reason: "not judged: the run was lost before the agent could act" } : await judgeRun(run, JUDGE);
      return { ...run, success: verdict.success, blocked: !!verdict.blocked, reason: verdict.reason, keyPoints: verdict.keyPoints, met: verdict.met, judgeFailed: !!verdict.judgeFailed, judgeReply: verdict.judgeReply };
    };
    const save = (row, dir) => fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...row, pages: (row.pages || []).map((p) => ({ ...p, text: p.text.slice(0, 20000) })), screenshots: (row.screenshots || []).map((x) => path.basename(x)) }, null, 2));
    for (const { a, b } of pairs) {
      for (let r = 1; r <= RUNS; r++) {
        const base = path.join(OUT, a.id, `learn${r}`);
        const dirA = path.join(base, "A");
        const dirB = path.join(base, "B");
        const read = (d) => { const f = path.join(d, "run.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
        const priorA = read(dirA);
        const priorB = read(dirB);
        // A pair recorded earlier stands only whole: B means nothing without the A before it.
        if (priorA && priorB && !isInfra(priorA) && !isInfra(priorB)) { done.push({ a: priorA, b: priorB }); console.log(`pair  ${a.id} run ${r}  (recorded earlier)`); continue; }
        // A fresh browser, so the pair starts knowing nothing.
        await session.browser.close().catch(() => {});
        session = await launch();
        const start = describeMemory((await memoryState() || {}).store);
        let runA;
        try { runA = await runTask(session.browser, session.extensionId, a, r, dirA); } catch (e) { runA = lostRun(a, r, e.message); }
        // What A teaches is written after it ends, by one model call: B waits for it, as a person starting the next task a minute later would.
        const t0 = Date.now();
        let state = await memoryState();
        while (state && state.learning > 0 && Date.now() - t0 < 240000) { await sleep(2000); state = await memoryState(); }
        const learnSeconds = Math.round((Date.now() - t0) / 1000);
        const atB = describeMemory(state && state.store);
        let runB;
        if (isInfra(runA) || !session.browser.connected) runB = lostRun(b, r, "run A was lost, so B was not run");
        else { try { runB = await runTask(session.browser, session.extensionId, b, r, dirB); } catch (e) { runB = lostRun(b, r, e.message); } }
        const after = describeMemory(((await memoryState()) || {}).store);
        const rowA = { ...(await judged(runA)), learn: { phase: "A", mode: LEARN, pairOf: b.id, memoryAtStart: start } };
        const shown = (runB.known && runB.known.first) || null;
        const rowB = { ...(await judged(runB)), learn: { phase: "B", mode: LEARN, pairOf: a.id, memoryAtStart: atB, waitedForLearningSeconds: learnSeconds, shownAtFirstStep: shown, memoryAfter: after } };
        save(rowA, dirA);
        save(rowB, dirB);
        done.push({ a: rowA, b: rowB });
        const mark = (row) => (row.success ? "PASS" : row.blocked ? "BLOCK" : isInfra(row) || row.judgeFailed ? "LOST" : "FAIL");
        console.log(`${mark(rowA).padEnd(5)} ${a.id.padEnd(28)} A  ${String(rowA.steps).padStart(2)} steps ${String(rowA.seconds).padStart(3)}s  ${rowA.ending}`);
        console.log(`${mark(rowB).padEnd(5)} ${b.id.padEnd(28)} B  ${String(rowB.steps).padStart(2)} steps ${String(rowB.seconds).padStart(3)}s  ${rowB.ending}  | known at start: ${atB.count} (${Object.entries(atB.kinds).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing"}), shown at first step: ${shown && shown.ids.length ? shown.kinds.join(", ") : "nothing"}`);
      }
    }
    learnSummary(done);
  }

  function learnSummary(done) {
    const scored = done.filter((p) => !isInfra(p.a) && !isInfra(p.b) && !p.a.judgeFailed && !p.b.judgeFailed);
    const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return "-"; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
    const tokens = (r) => ((r.tokens && r.tokens.prompt) || 0) + ((r.tokens && r.tokens.completion) || 0);
    const side = (k) => scored.map((p) => p[k]);
    const line = (k) => {
      const rs = side(k);
      return `| ${k.toUpperCase()} | ${rs.filter((r) => r.success).length} of ${rs.length} | ${median(rs.map((r) => r.steps))} | ${median(rs.map((r) => r.seconds))} | ${median(rs.map((r) => r.calls))} | ${median(rs.map(tokens))} |`;
    };
    console.log(`\n| run | passed | median steps | median seconds | median model calls | median tokens |\n| --- | --- | --- | --- | --- | --- |\n${line("a")}\n${line("b")}`);
    const shown = scored.filter((p) => p.b.learn && p.b.learn.shownAtFirstStep && p.b.learn.shownAtFirstStep.ids.length);
    const knew = scored.filter((p) => p.b.learn && p.b.learn.memoryAtStart.count);
    console.log(`\nB runs that started with something learned: ${knew.length} of ${scored.length}; shown some of it at their first step: ${shown.length} of ${scored.length}.`);
    const worse = scored.filter((p) => (p.a.success && !p.b.success) || (p.a.success === p.b.success && p.b.steps > p.a.steps));
    console.log(`B worse than A (failed where A passed, or same result in more steps): ${worse.length ? worse.map((p) => `${p.a.id}${p.a.id === p.b.id ? "" : ` -> ${p.b.id}`} (${p.a.success ? "pass" : "fail"} ${p.a.steps} steps -> ${p.b.success ? "pass" : "fail"} ${p.b.steps} steps)`).join("; ") : "none"}.`);
    if (done.length > scored.length) console.log(`${done.length - scored.length} pair(s) left out: a run was lost or could not be judged.`);
    fs.writeFileSync(path.join(OUT, `learn-results${SHARD ? `-${SHARD[1]}of${SHARD[2]}` : ""}.json`), JSON.stringify({ mode: LEARN, agent: { provider: PROVIDER, model: MODEL, helperModel: HELPER_MODEL || undefined }, judge: { model: JUDGE.model }, pairs: done.map((p) => ({ a: { id: p.a.id, success: p.a.success, steps: p.a.steps, seconds: p.a.seconds, calls: p.a.calls, tokens: p.a.tokens, ending: p.a.ending, reason: p.a.reason }, b: { id: p.b.id, success: p.b.success, steps: p.b.steps, seconds: p.b.seconds, calls: p.b.calls, tokens: p.b.tokens, ending: p.b.ending, reason: p.b.reason, learn: p.b.learn } })) }, null, 2));
  }

  let lostInARow = 0;
  let stoppedEarly = "";
  const lostRun = (task, r, why) => ({ id: task.id, level: task.level, run: r, task: task.task, startUrl: task.url, ending: `harness error: ${String(why).slice(0, 120)}`, answer: "", history: [], steps: 0, helperSteps: 0, seconds: 0, costUSD: 0, screenshots: [], held: [] });
  // BENCH_LEARN: pairs of runs in fresh browsers, instead of the loop below.
  if (LEARN) {
    try { await learnPairs(); } finally {
      await session.browser.close().catch(() => {});
      fs.rmSync(loaded, { recursive: true, force: true });
      if (profileCopy) fs.rmSync(profileCopy, { recursive: true, force: true });
    }
    return;
  }

  try {
    for (const task of tasks) {
      for (let r = 1; r <= RUNS; r++) {
        const dir = path.join(OUT, task.id, `run${r}`);
        const saved = path.join(dir, "run.json");
        // A run recorded earlier stands, unless it was lost to the browser,
        // the provider or the judge.
        if (fs.existsSync(saved)) {
          const prior = JSON.parse(fs.readFileSync(saved, "utf8"));
          if (!isInfra(prior)) { rows.push({ ...prior, screenshots: prior.screenshots || [] }); console.log(`${prior.success ? "PASS" : "FAIL"}  ${task.id.padEnd(28)} run ${r}  (recorded earlier)  ${prior.ending}`); continue; }
        }
        let run;
        const notReady = await chatgptNotReady();
        if (notReady) { stoppedEarly = notReady; break; }
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt && CHATGPT) { const again = await chatgptNotReady(); if (again) { run = lostRun(task, r, again); break; } }
          try { run = await runTask(session.browser, session.extensionId, task, r, dir); } catch (e) { run = lostRun(task, r, e.message); }
          const gone = /^harness error/.test(run.ending) && (BROWSER_GONE.test(run.ending) || !session.browser.connected);
          if (!gone) break;
          // The browser died: start another and give the task one more go.
          await session.browser.close().catch(() => {});
          session = await launch();
        }
        const lost = isInfra(run);
        const verdict = lost ? { success: false, reason: "not judged: the run was lost before the agent could act" } : await judgeRun(run, JUDGE);
        const row = { ...run, success: verdict.success, blocked: !!verdict.blocked, reason: verdict.reason, keyPoints: verdict.keyPoints, met: verdict.met, judgeFailed: !!verdict.judgeFailed, judgeReply: verdict.judgeReply, judgeUsage: verdict.judgeUsage };
        rows.push(row);
        fs.writeFileSync(saved, JSON.stringify({ ...row, pages: (row.pages || []).map((p) => ({ ...p, text: p.text.slice(0, 20000) })), screenshots: row.screenshots.map((s) => path.basename(s)) }, null, 2));
        if (!QUIET && row.problems && row.problems.length) console.log(`  [page errors] ${row.problems.slice(0, 3).join(" | ")}`);
        const mark = row.success ? "PASS" : row.blocked ? "BLOCK" : lost || row.judgeFailed ? "LOST" : "FAIL";
        console.log(`${mark.padEnd(5)} ${task.id.padEnd(28)} run ${r}  ${String(row.steps).padStart(2)} steps ${String(row.seconds).padStart(3)}s  ${row.ending}${QUIET ? "" : `  | ${String(row.reason).slice(0, 110)}`}`);
        lostInARow = lost ? lostInARow + 1 : 0;
        // The plan says its usage is used up: every later run would end the same way.
        if (CHATGPT && BENCH_PROFILE_LIB.isPlanLimit(row.ending)) { stoppedEarly = "the ChatGPT plan's usage limit was reached; run again when it has room (Manage usage at chatgpt.com/settings/usage)."; break; }
        if (lostInARow >= MAX_LOST_IN_A_ROW) { stoppedEarly = `${lostInARow} runs in a row were lost (${row.ending}); stopping so the rest are not wasted.`; break; }
      }
      if (stoppedEarly) break;
    }
  } finally {
    await session.browser.close().catch(() => {});
    fs.rmSync(loaded, { recursive: true, force: true });
    if (profileCopy) fs.rmSync(profileCopy, { recursive: true, force: true });
  }

  const s = summarise(rows);
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  console.log(`\n| scored tasks | runs each | passed | success | success, blocked and lost as failures | solved at least once | solved every time | median steps (passed) | steps spent finding | median seconds | blocked by site | lost |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  console.log(`| ${s.tasks} | ${s.runsPerTask} | ${s.passed} | ${pct(s.success)} ± ${pct(s.standardError)} | ${pct(s.successAllRuns)} of ${s.tasksAllRuns} tasks | ${pct(s.solvedOnce)} | ${pct(s.solvedEveryTime)} | ${s.medianSteps} (${s.medianStepsPassed}) | ${pct(s.findingShare)} | ${s.medianSeconds} | ${s.blocked} | ${s.lost} |`);
  console.log(`\nHow runs ended: ${Object.entries(s.endings).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (HELPER_MODEL) {
    const all = rows.reduce((n, r) => n + (r.steps || 0), 0);
    const helped = rows.reduce((n, r) => n + (r.helperSteps || 0), 0);
    console.log(`Steps taken by the helper (${HELPER_MODEL}): ${helped} of ${all}${all ? ` (${pct(helped / all)})` : ""}.`);
  }
  if (s.lost) console.log(`${s.lost} run(s) were lost to the browser, the provider or the judge and are left out of the rate.`);
  if (s.blocked || s.lost) console.log(`Success with the ${s.blocked} blocked and ${s.lost} lost run(s) counted as failures: ${pct(s.successAllRuns)}.`);
  if (stoppedEarly) console.log(`Stopped early: ${stoppedEarly}`);
  fs.writeFileSync(path.join(OUT, `results${SHARD ? `-${SHARD[1]}of${SHARD[2]}` : ""}.json`), JSON.stringify({ agent: { provider: PROVIDER, model: MODEL, helperModel: HELPER_MODEL || undefined, url: CUSTOM_URL || undefined, extension: EXT, profile: CHATGPT ? CHATGPT.profile : undefined }, judge: { model: JUDGE.model, url: JUDGE.url, vision: JUDGE.vision, shots: JUDGE.vision ? JUDGE.shots : 0 }, summary: s, stoppedEarly, rows: rows.map((r) => ({ ...r, finalText: undefined, pages: undefined, screenshots: (r.screenshots || []).length })) }, null, 2));
  if (stoppedEarly) process.exitCode = 2;
})().catch((e) => { console.error(e); process.exit(1); });
