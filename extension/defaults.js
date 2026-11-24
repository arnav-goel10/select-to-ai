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
    // OpenRouter's free router works with no credit card and survives any
    // single free model being rate limited or retired (verified Sep 2026:
    // 3/3 agent actions correct at ~4s per step). OpenCode's free models
    // refuse calls from outside the OpenCode app, so they cannot be a default.
    activeProvider: "openrouter",
    model: "openrouter/free",
    customUrl: "http://localhost:11434/v1",
    // How long a run works before it asks the user whether to go on.
    checkInMinutes: 5,
    // Spending limit per task in US dollars; 0 is none.
    costBudget: 0,
  });

  // Features that ship turned off until they have been run end to end.
  // Sign in with ChatGPT is tested only against a played OpenAI
  // (tests/unit/chatgpt.test.js), never on a real Plus plan, so its buttons
  // are not shown and the worker refuses to start it.
  const FEATURES = Object.freeze({
    chatgptSignIn: false,
  });

  // Per-provider fallback models used when the configured model is not valid
  // for the active provider. "lite" is the cheap default, "pro" the flagship.
  // Catalog verified against the providers' live model lists on 28 Sep 2026,
  // and again on 24 Nov 2026, when retired ids were taken out of the presets.
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
    cerebras: { keyName: "agentCerebrasKey", baseUrl: "https://api.cerebras.ai/v1" },
  });

  const PROVIDER_FALLBACK_MODELS = Object.freeze({
    openrouter: {
      // "openrouter/free" is OpenRouter's own router across its free tier:
      // tool calling and vision, and it survives any single free model being
      // rate limited or retired, which hardcoded free ids do not.
      lite: "openrouter/free",
      pro: "anthropic/claude-sonnet-4.6",
    },
    anthropic: {
      lite: "claude-haiku-5-5",
      pro: "claude-sonnet-5-5",
    },
    openai: { lite: "gpt-5.4-mini", pro: "gpt-5.5" },
    // DeepSeek retired the names deepseek-chat and deepseek-reasoner on
    // 24 Jul 2026 (its API updates page, checked 24 Nov 2026).
    deepseek: { lite: "deepseek-flash", pro: "deepseek-v4-pro" },
    gemini: { lite: "gemini-flash-latest", pro: "gemini-pro-latest" },
    // On Mistral's free plan (checked 1 Oct 2026) medium allows 1,000 requests a
    // minute and large 15, so an agent run uses medium.
    mistral: { lite: "mistral-small-latest", pro: "mistral-medium-latest" },
    groq: { lite: "openai/gpt-oss-20b", pro: "openai/gpt-oss-120b" },
    // Together's serverless list (checked 24 Nov 2026) no longer has the
    // Llama 3 Turbo models or DeepSeek-V3.
    together: {
      lite: "openai/gpt-oss-120b",
      pro: "deepseek-ai/DeepSeek-V4-Pro-0813",
    },
    // xAI retired the grok-4-1-fast models on 15 May 2026 and sends their
    // names to grok-4.3; its model list spells the flagship grok-4.6.
    xai: { lite: "grok-4.3", pro: "grok-4.6" },
    // OpenCode Zen is a paid gateway from an extension: its "-free" models
    // answer "free tier can only be used from within OpenCode".
    opencode: {
      lite: "deepseek-v4.1-flash",
      pro: "claude-sonnet-5",
    },
    // Cerebras's free tier (checked 1 Oct 2026): gpt-oss-120b allows 5 requests
    // a minute, Qwen3.8 27B 450 a minute, so an agent run uses Qwen.
    cerebras: { lite: "qwen-3.8-27b", pro: "qwen-3.8-27b" },
    // Signed in with ChatGPT, the account's own model list decides
    // (chatgptAuth.js bestModel). This is the model OpenAI's plan-usage
    // guide uses in its examples, for before that list has loaded.
    chatgpt: { lite: "gpt-6.1-sol", pro: "gpt-6.1-sol" },
    custom: { lite: "llama3", pro: "llama3" },
  });

  // Datalist presets shown in the options page per provider.
  const MODEL_PRESETS = Object.freeze({
    openrouter: [
      "openrouter/free",
      "nvidia/nemotron-3.5-lightning:free",
      "google/gemma-4-31b-it:free",
      "google/gemini-3.8-flash",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-6-luna",
      "openai/gpt-5.4-mini",
      "deepseek/deepseek-v4.1-flash",
    ],
    opencode: [
      "deepseek-v4.1-flash",
      "gpt-6-luna",
      "gpt-5.4-mini",
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "gemini-3.8-flash",
    ],
    anthropic: [
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ],
    openai: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano", "gpt-5.5"],
    deepseek: ["deepseek-flash", "deepseek-v4-pro"],
    gemini: [
      "gemini-flash-latest",
      "gemini-pro-latest",
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
    ],
    mistral: [
      "mistral-small-latest",
      "mistral-medium-latest",
      "mistral-large-latest",
      "codestral-latest",
    ],
    groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
    together: [
      "openai/gpt-oss-120b",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "deepseek-ai/DeepSeek-V4-Pro-0813",
    ],
    xai: ["grok-4.3", "grok-4.6"],
    cerebras: ["qwen-3.8-27b", "gpt-oss-120b"],
    // Filled from the signed-in account's model list instead.
    chatgpt: [],
    custom: ["llama3", "mistral", "qwen2.5-coder", "phi3"],
  });

  // Providers with a free tier that can serve as a backup when the main
  // provider's limit runs out, in the order they are suggested. Checked
  // against the providers' own pages, Sep 2026.
  const FREE_BACKUPS = Object.freeze([
    Object.freeze({ provider: "gemini", model: "gemini-flash-latest", note: "Free on its Flash models, no card. Outside the EU and UK, Google may use free-tier prompts to improve its products." }),
    Object.freeze({ provider: "cerebras", model: "qwen-3.8-27b", note: "Free and fast, with generous limits on Qwen3.8 27B." }),
    Object.freeze({ provider: "groq", model: "openai/gpt-oss-120b", note: "Free: 1,000 requests a day, but only 8,000 tokens a minute, so better for questions than long tasks." }),
  ]);

  // What a free path allows in a day, said where the user picks it and not
  // first when it runs out. OpenRouter: 50 requests a day on free models,
  // 1,000 once the account has bought $10 of credit (the figures its own
  // 429 and usageLimits.js already state). The reply headers carry the real
  // figure for a key, which is shown in its place once known.
  const FREE_CAPS = Object.freeze({
    openrouter: Object.freeze({ daily: 50, raised: 1000, credit: 10 }),
  });

  /** One plain sentence on a provider's free daily cap, or "" when it has none on file. */
  function freeCapNote(provider) {
    const cap = FREE_CAPS[provider];
    if (!cap) return "";
    return `The free models take ${cap.daily} requests a day (${cap.raised.toLocaleString("en-US")} after adding $${cap.credit} of credit once), and one task uses several.`;
  }

  /**
   * What is left of an allowance, in the words the model pill shows:
   * {short, title}, or null when there is nothing current to show.
   * @param a {provider, remaining, limit, resetAt} as the engine kept it
   */
  function allowanceLabel(a, provider, now) {
    if (!a || a.provider !== provider || !(a.resetAt > now) || !Number.isFinite(a.remaining)) return null;
    let clock = "";
    try { clock = new Date(a.resetAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (_e) { /* no Intl */ }
    const count = a.remaining.toLocaleString("en-US");
    const of = a.limit > 0 ? ` of ${a.limit.toLocaleString("en-US")}` : "";
    return { short: `${count} left`, title: `${count}${of} requests left${clock ? `, back to full at ${clock}` : ""}.` };
  }

  // What "openrouter/free" is sent as. The free router picks at random
  // among every free model that accepts the request, which has meant a 2.6B
  // model, a note-taking preview and a content-safety classifier. These are
  // asked first, in order; OpenRouter moves down the list when one is rate
  // limited or down, and the router itself is the last resort. Checked Sep
  // 2026 with tests/decisions: qwen3.8-27b and nemotron-3-super each made
  // 28 of 28 next-step decisions right. gemma-4-31b was rate limited for
  // most of the run, so it could not be scored and comes after them.
  // On 24 Nov 2026 OpenRouter's public model list no longer had the first
  // two. They stay here until a measured run picks what replaces them,
  // since this chain decides which model the default free path acts with.
  const OPENROUTER_FREE_CHAIN = Object.freeze([
    "qwen/qwen3.8-27b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "google/gemma-4-31b-it:free",
    "openrouter/free",
  ]);

  // Models of one provider that stand in for each other when one is
  // overloaded (HTTP 503 "high demand") or out of its own per-model
  // allowance (429), in the order they are tried. Seen
  // 1 Oct 2026: Gemini's free Flash models answered 503 for hours while the
  // Flash-Lite ones answered at once.
  const MODEL_SIBLINGS = Object.freeze({
    gemini: Object.freeze(["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]),
    mistral: Object.freeze(["mistral-medium-latest", "mistral-small-latest", "ministral-14b-latest"]),
  });

  /** The next model to try after `tried` were overloaded, or "" when there is none. */
  function siblingModel(provider, model, tried) {
    const chain = MODEL_SIBLINGS[provider] || [];
    if (!chain.includes(model)) return "";
    const done = new Set([...(tried || []), model]);
    return chain.find((m) => !done.has(m)) || "";
  }

  // How much a model is shown and asked for in one step. A small model
  // does better with a shorter page listing and fewer actions at once
  // ("Read More, Think More", Apr 2026: compact listings suit smaller
  // models; long inputs make them invent). The text budget is generous on purpose: on
  // 1 Oct 2026, with 3,600 characters of page text, read was the commonest
  // action of a small model's runs, each one a whole model call spent on
  // seeing a little more. A frontier model reads more and does more per
  // step. Every model's finished answer is checked (core/run.js), whatever
  // its size.
  const TIER_LIMITS = Object.freeze({
    small: Object.freeze({ tier: "small", lines: 140, pageBudget: 8000, maxActions: 5 }),
    standard: Object.freeze({ tier: "standard", lines: 220, pageBudget: 12000, maxActions: 6 }),
    frontier: Object.freeze({ tier: "frontier", lines: 320, pageBudget: 24000, maxActions: 8 }),
  });
  // The tier of each model the extension lists (its presets, fallbacks,
  // free backups and siblings), set by hand per model and reviewed here,
  // not guessed from words in its name. Every listed model is in one of
  // the three lists (tests/unit/defaults.test.js), each at the tier it had
  // before the table (tests/unit/model-tiers.test.js). A model the
  // extension does not list, typed by the user, is placed by tierOf below.
  const MODEL_TIERS = Object.freeze({
    small: Object.freeze([
      "anthropic/claude-haiku-4.5", "claude-haiku-4-5", "claude-haiku-5-5", "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "google/gemma-4-31b-it:free", "gpt-5.4-mini", "gpt-5.4-nano",
      "ministral-14b-latest", "mistral-small-latest",
      "openai/gpt-5.4-mini", "openai/gpt-oss-20b", "openrouter/free", "qwen-3.8-27b", "qwen/qwen3.8-27b",
      "qwen/qwen3.8-27b:free"
    ]),
    standard: Object.freeze([
      "codestral-latest", "deepseek-ai/DeepSeek-V4-Pro-0813", "deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-flash",
      "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", "gemini-3.8-flash", "gemini-flash-latest",
      "google/gemini-3.8-flash", "gpt-oss-120b", "llama3", "mistral",
      "mistral-large-latest", "mistral-medium-latest", "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-120b", "phi3", "qwen2.5-coder"
    ]),
    frontier: Object.freeze([
      "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-5", "claude-opus-5-5", "claude-sonnet-4-6",
      "claude-sonnet-5", "claude-sonnet-5-5", "gemini-3.1-pro-preview", "gemini-pro-latest", "gpt-5.4",
      "gpt-5.5", "gpt-6-luna", "gpt-6.1-sol", "grok-4.3", "grok-4.6",
      "openai/gpt-6-luna"
    ]),
  });
  const TIER_OF = new Map(Object.entries(MODEL_TIERS).flatMap(([tier, ids]) => ids.map((id) => [id, tier])));

  // LEGACY FALLBACK, kept as it was before the table so that no model's
  // tier moves: how a model the table does not list was placed by its name. A family known to be a
  // maker's largest; else a parameter count in the name ("-20b", "550b");
  // else a word that marks a maker's small model, as a whole word ("mini"
  // is not the end of "gemini"); else mid-sized. It reads words in the
  // name, which is why it is only the last resort.
  const LEGACY_FRONTIER_FAMILY = /claude-(fable|opus|sonnet)|gpt-(5|6)(?![\w.-]*(mini|nano))|gemini-[\w.-]*pro|grok-4/i;
  const LEGACY_SMALL_WORD = /(?:^|[^a-z])(mini|nano|lite|small|haiku|ministral|tiny)(?![a-z])|openrouter\/free|(?:^|[^a-z0-9])e\d+b(?![a-z0-9])/i;
  function legacyNameTier(id) {
    const name = String(id || "");
    if (LEGACY_FRONTIER_FAMILY.test(name)) return "frontier";
    let size = 0;
    for (const m of name.matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)) size = Math.max(size, parseFloat(m[1]));
    if (size >= 200) return "frontier";
    if (size > 0) return size < 40 ? "small" : "standard";
    return LEGACY_SMALL_WORD.test(name) ? "small" : "standard";
  }

  /**
   * A model's tier: the tier the table sets for a model the extension
   * lists, else the legacy fallback above, which is the tier the name gave
   * before the table, unchanged.
   */
  function tierOf(id) {
    return TIER_OF.get(String(id || "")) || legacyNameTier(id);
  }
  /** The listing size, page budget and actions per step for a model, by its tier. */
  function limitsFor(id) {
    return TIER_LIMITS[tierOf(id)];
  }

  // Claude models that think adaptively (thinking: {type: "adaptive"}) and
  // refuse a thinking budget; the same models refuse a forced tool while
  // thinking, so the tool is offered to them, never forced.
  const CLAUDE_ADAPTIVE = /claude-(?:fable|mythos|haiku-[5-9]|sonnet-(?:[5-9]|4-6)|opus-(?:[5-9]|4-[6-9]))/i;
  const CLAUDE_FIXED_SAMPLING = /claude-(?:fable|mythos|haiku-[5-9]|sonnet-[5-9]|opus-(?:[5-9]|4-[7-9]))/i;

  // Sampling the makers themselves ask for, where a low temperature is
  // known to hurt: Gemini 3 ("lower values can cause looping", Gemini 3
  // guide, Sep 2026), Qwen3 ("do not use greedy decoding", model card), and
  // reasoning models that take no temperature at all. Everything else keeps
  // the steady 0.1 the agent has always used.
  const MODEL_SAMPLING = Object.freeze([
    [/gemini-3/i, Object.freeze({ temperature: 1 })],
    [/qwen/i, Object.freeze({ temperature: 0.6 })],
    [/^(gpt-(5|6)|o\d)/i, Object.freeze({ temperature: null })],
    // Anthropic's current models refuse a temperature other than their own
    // (Haiku 5.5 and Sonnet 5.5 take only 1; Opus 4.7 and later take none).
    [CLAUDE_FIXED_SAMPLING, Object.freeze({ temperature: null })],
  ]);
  // Models that think before they answer need room for both. DeepSeek's
  // V4 line thinks by default ("Thinking mode is enabled by default", its
  // thinking-mode guide, 24 Nov 2026), and deepseek-flash is its V4.1 Flash,
  // so every deepseek-flash and deepseek-v4 id thinks, wherever it is hosted.
  const THINKING_MODELS = /gpt-oss|nemotron|qwen|gemini|deepseek-(r|flash|v4)|magistral|claude-(fable|mythos|opus|sonnet|haiku-[5-9])|gpt-(5|6)|grok-4|:free|openrouter\/free/i;

  /** What a run on this model is given: listing size, actions per step, sampling, and whether it thinks. */
  function modelProfile(model) {
    const id = String(model || "");
    const base = limitsFor(id);
    const sampling = (MODEL_SAMPLING.find(([re]) => re.test(id)) || [null, { temperature: 0.1 }])[1];
    const thinks = THINKING_MODELS.test(id);
    return { ...base, temperature: sampling.temperature, maxTokens: thinks ? 6000 : 4000, thinks, adaptive: CLAUDE_ADAPTIVE.test(id) };
  }

  // Who is calling, for OpenRouter's app attribution. HTTP-Referer is the
  // app's URL and X-Title its name (openrouter.ai/docs/app-attribution,
  // checked 16 Nov 2026: X-Title is still accepted). The URL is the
  // project's own repository, the same one the manifest's homepage_url
  // names. welcome.js sends the same two values on its key test.
  const OPENROUTER_ATTRIBUTION = Object.freeze({
    "HTTP-Referer": "https://github.com/arnav-goel10/select-to-ai",
    "X-Title": "Select to AI",
  });

  /**
   * The model id a request really carries. "openrouter/free" goes out as
   * the first model of the free chain, so its sampling has to be that
   * model's, not the router's: asked as "openrouter/free" at 0.1, Qwen was
   * being sent the greedy decoding its own card warns against.
   */
  function outgoingModel(provider, model, bare) {
    return provider === "openrouter" && model === "openrouter/free" && !bare ? OPENROUTER_FREE_CHAIN[0] : model;
  }

  /**
   * Extra request fields for OpenRouter: the free chain in place of the
   * bare free router, and one tool call per reply. `bare` sends
   * "openrouter/free" as it is, for a connection that refused the chain
   * (a free model in it retired or renamed).
   */
  function openRouterOptions(model, hasTool, bare) {
    const out = {};
    const sent = outgoingModel("openrouter", model, bare);
    if (sent !== model) {
      out.model = sent;
      out.models = OPENROUTER_FREE_CHAIN.slice(1);
    }
    if (hasTool) out.parallel_tool_calls = false;
    return out;
  }

  /**
   * The model the agent runs on after switching to a backup provider. A free
   * backup names the model its free tier covers; any other backup is the
   * user's own paid key, so the agent keeps a full-strength model.
   */
  function backupModelFor(provider) {
    const free = FREE_BACKUPS.find((b) => b.provider === provider);
    if (free && free.model) return free.model;
    const models = PROVIDER_FALLBACK_MODELS[provider] || {};
    return models.pro || models.lite || "";
  }

  // USD per 1K tokens: [input, output]. Published list prices, August 2026.
  // Keys are matched exact-first, then longest-substring-first, so specific
  // entries always win over generic family entries.
  const MODEL_PRICES = Object.freeze({
    // Anthropic (family keys also match OpenRouter slugs like
    // "anthropic/claude-sonnet-4.6")
    // Anthropic list prices (platform.claude.com pricing, checked 6 Nov 2026).
    // Haiku 5.5 is $0.10/$0.50 up to 100K prompt tokens ($0.50/$2.50 above).
    "claude-haiku-5": [0.0001, 0.0005],
    "claude-sonnet-5": [0.002, 0.01],
    "claude-opus-5-5": [0.004, 0.02],
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
    // Gemini 3.8 Flash list price from 1 Jan 2027 (half that until then),
    // Google's pricing page, 24 Nov 2026.
    "gemini-3.8-flash": [0.0015, 0.0075],
    "gemini-3.5-flash": [0.0015, 0.009],
    "gemini-flash-latest": [0.0015, 0.009],
    "gemini-3.1-pro": [0.002, 0.012],
    "gemini-pro-latest": [0.002, 0.012],
    "gemini-2.5-flash": [0.0003, 0.0025],
    "gemini-2.5-pro": [0.00125, 0.01],
    // DeepSeek
    // Peak-hour list prices, cache miss (DeepSeek pricing page, 24 Nov 2026).
    "deepseek-flash": [0.0003, 0.0012],
    "deepseek-v4-pro": [0.00132, 0.00396],
    // The retired names, at the rate they had, for a setup that still has
    // one saved.
    "deepseek-chat": [0.00028, 0.00042],
    "deepseek-reasoner": [0.00028, 0.00042],
    // Together's serverless rate for its V4.1 Flash (its pricing page,
    // 24 Nov 2026). Exact, so OpenRouter's cheaper deepseek/deepseek-v4.1-flash
    // is not charged at it. Its V4 Pro id already matches deepseek-v4-pro,
    // which Together prices the same.
    "deepseek-ai/deepseek-v4.1-flash": [0.0003, 0.0012],
    // Groq on-demand, Qwen3.8 27B (its models page, 24 Nov 2026).
    "qwen/qwen3.8-27b": [0.0008, 0.004],
    // xAI
    // xAI's model list, 24 Nov 2026. A retired grok-4-1-fast name is
    // answered and billed as grok-4.3.
    "grok-4.3": [0.00125, 0.0025],
    "grok-4-1-fast": [0.00125, 0.0025],
    "grok-4.6": [0.002, 0.006],
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
    // Free-tier families shipped as OpenRouter presets. Without these the
    // agent silently drops to text-only DOM on a vision-capable free model.
    // "openrouter/free" is deliberately absent: the router may land on a
    // text-only model, so it runs on the DOM and asks for a screenshot only
    // when it needs one (request_screenshot).
    "gemma-4",
    "nemotron-nano-12b",
    "omni",
    "dots-3",
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
    // Free tiers are advertised by suffix, not by a price table entry:
    // OpenRouter uses ":free", other gateways use a "-free" id. Without this
    // the generic default rate applies and a zero-cost run reports a cost.
    if (
      nameLower.endsWith(":free") ||
      nameLower.endsWith("-free") ||
      nameLower === "openrouter/free"
    ) {
      return [0, 0];
    }
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
    FEATURES,
    PROVIDER_ENDPOINTS,
    PROVIDER_FALLBACK_MODELS,
    MODEL_PRESETS,
    FREE_BACKUPS,
    backupModelFor,
    OPENROUTER_FREE_CHAIN,
    OPENROUTER_ATTRIBUTION,
    openRouterOptions,
    outgoingModel,
    FREE_CAPS,
    freeCapNote,
    allowanceLabel,
    MODEL_SIBLINGS,
    siblingModel,
    modelProfile,
    MODEL_TIERS,
    legacyNameTier,
    MODEL_PRICES,
    VISION_MODEL_PATTERNS,
    findModelRates,
    isVisionModel,
  });

  root.SELECT_TO_AI_DEFAULTS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
