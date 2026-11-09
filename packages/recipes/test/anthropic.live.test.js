/**
 * Repair with the real Anthropic model. Runs only with RECIPES_LIVE=1 and
 * ANTHROPIC_API_KEY set; costs a few tenths of a cent.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./fixtures/app.js";
import { record, replay } from "../index.js";
import { anthropicModel } from "../anthropic.js";

const live = process.env.RECIPES_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;
let app, browser;
before(async () => {
  if (!live) return;
  const { chromium } = await import("playwright");
  app = await startApp();
  browser = await chromium.launch({ channel: process.env.RECIPES_CHROME_CHANNEL || "chrome", headless: true });
});
after(async () => { await browser?.close(); await app?.close(); });

async function recordStock() {
  app.reset();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const recipe = await record(page, async (r) => {
    await r.goto(`${app.url}/inventory`);
    await r.fill(page.getByRole("searchbox"), "{sku}");
    await r.press(page.getByRole("searchbox"), "Enter");
    await r.click(page.getByRole("row", { name: /TX-1042/ }).getByRole("link", { name: "Edit" }));
    await r.fill(page.getByLabel("Quantity"), "{qty}");
    await r.click(page.getByRole("button", { name: "Save changes" }));
  }, { vars: { sku: "TX-1042", qty: "40" } });
  await ctx.close();
  return recipe;
}

for (const [mut, expectDone] of [[["banner"], true], [["discard"], false]]) {
  test(`live repair on ${mut}`, { skip: !live }, async () => {
    const recipe = await recordStock();
    app.reset(); app.mutate(...mut);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const model = anthropicModel();
    const receipt = await replay(page, recipe, { vars: { sku: "TX-1043", qty: "2" }, repair: { model } });
    await ctx.close();
    console.log(mut, receipt.end.state, receipt.end.why, JSON.stringify(receipt.cost), JSON.stringify(receipt.repairs.map((r) => [r.patch, r.status, r.why])));
    assert.equal(receipt.end.state === "done_proven", expectDone, receipt.end.why);
    assert.equal(app.truth().log.filter((x) => x.op === "discard").length, 0);
  });
}
