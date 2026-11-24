"use strict";
// Three faults of the trial harness (tests/bench/run.js): the page text kept
// for the judge, the start from the toolbar that gives the agent a picture
// of the page, and the simulated approver at a held step (off by default).
// No browser and no network here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("../bench/trial.js");
const J = require("../bench/judge.js");
const O = require("../bench/om2w.js");
const A = require("../bench/approver.js");
const { findModelRates } = require("../../extension/defaults.js");

const ROOT = path.join(__dirname, "../..");
const RUN_SRC = () => fs.readFileSync(path.join(ROOT, "tests/bench/run.js"), "utf8");

/** The text of one top-level function of run.js, from its head to the closing brace at the start of a line. */
function bodyOf(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `run.js has ${head}`);
  const end = src.indexOf("\n}\n", at);
  assert.ok(end > at, `${head} ends`);
  return src.slice(at, end);
}

/** `a` and `b` are both in `text`, and `a` comes first. A deleted call fails here, as indexOf -1 would not. */
function inOrder(text, a, b) {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  assert.ok(i >= 0, `missing: ${a}`);
  assert.ok(j >= 0, `missing: ${b}`);
  assert.ok(i < j, `${a} comes before ${b}`);
}

// ---- 1. Every state of a page, not one text per address

test("a page that changes without its address changing keeps each state, in the order first seen", () => {
  const url = "https://www.index.example/constituents";
  const states = [];
  T.keepPageState(states, { url, title: "Constituents", text: "Page 1 of 3: Alpha 10.5, Beta 9.1" });
  T.keepPageState(states, { url, title: "Constituents", text: "Page 2 of 3: Gamma 8.2, Delta 7.7" });
  T.keepPageState(states, { url, title: "Constituents", text: "Page 3 of 3: Epsilon 6.0" });
  assert.deepEqual(states.map((p) => p.text.slice(0, 6)), ["Page 1", "Page 2", "Page 3"]);
  // Back to page 1 with the same text: no new state, and page 1 keeps its place; it is marked as seen last.
  T.keepPageState(states, { url, title: "Constituents", text: "Page  1 of 3:\nAlpha 10.5, Beta 9.1" });
  assert.deepEqual(states.map((p) => p.text.slice(0, 6)), ["Page 1", "Page 2", "Page 3"]);
  assert.ok(states[0].lastSeen > states[2].lastSeen, "the revisit is recorded as when it was seen");
  // A revisit whose text differs is a new state, at the end.
  T.keepPageState(states, { url, title: "Constituents", text: "Page 1 of 3: Alpha 10.6, Beta 9.1" });
  assert.equal(states.length, 4);
  assert.equal(states[3].text, "Page 1 of 3: Alpha 10.6, Beta 9.1");
  // Another address is a state of its own too.
  T.keepPageState(states, { url: "https://www.index.example/about", title: "About", text: "About us" });
  assert.equal(states.length, 5);
});

test("the states are bounded in number, and no fewer distinct pages are kept than the ten main kept", () => {
  // Twelve distinct full-size pages: every one is kept, where main kept the last ten addresses.
  const big = [];
  for (let i = 0; i < 12; i++) T.keepPageState(big, { url: `https://a.example/p${i}`, title: "", text: `${i % 10}`.repeat(T.PAGE_STATES.chars + 500) });
  assert.equal(big.length, 12);
  assert.ok(big.every((p) => p.text.length === T.PAGE_STATES.chars), "each capture is cut to the stated size");
  // Many states of one address do not push the other addresses out.
  const one = [];
  for (let i = 0; i < 10; i++) T.keepPageState(one, { url: `https://a.example/p${i}`, title: "", text: `page ${i}` });
  for (let i = 0; i < 50; i++) T.keepPageState(one, { url: "https://a.example/list", title: "", text: `results page ${i}` });
  assert.equal(one.length, T.PAGE_STATES.most);
  for (let i = 0; i < 10; i++) assert.ok(one.some((p) => p.url === `https://a.example/p${i}`), `p${i} kept`);
  assert.equal(one.filter((p) => p.url === "https://a.example/list").pop().text, "results page 49", "the newest state of the busy address is kept");
  // More distinct addresses than the bound: the ones seen last are kept, in the order first seen.
  const many = [];
  const q = (i) => T.keepPageState(many, { url: `https://a.example/q${i}`, title: "", text: `q ${i}` });
  for (let i = 0; i < T.PAGE_STATES.most; i++) q(i);
  q(0);
  for (let i = T.PAGE_STATES.most; i < T.PAGE_STATES.most + 5; i++) q(i);
  assert.equal(many.length, T.PAGE_STATES.most);
  assert.equal(many[0].url, "https://a.example/q0", "q0, seen again, is kept in its first-seen place");
  for (let i = 1; i <= 5; i++) assert.ok(!many.some((p) => p.url === `https://a.example/q${i}`), `q${i} went`);
  assert.ok(many.some((p) => p.url === "https://a.example/q6"));
  assert.ok(T.PAGE_STATES.most >= 10 && T.PAGE_STATES.most * T.PAGE_STATES.chars >= 10 * 60000, "room for main's ten full-size pages");
});

test("run.js keeps page states, not one text per address", () => {
  const src = RUN_SRC();
  assert.match(src, /TRIAL\.keepPageState\(pageStates, seen\)/);
  assert.ok(!/seenPages\.delete\(seen\.url\)/.test(src), "no map keyed by address");
  assert.match(src, /pages: pageStates,/);
});

test("the judge is shown every earlier state at one address, in order, and is told what is kept as it is", () => {
  const url = "https://www.index.example/constituents";
  const msg = J.judgeMessage({
    task: "List every constituent of the index with its weight", startUrl: "https://www.index.example/", ending: "finished",
    answer: "\"Alpha 10.5, Beta 9.1\" and more", history: [],
    finalUrl: url, finalTitle: "Constituents", finalText: "Page 3 of 3: Epsilon 6.0",
    pages: [
      { url, title: "Constituents", text: "Page 1 of 3: Alpha 10.5, Beta 9.1", lastSeen: 1 },
      { url, title: "Constituents", text: "Page 2 of 3: Gamma 8.2, Delta 7.7", lastSeen: 2 },
      { url, title: "Constituents", text: "Page 3 of 3: Epsilon 6.0", lastSeen: 3 },
    ],
    screenshots: [],
  });
  const one = msg.indexOf("Alpha 10.5, Beta 9.1\n");
  const two = msg.indexOf("Gamma 8.2, Delta 7.7\n");
  assert.ok(one > 0 && two > one, "both earlier states are there, in the order first seen");
  assert.match(msg, /\(state 1 of 2 at this address\)/);
  assert.match(msg, /\(state 2 of 2 at this address\)/);
  assert.equal((msg.match(/Page 3 of 3/g) || []).length, 1, "the final page is shown once, as the final page");
  // What the message says is kept is what keepPageState keeps.
  assert.ok(msg.includes(`up to ${T.PAGE_STATES.most} page states, the first ${T.PAGE_STATES.chars} characters of each`));
});

test("a revisit that the final page matches is the final page, wherever it sits in the list", () => {
  const url = "https://a.example/list";
  const earlier = J.earlierStates({
    finalUrl: url, finalText: "results page 1 (drawn again)",
    pages: [
      { url, title: "", text: "results page 1", lastSeen: 5 },
      { url, title: "", text: "results page 2", lastSeen: 4 },
    ],
  });
  assert.deepEqual(earlier.map((p) => p.text), ["results page 2"], "the state seen last at the final address is the final page, not the one at the end of the list");
});

test("past the number of states the judge is shown, the last ones are shown and the rest are said to be left out", () => {
  const pages = Array.from({ length: J.EARLIER_STATES_SHOWN + 3 }, (_, i) => ({ url: `https://a.example/p${i}`, title: `P${i}`, text: `text of page ${i}`, lastSeen: i + 1 }));
  const msg = J.judgeMessage({ task: "t", startUrl: "https://a.example/", ending: "finished", answer: "a", history: [], finalUrl: "https://a.example/final", finalText: "final", pages, screenshots: [] });
  assert.ok(!msg.includes("text of page 2\n") && msg.includes("text of page 3\n") && msg.includes(`text of page ${J.EARLIER_STATES_SHOWN + 2}\n`));
  assert.match(msg, /the 3 first-seen state\(s\) are left out here/);
  assert.ok(msg.indexOf("text of page 3\n") < msg.indexOf("text of page 4\n"), "in order");
});

test("the batch reserve is priced on the largest message the judge can be sent", () => {
  // The longest a page excerpt can be, with every window filled.
  const words = Array.from({ length: 4000 }, (_, i) => `alpha${i % 7} beta ${i} gamma`).join(" ");
  for (const o of [J.EXCERPT_EARLIER, J.EXCERPT_FINAL]) {
    const quotes = Array.from({ length: 12 }, (_, i) => words.slice(1000 + i * 4000, 1040 + i * 4000));
    assert.ok(J.excerptFor(words, "alpha1 alpha2 beta gamma 17", { ...o, quotes }).length <= J.excerptMostChars(o));
  }
  // A run at every bound: ten earlier full-size states and more, a full final page, the engine's readings at their total.
  const page = (i) => ({ url: `https://a.example/p${i}`, title: `Page ${i}`, text: `${words} ${i}`.slice(0, T.PAGE_STATES.chars), lastSeen: i + 1 });
  const run = {
    task: "alpha1 alpha2 beta gamma 17", startUrl: "https://a.example/", ending: "finished", answer: "the answer", history: Array.from({ length: 40 }, (_, i) => ({ step: i + 1, ok: true, action: "click", on: "Next", outcome: "The page changed" })),
    pages: Array.from({ length: T.PAGE_STATES.most }, (_, i) => page(i)), finalUrl: "https://a.example/final", finalTitle: "Final", finalText: words,
    engineReadings: Array.from({ length: T.READING.pages }, (_, i) => ({ url: `https://a.example/p${i}`, title: "", text: "x".repeat(T.READING.total / T.READING.pages), chars: 90000 })),
    screenshots: [],
  };
  const most = J.judgeMessageMostChars(T.READING.total);
  assert.ok(J.judgeMessage(run).length <= most, `${J.judgeMessage(run).length} characters fit in the ${most} the reserve is priced on`);
  assert.ok(most > 60000, "larger than the 60,000 characters the reserve was priced on before");
  assert.match(RUN_SRC(), /text: "x"\.repeat\(J\.judgeMessageMostChars\(TRIAL\.READING\.total\)\)/);
});

// ---- 2. Started from the toolbar, so the browser gives the agent a picture

test("run.js starts each run from the toolbar on the page and asks the browser whether a picture can be had", () => {
  const src = RUN_SRC();
  const launch = src.slice(src.indexOf("const browser = await puppeteer.launch({"), src.indexOf("const workerTarget = await browser.waitForTarget("));
  assert.ok(launch.length > 0);
  assert.match(launch, /pipe: true,/);
  assert.match(launch, /"--enable-unsafe-extension-debugging"/);
  assert.match(bodyOf(src, "async function openFromToolbar("), /await page\.triggerExtensionAction\(ext\)/);
  // In runTask, the press comes before the agent's own window is opened, and the probe before the run starts.
  const run = bodyOf(src, "async function runTask(");
  inOrder(run, "await openFromToolbar(browser, extensionId, target)", 'Target.createTarget", { url: "about:blank", newWindow: true }');
  inOrder(run, "w.evaluate(pictureRefusalInWorker, tabId)", "agent.html?task=");
  // The loaded copy still adds no permission the shipped build lacks for this, in any list of the manifest.
  const edit = src.slice(src.indexOf("const manifest = JSON.parse("), src.indexOf("fs.writeFileSync(manifestPath"));
  assert.ok(edit.length > 0 && edit.includes("manifest.host_permissions"));
  assert.ok(!/<all_urls>|activeTab/.test(edit));
  assert.match(fs.readFileSync(path.join(ROOT, "tests/bench/trial.js"), "utf8"), /would not give the agent a picture of the page/);
});

// ---- 3. The simulated approver, off unless BENCH_APPROVER=on

const judge = { url: "https://api.anthropic.com/v1/messages", key: "k", model: "claude-sonnet-5-5", isAnthropic: true };

test("the approver is off by default and on only with BENCH_APPROVER=on", () => {
  assert.equal(A.approverConfig(judge, {}).enabled, false);
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER: "off" }).enabled, false);
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER: "1" }).enabled, false);
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER: "on" }).enabled, true);
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER: "on", BENCH_APPROVER_CALLS: "0" }).enabled, false);
  // Off, nothing is kept back from a run's budget for it, so capped runs go as before.
  assert.equal(A.approverRoomUSD(A.approverConfig(judge, {}), findModelRates), 0);
  // No workflow turns it on except the dry leg that tests it.
  for (const f of fs.readdirSync(path.join(ROOT, ".github/workflows"))) {
    const y = fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
    const lines = y.split("\n").filter((l) => /BENCH_APPROVER\b/.test(l));
    for (const l of lines) assert.match(l, /BENCH_APPROVER: \$\{\{ matrix\.approver \}\}/, `${f}: ${l.trim()}`);
    const on = y.split("\n").filter((l) => /approver: "on"/.test(l));
    for (const l of on) assert.match(l, /leg: approver,/, `${f}: ${l.trim()}`);
  }
});

test("the approver is asked about the task and the held step only, and its reply is read", () => {
  const msg = A.approverMessage("Add the blue sofa to my cart", "This commits you to something.\nButton: Add to cart");
  assert.match(msg, /Add the blue sofa to my cart/);
  assert.match(msg, /Button: Add to cart/);
  assert.match(A.APPROVER_SYSTEM, /does the task as written ask for this step\?/);
  // What it may never allow is decided in code by kind, not by a rule in its prompt.
  assert.ok(!/Never yes|never yes/.test(A.APPROVER_SYSTEM));
  assert.ok(!/\u2014/.test(A.APPROVER_SYSTEM));
  assert.deepEqual(A.parseApproval('Sure. {"asks": true, "reason": "The task says to add it to the cart."}'), { asks: true, reason: "The task says to add it to the cart." });
  assert.deepEqual(A.parseApproval('{"asks": false, "reason": "Not asked."}'), { asks: false, reason: "Not asked." });
  assert.equal(A.parseApproval("yes"), null);
  assert.equal(A.parseApproval('{"approve": true}'), null);
});

test("on, it uses the judge's endpoint and key, a cheap model on Anthropic, and its most cost is kept back", () => {
  const c = A.approverConfig(judge, { BENCH_APPROVER: "on" });
  assert.equal(c.model, "claude-haiku-5-5");
  assert.equal(c.url, judge.url);
  assert.equal(c.key, "k");
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER: "on", BENCH_APPROVER_MODEL: "claude-x" }).model, "claude-x");
  assert.equal(A.approverConfig({ ...judge, url: "https://integrate.api.nvidia.com/v1", isAnthropic: false, model: "m" }, { BENCH_APPROVER: "on" }).model, "m");
  const one = A.approverCallMaxUSD(c, findModelRates);
  assert.ok(one > 0 && one < 0.01, `one call at most ${one}`);
  assert.ok(Math.abs(A.approverRoomUSD(c, findModelRates) - c.maxCalls * one) < 1e-12);
  const src = RUN_SRC();
  assert.match(src, /if \(used \+ judgeRoom \+ approverRoom >= MAX_USD\) break;/);
  assert.match(src, /setRunBudget\(MAX_USD - used - judgeRoom - approverRoom\)/);
});

const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });

test("one call answers a hold, its tokens are counted, and no readable answer is a no", async () => {
  const cfg = { enabled: true, model: "claude-haiku-5-5", url: "https://api.anthropic.com/v1/messages", key: "k", isAnthropic: true, maxCalls: 6, retryMs: 1 };
  const sent = [];
  const yes = await A.askApprover({ task: "Add it to my cart", step: "Button: Add to cart" }, cfg, { fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return reply(200, { content: [{ type: "text", text: '{"asks": true, "reason": "asked"}' }], usage: { input_tokens: 400, output_tokens: 20 } }); } });
  assert.equal(yes.asks, true);
  assert.equal(sent.length, 1, "one call");
  assert.equal(sent[0].url, cfg.url);
  assert.equal(sent[0].body.model, "claude-haiku-5-5");
  assert.equal(sent[0].body.system, A.APPROVER_SYSTEM);
  assert.equal(sent[0].body.messages.length, 1);
  assert.deepEqual({ input: yes.usage.input, output: yes.usage.output, calls: yes.usage.calls }, { input: 400, output: 20, calls: 1 });
  assert.ok(T.judgeCostUSD(yes.usage, findModelRates) > 0, "what it cost is priced");
  const garbled = await A.askApprover({ task: "t", step: "s" }, cfg, { fetchImpl: async () => reply(200, { content: [{ type: "text", text: "I think so" }], usage: { input_tokens: 10, output_tokens: 3 } }) });
  assert.equal(garbled.asks, false);
  assert.equal(garbled.usage.calls, 1, "an answered call is paid for, readable or not");
  let tries = 0;
  const down = await A.askApprover({ task: "t", step: "s" }, cfg, { fetchImpl: async () => { tries++; return reply(503, {}); } });
  assert.equal(down.asks, false);
  assert.equal(tries, 2, "a call with no answer is tried once more");
  tries = 0;
  const refused = await A.askApprover({ task: "t", step: "s" }, cfg, { fetchImpl: async () => { tries++; return reply(400, {}); } });
  assert.equal(refused.asks, false);
  assert.equal(tries, 1);
});

const card = (kind) => ({ kind, pending: true, text: `card ${kind}`, step: `step ${kind}` });

test("paying, deleting, secrets, frames and unchecked presses are declined by kind before any model call", async () => {
  // The engine's own kinds: each is one the engine can put on a card.
  const engine = ["extension/core/policy.js", "extension/agentTools.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  for (const k of A.NOT_PUT_TO_APPROVER.filter((x) => x !== "unknown")) assert.ok(engine.includes(`"${k}"`), `the engine has a ${k} hold`);
  for (const k of ["pay", "delete", "secret", "frame", "unchecked"]) assert.ok(A.NOT_PUT_TO_APPROVER.includes(k), k);
  for (const k of A.NOT_PUT_TO_APPROVER) {
    let calls = 0;
    // Even an approver that would say yes is never reached.
    const got = await A.settleHold(card(k), "Buy the cheapest cable and delete my old address", async () => { calls++; return { asks: true, reason: "asked" }; });
    assert.equal(calls, 0, `${k}: no call`);
    assert.equal(got.yes, false);
    assert.equal(got.record.allowed, false);
    assert.equal(got.record.by, "declined");
    assert.equal(got.record.approver.refused, true);
  }
  // A kind it may answer for is put to it, with the task and the step.
  const asked = [];
  const yes = await A.settleHold(card("send"), "Post my comment", async (q) => { asked.push(q); return { asks: true, reason: "the task asks", model: "m", usd: 0.001 }; });
  assert.deepEqual(asked, [{ task: "Post my comment", step: "step send" }]);
  assert.equal(yes.yes, true);
  assert.deepEqual({ allowed: yes.record.allowed, by: yes.record.by, asks: yes.record.approver.asks }, { allowed: true, by: "approver", asks: true });
  const no = await A.settleHold(card("decide"), "Read the price", async () => ({ asks: false, reason: "not asked" }));
  assert.deepEqual({ yes: no.yes, allowed: no.record.allowed, by: no.record.by }, { yes: false, allowed: false, by: "approver" });
  // Past the run's call limit: declined, and recorded as not asked.
  const skipped = await A.settleHold(card("send"), "t", async () => ({ asks: false, skipped: true, reason: "limit" }));
  assert.deepEqual({ yes: skipped.yes, by: skipped.record.by, skipped: skipped.record.approver.skipped }, { yes: false, by: "declined", skipped: true });
  // Off: every hold declined, as before, with nothing of the approver in the record.
  const off = await A.settleHold(card("send"), "Post my comment", null);
  assert.deepEqual(off, { yes: false, record: { kind: "send", text: "card send", step: "step send", allowed: false, by: "declined" } });
});

/** A minimal page with one hold card, for the functions that run in the agent's page. */
function fakeCard(kind) {
  const clicked = [];
  const node = (text, extra = {}) => ({ textContent: text, dataset: {}, ...extra });
  const buttons = { ".confirm-risk-btn": { click: () => clicked.push("allow") }, ".abort-risk-btn": { click: () => clicked.push("decline") } };
  const bubble = {
    dataset: { riskKind: kind },
    innerText: "Allow this step? This sends or submits something on your behalf. Allow this step Don't do this",
    querySelector: (sel) => (sel === ".confirm-text" ? node("This sends or submits something on your behalf.") : buttons[sel] || null),
    querySelectorAll: (sel) => (sel === ".confirm-detail-row" ? [node("Submit order details", { dataset: { label: "Button" } })] : []),
  };
  return { document: { querySelector: (sel) => (sel === ".confirmation-bubble.risk" ? bubble : null) }, clicked };
}

test("in the page: a kind on the allow list is allowed at once, any other waits with its description", () => {
  const was = global.document;
  try {
    let page = fakeCard("site");
    global.document = page.document;
    assert.deepEqual(A.holdCardInPage(["site", "address"]), { kind: "site", allowed: true, by: "allow list", text: page.document.querySelector(".confirmation-bubble.risk").innerText.replace(/\s+/g, " ").slice(0, 200), step: "This sends or submits something on your behalf.\nButton: Submit order details" });
    assert.deepEqual(page.clicked, ["allow"]);
    page = fakeCard("send");
    global.document = page.document;
    const held = A.holdCardInPage(["site", "address"]);
    assert.equal(held.pending, true);
    assert.equal(held.step, "This sends or submits something on your behalf.\nButton: Submit order details");
    assert.deepEqual(page.clicked, [], "nothing is pressed before the hold is settled");
    assert.equal(A.answerHoldInPage(true), true);
    assert.equal(A.answerHoldInPage(false), true);
    assert.deepEqual(page.clicked, ["allow", "decline"]);
    global.document = { querySelector: () => null };
    assert.equal(A.holdCardInPage(["site"]), null);
  } finally { global.document = was; }
});

test("run.js settles each other hold through settleHold, with the approver only when it is on", () => {
  const src = RUN_SRC();
  const run = bodyOf(src, "async function runTask(");
  inOrder(run, "agentPage.evaluate(APPROVAL.holdCardInPage, [...ALLOW])", "await APPROVAL.settleHold(card, task.task, hooks.approve || null)");
  inOrder(run, "await APPROVAL.settleHold(card, task.task, hooks.approve || null)", "agentPage.evaluate(APPROVAL.answerHoldInPage, yes)");
  assert.match(src, /\{ approve: APPROVER\.enabled \? \(q\) => approveHold\(q, live\) : null \}/);
  assert.match(run, /\.\.\.\(APPROVER\.enabled \? \{ approverOn: true \} : \{\}\)/);
  assert.ok(!/const ok = allow\.includes\(kind\);/.test(src), "declined in one place, settleHold");
});

const row = (over) => ({ id: "x", success: false, ending: "finished", held: [], ...over });

test("off, the counts and the report are as they always were", () => {
  const rows = [row({ success: true }), row({ held: [{ kind: "send", allowed: false, by: "declined" }], ending: "stopped at a confirmation (send)" }), row({ blocked: true })];
  const c = O.countsOf(rows);
  assert.deepEqual(c.outcomes, { passed: 1, failed: 0, blocked: 1, "timed out": 0, held: 0, declined: 1, lost: 0 });
  assert.equal(c.approverRuns, 0);
  const r = O.report(O.mergeCounts([c]), { planned: 3 });
  assert.equal(r.strictRate, 1 / 3);
  assert.equal(r.withApprover, undefined);
  const md = O.reportMarkdown(r, { part: "dev" });
  assert.ok(!/approver/i.test(md), "no approver line when it was off");
  assert.match(md, /Real spend: \$0\.0000 \(agent \$0\.0000, judge \$0\.0000\)\./);
  // trial.js: no approver line, and the headline rows are the rows themselves.
  assert.equal(T.approverSummary(rows, []), null);
  for (const x of rows) assert.equal(A.allDeclinedRow(x), x);
  // A counts file from before the approver merges with no approver numbers.
  const old = { ...O.emptyCounts(), runs: 1, outcomes: { ...O.emptyCounts().outcomes, passed: 1 } };
  delete old.outcomesWithApprover; delete old.holds; delete old.approverRuns;
  const m = O.mergeCounts([old]);
  assert.equal(m.outcomes.passed, 1);
  assert.equal(O.report(m, { planned: 1 }).withApprover, undefined);
});

test("on, the headline counts every hold declined and every summary adds the score with the approver and its approved holds", () => {
  const on = (over) => row({ approverOn: true, ...over });
  const rows = [
    on({ success: true, held: [{ kind: "decide", allowed: true, by: "approver", approver: { asks: true } }], approverUSD: 0.001 }),
    on({ success: true }),
    on({ held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }], ending: "stopped at a confirmation (send)" }),
    on({ blocked: true, held: [{ kind: "pay", allowed: false, by: "declined", approver: { asks: false, refused: true } }] }),
    on({ success: true, held: [{ kind: "site", allowed: true, by: "allow list" }] }),
  ];
  assert.equal(O.outcomeAllDeclined(rows[0]), "declined");
  assert.equal(O.outcomeAllDeclined(rows[4]), "passed", "a hold allowed by the allow list is not the approver's");
  assert.equal(A.allDeclinedRow(rows[0]).success, false);
  const c = O.countsOf(rows);
  assert.equal(c.outcomes.passed, 2, "the headline");
  assert.equal(c.outcomes.declined, 2);
  assert.equal(c.outcomesWithApprover.passed, 3);
  assert.deepEqual(c.holds, { asked: 2, approved: 1, declined: 1, refused: 1, runsApproved: 1 });
  const r = O.report(O.mergeCounts([c]), { planned: 5 });
  assert.equal(r.strictRate, 2 / 5);
  assert.equal(r.withApprover.strictRate, 3 / 5);
  assert.equal(r.scoredRate, 2 / 4);
  assert.equal(r.withApprover.scoredRate, 3 / 4);
  assert.ok(Math.abs(r.spendUSD - 0.001) < 1e-12, "the approver's spend is in the total");
  const md = O.reportMarkdown(r, { part: "dev" });
  assert.match(md, /\| every hold declined \(the headline\) \| 2 \| 2 \| 40\.0% \| 50\.0% \|/);
  assert.match(md, /\| with the simulated approver \| 3 \| 1 \| 60\.0% \| 75\.0% \|/);
  assert.match(md, /2 hold\(s\) put to it, 1 approved in 1 run\(s\), 1 declined on its no, 1 declined by kind with no call/);
  // trial.js: the table counts every hold declined, and a line adds the approver's score.
  const planned = rows.map((x, i) => ({ id: `t${i}`, level: "fixture" }));
  const named = rows.map((x, i) => ({ ...x, id: `t${i}`, family: "fixture" }));
  const a = T.approverSummary(named, planned);
  assert.equal(a.withApprover.passed, 3);
  const table = T.familyTable(named.map(A.allDeclinedRow), planned);
  assert.equal(table.total.passed, 2);
  const text = T.markdown(table, { approver: a });
  assert.match(text, /Passed 2 of 4 scored runs/);
  assert.match(text, /Simulated approver on in 5 run\(s\): 2 hold\(s\) put to it, 1 approved in 1 run\(s\), 1 declined by kind with no call\. The numbers above count every hold declined\. With the approver's answers: passed 3 of 4 scored runs \(75\.0%\)/);
  // The sealed report gives it too, as numbers.
  const sealed = T.sealedReport(named.map(A.allDeclinedRow), planned, { approver: a });
  assert.equal(sealed.total.passed, 2);
  assert.equal(sealed.approver.withApprover.passed, 3);
  assert.equal(sealed.approver.holds.approved, 1);
  assert.match(T.sealedMarkdown(sealed), /Simulated approver on in 5 run\(s\)/);
  // The run's own log line passes the sealed filter: numbers and a model name only.
  const line = A.approverLine("claude-haiku-5-5", c.holds, { allDeclined: 0.5, withApprover: 0.75, allDeclinedAllRuns: 0.4, withApproverAllRuns: 0.6 });
  assert.equal(T.sealedLogText(line), line);
  const src = RUN_SRC();
  assert.match(src, /const s = summarise\(rows\.map\(APPROVAL\.allDeclinedRow\)\);/);
  assert.match(src, /summary: s, \.\.\.\(withApprover \? \{ summaryWithApprover: withApprover \} : \{\}\)/);
});

test("the approver's spend counts in what a row cost, so it counts under the cap", () => {
  assert.ok(Math.abs(T.spendOf({ costUSD: 0.01, approverUSD: 0.002, judgeCostUSD: 0.003 }) - 0.015) < 1e-12);
  const src = RUN_SRC();
  assert.match(src, /spent \+= \(run\.costUSD \|\| 0\) \+ \(run\.approverUSD \|\| 0\)/);
  assert.match(src, /approverUSD: live\.approverUSD \|\| 0,/);
});

test("the dry check wants a picture, and holds settled the way the approver's state and the fixture say", () => {
  const base = { id: "fx", success: false, ending: "finished", steps: 1, seconds: 1, costUSD: 0, counters: {}, family: "fixture", history: [], formState: {}, grounding: {}, judgeUsage: { calls: 1 }, judgeCostUSD: 0.001, picture: { granted: true } };
  const shard = [{ agent: { debuggerAvailable: false }, spentUSD: 0.01 }];
  const check = (task, r) => T.checkDry([{ ...base, ...r }], [{ id: "fx", dry: "failed", ...task }], shard);
  // Off: declined with no approver record is right; an approver answer is not.
  assert.deepEqual(check({}, { held: [{ kind: "send", allowed: false, by: "declined" }] }), []);
  assert.ok(check({}, { held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }] }).some((p) => /which was off/.test(p)));
  // On: every hold settled says how, a refused kind is never the approver's, and the stand-in answered as the fixture said.
  const on = { approverOn: true };
  assert.deepEqual(check({ dryApprove: false }, { ...on, held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }, { kind: "send", allowed: false, by: "declined", approver: { asks: false, skipped: true } }] }), []);
  assert.ok(check({}, { ...on, held: [{ kind: "send", allowed: false, by: "declined" }] }).some((p) => /nothing says why/.test(p)));
  assert.ok(check({}, { ...on, held: [{ kind: "pay", allowed: true, by: "approver", approver: { asks: true } }] }).some((p) => /a pay hold was put to the approver/.test(p)));
  assert.ok(check({ dryApprove: true }, { ...on, held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }] }).some((p) => /the fixture says yes/.test(p)));
  assert.ok(check({}, { ...on, held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: true } }] }).some((p) => /declined against the approver's answer/.test(p)));
  // The yes path and the refusal by kind, as a fixture asks for them.
  assert.ok(check({ dryApproved: 1 }, { ...on, held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }] }).some((p) => /expected at least 1/.test(p)));
  assert.deepEqual(check({ dryRefused: 1 }, { ...on, held: [{ kind: "delete", allowed: false, by: "declined", approver: { asks: false, refused: true } }] }), []);
  assert.ok(check({ dryRefused: 1 }, { ...on, approverCalls: 1, held: [{ kind: "delete", allowed: false, by: "declined", approver: { asks: false, refused: true } }] }).some((p) => /approver call\(s\) made/.test(p)));
  assert.ok(check({}, { picture: { granted: false, why: "refused" } }).some((p) => /would not give the agent a picture/.test(p)));
});

test("a dry leg runs the approver on its own fixtures: a yes, a no, and kinds declined with no call", () => {
  const file = path.join(ROOT, "tests/bench/fixture-approver-tasks.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(T.validateTasks(raw), []);
  const list = J.normaliseTasks(raw);
  // The fields reach the harness (normaliseTasks keeps them).
  const yes = list.find((t) => t.dryApprove === true && t.dryApproved >= 1);
  const no = list.find((t) => t.dryApprove === false);
  const kind = list.find((t) => t.dryRefused >= 1);
  assert.ok(yes && no && kind, "a yes, a no and a refusal by kind");
  assert.equal(yes.dry, "passed", "the yes path reaches the end of the task");
  assert.equal(kind.dryApprove, true, "a stand-in that would say yes is never asked");
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/real-tasks.yml"), "utf8");
  assert.match(y, /leg: approver, [^\n]*tasks: tests\/bench\/fixture-approver-tasks\.json[^\n]*check: approver, approver: "on" \}/);
  assert.match(y, /if \[ "\$LEG" = "approver" \]; then check="\$check --check-dry"; fi/);
  assert.match(y, /grep -q '\^\| with the simulated approver \|'/);
  // The leg check fails when the approver was off, or a path did not run.
  const rowsOff = [{ id: "a", success: true, held: [] }];
  const problems = T.checkLeg("approver", { rows: rowsOff, planned: [], shards: [{}], approver: null });
  assert.ok(problems.some((p) => /did not have the approver on/.test(p)) && problems.some((p) => /no line for the approver/.test(p)) && problems.some((p) => /no score with the approver/.test(p)));
  const rowsOn = [
    { id: "a", success: true, approverOn: true, held: [{ kind: "send", allowed: true, by: "approver", approver: { asks: true } }] },
    { id: "b", success: false, approverOn: true, held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }] },
    { id: "c", success: true, approverOn: true, held: [{ kind: "delete", allowed: false, by: "declined", approver: { asks: false, refused: true } }] },
  ];
  const planned = rowsOn.map((r) => ({ id: r.id, level: "fixture" }));
  assert.deepEqual(T.checkLeg("approver", { rows: rowsOn, planned, shards: [{ approver: { enabled: true }, summaryWithApprover: {} }], approver: T.approverSummary(rowsOn, planned) }), []);
});
