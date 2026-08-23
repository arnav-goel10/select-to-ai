/**
 * Select to AI - Provider & model policy.
 *
 * Pure decision helpers extracted from the agent runtime so they can be
 * reasoned about and unit tested in isolation. No DOM, no chrome.* APIs,
 * no network: every function takes the data it needs (the shared defaults
 * catalog and/or a settings snapshot) and returns a plain value.
 *
 * Loaded by agent.html before agent.js. Exposes
 * SELECT_TO_AI_PROVIDER_MODELS; also CommonJS-exported for Node tests.
 */
(function initProviderModels(root) {
  "use strict";

  /**
   * Whether a model id plausibly belongs to the given provider. OpenAI-
   * compatible multi-model catalogs (custom, openrouter, opencode)
   * accept anything; first-party providers are prefix-checked.
   */
  function isModelCompatible(provider, model) {
    if (!model) return false;
    if (
      provider === "custom" ||
      provider === "openrouter" ||
      provider === "opencode"
    ) {
      return true;
    }
    if (provider === "anthropic") return model.startsWith("claude-");
    if (provider === "openai") return /^(gpt-|o\d|chatgpt-)/.test(model);
    if (provider === "deepseek") return model.startsWith("deepseek-");
    if (provider === "gemini") return model.startsWith("gemini-");
    if (provider === "mistral")
      return (
        model.includes("mistral") ||
        model.includes("ministral") ||
        model.includes("codestral") ||
        model.includes("magistral") ||
        model.includes("devstral")
      );
    if (provider === "groq")
      return (
        /^(llama|llama3|llama-3|mixtral|gemma|qwen|deepseek|moonshot|gpt-oss)/.test(
          model,
        ) || model.includes("/")
      );
    if (provider === "together") return model.includes("/");
    if (provider === "xai") return model.startsWith("grok-");
    return true;
  }

  /** Lite/pro fallback pair for a provider from the shared catalog. */
  function fallbackPair(provider, defaults) {
    const catalog = defaults.PROVIDER_FALLBACK_MODELS;
    return catalog[provider] || catalog.openrouter;
  }

  /**
   * Resolves the model to actually send: the configured model when
   * compatible, otherwise the provider's tiered fallback.
   */
  function resolveModel(provider, requestedModel, tier, defaults) {
    if (isModelCompatible(provider, requestedModel)) return requestedModel;
    const pair = fallbackPair(provider, defaults);
    return tier === "pro" ? pair.pro : pair.lite;
  }

  /**
   * Tier-aware resolution matching the runtime rule: lite-tier calls use
   * the catalog's cheap model except on single-model gateways (custom,
   * custom), which serve both tiers with the configured model.
   */
  function resolveTierModel(provider, tier, configuredModel, defaults) {
    if (tier === "lite" && provider !== "custom") {
      const pair = fallbackPair(provider, defaults);
      if (pair && pair.lite && isModelCompatible(provider, pair.lite)) {
        return pair.lite;
      }
    }
    return resolveModel(
      provider,
      configuredModel,
      tier === "pro" ? "pro" : "lite",
      defaults,
    );
  }

  /**
   * Shape-level API-key validation. Returns "" when the key looks fine (or
   * when none is needed), otherwise a human-readable problem description.
   */
  function validateKeyShape(provider, apiKey) {
    const key = String(apiKey || "").trim();
    if (provider === "custom") return "";
    if (!key) return `Missing API key for active provider "${provider}".`;
    if (
      key === "sk-or-v1-..." ||
      key === "sk-proj-..." ||
      key === "sk-ant-..." ||
      key === "AIzaSy..." ||
      key === "gsk_..." ||
      key.toLowerCase() === "api key"
    ) {
      return `The saved ${provider} API key looks like a placeholder, not a real key.`;
    }
    if (provider === "openrouter" && !key.startsWith("sk-or-"))
      return 'OpenRouter keys usually start with "sk-or-". Check that the active provider matches the key you saved.';
    if (provider === "anthropic" && !key.startsWith("sk-ant-"))
      return 'Anthropic keys usually start with "sk-ant-". Check that the active provider matches the key you saved.';
    if (provider === "openai" && !key.startsWith("sk-"))
      return 'OpenAI keys usually start with "sk-". Check that the active provider matches the key you saved.';
    if (provider === "gemini" && !key.startsWith("AIza"))
      return 'Gemini API keys usually start with "AIza". Check that the active provider matches the key you saved.';
    if (provider === "groq" && !key.startsWith("gsk_"))
      return 'Groq keys usually start with "gsk_". Check that the active provider matches the key you saved.';
    if (provider === "xai" && !key.startsWith("xai-"))
      return 'xAI keys usually start with "xai-". Check that the active provider matches the key you saved.';
    // OpenCode Zen keys have no stable public prefix; any non-placeholder
    // value is accepted here and verified live by the connection test.
    return "";
  }

  root.SELECT_TO_AI_PROVIDER_MODELS = Object.freeze({
    isModelCompatible,
    fallbackPair,
    resolveModel,
    resolveTierModel,
    validateKeyShape,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_PROVIDER_MODELS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
