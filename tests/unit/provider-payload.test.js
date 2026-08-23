const test = require("node:test");
const assert = require("node:assert/strict");
const pp = require("../../extension/providerPayload.js");

test("parseDataUrl extracts media type and base64 payload", () => {
  const parsed = pp.parseDataUrl("data:image/jpeg;base64,QUJD");
  assert.equal(parsed.mediaType, "image/jpeg");
  assert.equal(parsed.base64Data, "QUJD");
  assert.equal(pp.parseDataUrl(null), null);
  assert.equal(pp.parseDataUrl("https://not-a-data-url"), null);
});

test("explicit prompt caching is scoped to Anthropic and OpenRouter Claude/Qwen", () => {
  assert.equal(pp.supportsExplicitPromptCaching("anthropic", "claude-x", true), true);
  assert.equal(pp.supportsExplicitPromptCaching("openrouter", "anthropic/claude-sonnet-4.6", true), true);
  assert.equal(pp.supportsExplicitPromptCaching("openrouter", "qwen/qwen3", true), true);
  assert.equal(pp.supportsExplicitPromptCaching("openrouter", "openai/gpt-5", true), false);
  assert.equal(pp.supportsExplicitPromptCaching("openai", "gpt-5", true), false);
  // The user setting wins: disabled means disabled everywhere.
  assert.equal(pp.supportsExplicitPromptCaching("anthropic", "claude-x", false), false);
});

test("splitSystemPromptForCaching marks the stable block cacheable", () => {
  const parts = pp.splitSystemPromptForCaching(
    "dynamic intro\nSTABLE-BLOCK\ndynamic outro",
    "STABLE-BLOCK",
  );
  assert.deepEqual(parts.map((p) => p.cacheable), [false, true, false]);
  assert.equal(parts.map((p) => p.text).join(""), "dynamic intro\nSTABLE-BLOCK\ndynamic outro");
});

test("splitSystemPromptForCaching passes pre-split parts through verbatim", () => {
  const parts = [{ text: "a", cacheable: true }, { text: "", cacheable: true }];
  assert.deepEqual(pp.splitSystemPromptForCaching(parts, "ignored"), [
    { text: "a", cacheable: true },
  ]);
  // No stable block found -> single non-cacheable part.
  const miss = pp.splitSystemPromptForCaching("plain text", "NOT-PRESENT");
  assert.deepEqual(miss, [{ text: "plain text", cacheable: false }]);
});

test("system content builders shape Anthropic vs OpenAI payloads", () => {
  const anthro = pp.buildAnthropicSystemContent(
    [{ text: "dyn" }, { text: "static", cacheable: true }],
    "anthropic",
    "claude-haiku-4-5",
    true,
    "",
  );
  assert.deepEqual(anthro, [
    { type: "text", text: "dyn" },
    { type: "text", text: "static", cache_control: { type: "ephemeral" } },
  ]);

  const openaiPlain = pp.buildOpenAICompatibleSystemMessage(
    "hello",
    "openai",
    "gpt-5",
    true,
    "",
  );
  assert.deepEqual(openaiPlain, { role: "system", content: "hello" });

  const openaiCached = pp.buildOpenAICompatibleSystemMessage(
    [{ text: "static", cacheable: true }],
    "openrouter",
    "anthropic/claude-sonnet-4.6",
    true,
    "",
  );
  assert.equal(openaiCached.role, "system");
  assert.deepEqual(openaiCached.content[0].cache_control, { type: "ephemeral" });
});

test("cleanErrorMessage unwraps provider error envelopes", () => {
  assert.equal(
    pp.cleanErrorMessage('{"error":{"message":"Rate limited"}}', 429),
    "Rate limited",
  );
  assert.equal(
    pp.cleanErrorMessage('[{"error":"quota exceeded"}]', 402),
    "quota exceeded",
  );
  // Bracket-wrapped arrays unwrap to their first element's message.
  assert.equal(pp.cleanErrorMessage('[{"error":{"message":"inner"}}]', 400), "inner");
  assert.equal(pp.cleanErrorMessage('{"message":"plain msg"}', 500), "plain msg");
  // Long plain text truncates.
  const long = "x".repeat(300);
  const cleaned = pp.cleanErrorMessage(long, 500);
  assert.ok(cleaned.length <= 204);
  assert.equal(pp.cleanErrorMessage("", 0), "API error (HTTP unknown)");
});
