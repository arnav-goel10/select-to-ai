"use strict";
// The selection a request is about, with its place on the page: the fact
// the run is given (core/context.js) and what counts as read (core/run.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const CONTEXT = require("../../extension/core/context.js");
const TOOLS = require("../../extension/agentTools.js");

const page = { url: "https://shop.example/orders", title: "Your orders", scrollY: 0, viewportHeight: 900, pageHeight: 900, visibleText: "Your orders", innerText: "Your orders. Order 4411 12 Sep 2026 $182.50", elements: [] };
const place = { text: "$182.50", title: "Your orders", url: "https://shop.example/orders", heading: "Your orders", passage: "4411 12 Sep 2026 $182.50", row: "4411", column: "Total" };

test("a selection is given to the run with its page, heading, table place and passage", () => {
  const fact = CONTEXT.selectionFact(place);
  assert.equal(fact, 'The user selected "$182.50" on Your orders (shop.example), under the heading "Your orders", in a table cell in the row "4411" under the column "Total".\nThe passage it is in: "4411 12 Sep 2026 $182.50"');
});

test("the selection's place is kept small, so the page listing keeps its room", () => {
  const long = { ...place, text: "x ".repeat(2000), passage: "y ".repeat(3000), heading: "h ".repeat(300), row: "", column: "" };
  assert.ok(CONTEXT.selectionFact(long).length < 1600, `${CONTEXT.selectionFact(long).length} characters`);
});

test("a step is shown the captured selection in place of the live one, inside the page markers", () => {
  const run = RUN.newRun({ id: "r", task: "is this more than $150?", tabId: 1, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, { now: 1, page });
  const fx = RUN.advance(run, { type: "observed", page }, { now: 2, page, settings: {}, extras: { selection: place.text, selectionPlace: place } });
  const user = fx[0].user;
  assert.match(user, /The user selected "\$182\.50" on Your orders \(shop\.example\)/);
  assert.doesNotMatch(user, /Text the user had selected when they asked/);
  assert.ok(user.indexOf("The user selected") > user.indexOf("PAGE-abcd1234 begins") && user.indexOf("The user selected") < user.indexOf("PAGE-abcd1234 ends"), "it is page content, not an instruction");
});

test("a quote from the passage around the selection counts as read on its page, which is then a page used", () => {
  const run = RUN.newRun({ id: "r", task: "when was this ordered?", tabId: 1, startUrl: "https://other.example/", marker: "PAGE-abcd1234", now: 1 });
  const other = { ...page, url: "https://other.example/", title: "Other", innerText: "Nothing here", visibleText: "" };
  const extras = { selection: place.text, selectionPlace: place };
  RUN.advance(run, { type: "start" }, { now: 1, page: other });
  RUN.advance(run, { type: "observed", page: other }, { now: 2, page: other, settings: {}, extras });
  const fx = RUN.advance(run, { type: "model_replied", reply: { goal: "g", actions: [{ do: "done", success: true, answer: "On 12 Sep 2026.", evidence: ["4411 12 Sep 2026"] }] }, usage: {} }, { now: 3, page: other, settings: { verify: true }, extras });
  assert.equal(fx[0].purpose, "verify", "the quote was found, so the answer goes to the check");
  RUN.advance(run, { type: "model_replied", purpose: "verify", reply: { requirements: [], pass: true, reason: "ok" }, usage: {} }, { now: 4, page: other, settings: {}, extras });
  assert.deepEqual(run.outcome.sources.map((s) => s.url), ["https://shop.example/orders"]);
});

test("the page-side capture stands by itself, so it can be injected into any page", () => {
  const src = TOOLS.selectionPlace.toString();
  // Only browser globals and its own names: nothing from this module's scope.
  for (const outer of ["TOOLS", "clip(", "root.", "SELECT_TO_AI"]) assert.ok(!src.includes(outer), `uses ${outer}`);
});
