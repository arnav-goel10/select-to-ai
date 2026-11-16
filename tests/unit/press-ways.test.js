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

/** otherPressWays from the content script, with each way's result given by the test. */
function ladder(results) {
  const pressed = [];
  const { otherPressWays } = build(["unanswered", "otherPressWays"], { cancelRequested: false });
  const run = (first) => otherPressWays(first, async (way) => { pressed.push(way); return results[way] || quiet(); });
  return { pressed, run };
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

test("the ways are tried in order: pointer, Enter, Space, then the control's own click", async () => {
  const l = ladder({ direct: quiet({ changed: true }) });
  const got = await l.run(quiet());
  assert.deepEqual(l.pressed, ["Enter", "Space", "direct"]);
  assert.deepEqual([got.by, got.seen], ["direct", true]);
});

test("a control that answers no way is said to have answered none", async () => {
  const l = ladder({});
  const got = await l.run(quiet());
  assert.deepEqual(got.tried, ["pointer", "Enter", "Space", "direct"]);
  assert.deepEqual([got.by, got.seen], [null, false]);
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

test("the page presses another way only for a scripted click the user did not approve as one press", () => {
  assert.match(CONTENT, /const again = !!SETTLE_TOOLS && !request\.data\.once && \(kind === 'click' \|\| kind === 'hover'\);/);
  assert.match(CONTENT, /const scripted = again && result\.pointer === 'synthetic' && !result\.opensTab && acted && acted\.isConnected;/);
  assert.match(ENGINE, /case "click": return interact\(session, a, \{ action: "click", id: a\.ref, \.\.\.\(a\.approved !== undefined \? \{ once: true \} : \{\}\) \}, true\);/);
});

// ------------------------------------------------------ what the model is told

test("the result names the way that worked", () => {
  assert.equal(CONTEXT.waysNote({ tried: ["pointer", "Enter"], by: "Enter", seen: true }, 5), "The page did not answer pointer events on it; the Enter key with the focus on it worked.");
  assert.equal(CONTEXT.waysNote({ tried: ["pointer", "Enter", "Space", "direct"], by: "direct", seen: true }, 5), "The page did not answer pointer events on it; its own click called directly worked.");
});

test("a control that answered no way is said to ignore scripted input, with the user's press as the way on", () => {
  const said = CONTEXT.waysNote({ tried: ["pointer", "Enter", "Space", "direct"], by: null, seen: false }, 12);
  assert.match(said, /^It did not answer a press made by script in any of the ways tried: pointer events, the Enter key with the focus on it, the Space key with the focus on it, its own click called directly\./);
  assert.match(said, /it ignores scripted input and takes only a real press/);
  assert.match(said, /The user can press it once for you: ask_user with kind "press" and ref 12\.$/);
});

test("a way the page took without a change is said as that, not as working", () => {
  assert.equal(CONTEXT.waysNote({ tried: ["pointer", "Enter", "Space"], by: "Space", seen: false }, 3), "The page did not answer pointer events on it. It took the Space key with the focus on it, though no change was seen.");
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
  assert.match(ENGINE, /session\.extras\.scripted = !chrome\.debugger \|\| debuggerDisabled;/);
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
