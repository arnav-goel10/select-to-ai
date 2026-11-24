"use strict";
// A model's tier sets how much of a page it is shown and how many actions
// it may take in one step. No model's tier moves in this change:
// - a model the extension lists has its tier set in the table
//   (defaults.js MODEL_TIERS), at the tier main gave it;
// - any other id takes the tier the context window its provider reports
//   gives, when the provider's model list gives one;
// - otherwise the legacy fallback (defaults.js legacyNameTier) gives
//   exactly the tier main's function gave.
// The yardstick is main's own function, copied under tests/helpers. The ids
// are real ones, in the forms people type them, and generated variants of
// each: provider prefixes, Bedrock's region and version forms, release
// dates, route tags and case.
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../../extension/defaults.js");
const { mainTier } = require("../helpers/main-model-tier.js");

// Every model the extension lists by name.
const LISTED = (() => {
  const out = new Set(Object.values(D.MODEL_TIERS).flat());
  for (const pair of Object.values(D.PROVIDER_FALLBACK_MODELS)) for (const id of Object.values(pair)) out.add(id);
  for (const ids of Object.values(D.MODEL_PRESETS)) for (const id of ids) out.add(id);
  for (const b of D.FREE_BACKUPS) out.add(b.model);
  for (const id of D.OPENROUTER_FREE_CHAIN) out.add(id);
  for (const ids of Object.values(D.MODEL_SIBLINGS)) for (const id of ids) out.add(id);
  return [...out];
})();

const REAL_IDS = [
  // Anthropic, direct and through a router, dated and not.
  "claude-opus-5-5", "anthropic/claude-opus-5.5", "anthropic/claude-opus-5-5", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "anthropic/claude-opus-4.1",
  "claude-sonnet-4-6-20260115", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "anthropic/claude-sonnet-4.5", "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-fable-5-2", "claude-opus-6",
  "claude-3-opus-20240229", "claude-3-7-sonnet-20250219", "anthropic/claude-3.5-sonnet", "claude-sonnet-5-mini", "claude-haiku-5",
  // Anthropic on Bedrock and other OpenAI-compatible endpoints: region prefixes and version suffixes.
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "apac.anthropic.claude-sonnet-4-20250514-v1:0", "anthropic.claude-opus-4-1-20250805-v1:0", "us.anthropic.claude-opus-4-1-20250805-v1:0",
  "bedrock/anthropic.claude-sonnet-4-20250514-v1:0", "anthropic.claude-3-5-haiku-20241022-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-3-7-sonnet-20250219-v1:0", "vertex_ai/claude-sonnet-4-5@20250929", "claude-opus-4-1@20250805",
  // OpenAI.
  "gpt-5", "gpt-5.5", "openai/gpt-5.5", "gpt-5.5-2026-03-01", "gpt-5-2025-08-07", "gpt-5.1", "gpt-5.1-codex", "gpt-5-chat-latest", "gpt-6-luna", "openai/gpt-6-luna",
  "gpt-5-mini", "gpt-5-mini-2025-08-07", "gpt-5.4-mini-2026-01-01", "openai/gpt-5.4-mini", "gpt-5-nano", "gpt-5.1-codex-mini", "gpt-5.4-nano", "gpt-7", "gpt-7-mini",
  "gpt-4o", "gpt-4o-2024-08-06", "openai/gpt-4o", "gpt-4o-mini", "openai/gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "chatgpt-4o-latest",
  "o3", "o3-mini", "o4-mini", "o4-mini-2025-04-16", "openai/gpt-oss-20b", "gpt-oss-120b", "openai/gpt-oss-120b:free", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o1-mini", "o3-pro",
  // Google.
  "gemini-2.5-pro", "google/gemini-2.5-pro", "gemini-3.1-pro", "google/gemini-3.1-pro", "gemini-3-pro-preview", "gemini-2.5-pro-preview-06-05", "gemini-pro-latest",
  "gemini-2.5-flash", "google/gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.5-flash-preview-05-20", "gemini-flash-latest", "gemini-3.5-flash",
  "gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "google/gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.5-flash-8b", "gemini-flash-8b",
  "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-1.5-pro", "models/gemini-2.5-pro", "gemini-exp-1206",
  "gemma-3-27b-it", "google/gemma-3-27b-it:free", "gemma-3-4b-it", "gemma-3n-e4b-it", "google/gemma-3n-e4b-it:free", "gemma4:e4b", "gemma2:9b",
  // xAI.
  "grok-4", "x-ai/grok-4", "grok-4-6", "x-ai/grok-4-6", "grok-4-fast-reasoning", "grok-4-1-fast-non-reasoning", "x-ai/grok-4.1-fast", "grok-3", "grok-3-mini", "grok-code-fast-1",
  "grok-4-mini", "grok-5", "x-ai/grok-5",
  // Mistral.
  "mistral-large-latest", "mistral-large-2411", "mistral-medium-latest", "mistral-medium-2508", "mistral-small-latest", "mistral-small-2506", "mistralai/mistral-small-3.2-24b-instruct",
  "ministral-8b-latest", "ministral-3b-latest", "ministral-14b-latest", "codestral-latest", "codestral-2508", "open-mistral-nemo", "pixtral-large-latest", "magistral-medium-latest",
  "devstral-small-2507", "mistral", "mistral-tiny",
  // Meta, through Groq, Together and routers.
  "llama-3.1-8b-instant", "llama-3.3-70b-versatile", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", "meta-llama/llama-3.1-405b-instruct",
  "meta-llama/Llama-3.2-3B-Instruct-Turbo", "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout", "meta/llama-4-maverick", "llama3", "llama3.1:70b", "llama3.2:3b",
  "meta-llama/llama-guard-4-12b",
  // Qwen, the whole line as people type it.
  "qwen3-max", "qwen/qwen3-max", "qwen3-max-preview", "qwen/qwen3-max-thinking", "qwen3-plus", "qwen3.5-plus", "qwen3.6-plus", "qwen/qwen3.6-max", "qwen/qwen3-vl-plus",
  "qwen3-turbo", "qwen-4-max", "qwen-max", "qwen-plus", "qwen-turbo", "qwen3-235b-a22b", "qwen/qwen3-235b-a22b-2507", "qwen3-30b-a3b", "qwen/qwen3-coder",
  "qwen/qwen-2.5-72b-instruct", "qwen2.5-coder", "qwen2.5:7b", "qwen/qwen3.6-27b", "qwen/qwq-32b", "qwen-3.8-27b", "qwen/qwen3.8-27b",
  // DeepSeek, NVIDIA and others.
  "deepseek-chat", "deepseek-reasoner", "deepseek/deepseek-r1", "deepseek/deepseek-chat-v3.1", "deepseek-ai/DeepSeek-V3", "deepseek-r1-distill-llama-70b", "deepseek/deepseek-v4.1-flash", "deepseek-v3",
  "nvidia/nemotron-3-super-120b-a12b:free", "nvidia/nemotron-nano-9b-v2", "nvidia/llama-3.1-nemotron-70b-instruct", "nvidia/nemotron-3-ultra-550b-a55b",
  "phi3", "phi-4", "microsoft/phi-4-mini-instruct", "moonshotai/kimi-k2", "moonshotai/kimi-k2-instruct", "z-ai/glm-4.5", "z-ai/glm-4.5-air", "cohere/command-r-plus", "command-r7b-12-2024",
  "amazon/nova-pro-v1", "amazon.nova-lite-v1:0", "amazon.nova-micro-v1:0", "ai21/jamba-large-1.7", "perplexity/sonar-pro", "minimax/minimax-m2",
  "openrouter/free", "openrouter/auto", "acme-haiku-tiny", "",
];

// The forms an id takes elsewhere: a router's provider prefix, Bedrock's
// region and version marks, a release date, a route tag, upper case.
const PREFIXES = ["openrouter/", "bedrock/", "us.", "eu.", "global.", "azure/", "together/", "groq/", "vertex_ai/"];
const SUFFIXES = ["-20250929", "-2026-03-01", "-2506", "@20250514", "-v1:0", ":free", ":nitro", "-latest", "-preview", "-instruct", "-thinking"];
const forms = (id) => [id, ...PREFIXES.map((p) => p + id), ...SUFFIXES.map((s) => id + s), id.toUpperCase(), id.replace(/^./, (c) => c.toUpperCase()), id.replace(/-/g, ".")];
const ALL = [...new Set([...LISTED, ...REAL_IDS].flatMap((id) => (id ? forms(id) : [id])))];

test("every model the extension lists is set in the table at the tier main gave it", () => {
  const listed = Object.values(D.MODEL_TIERS).flat();
  for (const id of LISTED) assert.ok(listed.includes(id), `${id} has a tier set`);
  const moved = listed.filter((id) => D.modelProfile(id).tier !== mainTier(id)).map((id) => `${id}: ${mainTier(id)} -> ${D.modelProfile(id).tier}`);
  assert.deepEqual(moved, []);
});

test("with no context window reported, no id's tier moves from main's, over a wide list of real ids and their forms", () => {
  assert.ok(ALL.length > 3000, `a wide list (${ALL.length})`);
  const moved = ALL.map((id) => [id, mainTier(id), D.modelProfile(id).tier]).filter(([, was, now]) => was !== now).map(([id, was, now]) => `${id}: ${was} -> ${now}`);
  assert.deepEqual(moved, []);
  // The same holds when the provider's list gave no usable number.
  for (const id of ALL.slice(0, 400)) for (const none of [undefined, null, 0, -1, "", "n/a", NaN]) assert.equal(D.modelProfile(id, none).tier, mainTier(id), `${id} with ${none}`);
});

test("a model the extension does not list takes the tier its reported context window gives", () => {
  assert.equal(D.contextTier(8192), "small");
  assert.equal(D.contextTier(31999), "small");
  assert.equal(D.contextTier(32000), "standard");
  assert.equal(D.contextTier(131072), "standard");
  assert.equal(D.contextTier(200000), "frontier");
  assert.equal(D.contextTier(1048576), "frontier");
  // Unlisted: the reported window decides, whatever the name says.
  assert.equal(D.modelProfile("qwen3-max", 262144).tier, "frontier");
  assert.equal(D.modelProfile("some-lab/tiny-chat-v2", 8192).tier, "small");
  assert.equal(D.modelProfile("claude-sonnet-5-mini", 64000).tier, "standard");
  // Listed: the table's tier stands, whatever is reported.
  assert.equal(D.modelProfile("claude-opus-5-5", 8000).tier, "frontier");
  assert.equal(D.modelProfile("gpt-5.4-mini", 400000).tier, "small");
});

test("the context window is read from each provider's own model list", () => {
  assert.equal(D.reportedContext({ id: "qwen/qwen3-max", context_length: 262144, top_provider: { context_length: 131072 } }), 131072, "OpenRouter: the provider it is served by");
  assert.equal(D.reportedContext({ id: "qwen/qwen3-max", context_length: 262144 }), 262144, "OpenRouter and Together");
  assert.equal(D.reportedContext({ id: "llama-3.1-8b-instant", context_window: 131072 }), 131072, "Groq");
  assert.equal(D.reportedContext({ id: "mistral-large-latest", max_context_length: 131072 }), 131072, "Mistral");
  assert.equal(D.reportedContext({ name: "models/gemini-2.5-pro", inputTokenLimit: 1048576 }), 1048576, "Gemini");
  assert.equal(D.reportedContext({ id: "claude-opus-5-5", max_input_tokens: 200000 }), 200000, "Anthropic");
  assert.equal(D.reportedContext({ id: "gpt-5.5", object: "model" }), 0, "OpenAI gives none");
  assert.equal(D.reportedContext("gpt-5.5"), 0);
  assert.equal(D.reportedContext(null), 0);
});

test("the tier is picked from the table, the reported window, then the legacy fallback, in that order", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../extension/defaults.js"), "utf8");
  const pick = src.slice(src.indexOf("function tierOf("), src.indexOf("\n  }\n", src.indexOf("function tierOf(")));
  assert.ok(pick.includes('return TIER_OF.get(String(id || "")) || contextTier(contextTokens) || legacyNameTier(id);'), pick);
  // The legacy fallback is the one place a name is read, and it is main's.
  for (const id of ALL.slice(0, 2000)) assert.equal(D.legacyNameTier(id), mainTier(id), id);
});
