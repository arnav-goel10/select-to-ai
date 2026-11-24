"use strict";
// Call hygiene for small and free models (extension/core/llm.js): the
// sampling follows the model the request really carries, a tool call whose
// arguments are slightly off is mended here instead of asked for again, and
// the asks that are left are counted once for a step.
const test = require("node:test");
const assert = require("node:assert/strict");
const LLM = require("../../extension/core/llm.js");
const D = require("../../extension/defaults.js");
const RUN = require("../../extension/core/run.js");
// The page-blind press check, answered at once by a stand-in for its model.
const JUDGE = require("../helpers/fake-judge.js");
const advance = JUDGE.judging(RUN);

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
/** A streamed tool call whose arguments are exactly `raw`, sent in two pieces as providers do. */
const rawCall = (name, raw, finish) => {
  const half = Math.ceil(raw.length / 2);
  return sse([
    { model: "served-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: raw.slice(0, half) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(half) } }] } }] },
    { choices: [{ delta: {}, finish_reason: finish || "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ]);
};
const reply = (status, body, headers) => ({
  status, ok: status >= 200 && status < 300,
  headers: { forEach: (fn) => Object.entries(headers || {}).forEach(([k, v]) => fn(v, k)) },
  text: async () => body,
  body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(body) })) }; } },
});
const tool = {
  name: "step", description: "d",
  parameters: { type: "object", properties: { note: { type: "string" }, goal: { type: "string" }, do: { type: "string" }, ref: { type: "integer" }, value: { type: "string" }, actions: { type: "array" } }, required: ["note", "goal", "do"] },
};
const cfg = (more) => ({ provider: "mistral", apiKey: "mk-test", baseUrl: "https://api.mistral.ai/v1", customUrl: "", model: "ministral-8b-latest", liteModel: "ministral-8b-latest", backup: "", keyProblem: "", promptCaching: true, ...more });
const client = (replies, seen) => LLM.createClient({
  fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); const r = replies.shift(); if (!r) throw new Error("no more replies"); return r; },
  sleep: async () => {}, now: () => 1000, log: (title, text) => seen.push({ log: title, text }),
});
const ask = (replies, seen, more) => client(replies, seen).call({ system: "s", user: "u", tool, tier: "pro", ...more }, cfg());
const GOOD = { note: "n", goal: "g", do: "click", ref: 3 };

// ---------------------------------------------------------------- sampling

test("the free path is sent at the sampling of the model it goes out as", () => {
  const free = cfg({ provider: "openrouter", apiKey: "sk-or-test", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" });
  const first = LLM.buildRequest({ system: "s", user: "u", tool }, free, "openrouter/free", { maxTokens: 4000 }).body;
  assert.equal(first.model, D.OPENROUTER_FREE_CHAIN[0]);
  assert.match(first.model, /gemma/);
  assert.equal(first.temperature, D.modelProfile(first.model).temperature);
  // The chain's head now takes the steady default, so to see the sampling
  // follow the id sent, not "openrouter/free", a fresh client is given a
  // free path that goes out as a Qwen id.
  const llmPath = require.resolve("../../extension/core/llm.js");
  const saved = globalThis.SELECT_TO_AI_DEFAULTS;
  delete require.cache[llmPath];
  globalThis.SELECT_TO_AI_DEFAULTS = { ...D, outgoingModel: (p, m, b) => (p === "openrouter" && m === "openrouter/free" && !b ? "qwen/qwen3-test:free" : m) };
  let viaQwen;
  try {
    viaQwen = require(llmPath).buildRequest({ system: "s", user: "u", tool }, free, "openrouter/free", { maxTokens: 4000 }).body;
  } finally {
    globalThis.SELECT_TO_AI_DEFAULTS = saved;
    delete require.cache[llmPath];
    require(llmPath);
  }
  assert.equal(viaQwen.temperature, 0.6, "a free path sent out as Qwen is not sent greedy decoding");
  // The bare router, for a connection that refused the chain, keeps the steady default.
  const bare = LLM.buildRequest({ system: "s", user: "u", tool }, free, "openrouter/free", { maxTokens: 4000, bareFree: true }).body;
  assert.equal(bare.model, "openrouter/free");
  assert.equal(bare.temperature, 0.1);
  // Every other model is sent as itself, at its own setting.
  for (const [provider, model] of [["openrouter", "openrouter/free"], ["openrouter", "x/y"], ["mistral", "openrouter/free"], ["gemini", "gemini-3.5-flash"]]) {
    const sent = D.outgoingModel(provider, model, false);
    assert.equal(sent, provider === "openrouter" && model === "openrouter/free" ? D.OPENROUTER_FREE_CHAIN[0] : model);
  }
  assert.equal(D.outgoingModel("openrouter", "openrouter/free", true), "openrouter/free");
  assert.equal(D.openRouterOptions("openrouter/free", true, false).model, D.outgoingModel("openrouter", "openrouter/free", false), "one place decides the id");
});

// ------------------------------------------------------------------ repair

const SHAPES = [
  ["a trailing comma", '{"note":"n","goal":"g","do":"click","ref":3,}', GOOD, "not valid JSON"],
  ["single quotes", "{'note':'n','goal':'g','do':'click','ref':3}", GOOD, "not valid JSON"],
  ["bare keys and Python literals", '{note: "n", goal: "g", do: "click", ref: 3, ok: True, x: None}', { ...GOOD, ok: true, x: null }, "not valid JSON"],
  ["a missing comma", '{"note":"n" "goal":"g","do":"click","ref":3}', GOOD, "not valid JSON"],
  ["a line break inside a string", '{"note":"one\ntwo","goal":"g","do":"click","ref":3}', { ...GOOD, note: "one\ntwo" }, "not valid JSON"],
  ["a code fence around it", '```json\n{"note":"n","goal":"g","do":"click","ref":3,}\n```', GOOD, "not valid JSON"],
  ["a brace too many and words after it", '{"note":"n","goal":"g","do":"click","ref":3}} done', GOOD, "not valid JSON"],
  ["the closing brace missing", '{"note":"n","goal":"g","do":"click","ref":3,"value":"x"', { ...GOOD, value: "x" }, "cut short"],
  ["a list and the object left unclosed", '{"note":"n","goal":"g","do":"many","actions":[{"do":"click","ref":1}', { note: "n", goal: "g", do: "many", actions: [{ do: "click", ref: 1 }] }, "cut short"],
  ["a wrapper left unclosed", '{"name":"step","arguments":{"note":"n","goal":"g","do":"click","ref":3}', GOOD, "cut short"],
  ["the name and arguments wrapper", '{"name":"step","arguments":{"note":"n","goal":"g","do":"click","ref":3}}', GOOD, "wrapped in something else"],
  ["the wrapper with its arguments as a string", JSON.stringify({ name: "step", arguments: JSON.stringify(GOOD) }), GOOD, "wrapped in something else"],
  ["an object under the tool's name", '{"step":{"note":"n","goal":"g","do":"click","ref":3}}', GOOD, "wrapped in something else"],
  ["a one-item list", '[{"note":"n","goal":"g","do":"click","ref":3}]', GOOD, "wrapped in something else"],
  ["the arguments as a string of JSON", JSON.stringify(JSON.stringify(GOOD)), GOOD, "wrapped in something else"],
  ["a string of JSON that is itself a little off", JSON.stringify("{'note':'n','goal':'g','do':'click','ref':3,}"), GOOD, "not valid JSON"],
];

for (const [name, raw, want, how] of SHAPES) {
  test(`a tool call with ${name} is mended and used, in one request`, async () => {
    assert.deepEqual(LLM.repairArguments(raw, tool), { args: want, how });
    const seen = [];
    const out = await ask([reply(200, rawCall("step", raw))], seen);
    assert.deepEqual(out.reply, want);
    assert.equal(seen.filter((x) => x.body).length, 1, "no second request");
    assert.ok(seen.some((x) => x.log === "Call Mended"), "the saved log says it was mended");
  });
}

test("a call that stopped in the middle of a field is not used with the field left out", () => {
  // Each of these has every required field, and would run as a different action without its last one.
  const CUT = [
    ["a final answer", '{"note":"n","goal":"g","do":"done","answer":"The price is 19 dollars and the'],
    ["the target of a key press", '{"note":"n","goal":"g","do":"press","key":"Enter","ref":1'],
    ["whether it succeeded", '{"note":"n","goal":"g","do":"done","answer":"It could not be found.","success":fal'],
    ["a direction", '{"note":"n","goal":"g","do":"scroll","direction":"do'],
    ["a number that may have had more digits", '{"note":"n","goal":"g","do":"click","ref":12'],
    ["an inner object", '{"note":"n","goal":"g","do":"click","at":{"x":1,"y":2'],
    ["the second item of a list", '{"note":"n","goal":"g","do":"many","actions":[{"do":"click","ref":1},{"do":"fill","ref":2,"value":"ab'],
    ["a key", '{"note":"n","goal":"g","do":"click","re'],
    ["whatever was to follow a comma", '{"note":"n","goal":"g","do":"click","ref":3,'],
  ];
  for (const [what, raw] of CUT) {
    const r = LLM.repairArguments(raw, tool);
    assert.equal(r.args, null, what);
    assert.equal(r.cut, true, what);
    assert.match(r.error, /cut off in the middle of a field/, what);
  }
  // readLoose says which kind of ending it met.
  assert.deepEqual(LLM.readLoose('{"a":1,"b":"x"'), { value: { a: 1, b: "x" }, cut: true, dropped: false });
  assert.deepEqual(LLM.readLoose('{"a":1,"b":"x'), { value: { a: 1 }, cut: true, dropped: true });
  assert.deepEqual(LLM.readLoose('{"a":[1,2],"b":{"c":[3'), { value: { a: [1, 2] }, cut: true, dropped: true });
  assert.deepEqual(LLM.readLoose('{"a":[1,{"c":"d"}'), { value: { a: [1, { c: "d" }] }, cut: true, dropped: false });
  // Cut before a required field: there is nothing to run, and the model is told which.
  const lost = LLM.repairArguments('{"note":"n","goal":"find the pri', tool);
  assert.equal(lost.args, null);
  assert.match(lost.error, /cut off before goal, do/);
});

test("a reply that ran out of room is asked for again with more room, never run short of a field", async () => {
  const CUT = [
    '{"note":"n","goal":"g","do":"done","answer":"The price is 19 dollars and the',
    '{"note":"n","goal":"g","do":"press","key":"Enter","ref":1',
    '{"note":"n","goal":"g","do":"done","answer":"It could not be found.","success":fal',
    // Ended on a whole value: with the room gone, more fields may still have been to come.
    '{"note":"n","goal":"g","do":"done","answer":"It could not be found."',
  ];
  for (const raw of CUT) {
    const seen = [];
    const full = { note: "n", goal: "g", do: "done", answer: "It could not be found.", success: false };
    const out = await ask([reply(200, rawCall("step", raw, "length")), reply(200, rawCall("step", raw, "length")), reply(200, rawCall("step", JSON.stringify(full)))], seen, { maxTokens: 2000 });
    assert.deepEqual(out.reply, full, raw);
    assert.deepEqual(seen.filter((x) => x.body).map((x) => x.body.max_tokens), [2000, 4000, 8000], raw);
    assert.equal(seen.some((x) => x.log === "Call Mended"), false, "the cut call was not used");
  }
  // The same call written out as text.
  const seen = [];
  const text = (t, finish) => sse([{ choices: [{ delta: { content: t } }] }, { choices: [{ delta: {}, finish_reason: finish }] }]);
  const out = await ask([reply(200, text(CUT[3], "length")), reply(200, rawCall("step", JSON.stringify(GOOD)))], seen, { maxTokens: 2000 });
  assert.deepEqual(out.reply, GOOD);
  assert.deepEqual(seen.filter((x) => x.body).map((x) => x.body.max_tokens), [2000, 4000]);
  // With no more room to give, the model is told what happened.
  const big = [];
  await ask([reply(200, rawCall("step", CUT[3], "length")), reply(200, rawCall("step", JSON.stringify(GOOD)))], big, { maxTokens: 16000 });
  assert.match(big.filter((x) => x.body)[1].body.messages[1].content, /called the step tool, but its arguments were cut off when the reply ran out of room/);
});

test("text inside a field of a real call is never read as the call", () => {
  const inner = '{"note":"a","goal":"b","do":"done","success":true,"answer":"x"}';
  // A call short of a required field, with page text in one of its own fields: the caller judges it as it stands.
  const short = { do: "fill", ref: 4, value: inner };
  assert.deepEqual(LLM.repairArguments(JSON.stringify(short), tool), { args: short, how: "" });
  assert.deepEqual(LLM.repairArguments(short, tool), { args: short, how: "" });
  // Nor is an item of one of its lists.
  const listed = { note: "n", do: "many", actions: [{ note: "a", goal: "b", do: "done" }] };
  assert.deepEqual(LLM.repairArguments(JSON.stringify(listed), tool), { args: listed, how: "" });
  // Written loosely, it is asked for again, not swapped for what is inside it.
  const loose = LLM.repairArguments(`{do: 'fill', ref: 4, value: '${inner}',}`, tool);
  assert.equal(loose.args, null);
  assert.match(loose.error, /had no note, goal/);
  // A wrapper has none of the tool's fields: what it holds is still found.
  assert.deepEqual(LLM.repairArguments(JSON.stringify({ function: { name: "step", parameters: JSON.stringify(GOOD) } }), tool), { args: GOOD, how: "wrapped in something else" });
});

test("a malformed call on the Responses API is mended the same way", async () => {
  const events = (raw, status) => [
    { type: "response.created", response: { model: "served-model" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "i1", call_id: "c1", name: "step", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "i1", delta: raw },
    { type: status === "incomplete" ? "response.incomplete" : "response.completed", response: { status, ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}), usage: { input_tokens: 5, output_tokens: 5 } } },
  ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  // Played through an address the client may send to; the provider decides the wire format.
  const responses = cfg({ provider: "chatgpt", apiKey: "", baseUrl: "https://gate.example/v1", customUrl: "https://gate.example/v1", model: "gpt-x", liteModel: "gpt-x" });
  const play = async (replies, seen) => LLM.createClient({
    fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return replies.shift(); },
    sleep: async () => {}, now: () => 1000, log: (title) => seen.push({ log: title }), chatgptToken: async () => "test-token",
  }).call({ system: "s", user: "u", tool, tier: "pro" }, responses);
  const seen = [];
  const out = await play([reply(200, events("{'note':'n','goal':'g','do':'click','ref':3,}", "completed"))], seen);
  assert.deepEqual(out.reply, GOOD);
  assert.match(seen[0].url, /\/responses$/);
  assert.equal(seen.filter((x) => x.body).length, 1, "no second request");
  assert.ok(seen.some((x) => x.log === "Call Mended"));
  // And what cannot be mended is asked for again with the reason.
  const again = [];
  await play([reply(200, events('{"note":"n","goal":"find the pri', "completed")), reply(200, events(JSON.stringify(GOOD), "completed"))], again);
  assert.match(JSON.stringify(again.filter((x) => x.body)[1].body.input), /called the step tool, but its arguments were cut off before goal, do/);
});

test("valid arguments are passed through untouched, and what cannot be mended says why", () => {
  assert.deepEqual(LLM.repairArguments(JSON.stringify(GOOD), tool), { args: GOOD, how: "" });
  assert.deepEqual(LLM.repairArguments(GOOD, tool), { args: GOOD, how: "" });
  // Valid JSON without a required field is still the caller's to judge.
  assert.deepEqual(LLM.repairArguments('{"goal":"g","do":"click"}', tool), { args: { goal: "g", do: "click" }, how: "" });
  assert.match(LLM.repairArguments('{"goal":"g","do":"click",}', tool).error, /not valid JSON and had no note/);
  assert.match(LLM.repairArguments("click the button", tool).error, /not valid JSON/);
  assert.match(LLM.repairArguments('"click the button"', tool).error, /not one JSON object/);
  assert.match(LLM.repairArguments("{'note': 'the user's page', 'goal': 'g', 'do': 'x'}", tool).error, /not valid JSON/);
  assert.throws(() => LLM.readLoose("no braces here"), /no JSON object/);
  assert.deepEqual(LLM.readLoose('{"a":[1,2,],"b":"\\u00e9\\n"}'), { value: { a: [1, 2], b: "é\n" }, cut: false, dropped: false });
});

test("a call written out as text and not quite JSON is read the same way", async () => {
  const seen = [];
  const text = sse([{ choices: [{ delta: { content: "```json\n{'note':'n','goal':'g','do':'click','ref':3,}\n```" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  const out = await ask([reply(200, text)], seen);
  assert.deepEqual(out.reply, GOOD);
  assert.equal(seen.filter((x) => x.body).length, 1);
  // Prose with a brace in it is not a call.
  const prose = sse([{ choices: [{ delta: { content: "I will press {Enter} now." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  const again = [];
  await ask([reply(200, prose), reply(200, rawCall("step", JSON.stringify(GOOD)))], again);
  assert.equal(again.filter((x) => x.body).length, 2);
});

// ------------------------------------------------------------------ re-ask

test("arguments that cannot be mended are asked for again with what was wrong", async () => {
  const seen = [];
  const out = await ask([reply(200, rawCall("step", '{"note":"n","goal":"find the pri')), reply(200, rawCall("step", JSON.stringify(GOOD)))], seen);
  assert.deepEqual(out.reply, GOOD);
  const calls = seen.filter((x) => x.body);
  assert.equal(calls.length, 2);
  const said = calls[1].body.messages[1].content;
  assert.match(said, /called the step tool, but its arguments were cut off before goal, do/);
  assert.doesNotMatch(said, /did not call the step tool/, "it did call it: the reason given is the real one");
  assert.ok(seen.some((x) => x.log === "Call Not Readable"));
});

test("a call cut off by the reply's length is still asked for again with more room", async () => {
  const seen = [];
  const out = await ask([reply(200, rawCall("step", '{"note":"n","goal":"find the pri', "length")), reply(200, rawCall("step", JSON.stringify(GOOD)))], seen, { maxTokens: 2000 });
  assert.deepEqual(out.reply, GOOD);
  assert.deepEqual(seen.filter((x) => x.body).map((x) => x.body.max_tokens), [2000, 4000]);
});

test("the asks of one step are counted once: four requests in the call, then one at a time", async () => {
  const bad = () => reply(200, rawCall("step", "{{{"));
  const seen = [];
  await assert.rejects(ask([bad(), bad(), bad(), bad(), bad()], seen), (e) => e.kind === "no_action");
  assert.equal(seen.filter((x) => x.body).length, 4, "two re-asks and one try as written JSON");
  // The run's own next asks pass reasks 0: one request each.
  const single = [];
  await assert.rejects(ask([bad(), bad()], single, { reasks: 0 }), (e) => e.kind === "no_action");
  assert.equal(single.filter((x) => x.body).length, 1);
  const one = [];
  assert.deepEqual((await ask([bad(), reply(200, rawCall("step", JSON.stringify(GOOD)))], one, { reasks: 1 })).reply, GOOD);
});

test("after a step's asks are used up, the run asks once at a time until it stops", () => {
  const page = { url: "https://shop.example/", title: "Shop", scrollY: 0, viewportHeight: 900, pageHeight: 900, visibleText: "Blue Widget $19", innerText: "Blue Widget $19", elements: [{ id: 3, tagName: "a", accName: "Blue Widget", url: "https://shop.example/p/blue-widget" }] };
  const env = { now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} };
  const run = RUN.newRun({ id: "r1", task: "find blue widgets", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  advance(run, { type: "start" }, env);
  let fx = advance(run, { type: "observed", page }, env);
  assert.equal(fx[0].type, "model");
  assert.equal(fx[0].reasks, undefined, "the first ask has the call's full budget");
  const failed = () => advance(run, { type: "model_failed", purpose: "step", kind: "no_action", message: "The model kept replying without an action.", usage: { prompt: 50, completion: 5, cost: 0 } }, env);
  fx = failed();
  assert.equal(fx[0].type, "model");
  assert.equal(fx[0].reasks, 0, "the next ask is a single request");
  // A usable step gives the next step its full budget back.
  fx = advance(run, { type: "model_replied", purpose: "step", reply: { memory: "", goal: "g", actions: [{ do: "click", ref: 3 }] }, usage: {} }, env);
  assert.equal(fx[0].type, "act", JSON.stringify(run.journal.slice(-2)));
  advance(run, { type: "acted", result: { ok: true, message: "Done.", pageChanged: true } }, env);
  fx = advance(run, { type: "observed", page }, env);
  assert.equal(fx[0].reasks, undefined);
  // A call that names a step the run cannot use is still a call: the ask after it has its full budget.
  assert.equal(failed()[0].reasks, 0);
  fx = advance(run, { type: "model_replied", purpose: "step", reply: { memory: "", goal: "g", actions: [{ do: "click", ref: 999 }] }, usage: {} }, env);
  if (fx[0].type === "observe") fx = advance(run, { type: "observed", page }, env);
  assert.equal(fx[0].type, "model", JSON.stringify(fx));
  assert.equal(fx[0].reasks, undefined, "the model did call the tool");
  fx = advance(run, { type: "model_replied", purpose: "step", reply: { memory: "", goal: "g", actions: [{ do: "click", ref: 3 }] }, usage: {} }, env);
  assert.equal(fx[0].type, "act");
  advance(run, { type: "acted", result: { ok: true, message: "Done.", pageChanged: true } }, env);
  advance(run, { type: "observed", page }, env);
  // Three in a row end the run: 4 + 1 + 1 requests at most.
  assert.equal(failed()[0].reasks, 0);
  assert.equal(failed()[0].reasks, 0);
  assert.deepEqual(failed(), [{ type: "end" }]);
});
