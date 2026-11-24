"use strict";
// Asking a model for a tool call (extension/core/llm.js), with a provider
// played by a function: what is sent, and what is done when it misbehaves.
const test = require("node:test");
const assert = require("node:assert/strict");
const LLM = require("../../extension/core/llm.js");
const D = require("../../extension/defaults.js");

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = (name, args, extra) => sse([{ model: "served-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 }, ...(extra || {}) }]);
const reply = (status, body, headers) => ({
  status, ok: status >= 200 && status < 300,
  headers: { forEach: (fn) => Object.entries(headers || {}).forEach(([k, v]) => fn(v, k)) },
  text: async () => body,
  body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(body) })) }; } },
});
const tool = { name: "step", description: "d", parameters: { type: "object", properties: { goal: { type: "string" } } } };
const cfg = (more) => ({ provider: "mistral", apiKey: "mk-test", baseUrl: "https://api.mistral.ai/v1", customUrl: "", model: "ministral-8b-latest", liteModel: "ministral-8b-latest", backup: "", keyProblem: "", promptCaching: true, ...more });
const client = (replies, seen) => LLM.createClient({
  fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); const r = replies.shift(); if (!r) throw new Error("no more replies"); return r; },
  sleep: async () => {}, now: () => 1000, log: (title) => seen.push({ log: title }),
});

test("a tool call is read from the stream, with what it cost and which model answered", async () => {
  const seen = [];
  const out = await client([reply(200, toolCall("step", { goal: "go" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(out.reply, { goal: "go" });
  assert.equal(out.model, "served-model");
  assert.equal(out.usage.prompt, 100);
  assert.equal(seen[0].url, "https://api.mistral.ai/v1/chat/completions");
  // The tool is offered, not forced, on the first ask.
  assert.equal(seen[0].body.tool_choice, "auto");
  assert.equal(seen[0].body.temperature, 0.1);
});

test("a reply cut off before its action is asked for again with more room", async () => {
  const seen = [];
  const cut = sse([{ choices: [{ delta: { reasoning_content: "We need to find the search box and then" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }]);
  const out = await client([reply(200, cut), reply(200, toolCall("step", { goal: "go" }))], seen).call({ system: "s", user: "u", tool, tier: "pro", maxTokens: 2000 }, cfg());
  assert.deepEqual(out.reply, { goal: "go" });
  const calls = seen.filter((x) => x.body);
  assert.equal(calls[0].body.max_tokens, 2000);
  assert.equal(calls[1].body.max_tokens, 4000);
  assert.ok(seen.some((x) => x.log === "Reply Cut Short"));
});

test("a model that ran out of room once is given that room from the start afterwards", async () => {
  const seen = [];
  const cut = sse([{ choices: [{ delta: { reasoning_content: "thinking" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }]);
  const c = client([reply(200, cut), reply(200, toolCall("step", { goal: "go" })), reply(200, toolCall("step", { goal: "on" }))], seen);
  await c.call({ system: "s", user: "u", tool, tier: "pro", maxTokens: 2000 }, cfg());
  await c.call({ system: "s", user: "u", tool, tier: "pro", maxTokens: 2000 }, cfg());
  const calls = seen.filter((x) => x.body);
  assert.deepEqual(calls.map((x) => x.body.max_tokens), [2000, 4000, 4000]);
});

test("prose instead of an action is asked again, twice, then asked for as written JSON, then given up on", async () => {
  const seen = [];
  const prose = sse([{ choices: [{ delta: { content: "I think I should click the button." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  await assert.rejects(client([reply(200, prose), reply(200, prose), reply(200, prose), reply(200, prose)], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "no_action" && e.usage.prompt > 0);
  const calls = seen.filter((x) => x.body);
  assert.match(calls[1].body.messages[1].content, /did not call the step tool/);
  assert.equal(calls[0].body.tool_choice, "auto", "offered on the first ask");
  assert.equal(calls[1].body.tool_choice, "auto", "offered again on the first re-ask");
  assert.match(calls[2].body.messages[1].content, /did not call the step tool/);
  assert.equal(calls[2].body.tool_choice.function.name, "step", "forced on the second re-ask");
  assert.equal(calls[3].body.tools, undefined, "the last try asks for the fields as text");
  assert.match(calls[3].body.messages[0].content, /The step tool takes these fields/);
  // The connection is not marked as unable to use tools because of one bad step.
  const next = [];
  const c = client([reply(200, prose), reply(200, prose), reply(200, prose), reply(200, sse([{ choices: [{ delta: { content: "{\"goal\":\"go\"}" } }] }])), reply(200, toolCall("step", { goal: "on" }))], next);
  assert.deepEqual((await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg())).reply, { goal: "go" });
  await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.ok(next.filter((x) => x.body).pop().body.tools, "the next step is asked for with the tool again");
});

test("JSON written as text is taken as the tool call it was meant to be", async () => {
  const seen = [];
  const text = sse([{ choices: [{ delta: { content: "```json\n{\"goal\":\"go\"}\n```" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  const out = await client([reply(200, text)], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(out.reply, { goal: "go" });
});

test("a provider that refuses a forced tool is offered it instead; one that refuses tools gets plain JSON", async () => {
  const seen = [];
  const c = client([reply(400, JSON.stringify({ error: { message: "tool_choice with a forced tool is not supported by this model" } })), reply(200, toolCall("step", { goal: "go" })),
    reply(200, toolCall("step", { goal: "again" }))], seen);
  await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  const calls = () => seen.filter((x) => x.body);
  assert.equal(calls()[1].body.tool_choice, "auto");
  await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.equal(calls()[2].body.tool_choice, "auto", "what a connection would not take is remembered");
  const seen2 = [];
  const text = sse([{ choices: [{ delta: { content: "{\"goal\":\"go\"}" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  const out = await client([reply(400, JSON.stringify({ error: { message: "tools are not supported" } })), reply(200, text)], seen2).call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(out.reply, { goal: "go" });
  const second = seen2.filter((x) => x.body)[1].body;
  assert.equal(second.tools, undefined);
  assert.match(second.messages[0].content, /The step tool takes these fields/);
});

test("a busy model is swapped for its sibling; a key out of requests ends the call with the reason", async () => {
  const seen = [];
  const out = await client([reply(503, "overloaded"), reply(200, toolCall("step", { goal: "go" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ model: "mistral-medium-latest" }));
  assert.deepEqual(out.reply, { goal: "go" });
  assert.equal(seen.filter((x) => x.body)[1].body.model, "mistral-small-latest");
  await assert.rejects(client([reply(401, JSON.stringify({ error: { message: "bad key" } }))], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "auth");
  await assert.rejects(client([reply(402, JSON.stringify({ error: { message: "Insufficient credits" } }))], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "x/y" })), (e) => e.kind === "limit");
});

test("a rate limit is waited out for as long as the provider says, up to about a minute", async () => {
  const waits = [];
  const mk = (replies) => LLM.createClient({ fetch: async () => replies.shift(), sleep: async (ms) => { waits.push(Math.round(ms / 1000)); }, now: () => 1000, log: () => {} });
  const busy = reply(429, JSON.stringify({ error: { code: 429, message: "Quota exceeded for requests per minute", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" }] } }));
  const c = cfg({ provider: "custom", baseUrl: "https://llm.example/v1", customUrl: "https://llm.example/v1", model: "some-model", liteModel: "some-model" });
  const out = await mk([busy, reply(200, toolCall("step", { goal: "go" }))]).call({ system: "s", user: "u", tool, tier: "pro" }, c);
  assert.deepEqual(out.reply, { goal: "go" });
  assert.equal(waits[0], 34, "the wait the provider asked for, read from its reply");
  waits.length = 0;
  const plain = () => reply(429, JSON.stringify({ error: { message: "Too many requests" } }));
  await mk([plain(), plain(), reply(200, toolCall("step", { goal: "go" }))]).call({ system: "s", user: "u", tool, tier: "pro" }, c);
  assert.ok(waits[0] >= 5 && waits[1] >= 15, `with no hint the waits grow: ${waits}`);
  waits.length = 0;
  const gemini = reply(429, JSON.stringify([{ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details. Please retry in 21.5s.", status: "RESOURCE_EXHAUSTED" } }]));
  await mk([gemini, reply(200, toolCall("step", { goal: "go" }))]).call({ system: "s", user: "u", tool, tier: "pro" }, c);
  assert.equal(waits[0], 22, "a quota counted by the minute is waited out, not taken for a spent day");
});

test("a longer wait, or refusals that name none, end the call with how long to wait, so the run can pause instead of ending", async () => {
  // Was: kind "busy", which ended the run.
  const waits = [];
  const mk = (replies) => LLM.createClient({ fetch: async () => replies.shift(), sleep: async (ms) => { waits.push(ms); }, now: () => 1000, log: () => {} });
  const c = cfg({ provider: "custom", baseUrl: "https://llm.example/v1", customUrl: "https://llm.example/v1", model: "some-model", liteModel: "some-model" });
  const long = reply(429, JSON.stringify({ error: { message: "Please retry in 3600s" } }), { "retry-after": "3600" });
  await assert.rejects(mk([long]).call({ system: "s", user: "u", tool, tier: "pro" }, c), (e) => e.kind === "rate_limited" && e.waitMs === 3600000 && /asked to wait about 60 minutes/.test(e.message));
  assert.equal(waits.length, 0, "a long wait is not slept through inside the call");
  const plain = () => reply(429, JSON.stringify({ error: { message: "Too many requests" } }));
  await assert.rejects(mk([plain(), plain(), plain(), plain()]).call({ system: "s", user: "u", tool, tier: "pro" }, c), (e) => e.kind === "rate_limited" && e.waitMs === 0 && /kept turning requests away/.test(e.message));
  assert.equal(waits.length, 3, "short waits are still waited out in the call first");
  // A spent daily allowance is not a wait: it ends the call as a limit.
  const daily = reply(429, JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", metadata: { headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Date.now() + 8 * 3600000) } } } }));
  await assert.rejects(mk([daily]).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "x/y:free" })), (e) => e.kind === "limit");
});

test("a missing or misplaced key is caught before anything is sent", async () => {
  const s = LLM.settingsFrom({ agentActiveProvider: "gemini", agentGeminiKey: "sk-or-wrong" }, 0);
  assert.match(s.keyProblem, /does not look like a Google Gemini key/);
  await assert.rejects(client([], []).call({ system: "s", user: "u", tool, tier: "pro" }, s), (e) => e.kind === "config");
  assert.equal(LLM.settingsFrom({ agentActiveProvider: "gemini", agentGeminiKey: "AQ.abc" }, 0).keyProblem, "");
});

test("while the main provider's allowance is spent, the chosen backup answers", () => {
  const items = { agentActiveProvider: "openrouter", agentOpenRouterKey: "sk-or-x", agentModel: "openrouter/free", agentBackupProvider: "gemini", agentGeminiKey: "AIzaXYZ", agentProviderPause: { provider: "openrouter", until: 5000 } };
  assert.equal(LLM.settingsFrom(items, 1000).provider, "gemini");
  assert.equal(LLM.settingsFrom(items, 9000).provider, "openrouter");
});

test("a model is given the room its listed tier says, and the sampling its maker asks for", () => {
  assert.equal(D.modelProfile("openrouter/free").tier, "small");
  assert.equal(D.modelProfile("mistral-medium-latest").tier, "standard");
  assert.equal(D.modelProfile("claude-opus-5-5").tier, "frontier");
  assert.equal("verify" in D.modelProfile("claude-opus-5-5"), false, "no model is trusted to skip the check of its answer");
  assert.equal(D.modelProfile("gemini-pro-latest").tier, "frontier");
  assert.equal(D.modelProfile("gemini-flash-latest").tier, "standard");
  assert.equal(D.modelProfile("gemini-3.1-flash-lite").tier, "small");
  assert.equal(D.modelProfile("openai/gpt-oss-120b").tier, "standard");
  assert.equal(D.modelProfile("openai/gpt-oss-20b").tier, "small");
  // A model the extension does not list keeps the tier it always had, worked
  // out from the table (tests/unit/model-tiers.test.js holds the wide list).
  for (const [id, tier] of [["ministral-8b-latest", "small"], ["gpt-5.5-mini", "small"], ["nvidia/nemotron-3-ultra-550b-a55b", "frontier"], ["meta/llama-4-maverick", "standard"], ["gemma4:e4b", "small"], ["acme-haiku-tiny", "small"], ["claude-opus-9", "frontier"], ["", "standard"]]) {
    assert.equal(D.modelProfile(id).tier, tier, id);
  }
  assert.equal(D.modelProfile("gemini-3.5-flash").temperature, 1);
  assert.equal(D.modelProfile("gpt-6").temperature, null);
  assert.equal(D.modelProfile("ministral-8b-latest").temperature, 0.1);
  assert.ok(D.modelProfile("openai/gpt-oss-20b").maxTokens > D.modelProfile("ministral-8b-latest").maxTokens, "a model that thinks first gets room for both");
  const seen = [];
  return client([reply(200, toolCall("step", { goal: "go" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "gpt-6" })).then(() => {
    assert.equal("temperature" in seen[0].body, false);
  });
});

test("the helper tier asks the helper model, with the reply room of its own profile, and the main model when none is set", async () => {
  const seen = [];
  const c = client([reply(200, toolCall("step", { goal: "go" })), reply(200, toolCall("step", { goal: "on" })), reply(200, toolCall("step", { goal: "up" }))], seen);
  await c.call({ system: "s", user: "u", tool, tier: "helper" }, cfg({ helperModel: "magistral-medium-latest" }));
  await c.call({ system: "s", user: "u", tool, tier: "helper" }, cfg());
  await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ helperModel: "magistral-medium-latest" }));
  const calls = seen.filter((x) => x.body).map((x) => x.body);
  assert.deepEqual(calls.map((b) => b.model), ["magistral-medium-latest", "ministral-8b-latest", "ministral-8b-latest"]);
  assert.equal(calls[0].max_tokens, D.modelProfile("magistral-medium-latest").maxTokens);
  assert.equal(calls[1].max_tokens, D.modelProfile("ministral-8b-latest").maxTokens);
  assert.notEqual(calls[0].max_tokens, calls[1].max_tokens);
});

test("the helper is a model of the same provider, set or not at all", () => {
  const base = { agentActiveProvider: "mistral", agentMistralKey: "mk-x", agentModel: "ministral-8b-latest" };
  assert.equal(LLM.settingsFrom(base, 0).helperModel, "");
  assert.equal(LLM.settingsFrom({ ...base, agentHelperModel: " mistral-large-latest " }, 0).helperModel, "mistral-large-latest");
  assert.equal(LLM.settingsFrom({ ...base, agentHelperModel: "claude-opus-5-5" }, 0).helperModel, "", "a model the provider does not serve");
  assert.equal(LLM.settingsFrom({ ...base, agentHelperModel: "ministral-8b-latest" }, 0).helperModel, "", "the main model is no helper");
  const paused = { agentActiveProvider: "openrouter", agentOpenRouterKey: "sk-or-x", agentModel: "qwen/qwen3.8-27b:free", agentHelperModel: "anthropic/claude-sonnet-4.6", agentBackupProvider: "gemini", agentGeminiKey: "AIzaXYZ", agentProviderPause: { provider: "openrouter", until: 5000 } };
  assert.equal(LLM.settingsFrom(paused, 9000).helperModel, "anthropic/claude-sonnet-4.6");
  assert.equal(LLM.settingsFrom(paused, 1000).helperModel, "", "a backup standing in has no helper");
});

test("low effort is asked for in each provider's words, only of models that think, and the model's own is asked for by sending nothing", () => {
  const req = (effort) => ({ system: "s", user: "u", tool, effort });
  const body = (c, model, effort) => LLM.buildRequest(req(effort), cfg(c), model, { maxTokens: 100 }).body;
  assert.equal(body({ provider: "custom", baseUrl: "https://integrate.api.nvidia.com/v1" }, "openai/gpt-oss-20b", "low").reasoning_effort, "low");
  assert.equal(body({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1" }, "openai/gpt-oss-120b", "low").reasoning_effort, "low");
  assert.equal(body({ provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }, "gemini-3-flash-preview", "low").reasoning_effort, "low", "Gemini's thinking level, through its OpenAI-compatible endpoint");
  assert.deepEqual(body({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1/messages" }, "claude-sonnet-5-5", "low").output_config, { effort: "low" });
  assert.deepEqual(body({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "qwen/qwen3-235b-a22b", "low").reasoning, { effort: "low" });
  assert.equal(body({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "anthropic/claude-sonnet-5-5", "low").reasoning, undefined, "it would turn thinking on there");
  const quiet = body({ provider: "custom", baseUrl: "https://integrate.api.nvidia.com/v1" }, "openai/gpt-oss-20b", "default");
  assert.equal(quiet.reasoning_effort, undefined);
  assert.equal(body({}, "ministral-8b-latest", "low").reasoning_effort, undefined, "a model that does not think is not asked");
  assert.equal(body({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1/messages" }, "claude-haiku-4-5", "low").output_config, undefined);
});

test("a provider that rejects the effort setting, alone or with tools, is asked again without it, and it is not sent on that connection again", async () => {
  const seen = [];
  const c = client([
    reply(400, JSON.stringify({ error: { message: "reasoning_effort is not supported together with tools for this model" } })),
    reply(200, toolCall("step", { goal: "go" })),
    reply(200, toolCall("step", { goal: "again" })),
  ], seen);
  const nim = cfg({ provider: "custom", baseUrl: "https://integrate.api.nvidia.com/v1", customUrl: "https://integrate.api.nvidia.com/v1", model: "openai/gpt-oss-20b", liteModel: "openai/gpt-oss-20b" });
  const out = await c.call({ system: "s", user: "u", tool, tier: "pro", effort: "low" }, nim);
  assert.deepEqual(out.reply, { goal: "go" });
  const calls = () => seen.filter((x) => x.body);
  assert.equal(calls()[0].body.reasoning_effort, "low");
  assert.equal(calls()[1].body.reasoning_effort, undefined);
  assert.ok(calls()[1].body.tools, "the connection keeps its tools");
  assert.ok(seen.some((x) => x.log === "Compatibility"));
  await c.call({ system: "s", user: "u", tool, tier: "pro", effort: "low" }, nim);
  assert.equal(calls()[2].body.reasoning_effort, undefined, "remembered");
  // Anthropic, with the provider's generic words for a field it does not take.
  const seen2 = [];
  const a = client([reply(400, JSON.stringify({ error: { message: "output_config.effort: Extra inputs are not permitted" } })), reply(200, toolCall("step", { goal: "go" }))], seen2);
  await a.call({ system: "s", user: "u", tool, tier: "pro", effort: "low" }, cfg({ provider: "anthropic", apiKey: "sk-ant-x", baseUrl: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-5", liteModel: "claude-sonnet-4-5" }));
  const bodies = seen2.filter((x) => x.body).map((x) => x.body);
  assert.deepEqual(bodies[0].output_config, { effort: "low" });
  assert.equal(bodies[1].output_config, undefined);
  // A rejection that names another field is not taken as one of the effort setting.
  const seen3 = [];
  const g = client([reply(400, JSON.stringify({ error: { message: "Unsupported parameter: stream_options" } })), reply(200, toolCall("step", { goal: "go" }))], seen3);
  await g.call({ system: "s", user: "u", tool, tier: "pro", effort: "low" }, nim);
  const b3 = seen3.filter((x) => x.body).map((x) => x.body);
  assert.equal(b3[1].stream_options, undefined);
  assert.equal(b3[1].reasoning_effort, "low");
});

// Anthropic's current models (Haiku 5.5, Sonnet 5.5, Opus 5.5): adaptive
// thinking, no thinking budget, no temperature but their own, no forced tool
// while thinking, and cached prompt tokens counted at their own rates.
const ANTHROPIC = { provider: "anthropic", apiKey: "sk-ant-x", baseUrl: "https://api.anthropic.com/v1/messages" };
const anthropicCall = (args, usage) => sse([
  { type: "message_start", message: { model: "claude-haiku-5-5", usage: { input_tokens: 1000, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "step", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 200, ...(usage || {}) } },
]);

test("current Claude models are asked with adaptive thinking, an offered tool and no temperature", () => {
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
    const { body } = LLM.buildRequest({ system: "s", user: "u", tool, effort: "low" }, ANTHROPIC, model, { maxTokens: 6000 });
    assert.deepEqual(body.thinking, { type: "adaptive" }, model);
    assert.equal(body.thinking.budget_tokens, undefined, `${model}: a thinking budget is refused`);
    assert.equal(body.temperature, undefined, `${model}: only the model's own temperature is taken`);
    assert.deepEqual(body.tool_choice, { type: "auto" }, `${model}: a forced tool is refused while thinking`);
    assert.deepEqual(body.output_config, { effort: "low" }, `${model}: routine steps ask for low effort`);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" }, `${model}: the static block is cached`);
    assert.equal(body.tools[0].name, "step");
  }
  // Older Claude models keep what they took.
  const old = LLM.buildRequest({ system: "s", user: "u", tool }, ANTHROPIC, "claude-haiku-4-5", { maxTokens: 4000 }).body;
  assert.equal(old.thinking, undefined);
  assert.equal(old.temperature, 0.1);
  assert.deepEqual(old.tool_choice, { type: "tool", name: "step" });
});

test("the Claude catalog names the current models and their list prices", () => {
  assert.equal(D.PROVIDER_FALLBACK_MODELS.anthropic.lite, "claude-haiku-5-5");
  assert.equal(D.PROVIDER_FALLBACK_MODELS.anthropic.pro, "claude-sonnet-5-5");
  for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) assert.ok(D.MODEL_PRESETS.anthropic.includes(m), m);
  assert.deepEqual(D.findModelRates("claude-haiku-5-5"), [0.0001, 0.0005]);
  assert.deepEqual(D.findModelRates("claude-sonnet-5-5"), [0.002, 0.01]);
  assert.deepEqual(D.findModelRates("claude-opus-5-5"), [0.004, 0.02]);
  assert.deepEqual(D.findModelRates("claude-haiku-4-5"), [0.001, 0.005]);
  assert.equal(D.modelProfile("claude-haiku-5-5").thinks, true, "Haiku 5.5 thinks by default, so it gets thinking room and low effort");
});

test("cached prompt tokens are counted in the prompt and charged at a tenth, cache writes at 1.25 times", async () => {
  const seen = [];
  const out = await client([reply(200, anthropicCall({ goal: "go" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ ...ANTHROPIC, model: "claude-haiku-5-5", liteModel: "claude-haiku-5-5" }));
  assert.deepEqual(out.reply, { goal: "go" });
  assert.equal(out.usage.prompt, 7000);
  assert.equal(out.usage.cached, 6000);
  assert.equal(out.usage.completion, 200);
  // 1000 + 600 effective input tokens at $0.10/M, 200 output at $0.50/M.
  assert.ok(Math.abs(out.usage.cost - (1600 * 0.0001 + 200 * 0.0005) / 1000) < 1e-12, String(out.usage.cost));
});

test("a model that refuses a temperature is asked again without it, and it is not sent on that connection again", async () => {
  const seen = [];
  const refusal = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "temperature: only 1 is supported for this model" } });
  const c = client([reply(400, refusal), reply(200, toolCall("step", { goal: "go" })), reply(200, toolCall("step", { goal: "again" }))], seen);
  const out = await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(out.reply, { goal: "go" });
  const bodies = seen.filter((x) => x.body).map((x) => x.body);
  assert.equal(bodies[0].temperature, 0.1);
  assert.equal(bodies[1].temperature, undefined);
  await c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.equal(seen.filter((x) => x.body).pop().body.temperature, undefined);
});

// Cached prompt tokens in each provider's own usage shape, as their API
// docs gave them on 24 Nov 2026. Outside Anthropic the cached tokens are
// already inside prompt_tokens, so the prompt count does not grow and the
// prompt is charged at the full input rate.
const cachedReply = (usage) => toolCall("step", { goal: "go" }, { usage: { completion_tokens: 20, ...usage } });
const fullRate = (model, prompt, completion) => { const r = D.findModelRates(model); return (prompt / 1000) * r[0] + (completion / 1000) * r[1]; };
for (const [name, provider, model, usage, cached, cacheWrite] of [
  ["OpenAI", "openai", "gpt-5.4-mini", { prompt_tokens: 5000, prompt_tokens_details: { cached_tokens: 4096, cache_write_tokens: 512 } }, 4096, 512],
  ["OpenRouter", "openrouter", "anthropic/claude-sonnet-4.6", { prompt_tokens: 194, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 } }, 0, 100],
  ["Groq", "groq", "openai/gpt-oss-120b", { prompt_tokens: 4641, prompt_tokens_details: { cached_tokens: 4608 } }, 4608, 0],
  ["Cerebras", "cerebras", "qwen-3.8-27b", { prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 2800 } }, 2800, 0],
  ["xAI", "xai", "grok-4-6", { prompt_tokens: 32, prompt_tokens_details: { text_tokens: 32, audio_tokens: 0, image_tokens: 0, cached_tokens: 8 } }, 8, 0],
  ["DeepSeek", "deepseek", "deepseek-flash", { prompt_tokens: 1200, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 200 }, 1000, 0],
  ["Mistral", "mistral", "mistral-small-latest", { prompt_tokens: 1013, prompt_tokens_details: { cached_tokens: 1008 } }, 1008, 0],
]) {
  test(`${name}: cached prompt tokens are read from its own usage fields`, async () => {
    const out = await client([reply(200, cachedReply(usage))], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ provider, model, liteModel: model }));
    assert.equal(out.usage.prompt, usage.prompt_tokens, "cached tokens are inside prompt_tokens, not added again");
    assert.equal(out.usage.cached, cached);
    assert.equal(out.usage.cacheWrite, cacheWrite);
    assert.ok(Math.abs(out.usage.cost - fullRate(model, usage.prompt_tokens, 20)) < 1e-12, String(out.usage.cost));
  });
}

test("the Responses API's cached tokens are read from input_tokens_details and not added to input_tokens", () => {
  const u = { input_tokens: 15000, input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 }, output_tokens: 2 };
  assert.deepEqual(LLM.cacheOf(u), { cached: 12000, cacheWrite: 3000, apart: false });
});

test("DeepSeek's prompt_tokens_details copy of the hit count is read the same", () => {
  assert.equal(LLM.cacheOf({ prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 1000 }, prompt_cache_hit_tokens: 1000 }).cached, 1000);
});

test("a usage with no cached count, as Gemini's OpenAI endpoint and Together send it, reads as none cached", () => {
  assert.deepEqual(LLM.cacheOf({ prompt_tokens: 800, completion_tokens: 20, total_tokens: 820 }), { cached: 0, cacheWrite: 0, apart: false });
});

test("Anthropic's cache fields stay counted apart from input_tokens", () => {
  assert.deepEqual(LLM.cacheOf({ input_tokens: 1000, cache_read_input_tokens: 6000, cache_creation_input_tokens: 50, output_tokens: 1 }), { cached: 6000, cacheWrite: 50, apart: true });
  assert.deepEqual(LLM.cacheOf({ prompt_tokens: 100 }), { cached: 0, cacheWrite: 0, apart: false });
});
