"use strict";
// A model's tier sets how much of a page it is shown and how many actions
// it may take in one step. Moving tiers from words in the name to the
// reviewed table (defaults.js MODEL_TIERS) was not to change any model's
// tier: a model the table does not list, typed by a user, gets the tier
// the name-reading code gave it, now worked out from what the table
// declares (the same model written another way, a newer release of a
// listed line, a size its id states, a smaller variant by its maker's
// mark). The ids below are real ones, in the forms people type them: with
// a provider prefix, a release date, a route tag, dots or hyphens.
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../../extension/defaults.js");

// How main (before the table) placed a model: by words and numbers in its
// name. Kept here, test-only, as the yardstick; nothing ships it.
const BEFORE = (() => {
  const FRONTIER_FAMILY = /claude-(fable|opus|sonnet)|gpt-(5|6)(?![\w.-]*(mini|nano))|gemini-[\w.-]*pro|grok-4/i;
  const SMALL_WORD = /(?:^|[^a-z])(mini|nano|lite|small|haiku|ministral|tiny)(?![a-z])|openrouter\/free|(?:^|[^a-z0-9])e\d+b(?![a-z0-9])/i;
  const billionsIn = (id) => {
    let most = 0;
    for (const m of String(id).matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)) most = Math.max(most, parseFloat(m[1]));
    return most;
  };
  return (id) => {
    if (FRONTIER_FAMILY.test(id)) return "frontier";
    const size = billionsIn(id);
    if (size >= 200) return "frontier";
    if (size > 0) return size < 40 ? "small" : "standard";
    return SMALL_WORD.test(id) ? "small" : "standard";
  };
})();

const REAL_IDS = [
  // Anthropic, direct and through a router, dated and not.
  "claude-opus-5-5", "anthropic/claude-opus-5.5", "anthropic/claude-opus-5-5", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "anthropic/claude-opus-4.1",
  "claude-sonnet-4-6-20260115", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "anthropic/claude-sonnet-4.5", "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-fable-5-2", "claude-opus-6",
  // OpenAI.
  "gpt-5", "gpt-5.5", "openai/gpt-5.5", "gpt-5.5-2026-03-01", "gpt-5-2025-08-07", "gpt-5.1", "gpt-5.1-codex", "gpt-5-chat-latest", "gpt-6-luna", "openai/gpt-6-luna",
  "gpt-5-mini", "gpt-5-mini-2025-08-07", "gpt-5.4-mini-2026-01-01", "openai/gpt-5.4-mini", "gpt-5-nano", "gpt-5.1-codex-mini", "gpt-5.4-nano",
  "gpt-4o", "gpt-4o-2024-08-06", "openai/gpt-4o", "gpt-4o-mini", "openai/gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "chatgpt-4o-latest",
  "o3", "o3-mini", "o4-mini", "o4-mini-2025-04-16", "openai/gpt-oss-20b", "gpt-oss-120b", "openai/gpt-oss-120b:free",
  // Google.
  "gemini-2.5-pro", "google/gemini-2.5-pro", "gemini-3.1-pro", "google/gemini-3.1-pro", "gemini-3-pro-preview", "gemini-2.5-pro-preview-06-05", "gemini-pro-latest",
  "gemini-2.5-flash", "google/gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.5-flash-preview-05-20", "gemini-flash-latest", "gemini-3.5-flash",
  "gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "google/gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite",
  "gemma-3-27b-it", "google/gemma-3-27b-it:free", "gemma-3-4b-it", "gemma-3n-e4b-it", "google/gemma-3n-e4b-it:free", "gemma4:e4b", "gemma2:9b",
  // xAI.
  "grok-4", "x-ai/grok-4", "grok-4-6", "x-ai/grok-4-6", "grok-4-fast-reasoning", "grok-4-1-fast-non-reasoning", "x-ai/grok-4.1-fast", "grok-3", "grok-3-mini", "grok-code-fast-1",
  // Mistral.
  "mistral-large-latest", "mistral-large-2411", "mistral-medium-latest", "mistral-medium-2508", "mistral-small-latest", "mistral-small-2506", "mistralai/mistral-small-3.2-24b-instruct",
  "ministral-8b-latest", "ministral-3b-latest", "ministral-14b-latest", "codestral-latest", "codestral-2508", "open-mistral-nemo", "pixtral-large-latest", "magistral-medium-latest", "devstral-small-2507", "mistral",
  // Meta, through Groq, Together and routers.
  "llama-3.1-8b-instant", "llama-3.3-70b-versatile", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", "meta-llama/llama-3.1-405b-instruct",
  "meta-llama/Llama-3.2-3B-Instruct-Turbo", "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout", "meta/llama-4-maverick", "llama3", "llama3.1:70b", "llama3.2:3b",
  // DeepSeek, Qwen, NVIDIA and others.
  "deepseek-chat", "deepseek-reasoner", "deepseek/deepseek-r1", "deepseek/deepseek-chat-v3.1", "deepseek-ai/DeepSeek-V3", "deepseek-r1-distill-llama-70b", "deepseek/deepseek-v4.1-flash",
  "qwen3-235b-a22b", "qwen/qwen3-235b-a22b-2507", "qwen3-30b-a3b", "qwen/qwen3-coder", "qwen/qwen-2.5-72b-instruct", "qwen2.5-coder", "qwen2.5:7b", "qwen/qwen3.6-27b", "qwen/qwq-32b",
  "nvidia/nemotron-3-super-120b-a12b:free", "nvidia/nemotron-nano-9b-v2", "nvidia/llama-3.1-nemotron-70b-instruct", "nvidia/nemotron-3-ultra-550b-a55b",
  "phi3", "phi-4", "microsoft/phi-4-mini-instruct", "moonshotai/kimi-k2", "moonshotai/kimi-k2-instruct", "z-ai/glm-4.5", "z-ai/glm-4.5-air", "cohere/command-r-plus", "command-r7b-12-2024",
  "claude-3-opus-20240229", "claude-3-7-sonnet-20250219", "anthropic/claude-3.5-sonnet", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o1-mini", "o3-pro",
  "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-1.5-pro", "deepseek-v3", "qwen-max", "qwen-plus", "qwen-turbo", "mistral-tiny", "meta-llama/llama-guard-4-12b",
  "openrouter/free", "openrouter/auto", "acme-haiku-tiny", "",
];

test("a model the table does not list gets the tier main gave it", () => {
  assert.ok(REAL_IDS.length > 150, `a wide list (${REAL_IDS.length})`);
  const moved = REAL_IDS.map((id) => [id, BEFORE(id), D.modelProfile(id).tier]).filter(([, was, now]) => was !== now).map(([id, was, now]) => `${id}: ${was} -> ${now}`);
  assert.deepEqual(moved, []);
});

test("a dated, prefixed or tagged form of a listed model has the listed model's tier", () => {
  for (const [form, listed] of [["anthropic/claude-opus-5.5", "claude-opus-5-5"], ["claude-sonnet-4-6-20260115", "claude-sonnet-4-6"], ["gpt-5.5-2026-03-01", "gpt-5.5"], ["gpt-5.4-mini-2026-01-01", "gpt-5.4-mini"], ["x-ai/grok-4-6", "grok-4-6"], ["google/gemini-3.1-pro", "gemini-3.1-pro"], ["mistral-medium-2508", "mistral-medium-latest"], ["qwen/qwen3.8-27b", "qwen/qwen3.8-27b:free"]]) {
    assert.equal(D.modelProfile(form).tier, D.modelProfile(listed).tier, form);
    assert.ok(Object.values(D.MODEL_TIERS).flat().includes(listed), `${listed} is listed`);
  }
});

test("the tier is worked out from the table, not from names written into the code", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../extension/defaults.js"), "utf8");
  const body = src.slice(src.indexOf("const RELEASE_STAGE"), src.indexOf("function limitsFor(")).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  // The lines declared outright are data, read from MODEL_LINES, not tested against a name.
  const code = body.replace(/const MODEL_LINES = [\s\S]*?\}\);/, "");
  // No family or size word is written down: the smaller-variant words come from the table.
  for (const word of ["mini", "nano", "lite", "haiku", "opus", "sonnet", "gpt", "gemini", "grok", "pro"]) assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`), word);
  assert.ok(Object.keys(D.MODEL_LINES).length <= 4, "only a few lines are declared outright");
  const small = D.MODEL_TIERS.small.join(" ");
  for (const word of ["mini", "nano", "lite", "haiku"]) assert.ok(new RegExp(`\\b${word}\\b`).test(small), `"${word}" is learned from a listed small model`);
});
