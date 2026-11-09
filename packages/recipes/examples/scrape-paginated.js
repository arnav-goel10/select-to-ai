#!/usr/bin/env node
/**
 * Scrape values from a paginated list.
 *
 *   node examples/scrape-paginated.js        (from packages/recipes)
 *
 * The recording looks up one invoice that happens to be on page 2: it
 * presses Next once, then reads three cells from that invoice's row. Recipes
 * notices that the Next press only paged through the list, and stores it as
 * "page through until the row for {invoice} is shown". So the same recipe
 * finds invoices on page 1 or page 3 with no model call.
 *
 * Each lookup ends with a receipt. On the "thousands" version of the site,
 * the Amount column now reads "Amount (USD thousands)": the selector still
 * matches and plain Playwright would return "5.01" instead of "5,007.50". Recipes
 * stops on that column instead of returning a wrong number.
 */
import { chromium } from "playwright";
import { record, replay } from "../index.js";
import { anthropicModel } from "../anthropic.js";
import { startPortal } from "./fixtures/portal.js";

const app = await startPortal();
const browser = await chromium.launch();
const repair = process.env.ANTHROPIC_API_KEY ? { model: anthropicModel() } : false;

try {
  // 1. Record one lookup. "INV-1012" equals the variable, so the row becomes "the row for {invoice}".
  let page = await browser.newPage();
  const recipe = await record(page, async (r) => {
    await r.goto(`${app.url}/invoices`);
    await r.click(page.getByRole("link", { name: "Next" }));
    const row = page.getByRole("row").filter({ hasText: "INV-1012" });
    await r.read(row.getByRole("cell").nth(2), "due");
    await r.read(row.getByRole("cell").nth(3), "amount");
    await r.read(row.getByRole("cell").nth(4), "status");
  }, { vars: { invoice: "INV-1012" }, title: "Look up invoice {invoice}" });
  await page.close();
  console.log(`recorded: ${recipe.steps.map((s) => s.intent).join(" -> ")}\n`);

  // 2. Replay it for invoices anywhere in the list.
  const lookup = async (invoice) => {
    const p = await browser.newPage();
    try { return await replay(p, recipe, { vars: { invoice }, repair }); } finally { await p.close(); }
  };
  const rows = [];
  for (const invoice of ["INV-1004", "INV-1012", "INV-1020"]) {
    const receipt = await lookup(invoice);
    const expected = app.invoices.find((x) => x.id === invoice);
    rows.push({ invoice, state: receipt.end.state, ...receipt.extracts, matchesServer: receipt.extracts.amount === expected.shown && receipt.extracts.status === expected.status, modelCalls: receipt.cost.modelCalls });
  }
  console.table(rows);

  // 3. The site changes what the column means.
  await app.setSite("thousands");
  const receipt = await lookup("INV-1012");
  console.log(`\nAmount column now in thousands: ${receipt.end.state}`);
  console.log(`  amount returned: ${receipt.extracts.amount ?? "(none)"}`);
  console.log(`  why: ${receipt.end.why}`);
} finally {
  await browser.close();
  await app.close();
}
