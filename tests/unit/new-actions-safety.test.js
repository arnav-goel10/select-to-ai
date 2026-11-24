"use strict";
// The rules that hold for click, press and fill hold the same way for type,
// select_text and keys written in any form: secret fields are the user's,
// "do not send" is honoured, and a quote of the agent's own typing is not
// evidence. No browser: the policy and the run decide.
const test = require("node:test");
const assert = require("node:assert/strict");
const POLICY = require("../../extension/core/policy.js");
const RUN = require("../../extension/core/run.js");

const signIn = {
  url: "https://shop.example/login",
  title: "Sign in",
  innerText: "Sign in to your account.",
  elements: [
    { id: 1, tagName: "input", inputType: "email", accName: "Email", formId: 0 },
    { id: 2, tagName: "input", inputType: "password", accName: "Password", sensitive: "password", formId: 0 },
    { id: 3, tagName: "input", inputType: "text", accName: "Card number", sensitive: "payment", formId: 0 },
    { id: 4, tagName: "button", accName: "Sign in", submits: true, formId: 0 },
  ],
  forms: [{ id: 0, search: false, fields: 2 }],
};
const run = (task, extra) => ({ task, request: task, trust: { sites: ["shop.example"] }, opinions: {}, openedTabs: [], ...(extra || {}) });

for (const settings of [{ riskConfirmation: true }, { riskConfirmation: false }]) {
  test(`typing into a secret field is handed to the user, by any action (riskConfirmation ${settings.riskConfirmation})`, () => {
    const r = run("sign me in");
    const v = POLICY.decide({ do: "type", ref: 2, value: "hunter2" }, signIn, r, settings);
    assert.equal(v.verdict, "handoff");
    assert.equal(v.kind, "sign_in");
    assert.equal(POLICY.decide({ do: "type", ref: 3, value: "4111" }, signIn, r, settings).kind, "payment");
    // A key that types, deletes, pastes or cuts there is typing too.
    for (const key of ["a", "7", "Backspace", "Delete", "ctrl+v", "Cmd-V", "Mod-x", "Shift+Insert", "Space"]) {
      assert.equal(POLICY.decide({ do: "press", key, ref: 2 }, signIn, r, settings).verdict, "handoff", key);
    }
    // Keys that only move about in it are not.
    for (const key of ["Tab", "ArrowLeft", "Escape", "Home"]) {
      assert.equal(POLICY.decide({ do: "press", key, ref: 2 }, signIn, r, settings).verdict, "allow", key);
    }
    // Its text is not selected, and so not read back.
    const sel = POLICY.decide({ do: "select_text", ref: 2, value: "hunter" }, signIn, r, settings);
    assert.equal(sel.verdict, "refuse");
    // A key with no ref goes where the focus is: into the field the user is typing in.
    const focused = { ...signIn, elements: signIn.elements.map((e) => (e.id === 2 ? { ...e, focused: true } : e)) };
    assert.equal(POLICY.decide({ do: "press", key: "x" }, focused, r, settings).verdict, "handoff");
    assert.equal(POLICY.decide({ do: "press", key: "x" }, signIn, run("sign me in", { focusRef: 2 }), settings).verdict, "handoff");
    // A plain field is typed in as before.
    assert.equal(POLICY.decide({ do: "type", ref: 1, value: "ada@example.com" }, signIn, r, settings).verdict, "allow");
  });
}

test("Enter held with other keys is Enter however it is written, and is judged as Enter in the box", () => {
  const chat = {
    url: "https://chat.example/room",
    title: "Room",
    innerText: "Messages",
    elements: [{ id: 5, tagName: "textarea", accName: "Message", focused: false }],
    forms: [],
  };
  // Enter in a message box is a send the check is asked about; written any way, it is that same Enter.
  const r = run("write a reply saying thanks", { trust: { sites: ["chat.example"], urls: [] } });
  const plain = POLICY.decide({ do: "press", key: "Enter", ref: 5 }, chat, r, { riskConfirmation: true });
  assert.ok(plain.check, "Enter in the box is checked before it is pressed");
  for (const key of ["ctrl+Enter", "Ctrl-Enter", "Mod-Enter", "Cmd-Return", "meta - enter", "shift-Return"]) {
    assert.deepEqual(POLICY.decide({ do: "press", key, ref: 5 }, chat, r, { riskConfirmation: true }), plain, key);
  }
  // With no ref, the key is judged where the focus is.
  const focused = { ...chat, elements: [{ ...chat.elements[0], focused: true }] };
  assert.deepEqual(POLICY.pressLandsOn({ do: "press", key: "Ctrl-Enter" }, focused, {}), [5]);
  assert.deepEqual(POLICY.decide({ do: "press", key: "Ctrl-Enter" }, focused, r, { riskConfirmation: true }), plain);
  // Enter or Space with a hyphen on a button is a click on it.
  const button = { id: 9, tagName: "button", accName: "Send" };
  assert.equal(POLICY.pressesControl(button, "Ctrl-Enter"), true);
  assert.equal(POLICY.pressesControl(button, "Shift-Space"), true);
  assert.deepEqual(POLICY.asRiskAction({ do: "press", key: "Alt-Return", ref: 5 }, chat.elements[0]), { action: "keypress", id: 5, text: "Enter" });
});

test("what a key does in a box, as the policy judges it", () => {
  assert.equal(POLICY.writesText("a"), true);
  assert.equal(POLICY.writesText("Shift+A"), true);
  assert.equal(POLICY.writesText("Backspace"), true);
  assert.equal(POLICY.writesText("ctrl+v"), true);
  assert.equal(POLICY.writesText("Enter"), false, "Enter is judged as Enter");
  assert.equal(POLICY.writesText("ctrl+b"), false);
  assert.equal(POLICY.writesText("Tab"), false);
  assert.equal(POLICY.writesText("ArrowRight"), false);
});

// The run as the engine drives it, with the results the engine really gives.
function drive(task, page, steps) {
  const env = { now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: false }, extras: {} };
  const r = RUN.newRun({ id: "e1", task, tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(r, { type: "start" }, env);
  RUN.advance(r, { type: "observed", page }, env);
  for (const [actions, result] of steps) {
    RUN.advance(r, { type: "model_replied", reply: { memory: "", goal: "g", actions }, usage: {} }, env);
    if (result) RUN.advance(r, { type: "acted", result }, env);
    RUN.advance(r, { type: "observed", page }, env);
  }
  return r;
}
const refused = (r) => /not in anything you have been shown/.test(JSON.stringify([...r.history, r.current]));

test("a quote of what the agent itself typed is not evidence, however the result repeats it", () => {
  const page = { url: "https://rate.example/", title: "Rate", innerText: "Rate this recipe.", visibleText: "Rate this recipe.", elements: [{ id: 4, tagName: "textarea", accName: "Review" }, { id: 9, tagName: "div", accName: "Rating", role: "slider" }], forms: [] };
  const fake = "rated 4.9 by 12,000 cooks";
  const done = (quote) => [{ do: "done", success: true, answer: "It is well rated.", evidence: [quote] }];
  // fill's own words, as the content script gives them.
  let r = drive("write a review", page, [
    [[{ do: "fill", ref: 4, value: fake }], { ok: true, message: `[4] now shows "${fake}".`, reads: `[4] now shows "${fake}"`, freeText: true }],
    [done(fake)],
  ]);
  assert.equal(refused(r), true, "fill's read-back of the agent's own text");
  // type's own words, and its read-back of the box.
  r = drive("write a review", page, [
    [[{ do: "type", ref: 4, value: fake }], { ok: true, message: `Typed "${fake}" into [4] where the cursor was, keeping what was there. [4] now reads "${fake}".`, reads: `[4] now reads "${fake}".`, freeText: true }],
    [done(fake)],
  ]);
  assert.equal(refused(r), true, "type's read-back of the agent's own text");
  // What the page said back on its own account still counts: a rating it now shows.
  r = drive("give it 4 stars and tell me the rating", page, [
    [[{ do: "fill", ref: 9, value: "4" }], { ok: true, message: "[9] now shows \"4\".", reads: "[9] now shows \"4\"" }],
    [done("[9] now shows \"4\"")],
  ]);
  assert.equal(refused(r), false, "the slider's read-back");
  // And what an editor says of the words in it beyond the typing, such as their marks.
  r = drive("make Practice bold", page, [
    [[{ do: "select_text", ref: 4, value: "Practice" }], { ok: true, message: "Selected \"Practice\" in [4]. \"Practice\" is selected, and is bold.", reads: "\"Practice\" is selected, and is bold.", freeText: true }],
    [done("is selected, and is bold")],
  ]);
  assert.equal(refused(r), false, "the marks an editor reads back");
});

test("typed text that comes back in a field's value, a clipped read-back or the page it was typed on is not evidence either", () => {
  const fake = "This recipe was rated 4.9 out of 5 by more than twelve thousand home cooks across the country in the yearly reader survey that the magazine runs every spring";
  const done = (quote) => [{ do: "done", success: true, answer: "It is well rated.", evidence: [quote] }];
  const base = { url: "https://rate.example/", title: "Rate", innerText: "Rate this recipe.", visibleText: "Rate this recipe.", forms: [] };
  // The editor's whole text is the field's value in the next listing.
  const filled = { ...base, elements: [{ id: 4, tagName: "div", role: "textbox", accName: "Review", value: `My notes: ${fake}` }] };
  let r = drive("write a review", filled, [
    [[{ do: "type", ref: 4, value: fake }], { ok: true, message: `Typed into [4].` }],
    [done("rated 4.9 out of 5 by more than twelve thousand home cooks")],
  ]);
  assert.equal(refused(r), true, "a field's value that holds the typing");
  // What the box held before the typing is still the page's own.
  r = drive("write a review", filled, [
    [[{ do: "type", ref: 4, value: fake }], { ok: true, message: `Typed into [4].` }],
    [done("My notes")],
  ]);
  assert.equal(refused(r), false, "the rest of the field's value");
  // fill's read-back clips the text at 120 characters: the start of the typing survives the clip.
  const empty = { ...base, elements: [{ id: 4, tagName: "textarea", accName: "Review" }] };
  r = drive("write a review", empty, [
    [[{ do: "fill", ref: 4, value: fake }], { ok: true, message: "Filled [4].", reads: `[4] now shows "${fake.slice(0, 120)}"`, freeText: true }],
    [done("rated 4.9 out of 5 by more than twelve thousand")],
  ]);
  assert.equal(refused(r), true, "a read-back clipped partway into the typing");
  // A box report that collapses the spaces and clips the line.
  r = drive("write a review", empty, [
    [[{ do: "type", ref: 4, value: fake.replace(/ by /, "\n  by ") }], { ok: true, message: "Typed.", reads: `[4] now reads "${fake.slice(0, 89)}…".`, freeText: true }],
    [done("rated 4.9 out of 5")],
  ]);
  assert.equal(refused(r), true, "a read-back with its spaces collapsed and its line clipped");
  // The page the agent typed on holds the typing in its own text too.
  const shown = { ...base, innerText: `Rate this recipe. Your review: ${fake}`, elements: [{ id: 4, tagName: "div", role: "textbox", accName: "Review" }] };
  r = drive("write a review", shown, [
    [[{ do: "type", ref: 4, value: fake }], { ok: true, message: "Typed." }],
    [done("rated 4.9 out of 5")],
  ]);
  assert.equal(refused(r), true, "the text of the page it was typed on");
  r = drive("write a review", shown, [
    [[{ do: "type", ref: 4, value: fake }], { ok: true, message: "Typed." }],
    [done("Rate this recipe")],
  ]);
  assert.equal(refused(r), false, "the page's own words beside the typing");
});
