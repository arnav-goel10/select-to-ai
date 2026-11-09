// Runs one adapter in its own process, with its own browser. The harness
// (run.js) forks this with RECIPES_HELDOUT_DIR removed from the environment
// and talks to it over IPC. This process never learns which mutation a
// session carries: it only gets an opaque session cookie.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { TASKS, publicTask } from "./tasks/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_TIMEOUT_MS = Number(process.env.RECIPES_RUN_TIMEOUT_MS || 120000);

let adapter = null;
let browser = null;
let serverUrl = null;
const artifacts = new Map();
const tasks = new Map(TASKS.map((t) => [t.id, t]));

export async function loadAdapter(spec) {
  const [name, query = ""] = spec.split("?");
  const file = name.endsWith(".js") ? path.resolve(name) : path.join(here, "adapters", `${name}.js`);
  const mod = await import(pathToFileURL(file).href);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (query && typeof mod.configure !== "function") throw new Error(`${name} takes no parameters`);
  return query ? mod.configure(params) : mod.default;
}

async function withPage(sid, fn) {
  const context = await browser.newContext({ baseURL: serverUrl, acceptDownloads: true, viewport: { width: 1200, height: 900 } });
  await context.addCookies([{ name: "bsid", value: sid, url: serverUrl }]);
  context.setDefaultTimeout(5000);
  context.setDefaultNavigationTimeout(10000);
  const page = await context.newPage();
  const calls = [];
  const usage = { model: (provider, model, inTok, outTok, ms) => calls.push({ provider, model, inTok, outTok, ms }) };
  const t0 = Date.now();
  let timer;
  try {
    const out = await Promise.race([
      fn(page, usage),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("run timeout")), RUN_TIMEOUT_MS);
      }),
    ]);
    // Let in-flight requests (a download, an SPA POST) reach the server.
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
    return { out, calls, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}

async function handle(msg) {
  if (msg.cmd === "init") {
    adapter = await loadAdapter(msg.adapter);
    serverUrl = msg.serverUrl;
    browser = await chromium.launch({ headless: true });
    return { name: adapter.name };
  }
  if (msg.cmd === "prepare") {
    const task = tasks.get(msg.taskId);
    const baseUrl = `${serverUrl}/${task.app}/`;
    try {
      const r = await withPage(msg.sid, (page, usage) => adapter.prepare({ task: publicTask(task), page, baseUrl, reference: task.reference, usage }));
      artifacts.set(task.id, r.out);
      return { ok: true, calls: r.calls, ms: r.ms };
    } catch (err) {
      artifacts.set(task.id, undefined);
      return { ok: false, error: String(err.message || err).split("\n")[0] };
    }
  }
  if (msg.cmd === "run") {
    const task = tasks.get(msg.taskId);
    const baseUrl = `${serverUrl}/${task.app}/`;
    try {
      const r = await withPage(msg.sid, (page, usage) => adapter.run({ task: publicTask(task), page, baseUrl, artifact: artifacts.get(task.id), vars: msg.vars, usage }));
      const o = r.out || {};
      return { result: { claimedDone: !!o.claimedDone, answer: o.answer ?? null, healed: !!o.healed, error: o.error || null }, calls: r.calls, ms: r.ms };
    } catch (err) {
      return { result: { claimedDone: false, answer: null, healed: false, error: String(err.message || err).split("\n")[0] }, calls: [], ms: 0, crashed: true };
    }
  }
  if (msg.cmd === "close") {
    await browser?.close().catch(() => {});
    setTimeout(() => process.exit(0), 50);
    return {};
  }
  throw new Error(`unknown command ${msg.cmd}`);
}

if (process.send) {
  process.on("message", async (msg) => {
    try {
      process.send({ id: msg.id, ...(await handle(msg)) });
    } catch (err) {
      process.send({ id: msg.id, fatal: String(err.message || err) });
    }
  });
  process.on("disconnect", async () => {
    await browser?.close().catch(() => {});
    process.exit(0);
  });
}
