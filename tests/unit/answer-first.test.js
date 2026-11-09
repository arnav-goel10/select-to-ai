"use strict";
// The answer shown first and checked in the background (core/run.js), the
// pages an answer drew on, the saved log (core/runlog.js), the bench's
// reading of the final answer, and the check's tool call (core/llm.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const CONTEXT = require("../../extension/core/context.js");
const LOG = require("../../extension/core/runlog.js");
const LLM = require("../../extension/core/llm.js");
const J = require("../bench/judge.js");

const wiki = (extra) => ({
  url: "https://en.wikipedia.org/wiki/Main_Page", title: "Wikipedia, the free encyclopedia", scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Welcome to Wikipedia", innerText: "Welcome to Wikipedia, the free encyclopedia that anyone can edit. Today's featured article is about the Roman calendar reform.",
  elements: [{ id: 1, tagName: "input", inputType: "search", accName: "Search Wikipedia", role: "searchbox", formId: 0 }],
  forms: [{ id: 0, search: true, fields: 1 }],
  ...extra,
});
const decade = { url: "https://en.wikipedia.org/wiki/Decade", title: "Decade - Wikipedia", scrollY: 0, viewportHeight: 900, pageHeight: 900, visibleText: "Decade", innerText: "A decade is a period of ten years. Decades may describe any ten-year period.", elements: [] };
const env = (page, now, more) => ({ now, page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {}, ...more });
const begin = (task, page) => {
  const run = RUN.newRun({ id: "r1", task, tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1000 });
  RUN.advance(run, { type: "start" }, env(page, 1000));
  RUN.advance(run, { type: "observed", page }, env(page, 1100));
  return run;
};
const done = (run, page, now, answer, evidence) => RUN.advance(run, { type: "model_replied", reply: { goal: "Answer the question", actions: [{ do: "done", success: true, answer, evidence: evidence || [] }] }, usage: { prompt: 100, completion: 10, cost: 0, model: "m" }, ms: 900 }, env(page, now));
const verdict = (run, page, now, pass) => RUN.advance(run, { type: "model_replied", purpose: "verify", reply: { requirements: [{ need: "the answer", met: pass }], pass, reason: pass ? "Supported." : "The count is not shown." }, usage: { prompt: 50, completion: 5, cost: 0, model: "m" }, ms: 1500 }, env(page, now));
const entries = (run, k) => run.journal.filter((e) => e.k === k);

test("the answer is shown as soon as the model gives it, while the check runs; a pass makes it the final answer", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  const fx = done(run, page, 2000, "A decade is ten years.");
  assert.equal(fx[0].purpose, "verify", "the check still runs");
  const shown = entries(run, "provisional");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].text, "A decade is ten years.");
  assert.equal(shown[0].at, 2000);
  assert.equal(entries(run, "answer").length, 0, "nothing is final yet");
  let t = RUN.trace(run);
  assert.equal(t.answer, "", "the trace has no final answer while the check runs");
  assert.equal(t.checking, true);
  assert.equal(t.firstAnswerMs, 1000);
  assert.equal(run.status, "running");
  assert.deepEqual(verdict(run, page, 3500, true), [{ type: "end" }]);
  t = RUN.trace(run);
  assert.equal(t.answer, "A decade is ten years.");
  assert.equal(t.checking, false);
  assert.equal(t.validated, true);
  assert.equal(t.firstAnswerMs, 1000, "first shown at the done, not at the check");
  assert.equal(t.endedMs, 2500);
  const end = entries(run, "answer")[0];
  assert.equal(end.state, "success");
  assert.equal(end.verified, true);
  // The check's own lines are kept for the log, not drawn as steps.
  const check = run.journal.filter((e) => e.k === "log" && /Checking Answer|Check Passed/.test(e.title));
  assert.equal(check.length, 2);
  assert.ok(check.every((e) => e.quiet));
});

test("an answer the check sends back is marked replaced, the run works on exactly as before, and only the final answer ends it", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "Twelve years.");
  const fx = verdict(run, page, 2600, false);
  assert.deepEqual(fx, [{ type: "observe" }], "sent back, not ended");
  const back = entries(run, "provisional_replaced");
  assert.equal(back.length, 1);
  assert.match(back[0].why, /The count is not shown/);
  assert.equal(RUN.trace(run).checking, false);
  assert.equal(RUN.trace(run).answer, "");
  assert.match(run.history[0].actions[0].result, /Not finished yet\. A check of your answer/, "the model is told as before");
  // A failed check is something the user sees in the timeline.
  assert.ok(run.journal.some((e) => e.k === "log" && e.title === "Check Failed" && !e.quiet));
  RUN.advance(run, { type: "observed", page: decade }, env(decade, 3000));
  done(run, decade, 4000, "A decade is a period of ten years.", ["A decade is a period of ten years"]);
  assert.equal(entries(run, "provisional").length, 2, "the second answer is shown while checked too");
  verdict(run, decade, 5000, true);
  assert.equal(RUN.trace(run).answer, "A decade is a period of ten years.");
  assert.equal(RUN.trace(run).firstAnswerMs, 1000, "the first answer shown counts, even one later replaced");
  assert.equal(entries(run, "answer").length, 1);
});

test("an answer the check objects to twice ends unconfirmed, as today", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "Ten.");
  verdict(run, page, 2500, false);
  RUN.advance(run, { type: "observed", page }, env(page, 2600));
  done(run, page, 3000, "Ten.");
  assert.deepEqual(verdict(run, page, 3500, false), [{ type: "end" }]);
  assert.equal(run.outcome.state, "unconfirmed");
  assert.equal(RUN.trace(run).answer, "Ten.");
});

test("a run stopped while its answer is checked ends stopped, with the answer said to be unchecked", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "Ten.");
  RUN.advance(run, { type: "stop" }, env(page, 2300));
  const end = entries(run, "answer")[0];
  assert.equal(end.state, "idle");
  assert.equal(end.provisionalUnchecked, true);
  assert.notEqual(RUN.trace(run).answer, "Ten.", "the unchecked answer is not the run's answer");
});

test("a check cut off by the browser pausing the run takes the shown answer back", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "Ten.");
  RUN.advance(run, { type: "resume" }, env(page, 9000));
  assert.equal(entries(run, "provisional_replaced").length, 1);
  assert.equal(RUN.trace(run).checking, false);
});

test("with checking off, the answer is final at once and nothing provisional is shown", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  const fx = RUN.advance(run, { type: "model_replied", reply: { goal: "g", actions: [{ do: "done", success: true, answer: "Ten.", evidence: [] }] }, usage: {} }, { ...env(page, 2000), settings: { verify: false } });
  assert.deepEqual(fx, [{ type: "end" }]);
  assert.equal(entries(run, "provisional").length, 0);
  assert.equal(RUN.trace(run).firstAnswerMs, 1000);
});

test("pages used: none for an answer with no evidence and no browsing, even on the tab the run began on", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "A decade is ten years.");
  verdict(run, page, 2500, true);
  assert.deepEqual(run.outcome.sources, []);
  assert.deepEqual(entries(run, "answer")[0].sources, []);
});

test("pages used: the page holding an evidence quote, the start page included", () => {
  const page = wiki();
  const run = begin("what is today's featured article about?", page);
  done(run, page, 2000, "It is about the Roman calendar reform.", ["Today's featured article is about the Roman calendar reform"]);
  verdict(run, page, 2500, true);
  assert.deepEqual(run.outcome.sources.map((s) => s.url), ["https://en.wikipedia.org/wiki/Main_Page"]);
});

test("pages used: a page the run read that the answer repeats, but not one it only passed through", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  // A step that leaves the start page: search, then the article.
  RUN.advance(run, { type: "model_replied", reply: { goal: "Search", actions: [{ do: "navigate", url: "https://en.wikipedia.org/wiki/Decade" }] }, usage: {} }, env(page, 1500));
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Opened." } }, env(page, 1600));
  RUN.advance(run, { type: "observed", page: decade }, env(decade, 1700));
  done(run, decade, 2000, "A decade is a period of ten years, by definition.");
  verdict(run, decade, 2500, true);
  const urls = run.outcome.sources.map((s) => s.url);
  assert.deepEqual(urls, ["https://en.wikipedia.org/wiki/Decade"], "the article the answer repeats; not the start page it only left");
});

test("the trace's model calls say what each was for, and how long it took", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "Ten.");
  verdict(run, page, 2500, true);
  const calls = RUN.trace(run).modelCalls;
  assert.deepEqual(calls.map((c) => [c.purpose, c.ms, c.ok]), [["step", 900, true], ["verify", 1500, true]]);
});

test("the saved log has the request, steps, checks, the shown and final answers, timings and model calls, with nothing quiet left out", () => {
  const page = wiki();
  const run = begin("how many years in a decade?", page);
  done(run, page, 2000, "Twelve.");
  verdict(run, page, 2400, false);
  run.journal.push({ k: "log", role: "system", title: "Reply Without Action", text: "The model answered without calling verdict. Asking again (1/2).", quiet: true, at: 2450 });
  RUN.advance(run, { type: "observed", page: decade }, env(decade, 2600));
  done(run, decade, 3000, "A decade is a period of ten years.", ["A decade is a period of ten years"]);
  verdict(run, decade, 3600, true);
  const md = LOG.toMarkdown({ trace: RUN.trace(run), journal: run.journal });
  assert.match(md, /^# Select to AI - task log/);
  assert.match(md, /\*\*Request:\*\* how many years in a decade\?/);
  assert.match(md, /\*\*Ended:\*\* Done, checked/);
  assert.match(md, /### Step 1/);
  assert.match(md, /### Step 2/);
  assert.match(md, /Goal: Answer the question/);
  assert.match(md, /Answer shown while being checked \(check 1\)/);
  assert.match(md, /> Twelve\./);
  assert.match(md, /That answer was sent back: The count is not shown/);
  assert.match(md, /Check: \*\*Check Failed\*\*/);
  assert.match(md, /\*\*Check Passed\*\*.*\(not shown in the timeline\)/);
  assert.match(md, /\*\*Reply Without Action\*\*.*\(not shown in the timeline\)/);
  assert.match(md, /## Final answer\n\nHow it ended: Done \(the check passed\)\.\n\n> A decade is a period of ten years\./);
  assert.match(md, /Pages used: https:\/\/en\.wikipedia\.org\/wiki\/Decade/);
  assert.match(md, /first answer shown after 1\.0 s/);
  assert.match(md, /## Model calls/);
  assert.match(md, /\| 2 \| 1 \| answer check \| main \| m \| 1\.5 s \|/);
  assert.match(md, /## Actions/);
  assert.match(md, /_\(\+1\.0 s\)_/, "entries carry their time from the start");
});

test("the saved log keeps values masked as the run shows them", () => {
  const md = LOG.toMarkdown({
    trace: { task: "sign me up", steps: 1, history: [{ step: 1, ok: true, action: 'fill [3] with "••••••"', goal: "Fill the form", outcome: "Filled." }] },
    journal: [{ k: "log", role: "executor", title: "Step 1", text: "Fill the form", at: 1 }, { k: "log", role: "executor", title: "Action", text: 'fill [3] with "••••••"', at: 2 }],
  });
  assert.match(md, /••••••/);
});

test("the bench judges the final answer from the trace, never one shown while being checked", () => {
  assert.equal(J.finalAnswer({ stopState: "success", answer: "Ten years." }, "Twelve years."), "Ten years.");
  assert.equal(J.finalAnswer({ stopState: "", checking: true, answer: "" }, "Twelve years."), "", "a run still checking has no answer yet");
  assert.equal(J.finalAnswer(null, "Shown."), "Shown.", "no trace at all: what the panel shows");
  assert.equal(J.finalAnswer({ stopState: "error", answer: "" }, "Couldn't reach the provider."), "Couldn't reach the provider.");
});

// ---- the check's tool call ----

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const reply = (body) => ({ status: 200, ok: true, headers: { forEach: () => {} }, text: async () => body, body: { getReader: () => { let d = false; return { read: async () => (d ? { done: true } : ((d = true), { done: false, value: new TextEncoder().encode(body) })) }; } } });
const cfg = { provider: "mistral", apiKey: "mk-test", baseUrl: "https://api.mistral.ai/v1", customUrl: "", model: "ministral-8b-latest", liteModel: "ministral-8b-latest", backup: "", keyProblem: "", promptCaching: true };

test("the check's verdict call is asked like a step: offered, offered again with what was missing, forced, then as written JSON", async () => {
  const seen = [];
  const logs = [];
  const prose = sse([{ choices: [{ delta: { content: "Requirements: 1. the number of years. Met." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  const json = sse([{ choices: [{ delta: { content: '{"requirements":[{"need":"years","met":true}],"pass":true,"reason":"ok","speaks_to_ai":false}' } }] }]);
  const replies = [reply(prose), reply(prose), reply(prose), reply(json)];
  const client = LLM.createClient({ fetch: async (url, init) => { seen.push(JSON.parse(init.body)); return replies.shift(); }, sleep: async () => {}, now: () => 1, log: (title, text, o) => logs.push({ title, quiet: !!(o && o.quiet) }) });
  const out = await client.call({ system: CONTEXT.VERIFIER, user: "u", tool: CONTEXT.VERDICT_TOOL, tier: "pro", effort: "default" }, cfg);
  assert.equal(CONTEXT.readVerdict(out.reply).pass, true);
  assert.equal(seen[0].tool_choice, "auto");
  assert.equal(seen[1].tool_choice, "auto");
  assert.match(seen[1].messages[1].content, /did not call the verdict tool/);
  assert.equal(seen[2].tool_choice.function.name, "verdict");
  assert.equal(seen[3].tools, undefined);
  assert.ok(logs.length && logs.every((l) => l.quiet), "the re-asks are kept out of the timeline");
});

test("the check is told to put its whole judgment in the verdict tool, not to write it out first", () => {
  assert.match(CONTEXT.VERIFIER, /You reply with one call to the verdict tool and write nothing else/);
  assert.doesNotMatch(CONTEXT.VERIFIER, /^List what the request asks for/m, "an instruction to list in prose drew prose replies");
  assert.doesNotMatch(CONTEXT.VERIFIER, /^Also say whether/m);
  const run = RUN.newRun({ id: "r", task: "t", marker: "PAGE-abcd1234" });
  const m = CONTEXT.verifierMessages(run, { answer: "a", success: true }, [], null, 0, {});
  assert.match(m.user, /Reply with one call to the verdict tool\.$/);
});
