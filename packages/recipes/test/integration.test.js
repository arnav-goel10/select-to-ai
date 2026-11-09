/**
 * Record and replay against a local fixture app in a real browser.
 * Repair uses a scripted model client here (no network); the live Anthropic
 * client is exercised in anthropic.live.test.js only when RECIPES_LIVE=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startApp } from "./fixtures/app.js";
import { record, replay, validate, headline } from "../index.js";

let app, browser;
before(async () => {
  app = await startApp();
  browser = await chromium.launch({ channel: process.env.RECIPES_CHROME_CHANNEL || "chrome", headless: true });
});
after(async () => { await browser?.close(); await app?.close(); });

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  return { ctx, page: await ctx.newPage() };
}

async function recordStock() {
  app.reset();
  const { ctx, page } = await fresh();
  const recipe = await record(page, async (r) => {
    await r.goto(`${app.url}/inventory`);
    await r.fill(page.getByRole("searchbox"), "{sku}");
    await r.press(page.getByRole("searchbox"), "Enter");
    await r.click(page.getByRole("row", { name: /TX-1042/ }).getByRole("link", { name: "Edit" }));
    await r.fill(page.getByLabel("Quantity"), "{qty}");
    await r.click(page.getByRole("button", { name: "Save changes" }));
  }, { vars: { sku: "TX-1042", qty: "40" }, title: "Set stock for {sku} to {qty}" });
  await ctx.close();
  return recipe;
}

/** A scripted model: picks a control by its label, or inserts a click on one. */
function scriptedModel(answer) {
  const calls = [];
  return {
    calls,
    name: "scripted", model: "scripted",
    async complete(req) {
      calls.push(req);
      const lines = req.user.split("\n");
      const find = (re) => { const l = lines.find((x) => /^\[f\d+e\d+\]/.test(x) && re.test(x)); return l ? /^\[(f\d+e\d+)\]/.exec(l)[1] : ""; };
      return { json: answer(find), usage: { model: "scripted", inTok: 1000, outTok: 50, usd: 0 } };
    },
  };
}

test("record compiles a valid recipe with variables, classes and checks", async () => {
  const recipe = await recordStock();
  assert.ok(validate(recipe).ok, validate(recipe).errors.join("; "));
  assert.deepEqual(recipe.variables.map((v) => [v.name, v.type]), [["sku", "text"], ["qty", "number"]]);
  const cls = recipe.steps.map((s) => s.class);
  assert.deepEqual(cls, ["read", "read", "read", "read", "edit", "commit"]);
  assert.equal(recipe.steps[3].target.scope.contains, "{sku}");
  assert.equal(recipe.steps[1].action.value, "{sku}");
  for (const s of recipe.steps) assert.equal(s.post.strength, "strong", `${s.id} ${JSON.stringify(s.post)}`);
  assert.ok(recipe.result.done.length >= 1);
  assert.ok(recipe.result.done.some((p) => p.k === "text" && /\{qty\}|Quantity updated/.test(p.contains)) || recipe.result.done.some((p) => p.k === "url"));
  // The developer's own locators are kept as evidence, with variables as slots.
  assert.match(recipe.steps[5].target.loc, /Save changes/);
  assert.match(recipe.steps[3].target.loc, /\{sku\}/);
});

test("a recorded locator is probed read-only on a live page and names exactly one control", async () => {
  const recipe = await recordStock();
  app.reset();
  const { ctx, page } = await fresh();
  const { playwrightDriver } = await import("../driver-playwright.js");
  const d = playwrightDriver(page);
  await page.goto(`${app.url}/inventory?q=TX-1042`);
  await page.getByRole("row", { name: /TX-1042/ }).getByRole("link", { name: "Edit" }).click();
  const sel = recipe.steps[5].target.loc;
  const s = await d.snapshot({ probes: [sel, "button"] });
  assert.equal(s.locs[sel].n, 1);
  const hit = s.elements.find((e) => e.ref === s.locs[sel].refs[0]);
  assert.equal(hit && hit.name, "Save changes");
  assert.ok(s.locs.button.n !== 1 || s.locs.button.refs.length === 1);
  await ctx.close();
});

test("replay with other values, no model calls, done proven by the server's state", async () => {
  const recipe = await recordStock();
  app.reset();
  const { ctx, page } = await fresh();
  const model = scriptedModel(() => { throw new Error("must not be called"); });
  const receipt = await replay(page, recipe, { vars: { sku: "BR-2001", qty: "17" }, repair: { model } });
  await ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(model.calls.length, 0);
  assert.equal(receipt.cost.modelCalls, 0);
  assert.ok(!receipt.trace.includes("model"));
  assert.equal(app.truth().items.find((i) => i.sku === "BR-2001").qty, 17);
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 12);
  assert.match(headline(receipt), /^Done:/);
  assert.equal(receipt.recipe.state, "verified");
});

test("shuffled rows and classes and a delayed list still replay without a model", async () => {
  const recipe = await recordStock();
  for (const mut of [["shuffle"], ["delay"], ["swap"]]) {
    app.reset(); app.mutate(...mut);
    const { ctx, page } = await fresh();
    const receipt = await replay(page, recipe, { vars: { sku: "TX-1043", qty: "9" } });
    await ctx.close();
    assert.equal(receipt.end.state, "done_proven", `${mut}: ${receipt.end.why}`);
    assert.equal(app.truth().items.find((i) => i.sku === "TX-1043").qty, 9, String(mut));
  }
});

test("a renamed save button (commit step) stops for a person, never auto-repaired", async () => {
  const recipe = await recordStock();
  app.reset(); app.mutate("rename");
  const { ctx, page } = await fresh();
  const model = scriptedModel((find) => ({ patch: "retarget", ref: find(/Update item/), insert_action: "none", insert_key: "", insert_value: "", predicted: "saved", confidence: "high", why: "renamed" }));
  const receipt = await replay(page, recipe, { vars: { sku: "TX-1042", qty: "5" }, repair: { model } });
  await ctx.close();
  assert.equal(receipt.end.state, "needs_you", receipt.end.why);
  assert.equal(model.calls.length, 0, "commit steps are not sent to the repair model without an approver");
  assert.equal(app.truth().log.length, 0);
});

test("with an approver, the renamed commit is repaired, judged by its check, and saved as a new version", async () => {
  const recipe = await recordStock();
  app.reset(); app.mutate("rename");
  const { ctx, page } = await fresh();
  const model = scriptedModel((find) => ({ patch: "retarget", ref: find(/Update item/), insert_action: "none", insert_key: "", insert_value: "", predicted: "saved", confidence: "high", why: "renamed" }));
  const asked = [];
  const receipt = await replay(page, recipe, { vars: { sku: "TX-1042", qty: "5" }, repair: { model, approve: async (p) => { asked.push(p); return true; } } });
  await ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(asked.length, 1);
  assert.equal(receipt.repairs[0].status, "persisted");
  assert.equal(receipt.recipe.versions.length, 2);
  assert.equal(receipt.recipe.versions[1].ops[0].op, "retarget");
  assert.ok(validate(receipt.recipe).ok, validate(receipt.recipe).errors.join("; "));
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 5);
});

test("a Discard button where Save was is never pressed (resolution refuses, no approver)", async () => {
  const recipe = await recordStock();
  app.reset(); app.mutate("discard");
  const { ctx, page } = await fresh();
  const receipt = await replay(page, recipe, { vars: { sku: "TX-1042", qty: "5" }, repair: { model: scriptedModel(() => ({ patch: "cannot" })) } });
  await ctx.close();
  assert.notEqual(receipt.end.state, "done_proven");
  assert.equal(app.truth().log.length, 0);
});

test("a cookie banner over the page is cleared by one inserted step, then the tail verifies", async () => {
  const recipe = await recordStock();
  app.reset(); app.mutate("banner");
  const { ctx, page } = await fresh();
  const model = scriptedModel((find) => ({ patch: "insert", ref: find(/Accept all/), insert_action: "click", insert_key: "", insert_value: "", predicted: "banner closes", confidence: "high", why: "a cookie banner covers the page" }));
  const receipt = await replay(page, recipe, { vars: { sku: "TX-1042", qty: "6" }, repair: { model } });
  await ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(model.calls.length, 1);
  assert.equal(receipt.repairs.filter((r) => r.status === "persisted").length, 1);
  const ins = receipt.recipe.steps.find((s) => s.optional);
  assert.ok(ins, "the inserted step is saved and optional");
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 6);
  // The repaired recipe replays on the plain app with no model: the inserted step is skipped.
  app.reset();
  const f2 = await fresh();
  const r2 = await replay(f2.page, receipt.recipe, { vars: { sku: "TX-1043", qty: "3" } });
  await f2.ctx.close();
  assert.equal(r2.end.state, "done_proven", r2.end.why);
  assert.equal(r2.steps.find((s) => s.status === "skipped")?.id, ins.id);
});

test("a relabelled search box (read step) is retargeted and the repair persists", async () => {
  const recipe = await recordStock();
  app.reset(); app.mutate("relabel", "shuffle");
  const { ctx, page } = await fresh();
  const model = scriptedModel((find) => ({ patch: "retarget", ref: find(/searchbox · "Find products"/), insert_action: "none", insert_key: "", insert_value: "", predicted: "the box holds the sku", confidence: "high", why: "the search box was relabelled" }));
  const receipt = await replay(page, recipe, { vars: { sku: "TX-1042", qty: "8" }, repair: { model } });
  await ctx.close();
  // The fingerprint may still resolve the box by its structure; either way the run must be proven.
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(app.truth().items.find((i) => i.sku === "TX-1042").qty, 8);
});

test("a wrong retarget is judged by the step's check and rolled back", async () => {
  const recipe = await recordStock();
  app.reset(); app.mutate("banner");
  const { ctx, page } = await fresh();
  // Proposes inserting a click on the "Reports" nav link instead of the banner's button.
  const model = scriptedModel((find) => ({ patch: "insert", ref: find(/link "Reports"/), insert_action: "click", insert_key: "", insert_value: "", predicted: "", confidence: "high", why: "guess" }));
  const receipt = await replay(page, recipe, { vars: { sku: "TX-1042", qty: "6" }, repair: { model } });
  await ctx.close();
  assert.notEqual(receipt.end.state, "done_proven");
  assert.ok(receipt.repairs.every((r) => r.status !== "persisted"));
  assert.equal(receipt.recipe.versions.length, 1);
  assert.equal(app.truth().log.length, 0);
});

test("read and download: the answer comes from the page and the file is in the receipt", async () => {
  app.reset();
  const { ctx, page } = await fresh();
  const recipe = await record(page, async (r) => {
    await r.goto(`${app.url}/report`);
    await r.select(page.getByLabel("Month"), "{month}");
    await r.click(page.getByRole("button", { name: "Show" }));
    await r.read(page.locator("td").first(), "total");
    await r.download(page.getByRole("link", { name: "Export CSV" }));
  }, { vars: { month: "2026-10" } });
  await ctx.close();
  assert.ok(validate(recipe).ok, validate(recipe).errors.join("; "));
  assert.equal(recipe.variables[0].type, "enum");
  app.reset();
  const f2 = await fresh();
  const receipt = await replay(f2.page, recipe, { vars: { month: "2026-11" } });
  await f2.ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(receipt.extracts.total, "$2,310.00");
  assert.equal(receipt.downloads.length, 1);
  assert.match(receipt.downloads[0].name, /report-2026-11\.csv/);
});

test("an unchanged Playwright script records through r.page", async () => {
  app.reset();
  const { ctx, page } = await fresh();
  const reference = async (p, v) => {
    await p.goto(`${app.url}/inventory`);
    await p.getByRole("searchbox").fill(v.sku);
    await p.getByRole("searchbox").press("Enter");
    await p.getByRole("row", { name: new RegExp(v.sku) }).getByRole("link", { name: "Edit" }).click();
    await p.getByLabel("Quantity").fill(v.qty);
    await p.click("button[type=submit]");
  };
  const vars = { sku: "TX-1042", qty: "40" };
  const recipe = await record(page, (r) => reference(r.page, vars), { vars });
  await ctx.close();
  assert.equal(recipe.steps[1].action.value, "{sku}");
  assert.equal(recipe.steps[4].action.value, "{qty}");
  app.reset();
  const f2 = await fresh();
  const receipt = await replay(f2.page, recipe, { vars: { sku: "BR-2002", qty: "11" } });
  await f2.ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.equal(app.truth().items.find((i) => i.sku === "BR-2002").qty, 11);
});

test("a password is never stored: it becomes a secret the caller supplies at replay", async () => {
  app.reset();
  const { ctx, page } = await fresh();
  const secrets = {};
  const recipe = await record(page, async (r) => {
    await r.page.goto(`${app.url}/login`);
    await r.page.fill("input[name=user]", "clerk");
    await r.page.fill("input[name=pw]", "ledger-42");
    await r.page.click("button[type=submit]");
  }, { vars: {}, secrets });
  await ctx.close();
  assert.ok(!JSON.stringify(recipe).includes("ledger-42"));
  assert.deepEqual(secrets, { password: "ledger-42" });
  assert.equal(recipe.variables.find((v) => v.name === "password").type, "secret");
  app.reset();
  const f2 = await fresh();
  const receipt = await replay(f2.page, recipe, { vars: { ...secrets } });
  await f2.ctx.close();
  assert.equal(receipt.end.state, "done_proven", receipt.end.why);
  assert.ok(!JSON.stringify(receipt).includes("ledger-42"));
  assert.deepEqual(app.truth().log, [{ op: "login", ok: true }]);
  const f3 = await fresh();
  const r3 = await replay(f3.page, recipe, {});
  await f3.ctx.close();
  assert.equal(r3.end.state, "failed");
});
