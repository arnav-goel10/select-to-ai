const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../../extension/runWords.js");

test("a step row names the control, not its element number", () => {
  const names = W.namesFrom({ do: "click", ref: "8", control: "Onion" });
  assert.equal(
    W.plainResult("Clicked element [8]. [8] is now checked. A field on the page holds a different value after it.", names),
    'Clicked "Onion". "Onion" is now checked. A field on the page holds a different value after it.',
  );
  assert.equal(W.plainResult("Clicked element [8]. [8] is now checked."), "Clicked the control. It is now checked.");
  assert.equal(W.plainResult("[22] is covered: a div with no words is drawn over it."), "It is covered: a div with no words is drawn over it.");
  assert.doesNotMatch(W.plainResult("Filled [14] and [15]."), /\[\d+\]/);
});

test("a step row shows the site, not the full tracking address", () => {
  const said = W.plainResult("Done. The page changed: now at https://duckduckgo.com/?ia=web&origin=funnel_home_website&t=h_&q=weather+singapore.");
  assert.equal(said, "Done. The page changed: now at duckduckgo.com.");
  assert.equal(W.plainResult("Opened https://www.zipair.net/en/booking"), "Opened zipair.net");
});

test("names come from the control names the engine sends, never from the action's words", () => {
  const names = W.namesFrom({ do: "fill", ref: "14", control: "Where from?" });
  W.namesFrom({ do: "click", ref: "57", control: "Sort by" }, names);
  W.namesFrom({ do: "fill", ref: "9" }, names);
  assert.equal(names.get("14"), "Where from?");
  assert.equal(names.get("57"), "Sort by");
  assert.equal(names.has("9"), false, "a control with no name has none, whatever was typed into it");
  assert.equal(W.namesIn, undefined, "there is no reader of names out of the action's words");
});

test("a step row says the action by its control's name, and a typed value never stands in for one", () => {
  assert.equal(W.actionWords({ do: "fill", ref: "14", control: "Company" }), 'Fill in "Company"');
  assert.equal(W.actionWords({ do: "fill", ref: "15" }), "Fill in a field");
  assert.equal(W.actionWords({ do: "click", ref: "3", control: "Sign up" }), 'Click "Sign up"');
  assert.equal(W.actionWords({ do: "click", ref: "3" }), "Click");
  assert.equal(W.actionWords({ do: "navigate", url: "https://www.zipair.net/en/booking?utm=x" }), "Open zipair.net");
  assert.equal(W.actionWords({ do: "press", key: "Enter" }), "Press Enter");
  // The words the engine logs for a fill hold the typed value in quotes
  // (STEP.describe with no label). Read alone, they give no name.
  const STEP = require("../../extension/core/step.js");
  const said = STEP.describe({ do: "fill", ref: 15, value: "555-0100" });
  assert.equal(said, 'fill [15] "555-0100"');
  assert.doesNotMatch(W.actionWords({ do: said.split(" ")[0] }), /555/);
  assert.doesNotMatch(W.plainResult('[15] now shows "555-0100".', W.namesFrom({ do: "fill", ref: "15" })), /^"555-0100" now/);
});

test("the engine sends a field's label as its name, never the words typed into it", () => {
  const TOOLS = require("../../extension/agentTools.js");
  // An input with no label: the scan's text for it is its value.
  assert.equal(TOOLS.controlName({ tagName: "input", inputType: "tel", text: "555-0100", value: "555-0100" }), "");
  assert.equal(TOOLS.controlName({ tagName: "input", inputType: "text", text: "Ada", accName: "First name" }), "First name");
  assert.equal(TOOLS.controlName({ tagName: "input", inputType: "text", text: "Ada", placeholder: "Your name" }), "Your name");
  assert.equal(TOOLS.controlName({ tagName: "div", isContentEditable: true, text: "my secret note" }), "");
  assert.equal(TOOLS.controlName({ tagName: "textarea", text: "a typed reply" }), "");
  // A button's words are its name.
  assert.equal(TOOLS.controlName({ tagName: "button", text: "Sign up" }), "Sign up");

  const RUN = require("../../extension/core/run.js");
  const JUDGE = require("../helpers/fake-judge.js");
  const advance = JUDGE.judging(RUN);
  const page = {
    url: "https://forms.example/signup", title: "Sign up", scrollY: 0, viewportHeight: 900, pageHeight: 900,
    visibleText: "Sign up", innerText: "Sign up. Company. Phone.",
    elements: [
      { id: 14, tagName: "input", inputType: "text", accName: "Company", text: "Analytical Engines Ltd", value: "Analytical Engines Ltd", formId: 0 },
      { id: 15, tagName: "input", inputType: "tel", text: "555-0100", value: "555-0100", formId: 0 },
    ],
    forms: [{ id: 0, fields: 2 }],
  };
  const env = { now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} };
  const run = RUN.newRun({ id: "r1", task: "fill the form", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  advance(run, { type: "start" }, env);
  advance(run, { type: "observed", page }, env);
  advance(run, { type: "model_replied", reply: { memory: "", goal: "Fill in the details", actions: [{ do: "fill", ref: 14, value: "Analytical Engines Ltd" }, { do: "fill", ref: 15, value: "555-0100" }] }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } }, env);
  const acts = run.journal.filter((j) => j.k === "log" && j.title === "Action");
  assert.ok(acts.length >= 1, JSON.stringify(run.journal.map((j) => j.title || j.k)));
  assert.deepEqual(acts[0].act, { do: "fill", ref: "14", control: "Company" });
  for (const a of acts) {
    assert.doesNotMatch(JSON.stringify(a.act), /Analytical|555-0100/, "what was typed is not in the data the row is drawn from");
    assert.doesNotMatch(W.actionWords(a.act), /Analytical|555-0100/);
  }
});

test("long text is cut at a sentence or clause, never mid-word", () => {
  const cut = W.clipWords("The landing time is not on any page that was read. The answer's claim about the source is not on the page either, and the day is missing.", 90);
  assert.equal(cut, "The landing time is not on any page that was read…");
  assert.ok(!/\w…$/.test(W.clipWords("one two three four five six seven", 12)) || /\s/.test(W.clipWords("one two three four five six seven", 12)));
  assert.equal(W.clipWords("short", 90), "short");
});

test("the not-confirmed note joins the checker's points as one sentence, cut between points", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require("node:path").resolve(__dirname, "../../extension/core/run.js"), "utf8");
  const body = src.slice(src.indexOf("function unconfirmedNote("));
  const fn = new Function(`${body.slice(0, body.indexOf("\n  }\n") + 4)}; return unconfirmedNote;`)();
  assert.equal(fn(["the price"]), "Part of this could not be confirmed: the price.");
  const said = fn([
    "The forecast is for the hourly block, so label the hourly block with a day.",
    "The answer's claim about the source is not on the page.",
    "The page shows '°C' and the answer gives °F without saying it converted them, which the check could not follow at all from the page text.",
    "A fourth point that will not fit in the note at all because the note is already long enough to read.",
  ]);
  assert.doesNotMatch(said, /\.;/, "no full stop before a semicolon");
  assert.match(said, /day; the answer's claim/);
  assert.match(said, /; and \d more points?\.$/);
  assert.ok(said.length < 380, said);
});
