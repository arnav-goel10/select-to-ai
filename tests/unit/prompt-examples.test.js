"use strict";
// The examples in the instructions must not be the cases the instructions
// are measured on. An example that is a decision case with a number
// changed makes that case pass whatever the rest of the prompt says, so it
// measures nothing, and the example teaches one case instead of a way of
// working.
//
// An example's shape is its own words: the words of its scene and of the
// step it shows, less the words the instructions keep using anyway
// ("page", "search", "answer": three times or more outside the examples)
// and the step tool's own names. A decision case or a bench task shares that shape
// when two of those words are in it, one of them in what the user asked.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "../..");
const CONTEXT = require(path.join(ROOT, "extension/core/context.js"));
const STEP = require(path.join(ROOT, "extension/core/step.js"));
const { CASES } = require(path.join(ROOT, "tests/decisions/cases.js"));
const { PRESS_CASES } = require(path.join(ROOT, "tests/decisions/press-cases.js"));

// Words, with a plural's "s" and a possessive's "'s" taken off, so "hikes" is "hike".
const stem = (w) => w.replace(/'s$/, "").replace(/(?<=[a-z]{3})(?:es|s)$/, "");
const wordsOf = (t) => (String(t || "").toLowerCase().replace(/<[^>]+>/g, " ").match(/[\p{L}][\p{L}'-]+/gu) || []).flatMap((w) => [w, ...(w.includes("-") ? w.split("-") : [])]).map(stem).filter((w) => w.length >= 4);
/** The words a text keeps using: three times or more. */
function usedOften(text) {
  const n = new Map();
  for (const w of wordsOf(text)) n.set(w, (n.get(w) || 0) + 1);
  return new Set([...n].filter(([, k]) => k >= 3).map(([w]) => w));
}

function examplesOf(instructions) {
  const body = instructions.slice(instructions.indexOf("# Examples") + "# Examples".length).split(/\n# /)[0];
  // One example: a scene, the step for it, and any scene and step that follow from it.
  return body.trim().split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
}

/** Words every example uses: the instructions' common words, and the step tool's own names (fill, press, ref, evidence). */
function generalWords(instructions) {
  const general = usedOften(instructions.slice(0, instructions.indexOf("# Examples")));
  for (const name of [...STEP.ACTION_NAMES, ...Object.keys(STEP.stepTool({}).parameters.properties)]) for (const w of wordsOf(name)) general.add(w);
  return general;
}

function shared(example, general, item) {
  const mine = new Set(wordsOf(example).filter((w) => !general.has(w)));
  const asked = new Set(wordsOf(item.task));
  const all = new Set([...asked, ...wordsOf(item.page)]);
  const both = [...mine].filter((w) => all.has(w));
  return both.length >= 2 && both.some((w) => asked.has(w)) ? both : [];
}

// What the examples are measured against: every decision case, every press
// case, and every task the repository's bench files hold.
function measuredOn() {
  const items = [];
  for (const c of CASES) items.push({ name: c.name, task: c.task, page: [c.html, ...(c.otherTabs || []).map((t) => t.html || "")].join(" ") });
  for (const c of PRESS_CASES) items.push({ name: c.name, task: c.task || "", page: c.html || "" });
  const benchFiles = [path.join(ROOT, "tests/bench/smoke-tasks.json"), path.join(ROOT, "bench/recipes/tasks/index.js")];
  for (const file of benchFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/["']?(?:task|goal)["']?\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) items.push({ name: path.basename(file), task: m[2], page: "" });
  }
  return items;
}

test("the shape check finds the examples that mirrored decision cases", () => {
  // The three examples the instructions had before, each of them a case with its details changed.
  const old = [
    'The user asks for the cheapest wireless mouse rated 4 stars or more. The page lists [3] searchbox "Search products".',
    'The user asks what is in their last order, and the page shows a sign-in form.',
    'The user asks whether the recipe on the page is vegetarian. The page text lists "200 g pancetta" among the ingredients.',
  ];
  const general = generalWords(CONTEXT.INSTRUCTIONS);
  const items = measuredOn();
  for (const ex of old) assert.ok(items.some((it) => shared(ex, general, it).length), `not caught: ${ex}`);
});

test("no example in the instructions shares its shape with a decision case or a bench task", () => {
  const text = CONTEXT.INSTRUCTIONS;
  const general = generalWords(text);
  const examples = examplesOf(text);
  assert.ok(examples.length >= 3, "the examples were found");
  const items = measuredOn();
  assert.ok(items.length > CASES.length, "the bench tasks were read");
  const clashes = [];
  for (const ex of examples) for (const it of items) { const words = shared(ex, general, it); if (words.length) clashes.push(`${it.name}: ${words.join(", ")} | ${ex.split("\n")[0].slice(0, 90)}`); }
  assert.deepEqual(clashes, []);
});
