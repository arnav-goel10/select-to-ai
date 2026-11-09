// Record a dev task, then open a page and print how a step's target ranks there.
//   node packages/recipes/tools/rank-debug.mjs <taskId> <stepId> <url-path> <varIdx>
import { chromium } from "playwright";
import { startServer } from "../../../bench/recipes/server.js";
import { TASKS } from "../../../bench/recipes/tasks/index.js";
import { record, rank } from "../index.js";
import { playwrightDriver } from "../driver-playwright.js";
import { resolve } from "../core/fingerprint.js";
const [taskId, stepId, urlPath, vi = "0"] = process.argv.slice(2);
const task = TASKS.find((t) => t.id === taskId);
const server = await startServer({});
const browser = await chromium.launch();
const mk = async (sid) => { const ctx = await browser.newContext({ baseURL: server.url, viewport: { width: 1200, height: 900 } }); await ctx.addCookies([{ name: "bsid", value: sid, url: server.url }]); return ctx.newPage(); };
const p1 = await mk(await server.newSession({ seed: 1234, mutation: null }));
const recipe = await record(p1, async (r) => { await task.reference(r.page, task.recordVars); }, { vars: task.recordVars });
const s = recipe.steps.find((x) => x.id === stepId);
console.log(JSON.stringify(s.target, null, 0).slice(0, 1500));
const p2 = await mk(await server.newSession({ seed: 999, mutation: null }));
await p2.goto(urlPath);
const d = playwrightDriver(p2);
const snap = await d.snapshot({ texts: true });
const vars = task.runVars[Number(vi)];
const res = resolve(s, snap, vars);
console.log(JSON.stringify({ ok: res.ok, reason: res.reason, score: res.score, margin: res.margin, ranked: res.ranked }, null, 0).slice(0, 2500));
await browser.close(); process.exit(0);
