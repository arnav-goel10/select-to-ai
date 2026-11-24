/**
 * Where the run looks first, on a live model: the start-site behaviour set
 * (start-site-cases.js) put to the model the way the engine puts a step,
 * with the instructions, the step tool and the facts of extension/core, and
 * sent through the engine's own model client (core/llm.js).
 *
 *   START_EVAL_KEY=... node tests/decisions/start-site-eval.js
 *
 * For each pair the first step is asked. When it stays on the site, the
 * action is taken as done and the site is shown answering it with nothing
 * that fits (its own search results, empty), and the second step is asked.
 * A step leaves when it opens an address, or presses a link, on another
 * site, or hands the work to sub-tasks, and the engine's own gate
 * (core/policy.js decide, with the engine's default of asking before risky
 * steps) lets that action run. A leave the gate holds for the user's
 * approval is "held": in the product the run stops there, so it is not
 * counted as leaving.
 *
 * The bar, from the decision this set checks:
 *   on   the site can answer: the first action stays on it in at least 9 of 10
 *   off  a general question from an unrelated tab: the run leaves within two
 *        steps in at least 8 of 10
 * The script fails when either is missed, or when a reply could not be used
 * often enough that the count says nothing.
 *
 * Env:
 *   START_EVAL_KEY       the Anthropic key (never printed)
 *   START_EVAL_MODEL     model id (default claude-haiku-5-5)
 *   START_EVAL_CAP_USD   hard spend cap (default 1.5). A call is not made
 *                        when its worst case would pass the cap.
 *   START_EVAL_ONLY      comma-separated case names
 *   START_EVAL_REPORT    write a JSON report here
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const EXT = path.resolve(__dirname, "../../extension");
const TOOLS = require(path.join(EXT, "agentTools.js"));
const D = require(path.join(EXT, "defaults.js"));
const LLM = require(path.join(EXT, "core/llm.js"));
const RUN = require(path.join(EXT, "core/run.js"));
const STEP = require(path.join(EXT, "core/step.js"));
const CONTEXT = require(path.join(EXT, "core/context.js"));
const KNOWN = require(path.join(EXT, "core/memory.js"));
const POLICY = require(path.join(EXT, "core/policy.js"));
// The engine's default settings for the gate (extension/engine.js).
const GATE = { riskConfirmation: true, allowlist: "" };
const { CASES, pagesOf } = require("./start-site-cases.js");

const MODEL = process.env.START_EVAL_MODEL || "claude-haiku-5-5";
const KEY = process.env.START_EVAL_KEY || "";
const CAP = Math.max(0, parseFloat(process.env.START_EVAL_CAP_USD || "1.5"));
const ONLY = (process.env.START_EVAL_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const BAR = { on: 9, off: 8 };
const NOW = Date.UTC(2026, 10, 24, 10);

/** The most one step call could cost: every prompt character a token, the whole reply room, and the engine's two re-asks. */
function worstCost(m, tool) {
  const [inRate, outRate] = D.findModelRates(MODEL) || [0, 0];
  const promptTokens = m.system.length + m.user.length + JSON.stringify(tool).length;
  const outTokens = D.modelProfile(MODEL).maxTokens || 4096;
  return 3 * ((promptTokens / 1000) * inRate + (outTokens / 1000) * outRate);
}

/** A run as the engine holds it at its first step on `page`. */
function startRun(c, page) {
  const profile = D.modelProfile(MODEL);
  const run = RUN.newRun({ id: c.name, task: c.task, tabId: 1, startUrl: page.url, marker: "PAGE-5a7e0c1d", now: NOW, settings: { maxActions: profile.maxActions, elementLimit: profile.lines, pageBudget: profile.pageBudget } });
  run.step = 1;
  look(run, page);
  return run;
}

/** What the engine knows once it has looked at a page: labels by ref, and the addresses the page shows. */
function look(run, page) {
  KNOWN.annotate(page.elements, KNOWN.empty());
  run.labels = {};
  for (const el of page.elements || []) run.labels[el.id] = TOOLS.elementLabel(el);
  run.trust.urls = [...new Set([...run.trust.urls, page.url, ...(page.elements || []).map((el) => el.url)].filter(Boolean))];
}

/** Where an action asks to go: "away" to another site, "here" on this one, or how it ends the step. */
function aimOf(a, run, page) {
  const away = (url) => { const s = TOOLS.siteOf(url); return s && s !== run.startSite; };
  if (a.do === "navigate") return away(a.url) ? "away" : "here";
  if (a.do === "tabs") return a.op === "open" && away(a.url) ? "away" : "here";
  if (a.do === "delegate") return "away";
  if (a.do === "click" && a.ref !== undefined) {
    const el = (page.elements || []).find((e) => e.id === a.ref);
    return el && el.url && away(el.url) ? "away" : "here";
  }
  if (a.do === "done" || a.do === "ask_user") return a.do;
  return "here";
}

/**
 * Where an action goes in the product: as aimOf, except that a leave the
 * gate does not allow is "held", since the run then waits for the user.
 */
function whereTo(a, run, page) {
  const aim = aimOf(a, run, page);
  if (aim !== "away") return aim;
  return POLICY.decide(a, page, run, GATE, null).verdict === "allow" ? "away" : "held";
}

/**
 * Where a step goes: its first action that leaves or is held decides,
 * since the actions run in order and a held one stops the step there.
 */
function stepWhere(wheres) {
  return wheres.find((w) => w === "away" || w === "held") || wheres[0];
}

/**
 * Whether a pair went as its group should: an "on" pair's first step
 * neither leaves nor is held leaving; an "off" pair leaves, with the gate's
 * leave, within its steps.
 */
function scored(group, wheres) {
  return group === "on" ? wheres[0] !== "away" && wheres[0] !== "held" : wheres.includes("away");
}

async function main() {
  if (!KEY) { console.error("Set START_EVAL_KEY."); process.exit(1); }
  if (!D.findModelRates(MODEL)) { console.error(`No price is known for ${MODEL}, so the spend cap cannot be kept.`); process.exit(1); }
  const entry = (D.PROVIDER_ENDPOINTS || {}).anthropic;
  const cfg = LLM.settingsFrom({ agentActiveProvider: "anthropic", [entry.keyName]: KEY, agentModel: MODEL }, Date.now());
  if (cfg.keyProblem) { console.error(cfg.keyProblem); process.exit(1); }
  const client = LLM.createClient({ fetch: (...a) => fetch(...a) });
  const cases = CASES.filter((c) => !ONLY.length || ONLY.includes(c.name));
  console.log(`Start-site eval: ${cases.length} pairs on anthropic/${cfg.model}, cap $${CAP.toFixed(2)}\n`);

  let spent = 0;
  let capped = false;
  const rows = [];

  /** One step, asked as the engine asks it. Returns {actions, where, said} or {error}. */
  async function ask(run, page) {
    const m = CONTEXT.stepMessages(run, page, { now: NOW, uiLanguage: "en-GB", tabs: [{ id: 1, current: true, active: true, title: page.title, url: page.url }] });
    const tool = RUN.toolFor(run, m, { memory: KNOWN.empty(), page });
    if (spent + worstCost(m, tool) > CAP) { capped = true; return { error: "cap" }; }
    let out = null;
    try {
      out = await client.call({ system: m.system, user: m.user, tool, tier: "pro", purpose: "step", effort: "default" }, cfg);
    } catch (e) {
      if (e && e.usage) spent += e.usage.cost || 0;
      return { error: String((e && e.message) || e).slice(0, 200) };
    }
    if (out && out.usage) spent += out.usage.cost || 0;
    const checked = STEP.checkStep(out && out.reply, { page, labels: run.labels, labelOf: TOOLS.elementLabel, maxActions: run.maxActions, finalStep: run.finalStep });
    if (!checked.ok) return { error: `unusable reply: ${String(checked.error).slice(0, 160)}` };
    const actions = checked.step.actions;
    const wheres = actions.map((a) => whereTo(a, run, page));
    const where = stepWhere(wheres);
    return { actions, where, goal: checked.step.goal || "", said: actions.map((a) => STEP.describe(a, a.ref !== undefined ? run.labels[a.ref] : "")).join(", then ") };
  }

  for (const c of cases) {
    if (capped) break;
    const { page, inside } = pagesOf(c);
    const run = startRun(c, page);
    const first = await ask(run, page);
    const row = { name: c.name, group: c.group, task: c.task, site: run.startSite, steps: [] };
    rows.push(row);
    if (first.error) { row.error = first.error; console.log(`${c.name}: NO STEP (${first.error})`); continue; }
    row.steps.push({ where: first.where, did: first.said });
    if (c.group === "off" && first.where === "here") {
      // The action is taken as done, and the site shows nothing that fits.
      const reads = first.actions.every((a) => a.do === "find" || a.do === "read" || a.do === "scroll");
      const shown = reads ? page : inside;
      run.history.push({ step: 1, goal: first.goal, url: page.url, actions: first.actions.map((a) => ({ text: STEP.describe(a, a.ref !== undefined ? run.labels[a.ref] : ""), ok: true, result: reads ? "Nothing on the page matches." : "Done. The page changed." })) });
      run.step = 2;
      run.previous = { url: page.url, visibleText: page.visibleText };
      look(run, shown);
      const second = await ask(run, shown);
      if (second.error) row.error = second.error;
      else row.steps.push({ where: second.where, did: second.said });
    }
    const wheres = row.steps.map((s) => s.where);
    row.right = scored(c.group, wheres);
    if (row.error && c.group === "off" && !row.right) row.right = null;
    console.log(`${row.right === true ? "ok   " : row.right === null ? "LOST " : "WRONG"} [${c.group}] ${c.name} on ${row.site}: ${row.steps.map((s, i) => `step ${i + 1} ${s.where}: ${s.did}`).join(" | ")}${row.error ? ` (${row.error})` : ""}`);
  }

  const tally = (group) => {
    const all = rows.filter((r) => r.group === group);
    return { asked: all.length, right: all.filter((r) => r.right === true).length, lost: all.filter((r) => r.right === null || (r.error && !r.steps.length)).length };
  };
  const on = tally("on");
  const off = tally("off");
  // How many steps the unrelated-tab group took on the open site before leaving.
  const offStays = rows.filter((r) => r.group === "off" && r.right).map((r) => r.steps.findIndex((s) => s.where === "away"));
  console.log("\nSummary");
  console.log(`  model                anthropic/${cfg.model}`);
  console.log(`  on the site          first action stays on it in ${on.right} of ${on.asked} (bar ${BAR.on} of 10)${on.lost ? `, ${on.lost} with no usable step` : ""}`);
  console.log(`  unrelated tab        leaves within two steps in ${off.right} of ${off.asked} (bar ${BAR.off} of 10)${off.lost ? `, ${off.lost} with no usable step` : ""}`);
  console.log(`  steps before leaving ${offStays.filter((n) => n === 0).length} left at step 1, ${offStays.filter((n) => n === 1).length} at step 2`);
  const held = rows.filter((r) => r.steps.some((s) => s.where === "held")).length;
  console.log(`  held by the gate     ${held} pair${held === 1 ? "" : "s"} had a step that asked to leave and waited for the user's approval`);
  console.log(`  spend                $${spent.toFixed(4)} (cap $${CAP.toFixed(2)}${capped ? ", reached" : ""})`);
  if (process.env.START_EVAL_REPORT) fs.writeFileSync(process.env.START_EVAL_REPORT, JSON.stringify({ model: `anthropic/${cfg.model}`, spent, capped, bar: BAR, on, off, rows }, null, 2));
  // The bar is for the whole set; a run cut short by the cap or by lost calls proves nothing either way.
  const whole = !ONLY.length;
  const short = capped || on.lost + off.lost > 2;
  if (whole && (short || on.right < BAR.on || off.right < BAR.off)) {
    console.error(short ? "\nThe set did not run in full, so the bar cannot be judged." : "\nThe bar is not met.");
    process.exit(1);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { whereTo, stepWhere, scored, GATE };
