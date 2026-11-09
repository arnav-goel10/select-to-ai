// The Recipes engine under the benchmark contract (bench/recipes/ADAPTER.md).
//
// prepare: records the task's reference run on the unmutated app, with the
//          task's recording values, into a recipe (secrets kept in memory,
//          never in the recipe).
// run:     replays the recipe with the run's values. No model call unless a
//          step can't be done as recorded; then repair on Claude Haiku 5.5.
//          Each run starts from the prepared recipe, so a repair made on
//          one mutation never helps another run.
//
// Parameters (adapter spec "recipes?repair=off&model=claude-haiku-5-5"):
//   repair=off   replay only, no model
//   model=<id>   the repair model
//   tau, mu, tauCommit, muCommit, labelFloor, tauLocator   threshold overrides (dev calibration only)
import { appendFileSync } from "node:fs";
import { record, replay } from "../../../packages/recipes/index.js";
import { anthropicModel } from "../../../packages/recipes/anthropic.js";

function withUsage(model, usage) {
  return {
    ...model,
    async complete(req) {
      const t0 = Date.now();
      try {
        const r = await model.complete(req);
        usage.model(r.usage.provider || "anthropic", r.usage.model, r.usage.inTok, r.usage.outTok, r.usage.ms ?? Date.now() - t0);
        return r;
      } catch (err) {
        if (err && err.usage) usage.model(err.usage.provider || "anthropic", err.usage.model, err.usage.inTok, err.usage.outTok, err.usage.ms ?? Date.now() - t0);
        throw err;
      }
    },
  };
}

function make(params = {}) {
  const repairOn = params.repair !== "off";
  const modelId = params.model || process.env.RECIPES_REPAIR_MODEL || "claude-haiku-5-5";
  // Threshold overrides, for calibration on the dev set only.
  const thresholds = {};
  for (const k of ["tau", "mu", "tauCommit", "muCommit", "labelFloor", "tauLocator", "driftSim"]) if (params[k] != null) thresholds[k] = Number(params[k]);
  return {
    name: (repairOn ? "recipes" : "recipes-replay-only") + (Object.keys(thresholds).length ? `-${Object.entries(thresholds).map(([k, v]) => `${k}${v}`).join("-")}` : ""),
    async prepare({ task, page, reference }) {
      const vars = { ...(task.recordVars || {}) };
      const secrets = {};
      const recipe = await record(page, async (r) => { await reference(r.page, vars); }, { vars, secrets, title: task.goal, request: task.goal });
      return { recipe, secrets };
    },
    async run({ page, artifact, vars, usage }) {
      if (!artifact || !artifact.recipe) return { claimedDone: false, answer: null, healed: false, error: "no recipe was recorded" };
      const repair = repairOn ? { model: withUsage(anthropicModel({ model: modelId }), usage) } : false;
      const receipt = await replay(page, artifact.recipe, { vars: { ...(vars || {}), ...artifact.secrets }, repair, thresholds });
      // Optional per-run log for calibration: how often the meaning check ran.
      if (process.env.RECIPES_RUN_LOG) {
        try {
          appendFileSync(process.env.RECIPES_RUN_LOG, `${JSON.stringify({ at: Date.now(), adapter: repairOn ? "repair" : "replay-only", recipe: artifact.recipe.title, end: receipt.end.state, why: receipt.end.why, drift: receipt.checks ? receipt.checks.drift : 0, usd: receipt.cost.usd, calls: receipt.cost.modelCalls, steps: receipt.steps.map((x) => `${x.id}:${x.status}:${x.resolution ? x.resolution.method : "-"}`).join(" "), repairs: receipt.repairs.map((x) => `${x.step}:${x.patch}:${x.status}`).join(" ") })}\n`);
        } catch { /* logging only */ }
      }
      const names = (artifact.recipe.result.extract || []).map((x) => x.name);
      const answer = names.length ? (receipt.extracts[names[names.length - 1]] ?? null) : null;
      return {
        claimedDone: receipt.end.state === "done_proven",
        answer,
        healed: !!receipt.healed,
        error: receipt.end.state === "done_proven" ? null : `${receipt.end.state}: ${receipt.end.why}`.slice(0, 300),
      };
    },
  };
}

export function configure(params) {
  return make(params);
}

export default make({});
