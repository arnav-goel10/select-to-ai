/**
 * Drive the replay state machine with a driver and, for repair only, a model
 * client. This is the only place the core touches the outside world, and it
 * does so only through the driver interface and the model client interface
 * (index.d.ts), so the same core runs on Playwright or in the extension.
 */
import { newReplay, start, advance, waitCheck } from "./replay.js";

/**
 * @param {object} driver  a RecipeDriver
 * @param {object} recipe
 * @param {object} [opts]
 * @param {Record<string,unknown>} [opts.vars]
 * @param {{model?:object, approve?:(proposal:object)=>Promise<boolean>, maxRepairs?:number}|false} [opts.repair]
 * @param {object} [opts.thresholds]
 * @param {(e:object)=>void} [opts.onEvent]  observe every effect and event
 * @param {number} [opts.deadlineMs]  whole-run deadline
 * @returns {Promise<{receipt:object, recipe:object, state:object}>}
 */
export async function runReplay(driver, recipe, opts = {}) {
  const repair = opts.repair && opts.repair.model ? opts.repair : null;
  let { state, effect } = start(newReplay(recipe, opts.vars, {
    now: Date.now(), thresholds: opts.thresholds, repair: !!repair,
    maxRepairs: repair && repair.maxRepairs, approver: !!(repair && repair.approve),
  }));
  const deadline = Date.now() + (opts.deadlineMs || (recipe.steps.reduce((t, s) => t + s.wait.deadlineMs, 0) * 2 + 60000));
  const note = opts.onEvent || (() => {});
  while (effect.type !== "end") {
    note({ effect });
    let ev;
    if (Date.now() > deadline) ev = { type: "stop", why: "the run took longer than its deadline" };
    else ev = await perform(driver, state, effect, repair);
    ev.at = Date.now();
    note({ event: { ...ev, snap: undefined } });
    ({ state, effect } = advance(state, ev));
  }
  return { receipt: effect.receipt, recipe: state.recipeOut, state };
}

async function perform(driver, state, effect, repair) {
  switch (effect.type) {
    case "wait": {
      const t0 = Date.now();
      const r = await driver.waitForState((snap) => waitCheck(state, effect, snap), { deadlineMs: effect.deadlineMs, texts: !!effect.texts, probes: effect.probes || null });
      return { type: "waited", held: r.held, snap: r.snapshot, elapsedMs: Date.now() - t0 };
    }
    case "act": {
      const t0 = Date.now();
      try {
        const r = await driver.act(effect.action);
        return { type: "acted", ok: r.ok !== false, error: r.error, settleMs: r.settleMs, downloads: r.downloads || [], requests: r.requests || [], startedAt: t0 };
      } catch (e) {
        return { type: "acted", ok: false, error: String(e && e.message || e), startedAt: t0 };
      }
    }
    case "model": {
      if (!repair || !repair.model) return { type: "model_failed", error: "no model" };
      try {
        const r = await repair.model.complete(effect.request);
        return { type: "model_replied", reply: r.json, usage: r.usage };
      } catch (e) {
        return { type: "model_failed", error: String(e && e.message || e) };
      }
    }
    case "ask": {
      const yes = repair && repair.approve ? !!(await repair.approve({ step: effect.step, text: effect.text, why: effect.why })) : false;
      return { type: "answered", yes };
    }
    default:
      return { type: "stop", why: `unknown effect ${effect.type}` };
  }
}
