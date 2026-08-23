/**
 * Shared runtime defaults and model catalog for Select to AI.
 *
 * Single source of truth consumed by:
 * - background.js (via importScripts)
 * - agent.html / options.html (via <script src>)
 * - Node.js unit tests (via require)
 *
 * Keep this module dependency-free so the same values load everywhere.
 */
(function initSharedDefaults(root) {
  "use strict";

  // Agent runtime defaults. The options UI, the agent runtime, and the
  // background worker all read these so they can never drift apart.
  const AGENT_DEFAULTS = Object.freeze({
    activeProvider: "opencode",
    model: "deepseek-v4-flash-free",
    customUrl: "http://localhost:11434/v1",
    // Hosted ("no key") mode relays through a small OpenAI-compatible relay
    // server. The default targets the bundled zero-dependency relay
    // (relay/server.js) running on the user's own machine.
    hostedRelayUrl: "http://localhost:8787/v1",
    maxSteps: 25,
    elementLimit: 60,
    historyLimit: 12,
    timeoutMs: 60000,
    maxTokensPerCall: 2000,
    temperature: 0.1,
    costBudget: 0,
    failureThreshold: 3,
    promptCaching: true,
    riskConfirmation: true,
  });

  // Per-provider fallback models used when the configured model is not valid
  // for the active provider. "lite" is the cheap default, "pro" the flagship.
  // Catalog verified against provider documentation in August 2026.
  // Provider endpoints and the storage key each provider's API key lives under.
  // "custom" is intentionally absent: its base URL comes from user settings.
  const PROVIDER_ENDPOINTS = Object.freeze({
    openrouter: { keyName: "agentOpenRouterKey", baseUrl: "https://openrouter.ai/api/v1" },
    anthropic: { keyName: "agentAnthropicKey", baseUrl: "https://api.anthropic.com/v1/messages" },
    openai: { keyName: "agentOpenAIKey", baseUrl: "https://api.openai.com/v1" },
    deepseek: { keyName: "agentDeepSeekKey", baseUrl: "https://api.deepseek.com" },
    gemini: { keyName: "agentGeminiKey", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
    mistral: { keyName: "agentMistralKey", baseUrl: "https://api.mistral.ai/v1" },
    groq: { keyName: "agentGroqKey", baseUrl: "https://api.groq.com/openai/v1" },
    together: { keyName: "agentTogetherKey", baseUrl: "https://api.together.xyz/v1" },
    xai: { keyName: "agentXaiKey", baseUrl: "https://api.x.ai/v1" },
    opencode: { keyName: "agentOpencodeKey", baseUrl: "https://opencode.ai/zen/v1" },
    // Hosted mode has no user key: the relay injects its own upstream
    // credential. The extension treats it like a custom OpenAI-compatible
    // gateway whose URL comes from AGENT_DEFAULTS.hostedRelayUrl (user
    // override stored under agentHostedUrl).
    hosted: { keyName: "", baseUrl: "" },
  });

  const PROVIDER_FALLBACK_MODELS = Object.freeze({
    openrouter: {
      lite: "google/gemini-3.5-flash",
      pro: "anthropic/claude-sonnet-4.6",
    },
    anthropic: {
      lite: "claude-haiku-4-5",
      pro: "claude-sonnet-4-6",
    },
    openai: { lite: "gpt-5.4-mini", pro: "gpt-5.5" },
    deepseek: { lite: "deepseek-chat", pro: "deepseek-reasoner" },
    gemini: { lite: "gemini-flash-latest", pro: "gemini-pro-latest" },
    mistral: { lite: "mistral-small-latest", pro: "mistral-large-latest" },
    groq: { lite: "openai/gpt-oss-20b", pro: "openai/gpt-oss-120b" },
    together: {
      lite: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      pro: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
    xai: { lite: "grok-4-1-fast-non-reasoning", pro: "grok-4-6" },
    opencode: {
      lite: "deepseek-v4-flash-free",
      pro: "deepseek-v4-flash-free",
    },
    hosted: {
      lite: "deepseek-v4-flash-free",
      pro: "deepseek-v4-flash-free",
    },
    custom: { lite: "llama3", pro: "llama3" },
  });

  // Datalist presets shown in the options page per provider.
  const MODEL_PRESETS = Object.freeze({
    openrouter: [
      "google/gemini-3.5-flash",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.5",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    opencode: [
      "deepseek-v4-flash-free",
      "deepseek-v4-pro",
      "meta-llama/llama-3.3-70b-instruct:free",
    ],
    hosted: [
      "deepseek-v4-flash-free",
      "deepseek-v4-pro",
    ],
    anthropic: [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-opus-5",
    ],
    openai: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano", "gpt-5.5"],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    gemini: [
      "gemini-flash-latest",
      "gemini-pro-latest",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ],
    mistral: [
      "mistral-small-latest",
      "mistral-medium-latest",
      "mistral-large-latest",
      "codestral-latest",
    ],
    groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.6-27b"],
    together: [
      "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
    ],
    xai: ["grok-4-1-fast-non-reasoning", "grok-4-1-fast-reasoning", "grok-4-6"],
    custom: ["llama3", "mistral", "qwen2.5-coder", "phi3"],
  });

  // USD per 1K tokens: [input, output]. Published list prices, August 2026.
  // Keys are matched exact-first, then longest-substring-first, so specific
  // entries always win over generic family entries.
  const MODEL_PRICES = Object.freeze({
    // Anthropic (family keys also match OpenRouter slugs like
    // "anthropic/claude-sonnet-4.6")
    "claude-haiku": [0.001, 0.005],
    "claude-sonnet": [0.003, 0.015],
    "claude-opus": [0.005, 0.025],
    // OpenAI
    "gpt-5.4-mini": [0.00075, 0.0045],
    "gpt-5.4-nano": [0.0002, 0.00125],
    "gpt-5.4": [0.0025, 0.015],
    "gpt-5.5": [0.005, 0.03],
    "gpt-5": [0.00125, 0.01],
    "gpt-4o-mini": [0.00015, 0.0006],
    "gpt-4o": [0.0025, 0.01],
    // Groq-hosted open-weight models
    "gpt-oss-20b": [0.0001, 0.0005],
    "gpt-oss-120b": [0.00015, 0.00075],
    // Google
    "gemini-3.5-flash": [0.0015, 0.009],
    "gemini-flash-latest": [0.0015, 0.009],
    "gemini-3.1-pro": [0.002, 0.012],
    "gemini-pro-latest": [0.002, 0.012],
    "gemini-2.5-flash": [0.0003, 0.0025],
    "gemini-2.5-pro": [0.00125, 0.01],
    // DeepSeek
    "deepseek-v4-flash-free": [0, 0],
    "deepseek-chat": [0.00028, 0.00042],
    "deepseek-reasoner": [0.00028, 0.00042],
    // xAI
    "grok-4-1-fast": [0.0002, 0.0005],
    "grok-4-6": [0.002, 0.006],
    // Meta Llama (Together-hosted pricing)
    "llama-3.3-70b": [0.00088, 0.00088],
    "llama-3.1-8b": [0.00018, 0.00018],
    llama: [0.0002, 0.0006],
    // Mistral
    "mistral-small": [0.0001, 0.0003],
    "mistral-medium": [0.0004, 0.002],
    "mistral-large": [0.002, 0.006],
    codestral: [0.0003, 0.0009],
    default: [0.0005, 0.002],
  });

  // Model families with vision (image input) support, matched by substring.
  // Used to decide whether the agent auto-attaches marked screenshots each
  // step. Unknown models default to text-only (request_screenshot still
  // works and the 400-vision fallback catches optimistic mistakes).
  const VISION_MODEL_PATTERNS = Object.freeze([
    "claude",
    "gpt-5",
    "gpt-4o",
    "gpt-4.1",
    "chatgpt",
    "gemini",
    "grok-4",
    "grok-3",
    "pixtral",
    "llama-4",
    "llama4",
    "qwen-vl",
    "qwen2-vl",
    "qwen3-vl",
    "vision",
    "mistral-medium",
    "mistral-large",
  ]);

  /** True when the model id belongs to a known vision-capable family. */
  function isVisionModel(modelName) {
    const nameLower = String(modelName || "").toLowerCase();
    if (!nameLower) return false;
    return VISION_MODEL_PATTERNS.some((pattern) => nameLower.includes(pattern));
  }

  const PRICE_KEYS_LONGEST_FIRST = Object.freeze(
    Object.keys(MODEL_PRICES)
      .filter((key) => key !== "default")
      .sort((a, b) => b.length - a.length),
  );

  /**
   * Resolves the [input, output] USD-per-1K-token rates for a model id.
   * Exact key match wins; otherwise the longest matching substring key wins,
   * so "gpt-5.4-mini" never resolves to the "gpt-5" family rate.
   */
  function findModelRates(modelName) {
    const nameLower = String(modelName || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MODEL_PRICES, nameLower) && nameLower !== "default") {
      return MODEL_PRICES[nameLower];
    }
    for (const key of PRICE_KEYS_LONGEST_FIRST) {
      if (nameLower.includes(key)) return MODEL_PRICES[key];
    }
    return MODEL_PRICES.default;
  }

  const api = Object.freeze({
    AGENT_DEFAULTS,
    PROVIDER_ENDPOINTS,
    PROVIDER_FALLBACK_MODELS,
    MODEL_PRESETS,
    MODEL_PRICES,
    VISION_MODEL_PATTERNS,
    findModelRates,
    isVisionModel,
  });

  root.SELECT_TO_AI_DEFAULTS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
