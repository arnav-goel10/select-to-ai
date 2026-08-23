/**
 * Select to AI - Options Settings Logic
 * Handles tab navigation, theme toggling, provider settings swap, dynamic model fetching, and connection testing.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Verify CONFIG is loaded
  if (typeof CONFIG === "undefined") {
    console.error("Select to AI: CONFIG not loaded in options.");
    return;
  }

  const DEFAULT_SYSTEM_PROMPT = CONFIG.DEFAULT_SYSTEM_PROMPT;

  const { STORAGE } = CONFIG;
  // Shared runtime defaults, the options UI must reflect what the agent
  // actually runs (extension/defaults.js is the single source of truth).
  const SHARED = SELECT_TO_AI_DEFAULTS;
  const AGENT_DEFAULTS = SHARED.AGENT_DEFAULTS;

  // Helper to proxy fetch requests to background script to bypass CORS.
  // `candidateCustomUrl` lets the options page test a TYPED (not yet saved)
  // custom-gateway URL: the background validates that candidate through the
  // same origin rules and accepts it for this single request only.
  function fetchProxy(url, options = {}, candidateCustomUrl = null, provider = null) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "fetchProxy",
          url: url,
          provider: provider,
          options: options,
          ...(candidateCustomUrl ? { candidateCustomUrl } : {}),
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.success) {
            reject(new Error(response?.error || "Unknown proxy fetch error"));
            return;
          }
          resolve({
            ok: response.ok,
            status: response.status,
            headers: {
              get: (name) => response.headers[name.toLowerCase()] || null,
            },
            text: () => Promise.resolve(response.text),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(response.text));
              } catch (e) {
                return Promise.reject(e);
              }
            },
          });
        },
      );
    });
  }

  // Default Provider Configurations.
  // Default models come from the shared catalog so the options UI always
  // matches the agent runtime's fallbacks.
  const PROVIDER_DEFAULTS = {
    opencode: {
      name: "OpenCode Zen",
      url: "https://opencode.ai/zen/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.opencode.lite,
      placeholder: "sk-...",
    },
    openrouter: {
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.openrouter.lite,
      placeholder: "sk-or-v1-...",
    },
    anthropic: {
      name: "Anthropic Claude",
      url: "https://api.anthropic.com/v1/messages",
      model: SHARED.PROVIDER_FALLBACK_MODELS.anthropic.lite,
      placeholder: "sk-ant-...",
    },
    openai: {
      name: "OpenAI",
      url: "https://api.openai.com/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.openai.lite,
      placeholder: "sk-proj-...",
    },
    deepseek: {
      name: "DeepSeek AI",
      url: "https://api.deepseek.com",
      model: SHARED.PROVIDER_FALLBACK_MODELS.deepseek.lite,
      placeholder: "sk-...",
    },
    gemini: {
      name: "Google Gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: SHARED.PROVIDER_FALLBACK_MODELS.gemini.lite,
      placeholder: "AIzaSy...",
    },
    mistral: {
      name: "Mistral AI",
      url: "https://api.mistral.ai/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.mistral.lite,
      placeholder: "API Key",
    },
    groq: {
      name: "Groq AI",
      url: "https://api.groq.com/openai/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.groq.lite,
      placeholder: "gsk_...",
    },
    together: {
      name: "Together AI",
      url: "https://api.together.xyz/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.together.lite,
      placeholder: "API Key",
    },
    xai: {
      name: "xAI Grok",
      url: "https://api.x.ai/v1",
      model: SHARED.PROVIDER_FALLBACK_MODELS.xai.lite,
      placeholder: "xai-...",
    },
    custom: {
      name: "Custom Gateway",
      url: AGENT_DEFAULTS.customUrl,
      model: SHARED.PROVIDER_FALLBACK_MODELS.custom.lite,
      placeholder: "API Key",
    },
  };

  // Keep track of unsaved provider keys in local session memory
  let cachedProviderKeys = {
    opencode: "",
    openrouter: "",
    anthropic: "",
    openai: "",
    deepseek: "",
    gemini: "",
    mistral: "",
    groq: "",
    together: "",
    xai: "",
    custom: "",
  };

  let previousProvider = "openrouter";
  let hasUnsavedChanges = false;

  function normalizeModelId(model) {
    return String(model || "")
      .replace(/^models\//, "")
      .toLowerCase();
  }

  function getModelVersionScore(id) {
    const normalized = normalizeModelId(id);
    let score = 0;
    const numericVersions = normalized.match(/\d+(?:\.\d+)?/g) || [];
    numericVersions.forEach((version, index) => {
      const parsed = parseFloat(version);
      if (!Number.isNaN(parsed) && parsed < 10000)
        score += parsed * (index === 0 ? 100 : 10);
    });
    const dateMatch = normalized.match(/20\d{6}/);
    if (dateMatch)
      score += Math.max(0, parseInt(dateMatch[0], 10) - 20200000) / 1000;
    if (normalized.includes("latest")) score += 1000;
    if (normalized.includes("preview")) score += 25;
    if (
      normalized.includes("beta") ||
      normalized.includes("experimental") ||
      normalized.includes("-exp")
    )
      score -= 30;
    if (normalized.includes("deprecated")) score -= 500;
    return score;
  }

  function scoreModelForTier(model, tier) {
    const id = normalizeModelId(model);
    let score = getModelVersionScore(id);
    if (tier === "lite") {
      if (
        /\b(flash|haiku|mini|nano|small|tiny|8b|7b|9b|instant|fast|lite)\b/.test(
          id,
        )
      )
        score += 450;
      if (
        /\b(pro|sonnet|opus|large|max|70b|405b|reason|thinking|r1|o1|o3)\b/.test(
          id,
        )
      )
        score -= 180;
      if (id.includes("vision") || id.includes("audio") || id.includes("image"))
        score -= 80;
    } else {
      if (
        /\b(pro|sonnet|opus|large|max|70b|405b|reason|thinking|r1|o1|o3|coder|code)\b/.test(
          id,
        )
      )
        score += 450;
      if (/\b(flash-lite|haiku|nano|tiny|7b|8b)\b/.test(id)) score -= 220;
      if (id.includes("mini") || id.includes("flash")) score -= 60;
    }
    if (
      id.includes("embedding") ||
      id.includes("embed") ||
      id.includes("moderation") ||
      id.includes("safety") ||
      id.includes("tts") ||
      id.includes("whisper")
    )
      score -= 100000;
    return score;
  }

  function findBestModel(
    fetchedModels,
    tier,
    defaultModel,
    excludedModel = null,
  ) {
    if (!fetchedModels || fetchedModels.length === 0) return defaultModel;
    const excluded = normalizeModelId(excludedModel);
    const candidates = [...new Set(fetchedModels)]
      .filter(Boolean)
      .filter((model) => !excluded || normalizeModelId(model) !== excluded);
    if (candidates.length === 0) return defaultModel;
    return (
      candidates.sort((a, b) => {
        const scoreDiff =
          scoreModelForTier(b, tier) - scoreModelForTier(a, tier);
        return scoreDiff !== 0
          ? scoreDiff
          : normalizeModelId(b).localeCompare(normalizeModelId(a), undefined, {
              numeric: true,
            });
      })[0] || defaultModel
    );
  }

  function sortModelsForDisplay(models) {
    return [...new Set(models)].filter(Boolean).sort((a, b) => {
      const versionDiff = getModelVersionScore(b) - getModelVersionScore(a);
      return versionDiff !== 0
        ? versionDiff
        : normalizeModelId(a).localeCompare(normalizeModelId(b), undefined, {
            numeric: true,
          });
    });
  }

  /**
   * Refills the datalist suggestions. The input value is only touched when
   * `fallbackValue` is provided AND the input is currently empty, a fetch
   * must never overwrite the user's chosen model.
   */
  function populateDatalist(inputElement, datalistElement, list, fallbackValue) {
    if (datalistElement) {
      while (datalistElement.firstChild)
        datalistElement.removeChild(datalistElement.firstChild);
      list.forEach((model) => {
        const opt = document.createElement("option");
        opt.value = model;
        datalistElement.appendChild(opt);
      });
    }
    if (inputElement && fallbackValue && !inputElement.value.trim()) {
      inputElement.value = fallbackValue;
    }
  }

  /**
   * Loads the provider's preset model suggestions into the datalist.
   * `replaceValue: true` (provider switch) swaps the input to the provider's
   * default model; otherwise the typed value is preserved.
   */
  function applyModelPresets(provider, { replaceValue = false } = {}) {
    const defs = PROVIDER_DEFAULTS[provider];
    const presets = SHARED.MODEL_PRESETS;
    const list = [...(presets[provider] || presets.openrouter)];
    if (replaceValue && modelSelect) {
      modelSelect.value = defs?.model || "";
    }
    populateDatalist(
      modelSelect,
      document.getElementById("agentModelList"),
      list,
      defs?.model || "",
    );
  }

  function getModelFetchRequest(provider, key, baseUrl) {
    const headers = {};
    let endpoint = baseUrl.replace(/\/$/, "") + "/models";
    if (provider === "anthropic") {
      endpoint = "https://api.anthropic.com/v1/models";
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "gemini") {
      endpoint = "https://generativelanguage.googleapis.com/v1beta/models";
      if (key) headers["x-goog-api-key"] = key;
    } else {
      if (key) headers["Authorization"] = `Bearer ${key}`;
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://selecttoai.github.io";
        headers["X-Title"] = "Select to AI Browser Agent Settings Page";
      }
    }
    return { endpoint, headers };
  }

  function getChatEndpoint(provider, baseUrl) {
    if (provider === "anthropic")
      return "https://api.anthropic.com/v1/messages";
    if (provider === "gemini")
      return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    if (
      !baseUrl.endsWith("/chat/completions") &&
      !baseUrl.includes("/messages")
    ) {
      return baseUrl.replace(/\/$/, "") + "/chat/completions";
    }
    return baseUrl;
  }

  function getConnectionTestRequest(provider, key, baseUrl, model) {
    const endpoint = getChatEndpoint(provider, baseUrl);
    const headers = { "Content-Type": "application/json" };
    let body;
    if (provider === "anthropic") {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      body = {
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Ping" }],
      };
    } else {
      if (key) headers["Authorization"] = `Bearer ${key}`;
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://selecttoai.github.io";
        headers["X-Title"] = "Select to AI Browser Agent Settings Page";
      }
      body = {
        model,
        messages: [{ role: "user", content: "Ping" }],
        max_tokens: 1,
      };
    }
    return { endpoint, headers, body };
  }

  function canFetchModelsWithoutKey(provider) {
    return provider === "openrouter" || provider === "custom";
  }

  function normalizeFetchedModels(provider, data) {
    if (provider === "gemini") {
      if (
        !data.models ||
        !Array.isArray(data.models) ||
        data.models.length === 0
      ) {
        throw new Error("No models returned from Google Gemini API.");
      }
      return data.models.map((model) => model.name.replace(/^models\//, ""));
    }
    const modelData = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    if (modelData.length === 0)
      throw new Error("No model list returned in response.");
    return modelData
      .map((model) =>
        typeof model === "string" ? model : model.id || model.name,
      )
      .filter(Boolean);
  }

  function getSelectableFetchedModels(provider, data, modelIds) {
    if (provider === "gemini") {
      const generationModelNames = new Set(
        (data.models || [])
          .filter((model) => {
            const methods = model.supportedGenerationMethods || [];
            return methods.length === 0 || methods.includes("generateContent");
          })
          .map((model) => normalizeModelId(model.name)),
      );
      return modelIds.filter((modelId) =>
        generationModelNames.has(normalizeModelId(modelId)),
      );
    }
    const rawModels = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    if (rawModels.length === 0) return modelIds;
    const selectableIds = new Set(
      rawModels
        .filter((model) => {
          if (typeof model === "string") return true;
          const id = normalizeModelId(model.id || model.name);
          const architecture = model.architecture || {};
          const inputModalities = architecture.input_modalities || [];
          const outputModalities = architecture.output_modalities || [];
          const modality = String(architecture.modality || "").toLowerCase();
          if (
            id.includes("embedding") ||
            id.includes("embed") ||
            id.includes("moderation") ||
            id.includes("safety") ||
            id.includes("tts") ||
            id.includes("whisper")
          )
            return false;
          if (outputModalities.length > 0 && !outputModalities.includes("text"))
            return false;
          if (inputModalities.length > 0 && !inputModalities.includes("text"))
            return false;
          if (modality && !modality.includes("->text")) return false;
          return true;
        })
        .map((model) =>
          normalizeModelId(
            typeof model === "string" ? model : model.id || model.name,
          ),
        )
        .filter(Boolean),
    );
    return modelIds.filter((modelId) =>
      selectableIds.has(normalizeModelId(modelId)),
    );
  }

  // --- DOM Elements ---

  // Sidebar Tabs
  const navItems = document.querySelectorAll(".nav-item");
  const panels = document.querySelectorAll(".panel");

  // Theme Toggle
  const themeToggleBtn = document.getElementById("theme-toggle");

  // Save & Reset Buttons
  const saveAllBtn = document.getElementById("save-all-btn");
  const resetAllBtn = document.getElementById("reset-all-btn");
  const resetPromptBtn = document.getElementById("reset-prompt-btn");

  // General Form Inputs
  const showChatGPTCheck = document.getElementById("showChatGPT");
  const showGeminiCheck = document.getElementById("showGemini");
  const showPerplexityCheck = document.getElementById("showPerplexity");
  const showClaudeCheck = document.getElementById("showClaude");
  const showAgentCheck = document.getElementById("showAgent");
  const autoSendCheck = document.getElementById("autoSend");
  const smartRoutingCheck = document.getElementById("omniboxSmartRouting");
  const autoContextCheck = document.getElementById("autoContext");
  const openingModeSelect = document.getElementById("openingMode");

  // Model & API Inputs
  const activeProviderSelect = document.getElementById("agentActiveProvider");
  const customUrlGroup = document.getElementById("url-group");
  const customUrlInput = document.getElementById("agentCustomUrl");

  const fetchModelsBtn = document.getElementById("fetch-models-btn");
  const testConnBtn = document.getElementById("test-conn-btn");
  const connStatus = document.getElementById("conn-status");

  // Model Dropdowns
  const modelSelect = document.getElementById("agentModel");

  // Step Cap Limit
  const maxStepsSlider = document.getElementById("agentMaxSteps");
  const maxStepsVal = document.getElementById("max-steps-val");

  // Prompt Inputs
  const systemPromptTextarea = document.getElementById("agentSystemPrompt");

  // Toast Message
  const toast = document.getElementById("toast");
  const toastMessage = document.getElementById("toast-message");

  // --- Tab Switching ---
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const targetId = item.getAttribute("data-target");

      navItems.forEach((nav) => nav.classList.remove("active"));
      item.classList.add("active");

      panels.forEach((panel) => {
        if (panel.id === targetId) {
          panel.classList.add("active");
        } else {
          panel.classList.remove("active");
        }
      });
    });
  });

  // --- Theme Switcher ---
  function updateThemeToggleLabel(theme) {
    if (!themeToggleBtn) return;
    themeToggleBtn.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
    );
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const newTheme = currentTheme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", newTheme);
      updateThemeToggleLabel(newTheme);
      chrome.storage.sync.set({ theme: newTheme });
    });
  }

  // --- Password Visibility Toggle ---
  document.querySelectorAll(".provider-key-eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = document.getElementById(targetId);
      if (input.type === "password") {
        input.type = "text";
        btn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                `;
      } else {
        input.type = "password";
        btn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                `;
      }
    });
  });

  // --- Slider UI updates ---
  maxStepsSlider.addEventListener("input", () => {
    maxStepsVal.textContent = maxStepsSlider.value;
  });

  // --- Provider Selection Swap ---
  // Shows only the active provider's key field and swaps the model input to
  // that provider's default plus its preset suggestions.
  activeProviderSelect.addEventListener("change", () => {
    const provider = activeProviderSelect.value;
    applyModelPresets(provider, { replaceValue: true });
    document.querySelectorAll(".provider-key-group").forEach((group) => {
      group.style.display = group.id === "group-" + provider ? "flex" : "none";
    });
    if (provider === "custom") {
      customUrlGroup.style.display = "block";
    } else {
      customUrlGroup.style.display = "none";
    }
  });

  function getActiveProviderKey() {
    const provider = activeProviderSelect.value;
    switch (provider) {
      case "opencode":
        return document.getElementById("agentOpencodeKey").value.trim();
      case "openrouter":
        return document.getElementById("agentOpenRouterKey").value.trim();
      case "anthropic":
        return document.getElementById("agentAnthropicKey").value.trim();
      case "openai":
        return document.getElementById("agentOpenAIKey").value.trim();
      case "deepseek":
        return document.getElementById("agentDeepSeekKey").value.trim();
      case "gemini":
        return document.getElementById("agentGeminiKey").value.trim();
      case "mistral":
        return document.getElementById("agentMistralKey").value.trim();
      case "groq":
        return document.getElementById("agentGroqKey").value.trim();
      case "together":
        return document.getElementById("agentTogetherKey").value.trim();
      case "xai":
        return document.getElementById("agentXaiKey").value.trim();
      case "custom":
        return document.getElementById("agentCustomKey").value.trim();
      default:
        return "";
    }
  }

  function getProviderKeyValidationError(provider, apiKey) {
    const key = (apiKey || "").trim();
    if (provider === "custom") return "";
    if (!key)
      return `Missing API key for ${PROVIDER_DEFAULTS[provider]?.name || provider}.`;
    if (
      key === "sk-or-v1-..." ||
      key === "sk-proj-..." ||
      key === "sk-ant-..." ||
      key === "AIzaSy..." ||
      key === "gsk_..." ||
      key.toLowerCase() === "api key"
    ) {
      return `The ${PROVIDER_DEFAULTS[provider]?.name || provider} key looks like a placeholder, not a real key.`;
    }
    if (provider === "openrouter" && !key.startsWith("sk-or-"))
      return 'OpenRouter keys usually start with "sk-or-".';
    if (provider === "anthropic" && !key.startsWith("sk-ant-"))
      return 'Anthropic keys usually start with "sk-ant-".';
    if (provider === "openai" && !key.startsWith("sk-"))
      return 'OpenAI keys usually start with "sk-".';
    if (provider === "gemini" && !key.startsWith("AIza"))
      return 'Gemini API keys usually start with "AIza".';
    if (provider === "groq" && !key.startsWith("gsk_"))
      return 'Groq keys usually start with "gsk_".';
    if (provider === "xai" && !key.startsWith("xai-"))
      return 'xAI keys usually start with "xai-".';
    return "";
  }

  function setProviderKey(provider, key) {
    const inputId = {
      opencode: "agentOpencodeKey",
      openrouter: "agentOpenRouterKey",
      anthropic: "agentAnthropicKey",
      openai: "agentOpenAIKey",
      deepseek: "agentDeepSeekKey",
      gemini: "agentGeminiKey",
      mistral: "agentMistralKey",
      groq: "agentGroqKey",
      together: "agentTogetherKey",
      xai: "agentXaiKey",
      custom: "agentCustomKey",
    }[provider];
    if (inputId) {
      const input = document.getElementById(inputId);
      if (input) input.value = key;
    }
  }

  // --- Load Settings on Launch ---
  function loadSettings() {
    const legacyKeys = STORAGE.API_KEYS;
    chrome.storage.sync.get([...STORAGE.SETTINGS, ...legacyKeys], (syncItems) => {
      chrome.storage.local.get(legacyKeys, (localItems) => {
        const migratedKeys = {};
        legacyKeys.forEach((key) => {
          if (!localItems[key] && syncItems[key]) migratedKeys[key] = syncItems[key];
        });
        const items = { ...syncItems, ...localItems, ...migratedKeys };

        if (Object.keys(migratedKeys).length > 0) {
          chrome.storage.local.set(migratedKeys);
        }
        chrome.storage.sync.remove(legacyKeys);

      showChatGPTCheck.checked = items.showChatGPT !== false;
      showGeminiCheck.checked = items.showGemini !== false;
      showPerplexityCheck.checked = items.showPerplexity === true;
      showClaudeCheck.checked = items.showClaude !== false;
      showAgentCheck.checked = items.showAgent === true;
      autoSendCheck.checked = items.autoSend === true;
      if (smartRoutingCheck) smartRoutingCheck.checked = items.omniboxSmartRouting !== false;
      autoContextCheck.checked = items.autoContext !== false;
      openingModeSelect.value = items.openingMode || "sidePanel";

      const theme =
        items.theme ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light");
      document.documentElement.setAttribute("data-theme", theme);
      updateThemeToggleLabel(theme);

      const activeProvider =
        items.agentActiveProvider || AGENT_DEFAULTS.activeProvider;
      activeProviderSelect.value = activeProvider;
      previousProvider = activeProvider;

      document.getElementById("agentOpenRouterKey").value =
        items.agentOpenRouterKey || "";
      document.getElementById("agentAnthropicKey").value =
        items.agentAnthropicKey || "";
      document.getElementById("agentOpenAIKey").value =
        items.agentOpenAIKey || "";
      document.getElementById("agentDeepSeekKey").value =
        items.agentDeepSeekKey || "";
      document.getElementById("agentGeminiKey").value =
        items.agentGeminiKey || "";
      document.getElementById("agentMistralKey").value =
        items.agentMistralKey || "";
      document.getElementById("agentGroqKey").value = items.agentGroqKey || "";
      document.getElementById("agentTogetherKey").value =
        items.agentTogetherKey || "";
      document.getElementById("agentXaiKey").value = items.agentXaiKey || "";
      document.getElementById("agentOpencodeKey").value =
        items.agentOpencodeKey || "";
      document.getElementById("agentCustomKey").value =
        items.agentCustomKey || "";

      document.querySelectorAll(".provider-key-group").forEach((group) => {
        group.style.display =
          group.id === "group-" + activeProvider ? "flex" : "none";
      });

      if (activeProvider === "custom") {
        customUrlGroup.style.display = "block";
      }

      customUrlInput.value = items.agentCustomUrl || "";

      const defs = PROVIDER_DEFAULTS[activeProvider];
      if (defs) {
        modelSelect.value = items.agentModel || defs.model || "";
      }
      // Seed the datalist with the provider's presets (value preserved).
      applyModelPresets(activeProvider);

      // Fallbacks mirror the shared runtime defaults so the UI shows what
      // the agent actually runs with when a setting was never saved.
      maxStepsSlider.value = items.agentMaxSteps || AGENT_DEFAULTS.maxSteps;
      maxStepsVal.textContent = items.agentMaxSteps || AGENT_DEFAULTS.maxSteps;

      const temp =
        items.agentTemperature !== undefined
          ? items.agentTemperature
          : AGENT_DEFAULTS.temperature;
      document.getElementById("agentTemperature").value = temp;
      document.getElementById("temp-val").textContent = temp;

      document.getElementById("agentElementLimit").value =
        items.agentElementLimit || AGENT_DEFAULTS.elementLimit;
      document.getElementById("el-limit-val").textContent =
        items.agentElementLimit || AGENT_DEFAULTS.elementLimit;

      document.getElementById("agentHistoryLimit").value =
        items.agentHistoryLimit || AGENT_DEFAULTS.historyLimit;
      document.getElementById("hist-limit-val").textContent =
        items.agentHistoryLimit || AGENT_DEFAULTS.historyLimit;

      const failThresh =
        items.agentFailureThreshold !== undefined
          ? items.agentFailureThreshold
          : AGENT_DEFAULTS.failureThreshold;
      document.getElementById("agentFailureThreshold").value = failThresh;
      document.getElementById("fail-thresh-val").textContent = failThresh;

      document.getElementById("agentCostBudget").value =
        items.agentCostBudget !== undefined
          ? items.agentCostBudget
          : AGENT_DEFAULTS.costBudget;
      document.getElementById("agentRiskConfirmation").checked =
        items.agentRiskConfirmation !== false;
      document.getElementById("agentDomainAllowlist").value =
        items.agentDomainAllowlist || "";
      systemPromptTextarea.value =
        items.agentSystemPrompt || DEFAULT_SYSTEM_PROMPT;

      document.getElementById("agentPromptCaching").checked =
        items.agentPromptCaching !== false;
      document.getElementById("agentTimeout").value =
        items.agentTimeout || AGENT_DEFAULTS.timeoutMs;
      document.getElementById("agentMaxTokensPerCall").value =
        items.agentMaxTokensPerCall || AGENT_DEFAULTS.maxTokensPerCall;

      setTimeout(() => {
        hasUnsavedChanges = false;
      }, 100);
      });
    });
  }

  function saveSettings() {
    const settingsToSave = {
      showChatGPT: showChatGPTCheck.checked,
      showGemini: showGeminiCheck.checked,
      showPerplexity: showPerplexityCheck.checked,
      showClaude: showClaudeCheck.checked,
      showAgent: showAgentCheck.checked,
      autoSend: autoSendCheck.checked,
      omniboxSmartRouting: smartRoutingCheck ? smartRoutingCheck.checked : true,
      autoContext: autoContextCheck.checked,
      openingMode: openingModeSelect.value,

      agentActiveProvider: activeProviderSelect.value,
      agentCustomUrl: customUrlInput.value.trim(),
      agentModel: modelSelect.value,
      agentMaxSteps: parseInt(maxStepsSlider.value, 10),

      agentTimeout: parseInt(document.getElementById("agentTimeout").value, 10),
      agentMaxTokensPerCall: parseInt(
        document.getElementById("agentMaxTokensPerCall").value,
        10,
      ),
      agentTemperature: parseFloat(
        document.getElementById("agentTemperature").value,
      ),
      agentElementLimit: parseInt(
        document.getElementById("agentElementLimit").value,
        10,
      ),
      agentHistoryLimit: parseInt(
        document.getElementById("agentHistoryLimit").value,
        10,
      ),
      agentFailureThreshold: parseInt(
        document.getElementById("agentFailureThreshold").value,
        10,
      ),
      agentCostBudget: parseFloat(
        document.getElementById("agentCostBudget").value,
      ),
      agentPromptCaching: document.getElementById("agentPromptCaching").checked,
      agentRiskConfirmation: document.getElementById("agentRiskConfirmation")
        .checked,
      agentDomainAllowlist: document
        .getElementById("agentDomainAllowlist")
        .value.trim(),

      agentSystemPrompt: systemPromptTextarea.value,
    };

    const apiKeysToSave = {
      agentOpenRouterKey: document
        .getElementById("agentOpenRouterKey")
        .value.trim(),
      agentAnthropicKey: document
        .getElementById("agentAnthropicKey")
        .value.trim(),
      agentOpenAIKey: document.getElementById("agentOpenAIKey").value.trim(),
      agentDeepSeekKey: document
        .getElementById("agentDeepSeekKey")
        .value.trim(),
      agentGeminiKey: document.getElementById("agentGeminiKey").value.trim(),
      agentMistralKey: document.getElementById("agentMistralKey").value.trim(),
      agentGroqKey: document.getElementById("agentGroqKey").value.trim(),
      agentTogetherKey: document
        .getElementById("agentTogetherKey")
        .value.trim(),
      agentXaiKey: document.getElementById("agentXaiKey").value.trim(),
      agentOpencodeKey: document
        .getElementById("agentOpencodeKey")
        .value.trim(),
      agentCustomKey: document.getElementById("agentCustomKey").value.trim(),
    };

    const persist = () => {
      chrome.storage.sync.set(settingsToSave, () => {
        chrome.storage.local.set(apiKeysToSave, () => {
          // Remove credentials left by versions that incorrectly used sync storage.
          chrome.storage.sync.remove(STORAGE.API_KEYS);
          hasUnsavedChanges = false;
          showToast("Settings saved securely on this device.");
        });
      });
    };

    if (activeProviderSelect.value !== "custom") {
      persist();
      return;
    }

    const origin = SELECT_TO_AI_SECURITY.customOrigin(settingsToSave.agentCustomUrl);
    if (!origin) {
      showToast("Custom gateways must use HTTPS or a loopback address.");
      return;
    }
    chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
      if (granted) persist();
      else showToast("Custom gateway access was not granted.");
    });
  }
  saveAllBtn.addEventListener("click", saveSettings);

  // --- Custom-gateway helpers (typed URL must be testable BEFORE saving) ---

  const STATUS_ICONS = {
    success:
      '<span class="icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>',
    error:
      '<span class="icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>',
    warning:
      '<span class="icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>',
  };

  /**
   * Prepares a typed custom-gateway URL for a one-off test request:
   * validates it through the shared security policy (HTTPS or loopback) and
   * requests the optional host permission Chrome needs for the fetch.
   * Calls done(candidateUrl) on success, done(null, errorMessage) otherwise.
   * Real agent traffic still uses only the SAVED gateway URL.
   */
  function prepareCustomGatewayCandidate(typedUrl, done) {
    const origin = SELECT_TO_AI_SECURITY.customOrigin(typedUrl);
    if (!origin) {
      done(
        null,
        "Custom gateways must use HTTPS or a loopback address (localhost / 127.0.0.1).",
      );
      return;
    }
    chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
      if (chrome.runtime.lastError || !granted) {
        done(null, `Access to ${origin} was not granted.`);
        return;
      }
      done(typedUrl);
    });
  }

  function setConnStatus(state, label, title = "") {
    connStatus.className = `status-indicator ${state}`;
    if (state === "loading") {
      connStatus.innerHTML = `<span class="spinner"></span> ${escapeHtmlText(label)}`;
    } else {
      connStatus.innerHTML = `${STATUS_ICONS[state] || ""} ${escapeHtmlText(label)}`;
    }
    connStatus.title = title;
    connStatus.style.display = "inline-flex";
    connStatus.onclick = null;
  }

  function escapeHtmlText(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- Fetch Models Dynamically ---
  function fetchModelsForProvider(provider, key, candidateCustomUrl = null) {
    let baseUrl = PROVIDER_DEFAULTS[provider].url;
    if (provider === "custom") {
      baseUrl = candidateCustomUrl || customUrlInput.value.trim();
    }
    setConnStatus("loading", "Querying API...");

    const { endpoint, headers } = getModelFetchRequest(provider, key, baseUrl);

    return fetchProxy(
      endpoint,
      { method: "GET", headers: headers },
      provider === "custom" ? baseUrl : null,
      provider,
    )
      .then((res) => {
        if (!res.ok) {
          return res.text().then((text) => {
            throw new Error(parseErrorText(text, res.status));
          });
        }
        return res.json();
      })
      .then((data) => {
        const fetchedModels = sortModelsForDisplay(
          normalizeFetchedModels(provider, data),
        );
        const selectableModels = sortModelsForDisplay(
          getSelectableFetchedModels(provider, data, fetchedModels),
        );
        const autoCandidates =
          selectableModels.length > 0 ? selectableModels : fetchedModels;
        const defs = PROVIDER_DEFAULTS[provider];

        // Ranked suggestion used only when the model input is EMPTY. A fetch
        // never overwrites the user's chosen model.
        const bestLite = findBestModel(autoCandidates, "lite", defs.model);

        populateDatalist(
          modelSelect,
          document.getElementById("agentModelList"),
          fetchedModels,
          bestLite,
        );

        const keyWarning = getProviderKeyValidationError(provider, key);
        setConnStatus(
          "success",
          `Models Fetched (${fetchedModels.length})`,
          `The full provider list is now available as typing suggestions in the model field.${keyWarning ? ` ${keyWarning} Chat calls still require a valid key.` : ""}`,
        );
        showToast(
          `Fetched ${fetchedModels.length} models into the suggestion list.`,
        );
      })
      .catch((err) => {
        applyModelPresets(provider);
        setConnStatus(
          "error",
          "Presets Loaded",
          "Click to show error details",
        );
        connStatus.onclick = () => {
          showErrorDetails(
            "Model fetch failed",
            `Endpoint: ${endpoint}\nError: ${err.message}\n\nFallback preset suggestions were loaded instead. Some providers require a valid key or billing-enabled account to list models.`,
          );
        };
      });
  }

  fetchModelsBtn.addEventListener("click", () => {
    const provider = activeProviderSelect.value;
    const key = getActiveProviderKey();
    if (provider === "custom") {
      prepareCustomGatewayCandidate(
        customUrlInput.value.trim(),
        (candidateUrl, errorMessage) => {
          if (!candidateUrl) {
            setConnStatus("error", "Invalid Gateway URL", errorMessage);
            showToast(errorMessage, true);
            return;
          }
          fetchModelsForProvider(provider, key, candidateUrl);
        },
      );
      return;
    }
    fetchModelsForProvider(provider, key);
  });

  // --- Test API Key Connection ---
  function runConnectionTest(provider, key, baseUrl) {
    setConnStatus("loading", "Testing connection...");

    const { endpoint, headers, body } = getConnectionTestRequest(
      provider,
      key,
      baseUrl,
      modelSelect.value || PROVIDER_DEFAULTS[provider].model,
    );

    fetchProxy(
      endpoint,
      { method: "POST", headers: headers, body: JSON.stringify(body) },
      provider === "custom" ? baseUrl : null,
      provider,
    )
      .then((res) => {
        if (!res.ok) {
          return res.text().then((text) => {
            throw new Error(parseErrorText(text, res.status));
          });
        }
        return res.json();
      })
      .then(() => {
        setConnStatus("success", "Connected", "Gateway verification successful!");
      })
      .catch((err) => {
        setConnStatus("error", "Connection Failed", "Click to show error details");
        connStatus.onclick = () => {
          showErrorDetails(
            "Connection test failed",
            `Endpoint: ${endpoint}\nError: ${err.message}\n\nCheck endpoint availability, CORS policies, or billing permissions.`,
          );
        };
      });
  }

  testConnBtn.addEventListener("click", () => {
    const provider = activeProviderSelect.value;
    const key = getActiveProviderKey();

    const keyError = getProviderKeyValidationError(provider, key);
    if (keyError) {
      setConnStatus("error", "Missing Key", keyError);
      connStatus.onclick = () =>
        showErrorDetails(
          "API key problem",
          `${keyError}\n\nModel lists may be public, but chat/completion calls require a valid provider API key.`,
        );
      return;
    }

    if (provider === "custom") {
      // The TYPED gateway URL is tested (not the saved one): the background
      // accepts the candidate origin exclusively for this single request.
      prepareCustomGatewayCandidate(
        customUrlInput.value.trim(),
        (candidateUrl, errorMessage) => {
          if (!candidateUrl) {
            setConnStatus("error", "Invalid Gateway URL", errorMessage);
            showToast(errorMessage, true);
            return;
          }
          runConnectionTest(provider, key, candidateUrl);
        },
      );
      return;
    }

    runConnectionTest(provider, key, PROVIDER_DEFAULTS[provider].url);
  });

  // --- Reset Prompt ---
  resetPromptBtn.addEventListener("click", () => {
    systemPromptTextarea.value = DEFAULT_SYSTEM_PROMPT;
    showToast("System directive prompt reset!");
  });

  // --- Reset All Settings ---
  resetAllBtn.addEventListener("click", () => {
    if (
      confirm(
        "Restore all select-to-ai configurations to original factory defaults?",
      )
    ) {
      chrome.storage.sync.remove(STORAGE.SETTINGS, () => {
        chrome.storage.local.remove(STORAGE.API_KEYS, () => {
          showToast("All configurations cleared. Reloading...");
          setTimeout(() => {
            location.reload();
          }, 1000);
        });
      });
    }
  });

  // --- Helper functions ---
  let toastTimer = null;
  function showToast(message, isError = false) {
    toastMessage.textContent = message;
    toast.classList.toggle("toast-error", isError);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, isError ? 4500 : 3000);
  }

  // Error-details expander: the non-blocking replacement for alert().
  const errorDetailsCard = document.getElementById("error-details");
  const errorDetailsTitle = document.getElementById("error-details-title");
  const errorDetailsBody = document.getElementById("error-details-body");
  const errorDetailsClose = document.getElementById("error-details-close");

  function showErrorDetails(title, details) {
    if (!errorDetailsCard) return;
    errorDetailsTitle.textContent = title;
    errorDetailsBody.textContent = details;
    errorDetailsCard.classList.remove("u-hidden");
  }

  function hideErrorDetails() {
    if (errorDetailsCard) errorDetailsCard.classList.add("u-hidden");
  }

  if (errorDetailsClose) {
    errorDetailsClose.addEventListener("click", hideErrorDetails);
  }

  // Parse API response errors, supporting JSON objects, arrays, and standard status text
  function parseErrorText(text, status) {
    let errMsg = `HTTP ${status || "Error"}`;
    if (!text) return errMsg;
    try {
      let trimmed = text.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const arr = JSON.parse(trimmed);
        if (arr && arr[0]) {
          trimmed =
            typeof arr[0] === "object"
              ? JSON.stringify(arr[0])
              : String(arr[0]);
        }
      }
      const parsed = JSON.parse(trimmed);
      errMsg =
        parsed.error?.message || parsed.error || parsed.message || errMsg;
    } catch (e) {}
    return errMsg;
  }

  // --- Onboarding Wizard Logic ---
  function initOnboardingWizard() {
    chrome.storage.local.get("onboardingComplete", (res) => {
      if (res.onboardingComplete === true) {
        return;
      }

      // Show wizard overlay
      const overlay = document.getElementById("onboarding-overlay");
      if (!overlay) return;
      overlay.style.display = "flex";

      const steps = overlay.querySelectorAll(".onboarding-step");
      const nextBtns = overlay.querySelectorAll(".next-step-btn");
      const prevBtns = overlay.querySelectorAll(".prev-step-btn");
      const skipBtns = overlay.querySelectorAll(".skip-onboarding-btn");
      const finishBtn = overlay.querySelector(".finish-onboarding-btn");

      const wizardProvider = document.getElementById("wizardProvider");
      const wizardApiKey = document.getElementById("wizardApiKey");
      const wizardKeyLabel = document.getElementById("wizardKeyLabel");
      const wizardUrlGroup = document.getElementById("wizardUrlGroup");
      const wizardCustomUrl = document.getElementById("wizardCustomUrl");

      const wizardTestBtn = document.getElementById("wizard-test-btn");
      const wizardTestStatus = document.getElementById("wizard-test-status");
      const step3Next = document.getElementById("wizard-step-3-next");

      let currentWizardStep = 1;

      // Sync wizard inputs with current provider default values
      function syncWizardProvider() {
        const prov = wizardProvider.value;
        const defs = PROVIDER_DEFAULTS[prov];

        const keyLinks = {
          openrouter: "https://openrouter.ai/keys",
          anthropic: "https://console.anthropic.com/settings/keys",
          openai: "https://platform.openai.com/api-keys",
          deepseek: "https://platform.deepseek.com/api_keys",
          gemini: "https://aistudio.google.com/app/apikey",
          mistral: "https://console.mistral.ai/api-keys/",
          groq: "https://console.groq.com/keys",
          together: "https://api.together.xyz/settings/api-keys",
          xai: "https://console.x.ai/",
          opencode: "https://zen.opencode.co",
        };
        const link = keyLinks[prov];
        const linkHtml = link
          ? ` (<a href="${link}" target="_blank" class="get-key-link" style="margin-left: 0; display: inline;">Get API Key</a>)`
          : "";

        wizardKeyLabel.innerHTML = `${defs.name} API Key${linkHtml}`;
        wizardApiKey.placeholder = defs.placeholder;
        wizardApiKey.value = cachedProviderKeys[prov] || "";

        if (prov === "custom") {
          wizardUrlGroup.style.display = "block";
        } else {
          wizardUrlGroup.style.display = "none";
        }
      }


      wizardProvider.addEventListener("change", syncWizardProvider);
      syncWizardProvider();

      // Next / Prev button event handlers
      nextBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          if (currentWizardStep === 2) {
            const prov = wizardProvider.value;
            cachedProviderKeys[prov] = wizardApiKey.value.trim();
          }
          if (currentWizardStep < steps.length) {
            steps[currentWizardStep - 1].classList.remove("active");
            currentWizardStep++;
            steps[currentWizardStep - 1].classList.add("active");
          }
        });
      });

      prevBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          if (currentWizardStep > 1) {
            steps[currentWizardStep - 1].classList.remove("active");
            currentWizardStep--;
            steps[currentWizardStep - 1].classList.add("active");
          }
        });
      });

      // Step 3 Connectivity test
      function runWizardTest(prov, key, baseUrl) {
        wizardTestStatus.className = "status-indicator loading";
        wizardTestStatus.innerHTML = `<span class="spinner"></span> Testing connection...`;
        wizardTestStatus.style.display = "inline-flex";
        wizardTestStatus.onclick = null;

        const { endpoint, headers, body } = getConnectionTestRequest(
          prov,
          key,
          baseUrl,
          PROVIDER_DEFAULTS[prov].model,
        );

        fetchProxy(
          endpoint,
          { method: "POST", headers: headers, body: JSON.stringify(body) },
          prov === "custom" ? baseUrl : null,
          prov,
        )
          .then((res) => {
            if (!res.ok) {
              return res.text().then((text) => {
                throw new Error(parseErrorText(text, res.status));
              });
            }
            return res.json();
          })
          .then(() => {
            wizardTestStatus.className = "status-indicator success";
            wizardTestStatus.innerHTML = `${STATUS_ICONS.success} Connection Successful`;
            step3Next.disabled = false;

            // Save credentials to cached keys
            cachedProviderKeys[prov] = key;

            // Auto-fill main options page fields with verified credentials
            activeProviderSelect.value = prov;
            setProviderKey(prov, key);
            document.querySelectorAll(".provider-key-group").forEach((group) => {
              group.style.display =
                group.id === "group-" + prov ? "flex" : "none";
            });
            if (prov === "custom") {
              customUrlInput.value = baseUrl;
              customUrlGroup.style.display = "block";
            } else {
              customUrlGroup.style.display = "none";
            }
            applyModelPresets(prov, { replaceValue: true });
          })
          .catch((err) => {
            wizardTestStatus.className = "status-indicator error";
            wizardTestStatus.innerHTML = `${STATUS_ICONS.error} Connection Failed`;
            wizardTestStatus.title = "Click to show error details";
            wizardTestStatus.onclick = () => {
              showErrorDetails("Wizard connection test failed", err.message);
            };
          });
      }

      wizardTestBtn.addEventListener("click", () => {
        const prov = wizardProvider.value;
        const key = wizardApiKey.value.trim();

        if (prov === "custom") {
          prepareCustomGatewayCandidate(
            wizardCustomUrl.value.trim(),
            (candidateUrl, errorMessage) => {
              if (!candidateUrl) {
                wizardTestStatus.className = "status-indicator error";
                wizardTestStatus.innerHTML = `${STATUS_ICONS.error} Invalid Gateway URL`;
                wizardTestStatus.title = errorMessage;
                wizardTestStatus.style.display = "inline-flex";
                return;
              }
              runWizardTest(prov, key, candidateUrl);
            },
          );
          return;
        }

        runWizardTest(prov, key, PROVIDER_DEFAULTS[prov].url);
      });

      // End onboarding wizard
      function finishWizard(success = true) {
        chrome.storage.local.set({ onboardingComplete: true }, () => {
          overlay.style.display = "none";
          if (success) {
            // Auto-enable agent toggle! (O1)
            showAgentCheck.checked = true;
            saveSettings();
          } else {
            loadSettings();
          }
          showToast("Onboarding setup finished!");
        });
      }

      skipBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          finishWizard(false);
        });
      });

      finishBtn.addEventListener("click", () => {
        finishWizard(true);
      });

      // Onboarding Focus Trap (O3)
      overlay.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          const focusableElements = overlay.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
          );
          if (focusableElements.length === 0) return;
          const firstElement = focusableElements[0];
          const lastElement = focusableElements[focusableElements.length - 1];

          if (e.shiftKey) {
            // Shift + Tab
            if (document.activeElement === firstElement) {
              lastElement.focus();
              e.preventDefault();
            }
          } else {
            // Tab
            if (document.activeElement === lastElement) {
              firstElement.focus();
              e.preventDefault();
            }
          }
        }
      });
    });
  }

  // --- Unsaved Changes Warning & Version Display ---

  const registerDirtyListeners = () => {
    const inputs = document.querySelectorAll("input, select, textarea");
    inputs.forEach((input) => {
      input.addEventListener("input", () => {
        hasUnsavedChanges = true;
      });
      input.addEventListener("change", () => {
        hasUnsavedChanges = true;
      });
    });
  };
  registerDirtyListeners();

  window.addEventListener("beforeunload", (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue =
        "You have unsaved changes. Are you sure you want to leave?";
      return e.returnValue;
    }
  });

  const versionSpan = document.getElementById("extension-version");
  if (versionSpan) {
    versionSpan.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  // --- Slider UI updates ---
  document.getElementById("agentTemperature").addEventListener("input", (e) => {
    document.getElementById("temp-val").textContent = parseFloat(
      e.target.value,
    ).toFixed(2);
  });
  document
    .getElementById("agentElementLimit")
    .addEventListener("input", (e) => {
      document.getElementById("el-limit-val").textContent = e.target.value;
    });
  document
    .getElementById("agentHistoryLimit")
    .addEventListener("input", (e) => {
      document.getElementById("hist-limit-val").textContent = e.target.value;
    });
  document
    .getElementById("agentFailureThreshold")
    .addEventListener("input", (e) => {
      document.getElementById("fail-thresh-val").textContent = e.target.value;
    });

  // --- Backup & Restore bindings ---
  const exportBtn = document.getElementById("export-settings-btn");
  const importBtn = document.getElementById("import-settings-btn");
  const importFile = document.getElementById("import-settings-file");
  const rerunWizardBtn = document.getElementById("rerun-wizard-btn");

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      chrome.storage.sync.get(STORAGE.SETTINGS, (syncItems) => {
        const configBackup = {
          version: chrome.runtime.getManifest().version,
          timestamp: Date.now(),
          includesSecrets: false,
          sync: syncItems,
          local: {},
        };
        const blob = new Blob([JSON.stringify(configBackup, null, 2)], {
          type: "application/json;charset=utf-8;",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute(
          "download",
          `select_to_ai_settings_${Date.now()}.json`,
        );
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast("Settings exported without API keys.");
      });
    });
  }

  if (importBtn) {
    importBtn.addEventListener("click", () => importFile.click());
  }

  if (importFile) {
    importFile.addEventListener("change", (fileEvent) => {
      const file = fileEvent.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const backup = JSON.parse(e.target.result);
          if (!backup.sync || typeof backup.sync !== "object") {
            throw new Error("Invalid backup file structure.");
          }

          const safeSync = Object.fromEntries(
            Object.entries(backup.sync).filter(([key]) =>
              STORAGE.SETTINGS.includes(key),
            ),
          );
          const safeLocal = Object.fromEntries(
            Object.entries(backup.local || {}).filter(([key]) =>
              STORAGE.API_KEYS.includes(key),
            ),
          );

          chrome.storage.sync.set(safeSync, () => {
            chrome.storage.local.set(safeLocal, () => {
              hasUnsavedChanges = false;
              showToast("Settings imported successfully! Reloading...");
              setTimeout(() => {
                location.reload();
              }, 1000);
            });
          });
        } catch (err) {
          showToast("Import failed; see details.", true);
          showErrorDetails("Settings import failed", err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  if (rerunWizardBtn) {
    rerunWizardBtn.addEventListener("click", () => {
      if (
        confirm(
          "Reset onboarding flag and run wizard setup? (Unsaved settings changes will be discarded)",
        )
      ) {
        chrome.storage.local.set({ onboardingComplete: false }, () => {
          hasUnsavedChanges = false;
          location.reload();
        });
      }
    });
  }

  // --- System Prompt Templates Library ---
  function updatePromptLibraryUI(library) {
    const select = document.getElementById("promptLibrarySelect");
    if (!select) return;
    select.innerHTML = '<option value="">-- Select Template --</option>';
    library.forEach((item, idx) => {
      const opt = document.createElement("option");
      opt.value = idx;
      opt.textContent = item.name;
      select.appendChild(opt);
    });
  }

  chrome.storage.sync.get("promptLibrary", (res) => {
    const library = res.promptLibrary || [];
    updatePromptLibraryUI(library);
  });

  const loadTemplateBtn = document.getElementById("load-template-btn");
  const deleteTemplateBtn = document.getElementById("delete-template-btn");
  const saveTemplateBtn = document.getElementById("save-template-btn");
  const newTemplateNameInput = document.getElementById("newTemplateName");

  if (loadTemplateBtn) {
    loadTemplateBtn.addEventListener("click", () => {
      const select = document.getElementById("promptLibrarySelect");
      const idx = select.value;
      if (idx === "") {
        showToast("Select a template to load first.", true);
        return;
      }
      chrome.storage.sync.get("promptLibrary", (res) => {
        const library = res.promptLibrary || [];
        const item = library[idx];
        if (item) {
          systemPromptTextarea.value = item.prompt;
          hasUnsavedChanges = true;
          showToast(`Loaded template: ${item.name}`);
        }
      });
    });
  }

  if (saveTemplateBtn) {
    saveTemplateBtn.addEventListener("click", () => {
      const name = newTemplateNameInput.value.trim();
      const prompt = systemPromptTextarea.value;

      if (!name) {
        showToast("Enter a name for the template first.", true);
        return;
      }

      chrome.storage.sync.get("promptLibrary", (res) => {
        const library = res.promptLibrary || [];
        library.push({ name, prompt });
        chrome.storage.sync.set({ promptLibrary: library }, () => {
          updatePromptLibraryUI(library);
          newTemplateNameInput.value = "";
          showToast(`Saved template "${name}" to library.`);
        });
      });
    });
  }

  if (deleteTemplateBtn) {
    deleteTemplateBtn.addEventListener("click", () => {
      const select = document.getElementById("promptLibrarySelect");
      const idx = select.value;
      if (idx === "") {
        showToast("Select a template to delete first.", true);
        return;
      }
      if (confirm("Are you sure you want to delete this template?")) {
        chrome.storage.sync.get("promptLibrary", (res) => {
          const library = res.promptLibrary || [];
          library.splice(idx, 1);
          chrome.storage.sync.set({ promptLibrary: library }, () => {
            updatePromptLibraryUI(library);
            showToast("Template deleted.");
          });
        });
      }
    });
  }

  // --- Memory Profile Editor ---
  // Durable facts the agent applies to every task. Local-only storage,
  // fully user-editable; injected into planning prompts via memoryProfile.js.
  const MEMORY_KEY = "agentMemoryProfile";
  const memoryInput = document.getElementById("memoryProfileInput");
  const memoryAddBtn = document.getElementById("memory-add-btn");
  const memoryList = document.getElementById("memory-profile-list");

  function renderMemoryProfile(facts) {
    if (!memoryList) return;
    memoryList.innerHTML = "";
    const list = Array.isArray(facts) ? facts : [];
    if (list.length === 0) {
      const empty = document.createElement("li");
      empty.className = "muted-note";
      empty.textContent = "Nothing yet. Add preferences the agent should always consider.";
      memoryList.appendChild(empty);
      return;
    }
    list.forEach((fact) => {
      const text = typeof fact === "string" ? fact : fact?.text || "";
      const li = document.createElement("li");
      li.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--border);border-radius:var(--radius-full,999px);padding:6px 14px;font-size:13px;";
      const span = document.createElement("span");
      span.textContent = text;
      span.style.overflow = "hidden";
      span.style.textOverflow = "ellipsis";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Remove";
      del.setAttribute("aria-label", `Remove fact: ${text}`);
      del.style.cssText =
        "border:none;background:none;color:var(--text-muted,#888);cursor:pointer;font-size:12px;text-decoration:underline;padding:0;";
      del.addEventListener("click", () => {
        chrome.storage.local.get(MEMORY_KEY, (res) => {
          const next = window.SELECT_TO_AI_MEMORY
            ? window.SELECT_TO_AI_MEMORY.removeFact(res[MEMORY_KEY], text)
            : (res[MEMORY_KEY] || []).filter(
                (f) => (typeof f === "string" ? f : f.text).toLowerCase() !== text.toLowerCase(),
              );
          chrome.storage.local.set({ [MEMORY_KEY]: next }, () =>
            renderMemoryProfile(next),
          );
        });
      });
      li.appendChild(span);
      li.appendChild(del);
      memoryList.appendChild(li);
    });
  }

  if (memoryAddBtn && memoryInput) {
    memoryAddBtn.addEventListener("click", () => {
      const value = memoryInput.value.trim();
      if (!value) return;
      chrome.storage.local.get(MEMORY_KEY, (res) => {
        const next = window.SELECT_TO_AI_MEMORY
          ? window.SELECT_TO_AI_MEMORY.addFact(res[MEMORY_KEY], value)
          : [...(res[MEMORY_KEY] || []), { text: value, addedAt: Date.now() }];
        chrome.storage.local.set({ [MEMORY_KEY]: next }, () => {
          memoryInput.value = "";
          renderMemoryProfile(next);
          showToast("Saved. The agent will know this.");
        });
      });
    });
    memoryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        memoryAddBtn.click();
      }
    });
  }

  // Load existing facts once on open.
  chrome.storage.local.get(MEMORY_KEY, (res) => renderMemoryProfile(res[MEMORY_KEY]));

  // --- Routines Editor ---
  const ROUTINES_KEY = "agentRoutines";
  const routineName = document.getElementById("routineName");
  const routineTask = document.getElementById("routineTask");
  const routineKind = document.getElementById("routineKind");
  const routineDay = document.getElementById("routineDay");
  const routineDayGroup = document.getElementById("routineDayGroup");
  const routineTime = document.getElementById("routineTime");
  const routineAddBtn = document.getElementById("routine-add-btn");
  const routinesList = document.getElementById("routines-list");

  if (routineKind && routineDayGroup) {
    routineKind.addEventListener("change", () => {
      routineDayGroup.style.display =
        routineKind.value === "weekly" ? "block" : "none";
    });
  }

  function describeRoutine(routine) {
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const s = routine.schedule;
    return s.kind === "weekly"
      ? `Weekly on ${dayNames[s.day]} at ${s.time}`
      : `Daily at ${s.time}`;
  }

  function renderRoutines(facts) {
    if (!routinesList) return;
    routinesList.innerHTML = "";
    const list = Array.isArray(facts) ? facts : [];
    if (list.length === 0) {
      const empty = document.createElement("li");
      empty.className = "muted-note";
      empty.textContent = "No routines yet.";
      routinesList.appendChild(empty);
      return;
    }
    list.forEach((routine) => {
      const li = document.createElement("li");
      li.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--border);border-radius:12px;padding:10px 14px;font-size:13px;flex-wrap:wrap;";
      const info = document.createElement("div");
      info.style.cssText = "display:flex;flex-direction:column;min-width:0;";
      const title = document.createElement("strong");
      title.textContent = routine.name;
      const meta = document.createElement("span");
      meta.className = "muted-note";
      meta.textContent = `${describeRoutine(routine)} — ${routine.task}`;
      info.appendChild(title);
      info.appendChild(meta);

      const controls = document.createElement("div");
      controls.style.cssText = "display:flex;gap:8px;align-items:center;";

      const toggleLabel = document.createElement("label");
      toggleLabel.style.cssText =
        "display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;";
      const enabledBox = document.createElement("input");
      enabledBox.type = "checkbox";
      enabledBox.checked = routine.enabled !== false;
      enabledBox.setAttribute("aria-label", `Enable routine ${routine.name}`);
      enabledBox.addEventListener("change", () => {
        chrome.storage.local.get(ROUTINES_KEY, (res) => {
          const next = (res[ROUTINES_KEY] || []).map((r) =>
            r.id === routine.id ? { ...r, enabled: enabledBox.checked } : r,
          );
          chrome.storage.local.set({ [ROUTINES_KEY]: next }, () => {
            showToast(enabledBox.checked ? "Routine enabled." : "Routine paused.");
          });
        });
      });
      toggleLabel.appendChild(enabledBox);
      toggleLabel.appendChild(document.createTextNode("On"));
      controls.appendChild(toggleLabel);

      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.setAttribute("aria-label", `Delete routine ${routine.name}`);
      del.style.cssText =
        "border:none;background:none;color:var(--text-muted,#888);cursor:pointer;font-size:12px;text-decoration:underline;padding:0;";
      del.addEventListener("click", () => {
        chrome.storage.local.get(ROUTINES_KEY, (res) => {
          const next = (res[ROUTINES_KEY] || []).filter((r) => r.id !== routine.id);
          chrome.storage.local.set({ [ROUTINES_KEY]: next }, () => renderRoutines(next));
        });
      });
      controls.appendChild(del);

      li.appendChild(info);
      li.appendChild(controls);
      routinesList.appendChild(li);
    });
  }

  if (routineAddBtn) {
    routineAddBtn.addEventListener("click", () => {
      const candidate = window.SELECT_TO_AI_ROUTINES
        ? window.SELECT_TO_AI_ROUTINES.normalizeRoutine({
            id: `routine-${Date.now()}`,
            name: routineName.value,
            task: routineTask.value,
            schedule: {
              kind: routineKind.value,
              ...(routineKind.value === "weekly"
                ? { day: Number(routineDay.value) }
                : {}),
              time: routineTime.value,
            },
          })
        : { ok: false, error: "Routines module missing." };
      if (!candidate.ok) {
        showToast(candidate.error, true);
        return;
      }
      chrome.storage.local.get(ROUTINES_KEY, (res) => {
        const next = [...(res[ROUTINES_KEY] || []), candidate.routine];
        chrome.storage.local.set({ [ROUTINES_KEY]: next }, () => {
          routineName.value = "";
          routineTask.value = "";
          renderRoutines(next);
          showToast("Routine scheduled.");
        });
      });
    });
  }

  chrome.storage.local.get(ROUTINES_KEY, (res) => renderRoutines(res[ROUTINES_KEY]));

  // --- Playbook Gallery ---
  const playbookImportBtn = document.getElementById("playbook-import-btn");
  const playbookImportFile = document.getElementById("playbook-import-file");
  const playbookImportStatus = document.getElementById("playbook-import-status");
  const playbooksList = document.getElementById("playbooks-list");
  let customPlaybooks = [];

  function allPlaybooks() {
    return (window.SELECT_TO_AI_PLAYBOOKS?.BUNDLED || []).concat(customPlaybooks);
  }

  function renderPlaybooks() {
    if (!playbooksList) return;
    playbooksList.innerHTML = "";
    for (const playbook of allPlaybooks()) {
      const li = document.createElement("li");
      li.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--border);border-radius:12px;padding:10px 14px;flex-wrap:wrap;";
      const info = document.createElement("div");
      info.style.cssText = "display:flex;flex-direction:column;min-width:0;";
      const title = document.createElement("strong");
      title.textContent = `${playbook.name} · ${playbook.category}`;
      const desc = document.createElement("span");
      desc.className = "muted-note";
      desc.textContent = playbook.description || playbook.task.slice(0, 120);
      info.appendChild(title);
      info.appendChild(desc);

      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.className = "btn btn-secondary";
      runBtn.textContent = "Run";
      runBtn.setAttribute("aria-label", `Run playbook ${playbook.name}`);

      const needsInput = /\{input\}/.test(playbook.task);
      if (needsInput) {
        const inputBox = document.createElement("input");
        inputBox.type = "text";
        inputBox.placeholder = playbook.description.replace(/\{input\}/g, "…") || "Fill in the blank";
        inputBox.setAttribute("aria-label", `Input for ${playbook.name}`);
        inputBox.style.cssText = "max-width:260px;";
        info.appendChild(inputBox);
        runBtn.addEventListener("click", () => {
          const rendered = window.SELECT_TO_AI_PLAYBOOKS.renderTask(
            playbook,
            inputBox.value,
          );
          launchPlaybook(playbook, rendered);
        });
      } else {
        runBtn.addEventListener("click", () => {
          launchPlaybook(playbook, window.SELECT_TO_AI_PLAYBOOKS.renderTask(playbook, ""));
        });
      }

      li.appendChild(info);
      li.appendChild(runBtn);
      playbooksList.appendChild(li);
    }
  }

  /** Queues a rendered playbook task and opens the agent page. */
  function launchPlaybook(playbook, renderedTask) {
    chrome.storage.local.set(
      { companionTask: { task: renderedTask, timestamp: Date.now(), source: `playbook:${playbook.id}` } },
      () => {
        chrome.tabs.create({ url: "agent.html?autorun=1" });
      },
    );
  }

  if (playbookImportBtn && playbookImportFile) {
    playbookImportBtn.addEventListener("click", () => playbookImportFile.click());
    playbookImportFile.addEventListener("change", () => {
      const file = playbookImportFile.files && playbookImportFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          const candidates = Array.isArray(parsed) ? parsed : [parsed];
          let added = 0;
          for (const candidate of candidates) {
            const result = window.SELECT_TO_AI_PLAYBOOKS
              ? window.SELECT_TO_AI_PLAYBOOKS.normalizePlaybook(candidate)
              : { ok: false, error: "Playbooks module missing." };
            if (!result.ok) {
              playbookImportStatus.textContent = `Rejected "${candidate?.name || candidate?.id || "entry"}": ${result.error}`;
              continue;
            }
            customPlaybooks = [
              ...customPlaybooks.filter((p) => p.id !== result.playbook.id),
              result.playbook,
            ];
            added += 1;
          }
          playbookImportStatus.textContent = added
            ? `Imported ${added} playbook${added > 1 ? "s" : ""}.`
            : "Nothing imported.";
          renderPlaybooks();
        } catch (err) {
          playbookImportStatus.textContent = `Invalid JSON: ${err.message}`;
        }
      };
      reader.readAsText(file);
      playbookImportFile.value = "";
    });
  }

  renderPlaybooks();

  // --- Init ---
  loadSettings();
  initOnboardingWizard();
});
