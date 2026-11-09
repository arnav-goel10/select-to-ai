#!/usr/bin/env node
/**
 * recipes CLI.
 *
 *   npx recipes receipt <receipt.json>     pretty-print a receipt
 *   npx recipes receipt <receipt.json> --md   print it as Markdown
 *   npx recipes validate <recipe.json>     check a recipe file
 */
import fs from "node:fs";
import { headline, toMarkdown } from "./core/receipt.js";
import { validate } from "./core/schema.js";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1"), dim = c("2"), green = c("32"), red = c("31"), yellow = c("33");

const STATE = {
  done_proven: green("DONE, PROVEN"),
  done_unproven: yellow("FINISHED, NOT PROVEN"),
  needs_you: yellow("NEEDS YOU"),
  stopped: yellow("STOPPED"),
  failed: red("FAILED"),
};

function usage(code = 0) {
  console.log(`usage:
  recipes receipt <receipt.json> [--md]   pretty-print a receipt (replay() returns it; save it as JSON)
  recipes validate <recipe.json>          check a recipe against select-to-ai.recipe/1`);
  process.exit(code);
}

function load(file) {
  if (!file) usage(1);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) { lines.push(line); line = w; } else line = `${line} ${w}`.trim();
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? indent : "") + l).join("\n");
}

export function pretty(r) {
  const out = [];
  const width = Math.max(60, Math.min(110, (process.stdout.columns || 100) - 4));
  out.push(`${STATE[r.end.state] || r.end.state}  ${bold(r.request || "")}`);
  out.push(dim(`receipt ${r.id} · recipe ${r.recipeId} v${r.recipeVersion}${r.healed ? " · repaired, please review" : ""}`));
  if (r.variables && r.variables.length) out.push(dim(`values: ${r.variables.map((v) => `${v.name} = "${v.shown}"`).join(", ")}`));
  out.push("");
  for (const s of r.steps || []) {
    const mark = s.status === "ok" ? green("ok  ") : s.status === "already" ? dim("skip") : s.status === "skipped" ? dim("skip") : red("FAIL");
    const how = s.resolution ? dim(` [${s.resolution.method}${typeof s.resolution.score === "number" ? ` ${s.resolution.score}` : ""}]`) : "";
    out.push(`  ${mark} ${String(s.n).padStart(2)}. ${s.class === "commit" ? bold(s.intent) : s.intent}${how}`);
    for (const p of s.post || []) out.push(dim(`             ${p.held ? "held" : "FAILED"}: ${p.predicate}${p.observed ? ` (${String(p.observed).slice(0, 80)})` : ""}`));
    if (s.value !== undefined) out.push(dim(`             read: "${String(s.value).slice(0, 80)}"`));
  }
  if (r.repairs && r.repairs.length) {
    out.push("");
    out.push(bold("Repairs"));
    for (const x of r.repairs) out.push(`  step ${x.step}, ${x.patch}: ${x.status}. ${wrap(x.diffText || "", width - 4, "    ")}`);
  }
  out.push("");
  if (r.end.proof && r.end.proof.items && r.end.proof.items.length) {
    out.push(bold("Proof"));
    for (const p of r.end.proof.items) out.push(`  ${p.what}${p.quote ? dim(`: "${String(p.quote).slice(0, 100)}"`) : ""}`);
  } else {
    out.push(bold("Why it stopped"));
    out.push(`  ${wrap(r.end.why, width - 2, "  ")}`);
  }
  if (r.answer) { out.push(""); out.push(`${bold("Answer")} ${r.answer}`); }
  out.push("");
  const cost = r.cost || {};
  out.push(dim(`${cost.modelCalls || 0} model call${cost.modelCalls === 1 ? "" : "s"}, $${cost.usd || 0}${r.checks && r.checks.drift ? ` · meaning checks: ${r.checks.drift}` : ""}`));
  return out.join("\n");
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") usage(0);
  if (cmd === "receipt") {
    const r = load(file);
    if (!r || !r.end || !r.steps) { console.error(`${file} is not a receipt (no "end" or "steps")`); process.exit(1); }
    console.log(rest.includes("--md") ? toMarkdown(r) : pretty(r));
    return;
  }
  if (cmd === "validate") {
    const v = validate(load(file));
    if (v.ok) console.log(green("valid recipe"));
    else { console.log(red("invalid recipe")); for (const e of v.errors.slice(0, 20)) console.log(`  ${e}`); process.exit(1); }
    return;
  }
  usage(1);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) main(process.argv.slice(2));

export { headline };
