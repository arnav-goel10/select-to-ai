/**
 * Recipes inside Playwright Test.
 *
 * The recipe is recorded once from the script you already have (here, in
 * beforeAll; in a real suite you would commit the .recipe.json and only
 * record again when you mean to). Every test replays it and asserts on the
 * receipt, so a test fails with the receipt's reason: which step, what
 * changed, and what the server showed. The receipt is attached to the report.
 *
 * Run from packages/recipes:
 *   npx playwright test -c examples/playwright-test
 * Repair and the meaning check use Claude when ANTHROPIC_API_KEY is set;
 * without it, any changed step stops the run (and the test fails) instead.
 */
import { test, expect } from "@playwright/test";
import { record, replay, toMarkdown } from "../../index.js";
import { anthropicModel } from "../../anthropic.js";
import { startApp } from "../demo/app.js";

let app, recipe;

// Your existing Playwright steps, unchanged.
async function saveDraft(page, base, { note }) {
  await page.goto(`${base}/draft`);
  await page.fill("#note", note);
  await page.click("#save");
  await page.click("#confirm");
}

test.beforeAll(async ({ browser }) => {
  app = await startApp();
  const page = await browser.newPage();
  recipe = await record(page, (r) => saveDraft(r.page, app.url, { note: "Recorded note" }), {
    vars: { note: "Recorded note" },
    title: "Save the draft with the note {note}",
  });
  await page.close();
});

test.afterAll(async () => { await app?.close(); });

const repair = process.env.ANTHROPIC_API_KEY ? { model: anthropicModel() } : false;

async function run(page, testInfo, note) {
  const receipt = await replay(page, recipe, { vars: { note }, repair });
  await testInfo.attach("receipt.md", { body: toMarkdown(receipt), contentType: "text/markdown" });
  return receipt;
}

test("saves a draft, proven step by step", async ({ page }, testInfo) => {
  await app.setSite("original");
  const receipt = await run(page, testInfo, "Ship it Friday");
  expect(receipt.end.state, receipt.end.why).toBe("done_proven");
  expect((await app.truth()).note).toBe("Ship it Friday");
});

test("a dialog that now publishes stops the run instead of clicking through", async ({ page }, testInfo) => {
  await app.setSite("publish");
  const receipt = await run(page, testInfo, "Ship it Friday");
  // needs_you: a person should look. Nothing was sent.
  expect(receipt.end.state).not.toBe("done_proven");
  expect((await app.truth()).events).toEqual([]);
});
