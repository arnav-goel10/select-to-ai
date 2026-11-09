// The extension's recipes driver (extension/recipes/driver.js) with the
// bundled core (extension/recipes/vendor/recipes-core.js), against the same
// fixture app and cases as packages/recipes/test/integration.test.js. The
// driver acts through the agent's real content script in Chromium; chrome.*
// is a stand-in over the page (chrome-over-page.js). Repair uses a scripted
// model here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { startApp } from "../../packages/recipes/test/fixtures/app.js";
import { chromeOver } from "./chrome-over-page.js";

const require = createRequire(import.meta.url);
const CORE = require("../../extension/recipes/vendor/recipes-core.js");
const DRIVER = require("../../extension/recipes/driver.js");

let app, browser;
before(async () => {
  app = await startApp();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); });

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const chrome = await chromeOver(page);
  const driver = DRIVER.createDriver({ chrome, tabId: 1, opts: { settleQuietMs: 120 } });
  return { ctx, page, chrome, driver };
}

async function recordStock() {
  app.reset();
  const { ctx, driver } = await fresh();
  const rec = new CORE.Recorder(driver, { vars: { sku: "TX-1042", qty: "40" }, title: "Set stock for {sku} to {qty}" });
  await rec.goto(`${app.url}/inventory`);
  await rec.fill("input[type=search]", "{sku}");
  await rec.press("input[type=search]", "Enter");
  await rec.click('a[href="/items/41/edit"]');
  await rec.fill("input[name=qty]", "{qty}");
  await rec.click("form[method=post] button[type=submit]");
  const recipe = rec.compile();
  await ctx.close();
  return recipe;
}

function scriptedModel(answer) {
  const calls = [];
  return {
    calls,
    name: "scripted", model: "scripted",
    async complete(req) {
      calls.push(req);
      const lines = req.user.split("\n");
      const find = (re) => { const l = lines.find((x) => /^\[f\d+e\d+\]/.test(x) && re.test(x)); return l ? /^\[(f\d+e\d+)\]/.exec(l)[1] : ""; };
      return { json: answer(find, req), usage: { model: "scripted", inTok: 1000, outTok: 50, usd: 0 } };
    },
  };
}

async function replayOn(recipe, vars, repair, mutate) {
  app.reset();
  if (mutate) app.mutate(...mutate);
  const { ctx, driver } = await fresh();
  const { receipt, recipe: next } = await CORE.runReplay(driver, recipe, { vars, repair });
  await ctx.close();
  return { ...receipt, recipe: next };
}

test("the bundled core records through the extension driver: valid recipe, variables, classes, checks", async () => {
  const recipe = await recordStock();
  assert.ok(CORE.validate(recipe).ok, CORE.validate(recipe).errors.join("; "));
  assert.deepEqual(recipe.variables.map((v) => [v.name, v.type]), [["sku", "text"], ["qty", "number"]]);
  assert.deepEqual(recipe.steps.map((s) => s.class), ["read", "read", "read", "read", "edit", "commit"]);
  assert.equal(recipe.steps[3].target.scope.contains, "{sku}");
  for (const s of recipe.steps) assert.equal(s.post.strength, "strong", `${s.id} ${JSON.stringify(s.post)}`);
  assert.ok(recipe.result.done.length >= 1);
  // A CSS selector is kept as evidence, like a Playwright locator.
  assert.match(recipe.steps[5].target.loc, /button/);
});

test("snapshots name controls the way the Playwright driver does", async () => {
  app.reset();
  const { ctx, page, driver } = await fresh();
  await driver.act({ do: "navigate", url: `${app.url}/items/41/edit` });
  const s = await driver.snapshot({ probes: ["form[method=post] button[type=submit]", "nope >>> bad"] });
  const save = s.elements.find((e) => e.name === "Save changes");
  assert.ok(save && /^f0e\d+$/.test(save.ref) && save.submits && save.form.method === "post");
  assert.equal(s.locs["form[method=post] button[type=submit]"].refs[0], save.ref);
  assert.deepEqual(s.locs["nope >>> bad"], { n: 0, refs: [] });
  // The agent's own number for a control it listed finds the same element.
  await page.addScriptTag({ path: `${DRIVER_PATH}/agentTools.js` });
  await page.addScriptTag({ path: `${DRIVER_PATH}/agentContentScript.js` });
  await page.evaluate(() => new Promise((r) => window.__s2aListener({ action: "scan", limit: 200, task: "", whole: true }, {}, r)));
  const agentId = await page.evaluate(() => window.__selectToAiIdOf([...document.querySelectorAll("button")].find((b) => /Save changes/.test(b.textContent))));
  const got = await driver.locate({ agentId });
  assert.equal(got.ref, save.ref);
  assert.equal(got.el.name, "Save changes");
  await ctx.close();
});
const DRIVER_PATH = new URL("../../extension", import.meta.url).pathname;

test("replay with other values makes no model call and is proven by the app's state", async () => {
  const recipe = await recordStock();
  const model = scriptedModel(() => { throw new Error("must not be called"); });
  const r = await replayOn(recipe, { sku: "BR-2001", qty: "17" }, { model });
  assert.equal(r.end.state, "done_proven", r.end.why);
  assert.equal(model.calls.length, 0);
  assert.equal(r.cost.modelCalls, 0);
  assert.equal(app.truth().items.find((i) => i.sku === "BR-2001").qty, 17);
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 12);
  assert.equal(r.recipe.state, "verified");
});

test("shuffled rows and classes, a delayed list and swapped buttons replay without a model", async () => {
  const recipe = await recordStock();
  for (const mut of [["shuffle"], ["delay"], ["swap"]]) {
    const r = await replayOn(recipe, { sku: "TX-1043", qty: "9" }, null, mut);
    assert.equal(r.end.state, "done_proven", `${mut}: ${r.end.why}`);
    assert.equal(app.truth().items.find((i) => i.sku === "TX-1043").qty, 9, String(mut));
  }
});

test("a renamed save button (commit) stops for a person; the repair model is not asked and nothing is saved", async () => {
  const recipe = await recordStock();
  const model = scriptedModel((find) => ({ patch: "retarget", ref: find(/Update item/), insert_action: "none", insert_key: "", insert_value: "", predicted: "saved", confidence: "high", why: "renamed" }));
  const r = await replayOn(recipe, { sku: "TX-1042", qty: "5" }, { model }, ["rename"]);
  assert.equal(r.end.state, "needs_you", r.end.why);
  assert.equal(model.calls.length, 0);
  assert.equal(app.truth().log.length, 0);
});

test("a Discard button where Save was is never pressed", async () => {
  const recipe = await recordStock();
  const r = await replayOn(recipe, { sku: "TX-1042", qty: "5" }, { model: scriptedModel(() => ({ patch: "cannot" })) }, ["discard"]);
  assert.notEqual(r.end.state, "done_proven");
  assert.equal(app.truth().log.length, 0);
});

test("a cookie banner is cleared by one inserted step under the step's check, and the repair is kept", async () => {
  const recipe = await recordStock();
  const model = scriptedModel((find) => ({ patch: "insert", ref: find(/Accept all/), insert_action: "click", insert_key: "", insert_value: "", predicted: "banner closes", confidence: "high", why: "a cookie banner covers the page" }));
  const r = await replayOn(recipe, { sku: "TX-1042", qty: "6" }, { model }, ["banner"]);
  assert.equal(r.end.state, "done_proven", r.end.why);
  assert.equal(model.calls.length, 1);
  assert.equal(r.repairs.filter((x) => x.status === "persisted").length, 1);
  assert.ok(r.recipe.steps.some((s) => s.optional));
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 6);
});

test("a relabelled search box (read step) is retargeted or resolved, and the run is proven", async () => {
  const recipe = await recordStock();
  const model = scriptedModel((find) => ({ patch: "retarget", ref: find(/searchbox · "Find products"/), insert_action: "none", insert_key: "", insert_value: "", predicted: "the box holds the sku", confidence: "high", why: "relabelled" }));
  const r = await replayOn(recipe, { sku: "TX-1042", qty: "8" }, { model }, ["relabel", "shuffle"]);
  assert.equal(r.end.state, "done_proven", r.end.why);
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 8);
});

test("a wrong insert is judged by the step's check and rolled back; nothing is saved", async () => {
  const recipe = await recordStock();
  const model = scriptedModel((find) => ({ patch: "insert", ref: find(/link "Reports"/), insert_action: "click", insert_key: "", insert_value: "", predicted: "", confidence: "high", why: "guess" }));
  const r = await replayOn(recipe, { sku: "TX-1042", qty: "6" }, { model }, ["banner"]);
  assert.notEqual(r.end.state, "done_proven");
  assert.ok(r.repairs.every((x) => x.status !== "persisted"));
  assert.equal(app.truth().log.length, 0);
});

test("act never throws: a ref that is gone, a bad ref and an unknown action come back as failures", async () => {
  app.reset();
  const { ctx, driver } = await fresh();
  await driver.act({ do: "navigate", url: `${app.url}/inventory` });
  assert.equal((await driver.act({ do: "click", ref: "f0e99999" })).ok, false);
  assert.equal((await driver.act({ do: "click", ref: "f2e1" })).ok, false);
  assert.equal((await driver.act({ do: "drag", ref: "f0e1" })).ok, false);
  await ctx.close();
});
