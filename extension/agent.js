/**
 * Select to AI - Browser Agent Client Page Logic
 * Manages the multi-agent autonomous loop (Planner, Executor, Validator).
 */

(function () {
  "use strict";

  const DEFAULT_SYSTEM_PROMPT = CONFIG.DEFAULT_SYSTEM_PROMPT;

  // State Variables
  let isRunning = false;
  let currentTask = "";
  let subtasks = [];
  let currentSubtaskIndex = 0;
  let currentStep = 0;
  let consecutiveFailures = 0;
  let parseFailureCount = 0;
  let agentMaxStepsLimit = 25; // Loop safeguard loaded from storage
  let targetTabId = null;
  let targetTabUrl = "";
  let currentAgentTabId = null;
  let activeAbortController = null;
  let actionHistory = [];
  let sessionRecording = [];
  let conversationHistory = [];

  // Token & Cost Tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUSD = 0.0;

  const MODEL_PRICES = {
    "gemini-2.5-flash": [0.000075, 0.0003],
    "gemini-flash": [0.000075, 0.0003],
    "gemini-3.5-flash": [0.000075, 0.0003],
    "gemini-2.5-pro": [0.00125, 0.005],
    "gemini-pro": [0.00125, 0.005],
    "claude-3-5-sonnet": [0.003, 0.015],
    "claude-3.5-sonnet": [0.003, 0.015],
    sonnet: [0.003, 0.015],
    "claude-3-5-haiku": [0.0008, 0.004],
    "claude-3.5-haiku": [0.0008, 0.004],
    haiku: [0.0008, 0.004],
    "gpt-4o-mini": [0.00015, 0.0006],
    "gpt-4o": [0.0025, 0.01],
    "o3-mini": [0.0011, 0.0044],
    "o1-mini": [0.003, 0.012],
    o1: [0.015, 0.06],
    "deepseek-chat": [0.00014, 0.00028],
    "deepseek-reasoner": [0.00055, 0.00219],
    "llama-3.3": [0.0002, 0.0004],
    llama: [0.00015, 0.0003],
    default: [0.0005, 0.002],
  };

  function accumulateUsage(usage, modelName) {
    if (!usage) return;
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;

    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;

    let rates = MODEL_PRICES.default;
    const nameLower = modelName.toLowerCase();
    for (const [key, value] of Object.entries(MODEL_PRICES)) {
      if (key !== "default" && nameLower.includes(key)) {
        rates = value;
        break;
      }
    }

    const cost =
      (promptTokens / 1000) * rates[0] + (completionTokens / 1000) * rates[1];
    totalCostUSD += cost;

    updateCostDashboard();

    // Enforce Cost Budget Ceiling (F7)
    if (config.agentCostBudget > 0 && totalCostUSD >= config.agentCostBudget) {
      setTimeout(() => {
        stopAgent(
          `Cost budget exceeded: Spent $${totalCostUSD.toFixed(4)} of $${config.agentCostBudget.toFixed(4)} budget limit.`,
          "error",
        );
      }, 50);
    }
  }

  function updateCostDashboard() {
    const costBadge = document.getElementById("costDashboardBadge");
    if (costBadge) {
      costBadge.style.display = "inline-flex";
      costBadge.textContent = `$${totalCostUSD.toFixed(4)}`;
      costBadge.title = `Tokens: Input: ${totalPromptTokens} | Output: ${totalCompletionTokens}`;
    }
  }

  // Configuration cache
  let config = {
    agentActiveProvider: "opencode",
    agentOpenRouterKey: "",
    agentAnthropicKey: "",
    agentOpenAIKey: "",
    agentDeepSeekKey: "",
    agentGeminiKey: "",
    agentCustomKey: "",
    agentMistralKey: "",
    agentGroqKey: "",
    agentTogetherKey: "",
    agentXaiKey: "",
    agentOpencodeKey: "",
    agentCustomUrl: "http://localhost:11434/v1",

    agentModel: "deepseek-v4-flash-free",
    agentRoutingStrategy: "single",

    agentSystemPrompt: "",
    agentTimeout: 60000,
    agentMaxTokensPerCall: 2000,
    agentTemperature: 0.1,
    agentCostBudget: 0,
    agentDomainAllowlist: "",
    agentRiskConfirmation: true,
    agentElementLimit: 60,
    agentHistoryLimit: 12,
    agentFailureThreshold: 3,
    agentPromptCaching: true,
  };

  const promptCacheSessionId = `select-to-ai-agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const browserCapabilityPrompt = `### Runtime Environment
You are running inside a Chrome extension side panel. The user is chatting with you, and you can either answer normally or use extension browser capabilities when the request needs live tab/page context or browser control.

### Available Extension Capabilities
- Chat normally: respond conversationally without touching the browser.
- Read current browser context: inspect the selected/active webpage tab metadata, including tab id, title, URL, active/current markers, and available tabs in the current Chrome window.
- Inspect page state: scan the current webpage after content-script injection for visible text, page title, URL, and interactive DOM elements.
- Capture screenshots: request a screenshot of the current agent tab for visual reasoning.
- Control DOM elements: click, double-click, right-click, hover, type, clear inputs, select dropdown options, toggle checkboxes/radios, press keys, scroll, wait, go back, and go forward.
- Control tabs: list tabs, switch the agent context to another tab, open a new tab, close a tab, and reload a tab.
- Navigate: load an allowed URL in the current agent tab or a new tab.
- Visual feedback: when browser actions run, the content script can show a cursor/scroll cue on the page so the user can see what is happening.

### Important Limits And Safety
- You cannot access Chrome system pages such as chrome:// or extension-internal pages.
- You must respect the configured domain allowlist before navigating or opening tabs.
- High-risk actions such as purchasing, submitting sensitive forms, payments, deletion, auth/security changes, account management, uploads, or sending messages require user confirmation.
- Do not invent page contents. If live page details are needed, route to browser context/page inspection instead of guessing.
- Do not use browser automation for ordinary conversation, opinions, explanations, brainstorming, or questions answerable from chat context.
- Prefer the smallest sufficient capability: use context for tab/page identity questions, full browser automation only for tasks that require actions or deeper inspection.`;

  // DOM Elements
  const taskInput = document.getElementById("taskInput");
  const actionBtn = document.getElementById("actionBtn");
  const chatViewport = document.getElementById("chatViewport");
  const chatContainer = document.getElementById("chatContainer");
  const welcomeScreen = document.getElementById("welcomeScreen");

  const modelSelectorBtn = document.getElementById("modelSelectorBtn");
  const modelSelectorContainer = document.getElementById(
    "modelSelectorContainer",
  );
  const modelSelectorDropdown = document.getElementById(
    "modelSelectorDropdown",
  );
  const credentialsWarning = document.getElementById("credentialsWarning");
  const sidebar = document.getElementById("sidebar");
  const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");
  const newTaskBtn = document.getElementById("newTaskBtn");
  const attachBtn = document.getElementById("attachBtn");

  // Dynamic message bubble references
  let activeChecklistItems = null;
  let activeProgressBar = null;
  let activeProgressPercent = null;
  let activeLogsWrapper = null;
  let activeBubbleStatus = null;
  let activeRadar = null;
  let activeThoughtStatus = null;
  let activeBubbleAnswer = null;
  let activeStreamPanel = null;
  let activeStreamText = null;
  let activeWave = null;
  let activeAvatar = null;

  // Initialize Settings
  loadSettings();

  // Event Binds
  actionBtn.addEventListener("click", () => {
    if (isRunning) {
      stopAgent("Stopped by user");
    } else {
      startAgent();
    }
  });

  // Auto-grow textarea helper
  function adjustTextareaHeight() {
    taskInput.style.height = "auto";
    taskInput.style.height = taskInput.scrollHeight + "px";
  }

  // Suggestion prompt clicks
  document.querySelectorAll(".suggestion-card").forEach((card) => {
    card.addEventListener("click", () => {
      taskInput.value = card.getAttribute("data-prompt");
      taskInput.focus();
      adjustTextareaHeight();
    });
  });

  // Enter key to send prompt
  taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isRunning) {
        startAgent();
      }
    }
  });

  taskInput.addEventListener("input", adjustTextareaHeight);
  adjustTextareaHeight();

  // Escape key to stop agent execution
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isRunning) {
      stopAgent("Stopped by user (Escape key)");
    }
  });

  // Model Selector Dropdown toggle and selection binding
  if (modelSelectorBtn && modelSelectorContainer) {
    modelSelectorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      modelSelectorContainer.classList.toggle("open");
    });
  }

  document.addEventListener("click", () => {
    if (modelSelectorContainer) {
      modelSelectorContainer.classList.remove("open");
    }
  });

  const dropAuto = document.getElementById("dropdownModeAuto");
  const dropHardcoded = document.getElementById("dropdownModeHardcoded");

  if (dropAuto) {
    dropAuto.addEventListener("click", () => {});
  }

  if (dropHardcoded) {
    dropHardcoded.addEventListener("click", () => {});
  }

  // Sidebar Toggle
  if (sidebarToggleBtn && sidebar) {
    sidebarToggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
      const isCollapsed = sidebar.classList.contains("collapsed");
      chrome.storage.sync.set({ sidebarCollapsed: isCollapsed });

      if (sidebarBackdrop) {
        if (!isCollapsed && window.innerWidth <= 768) {
          sidebarBackdrop.classList.add("active");
        } else {
          sidebarBackdrop.classList.remove("active");
        }
      }
    });
  }

  // Backdrop click or clicking outside dismisses sidebar
  document.addEventListener("click", (e) => {
    if (sidebar && !sidebar.classList.contains("collapsed")) {
      // If click is outside the sidebar AND outside the toggle button
      if (
        !sidebar.contains(e.target) &&
        (!sidebarToggleBtn || !sidebarToggleBtn.contains(e.target))
      ) {
        sidebar.classList.add("collapsed");
        chrome.storage.sync.set({ sidebarCollapsed: true });
        if (sidebarBackdrop) {
          sidebarBackdrop.classList.remove("active");
        }
      }
    }
  });

  // New Task Button (Reset session)
  if (newTaskBtn) {
    newTaskBtn.addEventListener("click", () => {
      if (isRunning) {
        stopAgent("Session reset by user");
      }
      // Clear message bubbles
      const bubbles = chatContainer.querySelectorAll(".message-bubble");
      bubbles.forEach((b) => b.remove());
      welcomeScreen.style.display = "flex";
      taskInput.value = "";
      adjustTextareaHeight();
    });
  }

  // Attach Options Button (Shortcut to settings dashboard)
  if (attachBtn) {
    attachBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: "options.html" });
    });
  }

  // Helper to get key/url for active provider
  function getProviderDetails(provider) {
    let apiKey = "";
    let baseUrl = "";

    if (provider === "openrouter") {
      apiKey = config.agentOpenRouterKey;
      baseUrl = "https://openrouter.ai/api/v1";
    } else if (provider === "anthropic") {
      apiKey = config.agentAnthropicKey;
      baseUrl = "https://api.anthropic.com/v1/messages";
    } else if (provider === "openai") {
      apiKey = config.agentOpenAIKey;
      baseUrl = "https://api.openai.com/v1";
    } else if (provider === "deepseek") {
      apiKey = config.agentDeepSeekKey;
      baseUrl = "https://api.deepseek.com";
    } else if (provider === "gemini") {
      apiKey = config.agentGeminiKey;
      baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    } else if (provider === "mistral") {
      apiKey = config.agentMistralKey;
      baseUrl = "https://api.mistral.ai/v1";
    } else if (provider === "groq") {
      apiKey = config.agentGroqKey;
      baseUrl = "https://api.groq.com/openai/v1";
    } else if (provider === "together") {
      apiKey = config.agentTogetherKey;
      baseUrl = "https://api.together.xyz/v1";
    } else if (provider === "xai") {
      apiKey = config.agentXaiKey;
      baseUrl = "https://api.x.ai/v1";
    } else if (provider === "opencode") {
      apiKey = config.agentOpencodeKey;
      baseUrl = "https://opencode.ai/zen/v1";
    } else if (provider === "custom") {
      apiKey = config.agentCustomKey;
      baseUrl = config.agentCustomUrl;
    }
    return { apiKey, baseUrl };
  }

  function getProviderFallbackModels(provider) {
    const defaults = {
      openrouter: {
        lite: "google/gemini-flash-latest",
        pro: "anthropic/claude-3.5-sonnet",
      },
      anthropic: {
        lite: "claude-3-5-haiku-20241022",
        pro: "claude-3-5-sonnet-20241022",
      },
      openai: { lite: "gpt-4o-mini", pro: "gpt-4o" },
      deepseek: { lite: "deepseek-chat", pro: "deepseek-reasoner" },
      gemini: { lite: "gemini-flash-latest", pro: "gemini-pro-latest" },
      mistral: { lite: "open-mistral-7b", pro: "mistral-large-latest" },
      groq: { lite: "llama3-8b-8192", pro: "llama-3.3-70b-versatile" },
      together: {
        lite: "meta-llama/Llama-3-8b-chat-hf",
        pro: "meta-llama/Llama-3.3-70b-instruct-turbo",
      },
      xai: { lite: "grok-beta", pro: "grok-beta" },
      opencode: {
        lite: "deepseek-v4-flash-free",
        pro: "deepseek-v4-flash-free",
      },
      custom: { lite: "llama3", pro: "llama3" },
    };
    return defaults[provider] || defaults.openrouter;
  }

  function isModelCompatibleWithProvider(provider, model) {
    if (!model) return false;
    if (
      provider === "custom" ||
      provider === "openrouter" ||
      provider === "opencode"
    )
      return true;

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
      return /^(llama|llama3|llama-3|mixtral|gemma|qwen|deepseek|moonshot)/.test(
        model,
      );
    if (provider === "together") return model.includes("/");
    if (provider === "xai") return model.startsWith("grok-");
    if (provider === "opencode") return true;
    return true;
  }

  function resolveModelForProvider(provider, requestedModel, tier) {
    if (isModelCompatibleWithProvider(provider, requestedModel))
      return requestedModel;
    const fallbacks = getProviderFallbackModels(provider);
    const fallback = tier === "pro" ? fallbacks.pro : fallbacks.lite;
    addLogEntry(
      "system",
      "Model Compatibility Fallback",
      `Model "${requestedModel || "(empty)"}" is not valid for ${provider}. Using "${fallback}" for ${tier}.`,
    );
    return fallback;
  }

  function getProviderKeyValidationError(provider, apiKey) {
    const key = (apiKey || "").trim();
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
    if (provider === "opencode" && !key.startsWith("sk-"))
      return 'OpenCode keys usually start with "sk-".';
    return "";
  }

  function hasProviderCredentials(provider) {
    if (provider === "custom") return true;
    const details = getProviderDetails(provider);
    return !getProviderKeyValidationError(provider, details.apiKey);
  }

  function getMissingCredentialsMessage(provider) {
    const details = getProviderDetails(provider);
    const validationError = getProviderKeyValidationError(
      provider,
      details.apiKey,
    );
    return `${validationError || `Missing API key for active provider "${provider}".`} Open Settings, add the correct ${provider} key, save, then run the agent again.`;
  }

  // Load non-sensitive settings from sync storage and credentials locally.
  // The legacy sync read migrates keys saved by versions before 3.1.
  function loadSettings(callback = null) {
    const legacyKeys = CONFIG.STORAGE.API_KEYS;
    chrome.storage.sync.get(
      [...CONFIG.STORAGE.SETTINGS, ...legacyKeys],
      (syncItems) => {
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

      config.agentActiveProvider = items.agentActiveProvider || "opencode";
      config.agentOpenRouterKey = items.agentOpenRouterKey || "";
      config.agentAnthropicKey = items.agentAnthropicKey || "";
      config.agentOpenAIKey = items.agentOpenAIKey || "";
      config.agentDeepSeekKey = items.agentDeepSeekKey || "";
      config.agentGeminiKey = items.agentGeminiKey || "";
      config.agentMistralKey = items.agentMistralKey || "";
      config.agentGroqKey = items.agentGroqKey || "";
      config.agentTogetherKey = items.agentTogetherKey || "";
      config.agentXaiKey = items.agentXaiKey || "";
      config.agentOpencodeKey = items.agentOpencodeKey || "";
      config.agentCustomKey = items.agentCustomKey || "";
      config.agentCustomUrl =
        items.agentCustomUrl || "http://localhost:11434/v1";

      config.agentModel = items.agentModel || "deepseek-v4-flash-free";
      config.agentRoutingStrategy = items.agentRoutingStrategy || "dual";

      agentMaxStepsLimit = items.agentMaxSteps || 25;

      config.agentSystemPrompt =
        items.agentSystemPrompt || DEFAULT_SYSTEM_PROMPT;

      config.agentTimeout =
        items.agentTimeout !== undefined ? items.agentTimeout : 60000;
      config.agentMaxTokensPerCall =
        items.agentMaxTokensPerCall !== undefined
          ? items.agentMaxTokensPerCall
          : 2000;
      config.agentTemperature =
        items.agentTemperature !== undefined ? items.agentTemperature : 0.1;
      config.agentCostBudget =
        items.agentCostBudget !== undefined
          ? parseFloat(items.agentCostBudget)
          : 0;
      config.agentDomainAllowlist = items.agentDomainAllowlist || "";
      config.agentRiskConfirmation = items.agentRiskConfirmation !== false;
      config.agentElementLimit =
        items.agentElementLimit !== undefined
          ? parseInt(items.agentElementLimit, 10)
          : 60;
      config.agentHistoryLimit =
        items.agentHistoryLimit !== undefined
          ? parseInt(items.agentHistoryLimit, 10)
          : 12;
      config.agentFailureThreshold =
        items.agentFailureThreshold !== undefined
          ? parseInt(items.agentFailureThreshold, 10)
          : 3;
      config.agentPromptCaching = items.agentPromptCaching !== false;

      // Apply Theme
      const theme =
        items.theme ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light");
      document.documentElement.setAttribute("data-theme", theme);

      // Update header selector
      const providerCapitalized =
        config.agentActiveProvider.charAt(0).toUpperCase() +
        config.agentActiveProvider.slice(1);

      const selectedModelName = document.getElementById("selectedModelName");
      if (selectedModelName) {
        selectedModelName.textContent = `Browser Agent (${providerCapitalized})`;
      }

      // Restore sidebar collapsed state
      if (sidebar) {
        if (items.sidebarCollapsed === true) {
          sidebar.classList.add("collapsed");
          if (sidebarBackdrop) sidebarBackdrop.classList.remove("active");
        } else {
          sidebar.classList.remove("collapsed");
          if (sidebarBackdrop) {
            if (window.innerWidth <= 768) {
              sidebarBackdrop.classList.add("active");
            } else {
              sidebarBackdrop.classList.remove("active");
            }
          }
        }
      }

      // Validate API Key Availability
      const missingCredentials = !hasProviderCredentials(
        config.agentActiveProvider,
      );

      if (missingCredentials) {
        credentialsWarning.style.display = "flex";
        actionBtn.disabled = true;
      } else {
        credentialsWarning.style.display = "none";
        actionBtn.disabled = false;
      }
      if (callback) callback();
        });
      },
    );
  }

  // Settings storage changed listener
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "sync" || namespace === "local") {
      loadSettings();
    }
  });

  // Helper to escape HTML text to prevent element injection
  function escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function appendSimpleUserBubble(text) {
    welcomeScreen.style.display = "none";
    const userBubble = document.createElement("div");
    userBubble.className = "message-bubble user";
    userBubble.innerHTML = `<div class="bubble-content">${escapeHtml(text)}</div>`;
    chatContainer.appendChild(userBubble);
    conversationHistory.push({ role: "user", text });
    if (conversationHistory.length > 12)
      conversationHistory = conversationHistory.slice(-12);
    scrollToBottom();
  }

  function appendSimpleAssistantBubble(text, recordHistory = true) {
    const assistantBubble = document.createElement("div");
    assistantBubble.className = "message-bubble assistant";
    assistantBubble.innerHTML = `
            <div class="bubble-avatar">A</div>
            <div class="bubble-content">
                <div class="final-answer-box" style="display: block;">${escapeHtml(text)}</div>
            </div>
        `;
    chatContainer.appendChild(assistantBubble);
    if (recordHistory) {
      conversationHistory.push({ role: "assistant", text });
      if (conversationHistory.length > 12)
        conversationHistory = conversationHistory.slice(-12);
    }
    scrollToBottom();
    return assistantBubble;
  }

  function setSimpleAssistantBubbleText(assistantBubble, text) {
    const answerBox = assistantBubble?.querySelector(".final-answer-box");
    if (answerBox) answerBox.textContent = text;
    conversationHistory.push({ role: "assistant", text });
    if (conversationHistory.length > 12)
      conversationHistory = conversationHistory.slice(-12);
    scrollToBottom();
  }

  function formatConversationContext() {
    return conversationHistory
      .slice(-8)
      .map((turn) => `${turn.role}: ${turn.text}`)
      .join("\n");
  }

  function formatBrowserCapabilityPrompt() {
    return browserCapabilityPrompt;
  }

  // Scroll viewport to bottom
  function scrollToBottom() {
    chatViewport.scrollTop = chatViewport.scrollHeight;
  }

  // Helper to print animated log cards
  function addLogEntry(role, title, description) {
    if (!activeLogsWrapper) return;
    const timeString = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const logItem = document.createElement("div");
    logItem.className = `log-item ${role}-role`;

    const logHeader = document.createElement("div");
    logHeader.className = "log-header";

    const logTitle = document.createElement("span");
    logTitle.innerHTML = `<strong>[${role.toUpperCase()}]</strong> ${title}`;

    const logTime = document.createElement("span");
    logTime.className = "log-time";
    logTime.textContent = timeString;

    logHeader.appendChild(logTitle);
    logHeader.appendChild(logTime);

    const logDesc = document.createElement("div");
    logDesc.className = "log-content";
    logDesc.textContent = description;

    logItem.appendChild(logHeader);
    logItem.appendChild(logDesc);

    activeLogsWrapper.appendChild(logItem);
    activeLogsWrapper.scrollTop = activeLogsWrapper.scrollHeight;
    scrollToBottom();
  }

  // Update status radar
  function setStatus(agentRole, message) {
    if (activeRadar) {
      activeRadar.className = `radar ${agentRole}-active`;
    }
    if (activeWave) {
      if (
        isRunning &&
        (agentRole === "planner" ||
          agentRole === "executor" ||
          agentRole === "validator")
      ) {
        activeWave.style.display = "flex";
        if (activeRadar) activeRadar.style.display = "none";
        if (activeAvatar) activeAvatar.classList.add("thinking");
      } else {
        activeWave.style.display = "none";
        if (activeRadar) activeRadar.style.display = "block";
        if (activeAvatar) activeAvatar.classList.remove("thinking");
      }
    }
    if (activeBubbleStatus) {
      activeBubbleStatus.textContent = message;
    }
    scrollToBottom();
  }

  // Resolves current active/target tab
  function getActiveTab(callback) {
    if (targetTabId !== null) {
      chrome.tabs.get(targetTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          // Reset and re-resolve
          targetTabId = null;
          currentAgentTabId = null;
          resolveTargetTab();
        } else {
          currentAgentTabId = targetTabId;
          callback(targetTabId, tab);
        }
      });
      return;
    }

    resolveTargetTab();

    function resolveTargetTab() {
      // 1. Try URL query parameter
      const urlParams = new URLSearchParams(window.location.search);
      const urlTabId = parseInt(urlParams.get("tabId"), 10);
      if (!isNaN(urlTabId)) {
        targetTabId = urlTabId;
        chrome.tabs.get(targetTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            targetTabId = null;
            currentAgentTabId = null;
            fallbackQuery();
          } else {
            currentAgentTabId = targetTabId;
            callback(targetTabId, tab);
          }
        });
        return;
      }

      fallbackQuery();
    }

    function fallbackQuery() {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs.length > 0) {
          const activeTab = tabs[0];
          if (activeTab.url.startsWith(chrome.runtime.getURL(""))) {
            // We are active (e.g. extension tab). Query other tabs in current window.
            chrome.tabs.query({ currentWindow: true }, (allTabs) => {
              const nonExtTabs = allTabs.filter(
                (t) => !t.url.startsWith(chrome.runtime.getURL("")),
              );
              if (nonExtTabs.length > 0) {
                targetTabId = nonExtTabs[0].id;
                currentAgentTabId = targetTabId;
                callback(targetTabId, nonExtTabs[0]);
              } else {
                stopAgent("No target webpage tab found to automate.", "error");
              }
            });
          } else {
            targetTabId = activeTab.id;
            currentAgentTabId = targetTabId;
            callback(targetTabId, activeTab);
          }
        } else {
          stopAgent("No target webpage tab found to automate.", "error");
        }
      });
    }
  }

  // Inject DOM scanner
  function injectContentScript(tabId, callback) {
    chrome.tabs.sendMessage(tabId, { action: "scan" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        chrome.scripting.executeScript(
          {
            target: { tabId: tabId },
            files: ["agentContentScript.js"],
          },
          () => {
            if (chrome.runtime.lastError) {
              offerSiteAccess(tabId, () => injectContentScript(tabId, callback));
              return;
            }
            setTimeout(() => {
              chrome.tabs.sendMessage(
                tabId,
                { action: "scan" },
                (retryResponse) => {
                  if (chrome.runtime.lastError || !retryResponse) {
                    stopAgent(
                      "Failed to communicate with tab content script.",
                      "error",
                    );
                  } else {
                    normalizeAndCallback(retryResponse);
                  }
                },
              );
            }, 200);
          },
        );
      } else {
        normalizeAndCallback(response);
      }
    });

    function normalizeAndCallback(res) {
      if (!res) {
        res = { url: "", title: "", elements: [] };
      } else if (!Array.isArray(res.elements)) {
        res.elements = [];
      }
      callback(res);
    }
  }

  function offerSiteAccess(tabId, onGranted) {
    chrome.tabs.get(tabId, (tab) => {
      let parsed;
      try {
        parsed = new URL(tab?.url || "");
      } catch (_error) {
        stopAgent("Cannot access this protected browser page.", "error");
        return;
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        stopAgent("Chrome does not allow extensions to automate this protected page.", "error");
        return;
      }

      const pattern = `${parsed.protocol}//${parsed.host}/*`;
      const card = document.createElement("div");
      card.className = "message-bubble assistant confirmation-bubble";

      const content = document.createElement("div");
      content.className = "bubble-content";
      const title = document.createElement("p");
      title.textContent = "Site access required";
      title.style.fontWeight = "600";
      const explanation = document.createElement("p");
      explanation.textContent = `Allow Select to AI to operate on ${parsed.hostname} for this task?`;
      const allowButton = document.createElement("button");
      allowButton.className = "primary-btn";
      allowButton.textContent = "Allow this site";
      const abortButton = document.createElement("button");
      abortButton.className = "secondary-btn";
      abortButton.textContent = "Abort task";

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:10px;margin-top:12px";
      actions.append(allowButton, abortButton);
      content.append(title, explanation, actions);
      card.append(content);
      chatContainer.appendChild(card);
      scrollToBottom();

      allowButton.addEventListener("click", () => {
        chrome.permissions.request({ origins: [pattern] }, (granted) => {
          if (granted) {
            card.remove();
            onGranted();
          } else {
            explanation.textContent = `Access to ${parsed.hostname} was not granted.`;
          }
        });
      });
      abortButton.addEventListener("click", () => {
        card.remove();
        stopAgent("Task stopped because site access was not granted.", "idle");
      });
    });
  }

  // Render / Update checklist UI nodes
  function updateChecklistUI() {
    if (!activeChecklistItems) return;
    activeChecklistItems.innerHTML = "";
    if (subtasks.length === 0) return;

    subtasks.forEach((task, index) => {
      const taskText =
        typeof task === "string" ? task : task.task || JSON.stringify(task);
      const item = document.createElement("div");
      item.className = "checklist-item";
      if (index === currentSubtaskIndex) item.className += " active";
      if (index < currentSubtaskIndex) item.className += " completed";

      const bullet = document.createElement("div");
      bullet.className = "checklist-bullet";
      if (index < currentSubtaskIndex) bullet.textContent = "✓";
      else bullet.textContent = index + 1;

      const textSpan = document.createElement("span");
      textSpan.textContent = taskText;

      item.appendChild(bullet);
      item.appendChild(textSpan);
      activeChecklistItems.appendChild(item);
    });

    // Compute percentage
    const percent = Math.min(
      100,
      Math.round((currentSubtaskIndex / subtasks.length) * 100),
    );
    if (activeProgressBar) {
      activeProgressBar.style.width = percent + "%";
    }
    if (activeThoughtStatus) {
      activeThoughtStatus.textContent = `running plan (${percent}%)...`;
    }

    // Scroll active item into view
    const activeNode = activeChecklistItems.querySelector(
      ".checklist-item.active",
    );
    if (activeNode)
      activeNode.scrollIntoView({ behavior: "smooth", block: "nearest" });
    scrollToBottom();
  }

  // Start Loop
  function startAgent() {
    loadSettings(() => startAgentWithLoadedSettings());
  }

  function startAgentWithLoadedSettings() {
    const task = taskInput.value.trim();
    if (!task) {
      alert("Please input a task instruction first.");
      return;
    }

    if (!hasProviderCredentials(config.agentActiveProvider)) {
      const message = getMissingCredentialsMessage(config.agentActiveProvider);
      if (credentialsWarning) credentialsWarning.style.display = "flex";
      addLogEntry("error", "Missing API Credentials", message);
      setStatus("error", message);
      actionBtn.disabled = true;
      return;
    }

    routeUserTurn(task);
  }

  function routeUserTurn(task) {
    appendSimpleUserBubble(task);
    taskInput.value = "";
    taskInput.style.height = "auto";
    const routingBubble = appendSimpleAssistantBubble("Thinking...", false);

    const previousStreamPanel = activeStreamPanel;
    const previousStreamText = activeStreamText;
    activeStreamPanel = null;
    activeStreamText = null;
    const isShortCommand = task.trim().split(/\s+/).length <= 3;
    const hasInterrogative =
      /^(what|who|where|why|when|how|summarize|read|tell|can|is|are)\b/i.test(
        task.trim(),
      ) || task.includes("?");
    const contextBlock =
      isShortCommand && !hasInterrogative
        ? ""
        : `
<current_context>
Recent conversation:
${formatConversationContext() || "[No prior conversation]"}
</current_context>`;

    const systemPrompt = `<instructions>
You are the intent and capability router for a browser-capable assistant.
Classify the user's latest message into exactly one route:
- "chat": normal conversation, greetings, advice, explanation, brainstorming, or questions that do not require live browser state or actions.
- "context": answer using current browser/tab/page state without creating a multi-step automation plan. Use this ONLY when the user EXPLICITLY asks about the current page, current tab, URL, title, site, open tabs, visible data, or visible errors/statuses (e.g., "what tab is this?", "summarize this page"). DO NOT use this route for single words, brand names, or search topics.
- "quick_action": run exactly one direct browser command without planner/executor/validator. Use this for simple commands like opening a website, navigating to a URL, creating a tab, switching tabs, reloading the current tab, listing tabs, or closing a tab.
- "browser": operate the browser or inspect the live page deeply. Use this for searching the web, comparing live results, filling forms, clicking, typing, scrolling, navigating, or completing a web workflow.
- "clarify": the user intent is ambiguous and you need one short question before deciding.

### Grounding & Action Capabilities:
${formatBrowserCapabilityPrompt()}

### Crucial Constraints:
- NEVER refuse a request by claiming you cannot browse or cannot open websites. You possess full browser control capabilities.
- For requests asking to open a website, you MUST select "quick_action" or "browser". Do NOT classify these as "chat".
- If the user types a single word or phrase, evaluate if it is a well-known web platform/brand (e.g., "youtube", "twitter", "netflix"). If yes, route as "quick_action", action "navigate", with the canonical URL. If it is a generic topic (e.g., "apples", "weather", "news"), route as "browser" to perform a web search.
- For any factual lookup request (e.g. "what is the score of...", "top 10 imdb movies"), you MUST select "browser" to perform a live web search, not "chat".
- Output ONLY a valid JSON object matching the schema below. Do NOT wrap the JSON in markdown code blocks (e.g. do not use \`\`\`json).

### Response Schema:
{
  "thought_process": "Analyze the user's core intent: 1) Is this chat? 2) Do they want me to read the screen? 3) Is it a 1-step navigation command (if so, explicitly deduce the exact URL here)? 4) Or is this a complex request? Explain your deduction step-by-step.",
  "route": "chat" | "context" | "quick_action" | "browser" | "clarify",
  "reply": "A brief, positive acknowledgement or chat response. Do NOT claim you cannot perform the task.",
  "action": "open_tab" | "navigate" | "list_tabs" | "switch_tab" | "reload_tab" | "close_tab" | null,
  "url": "The fully qualified URL (e.g., 'https://www.google.com'). If the user types a brand name like 'youtube', you MUST synthesize the full canonical URL. REQUIRED if action is open_tab or navigate.",
  "tabId": <tabId number or null>,
  "browser_task": "The exact, comprehensive task description for the multi-step browser automation engine. Preserve all specifics, filters, and user constraints."
}
</instructions>
${contextBlock}`;

    callLLM(systemPrompt, `Latest user message: ${task}`, (intent) => {
      activeStreamPanel = previousStreamPanel;
      activeStreamText = previousStreamText;

      const route = String(intent?.route || "clarify").toLowerCase();
      const reply =
        intent?.reply ||
        "Do you want me to answer normally, or use the browser for a task?";

      if (route === "browser") {
        setSimpleAssistantBubbleText(
          routingBubble,
          reply || "I’ll use the browser for that.",
        );
        setTimeout(() => {
          routingBubble.remove();
          continueBrowserAutomation(intent?.browser_task || task, true);
        }, 250);
        return;
      }

      if (route === "context") {
        answerFromBrowserContext(task, routingBubble);
        return;
      }

      if (route === "quick_action") {
        runQuickBrowserAction(task, intent, routingBubble, reply);
        return;
      }

      setSimpleAssistantBubbleText(routingBubble, reply);
    });
  }

  function normalizeActionUrl(url) {
    if (!url || typeof url !== "string") return "";
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  function runQuickBrowserAction(task, actionObj, routingBubble, pendingReply) {
    if (typeof actionObj === "string") {
      try {
        actionObj = JSON.parse(actionObj);
      } catch (e) {
        actionObj = null;
      }
    }

    if (!actionObj || !actionObj.action) {
      setSimpleAssistantBubbleText(
        routingBubble,
        "I could not decide the browser action cleanly. Try saying the site or tab action more directly.",
      );
      return;
    }

    currentTask = task;
    currentStep += 1;
    const action = { ...actionObj };

    if (action.action === "open_tab" || action.action === "navigate") {
      if (!action.url) {
        setSimpleAssistantBubbleText(
          routingBubble,
          "I couldn't determine the exact URL. Please provide the full address or ask me to search the web.",
        );
        return;
      }
      action.url = normalizeActionUrl(action.url);
      if (!isUrlAllowed(action.url)) {
        setSimpleAssistantBubbleText(
          routingBubble,
          `Navigation blocked by domain allowlist: ${action.url}`,
        );
        return;
      }
    }

    setSimpleAssistantBubbleText(
      routingBubble,
      pendingReply || "Working on that.",
    );

    const finishBubble = (message) => {
      setSimpleAssistantBubbleText(routingBubble, message);
    };

    if (action.action === "navigate") {
      getBrowserContext((browserContext, errorMessage) => {
        if (!browserContext?.currentTab?.id) {
          finishBubble(
            errorMessage || "I can't find a webpage tab to navigate.",
          );
          return;
        }

        chrome.tabs.update(
          browserContext.currentTab.id,
          { url: action.url, active: true },
          (tab) => {
            if (chrome.runtime.lastError || !tab) {
              finishBubble(
                chrome.runtime.lastError?.message ||
                  "Failed to navigate the current tab.",
              );
              return;
            }
            targetTabId = tab.id;
            currentAgentTabId = tab.id;
            waitForTabNavigation(tab.id, 300, 8000, () => {
              finishBubble(`Opened ${action.url}`);
            });
          },
        );
      });
      return;
    }

    if (
      [
        "open_tab",
        "list_tabs",
        "switch_tab",
        "close_tab",
        "reload_tab",
      ].includes(action.action)
    ) {
      executeBrowserAction(action, task, null, (success, message) => {
        finishBubble(success ? message : `Browser action failed: ${message}`);
      });
      return;
    }

    finishBubble(`Unsupported quick browser action: ${action.action}`);
  }

  function answerFromBrowserContext(task, routingBubble) {
    getBrowserContext((browserContext, errorMessage) => {
      if (!browserContext) {
        setSimpleAssistantBubbleText(
          routingBubble,
          errorMessage || "I can't read the current browser context right now.",
        );
        return;
      }

      const currentTab = browserContext.currentTab;
      let domRequested = false;
      let screenshotRequested = false;
      let currentPageState = null;
      let currentScreenshotUrl = null;

      const recursiveAnswer = () => {
        const elementSnippet =
          currentPageState?.elements
            ?.slice(0, 60)
            .map((el) => {
              return `ID [${el.id}] ${el.type}: "${el.text || ""}"${el.value ? ` value="${el.value}"` : ""}${el.label ? ` label="${el.label}"` : ""}`;
            })
            .join("\n") || "[No interactive elements scanned]";

        const systemPrompt = `You answer current-browser and visible-page questions for a Chrome extension assistant.

${formatBrowserCapabilityPrompt()}

Use only the provided browser/page context and screenshot (if requested). Do not answer from generic assumptions.
You initially receive only the Tab Title and URL. If you need to read the full webpage text or elements to answer the user's question, output {"action": "request_dom"}. If you need to visually see the page (e.g. colors, layout), output {"action": "request_screenshot"}.
If you have enough information to answer the question, output {"action": "answer", "reply": "your answer"}.

Respond ONLY as a valid JSON object matching this schema:
{
  "thought_process": "Do I need more data (DOM or Screenshot) to answer this question?",
  "action": "answer" | "request_dom" | "request_screenshot",
  "reply": "The final answer to show the user (if action is 'answer')"
}`;

        const domStatus = currentPageState ? "Loaded" : "Not requested yet";
        const screenshotStatus = currentScreenshotUrl
          ? "Loaded"
          : "Not requested yet";

        const userMessage = `User question: ${task}

Current browser context:
Current tab: ${JSON.stringify(currentTab)}
Available tabs:
${formatTabsContext(browserContext.tabs)}

DOM State: ${domStatus}
Screenshot State: ${screenshotStatus}

Visible page state:
URL: ${currentPageState?.url || currentTab.url}
Title: ${currentPageState?.title || currentTab.title}
Visible text:
${currentPageState?.innerText || "[No visible page text available]"}

Interactive/structured element snippet:
${elementSnippet}`;

        callLLM(
          systemPrompt,
          userMessage,
          (answer) => {
            let actionObj = answer;
            if (typeof answer === "string") {
              try {
                actionObj = JSON.parse(answer);
              } catch (e) {
                actionObj = { action: "answer", reply: answer };
              }
            }

            if (actionObj?.action === "request_dom") {
              if (domRequested) {
                actionObj.action = "answer";
                actionObj.reply =
                  "I cannot read the DOM for this page (it might be a protected chrome:// page or empty).";
              } else {
                domRequested = true;
                setSimpleAssistantBubbleText(
                  routingBubble,
                  "Scanning page content...",
                );
                if (
                  !currentTab?.id ||
                  !currentTab.url ||
                  currentTab.url.startsWith("chrome://") ||
                  currentTab.url.startsWith("chrome-extension://") ||
                  currentTab.url.startsWith("edge://")
                ) {
                  currentPageState = {
                    elements: [],
                    innerText: "[Protected Page - Cannot read DOM]",
                  };
                  recursiveAnswer();
                  return;
                }
                injectContentScript(currentTab.id, (scanResult) => {
                  currentPageState = scanResult || {
                    elements: [],
                    innerText: "[Failed to scan DOM]",
                  };
                  recursiveAnswer();
                });
                return;
              }
            }

            if (actionObj?.action === "request_screenshot") {
              if (screenshotRequested) {
                actionObj.action = "answer";
                actionObj.reply =
                  "I could not capture a screenshot for this page.";
              } else {
                screenshotRequested = true;
                setSimpleAssistantBubbleText(
                  routingBubble,
                  "Capturing screenshot...",
                );
                chrome.runtime.sendMessage(
                  { action: "captureScreenshot", tabId: currentTab?.id },
                  (screenshotRes) => {
                    currentScreenshotUrl =
                      screenshotRes && screenshotRes.success
                        ? screenshotRes.dataUrl
                        : null;
                    recursiveAnswer();
                  },
                );
                return;
              }
            }

            // Default to answer
            const reply =
              actionObj?.reply || formatCurrentTabAnswer(currentTab);
            setSimpleAssistantBubbleText(routingBubble, reply);
          },
          currentScreenshotUrl,
        );
      };

      recursiveAnswer();
    });
  }

  function formatCurrentTabAnswer(tab) {
    if (!tab)
      return "I can't see a regular webpage tab in this window right now.";
    const title = tab.title || "(Untitled)";
    const url = tab.url || "";
    return url ? `You're on "${title}".\n${url}` : `You're on "${title}".`;
  }

  function continueBrowserAutomation(task, userAlreadyRendered = false) {
    isRunning = true;
    currentTask = task;
    currentStep = 0;
    currentSubtaskIndex = 0;
    subtasks = [];
    consecutiveFailures = 0;
    actionHistory = [];
    totalPromptTokens = 0;
    totalCompletionTokens = 0;
    totalCostUSD = 0.0;
    updateCostDashboard();

    // Reset input button UI
    actionBtn.classList.add("stop-btn");
    actionBtn.title = "Stop Agent";
    actionBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" />
            </svg>
        `;

    // Disable input console
    taskInput.value = "";
    taskInput.style.height = "auto";
    taskInput.disabled = true;

    // Hide welcome recommendations grid
    welcomeScreen.style.display = "none";

    if (!userAlreadyRendered) {
      appendSimpleUserBubble(currentTask);
    }

    // Append Assistant chat bubble
    const assistantBubble = document.createElement("div");
    assistantBubble.className = "message-bubble assistant";
    assistantBubble.innerHTML = `
            <div class="bubble-avatar">A</div>
            <div class="bubble-content">
                <div class="agent-run-status">
                    <div class="radar activeRadar executor-active"></div>
                    <span class="activeStatusText">Working...</span>
                    <div class="status-wave activeWave">
                        <span></span><span></span><span></span><span></span>
                    </div>
                </div>
                <div class="checklist-panel" style="display: none;">
                    <div class="checklist-title activeThoughtStatus">running plan (0%)...</div>
                    <div class="progress-bar-container">
                        <div class="progress-bar activeProgressBar" style="width: 0%;"></div>
                    </div>
                    <div class="checklist-items activeChecklistItems"></div>
                </div>
                <div class="logs-panel">
                    <div class="logs-title">Execution Console</div>
                    <div class="logs-wrapper activeLogsWrapper"></div>
                </div>
                <div class="stream-panel activeStreamPanel" style="display: none;">
                    <div class="stream-text activeStreamText"></div>
                </div>
                <div class="final-answer-box activeFinalAnswer" style="display: none;"></div>
            </div>
        `;
    chatContainer.appendChild(assistantBubble);

    // Map active bubble elements
    activeChecklistItems = assistantBubble.querySelector(
      ".activeChecklistItems",
    );
    activeProgressBar = assistantBubble.querySelector(".activeProgressBar");
    activeLogsWrapper = assistantBubble.querySelector(".activeLogsWrapper");
    activeBubbleStatus = assistantBubble.querySelector(".activeStatusText");
    activeRadar = assistantBubble.querySelector(".activeRadar");
    activeThoughtStatus = assistantBubble.querySelector(".activeThoughtStatus");
    activeBubbleAnswer = assistantBubble.querySelector(".activeFinalAnswer");
    activeStreamPanel = assistantBubble.querySelector(".activeStreamPanel");
    activeStreamText = assistantBubble.querySelector(".activeStreamText");
    activeWave = assistantBubble.querySelector(".activeWave");
    activeAvatar = assistantBubble.querySelector(".bubble-avatar");

    // Align page height
    scrollToBottom();

    // Print initial log
    addLogEntry(
      "system",
      "Task Initialized",
      `Starting task: "${currentTask}"`,
    );

    // Go straight to execution loop
    agentStep();
  }

  // Helper to check if a URL is allowed by the domain allowlist (F10)
  function isUrlAllowed(url) {
    if (typeof SELECT_TO_AI_SECURITY !== "undefined") {
      return SELECT_TO_AI_SECURITY.isUrlAllowedByDomains(
        url,
        config.agentDomainAllowlist,
      );
    }
    return false;
  }

  // Helper to determine if an action is high risk (F11)
  function isHighRiskAction(actionObj, scanResult) {
    if (!config.agentRiskConfirmation) return false;

    const actionType = actionObj.action;
    const id = actionObj.id;
    const el = scanResult.elements.find((e) => e.id === id);

    const riskKeywords = [
      "delete",
      "remove",
      "pay",
      "purchase",
      "buy",
      "subscribe",
      "cancel",
      "terminate",
      "checkout",
      "order",
      "charge",
    ];

    if (actionType === "click" && el) {
      const textLower = (el.text || "").toLowerCase();
      const labelLower = (el.label || "").toLowerCase();
      const nameLower = (el.name || "").toLowerCase();

      const hasKeyword = riskKeywords.some(
        (kw) =>
          textLower.includes(kw) ||
          labelLower.includes(kw) ||
          nameLower.includes(kw),
      );
      if (hasKeyword) return true;
    }

    if (actionType === "type" && el) {
      const typeLower = (el.type || "").toLowerCase();
      const nameLower = (el.name || "").toLowerCase();
      const labelLower = (el.label || "").toLowerCase();

      if (
        typeLower.includes("password") ||
        nameLower.includes("card") ||
        nameLower.includes("cvv") ||
        nameLower.includes("pay") ||
        labelLower.includes("card") ||
        labelLower.includes("cvv") ||
        labelLower.includes("payment")
      ) {
        return true;
      }
    }

    if (
      (actionType === "navigate" || actionType === "open_tab") &&
      actionObj.url
    ) {
      const urlLower = actionObj.url.toLowerCase();
      if (
        urlLower.includes("checkout") ||
        urlLower.includes("payment") ||
        urlLower.includes("pay")
      ) {
        return true;
      }
    }

    return false;
  }

  // Helper to prompt user for risk confirmation (F11)
  function requestRiskConfirmation(actionObj, explanation, onConfirm, onAbort) {
    addLogEntry("system", "Risk Confirmation Required", explanation);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble assistant confirmation-bubble";
    bubble.style.border = "1px solid var(--danger)";
    bubble.style.background = "rgba(239, 68, 68, 0.05)";
    bubble.innerHTML = `
            <div class="bubble-avatar" style="background: var(--danger); color: white;">⚠</div>
            <div class="bubble-content">
                <p style="font-weight: 600; color: var(--danger); margin-bottom: 8px;">Security Confirmation Required</p>
                <p>The agent is requesting to perform a potentially high-risk action:</p>
                <blockquote style="background: rgba(255,255,255,0.05); border-left: 3px solid var(--danger); padding: 8px; margin: 8px 0; border-radius: 4px; font-family: monospace; font-size: 12px;">
                    <strong>Action:</strong> ${actionObj.action.toUpperCase()}<br/>
                    <strong>Details:</strong> ${explanation}
                </blockquote>
                <p>Do you authorize this action?</p>
                <div style="display: flex; gap: 10px; margin-top: 12px;">
                    <button id="confirmRiskBtn" class="primary-btn" style="background: var(--danger); border-color: var(--danger); color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer;">Authorize Action</button>
                    <button id="abortRiskBtn" class="secondary-btn" style="padding: 6px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border-card); background: transparent; color: var(--text-main);">Abort Task</button>
                </div>
            </div>
        `;
    chatContainer.appendChild(bubble);
    scrollToBottom();

    const confirmBtn = bubble.querySelector("#confirmRiskBtn");
    const abortBtn = bubble.querySelector("#abortRiskBtn");

    confirmBtn.addEventListener("click", () => {
      bubble.remove();
      onConfirm();
    });

    abortBtn.addEventListener("click", () => {
      bubble.remove();
      onAbort();
    });
  }

  // Helper to monitor tab loading/navigation (F6)
  function waitForTabNavigation(tabId, delayMs, maxWaitMs, callback) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        callback();
        return;
      }

      if (tab.status === "loading") {
        waitForComplete();
      } else {
        let startedLoading = false;

        const loadListener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === "loading") {
            startedLoading = true;
            chrome.tabs.onUpdated.removeListener(loadListener);
            waitForComplete();
          }
        };
        chrome.tabs.onUpdated.addListener(loadListener);

        setTimeout(() => {
          if (!startedLoading) {
            chrome.tabs.onUpdated.removeListener(loadListener);
            callback();
          }
        }, delayMs);
      }
    });

    function waitForComplete() {
      let completed = false;
      const completeListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          completed = true;
          chrome.tabs.onUpdated.removeListener(completeListener);
          clearTimeout(timeoutId);
          setTimeout(callback, 500);
        }
      };
      chrome.tabs.onUpdated.addListener(completeListener);

      const timeoutId = setTimeout(() => {
        if (!completed) {
          chrome.tabs.onUpdated.removeListener(completeListener);
          callback();
        }
      }, maxWaitMs);
    }
  }

  function getTabsContext(callback) {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      const extensionOrigin = chrome.runtime.getURL("");
      const usableTabs = (tabs || [])
        .filter(
          (tab) => tab.id && tab.url && !tab.url.startsWith(extensionOrigin),
        )
        .map((tab) => ({
          id: tab.id,
          active: !!tab.active,
          current: tab.id === currentAgentTabId,
          title: tab.title || "(Untitled)",
          url: tab.url || "",
        }));
      callback(usableTabs);
    });
  }

  function formatTabsContext(tabs) {
    if (!tabs || tabs.length === 0) return "[No browser tabs available]";
    return tabs
      .map((tab) => {
        const markers = [
          tab.current ? "agent-current" : "",
          tab.active ? "window-active" : "",
        ]
          .filter(Boolean)
          .join(", ");
        return `Tab ${tab.id}${markers ? ` (${markers})` : ""}: "${tab.title}" | ${tab.url}`;
      })
      .join("\n");
  }

  function getBrowserContext(callback) {
    const finish = (tabId, tab) => {
      currentAgentTabId = tabId;
      targetTabId = tabId;
      getTabsContext((tabs) => {
        callback({
          currentTab: {
            id: tabId,
            title: tab?.title || "(Untitled)",
            url: tab?.url || "",
            status: tab?.status || "",
            active: !!tab?.active,
          },
          tabs,
        });
      });
    };

    const queryFallback = () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const extensionOrigin = chrome.runtime.getURL("");
        const activeTab = tabs && tabs[0];

        if (
          activeTab &&
          activeTab.id &&
          activeTab.url &&
          !activeTab.url.startsWith(extensionOrigin)
        ) {
          finish(activeTab.id, activeTab);
          return;
        }

        chrome.tabs.query({ currentWindow: true }, (allTabs) => {
          const usableTabs = (allTabs || []).filter(
            (tab) => tab.id && tab.url && !tab.url.startsWith(extensionOrigin),
          );
          if (usableTabs.length === 0) {
            callback(
              null,
              "I can't see a regular webpage tab in this window right now.",
            );
            return;
          }
          finish(usableTabs[0].id, usableTabs[0]);
        });
      });
    };

    if (targetTabId !== null) {
      chrome.tabs.get(targetTabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.id) {
          finish(tab.id, tab);
          return;
        }
        targetTabId = null;
        currentAgentTabId = null;
        queryFallback();
      });
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const urlTabId = parseInt(urlParams.get("tabId"), 10);
    if (!Number.isNaN(urlTabId)) {
      chrome.tabs.get(urlTabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.id) {
          finish(tab.id, tab);
          return;
        }
        queryFallback();
      });
      return;
    }

    queryFallback();
  }

  function activateAgentTab(tabId, callback) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        callback(
          false,
          chrome.runtime.lastError?.message || `Tab ${tabId} not found.`,
        );
        return;
      }
      chrome.tabs.update(tabId, { active: true }, () => {
        if (chrome.runtime.lastError) {
          callback(false, chrome.runtime.lastError.message);
          return;
        }
        const finish = () => {
          targetTabId = tabId;
          currentAgentTabId = tabId;
          callback(true, `Switched agent context to tab ${tabId}.`);
        };
        if (tab.windowId) {
          chrome.windows.update(tab.windowId, { focused: true }, finish);
        } else {
          finish();
        }
      });
    });
  }

  function isBrowserAction(actionObj) {
    return [
      "list_tabs",
      "switch_tab",
      "open_tab",
      "close_tab",
      "reload_tab",
    ].includes(actionObj.action);
  }

  function executeBrowserAction(
    actionObj,
    activeSubtask,
    screenshotDataUrl,
    callback,
  ) {
    const recordEntry = {
      timestamp: Date.now(),
      step: currentStep,
      subtask: activeSubtask,
      action: actionObj,
      screenshot: screenshotDataUrl
        ? screenshotDataUrl.substring(0, 100) + "..."
        : null,
      success: false,
      outcome: "",
    };
    sessionRecording.push(recordEntry);

    const finish = (success, message) => {
      recordEntry.success = success;
      recordEntry.outcome = message;
      actionHistory.push({
        step: currentStep,
        subtask: activeSubtask,
        action: actionObj,
        success,
        message,
      });
      callback(success, message);
    };

    if (actionObj.action === "list_tabs") {
      getTabsContext((tabs) =>
        finish(true, `Available tabs:\n${formatTabsContext(tabs)}`),
      );
      return;
    }

    if (actionObj.action === "switch_tab") {
      const tabId = parseInt(actionObj.tabId, 10);
      if (Number.isNaN(tabId)) {
        finish(false, "Missing or invalid tabId for switch_tab.");
        return;
      }
      activateAgentTab(tabId, (success, message) => finish(success, message));
      return;
    }

    if (actionObj.action === "open_tab") {
      if (!actionObj.url) {
        finish(false, "Missing url for open_tab.");
        return;
      }
      const url = normalizeActionUrl(actionObj.url);
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          finish(
            false,
            chrome.runtime.lastError?.message || "Failed to create tab.",
          );
          return;
        }
        targetTabId = tab.id;
        currentAgentTabId = tab.id;
        waitForTabNavigation(tab.id, 300, 8000, () => {
          finish(true, `Opened new tab ${tab.id}: ${url}`);
        });
      });
      return;
    }

    if (actionObj.action === "close_tab") {
      const tabId = parseInt(actionObj.tabId || currentAgentTabId, 10);
      if (Number.isNaN(tabId)) {
        finish(false, "Missing or invalid tabId for close_tab.");
        return;
      }
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
          finish(false, chrome.runtime.lastError.message);
          return;
        }
        if (tabId === currentAgentTabId) {
          targetTabId = null;
          currentAgentTabId = null;
        }
        finish(true, `Closed tab ${tabId}.`);
      });
      return;
    }

    if (actionObj.action === "reload_tab") {
      const tabId = parseInt(actionObj.tabId || currentAgentTabId, 10);
      if (Number.isNaN(tabId)) {
        finish(false, "Missing or invalid tabId for reload_tab.");
        return;
      }
      chrome.tabs.reload(tabId, {}, () => {
        if (chrome.runtime.lastError) {
          finish(false, chrome.runtime.lastError.message);
          return;
        }
        waitForTabNavigation(tabId, 300, 8000, () =>
          finish(true, `Reloaded tab ${tabId}.`),
        );
      });
      return;
    }

    finish(false, `Unknown browser action: ${actionObj.action}`);
  }

  // Export Session Recording (F14)
  function exportSessionRecording() {
    const recordingData = {
      task: currentTask,
      startTime: sessionRecording[0]?.timestamp || Date.now(),
      endTime: Date.now(),
      steps: sessionRecording,
    };
    const blob = new Blob([JSON.stringify(recordingData, null, 2)], {
      type: "application/json;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `session_recording_${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Duplicate action loop detection helper (F9)
  function isDuplicateFailedAction(actionObj) {
    if (actionHistory.length === 0) return false;
    const last = actionHistory[actionHistory.length - 1];
    if (!last.success) {
      const a1 = last.action;
      const a2 = actionObj;
      if (
        a1.action === a2.action &&
        a1.id === a2.id &&
        a1.text === a2.text &&
        a1.scrollDirection === a2.scrollDirection &&
        a1.url === a2.url
      ) {
        return true;
      }
    }
    return false;
  }

  // Stop Loop
  function stopAgent(reason, statusState = "idle") {
    const originalTabId = targetTabId;
    isRunning = false;
    targetTabId = null;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }

    if (activeWave) {
      activeWave.style.display = "none";
    }
    if (activeAvatar) {
      activeAvatar.classList.remove("thinking");
    }

    // Reset action button style to Send
    actionBtn.classList.remove("stop-btn");
    actionBtn.title = "Run Agent";
    actionBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
        `;

    // Enable prompt input textarea
    taskInput.disabled = false;
    taskInput.focus();

    // Cross-session memory save (F13)
    if (statusState === "success") {
      const memoryItem = {
        task: currentTask,
        subtasks: subtasks,
        timestamp: Date.now(),
      };
      chrome.storage.local.get("agentCrossSessionMemory", (res) => {
        let memory = res.agentCrossSessionMemory || [];
        memory.unshift(memoryItem);
        if (memory.length > 20) {
          memory = memory.slice(0, 20);
        }
        chrome.storage.local.set({ agentCrossSessionMemory: memory });
      });
    }

    // Trigger notifications (F16)
    if (statusState === "success") {
      chrome.runtime.sendMessage({
        action: "showNotification",
        title: "Select to AI Browser Agent",
        message: `✔ Task Completed Successfully:\n${reason}`,
      });
    } else if (statusState === "error") {
      chrome.runtime.sendMessage({
        action: "showNotification",
        title: "Select to AI Browser Agent",
        message: `❌ Task Aborted/Failed:\n${reason}`,
      });
    }

    // Render outcomes in the active assistant bubble
    if (activeBubbleAnswer) {
      activeBubbleAnswer.style.display = "block";

      // Collapse thinking details on success to clean up viewport
      const details = activeBubbleAnswer.parentElement.querySelector("details");
      if (details && statusState === "success") {
        details.removeAttribute("open");
      }

      if (statusState === "success") {
        activeBubbleAnswer.innerHTML = `${escapeHtml(reason)}`;
        if (activeThoughtStatus) activeThoughtStatus.textContent = "completed";
        setStatus("validator", "Task Completed");
        if (activeRadar) activeRadar.className = "radar success";
      } else if (statusState === "error") {
        activeBubbleAnswer.innerHTML = `<span style="color: var(--danger);">${escapeHtml(reason)}</span>`;
        if (activeThoughtStatus) activeThoughtStatus.textContent = "failed";
        setStatus("error", "Task Aborted");
        if (activeRadar) activeRadar.className = "radar error";
      } else {
        activeBubbleAnswer.innerHTML = `${escapeHtml(reason)}`;
        if (activeThoughtStatus) activeThoughtStatus.textContent = "stopped";
        setStatus("idle", "Stopped");
        if (activeRadar) activeRadar.className = "radar idle";
      }
    }

    scrollToBottom();

    // Clear overlays on active tab
    getActiveTab((activeTabId) => {
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { action: "clear" }, () => {
          if (chrome.runtime.lastError) {
          }
        });
      }

      // Also clear original tab if it's different and still exists
      if (originalTabId && originalTabId !== activeTabId) {
        chrome.tabs.sendMessage(originalTabId, { action: "clear" }, () => {
          if (chrome.runtime.lastError) {
          }
        });
      }
    });
  }

  // ==========================================
  // MULTI-AGENT PIPELINE
  // ==========================================

  function formatMemoryContext(memory) {
    if (!memory || memory.length === 0) return "";
    let context = "\n### Cross-Session Memory (Previously Successful Tasks):\n";
    memory.slice(0, 5).forEach((item, idx) => {
      context += `- Goal: "${item.task}" -> Subtasks: ${JSON.stringify(item.subtasks)}\n`;
    });
    return context;
  }

  // ==========================================
  // UNIFIED BROWSER AGENT EXECUTION LOOP
  // ==========================================

  function agentStep(feedback = "", needsScreenshot = false) {
    if (!isRunning) return;

    currentStep++;
    if (currentStep > agentMaxStepsLimit) {
      stopAgent(
        `Aborted to prevent infinite loops (Max ${agentMaxStepsLimit} steps reached).`,
        "error",
      );
      return;
    }

    setStatus("executor", "Analyzing page...");
    addLogEntry(
      "executor",
      `Running Step ${currentStep}`,
      `Analyzing current browser state...`,
    );

    getActiveTab((tabId, tab) => {
      if (!isUrlAllowed(tab.url)) {
        stopAgent(`URL blocked by allowlist: ${tab.url}`, "error");
        return;
      }

      injectContentScript(tabId, (scanResult) => {
        if (!isRunning) return;
        getTabsContext((browserTabs) => {
          if (!isRunning) return;

          const elementLimit = config.agentElementLimit || 60;
          const visibleElements = (scanResult.elements || []).slice(
            0,
            elementLimit,
          );
          const elementsDescription = visibleElements
            .map((el) => {
              let attrs = `id="${el.id}"`;
              if (el.type) attrs += ` type="${el.type}"`;
              if (el.placeholder) attrs += ` placeholder="${el.placeholder}"`;
              if (el.label) attrs += ` aria-label="${el.label}"`;
              if (el.role) attrs += ` role="${el.role}"`;
              if (el.value) attrs += ` value="${el.value}"`;
              if (el.checked) attrs += ` checked="true"`;
              if (el.disabled) attrs += ` disabled="true"`;

              const tag = el.tagName ? el.tagName.toLowerCase() : "element";
              return `<${tag} ${attrs}>${el.text || ""}</${tag}>`;
            })
            .join("\n");

          // Action history
          const historyLimit = config.agentHistoryLimit || 12;
          const prunedHistory = actionHistory.slice(-historyLimit);
          let historyStr = "<history>\n";
          if (prunedHistory.length > 0) {
            historyStr += prunedHistory
              .map(
                (h) =>
                  `  <step number="${h.step}" status="${h.success ? "Success" : "Failed"}" message="${h.message}">\n    <action_taken>${JSON.stringify(h.action)}</action_taken>\n  </step>`,
              )
              .join("\n");
          } else {
            historyStr += '  <step status="Info">No actions taken yet.</step>';
          }
          historyStr += "\n</history>";

          // Construct system prompt optimized for instruct models
          const baseSystemPrompt = config.agentSystemPrompt
            ? `${config.agentSystemPrompt}\n\n`
            : "";

          const systemPrompt = `${baseSystemPrompt}<instructions>
You are an advanced, autonomous Web Browser Agent. Your objective is to complete the user's high-level request by autonomously driving a web browser. You do not ask the user for help; you execute actions until the goal is met.

### 1. Core Operating Directives
- **Zero Hallucination**: You MUST NOT answer factual queries (sports, weather, news, movies) from your internal memory. You MUST perform a live web search to retrieve and verify the exact data.
- **One Action Per Step**: You can only execute EXACTLY ONE action per step. You must wait for the page to update before taking the next.
- **Think Before Acting**: Use the "thought" field to analyze the current URL, the visible elements, the action history, and plan the immediate next step.

### 2. Standard Operating Procedures (SOPs)
- **Web Searching**:
  1. \`navigate\` to "https://www.google.com".
  2. Locate the search input bar (usually type="search" or title="Search").
  3. \`type\` your query into the search bar.
  4. \`keypress\` "Enter" OR \`click\` the Google Search button.
  5. Wait for results, read the extracted text, and if you have the answer, use \`finish\`. If not, \`click\` a search result link.
- **Form Filling**:
  1. Identify all required input IDs.
  2. \`type\` into text fields, \`select_option\` for dropdowns, \`checkbox_toggle\` for radios/checkboxes.
  3. You MUST \`click\` the Submit/Continue button after filling the form. Typing does NOT auto-submit.
- **Dealing with Overlays**: If you see a Cookie Consent banner, Newsletter pop-up, or Login modal obstructing the page, your FIRST priority is to \`click\` the "Accept", "Decline", or "Close (X)" button to clear the viewport.

### 3. Exhaustive Action Dictionary
Choose exactly one action from this dictionary. Provide the EXACT parameters required.

1. **click**: Left-clicks an element. Triggers navigation or form submission.
   - Params: \`"id": <number>\`
2. **double_click**: Double-clicks an element (useful for highlighting text or special webapp interactions).
   - Params: \`"id": <number>\`
3. **right_click**: Opens context menus.
   - Params: \`"id": <number>\`
4. **hover**: Moves the mouse over an element to trigger dropdowns or tooltips.
   - Params: \`"id": <number>\`
5. **type**: Injects text into an input field or textarea. Does NOT press Enter automatically.
   - Params: \`"id": <number>\`, \`"text": "value to type"\`
6. **clear**: Clears all existing text from an input field.
   - Params: \`"id": <number>\`
7. **select_option**: Selects a specific text option from an HTML \`<select>\` dropdown.
   - Params: \`"id": <number>\`, \`"optionText": "exact text of the option"\`
8. **checkbox_toggle**: Toggles the state of a checkbox or radio button.
   - Params: \`"id": <number>\`
9. **keypress**: Simulates pressing a specific keyboard key on a target element (or globally if id is null).
   - Params: \`"id": <number or null>\`, \`"text": "Enter" | "Tab" | "Escape" | "Backspace"\`
10. **scroll**: Scrolls the viewport or a specific container to reveal hidden elements. (Crucial when the target element is below the fold).
    - Params: \`"scrollDirection": "down" | "up" | "left" | "right"\`, \`"scrollTarget": <id or null>\`
11. **navigate**: Instructs the browser to load a specific URL in the current tab. Must be a fully qualified URL.
    - Params: \`"url": "https://..."\`
12. **wait**: Pauses execution for a specific duration to allow heavy SPA frameworks to render.
    - Params: \`"duration": <milliseconds (e.g., 2000)>\`
13. **back** / **forward**: Triggers browser history navigation.
    - Params: None (just the action name)
14. **request_screenshot**: Captures a full visual screenshot of the current viewport and feeds it into your very next step. Use this if the text DOM is missing context or you are failing to find a visual element.
    - Params: None (just the action name)
15. **open_tab** / **switch_tab** / **close_tab** / **reload_tab**: Tab management.
    - Params (open_tab): \`"url": "https://..."\`
    - Params (switch/close): \`"tabId": <number>\`
16. **finish**: Terminates the automation loop. ONLY use this when the user's high-level goal is 100% complete.
    - Params: \`"answer": "The detailed, formatted final response grounded in the web data."\`

### 4. Failure Recovery Heuristics
- If you attempt an action and receive a "Duplicate Loop Detected" feedback, it means you are stuck. You MUST try a different approach (e.g., scroll the page, click a different element, or use a keypress).
- If an element is "not interactable" or "hidden", it might be off-screen. Try using the \`scroll\` action first.
- If the text DOM is confusing or you are stuck, use \`request_screenshot\` to visually analyze the page layout.

### Response Format Constraints
You MUST output ONLY valid JSON. No markdown backticks, no conversational filler, no preambles.
{
  "thought": "Your internal reasoning...",
  "action": "<action_name>",
  "id": <id or null>,
  "text": "<text or null>",
  "url": "<url or null>",
  "reason": "Brief summary of what you are doing"
}
</instructions>

<current_context>
High-level Goal: "${currentTask}"
Current Tab URL: ${scanResult.url}
Current Tab Page Title: ${scanResult.title}

Available Browser Tabs:
${formatTabsContext(browserTabs)}

Action History:
${historyStr}

${feedback ? `Feedback from last attempt (IMPORTANT): "${feedback}"\n` : ""}

Interactive Elements on Current Page Section:
${elementsDescription || "[No interactive elements found on this section]"}

Page Text content:
${(function () {
  if (!scanResult.innerText) return "[No text content found]";
  let text = scanResult.innerText;
  if (text.length <= 3000) return text;
  const slice = text.substring(0, 3000);
  const lastSpace = slice.lastIndexOf(" ");
  const lastNewline = slice.lastIndexOf("\n");
  const cutPoint = Math.max(lastSpace, lastNewline);
  return cutPoint > 0 ? slice.substring(0, cutPoint) + "..." : slice + "...";
})()}
</current_context>`;

          const executeLLM = (screenshotDataUrl) => {
            callLLM(
              systemPrompt,
              `Goal: "${currentTask}". Choose the next action.`,
              (actionObj) => {
                if (!actionObj || !actionObj.action) {
                  addLogEntry(
                    "error",
                    "Executor Error",
                    "Failed to parse action object. Retrying.",
                  );
                  setTimeout(
                    () =>
                      agentStep(
                        "Failed to parse action object. Please try again with valid JSON.",
                        needsScreenshot,
                      ),
                    1500,
                  );
                  return;
                }

                // Duplicate action detection
                if (isDuplicateFailedAction(actionObj)) {
                  addLogEntry(
                    "system",
                    "Duplicate Loop Detected",
                    `Action ${actionObj.action} on ID ${actionObj.id} already failed. Retrying with feedback...`,
                  );
                  setTimeout(
                    () =>
                      agentStep(
                        `Your action choice (${actionObj.action} on element [${actionObj.id}]) was identified as a duplicate of a previously failed action. Please select a different element or action.`,
                        needsScreenshot,
                      ),
                    1500,
                  );
                  return;
                }

                if (actionObj.action === "request_screenshot") {
                  addLogEntry(
                    "executor",
                    "Vision Requested",
                    "Capturing visual snapshot of the page...",
                  );
                  actionHistory.push({
                    step: currentStep,
                    subtask: "Complete task",
                    action: actionObj,
                    success: true,
                    message: "Screenshot requested successfully.",
                  });
                  setTimeout(
                    () =>
                      agentStep(
                        "Here is the requested screenshot of the current viewport. Analyze it to find your target.",
                        true,
                      ),
                    500,
                  );
                  return;
                }

                // Allowlist navigation check
                if (
                  (actionObj.action === "navigate" ||
                    actionObj.action === "open_tab") &&
                  actionObj.url
                ) {
                  if (!isUrlAllowed(actionObj.url)) {
                    addLogEntry(
                      "error",
                      "URL Blocked",
                      `Navigation to ${actionObj.url} is blocked by domain allowlist.`,
                    );
                    stopAgent(
                      `Navigation blocked by domain allowlist: ${actionObj.url}`,
                      "error",
                    );
                    return;
                  }
                }

                if (actionObj.action === "finish") {
                  addLogEntry(
                    "executor",
                    "Task Completed",
                    "Signaling completion.",
                  );
                  actionHistory.push({
                    step: currentStep,
                    subtask: "Complete task",
                    action: actionObj,
                    success: true,
                    message: "Task completed successfully.",
                  });
                  stopAgent(
                    actionObj.answer || actionObj.reason || "Done.",
                    "success",
                  );
                  return;
                }

                if (isBrowserAction(actionObj)) {
                  const runBrowserAction = () => {
                    addLogEntry(
                      "executor",
                      "Browser Action Decided",
                      `${actionObj.reason || actionObj.action}`,
                    );
                    executeBrowserAction(
                      actionObj,
                      "Complete task",
                      screenshotDataUrl,
                      (success, message) => {
                        if (!success) {
                          addLogEntry(
                            "error",
                            "Browser Action Failed",
                            message,
                          );
                          setTimeout(
                            () =>
                              agentStep(
                                "Your last browser action failed: " + message,
                              ),
                            1500,
                          );
                          return;
                        }
                        addLogEntry(
                          "executor",
                          "Browser Action Executed",
                          message,
                        );
                        if (actionObj.action === "list_tabs") {
                          setTimeout(() => agentStep(message), 500);
                        } else if (isRunning) {
                          setTimeout(() => agentStep(), 1000);
                        }
                      },
                    );
                  };

                  if (isHighRiskAction(actionObj, scanResult)) {
                    const explanation = `${actionObj.reason || "High risk browser action triggered"}`;
                    requestRiskConfirmation(
                      actionObj,
                      explanation,
                      runBrowserAction,
                      () => {
                        stopAgent(
                          "Task execution aborted by user safety confirmation.",
                          "idle",
                        );
                      },
                    );
                  } else {
                    runBrowserAction();
                  }
                  return;
                }

                // DOM Action Execution
                const runDomAction = () => {
                  const recordEntry = {
                    timestamp: Date.now(),
                    step: currentStep,
                    subtask: "Complete task",
                    action: actionObj,
                    screenshot: screenshotDataUrl
                      ? screenshotDataUrl.substring(0, 100) + "..."
                      : null,
                    success: false,
                    outcome: "",
                  };
                  sessionRecording.push(recordEntry);

                  addLogEntry(
                    "executor",
                    "Action Decided",
                    `${actionObj.reason || actionObj.action}`,
                  );

                  chrome.tabs.sendMessage(
                    tabId,
                    {
                      action: "interact",
                      data: actionObj,
                    },
                    (response) => {
                      if (
                        chrome.runtime.lastError ||
                        !response ||
                        !response.success
                      ) {
                        const err = response
                          ? response.error
                          : chrome.runtime.lastError
                            ? chrome.runtime.lastError.message
                            : "interaction failed";
                        addLogEntry("error", "DOM Action Failed", err);

                        recordEntry.success = false;
                        recordEntry.outcome = err;

                        actionHistory.push({
                          step: currentStep,
                          subtask: "Complete task",
                          action: actionObj,
                          success: false,
                          message: err,
                        });
                        setTimeout(
                          () => agentStep("Your last action failed: " + err),
                          1500,
                        );
                      } else {
                        addLogEntry(
                          "executor",
                          "DOM Action Executed",
                          response.message,
                        );

                        recordEntry.success = true;
                        recordEntry.outcome = response.message;

                        actionHistory.push({
                          step: currentStep,
                          subtask: "Complete task",
                          action: actionObj,
                          success: true,
                          message: response.message,
                        });

                        // Wait for tab navigation
                        waitForTabNavigation(tabId, 300, 8000, () => {
                          if (isRunning) {
                            setTimeout(() => agentStep(), 1000);
                          }
                        });
                      }
                    },
                  );
                };

                if (isHighRiskAction(actionObj, scanResult)) {
                  const explanation = `${actionObj.reason || "High risk action triggered"}`;
                  requestRiskConfirmation(
                    actionObj,
                    explanation,
                    runDomAction,
                    () => {
                      stopAgent(
                        "Task execution aborted by user safety confirmation.",
                        "idle",
                      );
                    },
                  );
                } else {
                  runDomAction();
                }
              },
              screenshotDataUrl,
            );
          };

          if (needsScreenshot) {
            chrome.runtime.sendMessage(
              { action: "captureScreenshot", tabId },
              (screenshotRes) => {
                executeLLM(
                  screenshotRes && screenshotRes.success
                    ? screenshotRes.dataUrl
                    : null,
                );
              },
            );
          } else {
            executeLLM(null);
          }
        });
      });
    });
  }

  // ==========================================
  // API CALLS HARNESS
  // ==========================================

  function parseDataUrl(dataUrl) {
    if (!dataUrl) return null;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        mediaType: match[1],
        base64Data: match[2],
      };
    }
    return null;
  }

  function supportsExplicitPromptCaching(provider, model) {
    if (config.agentPromptCaching === false) return false;
    const modelId = String(model || "").toLowerCase();
    if (provider === "anthropic") return true;
    if (provider !== "openrouter") return false;
    return (
      modelId.includes("anthropic/") ||
      modelId.includes("claude") ||
      modelId.includes("qwen/") ||
      modelId.includes("qwen")
    );
  }

  function splitSystemPromptForCaching(systemPrompt) {
    const stableBlock = formatBrowserCapabilityPrompt();
    const idx = systemPrompt.indexOf(stableBlock);
    if (idx === -1) {
      return [{ text: systemPrompt, cacheable: false }];
    }

    return [
      { text: systemPrompt.slice(0, idx), cacheable: false },
      { text: stableBlock, cacheable: true },
      { text: systemPrompt.slice(idx + stableBlock.length), cacheable: false },
    ].filter((part) => part.text && part.text.trim().length > 0);
  }

  function buildAnthropicSystemContent(systemPrompt, provider, model) {
    if (!supportsExplicitPromptCaching(provider, model)) return systemPrompt;
    return splitSystemPromptForCaching(systemPrompt).map((part) => {
      const block = { type: "text", text: part.text };
      if (part.cacheable) {
        block.cache_control = { type: "ephemeral" };
      }
      return block;
    });
  }

  function buildOpenAICompatibleSystemMessage(systemPrompt, provider, model) {
    if (!supportsExplicitPromptCaching(provider, model)) {
      return { role: "system", content: systemPrompt };
    }

    return {
      role: "system",
      content: splitSystemPromptForCaching(systemPrompt).map((part) => {
        const block = { type: "text", text: part.text };
        if (part.cacheable) {
          block.cache_control = { type: "ephemeral" };
        }
        return block;
      }),
    };
  }

  function applyPromptCachingOptions(body, headers, provider, model) {
    if (config.agentPromptCaching === false) return;

    if (provider === "openrouter") {
      body.session_id = promptCacheSessionId;
      headers["x-session-id"] = promptCacheSessionId;
    }
  }

  // Clean up API error messages (handling raw JSON objects/arrays or long stacks) (B9)
  function cleanErrorMessage(rawErrorText, status) {
    if (!rawErrorText) return `API error (HTTP ${status || "unknown"})`;

    let trimmed = rawErrorText.trim();
    try {
      // Un-wrap array if it's wrapped in square brackets (e.g. Google APIs or custom endpoints)
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const arr = JSON.parse(trimmed);
        if (arr && arr[0]) {
          trimmed =
            typeof arr[0] === "object"
              ? JSON.stringify(arr[0])
              : String(arr[0]);
        }
      }

      const obj = JSON.parse(trimmed);

      // Check nested error messages
      if (obj.error) {
        if (typeof obj.error === "object") {
          if (obj.error.message) {
            return obj.error.message;
          }
        } else if (typeof obj.error === "string") {
          return obj.error;
        }
      }
      if (obj.message) {
        return obj.message;
      }
    } catch (e) {
      // Not a JSON, fallback to plain text processing
    }

    // If it's plain text but too long, truncate it
    if (rawErrorText.length > 200) {
      return rawErrorText.substring(0, 200) + "...";
    }
    return rawErrorText;
  }

  function callLLM(
    systemPrompt,
    userMessage,
    callback,
    screenshotDataUrl = null,
    attempt = 0,
  ) {
    const provider = config.agentActiveProvider;
    const { apiKey, baseUrl } = getProviderDetails(provider);

    if (provider !== "custom" && !apiKey) {
      const message = getMissingCredentialsMessage(provider);
      addLogEntry("error", `LLM Missing Credentials`, message);
      stopAgent(message, "error");
      return;
    }

    let model = config.agentModel;
    model = resolveModelForProvider(provider, model, "lite");

    let endpoint = baseUrl;
    if (
      !endpoint.endsWith("/chat/completions") &&
      !endpoint.includes("/messages")
    ) {
      endpoint = endpoint.replace(/\/$/, "") + "/chat/completions";
    }

    const headers = {
      "Content-Type": "application/json",
    };

    let body = {};
    let usageProvided = false;

    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";

      let userContent = [{ type: "text", text: userMessage }];
      if (screenshotDataUrl) {
        const parsedUrl = parseDataUrl(screenshotDataUrl);
        if (parsedUrl) {
          userContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: parsedUrl.mediaType,
              data: parsedUrl.base64Data,
            },
          });
        }
      }

      body = {
        model: model,
        max_tokens: config.agentMaxTokensPerCall || 2000,
        system: buildAnthropicSystemContent(systemPrompt, provider, model),
        messages: [{ role: "user", content: userContent }],
        temperature:
          config.agentTemperature !== undefined ? config.agentTemperature : 0.1,
        stream: true,
      };
      applyPromptCachingOptions(body, headers, provider, model);
    } else {
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://selecttoai.github.io";
        headers["X-Title"] = "Select to AI Browser Agent";
      }

      let userContent = userMessage;
      if (screenshotDataUrl) {
        userContent = [
          { type: "text", text: userMessage },
          { type: "image_url", image_url: { url: screenshotDataUrl } },
        ];
      }

      const messages = [
        buildOpenAICompatibleSystemMessage(systemPrompt, provider, model),
        { role: "user", content: userContent },
      ];

      body = {
        model: model,
        messages: messages,
        temperature:
          config.agentTemperature !== undefined ? config.agentTemperature : 0.1,
        max_tokens: config.agentMaxTokensPerCall || 2000,
        response_format: { type: "json_object" },
        stream: true,
      };
      applyPromptCachingOptions(body, headers, provider, model);
    }

    if (activeAbortController && attempt === 0) {
      try {
        activeAbortController.abort();
      } catch (e) {}
    }

    const port = chrome.runtime.connect({ name: "streamFetch" });

    let isTimedOut = false;
    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      if (activeAbortController) {
        activeAbortController.abort();
      }
    }, config.agentTimeout || 60000);

    activeAbortController = {
      abort: () => {
        clearTimeout(timeoutId);
        try {
          port.disconnect();
        } catch (e) {}
      },
    };

    if (activeStreamPanel && activeStreamText) {
      activeStreamPanel.style.display = "flex";
      activeStreamText.textContent = "Connecting to model...";
      activeStreamText.scrollTop = activeStreamText.scrollHeight;
    }

    let replyText = "";
    let buffer = "";

    function handleError(err, status = 0, respHeaders = {}) {
      clearTimeout(timeoutId);
      try {
        port.disconnect();
      } catch (e) {}

      if (activeStreamPanel) {
        activeStreamPanel.style.display = "none";
      }
      if (isTimedOut) {
        err = new Error(
          `Request timed out after ${config.agentTimeout / 1000} seconds.`,
        );
        status = 408;
      }

      console.error(`Error in LLM model call (HTTP ${status}):`, err);

      if (status === 401 || status === 403) {
        const providerMessage = cleanErrorMessage(err.message || "", status);
        const authDetails = [
          `Provider: ${provider}`,
          `Model: ${model}`,
          `Endpoint: ${endpoint}`,
          `Provider message: ${providerMessage}`,
        ].join("\n");
        addLogEntry("error", `LLM Auth Error`, authDetails);
        stopAgent(
          `Authorization failed (HTTP ${status}) for ${provider} using ${model}. ${providerMessage}`,
          "error",
        );
        return;
      }

      if (
        (status === 404 || status === 400) &&
        err.message.match(/image|vision/i)
      ) {
        if (screenshotDataUrl) {
          addLogEntry(
            "system",
            "Vision Unavailable",
            "The selected model does not support vision capabilities. Re-routing pure text payload...",
          );
          const fallbackMessage = `${userMessage}\n\n[SYSTEM WARNING: You previously requested a screenshot, but your current model does not support Computer Vision. The screenshot payload was rejected by the provider. Please proceed using purely the text-based DOM context. Do NOT use the "request_screenshot" action again.]`;
          setTimeout(() => {
            callLLM(systemPrompt, fallbackMessage, callback, null, 0);
          }, 500);
          return;
        }
      }

      const maxRetries = 3;
      if (
        attempt < maxRetries &&
        (status === 429 || status >= 500 || status === 408 || status === 0)
      ) {
        let backoffMs = 2000 * Math.pow(2, attempt) + Math.random() * 1000;

        if (status === 429) {
          const retryAfterHeader = respHeaders
            ? respHeaders["retry-after"] || respHeaders["Retry-After"]
            : null;
          if (retryAfterHeader) {
            const seconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds)) {
              backoffMs = seconds * 1000 + Math.random() * 500;
              addLogEntry(
                "system",
                "Rate Limited (429)",
                `Retry-After header suggests waiting ${seconds}s. Waiting...`,
              );
            } else {
              const dateMs = Date.parse(retryAfterHeader);
              if (!isNaN(dateMs)) {
                const diff = dateMs - Date.now();
                if (diff > 0) {
                  backoffMs = diff + Math.random() * 500;
                  addLogEntry(
                    "system",
                    "Rate Limited (429)",
                    `Retry-After date suggests waiting ${Math.round(diff / 1000)}s. Waiting...`,
                  );
                }
              }
            }
          } else {
            addLogEntry(
              "system",
              "Rate Limited (429)",
              `No Retry-After header. Waiting ${Math.round(backoffMs / 1000)}s before retry ${attempt + 1}...`,
            );
          }
        } else {
          addLogEntry(
            "system",
            "Network/Server Error",
            `HTTP ${status || "Network"}. Waiting ${Math.round(backoffMs / 1000)}s before retry ${attempt + 1}...`,
          );
        }

        setTimeout(() => {
          callLLM(
            systemPrompt,
            userMessage,
            callback,
            screenshotDataUrl,
            attempt + 1,
          );
        }, backoffMs);
        return;
      }

      addLogEntry(
        "error",
        `LLM Model Call Error`,
        `${err.message || "Failed."} (HTTP ${status})`,
      );

      stopAgent(
        err.message || "API connection failure after retries.",
        "error",
      );
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === "error") {
        const cleaned = cleanErrorMessage(msg.error, msg.status);
        handleError(
          new Error(`API Error (HTTP ${msg.status || "unknown"}): ${cleaned}`),
          msg.status,
          msg.headers,
        );
      } else if (msg.type === "connected") {
        if (activeStreamText) {
          activeStreamText.textContent = "";
        }
      } else if (msg.type === "chunk") {
        const chunk = msg.chunk;
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;

            try {
              const parsed = JSON.parse(dataStr);
              let contentToken = parsed.choices?.[0]?.delta?.content || "";
              let reasoningToken = parsed.choices?.[0]?.delta?.reasoning || "";

              if (!contentToken && parsed.delta?.text) {
                contentToken = parsed.delta.text;
              }
              if (
                !contentToken &&
                parsed.type === "content_block_delta" &&
                parsed.delta?.text
              ) {
                contentToken = parsed.delta.text;
              }

              const combinedToken = reasoningToken + contentToken;

              if (combinedToken) {
                replyText += combinedToken;
                if (activeStreamText) {
                  activeStreamText.textContent = replyText;
                  activeStreamText.scrollTop = activeStreamText.scrollHeight;
                }
              }

              if (parsed.usage) {
                usageProvided = true;
                accumulateUsage(parsed.usage, model);
              }
            } catch (e) {
              // Substring mismatch/partial chunk JSON
            }
          }
        }
      } else if (msg.type === "done") {
        clearTimeout(timeoutId);
        try {
          port.disconnect();
        } catch (e) {}

        setTimeout(() => {
          if (activeStreamPanel) {
            activeStreamPanel.style.display = "none";
          }
        }, 1000);

        if (!usageProvided) {
          const promptTokensEst = Math.ceil(
            (systemPrompt.length + userMessage.length) / 4,
          );
          const completionTokensEst = Math.ceil(replyText.length / 4);
          accumulateUsage(
            {
              prompt_tokens: promptTokensEst,
              completion_tokens: completionTokensEst,
            },
            model,
          );
        }

        try {
          let jsonText = replyText.trim();
          if (jsonText.startsWith("```")) {
            jsonText = jsonText
              .replace(/^```json/, "")
              .replace(/^```/, "")
              .replace(/```$/, "")
              .trim();
          }
          const parsed = JSON.parse(jsonText);
          parseFailureCount = 0;
          callback(parsed);
        } catch (err) {
          console.error("JSON parsing error on reply:", replyText, err);
          const match = replyText.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const parsed = JSON.parse(match[0]);
              parseFailureCount = 0;
              callback(parsed);
              return;
            } catch (e) {}
          }

          parseFailureCount++;
          const maxParseFailures = config.agentFailureThreshold || 3;
          if (parseFailureCount >= maxParseFailures) {
            stopAgent(
              `Too many consecutive JSON parsing failures (${parseFailureCount}). Aborting.`,
              "error",
            );
          } else {
            handleError(
              new Error(
                `API response did not contain a valid JSON object. (Failure ${parseFailureCount}/${maxParseFailures})`,
              ),
            );
          }
        }
      }
    });

    try {
      port.postMessage({
        url: endpoint,
        options: {
          method: "POST",
          headers: headers,
          body: JSON.stringify(body),
        },
      });
    } catch (postErr) {
      handleError(postErr);
    }
  }

  // Export task execution logs to Markdown file
  function exportMarkdownLogs() {
    let md = `# Select to AI - Task Execution Log\n\n`;
    md += `**Goal**: ${currentTask}\n`;
    md += `**Status**: ${isRunning ? "In Progress" : "Completed"}\n`;
    md += `**Steps Taken**: ${currentStep} / ${agentMaxStepsLimit}\n\n`;

    md += `## Checklist Plan\n`;
    subtasks.forEach((s, idx) => {
      const taskText = typeof s === "string" ? s : s.task;
      const isDone = idx < currentSubtaskIndex ? "[x]" : "[ ]";
      md += `- ${isDone} ${taskText}\n`;
    });
    md += `\n`;

    md += `## Execution History\n`;
    if (actionHistory.length === 0) {
      md += `*No actions recorded yet.*\n`;
    } else {
      actionHistory.forEach((h) => {
        md += `### Step ${h.step}\n`;
        md += `- **Subtask**: ${h.subtask}\n`;
        md += `- **Action**: \`${JSON.stringify(h.action)}\`\n`;
        md += `- **Result**: ${h.success ? "Success" : "Failed"}\n`;
        md += `- **Details**: ${h.message}\n\n`;
      });
    }

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `task_log_${Date.now()}.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Omnibox handoff: agent.html?task=...&autostart=1 pre-fills the task and,
  // when asked, starts planning immediately. Risky actions still stop at the
  // in-conversation authorization gate, so autostart never skips a decision.
  (function consumeOmniboxTask() {
    try {
      const params = new URLSearchParams(window.location.search);
      const handedTask = (params.get("task") || "").trim();
      if (!handedTask) return;
      taskInput.value = handedTask.slice(0, 2000);
      taskInput.style.height = "auto";
      taskInput.style.height = taskInput.scrollHeight + "px";
      if (params.get("autostart") === "1" && !isRunning) {
        startAgent();
      } else {
        taskInput.focus();
      }
    } catch (e) {
      console.warn("Omnibox task ingest failed:", e);
    }
  })();
})();
