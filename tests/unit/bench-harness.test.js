"use strict";
// Three faults of the Online-Mind2Web trial harness (tests/bench/run.js):
// the page text kept for the judge, the start from the toolbar that gives
// the agent a picture of the page, and the simulated approver at a held step.
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

// ---- 1. Every state of a page, not one text per address

test("a page that changes without its address changing keeps each state, in order", () => {
  const url = "https://www.index.example/constituents";
  const states = [];
  T.keepPageState(states, { url, title: "Constituents", text: "Page 1 of 3: Alpha 10.5, Beta 9.1" });
  T.keepPageState(states, { url, title: "Constituents", text: "Page 2 of 3: Gamma 8.2, Delta 7.7" });
  T.keepPageState(states, { url, title: "Constituents", text: "Page 3 of 3: Epsilon 6.0" });
  assert.deepEqual(states.map((p) => p.text.slice(0, 6)), ["Page 1", "Page 2", "Page 3"]);
  // The same state seen again is kept once, as the newest.
  T.keepPageState(states, { url, title: "Constituents", text: "Page  1 of 3:\nAlpha 10.5, Beta 9.1" });
  assert.deepEqual(states.map((p) => p.text.replace(/\s+/g, " ").slice(0, 6)), ["Page 2", "Page 3", "Page 1"]);
  // Another address is a state of its own too.
  T.keepPageState(states, { url: "https://www.index.example/about", title: "About", text: "About us" });
  assert.equal(states.length, 4);
});

test("the states are bounded in number and in characters, the oldest going first", () => {
  const states = [];
  for (let i = 0; i < 50; i++) T.keepPageState(states, { url: "https://a.example/", title: "", text: `state ${i}` }, { most: 5, chars: 1e6 });
  assert.deepEqual(states.map((p) => p.text), ["state 45", "state 46", "state 47", "state 48", "state 49"]);
  const big = [];
  for (let i = 0; i < 10; i++) T.keepPageState(big, { url: "https://a.example/", title: "", text: `${i}`.repeat(1000) }, { most: 100, chars: 3500 });
  assert.equal(big.length, 3);
  assert.equal(big[0].text[0], "7");
  assert.ok(T.PAGE_STATES.most >= 20 && T.PAGE_STATES.chars <= 600000, "a sane cap");
});

test("run.js keeps page states, not one text per address", () => {
  const src = RUN_SRC();
  assert.match(src, /TRIAL\.keepPageState\(pageStates, seen\)/);
  assert.ok(!/seenPages\.delete\(seen\.url\)/.test(src), "no map keyed by address");
  assert.match(src, /pages: pageStates,/);
});

test("the judge is shown every earlier state at one address, oldest first, and not the final one again", () => {
  const url = "https://www.index.example/constituents";
  const msg = J.judgeMessage({
    task: "List every constituent of the index with its weight", startUrl: "https://www.index.example/", ending: "finished",
    answer: "Alpha 10.5, Beta 9.1, Gamma 8.2, Delta 7.7, Epsilon 6.0", history: [],
    finalUrl: url, finalTitle: "Constituents", finalText: "Page 3 of 3: Epsilon 6.0",
    pages: [
      { url, title: "Constituents", text: "Page 1 of 3: Alpha 10.5, Beta 9.1" },
      { url, title: "Constituents", text: "Page 2 of 3: Gamma 8.2, Delta 7.7" },
      { url, title: "Constituents", text: "Page 3 of 3: Epsilon 6.0" },
    ],
    screenshots: [],
  });
  const one = msg.indexOf("Alpha 10.5, Beta 9.1\n");
  const two = msg.indexOf("Gamma 8.2, Delta 7.7\n");
  assert.ok(one > 0 && two > one, "both earlier states are there, oldest first");
  assert.match(msg, /\(state 1 of 2 at this address\)/);
  assert.match(msg, /\(state 2 of 2 at this address\)/);
  assert.equal((msg.match(/Page 3 of 3/g) || []).length, 1, "the final page is shown once, as the final page");
});

test("past the number of states the judge is shown, the newest are shown and the rest are said to be left out", () => {
  const pages = Array.from({ length: J.EARLIER_STATES_SHOWN + 3 }, (_, i) => ({ url: `https://a.example/p${i}`, title: `P${i}`, text: `text of page ${i}` }));
  const msg = J.judgeMessage({ task: "t", startUrl: "https://a.example/", ending: "finished", answer: "a", history: [], finalUrl: "https://a.example/final", finalText: "final", pages, screenshots: [] });
  assert.ok(!msg.includes("text of page 2\n") && msg.includes("text of page 3\n") && msg.includes(`text of page ${J.EARLIER_STATES_SHOWN + 2}\n`));
  assert.match(msg, /the 3 oldest state\(s\) are left out here/);
  assert.ok(msg.indexOf("text of page 3\n") < msg.indexOf("text of page 4\n"), "in order");
});

// ---- 2. Started from the toolbar, so the browser gives the agent a picture

test("run.js starts each run from the toolbar on the page and asks the browser whether a picture can be had", () => {
  const src = RUN_SRC();
  assert.match(src, /pipe: true,/);
  assert.match(src, /"--enable-unsafe-extension-debugging"/);
  assert.match(src, /page\.triggerExtensionAction\(ext\)/);
  // The press comes before the agent's own window is opened, and the probe before the run starts.
  assert.ok(src.indexOf("await openFromToolbar(browser, extensionId, target)") < src.indexOf('Target.createTarget", { url: "about:blank", newWindow: true }'));
  assert.ok(src.indexOf("pictureRefusalInWorker, tabId") < src.indexOf("agent.html?task="));
  // The loaded copy still adds no permission the shipped build lacks for this.
  assert.ok(!/<all_urls>/.test(src.slice(src.indexOf("manifest.host_permissions"), src.indexOf("manifest.host_permissions") + 200)));
  assert.match(fs.readFileSync(path.join(ROOT, "tests/bench/trial.js"), "utf8"), /would not give the agent a picture of the page/);
});

// ---- 3. The simulated approver

test("the approver is asked about the task and the held step only, and its reply is read", () => {
  const msg = A.approverMessage("Add the blue sofa to my cart", "This commits you to something.\nButton: Add to cart");
  assert.match(msg, /Add the blue sofa to my cart/);
  assert.match(msg, /Button: Add to cart/);
  assert.match(A.APPROVER_SYSTEM, /does the task as written ask for this step\?/);
  assert.match(A.APPROVER_SYSTEM, /Never yes for a step that pays/);
  assert.ok(!/—/.test(A.APPROVER_SYSTEM));
  assert.deepEqual(A.parseApproval('Sure. {"asks": true, "reason": "The task says to add it to the cart."}'), { asks: true, reason: "The task says to add it to the cart." });
  assert.deepEqual(A.parseApproval('{"asks": false, "reason": "Not asked."}'), { asks: false, reason: "Not asked." });
  assert.equal(A.parseApproval("yes"), null);
  assert.equal(A.parseApproval('{"approve": true}'), null);
});

test("the approver is on the judge's endpoint with the judge's key, cheap on Anthropic, and can be turned off", () => {
  const judge = { url: "https://api.anthropic.com/v1/messages", key: "k", model: "claude-sonnet-5-5", isAnthropic: true };
  const c = A.approverConfig(judge, {});
  assert.equal(c.enabled, true);
  assert.equal(c.model, "claude-haiku-5-5");
  assert.equal(c.url, judge.url);
  assert.equal(c.key, "k");
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER: "off" }).enabled, false);
  assert.equal(A.approverConfig(judge, { BENCH_APPROVER_MODEL: "claude-x" }).model, "claude-x");
  assert.equal(A.approverConfig({ ...judge, url: "https://integrate.api.nvidia.com/v1", isAnthropic: false, model: "m" }, {}).model, "m");
  // Its most possible cost is kept back from each run's own budget.
  const one = A.approverCallMaxUSD(c, findModelRates);
  assert.ok(one > 0 && one < 0.01, `one call at most ${one}`);
  assert.ok(Math.abs(A.approverRoomUSD(c, findModelRates) - c.maxCalls * one) < 1e-12);
  assert.equal(A.approverRoomUSD({ ...c, enabled: false }, findModelRates), 0);
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

/** A minimal page with one hold card, for the functions that run in the agent's page. */
function fakeCard(kind) {
  const clicked = [];
  const node = (text, extra = {}) => ({ textContent: text, dataset: {}, ...extra });
  const buttons = { ".confirm-risk-btn": { click: () => clicked.push("allow") }, ".abort-risk-btn": { click: () => clicked.push("decline") } };
  const card = {
    dataset: { riskKind: kind },
    innerText: "Allow this step? This sends or submits something on your behalf. Allow this step Don't do this",
    querySelector: (sel) => (sel === ".confirm-text" ? node("This sends or submits something on your behalf.") : buttons[sel] || null),
    querySelectorAll: (sel) => (sel === ".confirm-detail-row" ? [node("Submit order details", { dataset: { label: "Button" } })] : []),
  };
  return { document: { querySelector: (sel) => (sel === ".confirmation-bubble.risk" ? card : null) }, clicked };
}

test("in the page: a kind on the allow list is allowed at once, any other waits for the approver with its description", () => {
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
    assert.deepEqual(page.clicked, [], "nothing is pressed before the approver answers");
    assert.equal(A.answerHoldInPage(true), true);
    assert.equal(A.answerHoldInPage(false), true);
    assert.deepEqual(page.clicked, ["allow", "decline"]);
    global.document = { querySelector: () => null };
    assert.equal(A.holdCardInPage(["site"]), null);
  } finally { global.document = was; }
});

test("run.js puts every other hold to the approver and records its answer", () => {
  const src = RUN_SRC();
  assert.match(src, /agentPage\.evaluate\(APPROVAL\.holdCardInPage, \[\.\.\.ALLOW\]\)/);
  assert.match(src, /hooks\.approve \? await hooks\.approve\(\{ task: task\.task, step: card\.step \|\| card\.text \}\)/);
  assert.match(src, /by: answer && !answer\.skipped \? "approver" : "declined"/);
  assert.match(src, /approver: \{ asks: !!answer\.asks, reason:/);
  assert.ok(!/const ok = allow\.includes\(kind\);/.test(src), "no longer declined by kind alone");
});

const row = (over) => ({ id: "x", success: false, ending: "finished", held: [], ...over });

test("one run gives both scores: with the approver, and every hold declined", () => {
  const rows = [
    row({ success: true, held: [{ kind: "decide", allowed: true, by: "approver", approver: { asks: true } }], approverUSD: 0.001 }),
    row({ success: true }),
    row({ held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }], ending: "stopped at a confirmation (send)" }),
    row({ success: false, blocked: true }),
    row({ success: true, held: [{ kind: "site", allowed: true, by: "allow list" }] }),
  ];
  assert.equal(O.outcomeAllDeclined(rows[0]), "declined");
  assert.equal(O.outcomeAllDeclined(rows[4]), "passed", "a hold allowed by the allow list is not the approver's");
  assert.equal(A.approvedHold(rows[0]), true);
  assert.equal(A.approvedHold(rows[2]), false);
  const c = O.countsOf(rows);
  assert.equal(c.outcomes.passed, 3);
  assert.equal(c.outcomesAllDeclined.passed, 2);
  assert.equal(c.outcomesAllDeclined.declined, 2);
  assert.deepEqual(c.holds, { asked: 2, approved: 1, declined: 1, runsApproved: 1 });
  assert.ok(Math.abs(c.approverUSD - 0.001) < 1e-12);
  const r = O.report(O.mergeCounts([c]), { planned: 5 });
  assert.equal(r.strictRate, 3 / 5);
  assert.equal(r.allDeclined.strictRate, 2 / 5);
  assert.equal(r.scoredRate, 3 / 4);
  assert.equal(r.allDeclined.scoredRate, 2 / 4);
  assert.ok(Math.abs(r.spendUSD - 0.001) < 1e-12, "the approver's spend is in the total");
  const md = O.reportMarkdown(r, { part: "dev" });
  assert.match(md, /\| with the simulated approver \| 3 \| 1 \| 60\.0% \| 75\.0% \|/);
  assert.match(md, /\| every hold declined \| 2 \| 2 \| 40\.0% \| 50\.0% \|/);
  assert.match(md, /Held steps put to the approver: 2, of which 1 approved and 1 declined; 1 run\(s\) had a hold approved/);
  // A counts file from before the approver: every hold was declined there, so its two scores are the same.
  const old = { ...O.emptyCounts(), runs: 1, outcomes: { ...O.emptyCounts().outcomes, passed: 1 } };
  delete old.outcomesAllDeclined;
  delete old.holds;
  assert.equal(O.mergeCounts([old]).outcomesAllDeclined.passed, 1);
});

test("the approver's spend counts in what a row cost, so it counts under the cap", () => {
  assert.ok(Math.abs(T.spendOf({ costUSD: 0.01, approverUSD: 0.002, judgeCostUSD: 0.003 }) - 0.015) < 1e-12);
  const src = RUN_SRC();
  assert.match(src, /spent \+= \(run\.costUSD \|\| 0\) \+ \(run\.approverUSD \|\| 0\)/);
  assert.match(src, /approverUSD: live\.approverUSD \|\| 0,/);
});

test("the dry check wants a picture and an approver answer for every hold the allow list did not decide", () => {
  const task = { id: "fx", dry: "failed" };
  const base = { id: "fx", success: false, ending: "finished", steps: 1, seconds: 1, costUSD: 0, counters: {}, family: "fixture", history: [], formState: {}, grounding: {}, judgeUsage: { calls: 1 }, judgeCostUSD: 0.001 };
  const shard = [{ agent: { debuggerAvailable: false }, spentUSD: 0.01 }];
  const ok = T.checkDry([{ ...base, picture: { granted: true }, held: [{ kind: "send", allowed: false, by: "approver", approver: { asks: false } }] }], [task], shard);
  assert.ok(!ok.some((p) => /picture|approver/.test(p)), ok.join("; "));
  const bad = T.checkDry([{ ...base, picture: { granted: false, why: "refused" }, held: [{ kind: "send", allowed: false, by: "declined" }] }], [task], shard);
  assert.ok(bad.some((p) => /would not give the agent a picture/.test(p)));
  assert.ok(bad.some((p) => /no recorded answer from the approver/.test(p)));
});
