#!/usr/bin/env node
/**
 * Record the recipe that the CI example replays, and save it next to this
 * file. Run it again only when you mean to change what the recipe does.
 *
 *   node examples/ci/record.js        (from packages/recipes)
 *
 * It records against the example portal on a fixed port (4317), because a
 * recipe is tied to the site it was recorded on. In your own repo, record
 * against your real site (or staging) instead and commit the .recipe.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { record } from "@recipes/core";
import { startPortal } from "../fixtures/portal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = await startPortal({ port: 4317 });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const recipe = await record(page, async (r) => {
    await r.goto(`${app.url}/invoices`);
    await r.click(page.getByRole("link", { name: "Next" }));
    const row = page.getByRole("row").filter({ hasText: "INV-1012" });
    await r.read(row.getByRole("cell").nth(3), "amount");
    await r.read(row.getByRole("cell").nth(4), "status");
  }, { vars: { invoice: "INV-1012" }, title: "Check the amount and status of invoice {invoice}" });
  const file = path.join(here, "invoice-status.recipe.json");
  fs.writeFileSync(file, `${JSON.stringify(recipe, null, 2)}\n`);
  console.log(`recorded ${recipe.steps.length} steps to ${path.relative(process.cwd(), file)}`);
} finally {
  await browser.close();
  await app.close();
}
