const test = require("node:test");
const assert = require("node:assert/strict");

const tools = require("../../extension/agentTools.js");

// =========================================================================
// Tool schema
// =========================================================================

test("the browser_action tool covers every legacy verb plus the new ones", () => {
  const expected = [
    // legacy executor verbs
    "click",
    "double_click",
    "right_click",
    "hover",
    "type",
    "clear",
    "select_option",
    "checkbox_toggle",
    "keypress",
    "scroll",
    "navigate",
    "wait",
    "back",
    "forward",
    "open_tab",
    "switch_tab",
    "close_tab",
    "reload_tab",
    "list_tabs",
    "request_screenshot",
    "finish",
    // new verbs
    "ask_user",
    "give_up",
    "remember",
    "revise_plan",
  ];
  for (const verb of expected) {
    assert.ok(
      tools.ACTION_NAMES.includes(verb),
      `verb "${verb}" missing from the tool schema`,
    );
  }
  const schemaEnum =
    tools.TOOL_DEFS.browser_action.parameters.properties.action.enum;
  assert.deepEqual([...schemaEnum].sort(), [...tools.ACTION_NAMES].sort());
});

test("both provider tool shapes wrap the same parameters", () => {
  const def = tools.TOOL_DEFS.browser_action;
  const openai = tools.buildOpenAITool(def.name, def.description, def.parameters);
  assert.equal(openai.type, "function");
  assert.equal(openai.function.name, "browser_action");
  assert.equal(openai.function.parameters, def.parameters);

  const anthropic = tools.buildAnthropicTool(
    def.name,
    def.description,
    def.parameters,
  );
  assert.equal(anthropic.name, "browser_action");
  assert.equal(anthropic.input_schema, def.parameters);
  assert.ok(!("type" in anthropic), "anthropic tools carry no type field");
});

test("plan and validation tools exist with required fields", () => {
  const plan = tools.TOOL_DEFS.submit_plan.parameters;
  assert.deepEqual(plan.required, ["subtasks"]);
  assert.deepEqual(plan.properties.subtasks.items.required, [
    "task",
    "postcondition",
  ]);
  const validation = tools.TOOL_DEFS.submit_validation.parameters;
  assert.deepEqual(validation.required, ["verdict", "reason"]);
  assert.deepEqual(validation.properties.verdict.enum, ["pass", "fail"]);
});

// =========================================================================
// validateToolCall
// =========================================================================

test("validateToolCall accepts a well-formed click and normalizes string ids", () => {
  const result = tools.validateToolCall(
    { thought: "t", action: "click", id: "7" },
    { validIds: new Set([7, 8]) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.action.id, 7);
});

test("validateToolCall rejects unknown actions with the valid list", () => {
  const result = tools.validateToolCall({ action: "teleport" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown action "teleport"/);
  assert.match(result.error, /click/);
});

test("validateToolCall rejects element actions without a valid id", () => {
  assert.equal(tools.validateToolCall({ action: "click" }).ok, false);
  assert.equal(tools.validateToolCall({ action: "click", id: 0 }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "click", id: 1.5 }).ok,
    false,
  );
  const outOfScan = tools.validateToolCall(
    { action: "click", id: 99 },
    { validIds: [1, 2, 3] },
  );
  assert.equal(outOfScan.ok, false);
  assert.match(outOfScan.error, /not in the current element list/);
});

test("validateToolCall enforces per-action required params", () => {
  assert.equal(tools.validateToolCall({ action: "type", id: 1 }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "type", id: 1, text: "hi" }).ok,
    true,
  );
  assert.equal(
    tools.validateToolCall({ action: "select_option", id: 1 }).ok,
    false,
  );
  assert.equal(
    tools.validateToolCall({
      action: "select_option",
      id: 1,
      optionText: "Blue",
    }).ok,
    true,
  );
  assert.equal(
    tools.validateToolCall({
      action: "select_option",
      id: 1,
      optionIndex: 2,
    }).ok,
    true,
  );
  assert.equal(tools.validateToolCall({ action: "scroll" }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "scroll", scrollDirection: "down" }).ok,
    true,
  );
  assert.equal(
    tools.validateToolCall({ action: "scroll", scrollDirection: "diagonal" })
      .ok,
    false,
  );
  assert.equal(tools.validateToolCall({ action: "switch_tab" }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "switch_tab", tabId: "42" }).action?.tabId,
    42,
  );
  // keypress works without an id (global key)
  assert.equal(
    tools.validateToolCall({ action: "keypress", text: "Enter" }).ok,
    true,
  );
  // keypress accepts the "key" alias and normalizes it to "text"
  const aliased = tools.validateToolCall({ action: "keypress", key: "Enter" });
  assert.equal(aliased.ok, true);
  assert.equal(aliased.action.text, "Enter");
  assert.equal(tools.validateToolCall({ action: "keypress" }).ok, false);
});

test("validateToolCall normalizes and requires http(s) urls", () => {
  const bare = tools.validateToolCall({ action: "navigate", url: "example.com" });
  assert.equal(bare.ok, true);
  assert.equal(bare.action.url, "https://example.com");
  assert.equal(tools.validateToolCall({ action: "navigate" }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "open_tab", url: "   " }).ok,
    false,
  );
});

test("validateToolCall rejects an empty-answer finish", () => {
  const empty = tools.validateToolCall({ action: "finish", answer: "   " });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /finish rejected/);
  const ok = tools.validateToolCall({
    action: "finish",
    answer: "Canberra",
    evidence: "answer box",
  });
  assert.equal(ok.ok, true);
});

test("validateToolCall enforces the new-verb params", () => {
  assert.equal(tools.validateToolCall({ action: "ask_user" }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "ask_user", question: "Which account?" })
      .ok,
    true,
  );
  assert.equal(tools.validateToolCall({ action: "give_up" }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "give_up", reason: "site is down" }).ok,
    true,
  );
  assert.equal(tools.validateToolCall({ action: "remember" }).ok, false);
  assert.equal(
    tools.validateToolCall({ action: "remember", note: "price is $9" }).ok,
    true,
  );
});

test("validateToolCall normalizes revise_plan subtasks", () => {
  assert.equal(
    tools.validateToolCall({ action: "revise_plan", subtasks: [] }).ok,
    false,
  );
  const mixed = tools.validateToolCall({
    action: "revise_plan",
    subtasks: [
      "open the site",
      { task: "search", postcondition: "results visible" },
      { bogus: true },
    ],
  });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.action.subtasks, [
    { task: "open the site", postcondition: "" },
    { task: "search", postcondition: "results visible" },
  ]);
});

test("validateToolCall clamps wait durations", () => {
  const long = tools.validateToolCall({ action: "wait", duration: 99999 });
  assert.equal(long.ok, true);
  assert.equal(long.action.duration, 10000);
});

test("validateToolCall rejects non-object payloads", () => {
  assert.equal(tools.validateToolCall(null).ok, false);
  assert.equal(tools.validateToolCall("click").ok, false);
  assert.equal(tools.validateToolCall([1, 2]).ok, false);
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

  // Element order changed on the page — ids follow the elements.
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
  assert.match(tools.formatOutcomeDelta(delta), /no observable page change/);
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
  const text = tools.formatOutcomeDelta(delta);
  assert.match(text, /URL changed/);
  assert.match(text, /120 DOM mutations/);
  assert.match(text, /\+15 interactive elements/);
  assert.ok(!/no observable page change/.test(text));
});

test("computeOutcomeDelta tolerates tiny scroll jitter and missing counts", () => {
  const before = { url: "u", title: "t", scrollX: 0, scrollY: 100 };
  const after = { url: "u", title: "t", scrollX: 0, scrollY: 101 };
  const delta = tools.computeOutcomeDelta(before, after, 0);
  assert.equal(delta.scrollChanged, false);
  assert.equal(delta.newElementCount, 0);
  assert.equal(tools.computeOutcomeDelta(null, null, NaN).domMutationCount, 0);
});

// =========================================================================
// Plan / validator parsing
// =========================================================================

test("parsePlanResponse normalizes subtasks and rejects garbage", () => {
  const plan = tools.parsePlanResponse({
    subtasks: [
      { task: "open google", postcondition: "google is loaded" },
      "search for cats",
    ],
  });
  assert.deepEqual(plan, [
    { task: "open google", postcondition: "google is loaded" },
    { task: "search for cats", postcondition: "" },
  ]);
  assert.equal(tools.parsePlanResponse({ subtasks: [] }), null);
  assert.equal(tools.parsePlanResponse({ subtasks: [{}] }), null);
  assert.equal(tools.parsePlanResponse(null), null);
  assert.equal(tools.parsePlanResponse({}), null);
  // Caps at 8 subtasks.
  const many = tools.parsePlanResponse({
    subtasks: Array.from({ length: 12 }, (_v, i) => `step ${i}`),
  });
  assert.equal(many.length, 8);
});

test("parseValidatorResponse normalizes verdict shapes", () => {
  assert.deepEqual(
    tools.parseValidatorResponse({ verdict: "pass", reason: "supported" }),
    { pass: true, reason: "supported" },
  );
  assert.deepEqual(
    tools.parseValidatorResponse({ verdict: "FAIL", reason: "no evidence" }),
    { pass: false, reason: "no evidence" },
  );
  assert.deepEqual(tools.parseValidatorResponse({ valid: true }), {
    pass: true,
    reason: "",
  });
  assert.equal(tools.parseValidatorResponse({ verdict: "maybe" }), null);
  assert.equal(tools.parseValidatorResponse({}), null);
  assert.equal(tools.parseValidatorResponse(null), null);
});
