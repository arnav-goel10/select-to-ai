"use strict";
// A step as the run's conversation (context.js stepTurns, llm.js): the
// instructions, then the history as turns that only grow, then the page as
// it is now. What a provider caches is the start of the prompt, so the
// test that matters is that each step's prompt begins with the one before.
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const CONTEXT = require("../../extension/core/context.js");
const LLM = require("../../extension/core/llm.js");
const JUDGE = require("../helpers/fake-judge.js");
const advance = JUDGE.judging(RUN);

const page = (n, extra) => ({
  url: `https://shop.example/p/${n}`, title: `Item ${n}`, scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: `Item ${n} page`, innerText: `Item ${n} costs $${n}.00. Only on page ${n}: secret-${n}.`,
  elements: [
    { id: 1, tagName: "a", accName: `Next item after ${n}`, url: `https://shop.example/p/${n + 1}` },
    { id: 2, tagName: "input", inputType: "search", accName: "Search products", role: "searchbox", formId: 0 },
  ],
  forms: [{ id: 0, search: true, fields: 1 }],
  ...extra,
});
const env = (p) => ({ now: 1000, page: p, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} });

/** A run walked through `steps` pages by clicking Next, with the step effect of each. */
function walk(steps) {
  const run = RUN.newRun({ id: "r", task: "add up the prices", tabId: 7, startUrl: page(1).url, marker: "PAGE-abcd1234", now: 1 });
  advance(run, { type: "start" }, env(page(1)));
  const asked = [advance(run, { type: "observed", page: page(1) }, env(page(1)))[0]];
  for (let n = 1; n < steps; n++) {
    advance(run, { type: "model_replied", reply: { note: `Item ${n}: $${n}`, goal: `Open item ${n + 1}`, do: "click", ref: 1 }, usage: { prompt: 100, completion: 10, cost: 0, model: "m" } }, env(page(n)));
    advance(run, { type: "acted", result: { ok: true, message: `Done. Now at https://shop.example/p/${n + 1}`, pageChanged: true } }, env(page(n + 1)));
    asked.push(advance(run, { type: "observed", page: page(n + 1) }, env(page(n + 1)))[0]);
  }
  return { run, asked };
}

const ANTHROPIC = { provider: "anthropic", apiKey: "sk-ant-x", baseUrl: "https://api.anthropic.com/v1/messages", customUrl: "", promptCaching: true };
const OPENAI = { provider: "openai", apiKey: "sk-x", baseUrl: "https://api.openai.com/v1", customUrl: "", promptCaching: true };
const OPENROUTER = { provider: "openrouter", apiKey: "sk-or-x", baseUrl: "https://openrouter.ai/api/v1", customUrl: "", promptCaching: true };
const bodyOf = (fx, cfg, model) => LLM.buildRequest({ system: fx.system, user: fx.last, turns: fx.turns, tool: fx.tool, effort: fx.effort }, cfg, model, { maxTokens: 4000 }).body;
const unmarked = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === "cache_control" ? undefined : v)));
const marks = (body) => (JSON.stringify(body).match(/"cache_control"/g) || []).length;

test("each step's turns begin with the step before's, word for word: the history only grows", () => {
  const { asked } = walk(6);
  for (let i = 1; i < asked.length; i++) {
    const before = asked[i - 1].turns;
    const now = asked[i].turns;
    assert.ok(now.length > before.length, `step ${i + 1} has more turns`);
    // Every earlier turn is the same, and the last earlier one has only gained parts at its end.
    assert.deepEqual(now.slice(0, before.length - 1), before.slice(0, -1));
    const was = before[before.length - 1];
    assert.deepEqual(now[before.length - 1].parts.slice(0, was.parts.length), was.parts);
  }
});

test("Anthropic: the request of each step starts with every block of the step before, up to its current page", () => {
  const { asked } = walk(6);
  const flat = (body) => body.messages.flatMap((m, i) => m.content.map((c) => JSON.stringify([m.role, unmarked(c)])).map((c) => `${i}:${c}`));
  for (let i = 1; i < asked.length; i++) {
    const a = bodyOf(asked[i - 1], ANTHROPIC, "claude-haiku-5-5");
    const b = bodyOf(asked[i], ANTHROPIC, "claude-haiku-5-5");
    assert.deepEqual(unmarked(b.system), unmarked(a.system));
    assert.deepEqual(b.tools, a.tools);
    const kept = flat(a).slice(0, -1); // all but the current text
    assert.deepEqual(flat(b).slice(0, kept.length), kept, `step ${i + 1} begins with step ${i}`);
  }
});

test("Anthropic: one mark on the system text and one on the turns' last block, never on the current page", () => {
  const { asked } = walk(5);
  for (const fx of asked) {
    const body = bodyOf(fx, ANTHROPIC, "claude-haiku-5-5");
    assert.equal(marks(body), 2, "two of the four breakpoints a request may have");
    const end = body.messages[body.messages.length - 1].content;
    assert.equal(end[end.length - 1].cache_control, undefined, "the current page is not cached: the next step shows it in short");
    assert.deepEqual(end[end.length - 2].cache_control, { type: "ephemeral" });
    assert.match(end[end.length - 1].text, /----- PAGE-abcd1234 begins -----/);
  }
  // Turned off, nothing is marked.
  assert.equal(marks(bodyOf(asked[3], { ...ANTHROPIC, promptCaching: false }, "claude-haiku-5-5")), 0);
});

test("Anthropic: each earlier call is the model's own tool call, answered by its result", () => {
  const { asked } = walk(3);
  const body = bodyOf(asked[2], ANTHROPIC, "claude-haiku-5-5");
  const roles = body.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant", "user"]);
  const call = body.messages[1].content[0];
  assert.equal(call.type, "tool_use");
  assert.deepEqual(call.input, { note: "Item 1: $1", goal: "Open item 2", do: "click", ref: 1 });
  const result = body.messages[2].content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, call.id);
  assert.match(result.content, /Now at https:\/\/shop\.example\/p\/2/);
});

test("an earlier page is shown in short, and only the current page is shown in full", () => {
  const { asked } = walk(4);
  const fx = asked[3];
  const turnsText = fx.turns.map((t) => (t.parts || []).map((p) => p.text || p.result).join("\n")).join("\n");
  // An earlier page is its address and an excerpt between the markers, never its listing.
  assert.doesNotMatch(turnsText, /Current page:|Controls:|\[1\] a /, "no earlier page's view is in the turns");
  assert.match(turnsText, /Before this step you were shown https:\/\/shop\.example\/p\/1\. That view is no longer shown in full\.\]\n----- PAGE-abcd1234 begins -----\nAn excerpt of that page: Item 1: Item 1 costs \$1\.00\. Only on page 1: secret-1\.\n----- PAGE-abcd1234 ends -----/);
  assert.match(fx.last, /secret-4/);
  // Earlier pages are in their own steps' turns, so the current view does not excerpt them again.
  assert.doesNotMatch(fx.last, /secret-[123]|Current page: Item [123]|Next item after [123]/);
  assert.doesNotMatch(fx.last, /Pages you were on earlier/);
  assert.match(fx.user, /Pages you were on earlier in this run \(excerpts\)/, "the one message still has them");
  // The facts that hold for the whole run are said once, before the first step.
  assert.match(turnsText, /Facts from the browser that hold for the whole run:\n- The user was on shop\.example when they asked\./);
  assert.doesNotMatch(fx.last, /An address opens without asking the user/);
  assert.match(fx.user, /An address opens without asking the user/);
  assert.doesNotMatch(fx.last, /What you have done so far/, "the history is in the turns, not in the last one");
  assert.match(fx.last, /Your notes:\n/);
  assert.match(fx.last, /This is step 4\./);
  // The one message keeps everything, as before.
  assert.match(fx.user, /What you have done so far:\n1\. Open item 2/);
});

test("the facts in the conversation do not say the history is shortened, since its turns are all there", () => {
  const { asked } = walk(23);
  const fx = asked[asked.length - 1];
  assert.match(fx.user, /The first 2 steps are shown in short/);
  assert.doesNotMatch(fx.last, /shown in short/);
  assert.equal(fx.turns.filter((t) => t.role === "assistant").length, 22, "every step is a turn");
});

test("a step the run took by itself is told in the user's turn, not as a call the model made", () => {
  const run = { task: "t", marker: "PAGE-abcd1234", history: [{ step: 1, goal: "Open the address it was given", actions: [{ text: "navigate https://a.example/", ok: true, result: "Opened." }], url: "about:blank" }] };
  const turns = CONTEXT.stepTurns(run, "head");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, "user");
  assert.match(turns[0].parts[1].text, /The browser took this step itself, not you: Open the address it was given/);
});

test("chat completions: calls are tool_calls, results are tool messages, and the prefix stays the same", () => {
  const { asked } = walk(5);
  for (let i = 2; i < asked.length; i++) {
    const a = bodyOf(asked[i - 1], OPENAI, "gpt-5.4-mini");
    const b = bodyOf(asked[i], OPENAI, "gpt-5.4-mini");
    assert.equal(marks(b), 0, "OpenAI caches by itself: nothing to mark");
    const kept = a.messages.slice(0, -1);
    assert.deepEqual(b.messages.slice(0, kept.length), kept);
    assert.deepEqual(b.tools, a.tools);
  }
  const b = bodyOf(asked[2], OPENAI, "gpt-5.4-mini");
  assert.deepEqual(b.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user", "assistant", "tool", "user"]);
  assert.equal(b.messages[3].tool_call_id, b.messages[2].tool_calls[0].id);
  assert.match(b.messages[2].tool_calls[0].id, /^[a-zA-Z0-9]{9}$/, "the id shape the strictest provider takes");
  // OpenRouter's Claude takes cache_control: the turns' last text is marked.
  const r = bodyOf(asked[2], OPENROUTER, "anthropic/claude-sonnet-4.6");
  assert.equal(marks(r), 2);
  assert.deepEqual(r.messages[r.messages.length - 2].content[0].cache_control, { type: "ephemeral" });
});

test("the Responses API gets function_call and function_call_output items", () => {
  const { asked } = walk(3);
  const { body } = LLM.buildRequest({ system: "s", user: asked[2].last, turns: asked[2].turns, tool: asked[2].tool }, { provider: "chatgpt", apiKey: "t", baseUrl: "https://chatgpt.com/backend-api/codex" }, "gpt-5.4", {});
  assert.deepEqual(body.input.map((x) => x.type), ["message", "function_call", "function_call_output", "message", "function_call", "function_call_output", "message"]);
  assert.equal(body.input[1].call_id, body.input[2].call_id);
});

// ----------------------------------------------------------------- client

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const reply = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  headers: { forEach: () => {} },
  text: async () => body,
  body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(body) })) }; } },
});
const toolCall = (args) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "step", arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }]);
const mistral = { provider: "mistral", apiKey: "mk", baseUrl: "https://api.mistral.ai/v1", customUrl: "", model: "mistral-small-latest", liteModel: "mistral-small-latest", backup: "", keyProblem: "", promptCaching: true };
const client = (replies, seen) => LLM.createClient({
  fetch: async (url, init) => { seen.push({ body: JSON.parse(init.body) }); return replies.shift(); },
  sleep: async () => {}, now: () => 1000, log: (title) => seen.push({ log: title }),
});

test("the client sends the conversation, or the one message when prompt caching is off or there is no tool", async () => {
  const { asked } = walk(3);
  const fx = asked[2];
  const req = { system: fx.system, user: fx.user, turns: fx.turns, last: fx.last, tool: fx.tool, tier: "pro" };
  const seen = [];
  await client([reply(200, toolCall({ goal: "g", do: "done" }))], seen).call(req, mistral);
  assert.equal(seen[0].body.messages.length, 8);
  assert.equal(seen[0].body.messages[7].content, fx.last);
  const off = [];
  await client([reply(200, toolCall({ goal: "g" }))], off).call(req, { ...mistral, promptCaching: false });
  assert.equal(off[0].body.messages.length, 2);
  assert.equal(off[0].body.messages[1].content, fx.user);
});

test("a provider that refuses the conversation is sent the one message, on that connection from then on", async () => {
  const { asked } = walk(3);
  const fx = asked[2];
  const req = { system: fx.system, user: fx.user, turns: fx.turns, last: fx.last, tool: fx.tool, tier: "pro" };
  const seen = [];
  const c = client([reply(400, JSON.stringify({ error: { message: "Unexpected role 'tool' after role 'user'" } })), reply(200, toolCall({ goal: "g" })), reply(200, toolCall({ goal: "h" }))], seen);
  const out = await c.call(req, mistral);
  assert.deepEqual(out.reply, { goal: "g" });
  const bodies = seen.filter((x) => x.body).map((x) => x.body);
  assert.equal(bodies[0].messages.length, 8);
  assert.equal(bodies[1].messages.length, 2);
  assert.ok(bodies[1].tools, "the tool is still offered: it was the turns that were refused");
  assert.ok(seen.some((x) => x.log === "Compatibility"));
  await c.call(req, mistral);
  assert.equal(seen.filter((x) => x.body).pop().body.messages.length, 2);
});

test("a re-ask adds its words to the current text, and the earlier turns stay as they were", async () => {
  const { asked } = walk(3);
  const fx = asked[2];
  const prose = sse([{ choices: [{ delta: { content: "I will click." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  const seen = [];
  await client([reply(200, prose), reply(200, toolCall({ goal: "g" }))], seen).call({ system: fx.system, user: fx.user, turns: fx.turns, last: fx.last, tool: fx.tool, tier: "pro" }, mistral);
  const [a, b] = seen.filter((x) => x.body).map((x) => x.body);
  assert.deepEqual(b.messages.slice(0, -1), a.messages.slice(0, -1));
  assert.match(b.messages[b.messages.length - 1].content, /did not call the step tool/);
  assert.ok(b.messages[b.messages.length - 1].content.startsWith(fx.last));
});

test("cached tokens of a conversation step are counted as before: inside the prompt, at a tenth on Anthropic", async () => {
  const { asked } = walk(3);
  const fx = asked[2];
  const usage = { input_tokens: 900, cache_read_input_tokens: 8000, cache_creation_input_tokens: 300, output_tokens: 1 };
  const call = sse([
    { type: "message_start", message: { model: "claude-haiku-5-5", usage } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "step", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ goal: "g", do: "done" }) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50 } },
  ]);
  const seen = [];
  const out = await client([reply(200, call)], seen).call({ system: fx.system, user: fx.user, turns: fx.turns, last: fx.last, tool: fx.tool, tier: "pro" }, { ...ANTHROPIC, model: "claude-haiku-5-5", liteModel: "claude-haiku-5-5", backup: "", keyProblem: "" });
  assert.equal(out.usage.prompt, 9200);
  assert.equal(out.usage.cached, 8000);
  assert.equal(out.usage.cacheWrite, 300);
  assert.ok(Math.abs(out.usage.cost - ((900 + 800 + 375) * 0.0001 + 50 * 0.0005) / 1000) < 1e-12);
  assert.equal(seen[0].body.messages[0].role, "user");
  assert.equal(seen[0].body.messages[1].content[0].type, "tool_use");
});

test("a page the next step was still on is given by its address alone: an excerpt of it as it was would be out of date", () => {
  const h = (n, url) => ({ step: n, goal: "g", url, title: "Inbox", seen: `Row: closed (step ${n})`, call: { goal: "g", do: "click", ref: 1 }, actions: [{ text: "click [1]", ok: true, result: "Done. The row opened." }] });
  const run = { task: "t", marker: "PAGE-abcd1234", history: [h(1, "https://mail.example/"), h(2, "https://mail.example/#open"), h(3, "https://mail.example/other")] };
  const text = CONTEXT.stepTurns(run, "head", "PAGE-abcd1234", "https://mail.example/other").flatMap((t) => (t.parts || []).map((p) => p.text || "")).join("\n");
  assert.doesNotMatch(text, /step 1\)/, "step 2 was on the same page, which had changed");
  assert.match(text, /An excerpt of that page: Inbox: Row: closed \(step 2\)/, "step 3 was on another page");
  assert.doesNotMatch(text, /step 3\)/, "the current page is shown in full, not excerpted");
});
