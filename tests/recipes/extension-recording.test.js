// Recording a recipe from the agent's own actions (extension/recipes/service.js):
// each action is carried out exactly as the agent would (its content script,
// by its numbers for the controls), and the recorder turns it into a step.
// The agent's run is played here by hand: a scan for the page's controls,
// then the actions a model would choose. Real Chromium; chrome.* is a
// stand-in over the page (chrome-over-page.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { startApp } from "../../packages/recipes/test/fixtures/app.js";
import { chromeOver, EXT } from "./chrome-over-page.js";

const require = createRequire(import.meta.url);
for (const f of ["defaults.js", "security.js", "agentTools.js", "core/policy.js", "recipes/vendor/recipes-core.js", "recipes/driver.js"]) require(`${EXT}/${f}`);
const RECIPES = require(`${EXT}/recipes/service.js`);
const CORE = globalThis.SELECT_TO_AI_RECIPES_CORE;
const DRIVER = globalThis.SELECT_TO_AI_RECIPES_DRIVER;

let app, browser;
before(async () => {
  app = await startApp();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); });

/** An agent session on one tab of a fresh page, with what the agent saw (a scan) as session.page. */
async function agentOn(url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const chrome = await chromeOver(page);
  await page.goto(url);
  const session = { run: { id: `r${Math.random().toString(36).slice(2)}`, tabId: 1, task: "Set the stock of TX-1042" }, page: null };
  const look = async () => {
    await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["agentTools.js", "agentContentScript.js"] });
    session.page = await chrome.tabs.sendMessage(1, { action: "scan", limit: 500, task: "", whole: true });
    session.page.url = page.url();
    return session.page;
  };
  const id = (re) => { const e = session.page.elements.find((x) => re.test(x.accName || x.text || "")); assert.ok(e, `no control ${re}`); return e.id; };
  // An agent action as the engine carries it out: through the content script, by the control's number.
  const perform = (a) => async () => {
    if (a.do === "navigate") { await chrome.tabs.update(1, { url: a.url }); return { ok: true, message: "Opened" }; }
    const data = a.do === "click" ? { action: "click", id: a.ref } : a.do === "fill" ? { action: "fill", id: a.ref, value: a.value } : { action: "keypress", id: a.ref, text: a.key };
    const r = await chrome.tabs.sendMessage(1, { action: "interact", data }).catch(() => undefined);
    return r === undefined ? { ok: true, message: "The page changed." } : { ok: !!r.success, message: r.message || r.error || "" };
  };
  const act = async (a) => { const r = await RECIPES.around(session, a, perform(a)); await look(); return r; };
  RECIPES.begin(session.run, chrome);
  await look();
  return { ctx, page, chrome, session, id, act, look };
}

test("an agent's run is recorded step by step and compiles into a recipe that replays", async () => {
  app.reset();
  const a = await agentOn(`${app.url}/inventory`);
  assert.equal((await a.act({ do: "fill", ref: a.id(/Search SKU/), value: "TX-1042" })).ok, true);
  await a.act({ do: "press", ref: a.id(/Search SKU/), key: "Enter" });
  await a.act({ do: "click", ref: a.session.page.elements.find((e) => /Edit/.test(e.accName || e.text) && e.url && /\/items\/41\//.test(e.url)).id });
  await a.act({ do: "fill", ref: a.id(/^Quantity/), value: "40" });
  await a.act({ do: "click", ref: a.id(/Save changes/) });
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 40, "the agent's own actions happened");
  a.session.run.outcome = { state: "success" };
  RECIPES.end(a.session.run);
  const can = RECIPES.saveable(a.session.run.id);
  assert.equal(can.ok, true, can.why);
  const recipe = RECIPES._recordings.get(a.session.run.id).rec.compile();
  await a.ctx.close();
  assert.ok(CORE.validate(recipe).ok, CORE.validate(recipe).errors.join("; "));
  assert.deepEqual(recipe.steps.map((s) => `${s.action.do}:${s.class}`), ["navigate:read", "fill:read", "press:read", "click:read", "fill:edit", "click:commit"]);
  assert.deepEqual(recipe.variables.map((v) => [v.name, v.example]), [["search_sku_or_name", "TX-1042"], ["quantity", "40"]]);
  assert.equal(recipe.steps[3].target.scope.contains, "{search_sku_or_name}");

  // Replayed through the extension driver with other values, with no model.
  app.reset();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const driver = DRIVER.createDriver({ chrome: await chromeOver(page), tabId: 1 });
  const { receipt } = await CORE.runReplay(driver, recipe, { vars: { search_sku_or_name: "BR-2001", quantity: "21" } });
  await ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(app.truth().items.find((i) => i.sku === "BR-2001").qty, 21);
});

test("a press the agent's own risk checks hold as sending is recorded as a commit step", async () => {
  app.reset();
  const a = await agentOn(`${app.url}/items/41/edit`);
  // A plain button that sends no form, named for what it does to the item.
  await a.page.evaluate(() => { const b = document.createElement("button"); b.type = "button"; b.textContent = "Delete item"; b.onclick = () => { document.querySelector("h1").textContent = "Item deleted"; }; document.querySelector("main").appendChild(b); });
  await a.look();
  await a.act({ do: "click", ref: a.id(/Delete item/) });
  a.session.run.outcome = { state: "success" };
  RECIPES.end(a.session.run);
  const recipe = RECIPES._recordings.get(a.session.run.id).rec.compile();
  await a.ctx.close();
  assert.equal(recipe.steps[1].class, "commit");
});

test("with no view of requests, a script-driven button outside a form is recorded as a commit step", async () => {
  app.reset();
  const a = await agentOn(`${app.url}/items/41/edit`);
  // Plain words the agent's own risk checks pass, no form, a script behind
  // it: whether it saved anything is not something this recording can see.
  await a.page.evaluate(() => { const b = document.createElement("button"); b.type = "button"; b.textContent = "Apply"; b.onclick = () => { document.querySelector("h1").textContent = "Applied"; }; document.querySelector("main").appendChild(b); });
  await a.look();
  await a.act({ do: "click", ref: a.id(/^Apply$/) });
  a.session.run.outcome = { state: "success" };
  RECIPES.end(a.session.run);
  const recipe = RECIPES._recordings.get(a.session.run.id).rec.compile();
  await a.ctx.close();
  assert.deepEqual(recipe.steps.map((s) => `${s.action.do}:${s.class}`), ["navigate:read", "click:commit"]);
});

test("what a recipe cannot repeat is said, and the agent's action still happens", async () => {
  app.reset();
  const a = await agentOn(`${app.url}/inventory`);
  let ran = false;
  const r = await RECIPES.around(a.session, { do: "drag", ref: 3, to_ref: 4 }, async () => { ran = true; return { ok: true, message: "Dragged." }; });
  assert.equal(r.ok, true);
  assert.equal(ran, true);
  a.session.run.outcome = { state: "success" };
  RECIPES.end(a.session.run);
  assert.deepEqual(RECIPES.saveable(a.session.run.id), { ok: false, why: "it used drag, which a recipe cannot repeat" });
  // A run that did not succeed cannot be saved; one that read only has nothing to repeat.
  const b = await agentOn(`${app.url}/inventory`);
  await RECIPES.around(b.session, { do: "scroll", direction: "down" }, async () => ({ ok: true }));
  b.session.run.outcome = { state: "success" };
  RECIPES.end(b.session.run);
  assert.equal(RECIPES.saveable(b.session.run.id).ok, false);
  assert.match(RECIPES.saveable(b.session.run.id).why, /nothing on a page/);
  const c = await agentOn(`${app.url}/inventory`);
  await c.act({ do: "fill", ref: c.id(/Search SKU/), value: "x" });
  c.session.run.outcome = { state: "error" };
  RECIPES.end(c.session.run);
  assert.match(RECIPES.saveable(c.session.run.id).why, /did not finish/);
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
});

test("the user's saved details are never recorded: such a run cannot be saved", async () => {
  app.reset();
  const a = await agentOn(`${app.url}/items/41/edit`);
  let ran = false;
  await RECIPES.around(a.session, { do: "fill", ref: a.id(/^Name/), from: "full_name" }, async () => { ran = true; return { ok: true }; });
  assert.equal(ran, true);
  a.session.run.outcome = { state: "success" };
  RECIPES.end(a.session.run);
  assert.match(RECIPES.saveable(a.session.run.id).why, /saved details/);
  await a.ctx.close();
});

test("the repair model is the user's provider on its lite tier, through the extension's own client", async () => {
  const seen = [];
  const client = { call: async (req, cfg) => { seen.push({ req, cfg }); return { reply: { same: "same", why: "ok" }, usage: { prompt: 900, completion: 40, cost: 0.0001, model: "claude-haiku-5-5" } }; } };
  const cfg = { provider: "anthropic", model: "claude-sonnet-5-5", liteModel: "claude-haiku-5-5", keyProblem: "" };
  const m = RECIPES.modelFrom(cfg, { client });
  const out = await m.complete({ system: "s", user: "u", schema: { type: "object", properties: { same: { type: "string" } } } });
  assert.equal(seen[0].req.tier, "lite");
  assert.equal(seen[0].req.tool.parameters.properties.same.type, "string");
  assert.deepEqual(out, { json: { same: "same", why: "ok" }, usage: { provider: "anthropic", model: "claude-haiku-5-5", inTok: 900, outTok: 40, usd: 0.0001 } });
  assert.equal(RECIPES.modelFrom({ ...cfg, keyProblem: "no key" }, { client }), null, "no model without a working key: repair is off");
});
