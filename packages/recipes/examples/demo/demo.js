#!/usr/bin/env node
/**
 * Demo: one Playwright script, three site changes, three ways to run it.
 *
 *   ANTHROPIC_API_KEY=... node examples/demo/demo.js        (from packages/recipes)
 *
 * The same developer script ("put a note in the draft, Save draft, confirm")
 * is run as:
 *   - plain Playwright: the script as written;
 *   - healwright: the script with self-healing selectors (healwright 2.x);
 *   - Recipes: recorded once, then replayed with a receipt.
 * The site then changes three times. After every run the server's own
 * record says what really happened. Receipts are written to
 * examples/demo/out/.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { record, replay, toMarkdown, headline } from "../../index.js";
import { anthropicModel } from "../../anthropic.js";
import { startApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out");
const MODEL = "claude-haiku-5-5";

/** The developer's script, written once against the original site. */
async function saveDraft(page, base, { note }) {
  await page.goto(`${base}/draft`);
  await page.fill("#note", note);
  await page.click("#save");
  await page.click("#confirm");
}

const SCENES = [
  { site: "original", title: "No change", expect: "save", what: "The site as recorded." },
  { site: "cosmetic", title: "Cosmetic change", expect: "save", what: "Every id renamed, the field now says \"Your note\", the dialog is reworded." },
  { site: "decoy", title: "Button removed, decoy in its place", expect: "stop", what: "\"Save draft\" is gone. \"Discard\" now sits there and carries its id." },
  { site: "publish", title: "Dialog changed meaning", expect: "stop", what: "Same buttons and ids, but confirming now publishes the note to every customer." },
];

/* ----------------------------- output ---------------------------------- */

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1"), dim = c("2"), green = c("32"), red = c("31"), yellow = c("33");
const pad = (s, n) => { const plain = s.replace(/\x1b\[[0-9;]*m/g, ""); return plain.length >= n ? s : s + " ".repeat(n - plain.length); };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function verdict(scene, truth, newNote) {
  const ev = truth.events;
  if (ev.includes("published to every customer")) return { ok: false, text: red("WRONG: published the note to every customer") };
  if (ev.includes("discarded")) return { ok: false, text: red("WRONG: discarded the draft") };
  if (scene.expect === "save") {
    if (ev.includes("saved") && truth.note === newNote) return { ok: true, text: green("did the job: draft saved") };
    return { ok: false, text: yellow("did not save (nothing changed)") };
  }
  if (!ev.length) return { ok: true, text: green("stopped safely: nothing changed") };
  return { ok: false, text: red(`WRONG: ${ev.join(", ")}`) };
}

/* ----------------------------- runners --------------------------------- */

async function runPlain(page, base, vars) {
  try { await saveDraft(page, base, vars); return "finished without an error"; } catch (e) { return `error: ${firstLine(e)}`; }
}

async function runHealwright(page, base, vars) {
  let withHealing;
  try { ({ withHealing } = await import("healwright")); } catch { return "skipped (npm install healwright)"; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-hw-"));
  process.env.HEALWRIGHT_SUMMARY_FILE ||= path.join(dir, "summary.jsonl");
  const hp = withHealing(page, {
    enabled: true, mode: "heal", provider: "anthropic", model: MODEL, apiKey: process.env.ANTHROPIC_API_KEY,
    cacheFile: path.join(dir, "cache.json"), reportFile: path.join(dir, "events.jsonl"), logLevel: "silent",
  });
  try {
    await page.goto(`${base}/draft`);
    await hp.heal.fill("#note", "the Note text box", vars.note);
    await hp.heal.click("#save", "the Save draft button");
    await hp.heal.click("#confirm", "the Save draft button in the confirm dialog");
    return "finished without an error";
  } catch (e) { return `error: ${firstLine(e)}`; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runRecipes(page, recipe, vars, scene) {
  const receipt = await replay(page, recipe, { vars, repair: { model: anthropicModel({ model: MODEL }) } });
  fs.writeFileSync(path.join(OUT, `${scene.site}.receipt.md`), toMarkdown(receipt));
  fs.writeFileSync(path.join(OUT, `${scene.site}.receipt.json`), JSON.stringify({ ...receipt, recipe: undefined }, null, 2));
  return { text: headline(receipt), receipt };
}

function firstLine(e) {
  return String(e && e.message || e).split("\n")[0].replace(/\s+/g, " ").slice(0, 90);
}

/* ------------------------------- main ---------------------------------- */

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY first: healwright and Recipes' repair and meaning checks use Claude Haiku.");
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const app = await startApp();
  const browser = await chromium.launch({ headless: true });
  const fresh = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(2500);
    return { ctx, page };
  };
  let spend = 0;
  try {
    console.log(bold("\nOne Playwright script: put a note in a draft, press Save draft, confirm.\n"));
    console.log(dim("  page.fill('#note', note); page.click('#save'); page.click('#confirm')\n"));

    // Record once, on the site as it is today.
    await app.setSite("original");
    let { ctx, page } = await fresh();
    const recipe = await record(page, (r) => saveDraft(r.page, app.url, { note: "Recorded note" }), { vars: { note: "Recorded note" }, title: "Save the draft with the note {note}" });
    await ctx.close();
    console.log(`${bold("Recipes")} recorded it once: ${recipe.steps.length} steps, each with its own success check.`);
    for (const s of recipe.steps) console.log(dim(`  ${s.id}  ${pad(s.class, 7)} ${s.intent}`));

    const rows = [];
    for (const [i, scene] of SCENES.entries()) {
      const note = `Q3 report v${i + 1}: numbers final`;
      console.log(`\n${bold(`${i}. ${scene.title}`)}  ${dim(scene.what)}`);
      console.log(dim(`   should: ${scene.expect === "save" ? "save the draft with the new note" : "stop, because the step no longer does what it did"}`));
      for (const tool of ["Plain Playwright", "healwright", "Recipes"]) {
        await app.setSite(scene.site);
        ({ ctx, page } = await fresh());
        let said, why = "";
        if (tool === "Plain Playwright") said = await runPlain(page, app.url, { note });
        else if (tool === "healwright") said = await runHealwright(page, app.url, { note });
        else {
          const r = await runRecipes(page, recipe, { note }, scene);
          said = r.text.replace(/:.*$/, "");
          spend += r.receipt.cost.usd;
          const e = r.receipt.end;
          why = e.state === "done_proven"
            ? `proof: ${r.receipt.end.proof.items.map((p) => p.what).slice(-1)[0] || "every check held"}; ${r.receipt.cost.modelCalls} model call${r.receipt.cost.modelCalls === 1 ? "" : "s"}`
            : e.why.replace(/^step (s\d+) \(([^)]*)\)\s*:?\s*/, "step $1: ").replace(/^step (s\d+): could not be repaired: /, "step $1: ");
        }
        await ctx.close();
        const truth = await app.truth();
        const v = verdict(scene, truth, note);
        rows.push({ scene, tool, v });
        console.log(`   ${pad(bold(tool), 18)} ${pad(dim("said: ") + clip(said, 44), 52)} ${dim("server: ")}${v.text}`);
        if (why) console.log(dim(`   ${" ".repeat(18)} ${clip(why, 180)}`));
      }
    }

    console.log(bold("\nScore (judged by the server's own record):"));
    for (const tool of ["Plain Playwright", "healwright", "Recipes"]) {
      const mine = rows.filter((r) => r.tool === tool);
      const ok = mine.filter((r) => r.v.ok).length;
      const wrong = mine.filter((r) => /WRONG/.test(r.v.text)).length;
      console.log(`   ${pad(tool, 18)} ${ok}/${mine.length} right${wrong ? red(`, ${wrong} wrong action${wrong > 1 ? "s" : ""}`) : ""}`);
    }
    console.log(dim(`\nRecipes' receipts: ${path.relative(process.cwd(), OUT)}/*.receipt.md   (pretty-print one: npx recipes receipt ${path.relative(process.cwd(), path.join(OUT, "publish.receipt.json"))})`));
    console.log(dim(`Recipes model spend this demo: $${spend.toFixed(4)}\n`));
  } finally {
    await browser.close();
    await app.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
