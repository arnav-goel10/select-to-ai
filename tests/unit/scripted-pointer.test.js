"use strict";
// The pointer made by script, for a build with no debugger: one place makes
// the fields of every pointer and mouse event, a click is the sequence a
// mouse makes, the pointer leaves what it was over, and a page that cancels
// mousedown keeps its focus.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CONTENT, build } = require("../helpers/content-source.js");

class FakeEvent {
  constructor(type, init) { this.type = type; this.init = init || {}; }
}
class FakePointerEvent extends FakeEvent {}
class FakeMouseEvent extends FakeEvent {}

/** A page of elements that write down every event sent to them. */
function page() {
  const log = [];
  const node = (name, parent, cancels) => {
    const n = {
      name, nodeType: 1, parentElement: parent || null, isConnected: true,
      contains(x) { for (let y = x; y; y = y.parentElement) if (y === n) return true; return false; },
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
      dispatchEvent(e) { log.push({ on: name, type: e.type, init: e.init, pointer: e instanceof FakePointerEvent }); return !(cancels || []).includes(e.type); },
    };
    return n;
  };
  const focused = [];
  const fns = build(["centreOf", "pointerInit", "movePointerTo", "pointerTargetIn", "dispatchClickEvents", "dispatchHoverEvents"], {
    window: { screenX: 100, screenY: 50 },
    document: { elementFromPoint: () => null },
    PointerEvent: FakePointerEvent,
    MouseEvent: FakeMouseEvent,
    upOf: (n) => n.parentElement || null,
    focusField: (el) => focused.push(el.name),
    pointerOver: null,
  });
  return { log, node, focused, ...fns };
}

test("every scripted pointer event is a primary mouse pointer that crosses shadow boundaries", () => {
  const { pointerInit } = page();
  const idle = pointerInit({ x: 30, y: 40 });
  assert.equal(idle.composed, true);
  assert.equal(idle.pointerId, 1);
  assert.equal(idle.pointerType, "mouse");
  assert.equal(idle.isPrimary, true);
  assert.deepEqual([idle.clientX, idle.clientY, idle.screenX, idle.screenY], [30, 40, 130, 90]);
  assert.deepEqual([idle.buttons, idle.pressure, idle.detail], [0, 0, 0]);
  const held = pointerInit({ x: 1, y: 1 }, { held: true, detail: 1, modifiers: { shiftKey: true } });
  assert.deepEqual([held.buttons, held.pressure, held.detail, held.shiftKey, held.ctrlKey], [1, 0.5, 1, true, false]);
  assert.equal(pointerInit({ x: 1, y: 1 }, { held: true, button: 2 }).buttons, 2);
});

test("clicks, hovers and drags take their fields from the one factory", () => {
  // The only place a pointer's position is written into an event.
  assert.equal(CONTENT.split("clientX: ").length - 1, 1);
  assert.match(CONTENT, /const at = \(s, buttons\) => pointerInit\(s, \{ held: buttons === 1 \}\);/);
});

test("a scripted click is the sequence a mouse makes, ending in one click counted as the first", () => {
  const p = page();
  const button = p.node("button", p.node("body"));
  assert.equal(p.dispatchClickEvents(button), true);
  const on = p.log.filter((e) => e.on === "button").map((e) => e.type);
  assert.deepEqual(on, ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  assert.ok(p.log.every((e) => e.init.composed === true && e.init.pointerType === "mouse"));
  const of = (type) => p.log.find((e) => e.on === "button" && e.type === type);
  assert.deepEqual([of("mousedown").init.buttons, of("mousedown").init.detail, of("mousedown").init.pressure], [1, 1, 0.5]);
  assert.deepEqual([of("click").init.buttons, of("click").init.detail, of("click").pointer], [0, 1, true]);
  // The browser sends the change of a box a click ticks: none is made here.
  assert.ok(!p.log.some((e) => e.type === "change"));
  // The pointer is at the control's middle.
  assert.deepEqual([of("click").init.clientX, of("click").init.clientY], [60, 40]);
});

test("the second click of a double click says it is the second", () => {
  const p = page();
  const button = p.node("button");
  p.dispatchClickEvents(button, {}, null, 2);
  assert.equal(p.log.find((e) => e.type === "click").init.detail, 2);
});

test("the focus moves on a press, but not when the page cancelled mousedown", () => {
  const plain = page();
  plain.dispatchClickEvents(plain.node("button"));
  assert.deepEqual(plain.focused, ["button"]);
  const editor = page();
  editor.dispatchClickEvents(editor.node("bold", null, ["mousedown"]));
  assert.deepEqual(editor.focused, []);
  // The click itself still goes out.
  assert.ok(editor.log.some((e) => e.type === "click"));
});

test("a click the page cancelled is reported as cancelled", () => {
  const p = page();
  assert.equal(p.dispatchClickEvents(p.node("link", null, ["click"])), false);
});

test("the pointer leaves what it was over before it arrives somewhere else", () => {
  const p = page();
  const bar = p.node("bar");
  const menu = p.node("menu", bar);
  const entry = p.node("entry", menu);
  const other = p.node("other", bar);
  p.dispatchHoverEvents(entry);
  p.log.length = 0;
  p.dispatchClickEvents(other);
  const seen = p.log.map((e) => `${e.on}:${e.type}`);
  // Out of the entry and of the menu around it, not of the bar both are in.
  assert.deepEqual(seen.slice(0, 6), ["entry:pointerout", "entry:mouseout", "entry:pointerleave", "entry:mouseleave", "menu:pointerleave", "menu:mouseleave"]);
  assert.ok(!seen.includes("bar:mouseleave") && !seen.includes("bar:mouseenter"));
  assert.equal(p.log.find((e) => e.type === "mouseout").init.relatedTarget, other);
  assert.equal(p.log.find((e) => e.type === "mouseleave").init.bubbles, false);
  assert.equal(p.log.find((e) => e.on === "other" && e.type === "mouseover").init.relatedTarget, entry);
});

test("a box around the target hears the pointer enter it", () => {
  const p = page();
  const item = p.node("item");
  const link = p.node("link", item);
  p.dispatchHoverEvents(link);
  const seen = p.log.map((e) => `${e.on}:${e.type}`);
  assert.ok(seen.indexOf("item:mouseenter") >= 0 && seen.indexOf("item:mouseenter") < seen.indexOf("link:mouseenter"));
});

test("a second click on the same thing does not arrive again, and a second hover does", () => {
  const p = page();
  const button = p.node("button");
  p.dispatchClickEvents(button);
  p.log.length = 0;
  p.dispatchClickEvents(button);
  assert.ok(!p.log.some((e) => e.type === "mouseover"));
  p.log.length = 0;
  p.dispatchHoverEvents(button);
  assert.ok(p.log.some((e) => e.type === "mouseover"));
  assert.ok(!p.log.some((e) => e.type === "mouseout"));
});
