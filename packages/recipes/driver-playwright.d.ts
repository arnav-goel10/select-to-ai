import type { RecipeDriver, ReplayOptions } from "./index.js";

/** A RecipeDriver over a Playwright Page. record() and replay() create one for you. */
export function playwrightDriver(page: any, opts?: ReplayOptions["driver"]): RecipeDriver;
export class PlaywrightDriver implements RecipeDriver {
  constructor(page: any, opts?: ReplayOptions["driver"]);
  snapshot: RecipeDriver["snapshot"];
  locate: RecipeDriver["locate"];
  act: RecipeDriver["act"];
  waitForState: RecipeDriver["waitForState"];
  readFile: NonNullable<RecipeDriver["readFile"]>;
  screenshot: NonNullable<RecipeDriver["screenshot"]>;
  [k: string]: any;
}
/** A Page whose actions are recorded; record() gives it to you as `r.page`. */
export function recordingPage(page: any, rec: any): any;
