"use strict";
// Typing where the cursor is, selecting words by their text, keys held with
// others, what a key does when the page leaves it alone, and reading back
// what a control holds after it was set. No browser: the parts that decide.
const test = require("node:test");
const assert = require("node:assert/strict");
const TOOLS = require("../../extension/agentTools.js");
const STEP = require("../../extension/core/step.js");
const RUN = require("../../extension/core/run.js");

test("a key written with the keys held with it is split into the key and those keys", () => {
  const mods = (o) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o });
  assert.deepEqual(TOOLS.parseKeyCombo("ctrl+b", false), { key: "b", mods: mods({ ctrlKey: true }) });
  assert.deepEqual(TOOLS.parseKeyCombo("Ctrl+End", false), { key: "End", mods: mods({ ctrlKey: true }) });
  assert.deepEqual(TOOLS.parseKeyCombo("Shift+ArrowLeft", false), { key: "ArrowLeft", mods: mods({ shiftKey: true }) });
  assert.deepEqual(TOOLS.parseKeyCombo("cmd+shift+z", true), { key: "Z", mods: mods({ metaKey: true, shiftKey: true }) });
  // "Mod" is the key this computer holds shortcuts with.
  assert.deepEqual(TOOLS.parseKeyCombo("Mod-z", true).mods, mods({ metaKey: true }));
  assert.deepEqual(TOOLS.parseKeyCombo("Mod-z", false).mods, mods({ ctrlKey: true }));
  assert.equal(TOOLS.parseKeyCombo("ctrl++", false).key, "+");
  assert.equal(TOOLS.parseKeyCombo("+", false).key, "+");
  assert.equal(TOOLS.parseKeyCombo("esc", false).key, "Escape");
  assert.equal(TOOLS.parseKeyCombo("Space", false).key, " ");
  // A name the list does not know reaches the page as it was written.
  assert.deepEqual(TOOLS.parseKeyCombo("F5", false), { key: "F5", mods: mods() });
  assert.deepEqual(TOOLS.parseKeyCombo("a-b", false), { key: "a-b", mods: mods() });
});

test("a shortcut written for another computer is pressed the way this one holds it", () => {
  assert.deepEqual(TOOLS.shortcutHere("b", { ctrlKey: true }, true), { ctrlKey: false, metaKey: true });
  assert.deepEqual(TOOLS.shortcutHere("b", { metaKey: true }, false), { ctrlKey: true, metaKey: false });
  assert.equal(TOOLS.shortcutHere("b", { ctrlKey: true }, false), null, "already the way it is held here");
  assert.equal(TOOLS.shortcutHere("End", { ctrlKey: true }, true), null, "only a letter, a digit or a sign");
  assert.equal(TOOLS.shortcutHere("b", { ctrlKey: true, altKey: true }, true), null);
});

test("what a key does in a text box when the page leaves it alone", () => {
  assert.deepEqual(TOOLS.keyDefault("P", {}, false), { kind: "text", text: "P" });
  assert.deepEqual(TOOLS.keyDefault(" ", {}, false), { kind: "text", text: " " });
  assert.deepEqual(TOOLS.keyDefault("Enter", {}, false), { kind: "paragraph" });
  assert.deepEqual(TOOLS.keyDefault("Backspace", {}, false), { kind: "delete", back: true });
  assert.deepEqual(TOOLS.keyDefault("Delete", {}, false), { kind: "delete", back: false });
  assert.deepEqual(TOOLS.keyDefault("End", { ctrlKey: true }, false), { kind: "caret", dir: "forward", unit: "documentboundary", extend: false });
  assert.deepEqual(TOOLS.keyDefault("ArrowLeft", { shiftKey: true }, false), { kind: "caret", dir: "backward", unit: "character", extend: true });
  assert.deepEqual(TOOLS.keyDefault("ArrowLeft", { altKey: true }, true), { kind: "caret", dir: "backward", unit: "word", extend: false });
  assert.deepEqual(TOOLS.keyDefault("a", { metaKey: true }, true), { kind: "all" });
  assert.deepEqual(TOOLS.keyDefault("b", { ctrlKey: true }, false), { kind: "format", command: "bold" });
  assert.deepEqual(TOOLS.keyDefault("i", { metaKey: true }, true), { kind: "format", command: "italic" });
  // A shortcut held the other computer's way does nothing by itself, and a held letter types nothing.
  assert.equal(TOOLS.keyDefault("b", { ctrlKey: true }, true), null);
  assert.equal(TOOLS.keyDefault("x", { ctrlKey: true }, false), null);
  assert.equal(TOOLS.keyDefault("Tab", {}, false), null);
  assert.equal(TOOLS.keyDefault("Escape", {}, false), null);
});

test("words are found in a box's text: exact case first, a whole word first, the one nearest the cursor", () => {
  assert.deepEqual(TOOLS.findTextIn("Practice makes. Practice line", "Practice", 29), { at: 16, count: 2 });
  assert.deepEqual(TOOLS.findTextIn("Practice makes. Practice line", "Practice", 0), { at: 0, count: 2 });
  assert.deepEqual(TOOLS.findTextIn("Practiced, then practice", "practice"), { at: 16, count: 1 });
  assert.deepEqual(TOOLS.findTextIn("Practiced", "Practice"), { at: 0, count: 1 }, "inside a longer word when that is all there is");
  assert.deepEqual(TOOLS.findTextIn("Hello", "bye"), { at: -1, count: 0 });
});

test("type and select_text are actions of their own, on a control, with text", () => {
  const ctx = { page: { elements: [{ id: 4, tagName: "div", accName: "Note", isContentEditable: true }] }, labels: {}, labelOf: (e) => e.accName };
  assert.deepEqual(STEP.checkAction({ do: "type", ref: 4, value: "\nPractice line" }, ctx), { action: { do: "type", ref: 4, value: "\nPractice line" } });
  assert.deepEqual(STEP.checkAction({ do: "select_text", ref: 4, value: "Practice" }, ctx), { action: { do: "select_text", ref: 4, value: "Practice" } });
  assert.match(STEP.checkAction({ do: "type", value: "x" }, ctx).error, /type needs ref/);
  assert.match(STEP.checkAction({ do: "select_text", ref: 4 }, ctx).error, /select_text needs value/);
  // Other names for them.
  assert.equal(STEP.checkAction({ do: "insert_text", ref: 4, value: "x" }, ctx).action.do, "type");
  assert.equal(STEP.checkAction({ do: "select_words", ref: 4, value: "x" }, ctx).action.do, "select_text");
  // Offered to the model, and in the actions that follow in a step.
  const tool = STEP.stepTool({});
  assert.ok(tool.parameters.properties.do.enum.includes("type") && tool.parameters.properties.do.enum.includes("select_text"));
  assert.ok(tool.parameters.properties.then.items.properties.do.enum.includes("select_text"));
  assert.match(tool.parameters.properties.do.description, /type: type text into a text box or an editor where its cursor is, keeping what is there/);
});

test("the listing says a slider's value, a toggle's pressed state, and an editor's text", () => {
  const slider = TOOLS.formatElementLine({ id: 9, tagName: "div", accName: "Rating", role: "slider", value: "4", min: "0", max: "5" });
  assert.equal(slider, '[9] div "Rating" role=slider value="4" min=0 max=5');
  assert.equal(TOOLS.formatElementLine({ id: 3, tagName: "button", accName: "Mute", ariaPressed: "true" }), '[3] button "Mute" pressed=true');
  assert.equal(TOOLS.formatElementLine({ id: 5, tagName: "my-switch", accName: "Dark mode", ariaChecked: "false" }), '[5] my-switch "Dark mode" checked=false');
});

test("what an action read back from the page is evidence the answer may quote", () => {
  const page = { url: "https://rate.example/", title: "Rate", innerText: "Rate this recipe.", visibleText: "Rate this recipe.", elements: [{ id: 9, tagName: "div", accName: "Rating", role: "slider" }], forms: [] };
  const env = { now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: false }, extras: {} };
  const run = RUN.newRun({ id: "r1", task: "Give it 4 stars and tell me its rating", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page }, env);
  RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "Set it", actions: [{ do: "fill", ref: 9, value: "4" }] }, usage: {} }, env);
  RUN.advance(run, { type: "acted", result: { ok: true, message: "[9] now shows \"4\".", reads: "[9] now shows \"4\"", pageChanged: false } }, env);
  RUN.advance(run, { type: "observed", page }, env);
  RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "Answer", actions: [{ do: "done", success: true, answer: "It holds 4 stars.", evidence: ["[9] now shows \"4\""] }] }, usage: {} }, env);
  const last = run.history[run.history.length - 1] || run.current;
  const said = JSON.stringify(last);
  assert.doesNotMatch(said, /not in anything you have been shown/);
  // A quote the model wrote in its own action is not evidence.
  const run2 = RUN.newRun({ id: "r2", task: "Give it 4 stars", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run2, { type: "start" }, env);
  RUN.advance(run2, { type: "observed", page }, env);
  RUN.advance(run2, { type: "model_replied", reply: { memory: "", goal: "Set it", actions: [{ do: "fill", ref: 9, value: "five golden stars" }] }, usage: {} }, env);
  RUN.advance(run2, { type: "acted", result: { ok: true, message: "Done.", pageChanged: false } }, env);
  RUN.advance(run2, { type: "observed", page }, env);
  RUN.advance(run2, { type: "model_replied", reply: { memory: "", goal: "Answer", actions: [{ do: "done", success: true, answer: "It has five golden stars.", evidence: ["five golden stars"] }] }, usage: {} }, env);
  assert.match(JSON.stringify(run2.history), /not in anything you have been shown/);
});
