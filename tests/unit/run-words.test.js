const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../../extension/runWords.js");

test("a step row names the control, not its element number", () => {
  const names = W.namesIn('click [8] "Onion"');
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

test("names are taken from fill and click actions alike", () => {
  const names = W.namesIn('fill [14] "Where from?": "Singapore"');
  W.namesIn('click [57] "Sort by"', names);
  assert.equal(names.get("14"), "Where from?");
  assert.equal(names.get("57"), "Sort by");
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
