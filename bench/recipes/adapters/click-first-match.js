// Degenerate: replays the recorded steps, but resolves every target to the
// FIRST visible element of the same kind, with no margin or identity check.
import { recordingPage, recordedTemplates, fillTemplate } from "./_record.js";

const KIND = {
  click: "a[href], button, input[type=submit], [role=button]",
  fill: "input:not([type=hidden]):not([type=checkbox]):not([type=submit]), textarea",
  selectOption: "select",
  check: "input[type=checkbox]",
  uncheck: "input[type=checkbox]",
  textContent: "strong, dd, td, time, span, a",
};

async function firstVisible(page, css) {
  const loc = page.locator(css);
  const n = Math.min(await loc.count(), 60);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  return null;
}

export default {
  name: "click-first-match",
  async prepare({ task, page, reference }) {
    const steps = [];
    try {
      await reference(recordingPage(page, task.recordVars, steps), task.recordVars);
    } catch {}
    return { steps: recordedTemplates(steps, task.recordVars) };
  },
  async run({ page, artifact, vars }) {
    let answer = null;
    try {
      for (const s of artifact.steps) {
        if (s.op === "isVisible") continue;
        if (s.op === "goto") {
          await page.goto(fillTemplate(s.arg, vars));
          continue;
        }
        const el = await firstVisible(page, KIND[s.op]);
        if (!el) continue;
        const opts = { timeout: 2000 };
        if (s.op === "click") await el.click(opts).catch(() => {});
        else if (s.op === "fill") await el.fill(fillTemplate(s.value, vars), opts).catch(() => {});
        else if (s.op === "selectOption") await el.selectOption({ index: 1 }, opts).catch(() => {});
        else if (s.op === "check") await el.check(opts).catch(() => {});
        else if (s.op === "uncheck") await el.uncheck(opts).catch(() => {});
        else if (s.op === "textContent") answer = ((await el.textContent().catch(() => "")) || "").trim();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    } catch {}
    return { claimedDone: true, answer, healed: false };
  },
};
