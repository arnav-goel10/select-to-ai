#!/usr/bin/env node
/**
 * Log in and submit a form.
 *
 *   node examples/login-form.js              (from packages/recipes)
 *
 * Records an ordinary Playwright script once (sign in, fill an expense
 * claim, submit), then replays it with new values on three versions of the
 * site, and prints what the server really recorded each time:
 *
 *   original   unchanged                        -> done_proven, no model call
 *   cosmetic   ids renamed, labels reworded     -> repaired with a model, or needs_you without one
 *   instant    "Submit claim" now pays it out   -> needs_you; nothing is submitted
 *
 * The password is never written into the recipe. record() hands it back in
 * `secrets`; you pass it in again at replay, from your own secret store.
 * Set ANTHROPIC_API_KEY to let cosmetic changes be repaired.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { record, replay, headline } from "../index.js";
import { anthropicModel } from "../anthropic.js";
import { startPortal } from "./fixtures/portal.js";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out");

// Your existing Playwright steps, unchanged.
async function submitClaim(page, base, { email, password, amount, category, description }) {
  await page.goto(`${base}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.fill("#amount", amount);
  await page.selectOption("#category", category);
  await page.fill("#desc", description);
  await page.click("#submit");
}

const app = await startPortal();
const browser = await chromium.launch();
fs.mkdirSync(OUT, { recursive: true });

try {
  // 1. Record once. Literal values equal to a var become variables.
  const vars = { email: app.user.email, amount: "42.50", category: "Travel", description: "Taxi to the airport" };
  const secrets = {};
  let page = await browser.newPage();
  const recipe = await record(page, (r) => submitClaim(r.page, app.url, { ...vars, password: app.user.password }), {
    vars, secrets, title: "Submit a {category} claim for {amount} USD",
  });
  await page.close();
  fs.writeFileSync(path.join(OUT, "claim.recipe.json"), JSON.stringify(recipe, null, 2));
  console.log(`recorded ${recipe.steps.length} steps; secrets kept out of the recipe: ${Object.keys(secrets).join(", ")}`);
  for (const s of recipe.steps) console.log(`  ${s.id.padEnd(4)} ${s.class.padEnd(7)} ${s.intent}`);

  // 2. Replay with new values on each version of the site.
  const repair = process.env.ANTHROPIC_API_KEY ? { model: anthropicModel() } : false;
  const values = { email: app.user.email, amount: "18.20", category: "Meals", description: "Lunch with Contoso", ...secrets };
  for (const site of ["original", "cosmetic", "instant"]) {
    await app.setSite(site);
    page = await browser.newPage();
    const receipt = await replay(page, recipe, { vars: values, repair });
    await page.close();
    fs.writeFileSync(path.join(OUT, `claim.${site}.receipt.json`), JSON.stringify({ ...receipt, recipe: undefined }, null, 2));
    const truth = await app.truth();
    console.log(`\n${site}: ${headline(receipt)}`);
    console.log(`  server recorded: ${truth.events.join(", ") || "nothing"}`);
    console.log(`  model calls: ${receipt.cost.modelCalls}`);
  }
  console.log(`\nreceipts in ${path.relative(process.cwd(), OUT)}/  (npx recipes receipt ${path.relative(process.cwd(), path.join(OUT, "claim.instant.receipt.json"))})`);
} finally {
  await browser.close();
  await app.close();
}
