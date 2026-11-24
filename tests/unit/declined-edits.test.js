"use strict";
// Removing a value from a field is an edit of the page, not a delete; and a
// step the user declines leaves the run going, never waiting on a question
// they have already answered.
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../extension/agentTools.js");
const RUN = require("../../extension/core/run.js");
const POLICY = require("../../extension/core/policy.js");

const JUDGE = require("../helpers/fake-judge.js");
// The page-blind press check, answered at once by a stand-in for its model.
const advance = JUDGE.judging(RUN);

const chip = (label, extra) => ({ id: 1, tagName: "div", role: "button", accName: label, inField: true, ...extra });
const page = (els, forms) => ({ url: "https://forms.example/edit", elements: els, forms: forms || [] });
const click = (el, forms) => T.actionRisk({ action: "click", id: el.id }, page([el], forms));
const decide = (el, forms, opinions) => POLICY.decide({ do: "click", ref: el.id }, page([el], forms), { trust: {}, task: "edit the field", opinions: opinions || {} }, { riskConfirmation: true });
// A form that sends nothing until its own submit control is pressed.
const staged = [{ id: 0, method: "post", fields: 1, hasSubmit: true }];

test("the x on a chosen value, in a form with its own submit, passes with no check in any wording", () => {
  for (const label of ["Remove Purple", "Remove item", "Delete tag teal", "Remove", "Clear", "Clear all", "Supprimer", "Entfernen Rot", "×"]) {
    const el = chip(label, { formId: 0 });
    assert.equal(click(el, staged), null, label);
    assert.deepEqual(T.pressEntryOf(el, page([el], staged)), { pass: "staged" }, `${label}: nothing leaves until the form's submit`);
    assert.deepEqual(decide(el, staged), { verdict: "allow" }, label);
  }
  // The same x outside such a form may save at once: it is judged, told what kind of control it is.
  const loose = chip("Remove Purple");
  assert.equal(T.pressEntryOf(loose, page([loose])).entry.kind, "button");
  assert.ok(decide(loose).check, "asked about");
});

test("the same words on a control outside a field are judged by the check, and held when it says they delete", () => {
  for (const label of ["Remove Purple", "Remove item", "Remove", "Delete"]) {
    const el = { id: 1, tagName: "button", accName: label };
    assert.equal(click(el), null, `${label}: nothing in the page's structure holds it`);
    const p = page([el]);
    assert.ok(decide(el).check, `${label}: put to the check`);
    assert.equal(decide(el, [], JUDGE.judged(p)).verdict, "confirm", label);
  }
  // A cart line's Remove, listed next to its quantity and price: never a field's x.
  const cartLine = { id: 1, tagName: "button", accName: "Remove Blue Widget from basket", group: "Blue Widget, $19, Qty 1" };
  assert.equal(decide(cartLine, [], JUDGE.judged(page([cartLine]))).verdict, "confirm");
  // A link that says it removes is never a field's own button: it is judged as a link.
  const link = { id: 1, tagName: "a", accName: "Remove", url: "https://forms.example/remove?id=4", href: "/remove?id=4", inField: true };
  assert.equal(T.pressEntryOf(link, page([link])).entry.kind, "link");
});

test("a field's button that submits, pays or sends is held whatever its place", () => {
  const forms = [{ id: 0, search: false, fields: 2 }];
  assert.equal(click(chip("Remove", { tagName: "button", submits: true, formId: 0 }), forms).kind, "send", "a submit button is never a value's x");
  for (const label of ["Buy now", "Send", "Place order"]) {
    const el = chip(label);
    assert.equal(decide(el, [], JUDGE.judged(page([el]))).verdict, "confirm", label);
  }
});

// ------------------------------------------------------------- declining

const shop = {
  url: "https://shop.example/basket", title: "Basket", scrollY: 0, scrollX: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Basket", innerText: "Basket. Blue Widget $19. Purple Mug $8.",
  elements: [
    { id: 1, tagName: "button", accName: "Remove Purple Mug", group: "Purple Mug, $8", rect: { x: 100, y: 100, w: 120, h: 30 } },
    { id: 2, tagName: "button", accName: "Continue shopping", rect: { x: 100, y: 200, w: 120, h: 30 } },
    { id: 3, tagName: "button", accName: "Remove Blue Widget", group: "Blue Widget, $19", rect: { x: 100, y: 300, w: 120, h: 30 } },
    { id: 4, tagName: "span", accName: "Purple Mug", rect: { x: 300, y: 100, w: 80, h: 30 } },
  ],
  forms: [],
};
const env = (page) => ({ now: 1000, page: page || shop, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} });
const reply = (run, actions, page) => advance(run, { type: "model_replied", reply: { memory: "", goal: "g", actions }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } }, env(page));
const look = (run, page) => advance(run, { type: "observed", page: page || shop }, env(page));
const declinedRun = (first) => {
  const run = RUN.newRun({ id: "r1", task: "tidy my basket", tabId: 7, startUrl: shop.url, marker: "PAGE-abcd1234", now: 1 });
  advance(run, { type: "start" }, env());
  look(run);
  reply(run, [first || { do: "click", ref: 1 }]);
  assert.equal(run.wait.kind, "approval");
  const fx = advance(run, { type: "declined", id: run.wait.id }, env());
  assert.deepEqual(fx, [{ type: "observe" }]);
  return run;
};
const results = (run) => run.history.flatMap((h) => h.actions.map((a) => a.result));

test("a declined step tells the model not to bring about the declined result another way, leaves it the rest, and to finish saying what it did and did not do", () => {
  const run = declinedRun();
  const said = results(run)[0];
  assert.match(said, /The user declined this step \(it would change or remove something of theirs\)\. It was not done\./);
  assert.match(said, /Do not ask them about it again/);
  assert.match(said, /do not bring about the result they declined in some other way/);
  assert.match(said, /Only that result is off limits: other controls, pages and addresses that do something else are still yours to use\./);
  assert.doesNotMatch(said, /needs no go-ahead|do that\./, "nothing tells the model to go round the decline");
  assert.match(said, /Carry on with any part of the request that does not need it\. Then finish and say what you did, what you did not do and why\./);
  // The model is shown that on its next step.
  const fx = look(run);
  assert.match(fx[0].user, /what you did not do and why/);
});

const heldAgain = (run, a) => {
  assert.equal(run.status, "waiting", `${JSON.stringify(a)} is held for the user`);
  assert.equal(run.wait.kind, "approval", JSON.stringify(a));
  assert.equal(run.wait.risk, "delete", `${JSON.stringify(a)}: held as what was declined`);
  assert.ok([run.wait.question, ...run.wait.detail].some((t) => /^You declined "Remove Purple Mug" a moment ago\. This would do it again/.test(t)), JSON.stringify(run.wait));
};

test("after a decline, every other way to the declined control is the user's to allow again: a key on it, a key landing on it, a press at its spot, a drop on it", () => {
  const tries = [
    { do: "press", ref: 1, key: "Delete" },
    { do: "press", ref: 1, key: "Backspace" },
    { do: "press", ref: 1, key: "Enter" },
    { do: "press", ref: 1, key: "Space" },
    { do: "click_at", x: 150, y: 110 },
    { do: "drag", ref: 4, to_ref: 1 },
    { do: "fill", ref: 1, value: "x" },
  ];
  for (const a of tries) {
    // Not held without the decline: the rules alone let some of these through.
    const fresh = RUN.newRun({ id: "f", task: "tidy my basket", tabId: 7, startUrl: shop.url, marker: "PAGE-abcd1234", now: 1 });
    if (a.key === "Delete") assert.equal(POLICY.decide(a, shop, fresh, { riskConfirmation: true }).verdict, "allow", "a Delete key alone is not held");
    const run = declinedRun();
    look(run);
    reply(run, [a]);
    heldAgain(run, a);
  }
  // A key with no ref that lands on the focused declined control.
  const focused = { ...shop, elements: shop.elements.map((e) => (e.id === 1 ? { ...e, focused: true } : e)) };
  const run = declinedRun();
  look(run, focused);
  reply(run, [{ do: "press", key: "Delete" }], focused);
  assert.equal(run.wait && run.wait.kind, "approval");
});

test("after a decline, the same control renumbered on a redraw is still the declined one; another row's Remove is asked about as usual; looking is free", () => {
  const redrawn = { ...shop, elements: shop.elements.map((e) => ({ ...e, id: e.id + 10 })) };
  const run = declinedRun();
  look(run, redrawn);
  reply(run, [{ do: "press", ref: 11, key: "Delete" }], redrawn);
  assert.equal(run.wait && run.wait.kind, "approval");
  const other = declinedRun();
  look(other);
  reply(other, [{ do: "press", ref: 3, key: "Delete" }]);
  assert.ok(!other.wait, "another row's control is not the declined one");
  assert.equal(POLICY.decide({ do: "hover", ref: 1 }, shop, other, { riskConfirmation: true }).verdict, "allow");
  assert.equal(POLICY.decide({ do: "click", ref: 3 }, shop, other, { riskConfirmation: true }).verdict, "confirm");
});

test("a declined address opened another way is asked about again, saying so", () => {
  // An address the agent wrote itself, on a site the request does not name, is held; the user says no.
  const run = declinedRun({ do: "navigate", url: "https://pay.example/checkout#pay" });
  assert.equal(run.declined[0].urls[0], "https://pay.example/checkout");
  look(run);
  const v = POLICY.decide({ do: "tabs", op: "open", url: "https://pay.example/checkout" }, shop, run, { riskConfirmation: true });
  assert.equal(v.verdict, "confirm");
  assert.match(v.detail[0], /^You declined "https:\/\/pay\.example\/checkout" a moment ago\. This would do it again another way\./);
});

test("once the user speaks, the rules alone decide again", () => {
  const run = declinedRun();
  advance(run, { type: "steer", text: "actually, remove the mug" }, env());
  look(run);
  reply(run, [{ do: "press", ref: 1, key: "Delete" }]);
  assert.ok(!run.wait, "the rules alone decide again");
  assert.equal(run.declined.length, 0);
});

test("a sub-task handed out after a decline does not do the declined step either, and a step declined in a sub-task holds for the run", () => {
  const run = declinedRun();
  look(run);
  advance(run, { type: "model_replied", reply: { note: "", goal: "split", do: "delegate", tasks: [{ task: "remove the mug" }] }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } }, env());
  const child = run.children[0].run;
  assert.equal(POLICY.decide({ do: "press", ref: 1, key: "Delete" }, shop, child, { riskConfirmation: true }).verdict, "confirm");

  // The other way: the user declines inside a sub-task, which then ends.
  const blank = { url: "about:blank", title: "", elements: [], innerText: "", visibleText: "", protectedPage: true };
  const pages = {};
  const penv = () => ({ ...env(), childEnv: (id) => ({ page: pages[id] || null, extras: {} }) });
  const parent = RUN.newRun({ id: "p", task: "tidy my basket", tabId: 7, startUrl: shop.url, marker: "PAGE-abcd1234", now: 1 });
  advance(parent, { type: "start" }, penv());
  advance(parent, { type: "observed", page: shop }, penv());
  advance(parent, { type: "model_replied", reply: { note: "", goal: "split", do: "delegate", tasks: [{ task: "remove the mug", url: shop.url }] }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } }, penv());
  const c = (event) => advance(parent, { type: "child", child: "p-s1", event }, penv());
  c({ type: "spawned", tabId: 101 });
  pages["p-s1"] = blank;
  c({ type: "observed", page: blank });
  c({ type: "acted", result: { ok: true, pageChanged: true, message: "Opened" } });
  pages["p-s1"] = shop;
  c({ type: "observed", page: shop });
  c({ type: "model_replied", reply: { memory: "", goal: "g", actions: [{ do: "click", ref: 1 }] }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } });
  const sub = parent.children[0].run;
  assert.equal(POLICY.decide({ do: "press", ref: 1, key: "Delete" }, shop, parent, { riskConfirmation: true }).verdict, "allow", "before the decline");
  assert.equal(sub.wait && sub.wait.kind, "approval");
  c({ type: "declined", id: sub.wait.id });
  c({ type: "observed", page: shop });
  c({ type: "model_replied", reply: { memory: "", goal: "g", actions: [{ do: "done", success: false, answer: "I did not remove the mug: you declined it.", evidence: [] }] }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } });
  assert.equal(parent.delegation, null, "the sub-task ended");
  assert.equal(POLICY.decide({ do: "press", ref: 1, key: "Delete" }, shop, parent, { riskConfirmation: true }).verdict, "confirm");
});

test("a question back about the declined step is not put to the user; asked again, the next step is the last; a third time, the run ends with an answer", () => {
  const run = declinedRun();
  look(run);
  let fx = reply(run, [{ do: "ask_user", kind: "question", question: "You declined removing the Purple Mug. Do you still want me to remove it?" }]);
  assert.equal(run.status, "running", "the run is not left waiting on the question");
  assert.deepEqual(fx, [{ type: "observe" }]);
  assert.match(results(run).pop(), /^Not asked: the user has just declined "Remove Purple Mug", and that is their answer\./);
  look(run);
  reply(run, [{ do: "ask_user", kind: "question", question: "Should I remove the Purple Mug after all?" }]);
  assert.equal(run.status, "running", "asked twice: still not put to the user");
  assert.match(results(run).pop(), /Your next step is the last: finish then\./);
  fx = look(run);
  assert.equal(run.finalStep, true);
  assert.match(fx[0].user, /The user declined "Remove Purple Mug", and you have asked about it again\. This is the last step/);
  // Handing the control to the user to press is asking about it too.
  reply(run, [{ do: "ask_user", kind: "press", ref: 1, question: "Please press Remove yourself." }]);
  assert.equal(run.status, "failed", "the run ends, never waiting on it");
  assert.equal(run.outcome.kind, "declined");
  assert.match(run.outcome.text, /^You declined "Remove Purple Mug", so it was not done, and I stopped there\./);
});

test("a question about something else is asked at once, and an address's scheme and host words do not tie a question to it", () => {
  const other = declinedRun();
  look(other);
  reply(other, [{ do: "ask_user", kind: "question", question: "Which colour of widget do you want?" }]);
  assert.equal(other.status, "waiting");
  assert.equal(other.wait.kind, "question");
  const away = declinedRun({ do: "navigate", url: "https://www.pay.example/checkout" });
  look(away);
  reply(away, [{ do: "ask_user", kind: "question", question: "Do you want the https link to the www help page?" }]);
  assert.equal(away.status, "waiting", "words every address has do not name the declined one");
});

test("once the user says something, a question about the step is theirs to answer again", () => {
  const run = declinedRun();
  advance(run, { type: "steer", text: "actually, remove the mug" }, env());
  look(run);
  reply(run, [{ do: "ask_user", kind: "question", question: "Remove the Purple Mug now?" }]);
  assert.equal(run.status, "waiting");
});

test("after a decline, typing into the declined control or selecting its text is the user's to allow again, and a secret field stays theirs", () => {
  const box = { id: 5, tagName: "textarea", accName: "Message to seller", rect: { x: 100, y: 400, w: 300, h: 60 } };
  const withBox = { ...shop, elements: [...shop.elements, box] };
  const fresh = RUN.newRun({ id: "f", task: "tidy my basket", tabId: 7, startUrl: shop.url, marker: "PAGE-abcd1234", now: 1 });
  assert.equal(POLICY.decide({ do: "select_text", ref: 1 }, withBox, fresh, { riskConfirmation: true }).verdict, "allow", "not held without the decline");
  const run = declinedRun();
  look(run);
  for (const a of [{ do: "type", ref: 1, value: "x" }, { do: "select_text", ref: 1 }]) {
    const v = POLICY.decide(a, withBox, run, { riskConfirmation: true });
    assert.equal(v.verdict, "confirm", JSON.stringify(a));
    assert.ok([v.why, ...(v.detail || [])].some((t) => /^You declined "Remove Purple Mug" a moment ago/.test(t)), JSON.stringify(v));
  }
  assert.equal(POLICY.decide({ do: "type", ref: 5, value: "hello" }, withBox, run, { riskConfirmation: true }).verdict, "allow", "another control is judged alone");
  const pw = { ...shop, elements: [{ id: 1, tagName: "input", type: "password", sensitive: "password", accName: "Password" }] };
  assert.equal(POLICY.decide({ do: "type", ref: 1, value: "hunter2" }, pw, run, { riskConfirmation: true }).verdict, "handoff");
  assert.equal(POLICY.decide({ do: "select_text", ref: 1 }, pw, run, { riskConfirmation: true }).verdict, "refuse");
});
