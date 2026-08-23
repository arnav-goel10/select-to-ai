const test = require("node:test");
const assert = require("node:assert/strict");
const pm = require("../../extension/providerModels.js");
const defaults = require("../../extension/defaults.js");

test("first-party providers prefix-check model ids", () => {
  assert.equal(pm.isModelCompatible("anthropic", "claude-sonnet-4-6"), true);
  assert.equal(pm.isModelCompatible("anthropic", "gpt-5"), false);
  assert.equal(pm.isModelCompatible("openai", "gpt-5.4-mini"), true);
  assert.equal(pm.isModelCompatible("openai", "claude-x"), false);
  assert.equal(pm.isModelCompatible("deepseek", "deepseek-chat"), true);
  assert.equal(pm.isModelCompatible("xai", "grok-4"), true);
});

test("multi-model catalogs accept any model id", () => {
  for (const provider of ["custom", "hosted", "openrouter", "opencode"]) {
    assert.equal(pm.isModelCompatible(provider, "anything/at-all"), true, provider);
  }
});

test("resolveModel falls back per tier when incompatible", () => {
  const pro = pm.resolveModel("anthropic", "not-a-claude", "pro", defaults);
  const lite = pm.resolveModel("anthropic", "not-a-claude", "lite", defaults);
  assert.equal(pro, defaults.PROVIDER_FALLBACK_MODELS.anthropic.pro);
  assert.equal(lite, defaults.PROVIDER_FALLBACK_MODELS.anthropic.lite);
  // Compatible ids pass through untouched.
  assert.equal(pm.resolveModel("anthropic", "claude-haiku-4-5", "lite", defaults), "claude-haiku-4-5");
});

test("resolveTierModel serves both tiers from the configured model on hosted gateways", () => {
  const lite = pm.resolveTierModel("hosted", "lite", "deepseek-v4-flash-free", defaults);
  const pro = pm.resolveTierModel("hosted", "pro", "deepseek-v4-flash-free", defaults);
  assert.equal(lite, "deepseek-v4-flash-free");
  assert.equal(pro, "deepseek-v4-flash-free");
});

test("resolveTierModel uses catalog lite models on multi-model providers", () => {
  const lite = pm.resolveTierModel("anthropic", "lite", "claude-sonnet-4-6", defaults);
  assert.equal(lite, defaults.PROVIDER_FALLBACK_MODELS.anthropic.lite);
});

test("validateKeyShape passes hosted and custom without keys", () => {
  assert.equal(pm.validateKeyShape("hosted", ""), "");
  assert.equal(pm.validateKeyShape("custom", ""), "");
});

test("validateKeyShape rejects missing and placeholder keys elsewhere", () => {
  assert.ok(pm.validateKeyShape("openrouter", "").length > 0);
  assert.ok(pm.validateKeyShape("openai", "sk-proj-...").includes("placeholder"));
  assert.ok(pm.validateKeyShape("anthropic", "sk-or-v1-real").includes('start with "sk-ant-"'));
  assert.equal(pm.validateKeyShape("openrouter", "sk-or-v1-realkey"), "");
});
