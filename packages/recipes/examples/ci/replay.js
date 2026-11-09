#!/usr/bin/env node
/**
 * Replay one saved recipe and keep the receipt. Built for CI.
 *
 *   node examples/ci/replay.js <name.recipe.json> [vars.json] [--out receipts]
 *
 * - Values come from vars.json. Secrets come from the environment:
 *   RECIPE_VAR_password=... becomes the variable "password".
 * - Writes <out>/<name>.receipt.json and <name>.receipt.md, and appends the
 *   Markdown to the GitHub job summary when $GITHUB_STEP_SUMMARY is set.
 * - After a verified repair it also writes <out>/<name>.recipe.json, the new
 *   version, for you to review and commit. It never edits your committed file.
 * - Exits 0 only when the receipt says done_proven.
 *
 * Repair and the meaning check use Claude when ANTHROPIC_API_KEY is set.
 * Without it, any changed step stops the run, which is a safe default in CI.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { replay, headline, toMarkdown, validate } from "@recipes/core";
import { anthropicModel } from "@recipes/core/anthropic";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : "receipts";
const [recipeFile, varsFile] = args;
if (!recipeFile) {
  console.error("usage: node replay.js <name.recipe.json> [vars.json] [--out receipts]");
  process.exit(2);
}

const recipe = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
const check = validate(recipe);
if (!check.ok) {
  console.error(`${recipeFile} is not a valid recipe:\n  ${check.errors.slice(0, 10).join("\n  ")}`);
  process.exit(2);
}
const vars = varsFile ? JSON.parse(fs.readFileSync(varsFile, "utf8")) : {};
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("RECIPE_VAR_")) vars[k.slice(11)] = v;

const name = path.basename(recipeFile).replace(/\.recipe\.json$|\.json$/, "");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
let receipt;
try {
  const page = await browser.newPage();
  receipt = await replay(page, recipe, {
    vars,
    repair: process.env.ANTHROPIC_API_KEY ? { model: anthropicModel() } : false,
  });
} finally {
  await browser.close();
}

const md = toMarkdown(receipt);
fs.writeFileSync(path.join(out, `${name}.receipt.json`), JSON.stringify({ ...receipt, recipe: undefined }, null, 2));
fs.writeFileSync(path.join(out, `${name}.receipt.md`), md);
if (receipt.healed) fs.writeFileSync(path.join(out, `${name}.recipe.json`), JSON.stringify(receipt.recipe, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);

console.log(headline(receipt));
if (receipt.healed) console.log(`repaired and verified; the new version is in ${path.join(out, `${name}.recipe.json`)} for review`);
process.exit(receipt.end.state === "done_proven" ? 0 : 1);
