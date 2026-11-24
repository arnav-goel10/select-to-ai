"use strict";
// Keys and focus around cards that arrive on their own (extension/keyGuard.js):
// nothing takes focus from a field being typed in, and a card's buttons act
// on no key press that began before the card was in view for a moment.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const KEYS = require("../../extension/keyGuard.js");

const node = (tagName, more) => ({ nodeType: 1, tagName, getAttribute: (n) => (more && more.attrs && more.attrs[n]) || null, ...more });

test("a field the user types in is told apart from a button or the page", () => {
  assert.equal(KEYS.isTypingField(node("TEXTAREA")), true);
  assert.equal(KEYS.isTypingField(node("INPUT", { type: "text" })), true);
  assert.equal(KEYS.isTypingField(node("INPUT", { type: "email" })), true);
  assert.equal(KEYS.isTypingField(node("DIV", { isContentEditable: true })), true);
  assert.equal(KEYS.isTypingField(node("DIV", { attrs: { role: "textbox" } })), true);
  assert.equal(KEYS.isTypingField(node("INPUT", { type: "checkbox" })), false);
  assert.equal(KEYS.isTypingField(node("BUTTON")), false);
  assert.equal(KEYS.isTypingField(node("BODY")), false);
  assert.equal(KEYS.isTypingField(null), false);
});

test("focus is never moved out of a field the user is typing in", () => {
  let moved = 0;
  const target = { focus: () => { moved++; } };
  const composer = node("TEXTAREA");
  assert.equal(KEYS.offerFocus({ activeElement: composer }, target), false);
  assert.equal(moved, 0);
  assert.equal(KEYS.offerFocus({ activeElement: node("BODY") }, target), true);
  assert.equal(KEYS.offerFocus({ activeElement: node("BUTTON") }, target), true);
  assert.equal(moved, 2);
});

test("a keyboard click counts only once the card is armed, from a key that went down after", () => {
  const kb = { trusted: true, detail: 0 };
  // Not yet in view long enough: no key acts.
  assert.equal(KEYS.clickCounts(kb, Infinity, 100, { downAt: 99, upAt: null, repeat: false }), false);
  assert.equal(KEYS.clickCounts(kb, 600, 500, { downAt: 499, upAt: null, repeat: false }), false);
  // Armed, but the key went down before (Enter typed in the box as the card came).
  assert.equal(KEYS.clickCounts(kb, 600, 700, { downAt: 550, upAt: null, repeat: false }), false);
  // Space let go on the button after it went down early.
  assert.equal(KEYS.clickCounts(kb, 600, 700, { downAt: 550, upAt: 699, repeat: false }), false);
  // A held key's repeats never count.
  assert.equal(KEYS.clickCounts(kb, 600, 900, { downAt: 850, upAt: null, repeat: true }), false);
  // A fresh press after the card was armed counts.
  assert.equal(KEYS.clickCounts(kb, 600, 900, { downAt: 890, upAt: null, repeat: false }), true);
  // A screen reader's click, with no key on the page, counts once armed.
  assert.equal(KEYS.clickCounts(kb, 600, 900, { downAt: 100, upAt: 120, repeat: false }), true);
  assert.equal(KEYS.clickCounts(kb, 600, 900, null), true);
  // A pointer press, or the page's own script, is not held back.
  assert.equal(KEYS.clickCounts({ trusted: true, detail: 1 }, Infinity, 10, null), true);
  assert.equal(KEYS.clickCounts({ trusted: false, detail: 0 }, Infinity, 10, null), true);
});

/** A page and a card with listeners that can be called with trusted-looking events. */
function fakePage() {
  const on = { doc: {}, card: {} };
  const add = (where) => (type, f) => { (on[where][type] = on[where][type] || []).push(f); };
  const remove = (where) => (type, f) => { on[where][type] = (on[where][type] || []).filter((g) => g !== f); };
  const doc = { visibilityState: "visible", addEventListener: add("doc"), removeEventListener: remove("doc") };
  const button = { closest: () => button };
  const card = { ownerDocument: doc, contains: (x) => x === button, addEventListener: add("card"), removeEventListener: remove("card") };
  let observed = null;
  class IO { constructor(cb) { observed = cb; } observe() {} disconnect() {} }
  let clock = 0;
  const win = { IntersectionObserver: IO, performance: { now: () => clock } };
  const fire = (where, type, e) => { for (const f of on[where][type] || []) f(e); };
  const click = () => {
    let acted = true;
    fire("card", "click", { isTrusted: true, detail: 0, target: button, preventDefault() {}, stopImmediatePropagation() { acted = false; } });
    return acted;
  };
  const key = (type, k, extra) => fire("doc", type, { key: k, timeStamp: clock, ...extra });
  return { doc, card, win, click, key, show: (v) => observed([{ isIntersecting: v, intersectionRatio: v ? 1 : 0 }]), at: (t) => { clock = t; }, on };
}

test("Enter held from the box as a card arrives does not answer it; a new press once it has been seen does", () => {
  const p = fakePage();
  const stop = KEYS.guardKeys(p.card, null, { win: p.win, armMs: 500 });
  // The user is typing and presses Enter just as the card appears.
  p.at(0); p.key("keydown", "Enter");
  p.show(true);
  assert.equal(p.click(), false, "the press that began before the card does nothing");
  p.at(300); p.key("keydown", "Enter", { repeat: true });
  assert.equal(p.click(), false, "nor do its repeats");
  p.at(400); p.key("keyup", "Enter");
  p.at(450); p.key("keydown", "Enter");
  assert.equal(p.click(), false, "a press before the card has been in view for a moment does nothing");
  p.key("keyup", "Enter");
  p.at(800); p.key("keydown", "Enter");
  assert.equal(p.click(), true, "a fresh press after that answers it");
  stop();
  assert.equal((p.on.card.click || []).length, 0, "the guard lets go when the card leaves");
});

test("a card out of view, or on a page in the background, is not armed", () => {
  const p = fakePage();
  KEYS.guardKeys(p.card, null, { win: p.win, armMs: 500 });
  p.at(0); p.show(false);
  p.at(2000); p.key("keydown", " ");
  assert.equal(p.click(), false, "scrolled away: keys do nothing");
  p.key("keyup", " ");
  p.show(true);
  p.at(2100); p.key("keydown", " ");
  assert.equal(p.click(), false, "just scrolled back: not yet");
  p.key("keyup", " ");
  p.at(2400);
  p.doc.visibilityState = "hidden";
  for (const f of p.on.doc.visibilitychange) f({});
  p.doc.visibilityState = "visible";
  for (const f of p.on.doc.visibilitychange) f({});
  p.at(2700); p.key("keydown", " ");
  assert.equal(p.click(), false, "the page was hidden: the moment starts again");
  p.key("keyup", " ");
  p.at(3200); p.key("keydown", " ");
  assert.equal(p.click(), true);
});

test("the agent page never moves focus onto a card, guards each card's buttons, and offers focus to the box only when it is free", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../extension/agent.js"), "utf8");
  const drawWait = src.slice(src.indexOf("  function drawWait("), src.indexOf("  function removeCard("));
  assert.ok(drawWait.length > 1000, "drawWait was found");
  assert.doesNotMatch(drawWait, /\.focus\(/, "a card never takes focus");
  assert.match(drawWait, /KEYS\.guardKeys\(card, actions\)/, "a card's buttons are guarded");
  assert.match(drawWait, /announce\(/, "a card is said to screen readers");
  const showSelection = src.slice(src.indexOf("  function showSelection("), src.indexOf("  function updateComposerForSelection("));
  assert.match(showSelection, /KEYS\.offerFocus\(document, taskInput\)/, "a selection arriving does not take focus from another field");
  const html = fs.readFileSync(path.resolve(__dirname, "../../extension/agent.html"), "utf8");
  assert.ok(html.indexOf('src="keyGuard.js"') > 0 && html.indexOf('src="keyGuard.js"') < html.indexOf('src="agent.js"'), "the guard loads before the page");
});

test("a box turned off while the user types in it gets the cursor back when it is on again", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../extension/agent.js"), "utf8");
  const controls = src.slice(src.indexOf("  function engineControls("), src.indexOf("    composer.dataset.mode"));
  assert.match(controls, /if \(off && !taskInput\.disabled && document\.activeElement === taskInput\) composerLostFocus = true;/);
  assert.match(controls, /if \(free && !modalOpen\(\)\) taskInput\.focus\(\{ preventScroll: true \}\);/);
});
