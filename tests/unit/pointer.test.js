"use strict";
// The real pointer: where a point of a frame lands in the window, the
// gestures sent through the debugger, the step fields for drag and
// click_at, how a drag or a press at a point is checked for risk, and
// what the trace says of each pointer action.
const test = require("node:test");
const assert = require("node:assert/strict");
const TOOLS = require("../../extension/agentTools.js");
const STEP = require("../../extension/core/step.js");
const POLICY = require("../../extension/core/policy.js");
const RUN = require("../../extension/core/run.js");

test("a point in the main page is used as it is", () => {
  assert.deepEqual(TOOLS.toViewport({ x: 12.5, y: 40 }, null), { x: 12.5, y: 40 });
});

test("a point in a frame is placed by where the frame's inside starts in the window", () => {
  // A frame whose inside starts 72 px from the left and 512 px from the top, drawn as wide as it lays out.
  assert.deepEqual(TOOLS.toViewport({ x: 100, y: 20 }, { left: 72, top: 512, width: 420, inner: 420 }), { x: 172, y: 532 });
});

test("a point in a frame drawn at another size than it lays out is scaled", () => {
  // Laid out 400 wide, drawn 200 wide (transform: scale(0.5)).
  assert.deepEqual(TOOLS.toViewport({ x: 100, y: 60 }, { left: 10, top: 10, width: 200, inner: 400 }), { x: 60, y: 40 });
  // Nothing known of its own width: drawn as laid out.
  assert.deepEqual(TOOLS.toViewport({ x: 100, y: 60 }, { left: 10, top: 10, width: 200, inner: 0 }), { x: 110, y: 70 });
});

test("a click is a move, a rest, a press and a letting go at one point", () => {
  const steps = TOOLS.clickSteps({ x: 5, y: 6 });
  assert.deepEqual(steps.map((s) => s.t), ["move", "wait", "down", "wait", "up"]);
  assert.ok(steps.filter((s) => s.t !== "wait").every((s) => s.x === 5 && s.y === 6));
  assert.equal(steps[0].aim, true);
});

test("a drag presses at its start, moves in even steps past a first nudge, rests over the drop and lets go there", () => {
  const steps = TOOLS.dragSteps({ x: 0, y: 0 }, { x: 100, y: 0 });
  const moves = steps.filter((s) => s.t === "move");
  assert.equal(steps.find((s) => s.t === "down").x, 0);
  assert.equal(steps[steps.length - 1].t, "up");
  assert.equal(steps[steps.length - 1].x, 100);
  assert.equal(moves[1].x, TOOLS.POINTER.DRAG_START_PX, "a small move first, so the page starts its drag");
  assert.ok(moves.length >= TOOLS.POINTER.DRAG_MOVES + 2);
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i].x >= moves[i - 1].x, "the moves go one way");
  const total = steps.filter((s) => s.t === "wait").reduce((n, s) => n + s.ms, 0);
  assert.ok(total >= 300 && total <= 1000, `the drag takes a short time: ${total} ms`);
});

/** A debugger connection that records what it was sent. */
const recorder = (fail) => {
  const sent = [];
  return { sent, send: async (method, params) => { if (fail && fail(method, params, sent.length)) throw new Error("detached"); sent.push([method, params]); return {}; } };
};

test("a gesture is sent as mouse events, with the button held between press and letting go", async () => {
  const c = recorder();
  const r = await TOOLS.runGesture(TOOLS.clickSteps({ x: 3, y: 4 }), { send: c.send, sleep: async () => {} });
  assert.equal(r.sent, 3);
  assert.deepEqual(c.sent.map(([, p]) => [p.type, p.button, p.buttons]), [["mouseMoved", "none", 0], ["mousePressed", "left", 1], ["mouseReleased", "left", 0]]);
});

test("a drag the page starts with the browser's drag and drop is caught and carried to a drop", async () => {
  const c = recorder();
  const data = { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 };
  let caught = null;
  // The browser says a drag began after the first move with the button held.
  const send = async (method, params) => { await c.send(method, params); if (params && params.type === "mouseMoved" && params.buttons === 1) caught = data; };
  const r = await TOOLS.runGesture(TOOLS.dragSteps({ x: 0, y: 0 }, { x: 50, y: 0 }), { drag: true, send, sleep: async () => {}, dragData: () => caught });
  assert.equal(r.dropped, true);
  const methods = c.sent.map(([m, p]) => `${m}:${p.type || p.enabled}`);
  assert.equal(methods[0], "Input.setInterceptDrags:true");
  assert.equal(methods[methods.length - 1], "Input.setInterceptDrags:false");
  assert.ok(methods.includes("Input.dispatchDragEvent:dragEnter"));
  assert.ok(methods.indexOf("Input.dispatchDragEvent:drop") < methods.indexOf("Input.dispatchMouseEvent:mouseReleased"), methods.join(" "));
  assert.ok(c.sent.filter(([m]) => m === "Input.dispatchDragEvent").every(([, p]) => p.data === data));
});

test("a drag on a page that starts no drag and drop stays mouse events", async () => {
  const c = recorder();
  const r = await TOOLS.runGesture(TOOLS.dragSteps({ x: 0, y: 0 }, { x: 50, y: 0 }), { drag: true, send: c.send, sleep: async () => {}, dragData: () => null });
  assert.equal(r.dropped, false);
  assert.ok(!c.sent.some(([m]) => m === "Input.dispatchDragEvent"));
});

test("a gesture cut off partway says how far it got", async () => {
  const c = recorder((method, params, n) => n === 1);
  const r = await TOOLS.runGesture(TOOLS.clickSteps({ x: 1, y: 1 }), { send: c.send, sleep: async () => {} });
  assert.equal(r.sent, 1);
  assert.match(r.error, /detached/);
});

// --------------------------------------------------------------- step fields

const page = (extra) => ({
  url: "https://shop.example/", scrollX: 0, scrollY: 0,
  elements: [
    { id: 1, tagName: "div", role: "slider", accName: "Volume", rect: { x: 10, y: 10, w: 24, h: 24 } },
    { id: 2, tagName: "li", text: "Apples", rect: { x: 10, y: 100, w: 200, h: 30 } },
    { id: 3, tagName: "div", accName: "Basket", rect: { x: 300, y: 100, w: 200, h: 80 } },
  ],
  ...extra,
});

test("drag takes a control to drop on, or a direction and a distance", () => {
  const p = page();
  assert.deepEqual(STEP.checkAction({ do: "drag", ref: 2, to_ref: 3 }, { page: p }).action, { do: "drag", ref: 2, to_ref: 3 });
  assert.deepEqual(STEP.checkAction({ do: "drag", ref: 1, direction: "right", distance: "120" }, { page: p }).action, { do: "drag", ref: 1, direction: "right", distance: 120 });
  assert.match(STEP.checkAction({ do: "drag", ref: 1 }, { page: p }).error, /to_ref .* or direction/);
  assert.match(STEP.checkAction({ do: "drag", ref: 1, direction: "sideways", distance: 5 }, { page: p }).error, /direction/);
  assert.match(STEP.checkAction({ do: "drag", to_ref: 3 }, { page: p }).error, /drag needs ref/);
  assert.match(STEP.checkAction({ do: "drag", ref: 2, to_ref: 2 }, { page: p }).error, /different control/);
  assert.match(STEP.checkAction({ do: "drag", ref: 2, to_ref: 99 }, { page: p }).action.gone, /no control \[99\]/);
});

test("click_at takes a point in page pixels", () => {
  assert.deepEqual(STEP.checkAction({ do: "click_at", x: "120", y: 80.4, ref: 5 }, { page: page() }).action, { do: "click_at", x: 120, y: 80 });
  assert.match(STEP.checkAction({ do: "click_at", x: 12 }, { page: page() }).error, /needs x and y/);
  assert.match(STEP.checkAction({ do: "click_at", x: -1, y: 4 }, { page: page() }).error, /needs x and y/);
});

test("a drag or a press at a point is never run after another action in the same step, and nothing runs after it", () => {
  const after = STEP.checkStep({ do: "click", ref: 3, then: [{ do: "drag", ref: 2, to_ref: 3 }] }, { page: page() });
  assert.equal(after.ok, true);
  assert.deepEqual(after.step.actions.map((a) => a.do), ["click"]);
  assert.match(after.dropped, /drag cannot follow other actions/);
  const first = STEP.checkStep({ do: "click_at", x: 5, y: 5, then: [{ do: "click", ref: 3 }] }, { page: page() });
  assert.deepEqual(first.step.actions.map((a) => a.do), ["click_at"]);
  assert.match(first.dropped, /after click_at were not run/);
});

test("click_at is offered only with something to aim with; drag is offered, and neither in then", () => {
  const without = STEP.stepTool({});
  assert.ok(without.parameters.properties.do.enum.includes("drag"));
  assert.ok(!without.parameters.properties.do.enum.includes("click_at"));
  assert.equal(without.parameters.properties.x, undefined);
  const aimed = STEP.stepTool({ canAim: true });
  assert.ok(aimed.parameters.properties.do.enum.includes("click_at"));
  assert.equal(aimed.parameters.properties.x.type, "integer");
  const then = aimed.parameters.properties.then.items;
  assert.ok(!then.properties.do.enum.includes("drag") && !then.properties.do.enum.includes("click_at"));
  assert.equal(then.properties.to_ref, undefined);
  assert.ok(STEP.stepTool({ finalStep: true }).parameters.properties.do.enum.every((n) => ["done", "ask_user"].includes(n)));
});

test("drag and click_at read plainly in the history, and differ by where they go", () => {
  assert.equal(STEP.describe({ do: "drag", ref: 2, to_ref: 3 }), "drag [2] onto [3]");
  assert.equal(STEP.describe({ do: "drag", ref: 1, direction: "right", distance: 120 }), "drag [1] right 120px");
  assert.equal(STEP.describe({ do: "click_at", x: 5, y: 9 }), "click_at 5,9");
  assert.notEqual(STEP.signature({ do: "click_at", x: 5, y: 9 }), STEP.signature({ do: "click_at", x: 6, y: 9 }));
});

test("the step tool offers click_at when the listing gives a position, or a picture goes with the step", () => {
  const run = RUN.newRun({ id: "r", task: "t", tabId: 1, startUrl: "https://a.example/", marker: "PAGE-1", now: 1 });
  const plain = page();
  assert.ok(!RUN.toolFor(run, {}, { settings: {} }, plain).parameters.properties.do.enum.includes("click_at"));
  const placed = page({ elements: [...plain.elements, { id: 9, tagName: "canvas", at: { x: 160, y: 1180 }, rect: { x: 10, y: 1100, w: 300, h: 150 } }] });
  assert.ok(RUN.toolFor(run, {}, { settings: {} }, placed).parameters.properties.do.enum.includes("click_at"));
  run.image = "data:image/jpeg;base64,x";
  assert.ok(RUN.toolFor(run, {}, { settings: {} }, plain).parameters.properties.do.enum.includes("click_at"));
});

// ------------------------------------------------------------------- policy

const risky = (extra) => ({
  url: "https://bank.example/account", scrollX: 0, scrollY: 400, innerText: "Your account",
  elements: [
    { id: 1, tagName: "span", text: "report.pdf", rect: { x: 100, y: 0, w: 80, h: 30 } },
    { id: 2, tagName: "div", accName: "Delete forever", rect: { x: 100, y: 60, w: 200, h: 60 } },
    { id: 3, tagName: "button", accName: "Pay now", rect: { x: 400, y: 0, w: 120, h: 40 } },
    { id: 4, tagName: "canvas", at: { x: 160, y: 700 }, rect: { x: 10, y: 225, w: 300, h: 150 } },
  ],
  forms: [],
  ...extra,
});
const runFor = (task) => ({ task, trust: { sites: [], urls: [] }, openedTabs: [], opinions: {} });
const settings = { riskConfirmation: true, allowlist: "" };

test("a point is resolved to the smallest listed control drawn there, in page pixels", () => {
  const p = risky();
  // [3] is drawn at 400..520 by 0..40 in the window, the window 400 px down the page.
  assert.equal(POLICY.pointTarget(p, 460, 420).el.id, 3);
  assert.equal(POLICY.pointTarget(p, 460, 20).el, null, "the same spot in the window is not the same spot on the page");
  const nested = risky({ elements: [{ id: 7, tagName: "div", accName: "Card", rect: { x: 0, y: 0, w: 500, h: 300 } }, { id: 8, tagName: "button", accName: "Buy", rect: { x: 10, y: 10, w: 50, h: 20 } }] });
  assert.equal(POLICY.pointTarget(nested, 20, 415).el.id, 8);
});

test("a press at a point on a pay button is held as a payment", () => {
  const v = POLICY.decide({ do: "click_at", x: 460, y: 420 }, risky(), runFor("look at my account"), settings);
  assert.equal(v.verdict, "confirm");
  assert.equal(v.kind, "pay");
});

test("a press at a point on a drawing is allowed", () => {
  const v = POLICY.decide({ do: "click_at", x: 160, y: 700 }, risky(), runFor("press the drawing"), settings);
  assert.equal(v.verdict, "allow");
});

test("a drop onto a delete box is held as a delete, whether by its number or by where a drag lets go", () => {
  assert.equal(POLICY.decide({ do: "drag", ref: 1, to_ref: 2 }, risky(), runFor("tidy up"), settings).kind, "delete");
  // From the middle of [1] (140, 415 on the page), 75 px down is inside [2].
  const by = POLICY.decide({ do: "drag", ref: 1, direction: "down", distance: 75 }, risky(), runFor("tidy up"), settings);
  assert.equal(by.verdict, "confirm");
  assert.equal(by.kind, "delete");
  assert.deepEqual(POLICY.dropPoint({ do: "drag", ref: 1, direction: "down", distance: 75 }, risky()), { x: 140, y: 490 });
});

test("a knob that pays when slid across is held: the control pressed is checked as well as where it is let go", () => {
  const p = risky({ elements: [{ id: 5, tagName: "div", role: "slider", accName: "Slide to pay", rect: { x: 0, y: 0, w: 40, h: 40 } }] });
  assert.equal(POLICY.decide({ do: "drag", ref: 5, direction: "right", distance: 200 }, p, runFor("look"), settings).kind, "pay");
});

test("a press at a point on a frame the agent cannot read is the user's to allow; on a human check it is handed over", () => {
  const p = risky({ frameAreas: [{ x: 600, y: 600, w: 300, h: 200 }, { x: 0, y: 1000, w: 300, h: 80, check: true }, { x: 600, y: 900, w: 300, h: 200, read: true }] });
  const blind = POLICY.decide({ do: "click_at", x: 700, y: 700 }, p, runFor("look"), settings);
  assert.equal(blind.verdict, "confirm");
  assert.equal(blind.kind, "frame");
  assert.equal(POLICY.decide({ do: "click_at", x: 10, y: 1010 }, p, runFor("look"), settings).verdict, "handoff");
  assert.equal(POLICY.decide({ do: "click_at", x: 700, y: 1000 }, p, runFor("look"), settings).verdict, "allow", "a frame that was read is checked by its controls");
});

test("a drag between harmless controls goes ahead", () => {
  const p = page();
  assert.equal(POLICY.decide({ do: "drag", ref: 2, to_ref: 3 }, p, runFor("put apples in the basket"), settings).verdict, "allow");
});

// -------------------------------------------------------------------- trace

test("the trace says whether each pointer action was real or made by script", () => {
  const p = page();
  const env = { now: 1, page: p, settings, extras: {} };
  const run = RUN.newRun({ id: "r", task: "move apples", tabId: 1, startUrl: p.url, marker: "PAGE-1", now: 1 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page: p }, env);
  const fx = RUN.advance(run, { type: "model_replied", reply: { note: "", goal: "move", do: "drag", ref: 2, to_ref: 3 }, usage: {} }, env);
  assert.equal(fx.find((f) => f.type === "act").action.do, "drag");
  RUN.advance(run, { type: "acted", result: { ok: true, pageChanged: true, pointer: "real", message: "Dragged [2] onto [3]." } }, env);
  const t = RUN.trace(run);
  assert.equal(t.history[0].pointer, "real");
  assert.equal(t.history[0].action, "drag [2] \"Apples\" onto [3]");
});
