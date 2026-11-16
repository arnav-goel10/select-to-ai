"use strict";
// The run's life in a service worker that Chrome stops and starts again
// (engine.js): a waiting run brought back after a restart, messages from the
// agent's page that arrive while the worker is still restoring, a site the
// user said no to, the "Only use these sites" list, frames, and a worker
// without the optional notifications grant.
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeWorker, settle } = require("../helpers/fake-worker.js");
const RUN = require("../../extension/core/run.js");
const TOOLS = require("../../extension/agentTools.js");

/** A run saved by an earlier worker while it waited for the user to sign in on tab 9. */
function savedWaiting(kind = "sign_in") {
  const run = RUN.newRun({ id: "r1", task: "What is my balance?", tabId: 9, startUrl: "https://shop.example/account", marker: "PAGE-abcd1234", now: 1 });
  run.status = "waiting";
  run.waits = 1;
  run.wait = { id: "r1-w1", kind, question: "Please sign in on this page.", tabId: 9, since: 1 };
  return { "agentSession:1": { turns: [], run: JSON.parse(JSON.stringify(RUN.toStored(run))), extras: {} } };
}

test("a wait brought back after a worker restart does not notify again: the one reminder alarm is the only notice", async () => {
  const w = fakeWorker({ notifications: true, saved: savedWaiting() });
  const view = w.connect(1);
  await view.hello();
  await settle(60);
  const s = w.engine.sessions.get(1);
  assert.equal(s.run.status, "waiting");
  assert.ok(s.attending.has("r1-w1"), "the wait is attended again");
  assert.equal(w.calls.notices.length, 0, "no notice on replay: the user was told before the restart");
  assert.equal(w.calls.alarms.filter((a) => a.name.startsWith("agentRemind:")).length, 0, "the reminder is not re-armed: the old alarm outlives the worker");
  assert.ok(w.calls.tabMessages.some((m) => m.tabId === 9 && m.message.action === "needsYou"), "the page is watched again");
  assert.ok(w.calls.badges.some((b) => b.text === "!"), "the badge is put back");
  // The alarm set before the restart goes off: one notice, and only one.
  await w.fire("alarms.onAlarm", { name: "agentRemind:1" });
  await settle(30);
  assert.equal(w.calls.notices.length, 1);
  assert.match(w.calls.notices[0].title, /still waiting/);
  // Another wake (the agent page reconnects) adds nothing.
  await w.connect(1).hello();
  await settle(30);
  assert.equal(w.calls.notices.length, 1, "a reconnect does not notify again");
});

test("with notifications not granted the worker loads and a wait still marks the badge", async () => {
  const w = fakeWorker({ notifications: false, saved: savedWaiting() });
  assert.equal(w.root.chrome.notifications, undefined);
  await w.connect(1).hello();
  await settle(60);
  assert.ok(w.calls.badges.some((b) => b.text === "!"));
  await w.fire("alarms.onAlarm", { name: "agentRemind:1" });
  await settle(20);
  assert.equal(w.calls.notices.length, 0);
});

test("a task sent right after hello, while the worker is still restoring, is not dropped", async () => {
  const w = fakeWorker({ restoreDelayMs: 80, tabs: { 9: { id: 9, url: "https://shop.example/", title: "Shop", windowId: 1, active: true } } });
  const view = w.connect(1);
  // agent.js posts hello and flushes its queue in the same callback.
  const a = view.hello();
  const b = view.post({ type: "send", text: "find the blue widget", tabId: 9 });
  await Promise.all([a, b]);
  await settle(40);
  const started = view.posted.find((m) => m.type === "started");
  assert.ok(started, `the queued task was started: ${JSON.stringify(view.posted.map((m) => m.type))}`);
  assert.equal(started.task, "find the blue widget");
  assert.ok(view.posted.findIndex((m) => m.type === "started") > view.posted.findIndex((m) => m.type === "snapshot" || m.type === "memory"), "after the hello was answered");
});

test("Skip on site access: the run remembers the site and reads it as a page it cannot use, instead of asking again", async () => {
  const tab = { id: 9, url: "https://blocked.example/item", title: "Item", windowId: 1 };
  const w = fakeWorker({ injectFails: true, tabs: { 9: tab } });
  const blocked = [];
  const session = { windowId: 1, run: { task: "t", declinedSites: [] }, settings: { allowlist: "" }, items: {}, touched: new Set(), frames: [] };
  // First time: the user is asked.
  let page = await w.engine.scan(session, tab, (e) => blocked.push(e));
  assert.equal(page, null);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, "site_access");
  // The user pressed Skip: run.js keeps the origin on the run.
  const run = RUN.newRun({ id: "r2", task: "t", tabId: 9, startUrl: tab.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, { now: 1, settings: {}, extras: {} });
  RUN.advance(run, { type: "blocked", kind: "site_access", question: "Let the agent use blocked.example?", detail: [tab.url] }, { now: 2, settings: {}, extras: {} });
  assert.equal(run.wait.kind, "site_access");
  const fx = RUN.advance(run, { type: "skipped", id: run.wait.id }, { now: 3, settings: {}, extras: {} });
  assert.deepEqual(run.declinedSites, ["https://blocked.example"]);
  assert.equal(fx[0].type, "observe");
  // The next look: no second question, a page the model can leave.
  session.run.declinedSites = run.declinedSites;
  page = await w.engine.scan(session, tab, (e) => blocked.push(e));
  assert.equal(blocked.length, 1, "not asked again");
  assert.ok(page && page.protectedPage);
  assert.match(page.innerText, /did not let the agent onto this site/);
  // A site the user did not decline is still asked about.
  const other = { id: 10, url: "https://other.example/", title: "Other", windowId: 1 };
  assert.equal(await w.engine.scan(session, other, (e) => blocked.push(e)), null);
  assert.equal(blocked.length, 2);
});

test("Only use these sites: a page off the list is not read at all, however the run got there", async () => {
  const w = fakeWorker({});
  const session = { windowId: 1, run: { task: "t" }, settings: { allowlist: "shop.example" }, items: {}, touched: new Set(), frames: [] };
  const off = { id: 9, url: "https://elsewhere.example/linked", title: "Linked", windowId: 1 };
  const page = await w.engine.scan(session, off, () => assert.fail("no question for an off-list page"));
  assert.ok(page.protectedPage);
  assert.match(page.innerText, /outside the sites you allow/);
  assert.equal(page.elements.length, 0);
  assert.equal(w.calls.tabMessages.length, 0, "nothing was asked of the page");
  assert.equal(w.calls.executes, 0, "nothing was put into the page");
  // A page on the list (or a subdomain of it) is read as usual.
  const on = { id: 11, url: "https://www.shop.example/", title: "Shop", windowId: 1 };
  w.tabs[11] = on;
  await w.engine.scan(session, on, () => {});
  assert.ok(w.calls.tabMessages.some((m) => m.tabId === 11 && m.message.action === "scan"));
});

test("frame controls are numbered and judged against the frame's own form", () => {
  const w = fakeWorker({});
  // The page's form 0 is its search box; the frame's form 0 is a contact form.
  const page = {
    url: "https://shop.example/", elements: [
      { id: 1, tagName: "input", inputType: "search", accName: "Search", formId: 0 },
      { id: 2, tagName: "button", accName: "Search", submits: true, formId: 0 },
    ],
    forms: [{ id: 0, search: true, fields: 1 }],
  };
  const got = {
    elements: [
      { id: 1, tagName: "input", inputType: "text", accName: "Your message", formId: 0 },
      { id: 2, tagName: "button", accName: "Continue", submits: true, formId: 0 },
    ],
    forms: [{ id: 0, search: false, fields: 3 }],
  };
  w.engine.joinFrame(page, got, 1, {}, "frame", null);
  const submit = page.elements.find((e) => e.id === 100002);
  assert.equal(submit.formId, 100000);
  assert.ok(page.forms.some((f) => f.id === 100000 && !f.search && f.fields === 3), "the frame's form joins the page's forms");
  assert.equal(page.forms.find((f) => f.id === 0).search, true, "the page's own form is untouched");
  const risk = TOOLS.actionRisk({ action: "click", id: 100002 }, JSON.parse(JSON.stringify(page)));
  assert.ok(risk && risk.kind === "send", `the frame's Continue sends its form: ${JSON.stringify(risk)}`);
  assert.equal(TOOLS.actionRisk({ action: "click", id: 2 }, JSON.parse(JSON.stringify(page))), null, "the page's search button stays free");
});

test("a frame form on a page with no form of its own still counts as a form", () => {
  const w = fakeWorker({});
  const page = { url: "https://shop.example/", elements: [{ id: 1, tagName: "a", accName: "Home", url: "https://shop.example/" }] };
  const got = { elements: [{ id: 4, tagName: "button", accName: "Next", submits: true, formId: 0 }], forms: [{ id: 0, search: false, fields: 2 }] };
  w.engine.joinFrame(page, got, 2, {}, "frame", null);
  const next = page.elements.find((e) => e.id === 200004);
  assert.equal(next.formId, 200000);
  const risk = TOOLS.actionRisk({ action: "click", id: 200004 }, JSON.parse(JSON.stringify(page)));
  assert.ok(risk && risk.kind === "send", `before, this had no form and was let through: ${JSON.stringify(risk)}`);
  // A control in no form keeps no form number.
  w.engine.joinFrame(page, { elements: [{ id: 5, tagName: "a", accName: "Help" }] }, 3, {}, "frame", null);
  assert.equal(page.elements.find((e) => e.id === 300005).formId, undefined);
});
