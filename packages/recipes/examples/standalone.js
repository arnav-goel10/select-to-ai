#!/usr/bin/env node
/**
 * A standalone script: record a recipe once, save it, replay it later with
 * other values, and keep the receipt. Exit code 0 only when done is proven.
 *
 *   node examples/standalone.js record   # writes draft.recipe.json
 *   node examples/standalone.js replay "New note text"
 *
 * It drives the demo app in examples/demo/app.js, started here on a random
 * port; point `BASE` at your own site and replace saveDraft with your script.
 */
import fs from "node:fs";
import { chromium } from "playwright";
import { record, replay, headline } from "../index.js";
import { anthropicModel } from "../anthropic.js";
import { startApp } from "./demo/app.js";

const RECIPE = "draft.recipe.json";

async function saveDraft(page, base, { note }) {
  await page.goto(`${base}/draft`);
  await page.fill("#note", note);
  await page.click("#save");
  await page.click("#confirm");
}

const [cmd = "record", note = "Hello from a replay"] = process.argv.slice(2);
const app = await startApp();
const browser = await chromium.launch();
const page = await browser.newPage();
let code = 0;
try {
  if (cmd === "record") {
    const recipe = await record(page, (r) => saveDraft(r.page, app.url, { note: "Recorded note" }), {
      vars: { note: "Recorded note" }, title: "Save the draft with the note {note}",
    });
    fs.writeFileSync(RECIPE, JSON.stringify(recipe, null, 2));
    console.log(`recorded ${recipe.steps.length} steps to ${RECIPE}`);
  } else {
    // The recipe stores the address it was recorded on; this demo app gets a
    // new port each time, so point the recipe at it. (On your own site, skip this.)
    const text = fs.readFileSync(RECIPE, "utf8").replace(/http:\/\/127\.0\.0\.1:\d+/g, app.url);
    const recipe = JSON.parse(text);
    const receipt = await replay(page, recipe, {
      vars: { note },
      repair: process.env.ANTHROPIC_API_KEY ? { model: anthropicModel() } : false,
    });
    console.log(headline(receipt));
    fs.writeFileSync("draft.receipt.json", JSON.stringify({ ...receipt, recipe: undefined }, null, 2));
    fs.writeFileSync(RECIPE, JSON.stringify(receipt.recipe, null, 2)); // keeps a verified repair
    console.log("receipt: draft.receipt.json   (npx recipes receipt draft.receipt.json)");
    code = receipt.end.state === "done_proven" ? 0 : 1;
  }
} finally {
  await browser.close();
  await app.close();
}
process.exit(code);
