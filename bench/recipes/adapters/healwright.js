// Baseline: healwright@2.0.0 (npm), self-healing locators for Playwright.
//
// How a team would adopt it: keep the reference script and route its
// locator calls through `page.heal.*`, giving each one a description. Here the
// descriptions are taken from the element at record time (accessible name,
// kind, and its row or dialog), with task variables templated in.
//
// The model is Anthropic `claude-haiku-5-5` through healwright's own Anthropic
// provider. Heals are cached in a fresh per-run cache, so every cell is
// judged on its own (no heal learned on one mutation is replayed on another).
// Token counts come from healwright's own heal log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withHealing } from "healwright";
import { recordingPage, recordedTemplates, templatize, fillTemplate, REFERENCE_API } from "./_record.js";

const MODEL = "claude-haiku-5-5";
// healwright also appends a run summary to ./.self-heal by default; keep it out of the repo.
process.env.HEALWRIGHT_SUMMARY_FILE ||= path.join(os.tmpdir(), "recipes-healwright-summary.jsonl");

export function configure(params = {}) {
  const minConfidence = params.minConfidence != null ? Number(params.minConfidence) : 0;
  return {
    name: minConfidence ? `healwright(min=${minConfidence})` : "healwright",
    async prepare({ task, page, reference }) {
      const steps = [];
      await reference(recordingPage(page, task.recordVars, steps), task.recordVars);
      const descs = {};
      for (const s of recordedTemplates(steps, task.recordVars)) if (s.desc) descs[`${s.op}|${s.arg}`] = s.desc;
      return { reference, descs };
    },
    async run({ page, artifact, vars, usage }) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-"));
      const reportFile = path.join(dir, "events.jsonl");
      const hp = withHealing(page, {
        enabled: true,
        mode: "heal",
        provider: "anthropic",
        model: MODEL,
        apiKey: process.env.ANTHROPIC_API_KEY,
        minConfidence,
        cacheFile: path.join(dir, "cache.json"),
        reportFile,
        logLevel: "silent",
      });
      const descFor = (op, sel) => {
        const d = artifact.descs[`${op}|${templatize(sel, vars)}`];
        return d ? fillTemplate(d, vars) : `element matching ${sel}`;
      };
      const healing = new Proxy(page, {
        get(target, prop) {
          if (!REFERENCE_API.includes(prop)) return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
          switch (prop) {
            case "goto":
              return (url) => target.goto(url);
            case "isVisible":
              return (sel) => target.isVisible(sel);
            case "click":
              return (sel) => hp.heal.click(sel, descFor("click", sel));
            case "fill":
              return (sel, value) => hp.heal.fill(sel, descFor("fill", sel), value);
            case "selectOption":
              return (sel, value) => hp.heal.selectOption(sel, descFor("selectOption", sel), value);
            case "check":
              return (sel) => hp.heal.check(sel, descFor("check", sel));
            case "uncheck":
              return (sel) => hp.heal.uncheck(sel, descFor("uncheck", sel));
            case "textContent":
              // healwright's getLocator checks the selector once, without the
              // short wait its actions get (quickTimeout, 1 s); give it the same
              // wait so a page still rendering is not mistaken for a broken locator.
              return async (sel) => {
                await target.locator(sel).first().waitFor({ state: "attached", timeout: 1000 }).catch(() => {});
                return (await hp.heal.getLocator(sel, descFor("textContent", sel))).textContent();
              };
          }
        },
      });
      let claimedDone = false;
      let answer = null;
      let error = null;
      try {
        answer = (await artifact.reference(healing, vars)) ?? null;
        claimedDone = true;
      } catch (err) {
        error = String(err.message || err).split("\n")[0];
      }
      let healed = false;
      try {
        for (const line of fs.readFileSync(reportFile, "utf8").split("\n").filter(Boolean)) {
          const ev = JSON.parse(line);
          if (ev.used === "healed" && ev.success) healed = true;
          if (ev.tokenUsage) usage.model("anthropic", MODEL, ev.tokenUsage.inputTokens || 0, ev.tokenUsage.outputTokens || 0, 0);
        }
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      return { claimedDone, answer, healed, error };
    },
  };
}

export default configure();
