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
  assert.ok(!/—/.test(about), "no long dashes in the tool");
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
  const run = { task: "tidy my account", trust: { sites: [], urls: [] }, opinions: {} };
  const settings = { riskConfirmation: true };
  for (const kind of ["click", "double_click", "hold", "right_click"]) {
    assert.equal(POLICY.decide({ do: kind, ref: 7 }, page, run, settings, null).verdict, "confirm", `${kind} on a delete button is held`);
  }
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
  assert.match(ENGINE, /case "double_click": return interact\(session, a, \{ action: "double_click", id: a\.ref, \.\.\.spotOf\(a\) \}, true\);/);
  assert.match(ENGINE, /case "right_click": return interact\(session, a, \{ action: "right_click", id: a\.ref, \.\.\.spotOf\(a\) \}, false\);/);
  assert.match(ENGINE, /case "hold": return interact\(session, a, \{ action: "hold", id: a\.ref, seconds: a\.seconds, \.\.\.spotOf\(a\) \}, true\);/);
  assert.match(ENGINE, /case "hover": return interact\(session, a, \{ action: "hover", id: a\.ref, \.\.\.spotOf\(a\) \}, false\);/);
  assert.match(ENGINE, /toText: a\.to_text, \.\.\.spotOf\(a\), \.\.\.dropSpot\(a\)/);
  // A look at one control asks the page for its own picture before the tab's.
  assert.match(ENGINE, /send\(tabId, \{ action: "picture", id: at\.id \}, at\.frameId\)/);
  for (const name of ["double_click", "right_click", "hold"]) assert.ok(require("../../extension/core/view.js").PAGE_ACTIONS.has(name), `${name} acts on the page`);
});

// ------------------------------------------------------------ the listing

test("a drawing is listed with its size, to aim at spots inside it", () => {
  assert.match(TOOLS.formatElementLine({ id: 4, tagName: "canvas", size: { w: 400, h: 300 }, at: { x: 200, y: 150 } }), /^\[4\] canvas no name at 200,150 drawing 400x300$/);
  assert.match(CONTENT, /if \(isDrawing\(el\)\) return true;/);
  const { isDrawing } = build(["isDrawing"], {});
  const box = (tag, w, h, extra) => ({ tagName: tag, ownerSVGElement: null, closest: () => null, getBoundingClientRect: () => ({ width: w, height: h }), ...(extra || {}) });
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

test("the drag result says how the page took it, and when it took it in none of the ways", () => {
  assert.match(CONTENT, /The page took it as a drag and drop, and it was dropped on /);
  assert.match(CONTENT, /did not take the drop\./);
  assert.match(CONTENT, /The page answered the drag in none of the ways it was made: mouse, pointer and touch\./);
  assert.match(CONTENT, /it was made again as a touch, and the page answered that\./);
});
