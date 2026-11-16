"use strict";
// The free cap and crowded models: the cap is said where the free path is
// picked, what is left is shown when the provider reports it, and a spent
// cap or a model that stays crowded holds the run so that it carries on
// (at the reset, on a backup, or when the user says so) with its work kept.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LLM = require("../../extension/core/llm.js");
const D = require("../../extension/defaults.js");
const LIMITS = require("../../extension/usageLimits.js");
const RUN = require("../../extension/core/run.js");
const { fakeWorker, settle } = require("../helpers/fake-worker.js");

const EXT = path.join(__dirname, "../../extension");
const HOUR = 3600000;

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = (name, args) => sse([{ model: "served-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }]);
const reply = (status, body, headers) => ({
  status, ok: status >= 200 && status < 300,
  headers: { forEach: (fn) => Object.entries(headers || {}).forEach(([k, v]) => fn(v, k)) },
  text: async () => body,
  body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(body) })) }; } },
});
const tool = { name: "step", description: "d", parameters: { type: "object", properties: { goal: { type: "string" } } } };
const free = (more) => ({ provider: "openrouter", apiKey: "sk-or-test", baseUrl: "https://openrouter.ai/api/v1", customUrl: "", model: "openrouter/free", liteModel: "openrouter/free", backup: "", keyProblem: "", promptCaching: true, ...more });
// A real clock time: providers give resets as epochs, and a small number would be read as seconds from now.
const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);
const client = (replies, seen, more) => LLM.createClient({
  fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); const r = replies.shift(); if (!r) throw new Error("no more replies"); return r; },
  sleep: async (ms) => { seen.push({ slept: ms }); }, now: () => NOW, log: () => {}, ...more,
});
/** OpenRouter's reply when the day's free requests are spent, as it sends it. */
const spent = (resetAt) => reply(429, JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", metadata: { headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAt) } } } }));
const crowded = () => reply(429, JSON.stringify({ error: { message: "Provider returned error: rate-limited upstream" } }));

const shop = () => ({
  url: "https://shop.example/", title: "Shop", scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Welcome to the shop", innerText: "Welcome to the shop. Blue Widget $19.00 In stock.",
  elements: [{ id: 3, tagName: "a", accName: "Blue Widget", url: "https://shop.example/p/blue-widget" }],
});
/** A run one step in, with a note written, about to ask for its second step. */
function oneStepIn(start) {
  let now = start || NOW;
  const page = shop();
  const at = (ms) => ({ now: (now += ms || 0), page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} });
  const run = RUN.newRun({ id: "r1", task: "find the blue widget's price", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now });
  RUN.advance(run, { type: "start" }, at());
  RUN.advance(run, { type: "observed", page }, at());
  RUN.advance(run, { type: "model_replied", reply: { memory: "Blue Widget is $19.", goal: "g", actions: [{ do: "click", ref: 3 }] }, usage: {} }, at(1000));
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Done.", pageChanged: true } }, at(1000));
  const fx = RUN.advance(run, { type: "observed", page }, at(1000));
  assert.equal(fx[0].type, "model");
  assert.equal(run.step, 2);
  return { run, page, at, clock: () => now };
}
/** The event the engine hands the run when a call fails, from the client's error. */
const failed = (e) => ({ type: "model_failed", purpose: "step", kind: e.kind, message: e.message, usage: e.usage || null, waitMs: e.waitMs || 0, ...(e.limit ? { limit: { kind: e.limit.kind, resetAt: e.limit.resetAt || 0, short: e.limit.short } } : {}) });

// ------------------------------------------------------------ said up front

test("the free daily cap is said where the free path is picked, from one figure", () => {
  const note = D.freeCapNote("openrouter");
  assert.match(note, /50 requests a day/);
  assert.match(note, /1,000 after adding \$10 of credit/);
  assert.ok(note.includes(String(D.FREE_CAPS.openrouter.daily)));
  assert.equal(D.freeCapNote("anthropic"), "", "no figure is made up for a provider without one on file");
  assert.doesNotMatch(note, /—/);
  // The welcome page shows it beside the button that picks the free path, and again once connected.
  const html = fs.readFileSync(path.join(EXT, "welcome.html"), "utf8");
  const js = fs.readFileSync(path.join(EXT, "welcome.js"), "utf8");
  assert.match(html, /id="connectOR"[^>]*>Continue with OpenRouter \(free\)<\/button>\s*<p class="fine">[^<]*<span id="freeCapNote"><\/span><\/p>/);
  assert.match(js, /\$\("freeCapNote"\)\.textContent = D\.freeCapNote\("openrouter"\)/);
  assert.match(js, /You're on OpenRouter's free models\. \$\{D\.freeCapNote\("openrouter"\)\}/);
});

// ------------------------------------------------------------ what is left

test("what is left of a key's requests is read from a reply's headers when they say so", () => {
  const day = NOW + 8 * HOUR;
  assert.deepEqual(LIMITS.readAllowance({ "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "37", "X-RateLimit-Reset": String(day) }, NOW), { remaining: 37, limit: 50, resetAt: day });
  // A day's count under its own name, with the reset as a span.
  assert.deepEqual(LIMITS.readAllowance({ "x-ratelimit-limit-requests-day": "14400", "x-ratelimit-remaining-requests-day": "14000", "x-ratelimit-reset-requests-day": "3h30m" }, NOW), { remaining: 14000, limit: 14400, resetAt: NOW + 3.5 * HOUR });
  assert.deepEqual(LIMITS.readAllowance({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "999", "x-ratelimit-reset-requests": "23h59m58.5s" }, NOW), { remaining: 999, limit: 1000, resetAt: NOW + 23 * HOUR + 59 * 60000 + 58500 });
  // A count that starts again within minutes is a pace, not an allowance to show.
  assert.equal(LIMITS.readAllowance({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-reset-requests": "120ms" }, NOW), null);
  assert.equal(LIMITS.readAllowance({ "x-ratelimit-limit": "20", "x-ratelimit-remaining": "19", "x-ratelimit-reset": "60" }, NOW), null);
  // Nothing said, or not said when it starts again: nothing shown.
  assert.equal(LIMITS.readAllowance({}, NOW), null);
  assert.equal(LIMITS.readAllowance({ "x-ratelimit-limit": "50", "x-ratelimit-remaining": "37" }, NOW), null);
  assert.equal(LIMITS.readAllowance({ "x-ratelimit-remaining": "37", "x-ratelimit-reset": String(day) }, NOW), null);
});

test("a call hands back what the provider said is left, and the pill words it", async () => {
  const day = NOW + 8 * HOUR;
  const seen = [];
  const out = await client([reply(200, toolCall("step", { goal: "go" }), { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "37", "x-ratelimit-reset": String(day) })], seen).call({ system: "s", user: "u", tool, tier: "pro" }, free());
  assert.deepEqual(out.left, { remaining: 37, limit: 50, resetAt: day });
  assert.equal(out.provider, "openrouter");
  const plain = await client([reply(200, toolCall("step", { goal: "go" }))], []).call({ system: "s", user: "u", tool, tier: "pro" }, free());
  assert.equal("left" in plain, false, "nothing is claimed when the provider says nothing");
  const label = D.allowanceLabel({ provider: "openrouter", ...out.left }, "openrouter", NOW);
  assert.equal(label.short, "37 left");
  assert.match(label.title, /^37 of 50 requests left/);
  // Another provider's count, or one whose day is over, is not shown.
  assert.equal(D.allowanceLabel({ provider: "openrouter", ...out.left }, "gemini", NOW), null);
  assert.equal(D.allowanceLabel({ provider: "openrouter", ...out.left }, "openrouter", day + 1), null);
  assert.equal(D.allowanceLabel(null, "openrouter", NOW), null);
});

// ------------------------------------------------------------- spent cap

test("a played 429 for a spent free cap holds the run until the reset, and it carries on from the same step", async () => {
  const resetAt = NOW + 8 * HOUR;
  const seen = [];
  const c = client([spent(resetAt), reply(200, toolCall("step", { goal: "go" }))], seen);
  const err = await c.call({ system: "s", user: "u", tool, tier: "pro" }, free()).catch((e) => e);
  assert.equal(err.kind, "limit");
  assert.equal(err.limit.kind, "free-daily");
  assert.equal(err.limit.resetAt, resetAt);
  assert.equal(seen.filter((x) => x.body).length, 1, "a spent day is not retried");

  const { run, page, at, clock } = oneStepIn();
  const journalBefore = run.journal.length;
  let fx = RUN.advance(run, failed(err), at(2000));
  assert.equal(run.outcome, null, "the run is not ended");
  assert.equal(run.status, "waiting");
  assert.equal(fx.length, 1);
  assert.equal(fx[0].type, "attention");
  assert.equal(run.wait.kind, "pause");
  assert.equal(run.wait.hold, "limit");
  assert.equal(run.wait.until, resetAt, "it wakes when the requests come back");
  assert.match(run.wait.question, /^Today's free OpenRouter requests are used up; they come back at .+\. Nothing is lost\. I will carry on from here by myself in about 8 hours, or sooner if you connect a backup or say to try again\.$/);
  assert.equal(run.step, 1, "the step that could not be asked for is not counted");
  assert.equal(run.memory, "Step 1: Blue Widget is $19.", "its notes are kept");
  assert.equal(run.history.length, 1, "and so is what it did");
  // The card the panel draws has the hold and the time on it; the trace says it is held.
  const card = run.journal.slice(journalBefore).find((j) => j.k === "ask").wait;
  assert.equal(card.hold, "limit");
  assert.equal(card.until, resetAt);
  assert.equal(RUN.trace(run).waitKind, "pause");
  assert.equal(RUN.trace(run).waitHold, "limit");
  // Through a worker restart it is still held.
  const saved = JSON.parse(JSON.stringify(RUN.toStored(run)));
  const again = RUN.advance(saved, { type: "resume" }, at(0));
  assert.equal(again[0].wait.hold, "limit");
  assert.equal(again[0].wait.until, resetAt);

  // The reset comes: the run looks at the page and asks for the same step again.
  fx = RUN.advance(run, { type: "pause_over", id: run.wait.id }, at(resetAt - clock()));
  assert.deepEqual(fx, [{ type: "observe" }]);
  assert.equal(run.status, "running");
  fx = RUN.advance(run, { type: "observed", page }, at(1000));
  assert.equal(fx[0].type, "model");
  assert.equal(run.step, 2);
  assert.match(fx[0].user, /Blue Widget is \$19\./, "the model is asked with what the run had found");
  const out = await c.call({ system: fx[0].system, user: fx[0].user, tool, tier: "pro" }, free());
  assert.deepEqual(out.reply, { goal: "go" });
  fx = RUN.advance(run, { type: "model_replied", purpose: "step", reply: { memory: "", goal: "g", actions: [{ do: "done", answer: "The Blue Widget is $19.", success: true }] }, usage: out.usage }, at(1000));
  assert.notEqual(run.status, "failed");
});

test("a spent cap with no time named waits for the user, who can try again or take what was found", () => {
  const { run, page, at } = oneStepIn();
  const noCredit = { kind: "limit", message: "**Your OpenAI account is out of credit.**", limit: { kind: "no-credit", resetAt: null, short: "Your OpenAI account is out of credit." } };
  RUN.advance(run, failed(noCredit), at(0));
  assert.equal(run.wait.hold, "limit");
  assert.equal(run.wait.until, undefined, "nothing wakes it by the clock");
  assert.match(run.wait.question, /^Your OpenAI account is out of credit\. Nothing is lost\. I will carry on from here when you connect a backup or say to try again\.$/);
  // An answer typed while held is kept for the next step; the run stays held.
  assert.deepEqual(RUN.advance(run, { type: "steer", text: "cheapest only" }, at(0)), []);
  assert.equal(run.status, "waiting");
  // Try again: on it goes, with the message.
  let fx = RUN.advance(run, { type: "pause_over", id: run.wait.id, by: "user" }, at(60000));
  assert.deepEqual(fx, [{ type: "observe" }]);
  fx = RUN.advance(run, { type: "observed", page }, at(0));
  assert.match(fx[0].user, /cheapest only/);
  // Still out of credit: held again, and this time the user stops with what it has.
  RUN.advance(run, failed(noCredit), at(0));
  assert.equal(run.wait.hold, "limit");
  fx = RUN.advance(run, { type: "wrap_up", id: run.wait.id }, at(0));
  assert.deepEqual(fx, [{ type: "end" }]);
  assert.equal(run.outcome.state, "limit");
  assert.match(run.outcome.text, /^\*\*Your OpenAI account is out of credit\.\*\*\n\nWhat I had found:\nStep 1: Blue Widget is \$19\./);
});

test("a reset time that has passed, or keeps being wrong, does not turn the hold into a loop", () => {
  const { run, page, at, clock } = oneStepIn();
  const limit = (resetAt) => ({ kind: "limit", message: "Out of requests.", limit: { kind: "daily", resetAt, short: "Out of requests." } });
  RUN.advance(run, failed(limit(clock() - 5000)), at(0));
  assert.equal(run.wait.until, clock() + 120000, "never sooner than two minutes");
  // The provider names a reset each time and refuses each time: after four, only the user carries it on.
  for (let i = 1; i < 4; i++) {
    RUN.advance(run, { type: "pause_over", id: run.wait.id }, at(120000));
    RUN.advance(run, { type: "observed", page }, at(0));
    RUN.advance(run, failed(limit(clock() + 1000)), at(0));
    assert.ok(run.wait.until > clock(), `hold ${i + 1} still has a time`);
  }
  RUN.advance(run, { type: "pause_over", id: run.wait.id }, at(120000));
  RUN.advance(run, { type: "observed", page }, at(0));
  RUN.advance(run, failed(limit(clock() + 1000)), at(0));
  assert.equal(run.wait.hold, "limit");
  assert.equal(run.wait.until, undefined);
  // Stop works on a held run as on any other, and gives what was found.
  RUN.advance(run, { type: "stop" }, at(0));
  assert.equal(run.status, "stopped");
  assert.match(run.outcome.text, /^Stopped\.\n\nWhat I had found:\nStep 1: Blue Widget is \$19\./);
});

test("with a backup chosen, a spent cap switches the same call to it and the run is never held", async () => {
  const seen = [];
  const backupCfg = { provider: "gemini", apiKey: "AIzaTest", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", customUrl: "", model: "gemini-flash-latest", liteModel: "gemini-flash-latest", backup: "", keyProblem: "", promptCaching: true };
  const switched = [];
  const c = client([spent(NOW + 8 * HOUR), reply(200, toolCall("step", { goal: "go" }))], seen, { onSwitch: async (from, to, until) => { switched.push({ from, to, until }); return backupCfg; } });
  const out = await c.call({ system: "s", user: "u", tool, tier: "pro" }, free({ backup: "gemini" }));
  assert.deepEqual(out.reply, { goal: "go" });
  assert.deepEqual(switched, [{ from: "openrouter", to: "gemini", until: NOW + 8 * HOUR }]);
  assert.match(seen.filter((x) => x.body)[1].url, /generativelanguage/);
});

// ----------------------------------------------------------- crowded model

test("played 429s from a crowded model pause the run, then hold it with the choices, and trying again starts fresh", async () => {
  const seen = [];
  const err = await client([crowded(), crowded(), crowded(), crowded()], seen).call({ system: "s", user: "u", tool, tier: "pro" }, free()).catch((e) => e);
  assert.equal(err.kind, "rate_limited");
  assert.equal(err.waitMs, 0);
  assert.equal(seen.filter((x) => x.body).length, 4);

  const { run, page, at } = oneStepIn();
  // Four waits by itself, each longer than the last.
  const waits = [];
  for (let i = 0; i < 4; i++) {
    RUN.advance(run, failed(err), at(0));
    assert.equal(run.wait.kind, "pause");
    assert.equal(run.wait.hold, undefined, "an ordinary pause, with its countdown");
    waits.push(run.wait.until - run.wait.since);
    RUN.advance(run, { type: "pause_over", id: run.wait.id }, at(waits[i]));
    RUN.advance(run, { type: "observed", page }, at(0));
  }
  assert.deepEqual(waits, [120000, 240000, 480000, 960000]);
  // Refused a fifth time: held, not ended.
  let fx = RUN.advance(run, failed(err), at(0));
  assert.equal(fx[0].type, "attention");
  assert.equal(run.outcome, null);
  assert.equal(run.wait.hold, "crowded");
  assert.equal(run.wait.until, undefined);
  assert.match(run.wait.question, /kept turning requests away as too many.*Nothing is lost\. I will carry on from here when you connect a backup or say to try again\./);
  assert.equal(run.memory, "Step 1: Blue Widget is $19.");
  // Try again: the run goes on, and a new refusal starts from the shortest wait.
  fx = RUN.advance(run, { type: "pause_over", id: run.wait.id, by: "user" }, at(5000));
  assert.deepEqual(fx, [{ type: "observe" }]);
  RUN.advance(run, { type: "observed", page }, at(0));
  RUN.advance(run, failed(err), at(0));
  assert.equal(run.wait.hold, undefined);
  assert.equal(run.wait.until - run.wait.since, 120000);
  // The provider answers: the run carries on from step 2 with everything it had.
  RUN.advance(run, { type: "pause_over", id: run.wait.id }, at(120000));
  fx = RUN.advance(run, { type: "observed", page }, at(0));
  assert.equal(run.step, 2);
  fx = RUN.advance(run, { type: "model_replied", purpose: "step", reply: { memory: "", goal: "g", actions: [{ do: "click", ref: 3 }] }, usage: {} }, at(0));
  assert.equal(fx[0].type, "act");
});

test("a wrap-up meant for a check-in or an ordinary pause does not end a run", () => {
  const { run, at } = oneStepIn();
  RUN.advance(run, { type: "model_failed", purpose: "step", kind: "rate_limited", waitMs: 180000, message: "Wait three minutes." }, at(0));
  assert.equal(run.wait.hold, undefined);
  assert.deepEqual(RUN.advance(run, { type: "wrap_up", id: run.wait.id }, at(0)), []);
  assert.equal(run.status, "waiting");
  // Nor does one for another wait's id end a hold.
  const held = oneStepIn();
  RUN.advance(held.run, { type: "model_failed", purpose: "step", kind: "limit", message: "Out." }, held.at(0));
  assert.deepEqual(RUN.advance(held.run, { type: "wrap_up", id: "someone-else" }, held.at(0)), []);
  assert.equal(held.run.status, "waiting");
});

// ---------------------------------------------------------------- the engine

/** A run held for a spent cap, as the worker finds it in session storage. */
function savedHeld(until) {
  // The worker goes by the real clock.
  const { run, at } = oneStepIn(Date.now());
  RUN.advance(run, { type: "model_failed", purpose: "step", kind: "limit", message: "Out of requests.", limit: { kind: "free-daily", resetAt: until || 0, short: "Today's free requests are used up." } }, at(0));
  run.tabId = 9;
  run.wait.tabId = 9;
  return { "agentSession:1": { turns: [], run: JSON.parse(JSON.stringify(RUN.toStored(run))), extras: {} } };
}
const waitingOn = (w) => { const s = w.engine.sessions.get(1); return s.run.status === "waiting" && s.run.wait ? s.run.wait : null; };
const carriedOn = (w) => w.engine.sessions.get(1).run.journal.some((j) => j.k === "ask_done" && j.how === "pause_over");

test("the worker wakes a held run at its reset by an alarm, and not at all when no time was named", async () => {
  const until = Date.now() + 8 * HOUR;
  const w = fakeWorker({ saved: savedHeld(until) });
  await w.connect(1).hello();
  await settle(40);
  assert.equal(waitingOn(w).hold, "limit");
  const alarm = w.calls.alarms.find((a) => a.name.startsWith("agentResume:1:"));
  assert.ok(alarm, "an alarm is set");
  assert.equal(alarm.info.when, until);
  assert.equal(carriedOn(w), false);
  await w.fire("alarms.onAlarm", { name: alarm.name });
  await settle(60);
  assert.equal(carriedOn(w), true, "the alarm carries the run on");

  const open = fakeWorker({ saved: savedHeld(0) });
  await open.connect(1).hello();
  await settle(40);
  assert.equal(waitingOn(open).hold, "limit");
  assert.equal(open.calls.alarms.filter((a) => a.name.startsWith("agentResume:")).length, 0);
  assert.equal(carriedOn(open), false, "and it is not carried on at once for want of a time");
});

test("a held run carries on when a backup is connected, when the user says try again, and ends when they say stop", async () => {
  // A backup connected in Settings.
  let w = fakeWorker({ saved: savedHeld(Date.now() + 8 * HOUR) });
  await w.connect(1).hello();
  await settle(40);
  await w.fire("storage.onChanged", { agentCrossSessionMemory: { newValue: [] } }, "local");
  await w.fire("storage.onChanged", { agentAllowance: { newValue: {} } }, "local");
  await settle(40);
  assert.equal(carriedOn(w), false, "a change that has nothing to do with the model leaves it held");
  await w.fire("storage.onChanged", { agentBackupProvider: { newValue: "gemini" } }, "sync");
  await settle(60);
  assert.equal(carriedOn(w), true);

  // Try again, from the card.
  w = fakeWorker({ saved: savedHeld(0) });
  let port = w.connect(1);
  await port.hello();
  await settle(40);
  await port.post({ type: "try_again", id: waitingOn(w).id });
  await settle(60);
  assert.equal(carriedOn(w), true);

  // Stop and answer with what it has.
  w = fakeWorker({ saved: savedHeld(0) });
  port = w.connect(1);
  await port.hello();
  await settle(40);
  await port.post({ type: "wrap_up", id: waitingOn(w).id });
  await settle(60);
  const run = w.engine.sessions.get(1).run;
  assert.equal(run.outcome.state, "limit");
  assert.match(run.outcome.text, /What I had found:\nStep 1: Blue Widget is \$19\./);
});

test("a hold with nobody looking is told by a notice, once", async () => {
  const w = fakeWorker({ notifications: true });
  const { run, at } = oneStepIn();
  const s = { windowId: 1, ports: new Set(), attending: new Map(), run };
  RUN.advance(run, { type: "model_failed", purpose: "step", kind: "limit", message: "Out.", limit: { kind: "free-daily", resetAt: 0, short: "Today's free requests are used up." } }, at(0));
  assert.equal(typeof w.engine.attention, "function");
  await w.engine.attention(s, run.wait, false);
  await settle(20);
  assert.equal(w.calls.notices.length, 1);
  assert.match(w.calls.notices[0].title, /Task on hold: usage limit reached/);
  assert.match(w.calls.notices[0].message, /Today's free requests are used up\. Nothing is lost\./);
  // Brought back after a worker restart: the user was told already.
  await w.engine.attention(s, run.wait, true);
  await settle(20);
  assert.equal(w.calls.notices.length, 1);
});

// ------------------------------------------------------------------ the page

test("the hold card offers a backup, trying again and stopping with what was found, and the pill shows what is left", () => {
  const agent = fs.readFileSync(path.join(EXT, "agent.js"), "utf8");
  assert.match(agent, /card\.dataset\.hold = wait\.hold/);
  assert.match(agent, /"hold-backup-btn [^"]+"/);
  assert.match(agent, /"hold-retry-btn [^"]+", \(\) => enginePost\(\{ type: "try_again", id: wait\.id \}\)/);
  assert.match(agent, /"Stop and answer with what you have", "hold-stop-btn [^"]+", \(\) => enginePost\(\{ type: "wrap_up", id: wait\.id \}\)/);
  assert.match(agent, /SELECT_TO_AI_DEFAULTS\.allowanceLabel\(allowance, config\.agentActiveProvider, Date\.now\(\)\)/);
  // The count changes with every call and must not reload the whole page's settings.
  assert.match(agent, /every\(\(k\) => k === "agentAllowance" \|\|/);
  // The benchmark's stand-in user ends a held run, so a spent plan is still reported as one.
  for (const f of ["run.js", "miniwob.js"]) assert.match(fs.readFileSync(path.join(__dirname, "../bench", f), "utf8"), /\.confirmation-bubble\[data-hold\] \.hold-stop-btn/);
});
