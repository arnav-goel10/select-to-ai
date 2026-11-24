/**
 * MiniWoB++ for the agent: small synthetic web widgets with a reward the
 * page computes itself, so what is measured is how the harness operates
 * controls, with no judge model in the way.
 *
 *   BENCH_PROVIDER=... BENCH_MODEL=... BENCH_API_KEY=... \
 *   MINIWOB_HTML=/path/to/miniwob-plusplus/miniwob/html \
 *   node tests/bench/miniwob.js
 *
 * Env: BENCH_PROVIDER, BENCH_MODEL, BENCH_HELPER_MODEL, BENCH_API_KEY,
 * and BENCH_CUSTOM_URL as in run.js; MINIWOB_TASKS (comma-separated task names,
 * default: the widget and form tasks listed below); MINIWOB_EPISODES
 * (default 2); MINIWOB_TIMEOUT_S (default 150 per episode); BENCH_OUT;
 * BENCH_SHARD "i/n"; BENCH_HEADFUL=1 to watch; BENCH_PROFILE as in run.js
 * (the owner's ChatGPT plan, from a profile made with chatgpt-profile.js).
 *
 * An episode: the task page is opened, seeded, and started; the task's
 * own wording (its #query) is given to the agent; the episode ends when
 * the page says so (WOB_DONE_GLOBAL), when the agent stops, or at the
 * timeout. At a check-in the harness chooses to keep going, so the timeout
 * is the limit; each row records the check-ins and the run's working time.
 * Success is the page's raw reward being positive.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const EXT = path.resolve(__dirname, "../../extension");
const HTML = process.env.MINIWOB_HTML || "";
const BENCH_PROFILE_LIB = require("./profile.js");
const { engineTrace } = require("../helpers/engine-trace.js");
// BENCH_PROFILE: the owner's ChatGPT plan, as in run.js.
let CHATGPT = null;
try { CHATGPT = BENCH_PROFILE_LIB.profileEnv(process.env); } catch (e) { console.error(e.message); process.exit(1); }
const PROVIDER = CHATGPT ? CHATGPT.provider : process.env.BENCH_PROVIDER || "openrouter";
const MODEL = CHATGPT ? CHATGPT.model : process.env.BENCH_MODEL || "openrouter/free";
const HELPER_MODEL = CHATGPT ? CHATGPT.helperModel : process.env.BENCH_HELPER_MODEL || "";
const KEY = process.env.BENCH_API_KEY || "";
const CUSTOM_URL = process.env.BENCH_CUSTOM_URL || "";
const EPISODES = Math.max(1, parseInt(process.env.MINIWOB_EPISODES || "2", 10));
const TIMEOUT_MS = Math.max(20, parseInt(process.env.MINIWOB_TIMEOUT_S || "150", 10)) * 1000;
const OUT = path.resolve(process.env.BENCH_OUT || path.join(__dirname, "out", "miniwob"));
const HEADFUL = !!process.env.BENCH_HEADFUL;
const PORT = parseInt(process.env.MINIWOB_PORT || "8931", 10);

// Widget and form tasks. Left out: tasks that need dragging, drawing,
// hovering, selecting text, the clipboard, a timer, or reading a picture.
const DEFAULT_TASKS = [
  "book-flight", "choose-date", "choose-date-easy", "choose-date-medium", "choose-list", "click-button", "click-button-sequence",
  "click-checkboxes", "click-checkboxes-large", "click-checkboxes-soft", "click-checkboxes-transfer", "click-collapsible", "click-collapsible-2",
  "click-color", "click-dialog", "click-dialog-2", "click-link", "click-menu", "click-menu-2", "click-option", "click-scroll-list",
  "click-tab", "click-tab-2", "click-tab-2-easy", "click-tab-2-hard", "click-tab-2-medium", "click-test", "click-widget",
  "email-inbox", "email-inbox-delete", "email-inbox-forward", "email-inbox-important", "email-inbox-nl-turk", "email-inbox-reply", "email-inbox-star-reply",
  "enter-date", "enter-password", "enter-text", "enter-text-2", "enter-text-dynamic", "enter-time", "find-word", "focus-text", "focus-text-2",
  "form-sequence", "form-sequence-2", "form-sequence-3", "grid-coordinate", "login-user", "login-user-popup", "multi-layouts", "multi-orderings",
  "navigate-tree", "number-checkboxes", "order-food", "phone-book", "read-table", "read-table-2", "search-engine", "sign-agreement",
  "social-media", "social-media-all", "social-media-some", "use-autocomplete", "use-slider", "use-slider-2", "use-spinner",
  "daily-calendar", "stock-market", "odd-or-even", "ascending-numbers", "find-greatest", "scroll-text", "scroll-text-2", "unicode-test",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serves the MiniWoB++ html folder as it is. */
function serve(root, port = PORT) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(root, decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  if (!HTML || !fs.existsSync(path.join(HTML, "core", "core.js"))) throw new Error("MINIWOB_HTML must point at miniwob-plusplus/miniwob/html");
  let tasks = (process.env.MINIWOB_TASKS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tasks.length) tasks = DEFAULT_TASKS;
  const shard = (process.env.BENCH_SHARD || "").match(/^(\d+)\/(\d+)$/);
  if (shard) tasks = tasks.filter((_t, i) => i % Number(shard[2]) === Number(shard[1]) - 1);
  fs.mkdirSync(OUT, { recursive: true });
  const profileMeta = CHATGPT ? BENCH_PROFILE_LIB.readMeta(CHATGPT.profile) : null;
  if (CHATGPT && !profileMeta) throw new Error(`${CHATGPT.profile} is not a profile made by chatgpt-profile.js. ${BENCH_PROFILE_LIB.LOGIN_HINT}`);
  const server = await serve(HTML);
  const puppeteer = require("puppeteer");
  const { PROVIDER_ENDPOINTS } = require(path.join(EXT, "defaults.js"));
  // As in run.js: a copy of the extension with access to every site already
  // given, as for a user who chose "allow on all sites"; the provider's
  // address is among them.
  const loaded = path.join(OUT, `.extension-${process.pid}`);
  fs.cpSync(EXT, loaded, { recursive: true });
  const manifestPath = path.join(loaded, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "https://*/*", "http://*/*"])];
  // On a ChatGPT profile, the profile's key, so the extension has the id its sign-in is stored under.
  if (profileMeta) manifest.key = profileMeta.key;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // This process's own copy of the profile, so shards never share a live one.
  const profileCopy = CHATGPT ? BENCH_PROFILE_LIB.copyProfile(CHATGPT.profile) : "";
  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    ...(HEADFUL ? { defaultViewport: null } : {}),
    ...(profileCopy ? { userDataDir: profileCopy } : {}),
    args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`, "--no-first-run", "--disable-features=DialMediaRouteProvider",
      ...(HEADFUL ? ["--window-position=0,0", "--window-size=1060,900", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] : [])],
  });
  const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 20000 });
  const extensionId = new URL(workerTarget.url()).host;
  const worker = await workerTarget.worker();
  await worker.evaluate((s) => new Promise((r) => chrome.storage.sync.set(s, r)), {
    agentActiveProvider: PROVIDER, agentModel: MODEL, agentHelperModel: HELPER_MODEL, showAgent: true, ...(CUSTOM_URL ? { agentCustomUrl: CUSTOM_URL } : {}),
    agentRiskConfirmation: true, agentDomainAllowlist: "", openingMode: "tab", agentLearning: false,
  });
  // ChatGPT has no key: the profile's sign-in is used.
  await worker.evaluate((e) => new Promise((r) => chrome.storage.local.set(e, r)), { onboardingComplete: true, ...(CHATGPT ? { agentProviderPause: null } : { [PROVIDER === "custom" ? "agentCustomKey" : PROVIDER_ENDPOINTS[PROVIDER].keyName]: KEY }) });
  const cleanupProfile = () => { if (profileCopy) fs.rmSync(profileCopy, { recursive: true, force: true }); };
  if (CHATGPT) {
    try {
      const account = await BENCH_PROFILE_LIB.checkAccount(browser, extensionId, profileMeta, CHATGPT);
      console.log(`ChatGPT plan: ${account.email || "signed in"}, profile copied to ${profileCopy}\n`);
    } catch (e) {
      await browser.close().catch(() => {});
      server.close();
      fs.rmSync(loaded, { recursive: true, force: true });
      cleanupProfile();
      throw e;
    }
  }

  const rows = [];
  const saved = path.join(OUT, "results.json");
  const earlier = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) : [];
  // An episode lost to the provider's limit is run again.
  const kept = earlier.filter((r) => !r.lost);
  const done = new Set(kept.map((r) => `${r.task}#${r.episode}`));
  rows.push(...kept);
  const stamp = () => new Date().toTimeString().slice(0, 8);
  let stoppedEarly = "";
  try {
    for (const task of tasks) {
      for (let episode = 1; episode <= EPISODES; episode++) {
        if (done.has(`${task}#${episode}`)) continue;
        if (CHATGPT) {
          // The shared sign-in, renewed under the lock if it would run out during the episode (profile.js).
          const ready = await BENCH_PROFILE_LIB.syncCredentials(browser, extensionId, CHATGPT.profile, TIMEOUT_MS + 5 * 60 * 1000).catch((e) => ({ ok: false, why: e.message }));
          if (!ready.ok) { stoppedEarly = `the ChatGPT sign-in is not usable (${ready.why}). ${BENCH_PROFILE_LIB.LOGIN_HINT}`; break; }
        }
        const row = await runEpisode(browser, extensionId, task, episode);
        rows.push(row);
        fs.writeFileSync(saved, JSON.stringify(rows, null, 1));
        console.log(`${stamp()}  ${row.success ? "PASS" : "FAIL"}  ${task.padEnd(26)} ep ${episode}  reward ${row.reward === null ? "none" : row.reward.toFixed(2)}  ${String(row.steps).padStart(2)} steps  ${String(row.seconds).padStart(4)}s  ${row.ending}  ${row.utterance.slice(0, 70)}`);
        // The plan says its usage is used up: every later episode would end the same way.
        if (CHATGPT && BENCH_PROFILE_LIB.isPlanLimit(row.ending)) { stoppedEarly = "the ChatGPT plan's usage limit was reached; run again when it has room (Manage usage at chatgpt.com/settings/usage)."; break; }
      }
      if (stoppedEarly) break;
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
    fs.rmSync(loaded, { recursive: true, force: true });
    cleanupProfile();
  }
  report(rows);
  if (stoppedEarly) { console.log(`Stopped early: ${stoppedEarly}`); process.exitCode = 2; }
}

async function runEpisode(browser, extensionId, task, episode) {
  const open = await browser.pages();
  const page = await browser.newPage();
  for (const p of open) if (!p.url().startsWith("chrome-extension://")) await p.close().catch(() => {});
  if (!HEADFUL) await page.setViewport({ width: 1100, height: 800 });
  page.on("console", () => {});
  await page.goto(`http://localhost:${PORT}/miniwob/${task}.html`, { waitUntil: "load" });
  await sleep(300);
  // Seeded, with the page's own clock set long: the model is the slow part.
  const utterance = await page.evaluate((seed, ms) => {
    core.EPISODE_MAX_TIME = ms;
    Math.seedrandom(`episode-${seed}`);
    core.startEpisodeReal();
    // Some tasks hand the words back inside an object.
    const said = core.getUtterance();
    return typeof said === "string" ? said : String((said && said.utterance) || "");
  }, episode, TIMEOUT_MS + 60000);

  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const agentTarget = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 15000 });
  const agent = await agentTarget.page();
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => ({}));
  if (windowId) await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: HEADFUL ? 1064 : 1200, top: 0, width: 440, height: 900 } }).catch(() => {});
  await cdp.detach().catch(() => {});
  const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 5000 }).catch(() => null);
  const worker = workerTarget ? await workerTarget.worker() : null;
  const tabId = worker ? await worker.evaluate(async (u) => { const tabs = await chrome.tabs.query({}); const t = tabs.find((x) => x.url === u) || tabs.filter((x) => /^http/.test(x.url || "")).pop(); return t ? t.id : null; }, page.url()) : null;

  const t0 = Date.now();
  await agent.goto(`chrome-extension://${extensionId}/agent.html?task=${encodeURIComponent(utterance)}&autostart=1&fresh=1${tabId ? `&tabId=${tabId}` : ""}`, { waitUntil: "load" });
  let ending = "timed out";
  let sawRunning = false;
  let trace = null;
  while (Date.now() - t0 < TIMEOUT_MS) {
    const state = await page.evaluate(() => ({ done: WOB_DONE_GLOBAL, reward: WOB_RAW_REWARD_GLOBAL, reason: WOB_REWARD_REASON || "" })).catch(() => null);
    if (state && state.done) { ending = "page ended the episode"; break; }
    const a = await agent.evaluate((t) => {
      const bubble = document.querySelector(".confirmation-bubble.risk");
      if (bubble) { const btn = bubble.querySelector(".confirm-risk-btn"); if (btn) btn.click(); }
      // At a check-in the user says to keep going; a run there or paused for its provider is still under way.
      const keep = document.querySelector('.confirmation-bubble[data-wait-kind="check_in"] .checkin-keep-btn');
      if (keep) keep.click();
      // A run held for its provider is ended with what it has, as it ended by itself before holds.
      const holdStop = document.querySelector(".confirmation-bubble[data-hold] .hold-stop-btn");
      if (holdStop) holdStop.click();
      const held = !!keep || !!(t && t.waitingForUser && ["check_in", "pause"].includes(t.waitKind));
      return { running: held || document.getElementById("actionBtn").classList.contains("stop-btn"), trace: t };
    }, await engineTrace(browser, agent)).catch(() => ({ running: false, trace: null }));
    if (a.trace) trace = a.trace;
    if (a.running) sawRunning = true;
    if (sawRunning && !a.running) { ending = trace && trace.waitingForUser ? "asked the user" : "agent stopped"; break; }
    await sleep(500);
  }
  if (ending === "timed out" && trace && trace.waitingForUser && trace.waitKind === "pause") ending = "provider limit (paused, still waiting at the timeout)";
  // The provider said its usage is used up (a ChatGPT plan's limit, say): the run stopped for that, not for the agent.
  if (ending === "agent stopped" && trace && trace.stopState === "limit") ending = "provider limit";
  // The page settles its reward a moment after the ending action.
  await sleep(600);
  // The last word on tokens and time: the poll above can miss the final step.
  const last = await engineTrace(browser, agent);
  if (last) trace = last;
  const final = await page.evaluate(() => ({ done: WOB_DONE_GLOBAL, reward: WOB_DONE_GLOBAL ? WOB_RAW_REWARD_GLOBAL : null, reason: WOB_REWARD_REASON || "" })).catch(() => ({ done: false, reward: null, reason: "" }));
  const log = await agent.evaluate(() => [...document.querySelectorAll(".log-item")].map((i) => i.textContent).join("\n")).catch(() => "");
  if (!final.done && ending !== "timed out" && ending !== "provider limit") ending = `agent stopped before the page ended (${ending})`;
  await agent.close().catch(() => {});
  const history = trace ? trace.history : [];
  return {
    task, episode, utterance, success: final.done && final.reward > 0, reward: final.reward, reason: final.reason, ending,
    // Stopped by the provider's limit: says nothing about the agent, so left out of the rate.
    ...(ending === "provider limit" && !final.done ? { lost: true } : {}),
    steps: trace ? trace.steps : 0, helperSteps: trace ? trace.helperSteps || 0 : 0, seconds: Math.round((Date.now() - t0) / 1000),
    // How often the run asked whether to go on, and how long it worked (not waiting).
    checkIns: trace ? trace.checkIns || 0 : 0, activeSeconds: trace && trace.activeMs !== undefined ? Math.round(trace.activeMs / 1000) : null,
    // For comparing cost with the screenshot runner: tokens as the provider
    // reported them, and milliseconds spent reading the page, waiting for the
    // model, and acting.
    tokens: trace && trace.tokens ? trace.tokens : { prompt: 0, completion: 0 }, timing: trace ? trace.timing || null : null,
    history, log: log.slice(0, 6000),
  };
}

function report(rows) {
  const byTask = new Map();
  for (const r of rows) { if (!byTask.has(r.task)) byTask.set(r.task, []); byTask.get(r.task).push(r); }
  const lines = ["| task | passed | steps (passed) | endings |", "| --- | --- | --- | --- |"];
  let pass = 0;
  for (const [task, rs] of [...byTask.entries()].sort()) {
    const ok = rs.filter((r) => r.success);
    pass += ok.length;
    const endings = {};
    for (const r of rs) endings[r.ending] = (endings[r.ending] || 0) + 1;
    lines.push(`| ${task} | ${ok.length}/${rs.length} | ${ok.map((r) => r.steps).join(", ") || "-"} | ${Object.entries(endings).map(([k, v]) => `${k} ${v}`).join("; ")} |`);
  }
  const scored = rows.filter((r) => !r.lost).length;
  lines.push("", `${pass} of ${scored} episodes passed (${scored ? Math.round(100 * pass / scored) : 0}%) across ${byTask.size} tasks.`);
  if (scored < rows.length) lines.push(`${rows.length - scored} episode(s) were lost to the provider's limit and are left out of the rate.`);
  const text = lines.join("\n");
  console.log(`\n${text}`);
  fs.writeFileSync(path.join(OUT, "report.md"), text);
}

// The screenshot runner (miniwob-vision.js) uses the same task list and server.
module.exports = { DEFAULT_TASKS, serve };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
