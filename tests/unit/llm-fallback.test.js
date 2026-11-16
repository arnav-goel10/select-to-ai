"use strict";
// The default free path (openrouter/free sent as a list of named free
// models) must not dead-end when one of those models is retired: the bare
// free router is asked once, never in a loop, and the connection remembers
// it. Also: one attribution for OpenRouter, and recipe repairs on the
// run's own model where the cheap one would be the wrong one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LLM = require("../../extension/core/llm.js");
const D = require("../../extension/defaults.js");
const RECIPES = require("../../extension/recipes/service.js");

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = (args) => sse([{ model: "served/free-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "step", arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
const reply = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  headers: { forEach: () => {} },
  text: async () => body,
  body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(body) })) }; } },
});
const err = (status, message) => reply(status, JSON.stringify({ error: { message, code: status } }));
const tool = { name: "step", description: "d", parameters: { type: "object", properties: { goal: { type: "string" } } } };
const free = (more) => ({ provider: "openrouter", apiKey: "sk-or-test", baseUrl: "https://openrouter.ai/api/v1", customUrl: "", model: "openrouter/free", liteModel: "openrouter/free", backup: "", keyProblem: "", promptCaching: true, ...more });
const client = (replies, seen) => LLM.createClient({
  fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); const r = replies.shift(); if (!r) throw new Error("no more replies"); return r; },
  sleep: async () => {}, now: () => 1000, log: (title, text) => seen.push({ log: title, text }),
});
const sent = (seen) => seen.filter((x) => x.body).map((x) => x.body);
const ask = { system: "s", user: "u", tool, tier: "pro" };

test("the free path goes out as the named chain first", async () => {
  const seen = [];
  await client([reply(200, toolCall({ goal: "go" }))], seen).call(ask, free());
  const [b] = sent(seen);
  assert.equal(b.model, D.OPENROUTER_FREE_CHAIN[0]);
  assert.deepEqual(b.models, D.OPENROUTER_FREE_CHAIN.slice(1));
});

for (const [status, message] of [
  [400, `${D.OPENROUTER_FREE_CHAIN[0]} is not a valid model ID`],
  [404, "No endpoints found for qwen/qwen3.8-27b:free."],
  [404, "Model not found"],
]) {
  test(`a ${status} naming the model ("${message.slice(0, 30)}") is retried once on the bare router`, async () => {
    const seen = [];
    const out = await client([err(status, message), reply(200, toolCall({ goal: "go" }))], seen).call(ask, free());
    assert.deepEqual(out.reply, { goal: "go" });
    const bodies = sent(seen);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].model, "openrouter/free");
    assert.equal(bodies[1].models, undefined, "no models list on the retry");
    assert.equal(bodies[1].parallel_tool_calls, false, "the other OpenRouter field stays");
  });
}

test("the retry happens once: a bare router that refuses too ends the call, no loop", async () => {
  const seen = [];
  const msg = "openrouter/free is not a valid model ID";
  await assert.rejects(
    client([err(400, `${D.OPENROUTER_FREE_CHAIN[0]} is not a valid model ID`), err(400, msg), err(400, msg), err(400, msg)], seen).call(ask, free()),
    (e) => e.kind === "invalid",
  );
  assert.equal(sent(seen).length, 2, "the chain once, the bare router once");
});

test("the connection remembers: the next call asks the bare router from the start", async () => {
  const seen = [];
  const c = client([err(404, "No endpoints found for qwen/qwen3.8-27b:free."), reply(200, toolCall({ goal: "a" })), reply(200, toolCall({ goal: "b" }))], seen);
  await c.call(ask, free());
  await c.call({ ...ask, tier: "lite" }, free());
  const bodies = sent(seen);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].model, "openrouter/free");
  assert.equal(bodies[2].models, undefined);
});

test("a refusal that does not name the model is not turned into a router retry", async () => {
  const seen = [];
  await assert.rejects(client([err(400, "Prompt is too long for this request")], seen).call(ask, free()), (e) => e.kind === "invalid");
  assert.equal(sent(seen).length, 1);
});

test("a model the user chose on OpenRouter is never swapped for the router", async () => {
  const seen = [];
  await assert.rejects(client([err(404, "anthropic/claude-sonnet-9 is not a valid model ID")], seen).call(ask, free({ model: "anthropic/claude-sonnet-9" })), (e) => e.kind === "invalid");
  const bodies = sent(seen);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "anthropic/claude-sonnet-9");
});

test("OpenRouter requests carry the project's repository as the referer, and the same name as the welcome key test", async () => {
  const seen = [];
  await client([reply(200, toolCall({ goal: "go" }))], seen).call(ask, free());
  const h = seen[0].headers;
  assert.equal(h["HTTP-Referer"], "https://github.com/arnav-goel10/select-to-ai");
  assert.equal(h["X-Title"], D.OPENROUTER_ATTRIBUTION["X-Title"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../extension/manifest.json"), "utf8"));
  assert.equal(h["HTTP-Referer"], manifest.homepage_url, "the referer is the listing's own homepage");
  // welcome.js tests a key with its own fetch: it must say the same.
  const welcome = fs.readFileSync(path.join(__dirname, "../../extension/welcome.js"), "utf8");
  assert.ok(welcome.includes(`"HTTP-Referer"] = "${h["HTTP-Referer"]}"`) || welcome.includes("OPENROUTER_ATTRIBUTION"), "welcome.js sends the same referer");
  assert.ok(welcome.includes(`"X-Title"] = "${h["X-Title"]}"`) || welcome.includes("OPENROUTER_ATTRIBUTION"), "welcome.js sends the same title");
  for (const f of ["core/llm.js", "defaults.js", "welcome.js"]) {
    assert.ok(!fs.readFileSync(path.join(__dirname, "../../extension", f), "utf8").includes("selecttoai.github.io"), `${f} names the unregistered page`);
  }
});

test("recipe repairs use the run's own model for a paid OpenRouter model or a custom gateway, and the cheap one otherwise", async () => {
  const cases = [
    [{ provider: "openrouter", model: "anthropic/claude-sonnet-5", liteModel: "openrouter/free" }, "pro", "anthropic/claude-sonnet-5"],
    [{ provider: "openrouter", model: "openrouter/free", liteModel: "openrouter/free" }, "lite", "openrouter/free"],
    [{ provider: "openrouter", model: "google/gemma-4-31b-it:free", liteModel: "openrouter/free" }, "lite", "openrouter/free"],
    [{ provider: "custom", model: "my-gateway-model", liteModel: "my-gateway-model" }, "pro", "my-gateway-model"],
    [{ provider: "anthropic", model: "claude-sonnet-5-5", liteModel: "claude-haiku-5-5" }, "lite", "claude-haiku-5-5"],
  ];
  for (const [c, tier, model] of cases) {
    const calls = [];
    const fake = { call: async (req, cfg) => { calls.push(req.tier); return { reply: { ok: true }, usage: { prompt: 1, completion: 1, cost: 0 }, model: req.tier === "pro" ? cfg.model : cfg.liteModel }; } };
    const m = RECIPES.modelFrom({ keyProblem: "", ...c }, { client: fake });
    assert.equal(m.model, model, `${c.provider} ${c.model}`);
    const out = await m.complete({ system: "s", user: "u", schema: { type: "object" } });
    assert.deepEqual(calls, [tier], `${c.provider} ${c.model}`);
    assert.equal(out.usage.model, model);
  }
});
