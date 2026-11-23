"use strict";
// Whole gestures, for a build whose pointer is made by script: a double
// click, a right click, a long press, a hover that stays, a press or a drag
// aimed at a spot inside a control, a drop before or after an item or on a
// place named by its words, and the browser's drag and drop with one
// DataTransfer. Each is offered to the model as an action of its own, is
// judged as the press it is, and is the run of events a page listens for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const STEP = require("../../extension/core/step.js");
const TOOLS = require("../../extension/agentTools.js");
const { CONTENT, build } = require("../helpers/content-source.js");

const ENGINE = fs.readFileSync(path.join(__dirname, "../../extension/engine.js"), "utf8");

// ------------------------------------------------------------ the step tool

const els = [
  { id: 3, tagName: "td", text: "SO-24101" },
  { id: 4, tagName: "canvas", size: { w: 400, h: 300 } },
  { id: 5, tagName: "div", text: "Banana", draggable: true },
  { id: 6, tagName: "li", text: "First item" },
];
const check = (raw) => STEP.checkAction(raw, { page: { elements: els } });

test("the tool offers a double click, a right click and a long press, each on a control", () => {
  const tool = STEP.stepTool({});
  const names = tool.parameters.properties.do.enum;
  for (const n of ["double_click", "right_click", "hold"]) assert.ok(names.includes(n), `${n} is offered`);
  const about = tool.parameters.properties.do.description;
  assert.match(about, /double_click: press a control twice/);
  assert.match(about, /right_click: [^.]*context menu/);
  assert.match(about, /hold: press a control and keep it pressed/);
  assert.match(about, /The pointer stays there until your next action/);
  assert.match(about, /to_text, words written on the place/);
  for (const f of ["fx", "fy", "to_text", "place", "to_fx", "to_fy"]) assert.ok(tool.parameters.properties[f], `${f} is a field`);
  assert.ok(!/\u2014/.test(about), "no long dashes in the tool");
  assert.deepEqual(check({ do: "double_click", ref: 3 }).action, { do: "double_click", ref: 3 });
  assert.match(check({ do: "right_click" }).error, /right_click needs ref/);
});

test("other names for the gestures are the gestures", () => {
  assert.equal(check({ do: "dblclick", ref: 3 }).action.do, "double_click");
  assert.equal(check({ do: "contextmenu", ref: 3 }).action.do, "right_click");
  assert.equal(check({ do: "long_press", ref: 3 }).action.do, "hold");
  assert.equal(check({ do: "press_and_hold", ref: 3 }).action.do, "hold");
});

test("a spot inside a control is a fraction of its box; a percentage is read as one", () => {
  assert.deepEqual(check({ do: "click", ref: 4, fx: 0.25, fy: 0.75 }).action, { do: "click", ref: 4, fx: 0.25, fy: 0.75 });
  assert.deepEqual(check({ do: "hover", ref: 4, fx: 40, fy: "10%" }).action, { do: "hover", ref: 4, fx: 0.4, fy: 0.1 });
  // One fraction alone keeps the middle on the other axis.
  assert.deepEqual(check({ do: "double_click", ref: 4, fx: 0.1 }).action, { do: "double_click", ref: 4, fx: 0.1, fy: 0.5 });
  assert.match(check({ do: "click", ref: 4, fx: -1, fy: 0.5 }).error, /fractions of the box from 0 to 1/);
  assert.match(check({ do: "hover", ref: 4, fx: "left", fy: 0.5 }).error, /fractions/);
  // A press with no spot is aimed at the middle, as before.
  assert.deepEqual(check({ do: "click", ref: 3 }).action, { do: "click", ref: 3 });
});

test("a long press lasts a second unless told, and never past ten", () => {
  assert.equal(check({ do: "hold", ref: 3 }).action.seconds, 1);
  assert.equal(check({ do: "hold", ref: 3, seconds: 2.5 }).action.seconds, 2.5);
  assert.equal(check({ do: "hold", ref: 3, seconds: 60 }).action.seconds, 10);
  assert.equal(check({ do: "hold", ref: 3, seconds: 0.01 }).action.seconds, 0.3);
  assert.equal(STEP.describe(check({ do: "hold", ref: 3, seconds: 2 }).action), "hold [3] for 2s");
});

test("a drag lets go on a control, before or after an item, at a spot of it, or on a place named by its words", () => {
  assert.deepEqual(check({ do: "drag", ref: 5, to_ref: 6, place: "before" }).action, { do: "drag", ref: 5, to_ref: 6, place: "before" });
  assert.deepEqual(check({ do: "drag", ref: 5, to_ref: 4, to_fx: 0.5625, to_fy: 0.0625 }).action, { do: "drag", ref: 5, to_ref: 4, to_fx: 0.563, to_fy: 0.063 });
  assert.deepEqual(check({ do: "drag", ref: 5, to_text: "  accepts:  food " }).action, { do: "drag", ref: 5, to_text: "accepts: food" });
  // "onto" is the default and is not written down.
  assert.deepEqual(check({ do: "drag", ref: 5, to_ref: 6, place: "onto" }).action, { do: "drag", ref: 5, to_ref: 6 });
  assert.match(check({ do: "drag", ref: 5, to_ref: 6, place: "under" }).error, /place is "onto", "before" or "after"/);
  assert.match(check({ do: "drag", ref: 5 }).error, /to_text \(words written on the place\)/);
  assert.equal(STEP.describe(check({ do: "drag", ref: 5, to_text: "In Progress", place: "after" }).action), 'drag [5] after "In Progress"');
  assert.equal(STEP.describe(check({ do: "drag", ref: 5, fx: 0.2, fy: 0.5, to_ref: 6 }).action), "drag [5] at 0.2,0.5 onto [6]");
  // Two drags to different places are two different actions.
  assert.notEqual(STEP.signature(check({ do: "drag", ref: 5, to_ref: 6, place: "before" }).action), STEP.signature(check({ do: "drag", ref: 5, to_ref: 6, place: "after" }).action));
});

test("look can be given one control, to picture it", () => {
  assert.deepEqual(check({ do: "look", ref: 4 }).action, { do: "look", ref: 4 });
  assert.deepEqual(check({ do: "look" }).action, { do: "look" });
  assert.match(check({ do: "look", ref: 99 }).action.gone, /There is no control \[99\]/);
});

// ------------------------------------------------------------ the policy

test("a double click, a right click and a long press are judged as the press they are", () => {
  const POLICY = require("../../extension/core/policy.js");
  const page = { url: "https://shop.example/", title: "Shop", innerText: "Account", elements: [{ id: 7, tagName: "button", text: "Delete account" }, { id: 8, tagName: "div", text: "Press and hold", role: "button" }, { id: 9, tagName: "span", text: "report.pdf" }] };
  const JUDGE = require("../helpers/fake-judge.js");
  // What the page-blind press check said, by a stand-in for its model, of the
  // page's controls and of the places named by their words below.
  const place = (words) => TOOLS.pressEntryOf({ id: -1, tagName: "div", text: words, accName: words }, page).entry;
  const named = { [place("Delete forever").key]: { does: "delete" }, [place("Attachments").key]: { does: "none" } };
  const run = { task: "tidy my account", trust: { sites: [], urls: [] }, opinions: JUDGE.judged(page, null, named) };
  const settings = { riskConfirmation: true };
  for (const kind of ["click", "hold", "right_click"]) {
    assert.equal(POLICY.decide({ do: kind, ref: 7 }, page, run, settings, null).verdict, "confirm", `${kind} on a delete button is held`);
  }
  // A double click would press it twice: one press is approved, by click.
  const twice = POLICY.decide({ do: "double_click", ref: 7 }, page, run, settings, null);
  assert.equal(twice.verdict, "refuse");
  assert.match(twice.message, /presses "Delete account" twice[^.]*\. Use click instead\./);
  // A press-and-hold human check is the person's to pass, however it is pressed.
  const v = POLICY.decide({ do: "hold", ref: 8, seconds: 3 }, page, run, settings, null);
  assert.equal(v.verdict, "handoff");
  assert.equal(v.kind, "human_check");
  // A drop on a place named by its words is a press on that place.
  assert.equal(POLICY.decide({ do: "drag", ref: 9, to_text: "Delete forever" }, page, run, settings, null).verdict, "confirm");
  assert.equal(POLICY.decide({ do: "drag", ref: 9, to_text: "Attachments" }, page, run, settings, null).verdict, "allow");
});

// ------------------------------------------------------------ the engine

test("the engine sends each gesture to the page with its spot and where it lets go", () => {
  // A press the check judges by the control's names carries those names, for the page to press only while it still has them.
  assert.match(ENGINE, /case "double_click": return interact\(session, a, \{ action: "double_click", id: a\.ref, \.\.\.spotOf\(a\), \.\.\.namesOf\(session, a\), \.\.\.onceIf\(a\) \}, true\);/);
  assert.match(ENGINE, /case "right_click": return interact\(session, a, \{ action: "right_click", id: a\.ref, \.\.\.spotOf\(a\), \.\.\.namesOf\(session, a\), \.\.\.onceIf\(a\) \}, false\);/);
  assert.match(ENGINE, /case "hold": return interact\(session, a, \{ action: "hold", id: a\.ref, seconds: a\.seconds, \.\.\.spotOf\(a\), \.\.\.namesOf\(session, a\), \.\.\.onceIf\(a\) \}, true\);/);
  assert.match(ENGINE, /case "hover": return interact\(session, a, \{ action: "hover", id: a\.ref, \.\.\.spotOf\(a\) \}, false\);/);
  assert.match(ENGINE, /toText: a\.to_text, toWords: place\.words, \.\.\.spotOf\(a\), \.\.\.dropSpot\(a\), \.\.\.onceIf\(a\)/);
  // A look at one control asks the page for its own picture before the tab's.
  assert.match(ENGINE, /send\(tabId, \{ action: "picture", id: at\.id \}, at\.frameId\)/);
  for (const name of ["double_click", "right_click", "hold"]) assert.ok(require("../../extension/core/view.js").PAGE_ACTIONS.has(name), `${name} acts on the page`);
});

// ------------------------------------------------------------ the listing

test("a drawing is listed with its size, to aim at spots inside it", () => {
  assert.match(TOOLS.formatElementLine({ id: 4, tagName: "canvas", size: { w: 400, h: 300 }, at: { x: 200, y: 150 } }), /^\[4\] canvas no name at 200,150 drawing 400x300$/);
  assert.match(CONTENT, /if \(isDrawing\(el\)\) return true;/);
  const { isDrawing } = build(["isDrawing"], { window: { innerWidth: 0, innerHeight: 0, getComputedStyle: () => ({ pointerEvents: "auto" }) }, document: {}, agentDrawn: () => false });
  const box = (tag, w, h, extra) => ({ tagName: tag, ownerSVGElement: null, closest: () => null, contains: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }), ...(extra || {}) });
  assert.equal(isDrawing(box("CANVAS", 400, 300)), true);
  assert.equal(isDrawing(box("svg", 600, 400)), true);
  assert.equal(isDrawing(box("svg", 16, 16)), false, "an icon is not a drawing");
  assert.equal(isDrawing(box("svg", 600, 400, { closest: () => ({}) })), false, "a picture inside a button is the button's");
  assert.equal(isDrawing(box("svg", 600, 400, { ownerSVGElement: {} })), false, "only the outermost picture");
  assert.equal(isDrawing(box("DIV", 600, 400)), false);
});

// ------------------------------------------------------------ the events

class FakeEvent { constructor(type, init) { this.type = type; this.init = init || {}; Object.assign(this, init || {}); } }
class FakePointerEvent extends FakeEvent {}
class FakeMouseEvent extends FakeEvent {}
class FakeDragEvent extends FakeEvent {}
class FakeTouchEvent extends FakeEvent {}
class FakeTouch { constructor(init) { Object.assign(this, init); } }
class FakeDataTransfer { constructor() { this.store = {}; this.dropEffect = "none"; } setData(k, v) { this.store[k] = v; } getData(k) { return this.store[k] || ""; } }

/** A page of boxes at places on screen that write down every event sent to them. */
function page(opts) {
  const o = opts || {};
  const log = [];
  const boxes = [];
  const node = (name, parent, box, behave) => {
    const n = {
      name, nodeType: 1, parentElement: parent || null, isConnected: true, tagName: "DIV",
      attrs: {},
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      contains(x) { for (let y = x; y; y = y.parentElement) if (y === n) return true; return false; },
      closest(sel) {
        for (let y = n; y; y = y.parentElement) {
          if (sel === "[draggable]" && y.attrs.draggable !== undefined) return y;
          if (sel === '[draggable="true"]' && y.attrs.draggable === "true") return y;
        }
        return null;
      },
      getBoundingClientRect: () => ({ left: box[0], top: box[1], width: box[2], height: box[3], right: box[0] + box[2], bottom: box[1] + box[3] }),
      dispatchEvent(e) {
        log.push({ on: name, type: e.type, init: e.init, kind: e.constructor.name, at: Date.now() });
        const r = behave && behave[e.type] ? behave[e.type](e) : undefined;
        return r !== false;
      },
    };
    boxes.push(n);
    return n;
  };
  const deepest = (x, y) => {
    let hit = null;
    for (const b of boxes) {
      const r = b.getBoundingClientRect();
      if (b.name !== "body" && x >= r.left && x < r.right && y >= r.top && y < r.bottom && (!hit || hit.contains(b))) hit = b;
    }
    return hit;
  };
  const scope = {
    window: { screenX: 0, screenY: 0, scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 800 },
    document: { elementFromPoint: deepest, body: null, visibilityState: "hidden" },
    PointerEvent: FakePointerEvent, MouseEvent: FakeMouseEvent, DragEvent: FakeDragEvent, TouchEvent: FakeTouchEvent, Touch: FakeTouch,
    DataTransfer: FakeDataTransfer,
    upOf: (n) => n.parentElement || null,
    focusField: () => {},
    pointerOver: null,
    drawnAt: deepest,
    delay: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))),
    cancelRequested: false,
    GESTURE: { HOVER_MOVES: 6, HOVER_STEP_MS: 40, CLICK_GAP_MS: 80, DRAG_HOLD_MS: 160, DRAG_MOVES: 16, DRAG_STEP_MS: 35, DROP_REST_MS: 150, DRAG_START_PX: 4 },
    ...(o.scope || {}),
  };
  scope.gestureDelay = () => Promise.resolve();
  // Every point of the window is on the page's body at least.
  scope.document.body = node("body", null, [0, 0, 1000, 800]);
  const fns = build(["centreOf", "pointerInit", "movePointerTo", "pointerTargetIn", "dispatchClickEvents", "dispatchHoverEvents", "spotIn", "dwellHover",
    "scriptedDoubleClick", "scriptedRightClick", "scriptedHold", "touchAt", "sendTouch", "touchGesture", "scriptedDragSteps", "syntheticDrag",
    "listRunsAcross", "dropAim", "newWords"], scope);
  return { log, node, ...fns, seen: (on) => log.filter((e) => !on || e.on === on).map((e) => e.type) };
}

test("a spot inside a control is that fraction of its box, kept inside its edges", () => {
  const p = page();
  const board = p.node("board", null, [100, 200, 400, 400]);
  assert.deepEqual(p.spotIn(board, 0.5625, 0.8125), { x: 325, y: 525 });
  assert.deepEqual(p.spotIn(board, 0, 1), { x: 104, y: 596 });
});

test("a double click is two clicks close together, the second counted as the second, then the double click, on what is under the spot", () => {
  const p = page();
  const grid = p.node("grid", null, [0, 0, 600, 300]);
  const cell = p.node("cell", grid, [100, 40, 120, 30]);
  return p.scriptedDoubleClick(grid, {}, { x: 150, y: 50 }).then((went) => {
    assert.equal(went, true);
    const on = p.log.filter((e) => e.on === "cell");
    assert.deepEqual(on.map((e) => e.type).filter((t) => /down|up|click/.test(t)), ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"]);
    assert.deepEqual(on.filter((e) => e.type === "mousedown").map((e) => e.init.detail), [1, 2]);
    assert.equal(on.find((e) => e.type === "dblclick").init.detail, 2);
    assert.ok(on.every((e) => e.init.clientX === 150 && e.init.clientY === 50));
    void cell;
  });
});

test("a right click asks for the context menu with the right button held, and says whether the page took it over", () => {
  const p = page();
  const tree = p.node("tree", null, [0, 0, 300, 300]);
  const node = p.node("node", tree, [20, 20, 100, 20], { contextmenu: () => false });
  const got = p.scriptedRightClick(tree, {}, { x: 30, y: 25 });
  assert.equal(got.taken, true);
  const on = p.log.filter((e) => e.on === "node");
  assert.deepEqual(on.map((e) => e.type).filter((t) => !/over|enter|move/.test(t)), ["pointerdown", "mousedown", "contextmenu", "pointerup", "mouseup", "auxclick"]);
  const menu = on.find((e) => e.type === "contextmenu").init;
  assert.deepEqual([menu.button, menu.buttons], [2, 2]);
  assert.deepEqual([on.find((e) => e.type === "mouseup").init.button, on.find((e) => e.type === "mouseup").init.buttons], [2, 0]);
  // A page with no menu of its own leaves it to the browser.
  const q = page();
  const plain = q.node("plain", null, [0, 0, 100, 100]);
  assert.equal(q.scriptedRightClick(plain, {}, null).taken, false);
  void node;
});

test("a long press holds the button down for the time asked, then lets go, and can be made again by touch", async () => {
  const p = page();
  const button = p.node("button", null, [10, 10, 100, 40]);
  const t0 = Date.now();
  const steps = await p.scriptedHold(button, {}, null, 300);
  const types = p.seen("button").filter((t) => !/over|enter|move/.test(t));
  assert.deepEqual(types, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  const down = p.log.find((e) => e.type === "pointerdown");
  const up = p.log.find((e) => e.type === "pointerup");
  assert.ok(up.at - down.at >= 280, `held ${up.at - down.at} ms`);
  assert.equal(down.init.buttons, 1);
  assert.ok(Date.now() - t0 >= 280);
  p.log.length = 0;
  assert.equal(await p.touchGesture(steps), true);
  assert.deepEqual(p.seen("button"), ["touchstart", "touchend"]);
  const start = p.log[0].init;
  assert.equal(start.touches.length, 1);
  assert.equal(start.changedTouches[0].target, button);
  assert.equal(p.log[1].init.touches.length, 0);
});

test("a hover comes in, moves a few times as it settles at the spot, and is not taken away", async () => {
  const p = page();
  const chart = p.node("chart", null, [0, 0, 400, 300]);
  await p.dwellHover(chart, { x: 200, y: 100 }, {});
  const moves = p.log.filter((e) => e.type === "pointermove");
  assert.ok(moves.length >= 5, `${moves.length} moves`);
  assert.deepEqual([moves[moves.length - 1].init.clientX, moves[moves.length - 1].init.clientY], [200, 100]);
  assert.ok(p.log.filter((e) => e.type === "mousemove").length === moves.length);
  assert.ok(!p.log.some((e) => /out|leave/.test(e.type)), "nothing says the pointer left");
  assert.equal(p.log[0].type, "pointerover");
});

test("a scripted drag holds the press a moment, passes the few pixels a page waits for, and spreads its moves over time", () => {
  const p = page();
  const steps = p.scriptedDragSteps({ x: 0, y: 0 }, { x: 200, y: 0 });
  assert.deepEqual(steps.slice(0, 3).map((s) => s.t), ["move", "down", "wait"]);
  assert.ok(steps[2].ms >= 150 && steps[2].hold === true, "the press is held before it moves, even in a tab nobody can see");
  const moves = steps.filter((s) => s.t === "move");
  assert.ok(moves.length >= 18);
  assert.ok(moves[1].x > 0 && moves[1].x < 5 && moves[2].x >= 10, "small moves first, past the start distance");
  const waited = steps.filter((s) => s.t === "wait").reduce((n, s) => n + s.ms, 0);
  assert.ok(waited >= 600 && waited <= 1200, `${waited} ms`);
  assert.deepEqual(steps[steps.length - 1], { t: "up", x: 200, y: 0 });
  // The real pointer's steps are not these, and are left as they were.
  assert.ok(TOOLS.dragSteps({ x: 0, y: 0 }, { x: 200, y: 0 }).length < steps.length);
});

test("a drag by mouse: pointer events go to what was pressed, mouse events to what is under the pointer", async () => {
  const p = page();
  const left = p.node("left", null, [0, 0, 200, 400]);
  const item = p.node("item", left, [10, 10, 180, 40]);
  const right = p.node("right", null, [300, 0, 200, 400]);
  const r = await p.syntheticDrag(item, p.scriptedDragSteps({ x: 50, y: 30 }, { x: 350, y: 30 }));
  assert.equal(r.dnd, false);
  assert.equal(r.target, right);
  assert.deepEqual(p.seen("item").filter((t) => /down|up/.test(t)), ["pointerdown", "mousedown", "pointerup"]);
  assert.ok(p.seen("item").includes("pointermove") && p.seen("item").filter((t) => t === "pointermove").length >= 18, "every pointer move goes where the press began");
  assert.ok(p.seen("right").includes("mousemove") && p.seen("right").includes("mouseup"), "mouse events go where the pointer is");
  assert.ok(!p.seen("right").includes("pointermove"));
  const pressedAt = p.log.findIndex((e) => e.type === "pointerdown");
  assert.ok(p.log.slice(pressedAt).filter((e) => /move/.test(e.type) && e.init.buttons !== 1).length === 0, "the button is held all the way");
  assert.ok(p.log.every((e) => e.kind !== "FakePointerEvent" || e.init.pointerId === 1));
});

test("a drag of a thing the page lets be dragged is the browser's drag and drop, with one DataTransfer, dropped only where the page takes it", async () => {
  const p = page();
  const transfers = new Set();
  const note = (e) => { transfers.add(e.init.dataTransfer); };
  const bins = p.node("bins", null, [0, 0, 800, 600]);
  const glass = p.node("glass", bins, [0, 0, 200, 200], { dragenter: note, dragover: note });
  const food = p.node("food", bins, [300, 0, 200, 200], { dragover: (e) => { note(e); return false; }, drop: (e) => { note(e); assert.equal(e.init.dataTransfer.getData("text/plain"), "banana"); } });
  const banana = p.node("banana", bins, [100, 400, 100, 40], { dragstart: (e) => { note(e); e.init.dataTransfer.setData("text/plain", "banana"); }, drag: note, dragend: note });
  banana.attrs.draggable = "true";
  const r = await p.syntheticDrag(banana, p.scriptedDragSteps({ x: 150, y: 420 }, { x: 400, y: 100 }));
  assert.deepEqual([r.dnd, r.dropped, r.refused], [true, true, false]);
  const order = p.log.map((e) => `${e.on}:${e.type}`).filter((t) => /drag|drop|cancel|mouseup|pointerup/.test(t));
  assert.equal(order[0], "banana:dragstart");
  assert.equal(order[1], "banana:pointercancel");
  assert.ok(order.includes("banana:drag"));
  assert.ok(order.includes("food:dragenter") && order.includes("food:dragover"));
  assert.ok(order.indexOf("food:drop") > order.lastIndexOf("food:dragover"));
  assert.equal(order[order.length - 1], "banana:dragend");
  assert.ok(!order.some((t) => /mouseup|pointerup/.test(t)), "the browser sends no mouse release in a drag and drop");
  assert.equal(transfers.size, 1, "one DataTransfer from start to end");
  // Left over a place that does not take drops: no drop, and it is said.
  const q = page();
  const shelf = q.node("shelf", null, [0, 0, 800, 600]);
  const chip = q.node("chip", shelf, [10, 10, 60, 20]);
  chip.attrs.draggable = "true";
  const s = await q.syntheticDrag(chip, q.scriptedDragSteps({ x: 20, y: 20 }, { x: 400, y: 300 }));
  assert.deepEqual([s.dnd, s.dropped, s.refused], [true, false, true]);
  assert.ok(!q.seen().includes("drop"));
  void glass; void food;
});

test("a drag of a link the page holds on to by cancelling mousedown stays a mouse drag", async () => {
  const p = page();
  const card = p.node("card", null, [0, 0, 300, 40], { mousedown: () => false });
  card.attrs.draggable = "true";
  const r = await p.syntheticDrag(card, p.scriptedDragSteps({ x: 10, y: 10 }, { x: 10, y: 200 }));
  assert.equal(r.dnd, false);
  assert.ok(!p.seen().includes("dragstart"));
  assert.ok(p.seen().includes("mouseup"));
});

test("a drag of a thing marked not draggable stays a mouse drag", async () => {
  const p = page();
  const row = p.node("row", null, [0, 0, 300, 40]);
  row.attrs.draggable = "false";
  const r = await p.syntheticDrag(row, p.scriptedDragSteps({ x: 10, y: 10 }, { x: 10, y: 200 }));
  assert.equal(r.dnd, false);
  assert.ok(!p.seen().includes("dragstart"));
});

test("a drag made again by touch keeps every touch on what it started on", async () => {
  const p = page();
  const board = p.node("board", null, [0, 0, 400, 400]);
  const piece = p.node("piece", board, [0, 300, 50, 50]);
  assert.equal(await p.touchGesture(p.scriptedDragSteps({ x: 25, y: 325 }, { x: 25, y: 225 })), true);
  const types = p.seen("piece");
  assert.equal(types[0], "touchstart");
  assert.equal(types[types.length - 1], "touchend");
  assert.ok(types.filter((t) => t === "touchmove").length >= 18);
  assert.ok(!p.seen("board").length, "nothing goes to what is under the finger");
  const last = p.log.filter((e) => e.type === "touchmove").pop().init.changedTouches[0];
  assert.deepEqual([last.clientX, last.clientY], [25, 225]);
});

test("before and after an item are aimed in its first or last fifth, along the way its list runs", () => {
  const p = page();
  const list = p.node("list", null, [0, 0, 200, 300]);
  const a = p.node("a", list, [0, 0, 200, 50]);
  const b = p.node("b", list, [0, 60, 200, 50]);
  a.nextElementSibling = b; b.previousElementSibling = a;
  assert.deepEqual(p.dropAim(b, { place: "before" }), { x: 100, y: 70 });
  assert.deepEqual(p.dropAim(b, { place: "after" }), { x: 100, y: 100 });
  const row = p.node("row", null, [0, 400, 600, 50]);
  const c = p.node("c", row, [0, 400, 100, 50]);
  const d = p.node("d", row, [120, 400, 100, 50]);
  c.nextElementSibling = d; d.previousElementSibling = c;
  assert.deepEqual(p.dropAim(d, { place: "before" }), { x: 140, y: 425 });
  assert.deepEqual(p.dropAim(d, { toFx: 0.5, toFy: 0.5 }), { x: 170, y: 425 });
  assert.equal(p.dropAim(d, {}), null);
});

test("the words a gesture brought up are what is on screen after that was not before", () => {
  const p = page();
  assert.deepEqual(p.newWords(["Users", "Line chart", "12"], ["Users", "Line chart", "12", "08:00 - 09:00", "Users", ": 1,204"]), ["08:00 - 09:00", "Users", ": 1,204"]);
  assert.deepEqual(p.newWords(["a", "b"], ["b", "a"]), []);
  // Every gesture of the model's says what words it brought up.
  assert.match(CONTENT, /const GESTURE_ACTIONS = new Set\(\['hover', 'double_click', 'right_click', 'hold', 'drag', 'click_at'\]\);/);
  assert.match(CONTENT, /Text that appeared on screen: /);
});

test("the drag result says how the page took it, and says only what it could see when it saw no change", () => {
  assert.match(CONTENT, /The page took it as a drag and drop, and it was dropped on /);
  assert.match(CONTENT, /did not take the drop\./);
  assert.match(CONTENT, /it was made again as a touch, and the page answered that\./);
  // Never that the page answered in none of the ways: a drawing or a late answer cannot be seen.
  assert.ok(!/none of the ways|answered neither/.test(CONTENT));
  const { noAnswerSeen } = build(["noAnswerSeen"], {});
  for (const what of ["drag", "press"]) assert.match(noAnswerSeen(what), /^No change showed in the page's elements after .* cannot be seen from here: look at the page before trying again\.$/);
});

// ------------------------------------------- every rule for a click, for every press

const POLICY = require("../../extension/core/policy.js");
const RUN = require("../../extension/core/run.js");
const PRESSES = ["click", "double_click", "right_click", "hold"];
const decideOn = (a, page, task) => POLICY.decide(a, page, { task, trust: { sites: [], urls: [] }, opinions: {} }, { riskConfirmation: true }, null);

test("\"fill it in but don't send it\" holds for every way of pressing the send button", () => {
  const page = {
    url: "https://forms.example/apply", title: "Apply", innerText: "Apply",
    elements: [{ id: 1, tagName: "input", accName: "Name", formId: 0 }, { id: 2, tagName: "button", accName: "Submit application", submits: true, formId: 0 }],
    forms: [{ id: 0, search: false, fields: 1 }],
  };
  for (const kind of PRESSES) {
    const v = decideOn({ do: kind, ref: 2 }, page, "fill in the application but don't submit it");
    assert.equal(v.verdict, "refuse", `${kind} on the send button is refused`);
    assert.match(v.message, /filled in but not sent/);
  }
  // A drag let go on it is a press on it too.
  const page2 = { ...page, elements: [...page.elements, { id: 3, tagName: "div", text: "Photo", draggable: true }] };
  assert.equal(decideOn({ do: "drag", ref: 3, to_ref: 2 }, page2, "fill in the application but don't submit it").verdict, "refuse");
});

test("the pay button is the user's to press, however the agent would press it", () => {
  const page = {
    url: "https://shop.example/checkout", title: "Checkout", innerText: "Checkout",
    elements: [
      { id: 1, tagName: "input", accName: "Card number", sensitive: "payment", formId: 0 },
      { id: 2, tagName: "button", accName: "Pay now", submits: true, formId: 0 },
    ],
    forms: [{ id: 0, search: false, fields: 1 }],
  };
  for (const kind of PRESSES) {
    const v = decideOn({ do: kind, ref: 2 }, page, "buy the blue widget");
    assert.equal(v.verdict, "handoff", `${kind} on the pay button is handed to the user`);
    assert.equal(v.kind, "payment");
  }
});

test("one place says which actions press a control, and each is judged by it", () => {
  assert.deepEqual([...POLICY.POINTER_PRESSES], PRESSES);
  for (const kind of PRESSES) assert.equal(POLICY.pressesOn({ do: kind, ref: 1 }, { tagName: "div" }), true);
  assert.equal(POLICY.pressesOn({ do: "press", key: "Enter", ref: 1 }, { tagName: "button" }), true);
  assert.equal(POLICY.pressesOn({ do: "hover", ref: 1 }, { tagName: "button" }), false);
  const src = fs.readFileSync(path.join(__dirname, "../../extension/core/policy.js"), "utf8");
  assert.ok(!/a\.do === "click" \|\| a\.do === "press"/.test(src), "no rule names click alone");
});

test("an approved gesture or drag is marked to be made once, and a drag only onto the control approved", () => {
  const page = {
    url: "https://files.example/", title: "Files", scrollY: 0, viewportHeight: 900, pageHeight: 900, visibleText: "Files", innerText: "Files",
    elements: [
      { id: 1, tagName: "div", accName: "report.pdf", draggable: true },
      { id: 2, tagName: "div", accName: "Delete forever", role: "button" },
      { id: 3, tagName: "button", accName: "Delete account" },
    ],
    forms: [],
  };
  const env = { now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} };
  // The page-blind press check, answered at once by a stand-in for its model.
  const advance = require("../helpers/fake-judge.js").judging(RUN);
  const approve = (action) => {
    const run = RUN.newRun({ id: "r1", task: "tidy up my files", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
    advance(run, { type: "start" }, env);
    advance(run, { type: "observed", page }, env);
    advance(run, { type: "model_replied", reply: { memory: "", goal: "g", actions: [action] }, usage: {} }, env);
    assert.equal(run.status, "waiting", `${action.do} waits for the user`);
    return RUN.advance(run, { type: "approved", id: run.wait.id }, env)[0].action;
  };
  const held = approve({ do: "hold", ref: 3 });
  assert.equal(held.approved, "Delete account");
  const dragged = approve({ do: "drag", ref: 1, to_ref: 2 });
  assert.equal(dragged.approved, "report.pdf");
  assert.equal(dragged.approvedTo, "Delete forever");
  // The driver passes "once" for every approved gesture; the page never makes one again another way.
  for (const name of ["click", "double_click", "right_click", "hold"]) assert.match(ENGINE, new RegExp(`case "${name}": return interact\\(session, a, \\{[^\\n]*onceIf\\(a\\)`));
  assert.match(ENGINE, /\.\.\.spotOf\(a\), expect, \.\.\.onceIf\(a\) \}, true\);/);
  assert.match(ENGINE, /const onceIf = \(a\) => \(a\.once \|\| a\.approved !== undefined \? \{ once: true \} : \{\}\);/);
  // A drag's drop target that changed while the user decided stops the step.
  assert.match(ENGINE, /a\.approvedTo !== undefined && a\.to_ref !== undefined \? \[\[a\.to_ref, a\.approvedTo\]\]/);
});

test("a gesture the page showed no answer to is made again by touch only when nothing says it was answered out of sight", () => {
  const { touchAgain } = build(["touchAgain"], {});
  assert.deepEqual(touchAgain({}, [], "drag", false), { again: true, why: "" });
  assert.deepEqual(touchAgain({}, ["focus", "scroll"], "press", false), { again: true, why: "" });
  const approved = touchAgain({ once: true }, [], "press", false);
  assert.equal(approved.again, false);
  assert.match(approved.why, /The user approved this press, so it was made once and not again another way\./);
  const drawn = touchAgain({}, [], "drag", true);
  assert.equal(drawn.again, false);
  assert.match(drawn.why, /made on a drawing/);
  const asked = touchAgain({}, ["request"], "press", false);
  assert.equal(asked.again, false);
  assert.match(asked.why, /sent a request to its site, and may be answering the press/);
  assert.equal(touchAgain({}, ["value"], "drag", false).again, false);
  // Both gestures that can be made again go through it, with what was watched.
  assert.equal(CONTENT.split("touchAgain(data, outOfSight,").length - 1, 2);
  assert.match(CONTENT, /touchAgain\(data, outOfSight, 'press', onCanvas\(\[at\]\)\)/);
  assert.match(CONTENT, /touchAgain\(data, outOfSight, 'drag', onCanvas\(\[from\.point, end\]\)\)/);
});

test("a gesture on a canvas is a gesture on a drawing", () => {
  const canvases = [{ getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 }) }];
  const { onCanvas } = build(["onCanvas"], { document: { querySelectorAll: () => canvases } });
  assert.equal(onCanvas([{ x: 100, y: 100 }]), true);
  assert.equal(onCanvas([{ x: 500, y: 100 }, { x: 600, y: 10 }]), false);
});

test("a place named by its words holds them as whole words, and is never a container that lacks them", () => {
  const { holdsWords } = build(["holdsWords"], {});
  assert.equal(holdsWords("This tray takes: china", "takes: china"), true);
  assert.equal(holdsWords("Seafood", "food"), false);
  assert.equal(holdsWords("Food bin", "food"), true);
  assert.equal(holdsWords("Delete  forever", "delete forever"), true);
  // A fake page: a text node with the first word only, under a few containers.
  const el = (text, parent, extra) => ({ textContent: text, parentElement: parent || null, contains(x) { for (let y = x; y; y = y.parentElement) if (y === this) return true; return false; }, getBoundingClientRect: () => ({ top: 0, bottom: 10, width: 10, height: 10 }), ...(extra || {}) });
  const body = el("Delete this note");
  const card = el("Delete this note", body);
  const words = { data: "Delete this note", parentElement: card };
  const scope = (nodes) => ({
    document: { body, createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] || null }; } },
    NodeFilter: { SHOW_TEXT: 4 }, openRoots: () => [], agentDrawn: () => false, isRendered: () => true,
    window: { innerHeight: 800 }, holdsWords,
  });
  const { placeNamed } = build(["placeNamed"], scope([words]));
  assert.equal(placeNamed("Delete forever", null), null, "no element holds the whole phrase, so there is no place");
  const bin = el("Delete forever", body);
  const binWords = { data: "Delete forever", parentElement: bin };
  const found = build(["placeNamed"], scope([words, binWords])).placeNamed("delete forever", null);
  assert.equal(found, bin);
});

test("a drop on a place named by part of its words is judged by all the words on it", () => {
  const page = { url: "https://files.example/", title: "Files", innerText: "Files", elements: [{ id: 9, tagName: "span", text: "report.pdf" }] };
  // What the page-blind press check says of each place by its words, as a model would.
  const place = (words) => TOOLS.pressEntryOf({ id: -1, tagName: "div", text: words, accName: words }, page).entry.key;
  const opinions = { [place("report.pdf")]: { does: "none" }, [place("forever")]: { does: "none" }, [place("Delete forever")]: { does: "delete" }, [place("Archive")]: { does: "none" }, [place("Archive 2024")]: { does: "none" } };
  opinions[TOOLS.pressEntryOf(page.elements[0], page).entry.key] = { does: "none" };
  const run = { task: "tidy up my files", trust: { sites: [], urls: [] }, opinions };
  const settings = { riskConfirmation: true };
  const a = { do: "drag", ref: 9, to_text: "forever" };
  assert.equal(POLICY.decide(a, page, run, settings, null).verdict, "allow", "the words alone sound harmless");
  const held = POLICY.placeRiskier(a, "Delete forever", page, run, settings, null);
  assert.equal(held.verdict, "refuse");
  assert.match(held.message, /says "Delete forever" in full/);
  // Named by all its words, it is decided (and approved) the usual way, and the place says no more than that.
  assert.equal(POLICY.decide({ ...a, to_text: "Delete forever" }, page, run, settings, null).verdict, "confirm");
  assert.equal(POLICY.placeRiskier({ ...a, to_text: "Delete forever" }, "Delete forever", page, run, settings, null), null);
  assert.equal(POLICY.placeRiskier({ ...a, to_text: "Archive" }, "Archive 2024", page, run, settings, null), null);
  // The engine finds the place and judges it before the drag, and the page drops only while it says the same.
  assert.match(ENGINE, /send\(tabId, \{ action: "placeNamed", id: from\.id, toText: a\.to_text \}, from\.frameId\)/);
  assert.match(ENGINE, /POLICY\.placeRiskier\(a, place\.words, page, run, session\.settings, memory\)/);
  assert.match(CONTENT, /wordsOfPlace\(named\) !== data\.toWords/);
});

test("only a drawing is listed with a size, and a drawing the page marks as only to be seen is not one", () => {
  assert.match(CONTENT, /if \(\(tag === 'canvas' \|\| tag === 'svg'\) && isDrawing\(el\)\) entry\.size = /);
  const base = { innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ pointerEvents: "auto" }) };
  const make = (win, doc) => build(["isDrawing"], { window: win || base, document: doc || { elementFromPoint: () => null }, agentDrawn: () => false }).isDrawing;
  const chart = (extra) => ({ tagName: "CANVAS", ownerSVGElement: null, closest: () => null, contains: () => false, getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }), ...(extra || {}) });
  const c = chart();
  assert.equal(make(base, { elementFromPoint: () => c })(c), true);
  assert.equal(make(base, { elementFromPoint: () => c })(chart({ closest: (sel) => (/aria-hidden/.test(sel) ? {} : null) })), false, "hidden from assistive technology");
  assert.equal(make({ ...base, getComputedStyle: () => ({ pointerEvents: "none" }) }, { elementFromPoint: () => c })(c), false, "the pointer goes through it");
  const cover = {};
  assert.equal(make(base, { elementFromPoint: () => cover })(c), false, "a backdrop under the page's content");
  // A label over the middle of a chart covers only the middle.
  assert.equal(make(base, { elementFromPoint: (x, y) => (x === 300 && y === 200 ? cover : c) })(c), true);
});

test("a drop is made where the page takes it though the browser ignores a drop effect set on a DataTransfer made by script", async () => {
  // As Chrome makes one with `new DataTransfer()`: not the browser's own drag, so both its effects read "none" and cannot be set.
  class ScriptDataTransfer {
    constructor() { this.store = {}; }
    get dropEffect() { return "none"; }
    set dropEffect(_v) { /* ignored */ }
    get effectAllowed() { return "none"; }
    set effectAllowed(_v) { /* ignored */ }
    setData(k, v) { this.store[k] = v; }
    getData(k) { return this.store[k] || ""; }
  }
  const p = page({ scope: { DataTransfer: ScriptDataTransfer } });
  let got = "";
  const trays = p.node("trays", null, [0, 0, 800, 600]);
  const china = p.node("china", trays, [300, 0, 200, 200], { dragover: () => false, drop: (e) => { got = e.init.dataTransfer.getData("text/plain"); } });
  const cup = p.node("cup", trays, [100, 400, 100, 40], { dragstart: (e) => { e.init.dataTransfer.setData("text/plain", "china:Teacup"); e.init.dataTransfer.effectAllowed = "move"; } });
  cup.attrs.draggable = "true";
  const r = await p.syntheticDrag(cup, p.scriptedDragSteps({ x: 150, y: 420 }, { x: 400, y: 100 }));
  assert.deepEqual([r.dnd, r.dropped, r.refused], [true, true, false]);
  assert.equal(got, "china:Teacup");
  // A place that does not cancel dragover still does not get the drop.
  const q = page({ scope: { DataTransfer: ScriptDataTransfer } });
  const shelf = q.node("shelf", null, [0, 0, 800, 600]);
  const chip = q.node("chip", shelf, [10, 10, 60, 20]);
  chip.attrs.draggable = "true";
  const s = await q.syntheticDrag(chip, q.scriptedDragSteps({ x: 20, y: 20 }, { x: 400, y: 300 }));
  assert.deepEqual([s.dnd, s.dropped, s.refused], [true, false, true]);
  void china;
});

test("a control's own picture is the size of what it draws, without its border", async () => {
  const out = { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => "data:image/jpeg;base64,AA" };
  const { pictureOf } = build(["pictureOf"], { document: { createElement: () => out }, isRendered: () => true });
  const pie = { tagName: "CANVAS", clientWidth: 300, clientHeight: 150, getBoundingClientRect: () => ({ width: 302, height: 152 }) };
  const got = await pictureOf(pie, 4);
  assert.match(got.message, /^A picture of \[4\] \(a canvas, drawn 300 by 150 pixels\) is attached/);
  assert.equal(out.width, 300);
  assert.equal(out.height, 150);
});
