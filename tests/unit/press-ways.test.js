"use strict";
// A press made by script that the page does not answer: it is made the
// next way before the result is given, never twice when anything says the
// page took it, and the result says which way worked or that none did. The
// model is told once that its input is scripted, and can hand one control
// to the user to press.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CONTEXT = require("../../extension/core/context.js");
const STEP = require("../../extension/core/step.js");
const RUN = require("../../extension/core/run.js");
const VIEW = require("../../extension/core/view.js");
const { CONTENT, build } = require("../helpers/content-source.js");

const ENGINE = fs.readFileSync(path.join(__dirname, "../../extension/engine.js"), "utf8");

// What was measured after a press: nothing changed, the requests were in view, none was made.
const quiet = (o) => ({ changed: false, cancelled: false, taken: [], network: true, asked: false, loading: false, ...o });

/**
 * otherPressWays from the content script, with each way's result given by
 * the test. `results.wait` is what the longer watch before each key finds,
 * in order (nothing, when not given). `pressed` is the keys sent; `waits`
 * counts the longer watches.
 */
function ladder(results) {
  const pressed = [];
  const waits = [];
  const late = [...(results.wait || [])];
  const { otherPressWays } = build(["unanswered", "otherPressWays"], { cancelRequested: false });
  const run = (first) => otherPressWays(first, async (way) => {
    if (way === "wait") { waits.push(pressed.length); return late.length ? late.shift() : quiet(); }
    pressed.push(way);
    return way in results ? results[way] : quiet();
  });
  return { pressed, waits, run };
}

test("a press the page answered is not made again", async () => {
  for (const first of [quiet({ changed: true }), quiet({ cancelled: true }), quiet({ taken: ["navigation"] }), quiet({ taken: ["form"] }), quiet({ asked: true }), quiet({ loading: true })]) {
    const l = ladder({});
    assert.equal(await l.run(first), null, JSON.stringify(first));
    assert.deepEqual(l.pressed, [], `pressed again after ${JSON.stringify(first)}`);
  }
});

test("a page whose requests cannot be seen is never pressed a second way", async () => {
  // It may be waiting for an answer to the first press: a second press could send it twice.
  const l = ladder({});
  assert.equal(await l.run(quiet({ network: false })), null);
  assert.deepEqual(l.pressed, []);
});

test("an unanswered press is made with the keyboard, and the way that worked is named", async () => {
  const l = ladder({ Enter: quiet({ changed: true }) });
  const got = await l.run(quiet());
  assert.deepEqual(l.pressed, ["Enter"]);
  assert.deepEqual([got.tried, got.by, got.seen], [["pointer", "Enter"], "Enter", true]);
});

test("the ways are tried in order: pointer, Enter, then Space", async () => {
  const l = ladder({ Space: quiet({ changed: true }) });
  const got = await l.run(quiet());
  assert.deepEqual(l.pressed, ["Enter", "Space"]);
  assert.deepEqual([got.by, got.seen], ["Space", true]);
});

test("a control that answers no way is said to have answered none", async () => {
  const l = ladder({});
  const got = await l.run(quiet());
  assert.deepEqual(got.tried, ["pointer", "Enter", "Space"]);
  assert.deepEqual([got.by, got.seen], [null, false]);
});

test("the control's own click is never called on top of the pointer's click", async () => {
  // It runs the listeners the first click already ran: a control that took the first would act twice.
  const l = ladder({});
  await l.run(quiet());
  assert.ok(!l.pressed.includes("direct"));
  const { source } = require("../helpers/content-source.js");
  assert.ok(!/\.click\(\)/.test(source("pressBy")), "pressBy calls no click()");
  assert.ok(!/\.click\(\)/.test(source("otherPressWays")));
});

test("what a press did out of sight is an answer: it is not made another way", async () => {
  for (const unseen of ["value", "scroll", "request", "focus", "canvas"]) {
    const l = ladder({});
    assert.equal(await l.run(quiet({ unseen: [unseen] })), null, unseen);
    assert.deepEqual(l.pressed, [], unseen);
  }
  // The same after a key: Space is not sent on top of an Enter that changed a field's value.
  const l = ladder({ Enter: quiet({ unseen: ["value"] }) });
  const got = await l.run(quiet());
  assert.deepEqual(l.pressed, ["Enter"]);
  assert.deepEqual([got.by, got.seen], ["Enter", false]);
});

test("the page is watched a while longer before each key, and a late answer to the press before means no key", async () => {
  // Nothing late: one longer watch before Enter and one before Space.
  const dead = ladder({});
  await dead.run(quiet());
  assert.deepEqual([dead.pressed, dead.waits], [["Enter", "Space"], [0, 1]]);
  // The click's effect came after a timer of the page's own: no key is sent, and the change is the click's.
  for (const answer of [quiet({ changed: true }), quiet({ unseen: ["request"] }), quiet({ unseen: ["value"] }), quiet({ taken: ["navigation"] }), quiet({ asked: true }), quiet({ loading: true })]) {
    const l = ladder({ wait: [answer] });
    const got = await l.run(quiet());
    assert.deepEqual(l.pressed, [], `a key was sent after ${JSON.stringify(answer)}`);
    assert.deepEqual([got.tried, got.by, got.seen, got.last], [["pointer"], "pointer", !!answer.changed, answer]);
  }
  // Enter's effect came late: Space is not sent on top, and Enter is named.
  const enter = ladder({ wait: [quiet(), quiet({ changed: true })] });
  const got = await enter.run(quiet());
  assert.deepEqual(enter.pressed, ["Enter"]);
  assert.deepEqual([got.tried, got.by, got.seen], [["pointer", "Enter"], "Enter", true]);
  // An answered first press is not watched longer at all.
  const answered = ladder({});
  await answered.run(quiet({ changed: true }));
  assert.deepEqual(answered.waits, []);
});

test("the ways as the page's handler runs them: a control that cannot take the focus is pressed once and nothing throws", async () => {
  // pressBy gives null for every way on it. The handler's own wrapper is the one run here.
  const asked = [];
  const { pressWays } = build(["unanswered", "otherPressWays", "pressWays"], { cancelRequested: false, pressBy: async (el, way) => { asked.push(way); return null; } });
  assert.deepEqual(await pressWays({}, quiet(), null, null), { ways: null, waited: 0 });
  assert.deepEqual(asked, ["wait", "Enter", "wait", "Space"]);
  assert.match(CONTENT, /const \{ ways, waited \} = await pressWays\(acted, first, busyBefore, compute\);/);
  // The time each way was watched for is added up, the longer watches too.
  const timed = build(["unanswered", "otherPressWays", "pressWays"], { cancelRequested: false, pressBy: async (el, way) => ({ ...quiet(), ms: way === "wait" ? 2100 : 500 }) });
  const got = await timed.pressWays({}, quiet(), null, null);
  assert.deepEqual([got.ways.tried, got.ways.by, got.waited], [["pointer", "Enter", "Space"], null, 5200]);
});

test("no longer watch is spent on a control the keyboard cannot reach, and none presses anything", async () => {
  const { takesFocus, pressBy } = build(["takesFocus", "pressBy"], {});
  const el = (o) => ({ tabIndex: -1, hasAttribute: () => false, ...o });
  assert.equal(takesFocus(el({})), false);
  assert.equal(takesFocus(el({ tabIndex: 0 })), true);
  assert.equal(takesFocus(el({ hasAttribute: (k) => k === "tabindex" })), true);
  assert.equal(takesFocus(null), false);
  // Null before anything on the page is touched: every other name pressBy reaches for is missing here.
  assert.equal(await pressBy(el({}), "wait", null, null), null);
  const { source } = require("../helpers/content-source.js");
  assert.ok(!/scriptKey|focusField|dispatchEvent|\.click\(/.test(source("laterSign")), "the longer watch only waits");
  assert.match(source("pressBy"), /\} else if \(way !== 'wait'\) \{\s*cancelled = !scriptKey/);
});

test("the longer watch ends at once when the page changes or asks for something, and by its limit otherwise", async () => {
  const TOOLS = require("../../extension/agentTools.js");
  assert.ok(TOOLS.SETTLE.SECOND_PRESS_MS >= 1500 && TOOLS.SETTLE.SECOND_PRESS_MS <= 4000, "long enough for a debounce, short enough to wait through twice");
  const { source } = require("../helpers/content-source.js");
  const make = (vars) => {
    let now = 1000;
    const clock = { now: () => now };
    const sleeps = [];
    const setTimeout = (fn, ms) => { sleeps.push(ms); now += ms; if (vars.at && now >= vars.at.when) vars.at.then(set); fn(); };
    let set;
    const made = new Function("Date", "setTimeout", "SETTLE_TOOLS", "cancelRequested", `let lastChangeAt = 0, pageNetLastStart = 0;\n${source("laterSign")}\nreturn { laterSign, set: (o) => { if (o.change !== undefined) lastChangeAt = o.change; if (o.net !== undefined) pageNetLastStart = o.net; } };`)(clock, setTimeout, { SETTLE: TOOLS.SETTLE }, false);
    set = made.set;
    return { ...made, sleeps, clock };
  };
  const quietPage = make({});
  await quietPage.laterSign(1000);
  assert.equal(quietPage.clock.now() - 1000, TOOLS.SETTLE.SECOND_PRESS_MS);
  const changed = make({ at: { when: 1500, then: (set) => set({ change: 1500 }) } });
  await changed.laterSign(1000);
  assert.equal(changed.clock.now(), 1500);
  const asked = make({ at: { when: 1300, then: (set) => set({ net: 1300 }) } });
  await asked.laterSign(1000);
  assert.equal(asked.clock.now(), 1300);
});

test("a key the control cannot be given, for not holding the focus, is not counted as tried", async () => {
  const l = ladder({ Enter: null, Space: null });
  assert.equal(await l.run(quiet()), null);
  assert.deepEqual(l.pressed, ["Enter", "Space"]);
  assert.match(CONTENT, /if \(way === 'Enter' \|\| way === 'Space'\) \{\s*focusField\(el\);\s*if \(focusNow\(\) !== el\) return null;\s*\}/);
});

test("a way the page took without showing a change ends the tries there", async () => {
  // The page cancelled Space: it handled the key, and its own click is not then called on top.
  const l = ladder({ Space: quiet({ cancelled: true }) });
  const got = await l.run(quiet());
  assert.deepEqual(l.pressed, ["Enter", "Space"]);
  assert.deepEqual([got.by, got.seen], ["Space", false]);
  // A request went out after Enter: the same.
  const sent = ladder({ Enter: quiet({ asked: true }) });
  assert.deepEqual([(await sent.run(quiet())).by, sent.pressed], ["Enter", ["Enter"]]);
});

test("only a control a press does something to is pressed another way", () => {
  const el = (o) => ({ isConnected: true, disabled: false, isContentEditable: false, tagName: "BUTTON", type: "", getAttribute: () => null, ...o });
  const { takesPress } = build(["takesPress"], {});
  assert.equal(takesPress(el({})), true);
  assert.equal(takesPress(el({ tagName: "A" })), true);
  assert.equal(takesPress(el({ tagName: "INPUT", type: "checkbox" })), true);
  assert.equal(takesPress(el({ tagName: "INPUT", type: "file" })), true);
  // A text box only takes the cursor; a drawing takes a press at a point.
  assert.equal(takesPress(el({ tagName: "INPUT", type: "text" })), false);
  assert.equal(takesPress(el({ tagName: "TEXTAREA" })), false);
  assert.equal(takesPress(el({ isContentEditable: true, tagName: "DIV" })), false);
  assert.equal(takesPress(el({ tagName: "CANVAS" })), false);
  assert.equal(takesPress(el({ tagName: "VIDEO" })), false);
  assert.equal(takesPress(el({ disabled: true })), false);
  assert.equal(takesPress(el({ getAttribute: (k) => (k === "aria-disabled" ? "true" : null) })), false);
  assert.equal(takesPress(el({ isConnected: false })), false);
  // The one already chosen rightly does nothing when pressed.
  assert.equal(takesPress(el({ getAttribute: (k) => (k === "aria-selected" ? "true" : null) })), false);
  assert.equal(takesPress(el({ tagName: "A", getAttribute: (k) => (k === "aria-current" ? "page" : null) })), false);
  assert.equal(takesPress(el({ getAttribute: (k) => (k === "aria-selected" || k === "aria-current" ? "false" : null) })), true);
  // A toggle that is on is still one to press.
  assert.equal(takesPress(el({ getAttribute: (k) => (k === "aria-pressed" ? "true" : null) })), true);
  assert.equal(takesPress(null), false);
});

test("a key made by script goes down, is pressed and comes up, and says when the page cancelled it", () => {
  class KeyboardEvent { constructor(type, init) { this.type = type; this.init = init; } }
  const { scriptKey } = build(["scriptKey"], { KeyboardEvent, window: {}, resolveKeyMeta: (k) => (k === "Enter" ? { keyCode: 13, code: "Enter" } : { keyCode: 32, code: "Space" }) });
  const sent = [];
  const el = (cancel) => ({ dispatchEvent(e) { sent.push(e); return e.type !== cancel; } });
  assert.equal(scriptKey(el(""), "Enter"), true);
  assert.deepEqual(sent.map((e) => e.type), ["keydown", "keypress", "keyup"]);
  assert.deepEqual([sent[0].init.key, sent[0].init.keyCode, sent[0].init.composed, sent[0].init.bubbles], ["Enter", 13, true, true]);
  assert.equal(scriptKey(el("keydown"), " "), false);
});

/** watchTaken on a stand-in window that keeps its listeners. */
function taking(o = {}) {
  const on = { window: {}, document: {}, navigation: {} };
  const target = (name) => ({
    addEventListener: (type, fn) => { on[name][type] = fn; },
    removeEventListener: (type, fn) => { if (on[name][type] === fn) delete on[name][type]; },
  });
  const media = o.media || [];
  const window = { ...target("window"), ...(o.noNavigation ? {} : { navigation: target("navigation") }) };
  const document = { ...target("document"), fullscreenElement: null, querySelectorAll: () => media };
  const { watchTaken } = build(["watchTaken"], { window, document });
  return { watch: watchTaken(), on, window, document, media };
}

test("a press that sends the page elsewhere, or sends a form, is seen though the page shows no change", () => {
  const nav = taking();
  nav.on.navigation.navigate({ type: "navigate" });
  assert.deepEqual(nav.watch.stop(), ["navigation"]);
  const form = taking();
  form.on.window.submit({ type: "submit" });
  assert.deepEqual(form.watch.stop(), ["form"]);
  // A browser without the navigation object still says when the page is about to go.
  const old = taking({ noNavigation: true });
  old.on.window.beforeunload({ type: "beforeunload" });
  assert.deepEqual(old.watch.stop(), ["navigation"]);
});

test("another window taking over, or something starting to play, is seen", () => {
  // A field losing the focus is not the window losing it.
  const field = taking();
  field.on.window.blur({ type: "blur", target: {} });
  assert.deepEqual(field.watch.stop(), []);
  const away = taking();
  away.on.window.blur({ type: "blur", target: away.window });
  assert.deepEqual(away.watch.stop(), ["window"]);
  const video = { paused: true, muted: false };
  const play = taking({ media: [video] });
  video.paused = false;
  assert.deepEqual(play.watch.stop(), ["media"]);
});

test("the watch takes its listeners off when it stops", () => {
  const t = taking();
  assert.ok(t.on.window.submit && t.on.window.beforeunload && t.on.navigation.navigate);
  t.watch.stop();
  assert.deepEqual([Object.keys(t.on.window), Object.keys(t.on.document), Object.keys(t.on.navigation)], [[], [], []]);
  assert.deepEqual(t.watch.stop(), [], "stopping twice is the same as once");
});

// ------------------------------------------- what a press does out of sight

/** A stand-in page for watchUnseen: fields, shadow roots, canvases, and the listeners it is given. */
function unseeing(o = {}) {
  const listeners = new Map();
  const target = (extra) => {
    const t = { ...extra, addEventListener: (type, fn) => listeners.set(t, { type, fn }), removeEventListener: (type, fn) => { if (listeners.get(t) && listeners.get(t).fn === fn) listeners.delete(t); } };
    return t;
  };
  const fields = o.fields || [];
  const inner = o.innerFields || [];
  const root = target({ querySelectorAll: (sel) => (/input/.test(sel) ? inner : []) });
  const host = { shadowRoot: root };
  const document = target({
    activeElement: o.active || null,
    querySelectorAll: (sel) => (sel === "*" ? (o.noRoot ? [] : [host]) : sel === "canvas" ? (o.canvases || []) : fields),
  });
  const observers = [];
  class PerformanceObserver {
    constructor(fn) { this.fn = fn; this.left = []; observers.push(this); }
    observe(what) { this.what = what; }
    takeRecords() { return this.left; }
    disconnect() { this.off = true; }
  }
  const record = [];
  const performance = { getEntriesByType: (type) => (type === "resource" ? [...record] : []) };
  const scope = { document, agentDrawn: () => false, shownNow: (c) => c.shown !== false, pageNetLastStart: 0, Date: { now: () => 5000 }, performance: o.noRecord ? undefined : performance, ...(o.noObserver ? { PerformanceObserver: undefined } : { PerformanceObserver }) };
  const names = ["openRoots", "fieldsNow", "focusNow", "watchUnseen"];
  const keys = Object.keys(scope);
  const { source } = require("../helpers/content-source.js");
  // pageNetLastStart is a variable of the content script: the test sets it through `net`.
  const made = new Function(...keys, `${names.map(source).join("\n")}\nreturn { ${names.join(", ")}, net: (t) => { pageNetLastStart = t; } };`)(...keys.map((k) => scope[k]));
  return { ...made, document, root, listeners, observers, fields, inner, record };
}

test("a field given a new value by the page's code is seen, in a component's own root too", () => {
  const qty = { type: "number", value: "1", checked: false };
  const a = unseeing({ fields: [qty] });
  const w = a.watchUnseen();
  qty.value = "2";
  assert.deepEqual(w.stop(), ["value"]);
  const box = { type: "checkbox", value: "on", checked: false };
  const b = unseeing({ innerFields: [box] });
  const w2 = b.watchUnseen();
  box.checked = true;
  assert.deepEqual(w2.stop(), ["value"]);
  // Nothing changed: nothing seen, and stopping twice is the same as once.
  const c = unseeing({ fields: [{ type: "text", value: "x", checked: false }] });
  const w3 = c.watchUnseen();
  assert.deepEqual(w3.stop(), []);
  assert.deepEqual(w3.stop(), []);
});

test("what a password box holds is compared by its length only", () => {
  const a = unseeing({ fields: [{ type: "password", value: "hunter2", checked: false }] });
  assert.ok(!a.fieldsNow().includes("hunter2"));
  assert.ok(a.fieldsNow().startsWith("7"));
});

test("a box scrolled inside the page is seen, inside a component too, and the listeners come off", () => {
  const a = unseeing();
  const w = a.watchUnseen();
  assert.equal(a.listeners.size, 2, "the document and the component's root are listened to");
  assert.equal(a.listeners.get(a.root).type, "scroll");
  a.listeners.get(a.root).fn({ target: {} });
  assert.deepEqual(w.stop(), ["scroll"]);
  assert.equal(a.listeners.size, 0);
});

test("anything the page fetched is seen: by the page's own count, its background too, or by the browser's record", () => {
  const counted = unseeing();
  const w = counted.watchUnseen();
  counted.net(5000);
  assert.deepEqual(w.stop(), ["request"]);
  // One begun before the press is not this press's.
  const earlier = unseeing();
  earlier.net(4000);
  assert.deepEqual(earlier.watchUnseen().stop(), []);
  // A request made through a function the page kept from before the count began is still in the browser's record.
  const kept = unseeing();
  const w2 = kept.watchUnseen();
  assert.deepEqual(kept.observers[0].what, { type: "resource" });
  kept.observers[0].fn({ getEntries: () => [{ name: "https://shop.example/api/cart" }] });
  assert.deepEqual(w2.stop(), ["request"]);
  assert.equal(kept.observers[0].off, true);
  // What the extension itself loads into the page is not the page fetching.
  const own = unseeing();
  const w4 = own.watchUnseen();
  own.observers[0].fn({ getEntries: () => [{ name: "chrome-extension://abcdef/icons/icon-48.png" }] });
  assert.deepEqual(w4.stop(), []);
  // One that ended just before the watch stopped.
  const late = unseeing();
  const w3 = late.watchUnseen();
  late.observers[0].left = [{}];
  assert.deepEqual(w3.stop(), ["request"]);
  // The record grew, though nothing was told as it did: read by its length at the end.
  const grown = unseeing({ noObserver: true });
  grown.record.push({ name: "https://shop.example/old" });
  const w5 = grown.watchUnseen();
  grown.record.push({ name: "https://shop.example/api/feed" });
  assert.deepEqual(w5.stop(), ["request"]);
  // What was in it before the press is not this press's, and the extension's own loads are not the page's.
  const before = unseeing({ noObserver: true });
  before.record.push({ name: "https://shop.example/old" });
  const w6 = before.watchUnseen();
  before.record.push({ name: "chrome-extension://abcdef/icons/icon-48.png" });
  assert.deepEqual(w6.stop(), []);
  // A browser without that record: the rest still works.
  assert.deepEqual(unseeing({ noObserver: true, noRecord: true }).watchUnseen().stop(), []);
});

test("the focus going elsewhere is seen", () => {
  const button = {};
  const a = unseeing({ active: button });
  const w = a.watchUnseen();
  a.document.activeElement = {};
  assert.deepEqual(w.stop(), ["focus"]);
});

test("a drawing on the page cannot be judged: what a press redraws in it is not seen", () => {
  const big = { getBoundingClientRect: () => ({ width: 600, height: 400 }) };
  assert.deepEqual(unseeing({ canvases: [big] }).watchUnseen().stop(), ["canvas"]);
  const icon = { getBoundingClientRect: () => ({ width: 16, height: 16 }) };
  assert.deepEqual(unseeing({ canvases: [icon] }).watchUnseen().stop(), []);
  assert.deepEqual(unseeing({ canvases: [{ ...big, shown: false }] }).watchUnseen().stop(), []);
});

test("changes inside a component's own root are counted with the page's", () => {
  const observed = [];
  class MutationObserver { constructor(fn) { this.fn = fn; } observe(node) { observed.push(node); } disconnect() {} }
  const root = { querySelectorAll: () => [] };
  const body = {};
  const document = { body, querySelectorAll: (sel) => (sel === "*" ? [{ shadowRoot: root }] : []) };
  const { createMutationCounter } = build(["openRoots", "createMutationCounter"], { document, MutationObserver, agentDrawn: () => false });
  createMutationCounter().stop();
  assert.deepEqual(observed, [body, root]);
});

test("the page presses another way only for a scripted click the user did not approve as one press", () => {
  assert.match(CONTENT, /const again = !!SETTLE_TOOLS && !request\.data\.once && \(kind === 'click' \|\| kind === 'hover'\);/);
  assert.match(CONTENT, /const scripted = again && result\.pointer === 'synthetic' && !result\.opensTab && acted && acted\.isConnected;/);
  assert.match(ENGINE, /case "click": return interact\(session, a, \{ action: "click", id: a\.ref, \.\.\.spotOf\(a\), \.\.\.\(a\.approved !== undefined \? \{ once: true \} : keys \? \{ keys: true \} : \{\}\) \}, true\);/);
});

test("a key follows a click only where the engine found the key allowed on that control", () => {
  // The engine passes on what the policy decided with the click, and the page sends no key without it.
  assert.match(ENGINE, /act\(session, fx\.action, fx\.keys === true\)/);
  assert.ok(!/act\(session, fx\.action\)/.test(ENGINE), "no act without the decision on the keys");
  assert.match(CONTENT, /if \(scripted && kind === 'click' && request\.data\.keys === true && takesPress\(acted\)\) \{/);
  assert.equal(CONTENT.split("pressWays(acted").length - 1, 1, "the keys are sent from one place");
});

// ------------------------------------------------------ what the model is told

test("the result names the way that worked", () => {
  assert.equal(CONTEXT.waysNote({ tried: ["pointer", "Enter"], by: "Enter", seen: true }, 5), "No change was seen after pointer events on it. It was then pressed with the Enter key with the focus on it, and the page changed: check that the change is the one you wanted.");
});

test("a control with no change seen after any way is said as that, not as ignoring scripted input, with the user's press as a way on", () => {
  const said = CONTEXT.waysNote({ tried: ["pointer", "Enter", "Space"], by: null, seen: false }, 12);
  assert.match(said, /^No change was seen after a press made by script in any of the ways tried: pointer events, the Enter key with the focus on it, the Space key with the focus on it\./);
  // What was seen is all that is claimed: the three things it can mean are left to the model.
  assert.match(said, /It may have nothing to do here, it may have done something that cannot be seen from here, or it may take only a real press\./);
  assert.ok(!/ignores scripted input/.test(said));
  assert.match(said, /Do not press it again by script\./);
  assert.match(said, /the user can press it once for you: ask_user with kind "press" and ref 12\.$/);
});

test("a field's new value after a press is said, where nothing else on the page changed", () => {
  assert.equal(CONTEXT.waysNote(undefined, 5, ["value"]), "A field on the page holds a different value after it.");
  assert.match(ENGINE, /const valued = !moved && Array\.isArray\(res\.taken\) && res\.taken\.includes\("value"\);/);
  assert.match(ENGINE, /noEffect: !!o\.noEffect && !moved && !valued,/);
});

test("a way the page took without a change is said as that, not as working", () => {
  assert.equal(CONTEXT.waysNote({ tried: ["pointer", "Enter", "Space"], by: "Space", seen: false }, 3), "No change was seen after pointer events on it. It was then pressed with the Space key with the focus on it: the page took that, though it shows no change either.");
});

test("a hover that brought nothing up says what cannot be opened by script", () => {
  assert.match(CONTEXT.waysNote({ tried: ["pointer", "focus"], by: null, seen: false, hover: true }, 3), /^Nothing came up under the pointer made by script, or with the focus on it\. What opens only under the real mouse cannot be opened by script\.$/);
  assert.match(CONTEXT.waysNote({ tried: ["pointer", "focus"], by: "focus", seen: true, hover: true }, 3), /putting the focus on it did\.$/);
});

test("nothing is said of ways when the first press was answered, and what it set off out of sight is", () => {
  assert.equal(CONTEXT.waysNote(undefined, 5), "");
  assert.equal(CONTEXT.waysNote(undefined, 5, ["navigation"]), "The page began to go to another page.");
  assert.equal(CONTEXT.waysNote(null, 5, ["form", "nonsense"]), "The press sent a form.");
});

test("the model is told once, as a fact, that its pointer and keys are scripted, only where they are", () => {
  const scripted = CONTEXT.systemMessage({}, false, true);
  const real = CONTEXT.systemMessage({}, false, false);
  assert.match(scripted, /\n\n# How your actions reach the page\nIn this browser your pointer and your keys are made by script/);
  assert.match(scripted, /ask_user with kind "press" and its ref\.\n\n# What only the user can do/);
  assert.equal(scripted.split("made by script").length - 1, 1, "said once");
  assert.ok(!/made by script/.test(real));
  assert.ok(!/\{\{/.test(scripted) && !/\{\{/.test(real));
  assert.match(real, /you do yourself\.\n\n# What only the user can do/);
  // It reaches the step's messages from what the engine says of the browser.
  const run = RUN.newRun({ id: "r1", task: "press it", tabId: 7, startUrl: "https://a.example/", marker: "PAGE-abcd1234", now: 1 });
  const page = { url: "https://a.example/", title: "A", elements: [], innerText: "A", visibleText: "A" };
  assert.match(CONTEXT.stepMessages(run, page, { scripted: true }).system, /made by script/);
  assert.ok(!/made by script/.test(CONTEXT.stepMessages(run, page, {}).system));
  // Where there is a debugger but a tab refused it, the last pointer action of the run says how it was made.
  assert.match(ENGINE, /session\.extras\.scripted = !chrome\.debugger \|\| debuggerDisabled \|\| !!\(session\.pointerWas && session\.pointerWas\.run === run\.id && session\.pointerWas\.how === "synthetic"\);/);
  assert.match(ENGINE, /if \(pointer\.pointer\) session\.pointerWas = \{ run: run\.id, how: pointer\.pointer \};/);
});

test("the tool does not promise what a scripted pointer cannot do", () => {
  const about = STEP.stepTool({}).parameters.properties.do.description;
  assert.match(about, /hover: [^:]*\. Its result says what that brought up, or that nothing came up\./);
  assert.match(about, /a drag that changed nothing was not followed by the page\./);
  // Tab is a key the browser itself acts on, which a scripted key does not make it do.
  assert.ok(!/press: a key such as[^.]*Tab/.test(about));
  assert.match(about, /With kind "press" and a ref, the user presses that one control themselves/);
});

// ------------------------------------------------------------ the user's press

const page = () => ({
  url: "https://shop.example/cart", title: "Cart", visibleText: "Cart", innerText: "Cart. Apply coupon.",
  elements: [{ id: 4, tagName: "button", accName: "Apply coupon" }],
});
const ctx = (p) => ({ page: p, labels: {}, labelOf: (e) => e.accName });

test("ask_user with kind press keeps the ref of the control to press", () => {
  const got = STEP.checkAction({ do: "ask_user", kind: "press", ref: 4, question: "Please press Apply coupon." }, ctx(page()));
  assert.deepEqual(got.action, { do: "ask_user", ref: 4, question: "Please press Apply coupon.", kind: "press" });
  assert.equal(STEP.describe(got.action), "ask_user [4] (press)");
});

test("ask_user with kind press needs a control that is on the page", () => {
  assert.match(STEP.checkAction({ do: "ask_user", kind: "press", question: "Please press it." }, ctx(page())).error, /ask_user with kind "press" needs ref/);
  assert.match(STEP.checkAction({ do: "ask_user", kind: "press", ref: 99, question: "Please press it." }, ctx(page())).error, /There is no control \[99\] on this page for the user to press/);
});

test("any other ask takes no ref, as before", () => {
  const got = STEP.checkAction({ do: "ask_user", kind: "sign_in", ref: 4, question: "Please sign in." }, ctx(page()));
  assert.equal(got.action.ref, undefined);
  assert.ok(STEP.ASK_KINDS.includes("press"));
});

test("the run waits for the user's press with the control marked on the page", () => {
  const p = page();
  const env = { now: 1000, page: p, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} };
  const run = RUN.newRun({ id: "r1", task: "apply my coupon", tabId: 7, startUrl: p.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page: p }, env);
  const fx = RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "hand the press over", actions: [{ do: "ask_user", kind: "press", ref: 4, question: "Please press Apply coupon." }] }, usage: {} }, env);
  assert.equal(run.status, "waiting");
  assert.deepEqual([run.wait.kind, run.wait.press, run.wait.tabId], ["press", 4, 7]);
  assert.ok(fx.some((f) => f.type === "attention" && f.wait.press === 4));
  // Their press ends the wait and the run carries on.
  RUN.advance(run, { type: "cleared", id: run.wait.id }, env);
  assert.equal(run.status, "running");
  assert.match(run.history[run.history.length - 1].actions[0].result, /The user did it/);
});

test("a press is waited for on the page, with the user left on it", () => {
  assert.ok(VIEW.ON_PAGE_WAITS.has("press"));
  assert.deepEqual(VIEW.onSettle({ home: 1, front: 2, tabs: [2], touched: false, wait: "press" }), { focus: null, bar: "keep" });
  assert.equal(VIEW.barLine({ status: "waiting", wait: { kind: "press" } }).text, "Waiting for you to press a button");
});

/** waitForUser from the content script, with the 700 ms timer turned by hand. */
function pressWait(elementMap, pressId) {
  const sent = [];
  let tick = null;
  const { waitForUser } = build(["waitForUser"], {
    detectBlockers: () => [], chrome: { runtime: { sendMessage: (m) => sent.push(m) } }, setInterval: (fn) => { tick = fn; return 1; },
    location: { href: "https://shop.example/cart" }, elementMap, needsYouTimer: null, removeNeedsYou: () => {}, showNeedsYou: () => {},
  });
  waitForUser("press", "Please press it", pressId);
  return { sent, tick: (n = 1) => { for (let i = 0; i < n; i++) tick(); } };
}

test("the wait for a press ends on the user's own click, not on one made by script", () => {
  let onClick = null;
  const button = { isConnected: true, dataset: {}, style: {}, scrollIntoView() {}, addEventListener: (_t, fn) => { onClick = fn; } };
  const w = pressWait({ 4: button }, 4);
  w.tick(4);
  assert.equal(w.sent.length, 0, "still waiting");
  onClick({ isTrusted: false });
  w.tick(4);
  assert.equal(w.sent.length, 0, "a scripted click is not the user's");
  onClick({ isTrusted: true });
  w.tick(2);
  assert.deepEqual(w.sent.map((m) => m.action), ["agentBlockerCleared"]);
});

test("a control to press that this page cannot watch is waited on until the user says they are done", () => {
  // One inside a frame has no number in the page's own listing: its absence here is not the user's press.
  const w = pressWait({}, 1000004);
  w.tick(10);
  assert.equal(w.sent.length, 0, "not said to be done after 1.4 seconds");
});
