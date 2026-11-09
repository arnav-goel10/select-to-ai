const test = require("node:test");
const assert = require("node:assert/strict");

const tools = require("../../extension/agentTools.js");

// =========================================================================
// Tool shapes
// =========================================================================

test("both provider tool shapes wrap the same parameters", () => {
  const def = { name: "step", description: "One step.", parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } };
  const openai = tools.buildOpenAITool(def.name, def.description, def.parameters);
  assert.equal(openai.type, "function");
  assert.equal(openai.function.name, "step");
  assert.equal(openai.function.parameters, def.parameters);

  const anthropic = tools.buildAnthropicTool(
    def.name,
    def.description,
    def.parameters,
  );
  assert.equal(anthropic.name, "step");
  assert.equal(anthropic.input_schema, def.parameters);
  assert.ok(!("type" in anthropic), "anthropic tools carry no type field");
});

// =========================================================================
// Streaming tool-call accumulators
// =========================================================================

test("OpenAI tool_calls fragments accumulate across deltas", () => {
  const state = tools.createToolCallAccumulator();
  tools.accumulateOpenAIToolCallDelta(state, [
    { index: 0, id: "call_1", function: { name: "browser_action", arguments: "" } },
  ]);
  tools.accumulateOpenAIToolCallDelta(state, [
    { index: 0, function: { arguments: '{"action":"cli' } },
  ]);
  tools.accumulateOpenAIToolCallDelta(state, [
    { index: 0, function: { arguments: 'ck","id":4}' } },
  ]);
  const calls = tools.finalizeToolCalls(state);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "browser_action");
  assert.deepEqual(calls[0].args, { action: "click", id: 4 });
});

test("Anthropic tool_use events accumulate input_json_delta chunks", () => {
  const state = tools.createToolCallAccumulator();
  tools.accumulateAnthropicEvent(state, {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "browser_action", input: {} },
  });
  tools.accumulateAnthropicEvent(state, {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"action":"typ' },
  });
  tools.accumulateAnthropicEvent(state, {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: 'e","id":2,"text":"hi"}' },
  });
  // Unrelated events are ignored
  tools.accumulateAnthropicEvent(state, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "thinking..." },
  });
  const calls = tools.finalizeToolCalls(state);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { action: "type", id: 2, text: "hi" });
});

test("finalizeToolCalls reports unparseable arguments instead of throwing", () => {
  const state = tools.createToolCallAccumulator();
  tools.accumulateOpenAIToolCallDelta(state, [
    { index: 0, function: { name: "browser_action", arguments: "{broken" } },
  ]);
  const calls = tools.finalizeToolCalls(state);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args, null);
  assert.ok(calls[0].error);
  // Empty arguments finalize to an empty object.
  const state2 = tools.createToolCallAccumulator();
  tools.accumulateOpenAIToolCallDelta(state2, [
    { index: 0, function: { name: "browser_action" } },
  ]);
  assert.deepEqual(tools.finalizeToolCalls(state2)[0].args, {});
});

// =========================================================================
// Text-JSON fallback parsing
// =========================================================================

test("parseTextAction handles raw, fenced, and prose-wrapped JSON", () => {
  assert.deepEqual(tools.parseTextAction('{"action":"back"}'), {
    action: "back",
  });
  assert.deepEqual(
    tools.parseTextAction('```json\n{"action":"back"}\n```'),
    { action: "back" },
  );
  assert.deepEqual(
    tools.parseTextAction('Sure! Here is the action: {"action":"back"} Done.'),
    { action: "back" },
  );
  assert.equal(tools.parseTextAction("no json here"), null);
  assert.equal(tools.parseTextAction(""), null);
  assert.equal(tools.parseTextAction(null), null);
  assert.equal(tools.parseTextAction("[1,2,3]"), null);
});

// =========================================================================
// Stable element ids
// =========================================================================

test("assignStableElementIds reuses ids for still-present elements", () => {
  // First scan of a page: three new elements.
  const first = tools.assignStableElementIds([null, null, null], 1);
  assert.deepEqual(first.ids, [1, 2, 3]);
  assert.equal(first.nextId, 4);

  // Re-scan: element 2 disappeared, a new element appeared at the end.
  const second = tools.assignStableElementIds([1, 3, null], first.nextId);
  assert.deepEqual(second.ids, [1, 3, 4]);
  assert.equal(second.nextId, 5);

  // Element order changed on the page, ids follow the elements.
  const third = tools.assignStableElementIds([3, 1, 4], second.nextId);
  assert.deepEqual(third.ids, [3, 1, 4]);
});

test("assignStableElementIds re-allocates duplicates and foreign ids", () => {
  // Two elements claim the same stamped id (cloned nodes): only the first
  // keeps it.
  const dup = tools.assignStableElementIds([2, 2], 5);
  assert.deepEqual(dup.ids, [2, 5]);
  // A stamped id that was never allocated this page (>= nextId) is foreign
  // (e.g. left by a bfcache restore) and gets replaced.
  const foreign = tools.assignStableElementIds([42], 3);
  assert.deepEqual(foreign.ids, [3]);
  assert.equal(foreign.nextId, 4);
});

test("assignStableElementIds resets cleanly with a fresh counter (navigation)", () => {
  const fresh = tools.assignStableElementIds([null, null], 1);
  assert.deepEqual(fresh.ids, [1, 2]);
  // Bad counter input falls back to 1.
  const bad = tools.assignStableElementIds([null], 0);
  assert.deepEqual(bad.ids, [1]);
});

// =========================================================================
// Outcome deltas
// =========================================================================

test("computeOutcomeDelta detects silent no-ops", () => {
  const snap = {
    url: "https://a.test/",
    title: "A",
    scrollX: 0,
    scrollY: 100,
    elementCount: 40,
  };
  const delta = tools.computeOutcomeDelta(snap, { ...snap }, 0);
  assert.equal(delta.noEffect, true);
  assert.equal(delta.urlChanged, false);
  assert.equal(delta.domMutationCount, 0);
});

test("computeOutcomeDelta reports real changes", () => {
  const before = {
    url: "https://a.test/",
    title: "A",
    scrollX: 0,
    scrollY: 0,
    elementCount: 40,
  };
  const after = {
    url: "https://a.test/results",
    title: "A - results",
    scrollX: 0,
    scrollY: 350,
    elementCount: 55,
  };
  const delta = tools.computeOutcomeDelta(before, after, 120);
  assert.equal(delta.urlChanged, true);
  assert.equal(delta.titleChanged, true);
  assert.equal(delta.scrollChanged, true);
  assert.equal(delta.newElementCount, 15);
  assert.equal(delta.noEffect, false);
  assert.equal(delta.domMutationCount, 120);
});

test("computeOutcomeDelta tolerates tiny scroll jitter and missing counts", () => {
  const before = { url: "u", title: "t", scrollX: 0, scrollY: 100 };
  const after = { url: "u", title: "t", scrollX: 0, scrollY: 101 };
  const delta = tools.computeOutcomeDelta(before, after, 0);
  assert.equal(delta.scrollChanged, false);
  assert.equal(delta.newElementCount, 0);
  assert.equal(tools.computeOutcomeDelta(null, null, NaN).domMutationCount, 0);
});

test("colourName gives the plain word for a colour", () => {
  const cases = [
    [[255, 0, 0], "red"], [[220, 53, 69], "red"], [[128, 0, 0], "red"],
    [[255, 165, 0], "orange"], [[255, 140, 0], "orange"],
    [[255, 255, 0], "yellow"], [[255, 215, 0], "yellow"],
    [[0, 128, 0], "green"], [[40, 167, 69], "green"], [[144, 238, 144], "green"],
    [[0, 128, 128], "teal"], [[0, 255, 255], "cyan"], [[0, 188, 212], "cyan"],
    [[0, 0, 255], "blue"], [[13, 110, 253], "blue"], [[0, 0, 128], "blue"],
    [[128, 0, 128], "purple"], [[103, 58, 183], "purple"],
    [[255, 192, 203], "pink"], [[255, 105, 180], "pink"], [[233, 30, 99], "pink"],
    [[139, 69, 19], "brown"], [[121, 85, 72], "brown"],
    [[0, 0, 0], "black"], [[34, 34, 34], "black"],
    [[255, 255, 255], "white"], [[248, 249, 250], "white"],
    [[128, 128, 128], "grey"], [[204, 204, 204], "grey"], [[238, 238, 238], "grey"],
  ];
  for (const [[r, g, b], want] of cases) assert.equal(tools.colourName({ r, g, b }), want, `rgb(${r}, ${g}, ${b})`);
});

test("a wordless control is listed by its colour, its markings and where it is", () => {
  assert.equal(tools.formatElementLine({ id: 7, tagName: "div", colour: "red", at: { x: 120, y: 85 } }), "[7] div no name, red at 120,85");
  assert.equal(tools.formatElementLine({ id: 8, tagName: "div", colour: "green", marked: "box-3", at: { x: 1, y: 2 } }), '[8] div no name, green, marked "box-3" at 1,2');
  assert.equal(tools.formatElementLine({ id: 9, tagName: "span", marked: "star", at: { x: 1, y: 2 }, rect: { x: 1, y: 2, w: 3, h: 4 } }, { withGeometry: true }), '[9] span no name, marked "star" at=(1,2) 3x4');
});

test("a long value is shown by its start and its end; a short or secret one as before", () => {
  const long = `${"a".repeat(120)}${"m".repeat(1220)}${"z".repeat(80)}`;
  const line = tools.formatElementLine({ id: 1, tagName: "textarea", accName: "Notes", value: long });
  assert.equal(line, `[1] textarea "Notes" value="${"a".repeat(120)}... (1,420 characters) ...${"z".repeat(80)}"`);
  const mid = "word ".repeat(20).trim();
  assert.match(tools.formatElementLine({ id: 2, tagName: "input", inputType: "text", accName: "Title", value: mid }), /value="(word ){11}word…"$/, "an input up to 120 characters is clipped as before");
  assert.match(tools.formatElementLine({ id: 3, tagName: "textarea", accName: "Notes", value: mid }), new RegExp(`value="${mid}"$`), "a textarea up to 120 characters is shown whole");
  assert.match(tools.formatElementLine({ id: 4, tagName: "input", inputType: "text", accName: "Bio", value: "b".repeat(130) }), /value="b{120}\.\.\. \(130 characters\) \.\.\.b{10}"$/, "the start and the end do not overlap");
  assert.equal(tools.formatElementLine({ id: 5, tagName: "textarea", accName: "Notes", value: long, mask: "the user's address" }), `[5] textarea "Notes" value="the user's address"`);
  assert.equal(tools.formatElementLine({ id: 6, tagName: "input", inputType: "password", accName: "Password", value: "", sensitive: "password", filled: true }), '[6] input(password) "Password" secret(password) filled');
});
