"use strict";
// Removing a value from a field is an edit of the page, not a delete; and a
// step the user declines leaves the run going, never waiting on a question
// they have already answered.
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../extension/agentTools.js");
const RUN = require("../../extension/core/run.js");
const POLICY = require("../../extension/core/policy.js");

const chip = (label, extra) => ({ id: 1, tagName: "div", role: "button", accName: label, inField: true, ...extra });
const page = (els, forms) => ({ url: "https://forms.example/edit", elements: els, forms: forms || [] });
const click = (el, forms) => T.actionRisk({ action: "click", id: el.id }, page([el], forms));
const decide = (el) => POLICY.decide({ do: "click", ref: el.id }, page([el]), { trust: {}, task: "edit the field" }, { riskConfirmation: true });

test("the x on a chosen value, or a field's clear button, is not held as a delete, in any wording", () => {
  for (const label of ["Remove Purple", "Remove item", "Delete tag teal", "Remove", "Clear", "Clear all", "Supprimer", "Entfernen Rot", "×", ""]) {
    const el = chip(label);
    assert.equal(click(el), null, label);
    assert.equal(T.pressCheckOf({ action: "click", id: 1 }, page([el])), null, `${label}: no second opinion is needed`);
    assert.equal(decide(el).verdict, "allow", label);
  }
});

test("the same words on a control outside a field are still held: a saved record, a cart line, a link", () => {
  for (const label of ["Remove Purple", "Remove item", "Remove", "Delete"]) {
    const el = { id: 1, tagName: "button", accName: label };
    assert.equal(click(el).kind, "delete", label);
    assert.equal(decide(el).verdict, "confirm", label);
  }
  // A cart line's Remove, listed next to its quantity and price: the content
  // script never marks it as part of a field, so it is a delete.
  const cartLine = { id: 1, tagName: "button", accName: "Remove Blue Widget from basket", group: "Blue Widget, $19, Qty 1" };
  assert.equal(click(cartLine).kind, "delete");
  // A link that says it removes is never a field's own button.
  assert.equal(click({ id: 1, tagName: "a", accName: "Remove", href: "#", inField: true }).kind, "delete");
  assert.ok(T.pressCheckOf({ action: "click", id: 1 }, page([{ id: 1, tagName: "a", accName: "Remove", url: "https://forms.example/remove?id=4", href: "/remove?id=4", inField: true }])), "a remove link inside a field is still asked about");
});

test("a field's button that submits, pays or sends is held whatever its place", () => {
  const forms = [{ id: 0, search: false, fields: 2 }];
  assert.equal(click(chip("Remove", { tagName: "button", submits: true, formId: 0 }), forms).kind, "delete", "a submit button is never a value's x");
  assert.equal(click(chip("Buy now")).kind, "pay");
  assert.equal(click(chip("Send")).kind, "send");
  assert.equal(decide(chip("Place order")).verdict, "confirm");
});

// ------------------------------------------------------------- declining

const shop = {
  url: "https://shop.example/basket", title: "Basket", scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Basket", innerText: "Basket. Blue Widget $19. Purple Mug $8.",
  elements: [
    { id: 1, tagName: "button", accName: "Remove Purple Mug" },
    { id: 2, tagName: "button", accName: "Continue shopping" },
  ],
  forms: [],
};
const env = () => ({ now: 1000, page: shop, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} });
const reply = (run, actions) => RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "g", actions }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } }, env());
const declinedRun = () => {
  const run = RUN.newRun({ id: "r1", task: "tidy my basket", tabId: 7, startUrl: shop.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env());
  RUN.advance(run, { type: "observed", page: shop }, env());
  reply(run, [{ do: "click", ref: 1 }]);
  assert.equal(run.wait.kind, "approval");
  assert.equal(run.wait.risk, "delete");
  const fx = RUN.advance(run, { type: "declined", id: run.wait.id }, env());
  assert.deepEqual(fx, [{ type: "observe" }]);
  return run;
};
const results = (run) => run.history.flatMap((h) => h.actions.map((a) => a.result));

test("a declined step tells the model to go another way or finish with what it did and did not do", () => {
  const run = declinedRun();
  const said = results(run)[0];
  assert.match(said, /The user declined this step \(it would delete something\)\. It was not done\./);
  assert.match(said, /Do not ask them about it again/);
  assert.match(said, /another way that needs no go-ahead/);
  assert.match(said, /finish now and say what you did, what you did not do and why/);
  // The model is shown that on its next step.
  const fx = RUN.advance(run, { type: "observed", page: shop }, env());
  assert.match(fx[0].user, /what you did not do and why/);
});

test("a question back about the declined step is not put to the user once; the run goes on and can finish", () => {
  const run = declinedRun();
  RUN.advance(run, { type: "observed", page: shop }, env());
  const fx = reply(run, [{ do: "ask_user", kind: "question", question: "You declined removing the Purple Mug. Do you still want me to remove it?" }]);
  assert.equal(run.status, "running", "the run is not left waiting on the question");
  assert.deepEqual(fx, [{ type: "observe" }]);
  assert.match(results(run).pop(), /^Not asked: the user has just declined a step, and that is their answer\./);
  // The model finishes with an answer.
  RUN.advance(run, { type: "observed", page: shop }, env());
  reply(run, [{ do: "done", success: false, answer: "I did not remove the Purple Mug, because you declined it. Nothing else was changed.", evidence: [] }]);
  assert.ok(["done", "failed"].includes(run.status) || run.pendingDone, `the run ends with its answer (${run.status})`);
});

test("a model that asks about it a second time is let through, and a question about something else is asked at once", () => {
  const run = declinedRun();
  RUN.advance(run, { type: "observed", page: shop }, env());
  reply(run, [{ do: "ask_user", kind: "question", question: "Should I remove the Purple Mug after all?" }]);
  RUN.advance(run, { type: "observed", page: shop }, env());
  reply(run, [{ do: "ask_user", kind: "question", question: "Should I remove the Purple Mug after all?" }]);
  assert.equal(run.status, "waiting", "asked the second time: the model is not overruled twice");

  const other = declinedRun();
  RUN.advance(other, { type: "observed", page: shop }, env());
  reply(other, [{ do: "ask_user", kind: "question", question: "Which colour of widget do you want?" }]);
  assert.equal(other.status, "waiting");
  assert.equal(other.wait.kind, "question");
});

test("once the user says something, a question about the step is theirs to answer again", () => {
  const run = declinedRun();
  RUN.advance(run, { type: "steer", text: "actually, remove the mug" }, env());
  RUN.advance(run, { type: "observed", page: shop }, env());
  reply(run, [{ do: "ask_user", kind: "question", question: "Remove the Purple Mug now?" }]);
  assert.equal(run.status, "waiting");
});
