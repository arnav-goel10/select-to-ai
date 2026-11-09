// Debug one benchmark task on the DEV set: record on the unmutated app, replay
// with a run value set, optionally under a dev mutation, and print the receipt.
//   node packages/recipes/tools/bench-debug.mjs <taskId> [varIdx] [devMutationId] [--repair]
import { chromium } from "playwright";
import { startServer } from "../../../bench/recipes/server.js";
import { TASKS } from "../../../bench/recipes/tasks/index.js";
import { loadMutations } from "../../../bench/recipes/lib/mutations.js";
import { APPS } from "../../../bench/recipes/apps/index.js";
import { judge } from "../../../bench/recipes/lib/truth.js";
import adapter, { configure } from "../../../bench/recipes/adapters/recipes.js";
import { record, replay, toMarkdown } from "../index.js";
import { anthropicModel } from "../anthropic.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [taskId, vi = "0", mutId, ...rest] = process.argv.slice(2);
const repairOn = rest.includes("--repair") || mutId === "--repair";
const task = TASKS.find((t) => t.id === taskId);
const here = path.dirname(fileURLToPath(import.meta.url));
const muts = loadMutations({ devDir: path.join(here, "../../../bench/recipes/mutations/dev"), heldoutDir: null, tasks: TASKS, apps: APPS });
const m = mutId && mutId !== "--repair" ? muts.find((x) => x.id === mutId) : null;
if (mutId && mutId !== "--repair" && !m) throw new Error("no such dev mutation");
if (m && m.set !== "dev") throw new Error("dev only");
const server = await startServer({});
const browser = await chromium.launch({ headless: true });
async function page(sid) {
  const ctx = await browser.newContext({ baseURL: server.url, acceptDownloads: true, viewport: { width: 1200, height: 900 } });
  await ctx.addCookies([{ name: "bsid", value: sid, url: server.url }]);
  ctx.setDefaultTimeout(5000);
  return { ctx, page: await ctx.newPage() };
}
try {
  let sid = await server.newSession({ seed: 1234, mutation: null });
  let p = await page(sid);
  const secrets = {};
  const recipe = await record(p.page, async (r) => { await task.reference(r.page, task.recordVars); }, { vars: task.recordVars, secrets, title: task.goal });
  await p.ctx.close();
  for (const s of recipe.steps) console.log(s.id, s.class, s.action.do, JSON.stringify(s.action).slice(0, 80), "|", s.intent.slice(0, 60), "| post:", s.post.all.map((x) => x.k + (x.contains ? `(${x.contains})` : "")).join(","), s.ctx ? JSON.stringify(s.ctx).slice(0, 300) : "");
  const vars = task.runVars[Number(vi)];
  sid = await server.newSession({ seed: 999, mutation: m || null });
  p = await page(sid);
  const receipt = await replay(p.page, recipe, { vars: { ...vars, ...secrets }, repair: repairOn ? { model: anthropicModel() } : false });
  await p.ctx.close();
  console.log(toMarkdown(receipt)); console.log(JSON.stringify(receipt.repairs.map(r=>[r.patch,r.status,r.observed])));
  for (const s of receipt.steps) if (s.resolution && s.resolution.ranked) console.log(s.id, JSON.stringify(s.resolution.ranked.slice(0, 3)));
  const truth = await server.truth(sid);
  const names = (recipe.result.extract || []).map((x) => x.name);
  const res = { claimedDone: receipt.end.state === "done_proven", answer: names.length ? receipt.extracts[names[names.length - 1]] : null, healed: receipt.healed };
  console.log("JUDGE", JSON.stringify(judge(task, truth, res, m ? m.expected : null, vars)));
} catch (e) { console.log('ERROR', e && e.stack || e); } finally {
  await browser.close();
  await server.close?.();
  process.exit(0);
}
