"use strict";
// The start-site eval (tests/decisions/start-site-eval.js) counts a step as
// leaving only when the engine's own gate lets it run. A leave the gate
// holds for the user's approval stops the run in the product, so it is not
// a leave. The addresses below are the ones a live model wrote in CI.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const EXT = path.join(__dirname, "../../extension");
const RUN = require(path.join(EXT, "core/run.js"));
const POLICY = require(path.join(EXT, "core/policy.js"));
const TOOLS = require(path.join(EXT, "agentTools.js"));
const { whereTo, stepWhere, scored, GATE } = require("../decisions/start-site-eval.js");
const { CASES, pagesOf } = require("../decisions/start-site-cases.js");

/** A run at its first step on the case's start page, as the eval holds it. */
function startOf(name) {
  const c = CASES.find((x) => x.name === name);
  const { page } = pagesOf(c);
  const run = RUN.newRun({ id: c.name, task: c.task, tabId: 1, startUrl: page.url, marker: "PAGE-5a7e0c1d", now: 1 });
  run.step = 1;
  run.labels = {};
  for (const el of page.elements) run.labels[el.id] = TOOLS.elementLabel(el);
  run.trust.urls = [...new Set([page.url, ...page.elements.map((el) => el.url)].filter(Boolean))];
  return { run, page };
}

const HELD = [
  ["lisbon-population", "https://en.wikipedia.org/wiki/Lisbon"],
  ["euro-yen", "https://www.google.com/search?q=euro+to+yen+exchange+rate"],
  ["oslo-weather", "https://duckduckgo.com/?q=Oslo+weather+this+weekend"],
  ["python-release", "https://www.python.org/downloads/"],
  ["kilimanjaro-permit", "https://duckduckgo.com/?q=Kilimanjaro+National+Park+climbing+permit+fee"],
  ["marathon-record", "https://worldathletics.org/records/all-time-toplists/marathon/outdoor/men/senior"],
];

test("the eval asks the gate with the engine's default of asking before risky steps", () => {
  assert.equal(GATE.riskConfirmation, true);
});

test("a written address on another site that the gate holds is not a leave", () => {
  for (const [name, url] of HELD) {
    const { run, page } = startOf(name);
    const a = { do: "navigate", url };
    assert.notEqual(POLICY.decide(a, page, run, GATE, null).verdict, "allow", `${name}: the gate holds it`);
    assert.equal(whereTo(a, run, page), "held", `${name}: ${url}`);
    assert.equal(scored("off", [stepWhere([whereTo(a, run, page)])]), false, `${name} is not scored as leaving`);
  }
});

test("a leave the gate allows is a leave", () => {
  const { run, page } = startOf("python-release");
  for (const url of ["https://www.python.org/", "https://duckduckgo.com/"]) {
    const a = { do: "navigate", url };
    assert.equal(POLICY.decide(a, page, run, GATE, null).verdict, "allow");
    assert.equal(whereTo(a, run, page), "away");
    assert.equal(scored("off", [whereTo(a, run, page)]), true);
  }
  // A step on the start site is not a leave, and a held leave stops the step there.
  assert.equal(whereTo({ do: "find", query: "python" }, run, page), "here");
  assert.equal(stepWhere(["here", "held", "away"]), "held");
  assert.equal(stepWhere(["here", "away"]), "away");
  assert.equal(scored("on", ["held"]), false, "asking to leave a site that can answer is not staying");
  assert.equal(scored("on", ["here"]), true);
});
