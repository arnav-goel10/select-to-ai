"use strict";
// A browser dialog (alert, confirm, prompt, the check before leaving)
// stops a page until someone closes it, and a page held that way runs no
// script, the extension's included. On 17 Nov 2026 the cart task on a shop
// that says "Product added" in an alert waited on its second step until the
// run's time was out (1021 s). The page's world now answers the page's
// dialogs while the agent works on it, the agent is told what they said,
// and no wait for a page's answer is unbounded.
const test = require("node:test");
const assert = require("node:assert/strict");
const INJECT = require("../../extension/core/inject.js");
const CONTEXT = require("../../extension/core/context.js");
const { build } = require("../helpers/content-source.js");
const { fakeWorker } = require("../helpers/fake-worker.js");

const NAME = "n0123456789abcdef01234567";
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A page's world with its own dialogs; `held` says whether the content script takes them. */
function world(o = {}) {
  const said = [];
  const own = [];
  const state = { held: !!o.held };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; this.cancelable = !!init.cancelable; } }
  const document = {
    dispatchEvent(e) {
      const d = JSON.parse(e.detail);
      said.push(d);
      // The content script cancels a dialog event while the agent has the page.
      return !(d.t === "dialog" && state.held && e.cancelable);
    },
  };
  class Event { preventDefault() { this.prevented = true; } }
  class BeforeUnloadEvent extends Event {}
  Object.defineProperty(BeforeUnloadEvent.prototype, "returnValue", { configurable: true, get() { return this.rv || ""; }, set(v) { this.rv = String(v); } });
  const listeners = [];
  const window = {
    alert(m) { own.push(["alert", m]); },
    confirm(m) { own.push(["confirm", m]); return true; },
    prompt(m) { own.push(["prompt", m]); return "typed"; },
    Event, BeforeUnloadEvent,
    onbeforeunload: o.onbeforeunload || null,
    addEventListener(type, fn) { if (type === "beforeunload") listeners.push(fn); },
  };
  const run = (want) => new Function("window", "document", "CustomEvent", `return (${INJECT.pageShim.toString()})(${JSON.stringify(NAME)}, ${JSON.stringify(want)});`)(window, document, CustomEvent);
  /** The page being left: its listeners run, as the browser runs them. */
  const leave = () => { const e = new BeforeUnloadEvent(); for (const fn of listeners) fn.call(window, e); return e; };
  return { said, own, state, window, run, leave, BeforeUnloadEvent };
}

test("while the agent has the page, an alert is said with its words and closed with OK, without the page's own dialog", () => {
  const w = world({ held: true });
  w.run({ net: false, dialogs: true });
  assert.equal(w.window.alert("Product added."), undefined);
  assert.deepEqual(w.own, [], "the page's own alert never opened");
  assert.deepEqual(w.said.filter((d) => d.t === "dialog"), [{ t: "dialog", kind: "alert", text: "Product added." }]);
});

test("a confirm and a prompt are answered Cancel while the agent has the page", () => {
  const w = world({ held: true });
  w.run({ net: false, dialogs: true });
  assert.equal(w.window.confirm("Delete this item?"), false);
  assert.equal(w.window.prompt("Your name?"), null);
  assert.deepEqual(w.own, []);
  assert.deepEqual(w.said.filter((d) => d.t === "dialog").map((d) => d.kind), ["confirm", "prompt"]);
});

test("when the agent does not have the page, its own dialogs open as before and their answers reach it", () => {
  const w = world({ held: false });
  w.run({ net: false, dialogs: true });
  w.window.alert("hi");
  assert.equal(w.window.confirm("Sure?"), true);
  assert.equal(w.window.prompt("Name?"), "typed");
  assert.deepEqual(w.own.map((x) => x[0]), ["alert", "confirm", "prompt"]);
});

test("the check before leaving is not shown while the agent has the page, and is as before otherwise", () => {
  const held = world({ held: true, onbeforeunload: () => "You have unsaved changes" });
  held.run({ net: false, dialogs: true });
  const byListener = new held.BeforeUnloadEvent();
  byListener.preventDefault();
  byListener.returnValue = "stay";
  assert.ok(!byListener.prevented && !byListener.rv, "a listener's cancel and returnValue are let go");
  const left = held.leave();
  assert.ok(!left.prevented && !left.rv, "the onbeforeunload handler's words are let go");
  assert.ok(held.said.filter((d) => d.t === "dialog").every((d) => d.kind === "beforeunload"));

  const free = world({ held: false, onbeforeunload: () => "You have unsaved changes" });
  free.run({ net: false, dialogs: true });
  const e = new free.BeforeUnloadEvent();
  e.preventDefault();
  assert.ok(e.prevented);
  const out = free.leave();
  assert.ok(out.prevented && out.rv === "You have unsaved changes", "the page's own check still opens for the user");
  assert.equal(typeof free.window.onbeforeunload, "function", "the page still reads back its own handler");
});

test("each part is put in only when asked for, and the hello says which", () => {
  const w = world();
  const fetchBefore = w.window.fetch;
  w.run({ net: false, dialogs: true });
  assert.equal(w.window.fetch, fetchBefore);
  assert.deepEqual(w.said.at(-1), { t: "hello", net: false, dialogs: true });
  const n = world();
  const alertBefore = n.window.alert;
  n.run({ net: true, dialogs: false });
  assert.equal(n.window.alert, alertBefore);
  assert.deepEqual(n.said.at(-1), { t: "hello", net: true, dialogs: false });
});

test("the content script takes a dialog only while the agent works on the page, and tells it once", () => {
  const fns = build(["onPageNet", "takeDialogs", "holdDialogs"], {
    pageNet: null, pageNetOpen: new Set(), pageNetAlive: false, pageNetLastStart: 0,
    pageDialogsAlive: false, pageDialogs: [], dialogsHeldUntil: 0, actingSince: 0,
    location: { href: "https://shop.example/" }, URL,
  });
  const event = (d) => { const e = { detail: JSON.stringify(d), prevented: false, preventDefault() { this.prevented = true; } }; fns.onPageNet(e); return e; };
  // Not held: the user's own dialog is theirs.
  assert.equal(event({ t: "dialog", kind: "alert", text: "x" }).prevented, false);
  assert.deepEqual(fns.takeDialogs(), []);
  fns.holdDialogs(15000);
  assert.equal(event({ t: "dialog", kind: "alert", text: "Product added." }).prevented, true);
  assert.equal(event({ t: "dialog", kind: "script", text: "odd" }).prevented, false, "a kind no dialog has is left alone");
  const told = fns.takeDialogs();
  assert.deepEqual(told.map((d) => [d.kind, d.text]), [["alert", "Product added."]]);
  assert.deepEqual(fns.takeDialogs(), [], "told once");
  // The user's turn (ask_user, or the run ended): the page's dialogs are theirs again.
  fns.holdDialogs(0);
  assert.equal(event({ t: "dialog", kind: "confirm", text: "Sure?" }).prevented, false);
});

test("a message to a page that never answers ends at its bound, marked late", async () => {
  const never = { tabs: { sendMessage: () => new Promise(() => {}) } };
  const t0 = Date.now();
  assert.deepEqual(await INJECT.ask(never, 3, { action: "scan" }, { frameId: 0 }, 30), { reply: null, late: true });
  assert.ok(Date.now() - t0 < 1000);
  const ok = { tabs: { sendMessage: async () => ({ elements: [] }) } };
  assert.deepEqual(await INJECT.ask(ok, 3, {}, {}, 1000), { reply: { elements: [] } });
  const gone = { tabs: { sendMessage: async () => { throw new Error("Receiving end does not exist."); } } };
  assert.deepEqual(await INJECT.ask(gone, 3, {}, {}, 1000), { reply: null });
});

const session = () => ({ windowId: 1, run: { id: "r1", task: "t", tabId: 9 }, settings: {}, items: { agentPressables: "off" }, touched: new Set(), frames: [], runners: new Map() });
const tab = { id: 9, url: "https://shop.example/prod.html?idp_=8", title: "STORE", windowId: 1, active: true };

test("an action whose alert the page's world answered is said with the alert's words", async () => {
  const w = fakeWorker({
    tabs: { 9: tab },
    onTabMessage: (_id, m) => (m.action === "interact" ? { success: true, message: "Clicked [12] \"Add to cart\".", outcome: { domMutationCount: 0, noEffect: true }, settle: { ms: 900, network: true, asked: true }, dialogs: [{ kind: "alert", text: "Product added.", at: 1 }] } : undefined),
  });
  const r = await w.engine.interact(session(), { do: "click", ref: 12 }, { action: "click", id: 12 }, true);
  assert.equal(r.ok, true);
  assert.match(r.message, /The page showed a browser alert: "Product added\."\. It was closed with OK, and the page went on\./);
});

test("an action on a page that stops answering ends at its bound and says why, instead of holding the run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = fakeWorker({ tabs: { 9: tab }, onTabMessage: (_id, m) => (m.action === "interact" ? new Promise(() => {}) : undefined) });
  let done = null;
  w.engine.interact(session(), { do: "click", ref: 12 }, { action: "click", id: 12 }, true).then((r) => { done = r; });
  await flush();
  t.mock.timers.tick(59000);
  await flush();
  assert.equal(done, null, "an action is given its whole wait");
  t.mock.timers.tick(1000);
  await flush();
  t.mock.timers.tick(20000);
  await flush();
  assert.ok(done, "the step came back");
  assert.equal(done.ok, false);
  assert.match(done.message, /stopped answering during that action/);
  assert.match(done.message, /A browser dialog may be open on it/);
});

test("a look at a page that does not answer comes back said to be held, not loading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = fakeWorker({ tabs: { 9: tab }, granted: ["https://shop.example"], onTabMessage: () => new Promise(() => {}) });
  let page = null;
  w.engine.scan(session(), tab, () => {}).then((p) => { page = p; });
  await flush();
  t.mock.timers.tick(15000);
  await flush();
  assert.ok(page, "the look came back");
  assert.equal(page.protectedPage, true);
  assert.match(page.innerText, /did not answer in 15 seconds/);
  assert.equal(w.calls.scripts.length, 0, "the script is not sent again into a page that cannot run it");
});

test("a dialog the page opened between steps is a fact of the next step", () => {
  const facts = CONTEXT.runFacts({ step: 3, history: [] }, { url: "https://shop.example/", dialogs: [{ kind: "confirm", text: "Leave the cart?" }] });
  const line = facts.find((f) => /Since your last step/.test(f));
  assert.ok(line);
  assert.match(line, /asked in a browser dialog to go ahead: "Leave the cart\?"\. It was answered Cancel/);
  assert.equal(CONTEXT.dialogsNote([]), "");
});
