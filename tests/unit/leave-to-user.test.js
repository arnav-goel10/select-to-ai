"use strict";
// "Fill it in but don't send it": the user's own words leave the sending to
// them. No word list reads that: the model reads the request each step and
// says so in the step (leave_to_user), in whatever words or language the
// user used. Once a step has said it, a press, a key or a submit that would
// commit the user is not taken, with confirmations on or off, until the
// user says something new. With confirmations on, a send the request did
// not hold back is still held for approval (risk.test.js and core-run.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const STEP = require("../../extension/core/step.js");
const POLICY = require("../../extension/core/policy.js");

const page = {
  url: "https://shop.example/contact", title: "Kontakt",
  elements: [
    { id: 1, tagName: "input", accName: "Name", formId: 0 },
    { id: 2, tagName: "textarea", accName: "Nachricht", formId: 0 },
    { id: 3, tagName: "button", accName: "Absenden", submits: true, formId: 0 },
    { id: 4, tagName: "input", inputType: "search", accName: "Suche", formId: 1 },
    { id: 5, tagName: "a", accName: "Impressum", href: "https://shop.example/impressum" },
    { id: 6, tagName: "div", role: "button", accName: "Weiter" },
  ],
  forms: [{ id: 0, search: false, fields: 2 }, { id: 1, search: true, fields: 1 }],
};
const env = (settings) => ({ now: 1000, page, settings: { allowlist: "", verify: true, ...settings }, extras: {} });

/** A run whose first step read the request and said what it said, then filled the name. */
function started(task, settings, leave) {
  const run = RUN.newRun({ id: "rl", task, tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(settings));
  RUN.advance(run, { type: "observed", page }, env(settings));
  RUN.advance(run, { type: "model_replied", reply: { note: "", goal: "fill the name", ...(leave === undefined ? {} : { leave_to_user: leave }), do: "fill", ref: 1, value: "Ada", commits: false }, usage: {} }, env(settings));
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Filled.", pageChanged: false } }, env(settings));
  RUN.advance(run, { type: "observed", page }, env(settings));
  return run;
}
/** What the run does with the next step's action. */
const next = (run, settings, action) => RUN.advance(run, { type: "model_replied", reply: { note: "", goal: "next", ...action }, usage: {} }, env(settings));
const acted = (fx) => fx.some((f) => f.type === "act");

test("the step tool asks the model to read the user's words for a hold on committing steps, and the step carries its reading", () => {
  const tool = STEP.stepTool({ maxActions: 3 });
  assert.equal(tool.parameters.properties.leave_to_user.type, "boolean");
  const said = STEP.checkStep({ note: "", goal: "g", leave_to_user: true, do: "scroll", direction: "down" }, { page, maxActions: 3 });
  assert.equal(said.ok && said.step.leaveToUser, true);
  const not = STEP.checkStep({ note: "", goal: "g", do: "scroll", direction: "down" }, { page, maxActions: 3 });
  assert.equal(not.ok && not.step.leaveToUser, false);
});

for (const confirmations of [false, true]) {
  test(`a request the step read as leaving the sending to the user is not sent, with confirmations ${confirmations ? "on" : "off"}`, () => {
    const settings = { riskConfirmation: confirmations };
    // The wording is the user's, in their language: no pattern reads it, the step said it.
    const task = "Trag meinen Namen ins Kontaktformular ein, abschicken mache ich selbst";
    for (const action of [{ do: "click", ref: 3, commits: true }, { do: "click", ref: 3, commits: false }, { do: "press", key: "Enter", ref: 2, commits: false }, { do: "click", ref: 6, commits: true }]) {
      const run = started(task, settings, true);
      const fx = next(run, settings, action);
      assert.equal(acted(fx), false, `${JSON.stringify(action)} is not taken: ${JSON.stringify(fx).slice(0, 300)}`);
      assert.ok(!fx.some((f) => f.type === "attention" && f.wait && f.wait.kind === "approval"), "not offered for approval either: the user's words already said no");
      const last = run.history[run.history.length - 1];
      assert.match(String(last && (last.result || last.message || JSON.stringify(last))), /leaves this to them/);
    }
    // What does not commit still runs: a search, a link, more typing.
    for (const action of [{ do: "press", key: "Enter", ref: 4, commits: false }, { do: "click", ref: 5, commits: false }, { do: "fill", ref: 2, value: "Hallo", commits: false }]) {
      const run = started(task, settings, true);
      const fx = next(run, settings, action);
      if (confirmations && action.ref === 5) continue;
      assert.equal(acted(fx), true, `${JSON.stringify(action)} runs: ${JSON.stringify(fx).slice(0, 300)}`);
    }
  });
}

test("a later step that forgets the hold does not lift it; the user's new words do", () => {
  const settings = { riskConfirmation: false };
  const run = started("Fill in my name and leave the sending to me", settings, true);
  // The next step says nothing of it: the hold read earlier still stands.
  assert.equal(acted(next(run, settings, { leave_to_user: false, do: "click", ref: 3, commits: true })), false);
  // The user says something new: the hold is theirs to renew, and the step reads their words again.
  run.said.push("ok, send it now");
  assert.equal(POLICY.leavesToUser(run), false);
  assert.equal(POLICY.decide({ do: "click", ref: 3, commits: true }, page, run, settings).verdict, "allow");
});

test("a request the step did not read as a hold is sent as before: with confirmations off it is the model's to follow", () => {
  const settings = { riskConfirmation: false };
  const run = started("Fill in my name and send the form", settings, false);
  assert.equal(acted(next(run, settings, { do: "click", ref: 3, commits: true })), true);
  assert.equal(POLICY.leavesToUser(run), false);
});

test("a sub-task is held by the hold its parent's request carries", () => {
  const run = { leaveToUser: { said: 0 }, said: [] };
  assert.equal(POLICY.leavesToUser(run), true);
  const child = { said: [], leaveToUser: { said: 0 } };
  assert.equal(POLICY.decide({ do: "click", ref: 3, commits: true }, page, child, { riskConfirmation: false }).verdict, "refuse");
});
