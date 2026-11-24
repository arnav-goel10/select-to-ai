/**
 * The page-blind press check against a live model, the way the engine asks
 * it: each group of press-cases.js is one page's batch, built by
 * agentTools.js labelsMessages, sent through the engine's own model client
 * (core/llm.js createClient, with the same request, streaming and retries)
 * and read by readLabels.
 *
 *   PRESS_EVAL_KEY=... node tests/decisions/press-eval.js
 *
 * Env:
 *   PRESS_EVAL_KEY       the provider key (never printed)
 *   PRESS_EVAL_PROVIDER  provider id as in Settings (default anthropic), or
 *                        "custom" for an OpenAI-compatible endpoint
 *   PRESS_EVAL_BASE_URL  with custom: its base URL (NVIDIA NIM's free tier:
 *                        https://integrate.api.nvidia.com/v1)
 *   PRESS_EVAL_MODEL     model id (default claude-haiku-5-5)
 *   PRESS_EVAL_REPEAT    times each group is asked (default 3)
 *   PRESS_EVAL_CAP_USD   hard spend cap for the run (default 1). A call is
 *                        not made when its worst case would pass the cap.
 *   PRESS_EVAL_ONLY      comma-separated group names
 *   PRESS_EVAL_REPORT    write a JSON report here
 *
 * Prints each control's verdict, then false holds (an ordinary control
 * held), missed holds (a committing control let through), the batch
 * latency against the engine's 6 s wait, and what the run cost.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const EXT = path.resolve(__dirname, "../../extension");
const TOOLS = require(path.join(EXT, "agentTools.js"));
const D = require(path.join(EXT, "defaults.js"));
const LLM = require(path.join(EXT, "core/llm.js"));
const { PRESS_CASES } = require("./press-cases.js");

const PROVIDER = process.env.PRESS_EVAL_PROVIDER || "anthropic";
const MODEL = process.env.PRESS_EVAL_MODEL || "claude-haiku-5-5";
const KEY = process.env.PRESS_EVAL_KEY || "";
const REPEAT = Math.max(1, parseInt(process.env.PRESS_EVAL_REPEAT || "3", 10));
const CAP = Math.max(0, parseFloat(process.env.PRESS_EVAL_CAP_USD || "1"));
const ONLY = (process.env.PRESS_EVAL_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
// What the engine waits for a page's batch before asking a press alone (run.js LABELS_WAIT_MS).
const BATCH_WAIT_MS = 6000;

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const pct = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "n/a");

/**
 * The most one call could cost: every prompt character a token, the
 * model's whole reply room, and the engine's two re-asks of a reply it
 * cannot use (llm.js call), so a call never passes the cap.
 */
function worstCost(m) {
  const [inRate, outRate] = D.findModelRates(MODEL) || [0, 0];
  const promptTokens = m.system.length + m.user.length + JSON.stringify(m.tool).length;
  const outTokens = D.modelProfile(MODEL).maxTokens || 4096;
  return 3 * ((promptTokens / 1000) * inRate + (outTokens / 1000) * outRate);
}

async function main() {
  if (!KEY) { console.error("Set PRESS_EVAL_KEY."); process.exit(1); }
  if (!D.findModelRates(MODEL)) { console.error(`No price is known for ${MODEL}, so the spend cap cannot be kept.`); process.exit(1); }
  const custom = PROVIDER === "custom";
  const entry = custom ? { keyName: "agentCustomKey" } : (D.PROVIDER_ENDPOINTS || {})[PROVIDER];
  if (!entry) { console.error(`Unknown provider ${PROVIDER}.`); process.exit(1); }
  if (custom && !process.env.PRESS_EVAL_BASE_URL) { console.error("Set PRESS_EVAL_BASE_URL for a custom provider."); process.exit(1); }
  const cfg = LLM.settingsFrom({ agentActiveProvider: PROVIDER, [entry.keyName]: KEY, agentModel: MODEL, ...(custom ? { agentCustomUrl: process.env.PRESS_EVAL_BASE_URL } : {}) }, Date.now());
  if (cfg.keyProblem) { console.error(cfg.keyProblem); process.exit(1); }
  const client = LLM.createClient({ fetch: (...a) => fetch(...a) });
  const groups = PRESS_CASES.filter((g) => !ONLY.length || ONLY.includes(g.name));
  console.log(`Press check eval: ${groups.length} pages x ${REPEAT} on ${PROVIDER}/${cfg.model}, cap $${CAP.toFixed(2)}\n`);

  let spent = 0;
  let capped = false;
  const batches = [];
  const rows = [];
  for (let r = 0; r < REPEAT && !capped; r++) {
    for (const g of groups) {
      const m = TOOLS.labelsMessages(g.entries, g.url);
      if (spent + worstCost(m) > CAP) { capped = true; console.log(`Stopped before ${g.name} (round ${r + 1}): the next call could pass the $${CAP.toFixed(2)} cap.`); break; }
      const t0 = Date.now();
      let out = null;
      let error = "";
      try {
        // The engine's own call for a page's batch: no helper set, so the run's model, default effort.
        out = await client.call({ system: m.system, user: m.user, tool: m.tool, tier: "pro", effort: "default" }, cfg);
      } catch (e) {
        error = (e && e.message) || String(e);
        if (e && e.usage) spent += e.usage.cost || 0;
      }
      const ms = Date.now() - t0;
      if (out && out.usage) spent += out.usage.cost || 0;
      const said = out ? TOOLS.readLabels(g.entries, out.reply) : null;
      const why = out && !said ? unusableWhy(g.entries, out.reply) : "";
      batches.push({ page: g.name, round: r + 1, ms, controls: g.entries.length, promptChars: m.system.length + m.user.length, usable: !!said, error, ...(out && !said ? { why, reply: out.reply } : {}), prompt: out && out.usage ? out.usage.prompt : 0, completion: out && out.usage ? out.usage.completion : 0, cost: out && out.usage ? out.usage.cost : 0 });
      console.log(`${g.name} (round ${r + 1}): ${(ms / 1000).toFixed(1)} s, ${g.entries.length} controls${said ? "" : `, NO USABLE ANSWER${error ? `: ${error.slice(0, 160)}` : ""}${why ? `: ${why}` : ""}`}`);
      g.entries.forEach((e, i) => {
        const does = said ? said[i] : "unanswered";
        const holds = does !== "none";
        const right = e.held ? holds : !holds;
        const name = `${e.names.join(" / ")}${e.dialog ? ` in "${e.dialog.name}"` : ""} (${e.kind})`;
        rows.push({ page: g.name, round: r + 1, name, wanted: e.held ? "held" : "free", does, right });
        console.log(`  ${right ? "ok   " : "WRONG"} ${name}: ${does}, wanted ${e.held ? "held" : "free"}`);
      });
    }
  }

  const answered = rows.filter((x) => x.does !== "unanswered");
  const ordinary = answered.filter((x) => x.wanted === "free");
  const committing = answered.filter((x) => x.wanted === "held");
  const falseHolds = ordinary.filter((x) => !x.right);
  const missed = committing.filter((x) => !x.right);
  const ok = batches.filter((b) => b.usable);
  const times = ok.map((b) => b.ms);
  const late = batches.filter((b) => b.ms > BATCH_WAIT_MS);
  const perPage = batches.length ? spent / batches.length : 0;

  console.log("\nSummary");
  console.log(`  model                ${PROVIDER}/${cfg.model}`);
  console.log(`  batches              ${batches.length}, usable ${ok.length}, unusable or failed ${batches.length - ok.length}`);
  console.log(`  false holds          ${falseHolds.length} of ${ordinary.length} ordinary controls (${pct(falseHolds.length, ordinary.length)})`);
  for (const x of uniq(falseHolds)) console.log(`    ${x.name}: ${x.does} (${x.times}x)`);
  console.log(`  missed holds         ${missed.length} of ${committing.length} committing controls (${pct(missed.length, committing.length)})`);
  for (const x of uniq(missed)) console.log(`    ${x.name}: ${x.does} (${x.times}x)`);
  console.log(`  batch latency        median ${(median(times) / 1000).toFixed(2)} s, worst ${(Math.max(0, ...times) / 1000).toFixed(2)} s, over the ${BATCH_WAIT_MS / 1000} s wait: ${late.length} of ${batches.length}`);
  const big = [...ok].sort((a, b) => b.controls - a.controls)[0];
  if (big) console.log(`  largest page         ${big.page}: ${big.controls} controls, ${big.promptChars} prompt chars`);
  console.log(`  spend                $${spent.toFixed(4)} in all, $${perPage.toFixed(5)} per page (cap $${CAP.toFixed(2)}${capped ? ", reached" : ""})`);
  console.log(`  tokens per page      median ${median(ok.map((b) => b.prompt))} in, ${median(ok.map((b) => b.completion))} out`);
  if (process.env.PRESS_EVAL_REPORT) fs.writeFileSync(process.env.PRESS_EVAL_REPORT, JSON.stringify({ model: `${PROVIDER}/${cfg.model}`, repeat: REPEAT, spent, perPage, capped, batches, rows }, null, 2));
}

/** Why readLabels would not use a reply, in words, for the log. */
function unusableWhy(entries, reply) {
  if (!reply || typeof reply !== "object") return `the reply is ${JSON.stringify(reply)}`;
  const n = entries.length;
  const parts = [];
  if (Number(reply.count) !== n) parts.push(`count ${JSON.stringify(reply.count)} for ${n} controls`);
  for (const k of ["commits", "unsure"]) if (reply[k] !== undefined && reply[k] !== null && !Array.isArray(reply[k])) parts.push(`${k} is a ${typeof reply[k]}`);
  for (const c of Array.isArray(reply.commits) ? reply.commits : []) {
    if (!c || typeof c !== "object") { parts.push(`a commits item is ${JSON.stringify(c)}`); continue; }
    if (!(Number(c.n) >= 1 && Number(c.n) <= n)) parts.push(`n ${JSON.stringify(c.n)} out of range`);
    if (!["pays", "sends", "deletes", "decides", "pay", "send", "delete", "decide"].includes(String(c.does || "").trim().toLowerCase())) parts.push(`does ${JSON.stringify(c.does)}`);
  }
  for (const u of Array.isArray(reply.unsure) ? reply.unsure : []) if (!(Number(u) >= 1 && Number(u) <= n)) parts.push(`unsure ${JSON.stringify(u)} out of range`);
  return parts.join("; ").slice(0, 400) || JSON.stringify(reply).slice(0, 400);
}

/** Wrong rows folded by control, with how many rounds each was wrong in. */
function uniq(list) {
  const by = new Map();
  for (const x of list) {
    const k = `${x.page}|${x.name}`;
    const had = by.get(k);
    if (had) { had.times += 1; if (!had.does.includes(x.does)) had.does += `, ${x.does}`; } else by.set(k, { name: `${x.page}: ${x.name}`, does: x.does, times: 1 });
  }
  return [...by.values()];
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { worstCost };
