"use strict";
// Handing a step to the user (sign in, a code, card details, a human check)
// and waiting until they have done it. The wait used to end by itself in
// about 1.4 seconds whenever the page's structure did not show the blocker
// (an email-first sign-in, a code box with no autocomplete), and the run
// then asked again, for ever. These tests hold the wait open until the
// blocker was seen and then went, and count a repeat on an unchanged page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const RUN = require("../../extension/core/run.js");
const { fakeWorker, settle } = require("../helpers/fake-worker.js");

const CONTENT = fs.readFileSync(path.join(__dirname, "../../extension/agentContentScript.js"), "utf8");

/** The source of one top-level function of the content script, by name. */
function source(name) {
  const start = CONTENT.indexOf(`    function ${name}(`);
  assert.ok(start > 0, `${name} is in agentContentScript.js`);
  const end = CONTENT.indexOf("\n    }\n", start);
  return CONTENT.slice(start, end + 6);
}

// ------------------------------------------------------------ a fake page

/** An input as the content script sees it. */
function field(o) {
  return {
    tagName: o.tag || "INPUT", type: o.type || "text", name: o.name || "", id: o.id || "", placeholder: o.placeholder || "",
    labels: o.label ? [{ innerText: o.label }] : [], attrs: o.attrs || {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    getBoundingClientRect: () => ({ width: 200, height: 30 }), closest: () => null,
  };
}

/** Enough of document.querySelectorAll for the selectors detectBlockers uses. */
function pageOf(fields) {
  const matches = (el, sel) => {
    if (/^input:not\(\[type="hidden"\]\), textarea$/.test(sel)) return (el.tagName === "INPUT" && el.type !== "hidden") || el.tagName === "TEXTAREA";
    return sel.split(",").map((s) => s.trim()).some((s) => {
      const type = s.match(/^input\[type="([^"]+)"\]$/);
      if (type) return el.tagName === "INPUT" && el.type === type[1];
      const ac = s.match(/^input\[autocomplete~="([^"]+)"\]$/);
      if (ac) return el.tagName === "INPUT" && String(el.getAttribute("autocomplete") || "").split(/\s+/).includes(ac[1]);
      return false;
    });
  };
  return { querySelectorAll: (sel) => fields.filter((el) => matches(el, sel)), title: "", body: { innerText: "" } };
}

/** detectBlockers and sensitiveKind from the content script, on a fake page. */
function blockersOn(fields) {
  const make = new Function("document", "getComputedStyle", "location", "accessibleName", `
    const HUMAN_CHECK_WIDGETS = "iframe[src*=\\"recaptcha\\"]";
    ${source("sensitiveKind")}
    ${source("detectBlockers")}
    return detectBlockers;`);
  return make(pageOf(fields), () => ({ visibility: "visible" }), { href: "https://shop.example/login" }, () => "")();
}

test("a code box with no autocomplete, named by its label, is a code blocker; card fields by name are payment", () => {
  assert.deepEqual(blockersOn([field({ name: "otp" })]).map((b) => b.kind), ["code"]);
  assert.deepEqual(blockersOn([field({ label: "Verification code" })]).map((b) => b.kind), ["code"]);
  assert.deepEqual(blockersOn([field({ name: "cardnumber", label: "Card number" })]).map((b) => b.kind), ["payment"]);
  assert.deepEqual(blockersOn([field({ type: "password" })]).map((b) => b.kind), ["sign_in"]);
  // Said once each, however many fields there are.
  assert.deepEqual(blockersOn([field({ name: "otp" }), field({ name: "otp2", label: "One-time code" })]).map((b) => b.kind), ["code"]);
  // An email box alone is not a blocker: the first step of an email-first sign-in shows none.
  assert.deepEqual(blockersOn([field({ type: "email", name: "identifier", label: "Email or phone" })]), []);
});

/**
 * waitForUser from the content script, with the page's blockers under the
 * test's control and the 700 ms timer turned by hand.
 */
function watch(kind, blockersNow) {
  const sent = [];
  let tick = null;
  const make = new Function("detectBlockers", "chrome", "setInterval", "location", "elementMap", `
    let needsYouTimer = null;
    const removeNeedsYou = () => {};
    const showNeedsYou = () => {};
    ${source("waitForUser")}
    return waitForUser;`);
  const waitForUser = make(() => blockersNow(), { runtime: { sendMessage: (m) => sent.push(m) } }, (fn) => { tick = fn; return 1; }, { href: "https://shop.example/login" }, {});
  waitForUser(kind, "Please sign in", undefined);
  return { sent, tick: (n = 1) => { for (let i = 0; i < n; i++) tick(); } };
}

test("an email-first sign-in page: the wait stays open while no password box was ever shown", () => {
  let blockers = [];
  const w = watch("sign_in", () => blockers);
  // Ten checks, seven seconds: the old watch said "cleared" after two.
  w.tick(10);
  assert.equal(w.sent.filter((m) => m.action === "agentBlockerCleared").length, 0, "not cleared by a blocker that was never there");
  // The user enters their email and the password box appears on the same page.
  blockers = [{ kind: "sign_in" }];
  w.tick();
  assert.ok(w.sent.some((m) => m.action === "agentBlockerSeen" && m.kind === "sign_in"), "the engine is told the blocker was seen");
  // They sign in: the box goes, and after two checks the wait is over.
  blockers = [];
  w.tick();
  assert.equal(w.sent.filter((m) => m.action === "agentBlockerCleared").length, 0, "one check is not enough");
  w.tick();
  assert.equal(w.sent.filter((m) => m.action === "agentBlockerCleared").length, 1);
});

test("a blocker seen at the start of the watch clears as before when it goes", () => {
  let blockers = [{ kind: "code" }];
  const w = watch("code", () => blockers);
  assert.ok(w.sent.some((m) => m.action === "agentBlockerSeen"));
  w.tick(3);
  assert.equal(w.sent.filter((m) => m.action === "agentBlockerCleared").length, 0);
  blockers = [];
  w.tick(2);
  assert.equal(w.sent.filter((m) => m.action === "agentBlockerCleared").length, 1);
});

// ------------------------------------------------------------ the engine

function savedWaiting() {
  const run = RUN.newRun({ id: "r1", task: "What is my balance?", tabId: 9, startUrl: "https://shop.example/login", marker: "PAGE-abcd1234", now: 1 });
  run.status = "waiting";
  run.waits = 1;
  run.wait = { id: "r1-w1", kind: "sign_in", question: "Please sign in.", tabId: 9, since: 1 };
  return { "agentSession:1": { turns: [], run: JSON.parse(JSON.stringify(RUN.toStored(run))), extras: {} } };
}

test("a new page without the blocker does not end a wait whose blocker was never seen; once seen, it does", async () => {
  let probe = { success: true, blockers: [] };
  const w = fakeWorker({ saved: savedWaiting(), onTabMessage: (_id, m) => (m.action === "probe" ? probe : { success: true }) });
  await w.connect(1).hello();
  await settle(40);
  const s = w.engine.sessions.get(1);
  const watches = () => w.calls.tabMessages.filter((m) => m.message.action === "needsYou").length;
  const before = watches();
  // The email step submits to a new page that still has no password box.
  await w.fire("tabs.onUpdated", 9, { status: "complete" });
  await settle(30);
  assert.equal(s.run.status, "waiting", "the wait is still open");
  assert.equal(watches(), before + 1, "the new page is watched again");
  // The password page: the blocker is there now.
  probe = { success: true, blockers: [{ kind: "sign_in" }] };
  await w.fire("tabs.onUpdated", 9, { status: "complete" });
  await settle(30);
  assert.equal(s.run.status, "waiting");
  assert.deepEqual(w.session.agentSeenWaits, ["r1-w1"], "seen, and kept for a worker that wakes up later");
  // Signed in: the account page has no blocker, and the wait is over.
  probe = { success: true, blockers: [] };
  await w.fire("tabs.onUpdated", 9, { status: "complete" });
  await settle(40);
  assert.ok(s.run.journal.some((j) => j.k === "ask_done" && j.id === "r1-w1" && j.how === "cleared"), "cleared once the seen blocker went");
});

test("the page saying it saw the blocker counts for the next page load too", async () => {
  const w = fakeWorker({ saved: savedWaiting(), onTabMessage: (_id, m) => (m.action === "probe" ? { success: true, blockers: [] } : { success: true }) });
  await w.connect(1).hello();
  await settle(40);
  for (const fn of w.listeners["runtime.onMessage"] || []) fn({ action: "agentBlockerSeen", kind: "sign_in" }, { tab: { id: 9 }, frameId: 0 }, () => {});
  await settle(20);
  await w.fire("tabs.onUpdated", 9, { status: "complete" });
  await settle(40);
  const s = w.engine.sessions.get(1);
  assert.ok(s.run.journal.some((j) => j.k === "ask_done" && j.how === "cleared"));
});

// ------------------------------------------------------------ the run

const login = (extra) => ({
  url: "https://bank.example/login", title: "Sign in", visibleText: "Sign in. Email", innerText: "Sign in to your account. Email or phone. Next.",
  elements: [
    { id: 1, tagName: "input", inputType: "email", accName: "Email or phone", formId: 0 },
    { id: 2, tagName: "button", accName: "Next", submits: true, formId: 0 },
  ],
  forms: [{ id: 0, search: false, fields: 1 }],
  ...extra,
});
const env = (page) => ({ now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} });
const askSignIn = (run, page) => RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "sign in", actions: [{ do: "ask_user", kind: "sign_in", question: "Please sign in." }] }, usage: {} }, env(page));

test("two hand-offs on a page that did not change count as going round, and the user's 'done' does not reset that", () => {
  const page = login();
  const run = RUN.newRun({ id: "r1", task: "what is my balance?", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  askSignIn(run, page);
  assert.equal(run.status, "waiting");
  assert.equal(run.handoff.n, 1);
  RUN.advance(run, { type: "user_done", id: run.wait.id }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  assert.equal(run.stuck.steps, 0, "one hand-off is not going round");
  askSignIn(run, page);
  assert.equal(run.handoff.n, 2, "the same hand-off on the same page");
  RUN.advance(run, { type: "cleared", id: run.wait.id }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  assert.ok(run.stuck.steps >= 1, `a repeat on an unchanged page counts toward the stuck stop: ${JSON.stringify(run.stuck)}`);
  // Each further repeat brings the stop nearer, until the next step is the last.
  for (let i = 0; i < 8 && !run.wrapUp; i++) {
    askSignIn(run, page);
    RUN.advance(run, { type: "user_done", id: run.wait.id }, env(page));
    RUN.advance(run, { type: "observed", page }, env(page));
  }
  assert.equal(run.wrapUp && run.wrapUp.by, "stuck", "the run stops going round");
});

test("a hand-off after which the page changed is not a repeat", () => {
  const page = login();
  const run = RUN.newRun({ id: "r1", task: "what is my balance?", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  askSignIn(run, page);
  RUN.advance(run, { type: "cleared", id: run.wait.id }, env(page));
  const password = login({ url: "https://bank.example/login/password", visibleText: "Enter your password", innerText: "Enter your password. Sign in.", elements: [{ id: 1, tagName: "input", inputType: "password", accName: "Password", sensitive: "password", formId: 0 }] });
  RUN.advance(run, { type: "observed", page: password }, env(password));
  assert.equal(run.stuck.steps, 0);
  askSignIn(run, password);
  assert.equal(run.handoff.n, 1, "a new page starts the count again");
});

test("provider pauses end the run after four in a row, with what it had found", () => {
  const page = login();
  const run = RUN.newRun({ id: "r1", task: "t", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  RUN.advance(run, { type: "model_replied", reply: { memory: "Balance page is behind a sign-in.", goal: "g", actions: [{ do: "scroll", direction: "down" }] }, usage: {} }, env(page));
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Done." } }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  const refuse = () => RUN.advance(run, { type: "model_failed", purpose: "step", kind: "rate_limited", waitMs: 0, message: "OpenRouter kept turning requests away as too many." }, env(page));
  for (let i = 0; i < 4; i++) {
    refuse();
    assert.equal(run.wait.kind, "pause", `pause ${i + 1}`);
    RUN.advance(run, { type: "pause_over", id: run.wait.id }, env(page));
    RUN.advance(run, { type: "observed", page }, env(page));
  }
  const fx = refuse();
  assert.deepEqual(fx, [{ type: "end" }]);
  assert.equal(run.status, "failed");
  assert.equal(run.outcome.kind, "rate_limited");
  assert.match(run.outcome.text, /after 4 waits/);
  assert.match(run.outcome.text, /What I had found:\nStep 1: Balance page is behind a sign-in\./);
});

test("a single provider wait longer than an hour ends the run instead of pausing it", () => {
  const page = login();
  const run = RUN.newRun({ id: "r1", task: "t", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  const fx = RUN.advance(run, { type: "model_failed", purpose: "step", kind: "rate_limited", waitMs: 2 * 3600000, message: "Come back in two hours." }, env(page));
  assert.deepEqual(fx, [{ type: "end" }]);
  assert.equal(run.outcome.kind, "rate_limited");
});

test("an answer from the provider starts the count of pauses again", () => {
  const page = login();
  const run = RUN.newRun({ id: "r1", task: "t", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 3; i++) {
      RUN.advance(run, { type: "model_failed", purpose: "step", kind: "rate_limited", waitMs: 60000, message: "Wait a minute." }, env(page));
      assert.equal(run.wait.kind, "pause");
      RUN.advance(run, { type: "pause_over", id: run.wait.id }, env(page));
      RUN.advance(run, { type: "observed", page }, env(page));
    }
    RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "g", actions: [{ do: "scroll", direction: "down" }] }, usage: {} }, env(page));
    RUN.advance(run, { type: "acted", result: { ok: true, message: "Done." } }, env(page));
    RUN.advance(run, { type: "observed", page }, env(page));
  }
  assert.equal(run.status, "running");
});
