"use strict";
// The engine must work the same on any site. Nothing in it may name a site
// it was tested on, or an incident from a test run: a rule written for one
// site is a patch, and patches do not carry over to the next site.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "../../extension");
const files = [...fs.readdirSync(path.join(EXT, "core")).map((f) => path.join("core", f)), "engine.js"];
// The sites of the public task sets the agent is measured on, and the sets' names.
const TESTED_ON = /\b(allrecipes|amazon|arxiv|bbc|booking\.com|cambridge|coursera|espn|github|hugging ?face|wolfram|webvoyager|mind2web|benchmark)\b/i;
// The extension's own project page is not a site it acts on.
const OWN = /selecttoai\.github\.io/g;

test("no file of the engine names a site it was tested on", () => {
  const hits = [];
  for (const file of files) {
    fs.readFileSync(path.join(EXT, file), "utf8").split("\n").forEach((line, i) => {
      if (TESTED_ON.test(line.replace(OWN, ""))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the instructions the model reads name no site at all", () => {
  const { INSTRUCTIONS, VERIFIER } = require(path.join(EXT, "core/context.js"));
  const { INSTRUCTIONS: LEARN } = require(path.join(EXT, "core/learn.js"));
  for (const text of [INSTRUCTIONS, VERIFIER, LEARN]) {
    assert.ok(!/\b[a-z0-9-]+\.(com|org|net|io|co|sg|uk)\b/i.test(text), "a domain name in the instructions");
    assert.ok(!/—/.test(text), "an em dash in the instructions");
  }
});

test("the engine's code overrides the model's choice only for safety and for a reply it cannot use", () => {
  // The run changes what happens next in exactly these ways; a new one
  // needs a reason that belongs on this list.
  const run = fs.readFileSync(path.join(EXT, "core/run.js"), "utf8");
  assert.ok(!/action\s*=\s*\{\s*(do|action):/.test(run), "the run never swaps the model's action for one of its own");
  const facts = require(path.join(EXT, "core/context.js")).runFacts({ step: 9, maxSteps: 25, facts: { repeats: 4, unchanged: 3, failures: 3 }, visits: {}, steers: [] }, { url: "https://e.example/" });
  for (const f of facts) assert.ok(!/\b(you must|do not|don't|never|should|try|instead|finish now|stop)\b/i.test(f), `a fact that gives an order: ${f}`);
});
