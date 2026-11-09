/**
 * @recipes/core: browser automations that prove they finished, and
 * repair themselves under contract when a site changes.
 *
 *   const recipe = await record(page, async (r) => { ... }, { vars })
 *   const receipt = await replay(page, recipe, { vars, repair: { model } })
 *
 * `page` is a Playwright Page or any object implementing RecipeDriver.
 */
import { Recorder } from "./core/compile.js";
import { runReplay } from "./core/runner.js";

export { validate, SCHEMA } from "./core/schema.js";
export { fingerprintOf, score, resolve, rank, gate, THRESHOLDS, WEIGHTS, describeFingerprint } from "./core/fingerprint.js";
export { derivePost, evaluate, evaluateAll, describePredicate } from "./core/post.js";
export { bindVariables, inferVariables } from "./core/vars.js";
export { newReplay, start, advance, waitCheck } from "./core/replay.js";
export { runReplay } from "./core/runner.js";
export { buildRepairRequest, vetPatch, REPAIR_SYSTEM, REPAIR_SCHEMA } from "./core/repair.js";
export { fromReplay, headline, toMarkdown } from "./core/receipt.js";
export { Recorder, classOf, deadlineFor } from "./core/compile.js";
export { urlPattern, urlMatches } from "./core/url.js";

function isDriver(x) {
  return x && typeof x.snapshot === "function" && typeof x.act === "function" && typeof x.waitForState === "function";
}

async function driverFor(page, opts) {
  if (isDriver(page)) return page;
  const { playwrightDriver } = await import("./driver-playwright.js");
  return playwrightDriver(page, opts && opts.driver);
}

/**
 * Record a recipe by running a script once.
 *
 * The script gets a recorder `r` with goto, click, fill, select, check,
 * uncheck, press, hover, download, read, expectText and back, each taking a
 * Playwright Locator, a selector or {ref}. `r.page` is the same Page with
 * its actions recorded, so an existing Playwright script can run unchanged.
 * Write a variable as "{name}" or pass its value literally; either way it
 * becomes a slot.
 *
 * @param {object} page  Playwright Page or RecipeDriver
 * @param {(r:object)=>Promise<void>} script
 * @param {{vars?:Record<string,string>, title?:string, request?:string, driver?:object}} [opts]
 * @returns {Promise<object>} the recipe (state "draft" until a clean replay)
 */
export async function record(page, script, opts = {}) {
  const driver = await driverFor(page, opts);
  const rec = new Recorder(driver, opts);
  const api = {
    goto: (u) => rec.goto(u),
    back: () => rec.back(),
    click: (t, o) => rec.click(t, o),
    hover: (t, o) => rec.hover(t, o),
    fill: (t, v, o) => rec.fill(t, v, o),
    select: (t, v, o) => rec.select(t, v, o),
    check: (t, o) => rec.check(t, o),
    uncheck: (t, o) => rec.uncheck(t, o),
    press: (t, k, o) => (k === undefined ? rec.press(null, t, o) : rec.press(t, k, o)),
    download: (t, o) => rec.download(t, o),
    read: (t, name, o) => rec.read(t, name, o),
    expectText: (text) => rec.expectText(text),
    page: null,
    driver,
  };
  if (!isDriver(page)) {
    const { recordingPage } = await import("./driver-playwright.js");
    api.page = recordingPage(page, rec);
  }
  await script(api);
  return rec.compile();
}

/**
 * Replay a recipe. Makes no model call unless a step cannot be completed as
 * recorded and `repair.model` is given.
 *
 * @param {object} page  Playwright Page or RecipeDriver
 * @param {object} recipe
 * @param {{vars?:Record<string,unknown>, repair?:{model?:object, approve?:(p:object)=>Promise<boolean>, maxRepairs?:number}|false, thresholds?:object, onEvent?:(e:object)=>void, driver?:object}} [opts]
 * @returns {Promise<object>} the receipt; `receipt.recipe` is the recipe to save (with any repair and updated counters)
 */
export async function replay(page, recipe, opts = {}) {
  const driver = await driverFor(page, opts);
  const { receipt, recipe: next } = await runReplay(driver, recipe, opts);
  return { ...receipt, recipe: next };
}
