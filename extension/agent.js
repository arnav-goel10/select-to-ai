/**
 * Select to AI - Browser Agent Client Page Logic
 * Manages the multi-agent autonomous loop (Planner, Executor, Validator).
 */

(function () {
  "use strict";

  const DEFAULT_SYSTEM_PROMPT = CONFIG.DEFAULT_SYSTEM_PROMPT;
  const DEFAULTS = SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS;

  // State Variables
  let isRunning = false;
  let isStopping = false;
  // Monotonically increasing run-generation token. Every deferred continuation
  // (setTimeout, async callback, confirmation handler) captures the current
  // value and bails if it no longer matches, so a stopped run's pending work
  // can never resume, or leak into the next run.
  let runId = 0;
  let currentTask = "";
  let subtasks = [];
  let currentSubtaskIndex = 0;
  let currentStep = 0;
  let consecutiveFailures = 0;
  let parseFailureCount = 0;
  let agentMaxStepsLimit = DEFAULTS.maxSteps; // Loop safeguard loaded from storage
  let targetTabId = null;
  let targetTabUrl = "";
  let currentAgentTabId = null;
  let activeAbortController = null;
  let actionHistory = [];
  let sessionRecording = [];
  let conversationHistory = [];
  // Scratchpad memory: notes the executor saves via the `remember` action.
  // Always included in the executor prompt so multi-page tasks keep early
  // findings after navigation truncates the page context.
  let sessionNotes = [];
  // Validator bookkeeping: how many validator calls this run has spent, and
  // whether the final answer passed (only validator-passed runs are written
  // to cross-session memory).
  let validatorCalls = 0;
  let lastValidatorPassed = false;
  // Set once a provider rejects response_format/stream_options with a 400;
  // subsequent calls omit those OpenAI-compatible extras.
  let compatParamsUnsupported = false;
  // Set once a provider rejects native tools/tool_choice with a 400 (or a
  // model persistently returns no tool call); subsequent calls use the
  // legacy text-JSON protocol so nothing regresses.
  let toolsUnsupported = false;
  // Set once the provider rejects an image payload; subsequent steps stay
  // text-only even for models flagged as vision-capable.
  let visionUnsupported = false;

  // Token & Cost Tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUSD = 0.0;
  let costIsEstimated = false;

  function accumulateUsage(usage, modelName, isEstimated = false) {
    if (!usage) return;
    // OpenAI-compatible payloads use prompt_tokens/completion_tokens;
    // Anthropic payloads use input_tokens/output_tokens.
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const completionTokens =
      usage.completion_tokens ?? usage.output_tokens ?? 0;

    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
    if (isEstimated) costIsEstimated = true;

    const rates = SELECT_TO_AI_DEFAULTS.findModelRates(modelName);

    const cost =
      (promptTokens / 1000) * rates[0] + (completionTokens / 1000) * rates[1];
    totalCostUSD += cost;

    updateCostDashboard();

    // Enforce Cost Budget Ceiling (F7)
    if (config.agentCostBudget > 0 && totalCostUSD >= config.agentCostBudget) {
      const budgetRunId = runId;
      setTimeout(() => {
        if (budgetRunId !== runId) return; // run already ended/replaced
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
      // Two-decimal display with an explicit "est." qualifier whenever any
      // usage was estimated; the tooltip carries the exact figure.
      costBadge.textContent = `${costIsEstimated ? "est. " : ""}$${totalCostUSD.toFixed(2)}`;
      costBadge.title =
        `Exact: $${totalCostUSD.toFixed(6)} · tokens in: ${totalPromptTokens}, out: ${totalCompletionTokens}.` +
        (costIsEstimated
          ? " Includes estimated usage (the provider did not report token counts for every call)."
          : " Based on provider-reported token usage.");
    }
  }

  // Configuration cache
  let config = {
    agentActiveProvider: DEFAULTS.activeProvider,
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
    agentCustomUrl: DEFAULTS.customUrl,

    agentModel: DEFAULTS.model,

    agentSystemPrompt: "",
    agentTimeout: DEFAULTS.timeoutMs,
    agentMaxTokensPerCall: DEFAULTS.maxTokensPerCall,
    agentTemperature: DEFAULTS.temperature,
    agentCostBudget: DEFAULTS.costBudget,
    agentDomainAllowlist: "",
    agentRiskConfirmation: DEFAULTS.riskConfirmation,
    agentElementLimit: DEFAULTS.elementLimit,
    agentHistoryLimit: DEFAULTS.historyLimit,
    agentFailureThreshold: DEFAULTS.failureThreshold,
    agentPromptCaching: DEFAULTS.promptCaching,
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

  const credentialsWarning = document.getElementById("credentialsWarning");
  const sidebar = document.getElementById("sidebar");
  const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");
  const newTaskBtn = document.getElementById("newTaskBtn");
  const attachBtn = document.getElementById("attachBtn");
  const recentSessionsList = document.getElementById("recentSessionsList");
  const scratchpadPanel = document.getElementById("scratchpadPanel");
  const scratchpadItems = document.getElementById("scratchpadItems");
  const memoryPanel = document.getElementById("memoryPanel");
  const memoryItems = document.getElementById("memoryItems");
  const steerRow = document.getElementById("steerRow");
  const steerInput = document.getElementById("steerInput");
  const steerSendBtn = document.getElementById("steerSendBtn");
  const steerPending = document.getElementById("steerPending");

  // One queued steer message, delivered as the feedback argument of the
  // NEXT agentStep call, then cleared. Queuing again replaces it.
  let pendingSteerMessage = "";

  // Dynamic message bubble references
  let activeChecklistPanel = null;
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

  // Suggestion prompt clicks. The cards are (re)rendered from the active
  // tab's context by SELECT_TO_AI_SUGGESTIONS so a first run is one click;
  // the click handler here fills the input, matching the old behavior.
  document.querySelectorAll(".suggestion-card").forEach((card) => {
    card.addEventListener("click", () => {
      taskInput.value = card.getAttribute("data-prompt");
      taskInput.focus();
      adjustTextareaHeight();
    });
  });

  const suggestionsGrid = document.querySelector(".suggestions-grid");
  if (
    suggestionsGrid &&
    window.SELECT_TO_AI_SUGGESTIONS &&
    window.SELECT_TO_AI_SUGGESTIONS.renderContextualSuggestions
  ) {
    window.SELECT_TO_AI_SUGGESTIONS.renderContextualSuggestions(
      suggestionsGrid,
      (prompt) => {
        taskInput.value = prompt;
        taskInput.focus();
        adjustTextareaHeight();
      },
    );
  }

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

  // The sidebar stays open until the user closes it. Only the mobile
  // backdrop (which exists solely while the sidebar overlays content)
  // dismisses it, ordinary clicks elsewhere never force-collapse it.
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", () => {
      if (sidebar) sidebar.classList.add("collapsed");
      chrome.storage.sync.set({ sidebarCollapsed: true });
      sidebarBackdrop.classList.remove("active");
    });
  }

  // --- Steer-while-running ---
  // Queues ONE guidance message; agentStep() consumes it as feedback before
  // the next model call. Never interrupts or stops the run.
  function queueSteerMessage() {
    const text = (steerInput.value || "").trim();
    if (!text) return;
    pendingSteerMessage = text;
    steerInput.value = "";
    if (steerPending) {
      steerPending.textContent = `Queued for the next step: "${text.length > 80 ? text.slice(0, 77) + "..." : text}"`;
    }
    addLogEntry(
      "system",
      "User Guidance Queued",
      `Will be delivered to the agent before its next step: ${text}`,
    );
  }

  if (steerSendBtn) steerSendBtn.addEventListener("click", queueSteerMessage);
  if (steerInput) {
    steerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        queueSteerMessage();
      }
    });
  }

  function setSteerRowVisible(visible) {
    if (!steerRow) return;
    steerRow.classList.toggle("active", visible);
    if (!visible && steerPending) steerPending.textContent = "";
    if (!visible) pendingSteerMessage = "";
  }

  // --- Sidebar content: recent sessions + scratchpad/memory viewers ---

  function formatSessionTime(timestamp) {
    if (!timestamp) return "";
    try {
      const d = new Date(timestamp);
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  /** Renders validator-confirmed past runs from the cross-session store. */
  function renderRecentSessions() {
    if (!recentSessionsList) return;
    chrome.storage.local.get("agentCrossSessionMemory", (res) => {
      const memory = res.agentCrossSessionMemory || [];
      recentSessionsList.innerHTML = "";
      if (memory.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sidebar-empty-note";
        empty.textContent =
          "Completed (validated) tasks appear here. Click one to reuse it.";
        recentSessionsList.appendChild(empty);
        return;
      }
      memory.slice(0, 12).forEach((item) => {
        const row = document.createElement("div");
        row.className = "sidebar-chat-item";
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.title = item.task || "";

        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "14");
        icon.setAttribute("height", "14");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "2");
        icon.innerHTML =
          '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>';

        const title = document.createElement("span");
        title.className = "session-title";
        title.textContent = item.task || "(untitled task)";

        const time = document.createElement("span");
        time.className = "session-time";
        time.textContent = formatSessionTime(item.timestamp);

        row.appendChild(icon);
        row.appendChild(title);
        row.appendChild(time);

        const reuse = () => {
          taskInput.value = item.task || "";
          adjustTextareaHeight();
          taskInput.focus();
        };
        row.addEventListener("click", reuse);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            reuse();
          }
        });
        recentSessionsList.appendChild(row);
      });
    });
  }

  function renderScratchpadPanel() {
    if (!scratchpadItems) return;
    scratchpadItems.innerHTML = "";
    if (sessionNotes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "data-empty";
      empty.textContent = "No notes yet; the agent saves findings here during a run.";
      scratchpadItems.appendChild(empty);
      return;
    }
    sessionNotes.forEach((note) => {
      const item = document.createElement("div");
      item.className = "data-item";
      item.textContent = note;
      scratchpadItems.appendChild(item);
    });
  }

  function renderMemoryPanel() {
    if (!memoryItems) return;
    chrome.storage.local.get("agentCrossSessionMemory", (res) => {
      const memory = res.agentCrossSessionMemory || [];
      memoryItems.innerHTML = "";
      if (memory.length === 0) {
        const empty = document.createElement("div");
        empty.className = "data-empty";
        empty.textContent =
          "Empty. Only validator-confirmed task outlines are stored (never page contents).";
        memoryItems.appendChild(empty);
        return;
      }
      memory.forEach((entry) => {
        const item = document.createElement("div");
        item.className = "data-item";
        const plan = (entry.subtasks || []).join("; ");
        item.textContent = plan ? `${entry.task} · ${plan}` : entry.task;
        memoryItems.appendChild(item);
      });
    });
  }

  function bindPanelToggle(button, panel, render) {
    if (!button || !panel) return;
    button.addEventListener("click", () => {
      const open = panel.classList.toggle("open");
      button.setAttribute("aria-expanded", String(open));
      if (open) render();
    });
  }

  bindPanelToggle(
    document.getElementById("toggleScratchpadBtn"),
    scratchpadPanel,
    renderScratchpadPanel,
  );
  bindPanelToggle(
    document.getElementById("toggleMemoryBtn"),
    memoryPanel,
    renderMemoryPanel,
  );

  const clearScratchpadBtn = document.getElementById("clearScratchpadBtn");
  if (clearScratchpadBtn) {
    clearScratchpadBtn.addEventListener("click", () => {
      sessionNotes = [];
      renderScratchpadPanel();
    });
  }

  const clearMemoryBtn = document.getElementById("clearMemoryBtn");
  if (clearMemoryBtn) {
    clearMemoryBtn.addEventListener("click", () => {
      if (!confirm("Delete all stored task memory? Future plans will no longer reuse these outlines.")) {
        return;
      }
      chrome.storage.local.remove("agentCrossSessionMemory", () => {
        renderMemoryPanel();
        renderRecentSessions();
      });
    });
  }

  renderRecentSessions();

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

  // Helper to get key/url for the active provider (catalog shared with the
  // service worker via defaults.js).
  function getProviderDetails(provider) {
    if (provider === "custom") {
      return { apiKey: config.agentCustomKey, baseUrl: config.agentCustomUrl };
    }
    if (provider === "hosted") {
      // Hosted ("no key") mode: the relay injects the real credential
      // server-side, so the extension carries and sends no API key.
      return { apiKey: "", baseUrl: config.agentHostedUrl || DEFAULTS.hostedRelayUrl };
    }
    const entry = (SELECT_TO_AI_DEFAULTS.PROVIDER_ENDPOINTS || {})[provider];
    if (!entry) {
      return { apiKey: "", baseUrl: "" };
    }
    return { apiKey: config[entry.keyName] || "", baseUrl: entry.baseUrl };
  }

  function getProviderFallbackModels(provider) {
    return SELECT_TO_AI_PROVIDER_MODELS.fallbackPair(
      provider,
      SELECT_TO_AI_DEFAULTS,
    );
  }

  function isModelCompatibleWithProvider(provider, model) {
    return SELECT_TO_AI_PROVIDER_MODELS.isModelCompatible(provider, model);
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

  /**
   * Model tiers: the strong configured model ("pro") drives the executor;
   * the provider's cheap catalog model ("lite") handles routing, planning,
   * reflection, and validation. Custom and hosted gateways only have the
   * configured model, so both tiers use it there.
   */
  function resolveTierModel(provider, tier) {
    return SELECT_TO_AI_PROVIDER_MODELS.resolveTierModel(
      provider,
      tier,
      config.agentModel,
      SELECT_TO_AI_DEFAULTS,
    );
  }

  /** True when this run should auto-attach a marked screenshot each step. */
  function executorVisionEnabled() {
    if (visionUnsupported) return false;
    // Silent resolve (no fallback log spam): mirror resolveModelForProvider.
    const provider = config.agentActiveProvider;
    const model = isModelCompatibleWithProvider(provider, config.agentModel)
      ? config.agentModel
      : getProviderFallbackModels(provider).pro;
    return SELECT_TO_AI_DEFAULTS.isVisionModel(model);
  }

  function getProviderKeyValidationError(provider, apiKey) {
    // Delegates to the shared provider-models policy; hosted and custom
    // gateways need no key by design.
    return SELECT_TO_AI_PROVIDER_MODELS.validateKeyShape(provider, apiKey);
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

      config.agentActiveProvider =
        items.agentActiveProvider || DEFAULTS.activeProvider;
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
      config.agentCustomUrl = items.agentCustomUrl || DEFAULTS.customUrl;
      // Hosted relay URL override; empty means the bundled-relay default.
      config.agentHostedUrl =
        typeof items.agentHostedUrl === "string" && items.agentHostedUrl.trim()
          ? items.agentHostedUrl.trim()
          : DEFAULTS.hostedRelayUrl;

      config.agentModel = items.agentModel || DEFAULTS.model;

      agentMaxStepsLimit = items.agentMaxSteps || DEFAULTS.maxSteps;

      config.agentSystemPrompt =
        items.agentSystemPrompt || DEFAULT_SYSTEM_PROMPT;

      config.agentTimeout =
        items.agentTimeout !== undefined
          ? items.agentTimeout
          : DEFAULTS.timeoutMs;
      config.agentMaxTokensPerCall =
        items.agentMaxTokensPerCall !== undefined
          ? items.agentMaxTokensPerCall
          : DEFAULTS.maxTokensPerCall;
      config.agentTemperature =
        items.agentTemperature !== undefined
          ? items.agentTemperature
          : DEFAULTS.temperature;
      config.agentCostBudget =
        items.agentCostBudget !== undefined
          ? parseFloat(items.agentCostBudget)
          : DEFAULTS.costBudget;
      config.agentDomainAllowlist = items.agentDomainAllowlist || "";
      config.agentRiskConfirmation = items.agentRiskConfirmation !== false;
      config.agentElementLimit =
        items.agentElementLimit !== undefined
          ? parseInt(items.agentElementLimit, 10)
          : DEFAULTS.elementLimit;
      config.agentHistoryLimit =
        items.agentHistoryLimit !== undefined
          ? parseInt(items.agentHistoryLimit, 10)
          : DEFAULTS.historyLimit;
      config.agentFailureThreshold =
        items.agentFailureThreshold !== undefined
          ? parseInt(items.agentFailureThreshold, 10)
          : DEFAULTS.failureThreshold;
      config.agentPromptCaching = items.agentPromptCaching !== false;

      // Apply Theme
      const theme =
        items.theme ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light");
      document.documentElement.setAttribute("data-theme", theme);

      // Header shows the ACTUAL provider and executor model in use
      // (silently resolved, same fallback logic as the runtime, no log spam).
      const provider = config.agentActiveProvider;
      const providerCapitalized =
        provider.charAt(0).toUpperCase() + provider.slice(1);
      const resolvedModel = isModelCompatibleWithProvider(
        provider,
        config.agentModel,
      )
        ? config.agentModel
        : getProviderFallbackModels(provider).pro;

      const selectedModelName = document.getElementById("selectedModelName");
      if (selectedModelName) {
        selectedModelName.textContent = `${providerCapitalized} · ${resolvedModel}`;
      }
      const headerModel = document.getElementById("headerModel");
      if (headerModel) {
        headerModel.title = `Provider: ${providerCapitalized}\nModel: ${resolvedModel}\nChange both in Settings → Models & API.`;
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

  // Background broadcasts 'tabClosed' whenever any tab closes. If it is the
  // tab this run is driving, stop instead of silently retargeting.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.action !== "tabClosed") return;
    if (isRunning && message.tabId === targetTabId) {
      stopAgent(
        "The tab the agent was working on was closed. Task stopped.",
        "error",
      );
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

  /**
   * Renders assistant text with the minimal safe markdown subset (bold,
   * italics, bullet lists, noopener links). Everything is escaped first in
   * SELECT_TO_AI_TOOLS.renderSafeMarkdown, so model text cannot inject HTML.
   */
  function renderAnswerHtml(text) {
    return SELECT_TO_AI_TOOLS.renderSafeMarkdown(String(text ?? ""));
  }

  function appendSimpleAssistantBubble(text, recordHistory = true) {
    const assistantBubble = document.createElement("div");
    assistantBubble.className = "message-bubble assistant";
    assistantBubble.innerHTML = `
            <div class="bubble-avatar">A</div>
            <div class="bubble-content">
                <div class="final-answer-box" style="display: block;">${renderAnswerHtml(text)}</div>
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
    if (answerBox) answerBox.innerHTML = renderAnswerHtml(text);
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

  // Helper to print animated log cards. `collapsible: true` renders the
  // description inside a collapsed-by-default expander (used for per-step
  // model thoughts so the console stays scannable).
  function addLogEntry(role, title, description, { collapsible = false } = {}) {
    if (!activeLogsWrapper) return;
    const timeString = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const logItem = document.createElement("div");
    logItem.className = `log-item ${role}-role${collapsible ? " log-thought" : ""}`;

    const logHeader = document.createElement("div");
    logHeader.className = "log-header";

    const logTitle = document.createElement("span");
    logTitle.innerHTML = `<strong>[${role.toUpperCase()}]</strong> ${escapeHtml(title)}`;

    const logTime = document.createElement("span");
    logTime.className = "log-time";
    logTime.textContent = timeString;

    logHeader.appendChild(logTitle);
    logHeader.appendChild(logTime);
    logItem.appendChild(logHeader);

    if (collapsible) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Show reasoning";
      const logDesc = document.createElement("div");
      logDesc.className = "log-content";
      logDesc.textContent = description;
      details.appendChild(summary);
      details.appendChild(logDesc);
      logItem.appendChild(details);
    } else {
      const logDesc = document.createElement("div");
      logDesc.className = "log-content";
      logDesc.textContent = description;
      logItem.appendChild(logDesc);
    }

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
          if (isRunning) {
            // Mid-run the target tab is load-bearing: never silently
            // retarget to some other tab, stop with a clear message.
            stopAgent(
              "The tab the agent was working on is no longer available. Task stopped.",
              "error",
            );
            return;
          }
          // Reset and re-resolve (idle flows only)
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

  // Inject DOM scanner (agentTools.js first: shared pure helpers for stable
  // ids and outcome deltas used by the content script).
  // Protected browser pages (chrome://, the Web Store, blank tabs) cannot be
  // read or clicked, but they are a perfectly fine STARTING POINT: instead of
  // aborting, hand the model an empty scan that says so, and let it navigate.
  function injectContentScript(tabId, callback) {
    chrome.tabs.get(tabId, (tab) => {
      const tabUrl = tab?.url || "";
      let scannable = false;
      try {
        scannable = ["http:", "https:"].includes(new URL(tabUrl).protocol);
      } catch (_error) {
        scannable = false;
      }
      if (!scannable) {
        callback({
          url: tabUrl,
          title: tab?.title || "Protected browser page",
          elements: [],
          innerText:
            "[This tab is a protected browser page" +
            (tabUrl ? ` (${tabUrl})` : "") +
            ". Extensions cannot read or interact with it. Use the navigate action to go to the website this task needs, or open_tab to start one.]",
          protectedPage: true,
        });
        return;
      }
      injectIntoWebTab(tabId, callback);
    });
  }

  function injectIntoWebTab(tabId, callback) {
    const scanRequest = {
      action: "scan",
      limit: config.agentElementLimit || DEFAULTS.elementLimit,
    };
    chrome.tabs.sendMessage(tabId, scanRequest, (response) => {
      if (chrome.runtime.lastError || !response) {
        chrome.scripting.executeScript(
          {
            target: { tabId: tabId },
            files: ["agentTools.js", "agentContentScript.js"],
          },
          () => {
            if (chrome.runtime.lastError) {
              offerSiteAccess(tabId, () => injectContentScript(tabId, callback));
              return;
            }
            // Event-driven readiness: wait for the DOM (body) via the
            // content script's waitForElement handler instead of a fixed
            // 200ms sleep, then scan.
            chrome.tabs.sendMessage(
              tabId,
              { action: "waitForElement", selector: "body", timeout: 3000 },
              () => {
                void chrome.runtime.lastError;
                chrome.tabs.sendMessage(
                  tabId,
                  scanRequest,
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
              },
            );
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

  // Render / Update checklist UI nodes (the plan panel in the run bubble)
  function updateChecklistUI() {
    if (!activeChecklistItems) return;
    activeChecklistItems.innerHTML = "";
    if (subtasks.length === 0) {
      if (activeChecklistPanel) activeChecklistPanel.style.display = "none";
      return;
    }
    if (activeChecklistPanel) activeChecklistPanel.style.display = "flex";

    subtasks.forEach((task, index) => {
      const taskText =
        typeof task === "string" ? task : task.task || JSON.stringify(task);
      const postcondition =
        typeof task === "object" && task && task.postcondition
          ? task.postcondition
          : "";
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
      if (postcondition) {
        item.title = `Done when: ${postcondition}`;
      }

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
      taskInput.focus();
      taskInput.placeholder = "Type a task or question first…";
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

    // Quick actions bypass the planner loop, but never the risk gate.
    if (isHighRiskAction(action, { elements: [], url: action.url || "" })) {
      requestRiskConfirmation(
        action,
        `Quick browser action: ${action.action}${action.url ? ` → ${action.url}` : ""}`,
        () => executeQuickAction(),
        () =>
          finishBubble("Action cancelled by the safety confirmation prompt."),
      );
      return;
    }

    executeQuickAction();

    function executeQuickAction() {
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
    runId++;
    isRunning = true;
    currentTask = task;
    currentStep = 0;
    currentSubtaskIndex = 0;
    subtasks = [];
    consecutiveFailures = 0;
    parseFailureCount = 0;
    actionHistory = [];
    sessionNotes = [];
    validatorCalls = 0;
    lastValidatorPassed = false;
    totalPromptTokens = 0;
    totalCompletionTokens = 0;
    totalCostUSD = 0.0;
    costIsEstimated = false;
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
                    <div class="logs-title-row">
                        <div class="logs-title">Execution Console</div>
                        <div class="logs-actions">
                            <button type="button" class="export-logs-btn exportMdLogsBtn" title="Download this run's plan and action log as Markdown">Export log (.md)</button>
                            <button type="button" class="export-logs-btn exportJsonSessionBtn" title="Download the full session recording (actions + outcomes) as JSON">Session (.json)</button>
                        </div>
                    </div>
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
    activeChecklistPanel = assistantBubble.querySelector(".checklist-panel");
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

    // Wire the export actions for THIS run's bubble.
    const mdExportBtn = assistantBubble.querySelector(".exportMdLogsBtn");
    if (mdExportBtn) mdExportBtn.addEventListener("click", exportMarkdownLogs);
    const jsonExportBtn = assistantBubble.querySelector(".exportJsonSessionBtn");
    if (jsonExportBtn)
      jsonExportBtn.addEventListener("click", exportSessionRecording);

    // Steer-while-running input becomes available for this run.
    setSteerRowVisible(true);

    // Align page height
    scrollToBottom();

    // Print initial log
    addLogEntry(
      "system",
      "Task Initialized",
      `Starting task: "${currentTask}"`,
    );

    // Plan first (cheap lite-tier call), then start the execution loop.
    generatePlan(() => agentStep());
  }

  // ==========================================
  // PLANNER (lite tier, one call at task start)
  // ==========================================

  function generatePlan(done) {
    const planRunId = runId;
    setStatus("planner", "Planning the task...");
    addLogEntry("planner", "Planning", "Breaking the task into subtasks...");

    chrome.storage.local.get("agentCrossSessionMemory", (res) => {
      if (!isRunning || planRunId !== runId) return;
      const memoryContext = formatMemoryContext(res.agentCrossSessionMemory);

      const planSystemPrompt = `<instructions>
You are the planning module of a browser automation agent. Break the user's task into 2-6 ordered subtasks. Each subtask needs a "postcondition": an observable page condition proving it is done (e.g. "search results for X are visible", "the confirmation message appears").
Rules:
- Keep subtasks concrete and executable with browser actions (navigate, click, type, scroll, read).
- Do not invent requirements the user did not state.
- A simple task may be a single subtask.
Call the submit_plan tool with the subtasks. If tool calling is unavailable, output ONLY a raw JSON object: {"subtasks": [{"task": "...", "postcondition": "..."}]}.
</instructions>`;

      const planUserMessage = `Task: ${currentTask}${memoryContext ? `\n${memoryContext}` : ""}`;

      callLLM(
        planSystemPrompt,
        planUserMessage,
        (planObj) => {
          if (!isRunning || planRunId !== runId) return;
          const parsed = SELECT_TO_AI_TOOLS.parsePlanResponse(planObj);
          subtasks =
            parsed && parsed.length > 0
              ? parsed
              : [
                  {
                    task: currentTask,
                    postcondition: "The user's request is fully satisfied.",
                  },
                ];
          currentSubtaskIndex = 0;
          updateChecklistUI();
          addLogEntry(
            "planner",
            "Plan Created",
            subtasks.map((s, i) => `${i + 1}. ${s.task}`).join("  |  "),
          );
          done();
        },
        null,
        0,
        { tier: "lite", tool: SELECT_TO_AI_TOOLS.TOOL_DEFS.submit_plan },
      );
    });
  }

  /** Advances the checklist to the next subtask (never past the end). */
  function advanceSubtask(reasonNote) {
    if (currentSubtaskIndex < subtasks.length) {
      currentSubtaskIndex++;
      consecutiveFailures = 0;
      updateChecklistUI();
      if (reasonNote) {
        addLogEntry("planner", "Subtask Advanced", reasonNote);
      }
    }
  }

  // ==========================================
  // REFLECT GATE (after repeated failures)
  // ==========================================

  /**
   * Central failure bookkeeping for the executor loop. After 2 consecutive
   * failures a dedicated reflection call replaces blind retry; after the
   * abandon threshold the current subtask is skipped (or the run gives up
   * when it was the last one).
   */
  function registerStepFailure(feedbackMessage, keepScreenshot = false) {
    consecutiveFailures++;
    const abandonAt = Math.max(
      4,
      (config.agentFailureThreshold || DEFAULTS.failureThreshold) + 1,
    );

    if (consecutiveFailures >= abandonAt) {
      if (currentSubtaskIndex < subtasks.length - 1) {
        const abandoned = subtasks[currentSubtaskIndex];
        advanceSubtask(
          `Abandoned subtask "${abandoned ? abandoned.task : ""}" after ${consecutiveFailures} consecutive failures.`,
        );
        scheduleStep(
          800,
          `The previous subtask was abandoned after repeated failures. Move on to the new current subtask. Last problem: ${feedbackMessage}`,
          keepScreenshot,
        );
      } else {
        stopAgent(
          `Giving up after ${consecutiveFailures} consecutive failures. Last problem: ${feedbackMessage}`,
          "error",
        );
      }
      return;
    }

    if (consecutiveFailures === 2) {
      runReflection(feedbackMessage, keepScreenshot);
      return;
    }

    scheduleStep(1200, feedbackMessage, keepScreenshot);
  }

  /**
   * Dedicated reflection call (lite tier): name the wrong assumption and
   * pick a different strategy, then feed that back into the next step.
   */
  function runReflection(feedbackMessage, keepScreenshot = false) {
    const reflectRunId = runId;
    setStatus("planner", "Reflecting on repeated failures...");
    addLogEntry(
      "planner",
      "Reflection",
      "Two consecutive failures; analyzing which assumption was wrong...",
    );

    const historySummary = actionHistory
      .slice(-6)
      .map(
        (h) =>
          `${h.success ? "OK" : "FAIL"} ${JSON.stringify(h.action)} -> ${h.message}`,
      )
      .join("\n");

    const reflectSystemPrompt = `<instructions>
You are the reflection module of a browser agent that has failed the same subtask twice in a row.
Identify the single wrong assumption behind the failures and propose ONE genuinely different strategy (different element, different interaction, scrolling, direct navigation, or ask_user/give_up when appropriate).
Output ONLY a raw JSON object: {"assumption": "the wrong assumption", "strategy": "the new approach to take next"}.
</instructions>`;

    const reflectUserMessage = `Task: ${currentTask}
Current subtask: ${(subtasks[currentSubtaskIndex] && subtasks[currentSubtaskIndex].task) || currentTask}
Recent attempts:
${historySummary || "(none recorded)"}
Latest failure feedback: ${feedbackMessage}`;

    callLLM(
      reflectSystemPrompt,
      reflectUserMessage,
      (obj) => {
        if (!isRunning || reflectRunId !== runId) return;
        const assumption =
          obj && typeof obj.assumption === "string" && obj.assumption.trim()
            ? obj.assumption.trim()
            : "unknown";
        const strategy =
          obj && typeof obj.strategy === "string" && obj.strategy.trim()
            ? obj.strategy.trim()
            : "try a different element or interaction";
        addLogEntry(
          "planner",
          "Reflection Result",
          `Wrong assumption: ${assumption}. New strategy: ${strategy}`,
        );
        scheduleStep(
          400,
          `Reflection after repeated failures: the assumption "${assumption}" was wrong. Follow this new strategy now: ${strategy}. Do NOT repeat the failed action. (Original failure: ${feedbackMessage})`,
          keepScreenshot,
        );
      },
      null,
      0,
      { tier: "lite" },
    );
  }

  // ==========================================
  // VALIDATOR (lite tier, on finish)
  // ==========================================

  /**
   * Verification-before-finish: a cheap validator call receives the final
   * page scan and the claimed answer, and must confirm the answer is
   * supported by on-page evidence. Reject -> feed back -> continue (bounded
   * by remaining steps and a per-run validator budget). Only validator-passed
   * runs are saved to cross-session memory.
   */
  function runValidatorOnFinish(finishAction, scanResult) {
    const validateRunId = runId;
    const answer = String(finishAction.answer || "").trim();

    if (validatorCalls >= 3) {
      addLogEntry(
        "validator",
        "Validation Budget Exhausted",
        "Accepting the answer without confirmation (this run will not be saved to memory).",
      );
      lastValidatorPassed = false;
      stopAgent(answer, "success");
      return;
    }
    validatorCalls++;

    setStatus("validator", "Validating the answer against the page...");
    addLogEntry(
      "validator",
      "Validating Answer",
      "Checking the claimed answer against the final page state...",
    );

    const validatorSystemPrompt = `<instructions>
You are the validator module of a browser agent. The agent claims it completed the user's task. Decide whether the claimed answer is actually supported by the final page state provided (URL, title, page text).
- pass: the page evidence supports the answer (the answer may paraphrase, but the facts must appear in or clearly follow from the page content or the URL/title).
- fail: the answer is unsupported, contradicted, fabricated, or the task is visibly incomplete.
Call the submit_validation tool with your verdict. If tool calling is unavailable, output ONLY a raw JSON object: {"verdict": "pass" | "fail", "reason": "..."}.
</instructions>`;

    const pageText = (() => {
      const text = scanResult.innerText || "";
      return text.length > 2500 ? `${text.substring(0, 2500)}...` : text;
    })();

    const validatorUserMessage = `User task: ${currentTask}
Plan: ${subtasks.map((s) => (typeof s === "string" ? s : s.task)).join("; ") || "(none)"}
Claimed answer: ${answer}
Claimed evidence: ${finishAction.evidence || "(none provided)"}

Final page URL: ${scanResult.url}
Final page title: ${scanResult.title}
Final page text (truncated):
${pageText || "[No page text available]"}`;

    callLLM(
      validatorSystemPrompt,
      validatorUserMessage,
      (obj) => {
        if (!isRunning || validateRunId !== runId) return;
        const verdict = SELECT_TO_AI_TOOLS.parseValidatorResponse(obj);

        if (!verdict) {
          addLogEntry(
            "validator",
            "Validation Inconclusive",
            "The validator response was unparseable; accepting the answer (not saved to memory).",
          );
          lastValidatorPassed = false;
          stopAgent(answer, "success");
          return;
        }

        if (verdict.pass) {
          lastValidatorPassed = true;
          addLogEntry(
            "validator",
            "Validation Passed",
            verdict.reason || "The answer is supported by the page evidence.",
          );
          stopAgent(answer, "success");
          return;
        }

        addLogEntry(
          "validator",
          "Validation Failed",
          verdict.reason || "The answer is not supported by the page.",
        );
        consecutiveFailures = 0;
        scheduleStep(
          600,
          `Validator rejected your answer: ${verdict.reason || "it is not supported by the page evidence"}. Gather the missing evidence on the page (navigate/read further) before finishing again.`,
        );
      },
      null,
      0,
      { tier: "lite", tool: SELECT_TO_AI_TOOLS.TOOL_DEFS.submit_validation },
    );
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

    // Pressing Enter can submit a form, apply the same gates as a click on
    // the target element, plus a page-context check.
    if (actionType === "keypress") {
      const key = String(actionObj.text || actionObj.key || "").toLowerCase();
      if (key === "enter") {
        if (el) {
          const textLower = (el.text || "").toLowerCase();
          const labelLower = (el.label || "").toLowerCase();
          const nameLower = (el.name || "").toLowerCase();
          const typeLower = (el.type || "").toLowerCase();
          const hasKeyword = riskKeywords.some(
            (kw) =>
              textLower.includes(kw) ||
              labelLower.includes(kw) ||
              nameLower.includes(kw),
          );
          if (hasKeyword) return true;
          if (
            typeLower.includes("password") ||
            nameLower.includes("card") ||
            nameLower.includes("cvv") ||
            labelLower.includes("card") ||
            labelLower.includes("cvv")
          ) {
            return true;
          }
        }
        const pageUrlLower = (scanResult.url || "").toLowerCase();
        if (
          pageUrlLower.includes("checkout") ||
          pageUrlLower.includes("payment")
        ) {
          return true;
        }
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

    const confirmationRunId = runId;
    const bubble = document.createElement("div");
    bubble.className = "message-bubble assistant confirmation-bubble";
    bubble.style.border = "1px solid var(--danger)";
    bubble.style.background = "rgba(239, 68, 68, 0.05)";
    // Action and explanation include LLM-generated text, always escape it.
    bubble.innerHTML = `
            <div class="bubble-avatar" style="background: var(--danger); color: white;">⚠</div>
            <div class="bubble-content">
                <p style="font-weight: 600; color: var(--danger); margin-bottom: 8px;">Security Confirmation Required</p>
                <p>The agent is requesting to perform a potentially high-risk action:</p>
                <blockquote style="background: rgba(255,255,255,0.05); border-left: 3px solid var(--danger); padding: 8px; margin: 8px 0; border-radius: 4px; font-family: monospace; font-size: 12px;">
                    <strong>Action:</strong> ${escapeHtml(String(actionObj.action || "").toUpperCase())}<br/>
                    <strong>Details:</strong> ${escapeHtml(explanation)}
                </blockquote>
                <p>Do you authorize this action?</p>
                <div style="display: flex; gap: 10px; margin-top: 12px;">
                    <button class="confirm-risk-btn primary-btn" style="background: var(--danger); border-color: var(--danger); color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer;">Authorize Action</button>
                    <button class="abort-risk-btn secondary-btn" style="padding: 6px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border-card); background: transparent; color: var(--text-main);">Abort Task</button>
                </div>
            </div>
        `;
    chatContainer.appendChild(bubble);
    scrollToBottom();

    const confirmBtn = bubble.querySelector(".confirm-risk-btn");
    const abortBtn = bubble.querySelector(".abort-risk-btn");

    confirmBtn.addEventListener("click", () => {
      bubble.remove();
      // A stale Authorize (run stopped or a new run started) must never
      // execute the deferred action.
      if (confirmationRunId !== runId) {
        addLogEntry(
          "system",
          "Stale Confirmation Ignored",
          "The task this confirmation belonged to is no longer active.",
        );
        return;
      }
      onConfirm();
    });

    abortBtn.addEventListener("click", () => {
      bubble.remove();
      if (confirmationRunId !== runId) return;
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
    // Never re-enter: a stop in progress must not trigger another stop
    // (e.g. via a callback that notices the run ended).
    if (isStopping) return;
    isStopping = true;

    // Remember which tabs may carry overlays before clearing targeting state.
    const cleanupTabIds = new Set();
    if (targetTabId !== null) cleanupTabIds.add(targetTabId);
    if (currentAgentTabId !== null) cleanupTabIds.add(currentAgentTabId);

    // Invalidate every pending continuation of this run.
    runId++;
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

    // The steer input only exists while a run is active.
    setSteerRowVisible(false);

    // Cross-session memory save (F13): only validator-confirmed successes
    // are written, unvalidated finishes never seed future plans.
    if (statusState === "success" && lastValidatorPassed) {
      const memoryItem = {
        task: currentTask,
        subtasks: subtasks.map((s) => (typeof s === "string" ? s : s.task)),
        timestamp: Date.now(),
      };
      chrome.storage.local.get("agentCrossSessionMemory", (res) => {
        let memory = res.agentCrossSessionMemory || [];
        memory.unshift(memoryItem);
        if (memory.length > 20) {
          memory = memory.slice(0, 20);
        }
        chrome.storage.local.set({ agentCrossSessionMemory: memory }, () => {
          renderRecentSessions();
        });
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
        // Final answers render the minimal safe markdown subset instead of
        // raw asterisks (renderAnswerHtml escapes everything first).
        activeBubbleAnswer.innerHTML = renderAnswerHtml(reason);
        if (activeThoughtStatus) activeThoughtStatus.textContent = "completed";
        // Mark the whole plan complete in the checklist panel.
        if (subtasks.length > 0) {
          currentSubtaskIndex = subtasks.length;
          updateChecklistUI();
        }
        setStatus("validator", "Task Completed");
        if (activeRadar) activeRadar.className = "radar success";
      } else if (statusState === "error") {
        activeBubbleAnswer.innerHTML = `<span style="color: var(--danger);">${escapeHtml(reason)}</span>`;
        if (activeThoughtStatus) activeThoughtStatus.textContent = "failed";
        setStatus("error", "Task Aborted");
        if (activeRadar) activeRadar.className = "radar error";
      } else {
        activeBubbleAnswer.innerHTML = renderAnswerHtml(reason);
        if (activeThoughtStatus) activeThoughtStatus.textContent = "stopped";
        setStatus("idle", "Stopped");
        if (activeRadar) activeRadar.className = "radar idle";
      }
    }

    scrollToBottom();

    // Best-effort overlay cleanup on the tabs this run touched. Never
    // re-resolve tabs here (getActiveTab could recurse back into stopAgent
    // when no webpage tab exists), just try the known ids and ignore errors.
    cleanupTabIds.forEach((tabId) => {
      chrome.tabs.sendMessage(tabId, { action: "clear" }, () => {
        void chrome.runtime.lastError;
      });
    });

    isStopping = false;
  }

  // ==========================================
  // MULTI-AGENT PIPELINE
  // ==========================================

  // Formats validator-confirmed past runs for the planner prompt.
  function formatMemoryContext(memory) {
    if (!memory || memory.length === 0) return "";
    let context =
      "\n### Cross-session memory (plans that previously completed similar tasks):\n";
    memory.slice(0, 5).forEach((item) => {
      const plan = (item.subtasks || [])
        .map((s) => (typeof s === "string" ? s : s && s.task))
        .filter(Boolean)
        .join("; ");
      context += `- Goal: "${item.task}"${plan ? ` -> Plan: ${plan}` : ""}\n`;
    });
    return context;
  }

  // ==========================================
  // UNIFIED BROWSER AGENT EXECUTION LOOP
  // ==========================================

  // Schedules the next agent step, bound to the current run generation.
  // If the run is stopped (or a new run starts) before the timer fires,
  // the continuation is dropped instead of resuming inside the wrong run.
  function scheduleStep(delayMs, feedback = "", needsScreenshot = false) {
    const stepRunId = runId;
    setTimeout(() => {
      if (!isRunning || stepRunId !== runId) return;
      agentStep(feedback, needsScreenshot);
    }, delayMs);
  }

  function agentStep(feedback = "", needsScreenshot = false) {
    if (!isRunning) return;
    const stepRunId = runId;
    const isCurrentRun = () => isRunning && stepRunId === runId;

    // Deliver a queued steer message as feedback for THIS step, then clear
    // it (one message, delivered once).
    if (pendingSteerMessage) {
      const guidance = `User guidance received mid-run (follow it): ${pendingSteerMessage}`;
      feedback = feedback ? `${feedback}\n${guidance}` : guidance;
      addLogEntry(
        "system",
        "User Guidance Delivered",
        pendingSteerMessage,
      );
      pendingSteerMessage = "";
      if (steerPending) steerPending.textContent = "";
    }

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
      if (!isCurrentRun()) return;
      if (!isUrlAllowed(tab.url)) {
        stopAgent(`URL blocked by allowlist: ${tab.url}`, "error");
        return;
      }

      injectContentScript(tabId, (scanResult) => {
        if (!isCurrentRun()) return;
        getTabsContext((browserTabs) => {
          if (!isCurrentRun()) return;

          const elementLimit = config.agentElementLimit || 60;
          const visibleElements = (scanResult.elements || []).slice(
            0,
            Math.max(elementLimit, 10),
          );
          const validElementIds = new Set(visibleElements.map((el) => el.id));
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
              if (el.rect)
                attrs += ` at="(${el.rect.x},${el.rect.y}) ${el.rect.w}x${el.rect.h}"`;
              if (el.position) attrs += ` position="${el.position}"`;

              const tag = el.tagName ? el.tagName.toLowerCase() : "element";
              return `<${tag} ${attrs}>${el.text || ""}</${tag}>`;
            })
            .join("\n");

          // Scroll / viewport signal so the model knows whether to scroll.
          let scrollLine = "";
          if (typeof scanResult.pageHeight === "number" && scanResult.pageHeight > 0) {
            const viewportH = scanResult.viewportHeight || 0;
            const scrollY = scanResult.scrollY || 0;
            const belowFold = scanResult.pageHeight - (scrollY + viewportH);
            const hints = [];
            if (scrollY > 4) hints.push("content above the fold (scroll up to see it)");
            if (belowFold > 4) hints.push("content below the fold (scroll down to see it)");
            scrollLine = `Scroll position: ${scrollY}px of ${scanResult.pageHeight}px total page height (viewport ${viewportH}px). ${
              hints.length > 0 ? `There is ${hints.join(" and ")}.` : "The full page fits in the viewport."
            }`;
          }

          // Action history (messages already carry measured outcome deltas)
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

          // Plan block: the checklist with the current subtask highlighted.
          let planBlock = "";
          if (subtasks.length > 0) {
            const planLines = subtasks
              .map((s, i) => {
                const marker =
                  i < currentSubtaskIndex
                    ? "[done]"
                    : i === currentSubtaskIndex
                      ? "[current]"
                      : "[pending]";
                const post = s.postcondition
                  ? ` (done when: ${s.postcondition})`
                  : "";
                return `${marker} ${i + 1}. ${s.task}${post}`;
              })
              .join("\n");
            planBlock = `Plan:\n${planLines}\nSet "completedSubtask": true on the action that fulfills the current subtask's postcondition. Use "revise_plan" if the plan no longer fits what you see.`;
          }

          // Scratchpad notes saved via the `remember` action.
          const notesBlock =
            sessionNotes.length > 0
              ? `Your scratchpad notes (persist across pages):\n${sessionNotes
                  .map((n, i) => `${i + 1}. ${n}`)
                  .join("\n")}`
              : "";

          // ONE prompt: the static instructions (config.agentSystemPrompt,
          // defaulting to CONFIG.DEFAULT_SYSTEM_PROMPT) are the cacheable
          // half; the per-step context below is the dynamic half.
          const staticPrompt =
            config.agentSystemPrompt || DEFAULT_SYSTEM_PROMPT;

          const dynamicContext = `<current_context>
High-level Goal: "${currentTask}"
Current Tab URL: ${scanResult.url}
Current Tab Page Title: ${scanResult.title}

${planBlock ? `${planBlock}\n` : ""}${notesBlock ? `${notesBlock}\n` : ""}
Available Browser Tabs:
${formatTabsContext(browserTabs)}

Action History:
${historyStr}

${feedback ? `Feedback from last attempt (IMPORTANT): "${feedback}"\n` : ""}

Interactive Elements (DOM/reading order; ids are stable on this page):
${elementsDescription || "[No interactive elements found on this section]"}
${scrollLine ? `\n${scrollLine}\n` : ""}
Page Text content (truncated):
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

          const systemPrompt = [
            { text: staticPrompt, cacheable: true },
            { text: `\n\n${dynamicContext}`, cacheable: false },
          ];

          const activeSubtaskLabel = () =>
            (subtasks[currentSubtaskIndex] && subtasks[currentSubtaskIndex].task) ||
            "Complete task";

          const executeLLM = (screenshotDataUrl) => {
            callLLM(
              systemPrompt,
              `Goal: "${currentTask}". Call the browser_action tool with your next action.`,
              (rawActionObj) => {
                if (!isCurrentRun()) return;

                // Validate the tool call against the schema BEFORE dispatch.
                // Unknown actions, missing params, and out-of-range ids feed
                // a structured correction back instead of executing garbage.
                const validation = SELECT_TO_AI_TOOLS.validateToolCall(
                  rawActionObj,
                  { validIds: validElementIds },
                );
                if (!validation.ok) {
                  addLogEntry("error", "Invalid Tool Call", validation.error);
                  registerStepFailure(
                    `Invalid tool call: ${validation.error}`,
                    needsScreenshot,
                  );
                  return;
                }
                const actionObj = validation.action;

                // Stream the model's thought into the status line.
                if (actionObj.thought) {
                  const thought = String(actionObj.thought);
                  setStatus(
                    "executor",
                    thought.length > 140 ? `${thought.slice(0, 137)}...` : thought,
                  );
                  // Collapsed-by-default expander keeps the console scannable.
                  addLogEntry("executor", "Thought", thought, {
                    collapsible: true,
                  });
                }

                // The model asserts the current subtask's postcondition was
                // just met, advance the plan when the action succeeds.
                const shouldAdvanceSubtask = actionObj.completedSubtask === true;

                // ---- Agent-level verbs (no page dispatch) ----

                if (actionObj.action === "remember") {
                  sessionNotes.push(String(actionObj.note).slice(0, 500));
                  if (sessionNotes.length > 20)
                    sessionNotes = sessionNotes.slice(-20);
                  addLogEntry("executor", "Note Saved", actionObj.note);
                  if (scratchpadPanel && scratchpadPanel.classList.contains("open"))
                    renderScratchpadPanel();
                  actionHistory.push({
                    step: currentStep,
                    subtask: activeSubtaskLabel(),
                    action: actionObj,
                    success: true,
                    message: `Saved note to scratchpad.`,
                  });
                  if (shouldAdvanceSubtask)
                    advanceSubtask("Subtask postcondition reported met.");
                  scheduleStep(
                    200,
                    "Note saved to your scratchpad. Continue with the task.",
                  );
                  return;
                }

                if (actionObj.action === "ask_user") {
                  addLogEntry("executor", "User Input Needed", actionObj.question);
                  actionHistory.push({
                    step: currentStep,
                    subtask: activeSubtaskLabel(),
                    action: actionObj,
                    success: true,
                    message: "Paused to ask the user for input.",
                  });
                  conversationHistory.push({
                    role: "assistant",
                    text: actionObj.question,
                  });
                  if (conversationHistory.length > 12)
                    conversationHistory = conversationHistory.slice(-12);
                  stopAgent(
                    `I need your input to continue: ${actionObj.question}`,
                    "idle",
                  );
                  return;
                }

                if (actionObj.action === "give_up") {
                  actionHistory.push({
                    step: currentStep,
                    subtask: activeSubtaskLabel(),
                    action: actionObj,
                    success: true,
                    message: "Agent gave up on the task.",
                  });
                  stopAgent(`Task abandoned: ${actionObj.reason}`, "error");
                  return;
                }

                if (actionObj.action === "revise_plan") {
                  subtasks = actionObj.subtasks;
                  currentSubtaskIndex = 0;
                  consecutiveFailures = 0;
                  updateChecklistUI();
                  addLogEntry(
                    "planner",
                    "Plan Revised",
                    subtasks.map((s, i) => `${i + 1}. ${s.task}`).join("  |  "),
                  );
                  actionHistory.push({
                    step: currentStep,
                    subtask: activeSubtaskLabel(),
                    action: actionObj,
                    success: true,
                    message: "Plan revised mid-run.",
                  });
                  scheduleStep(
                    200,
                    "Plan revised. Continue with the first remaining subtask.",
                  );
                  return;
                }

                // Duplicate action detection (stable ids make this reliable)
                if (isDuplicateFailedAction(actionObj)) {
                  addLogEntry(
                    "system",
                    "Duplicate Loop Detected",
                    `Action ${actionObj.action} on ID ${actionObj.id} already failed. Retrying with feedback...`,
                  );
                  registerStepFailure(
                    `Your action choice (${actionObj.action} on element [${actionObj.id}]) was identified as a duplicate of a previously failed action. Please select a different element or action.`,
                    needsScreenshot,
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
                    subtask: activeSubtaskLabel(),
                    action: actionObj,
                    success: true,
                    message: "Screenshot requested successfully.",
                  });
                  scheduleStep(
                    500,
                    "Here is the requested screenshot of the current viewport. Analyze it to find your target.",
                    true,
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
                  // Verification-before-finish: the schema validator already
                  // rejected empty answers; now a cheap validator call checks
                  // the claim against the final page state.
                  addLogEntry(
                    "executor",
                    "Finish Requested",
                    "Answer submitted; validating against the page...",
                  );
                  actionHistory.push({
                    step: currentStep,
                    subtask: activeSubtaskLabel(),
                    action: actionObj,
                    success: true,
                    message: "Finish requested; answer sent to the validator.",
                  });
                  if (shouldAdvanceSubtask)
                    advanceSubtask("Final subtask reported complete.");
                  runValidatorOnFinish(actionObj, scanResult);
                  return;
                }

                if (isBrowserAction(actionObj)) {
                  const runBrowserAction = () => {
                    // Guard the deferred entry point: Stop (or a new run)
                    // between decision and execution must cancel this.
                    if (!isCurrentRun()) return;
                    addLogEntry(
                      "executor",
                      "Browser Action Decided",
                      `${actionObj.reason || actionObj.action}`,
                    );
                    executeBrowserAction(
                      actionObj,
                      activeSubtaskLabel(),
                      screenshotDataUrl,
                      (success, message) => {
                        if (!isCurrentRun()) return;
                        if (!success) {
                          addLogEntry(
                            "error",
                            "Browser Action Failed",
                            message,
                          );
                          registerStepFailure(
                            "Your last browser action failed: " + message,
                          );
                          return;
                        }
                        addLogEntry(
                          "executor",
                          "Browser Action Executed",
                          message,
                        );
                        consecutiveFailures = 0;
                        if (shouldAdvanceSubtask)
                          advanceSubtask("Subtask postcondition reported met.");
                        if (actionObj.action === "list_tabs") {
                          scheduleStep(500, message);
                        } else {
                          scheduleStep(300);
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
                  // Guard the deferred entry point (risk confirmation may
                  // resolve long after Stop) before sending the interact
                  // message to the page.
                  if (!isCurrentRun()) return;
                  const recordEntry = {
                    timestamp: Date.now(),
                    step: currentStep,
                    subtask: activeSubtaskLabel(),
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
                      if (!isCurrentRun()) {
                        void chrome.runtime.lastError;
                        return;
                      }
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

                        // A click/keypress that unloads the page closes the
                        // message channel before the content script can
                        // respond. That is a SUCCESS (navigation), not a
                        // failure, verify by watching the tab's URL.
                        const channelLost =
                          !response &&
                          /message|port|channel|receiving end|context invalidated/i.test(
                            err || "",
                          );
                        const navCapable = ["click", "keypress", "double_click"].includes(
                          actionObj.action,
                        );
                        if (channelLost && navCapable) {
                          waitForTabNavigation(tabId, 400, 8000, () => {
                            if (!isCurrentRun()) return;
                            chrome.tabs.get(tabId, (updatedTab) => {
                              if (!isCurrentRun()) return;
                              if (
                                !chrome.runtime.lastError &&
                                updatedTab &&
                                updatedTab.url &&
                                updatedTab.url !== scanResult.url
                              ) {
                                const navMessage = `${actionObj.action} on [${actionObj.id ?? "page"}] caused a navigation to ${updatedTab.url}. Outcome: URL changed.`;
                                addLogEntry(
                                  "executor",
                                  "DOM Action Caused Navigation",
                                  navMessage,
                                );
                                recordEntry.success = true;
                                recordEntry.outcome = navMessage;
                                actionHistory.push({
                                  step: currentStep,
                                  subtask: activeSubtaskLabel(),
                                  action: actionObj,
                                  success: true,
                                  message: navMessage,
                                });
                                consecutiveFailures = 0;
                                if (shouldAdvanceSubtask)
                                  advanceSubtask(
                                    "Subtask postcondition reported met.",
                                  );
                                scheduleStep(200);
                                return;
                              }
                              recordEntry.success = false;
                              recordEntry.outcome = err;
                              actionHistory.push({
                                step: currentStep,
                                subtask: activeSubtaskLabel(),
                                action: actionObj,
                                success: false,
                                message: err,
                              });
                              addLogEntry("error", "DOM Action Failed", err);
                              registerStepFailure(
                                "Your last action failed: " + err,
                              );
                            });
                          });
                          return;
                        }

                        addLogEntry("error", "DOM Action Failed", err);

                        recordEntry.success = false;
                        recordEntry.outcome = err;

                        actionHistory.push({
                          step: currentStep,
                          subtask: activeSubtaskLabel(),
                          action: actionObj,
                          success: false,
                          message: err,
                        });
                        registerStepFailure("Your last action failed: " + err);
                      } else {
                        // Outcome verification: replace the optimistic
                        // "clicked successfully" with what actually changed.
                        const outcomeText = response.outcome
                          ? SELECT_TO_AI_TOOLS.formatOutcomeDelta(
                              response.outcome,
                            )
                          : "";
                        const fullMessage = outcomeText
                          ? `${response.message} ${outcomeText}`
                          : response.message;

                        addLogEntry(
                          "executor",
                          "DOM Action Executed",
                          fullMessage,
                        );

                        recordEntry.success = true;
                        recordEntry.outcome = fullMessage;

                        actionHistory.push({
                          step: currentStep,
                          subtask: activeSubtaskLabel(),
                          action: actionObj,
                          success: true,
                          message: fullMessage,
                        });

                        // Silent no-ops count toward the reflection gate;
                        // effective actions reset it.
                        if (response.outcome && response.outcome.noEffect) {
                          consecutiveFailures++;
                        } else {
                          consecutiveFailures = 0;
                        }
                        if (shouldAdvanceSubtask)
                          advanceSubtask("Subtask postcondition reported met.");

                        // The content script already waited for the DOM to
                        // settle (event-driven); only cover a possible full
                        // navigation before the next scan.
                        waitForTabNavigation(tabId, 250, 8000, () => {
                          scheduleStep(150);
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
              0,
              // Strong ("pro") tier drives the executor with the native
              // browser_action tool; text-JSON fallback engages automatically
              // if the provider rejects tools.
              { tier: "pro", tool: SELECT_TO_AI_TOOLS.TOOL_DEFS.browser_action },
            );
          };

          // Vision-capable executors get the marked screenshot every step
          // (badges are already drawn); others stay text-only unless the
          // model explicitly asked via request_screenshot.
          const wantScreenshot = needsScreenshot || executorVisionEnabled();
          if (wantScreenshot) {
            chrome.runtime.sendMessage(
              { action: "captureScreenshot", tabId },
              (screenshotRes) => {
                if (!isCurrentRun()) return;
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
    return SELECT_TO_AI_PROVIDER_PAYLOAD.parseDataUrl(dataUrl);
  }

  function supportsExplicitPromptCaching(provider, model) {
    return SELECT_TO_AI_PROVIDER_PAYLOAD.supportsExplicitPromptCaching(
      provider,
      model,
      config.agentPromptCaching,
    );
  }

  /** Joins a string-or-parts system prompt into one plain string. */
  function systemPromptToText(systemPrompt) {
    return SELECT_TO_AI_PROVIDER_PAYLOAD.systemPromptToText(systemPrompt);
  }

  /**
   * Splits a system prompt into [static | dynamic] parts for caching.
   * Callers that already know the split (the executor: static instructions
   * first, per-step context second) pass an array of {text, cacheable}
   * parts directly, that IS the real static block, so it is used verbatim.
   * String prompts fall back to marking the embedded browser-capability
   * block (the only stable region of the legacy prompts) as cacheable.
   */
  function splitSystemPromptForCaching(systemPrompt) {
    return SELECT_TO_AI_PROVIDER_PAYLOAD.splitSystemPromptForCaching(
      systemPrompt,
      formatBrowserCapabilityPrompt(),
    );
  }

  function buildAnthropicSystemContent(systemPrompt, provider, model) {
    return SELECT_TO_AI_PROVIDER_PAYLOAD.buildAnthropicSystemContent(
      systemPrompt,
      provider,
      model,
      config.agentPromptCaching,
      formatBrowserCapabilityPrompt(),
    );
  }

  function buildOpenAICompatibleSystemMessage(systemPrompt, provider, model) {
    return SELECT_TO_AI_PROVIDER_PAYLOAD.buildOpenAICompatibleSystemMessage(
      systemPrompt,
      provider,
      model,
      config.agentPromptCaching,
      formatBrowserCapabilityPrompt(),
    );
  }

  function applyPromptCachingOptions(body, headers, provider, model) {
    if (config.agentPromptCaching === false) return;

    if (provider === "openrouter") {
      body.session_id = promptCacheSessionId;
      headers["x-session-id"] = promptCacheSessionId;
    }
  }

  // Clean up API error messages (handling raw JSON objects/arrays or long stacks)
  function cleanErrorMessage(rawErrorText, status) {
    return SELECT_TO_AI_PROVIDER_PAYLOAD.cleanErrorMessage(rawErrorText, status);
  }

  /**
   * @param {string|Array<{text: string, cacheable: boolean}>} systemPrompt -
   *   Plain prompt, or [static | dynamic] parts for prompt caching.
   * @param {Object} [options]
   * @param {"lite"|"pro"} [options.tier] - Model tier ("pro" = configured
   *   executor model, "lite" = the provider's cheap catalog model).
   * @param {{name, description, parameters}} [options.tool] - Native tool to
   *   force-call (OpenAI `tools`/`tool_choice` or Anthropic `tools`/`tool_use`).
   *   Falls back to the text-JSON protocol when the provider rejects tools.
   */
  function callLLM(
    systemPrompt,
    userMessage,
    callback,
    screenshotDataUrl = null,
    attempt = 0,
    options = {},
  ) {
    // Bind this call (and any retry it schedules) to the current run
    // generation so retries never resume after Stop / into a new run.
    const callRunId = runId;
    const provider = config.agentActiveProvider;
    const { apiKey, baseUrl } = getProviderDetails(provider);

    if (provider !== "custom" && !apiKey) {
      const message = getMissingCredentialsMessage(provider);
      addLogEntry("error", `LLM Missing Credentials`, message);
      stopAgent(message, "error");
      return;
    }

    const tier = options.tier === "pro" ? "pro" : "lite";
    // Per-session guard: once a provider rejects tools, every later call
    // uses the text-JSON fallback protocol instead.
    const activeTool = options.tool && !toolsUnsupported ? options.tool : null;
    const model = resolveTierModel(provider, tier);
    const systemPromptText = systemPromptToText(systemPrompt);

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
      if (activeTool) {
        // Anthropic shape: tools + forced tool_choice; the reply arrives as
        // a tool_use content block streamed via input_json_delta events.
        body.tools = [
          SELECT_TO_AI_TOOLS.buildAnthropicTool(
            activeTool.name,
            activeTool.description,
            activeTool.parameters,
          ),
        ];
        body.tool_choice = { type: "tool", name: activeTool.name };
      }
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
        stream: true,
      };
      if (activeTool) {
        // OpenAI-compatible shape (OpenRouter, OpenAI, DeepSeek, Groq,
        // Together, Mistral, xAI, custom gateways): tools + forced
        // tool_choice; the reply streams as delta.tool_calls fragments.
        body.tools = [
          SELECT_TO_AI_TOOLS.buildOpenAITool(
            activeTool.name,
            activeTool.description,
            activeTool.parameters,
          ),
        ];
        body.tool_choice = {
          type: "function",
          function: { name: activeTool.name },
        };
      }
      if (!compatParamsUnsupported) {
        // response_format and tools are mutually exclusive here: some
        // gateways reject json_object mode when tools are attached, and the
        // tool schema already constrains the output.
        if (!activeTool) {
          body.response_format = { type: "json_object" };
        }
        // Ask OpenAI-compatible providers to attach real token usage to the
        // final stream chunk instead of forcing a character-count estimate.
        body.stream_options = { include_usage: true };
      }
      applyPromptCachingOptions(body, headers, provider, model);
    }

    if (activeAbortController && attempt === 0) {
      try {
        activeAbortController.abort();
      } catch (e) {}
    }

    const port = chrome.runtime.connect({ name: "streamFetch" });

    const timeoutId = setTimeout(() => {
      // Route the timeout through the real error path so the run actually
      // ends or retries (handleError disconnects the port, which aborts the
      // background fetch) and the panel sees the timeout error.
      handleError(
        new Error(
          `Model request timed out after ${(config.agentTimeout || DEFAULTS.timeoutMs) / 1000} seconds.`,
        ),
        408,
      );
    }, config.agentTimeout || DEFAULTS.timeoutMs);

    activeAbortController = {
      abort: () => {
        clearTimeout(timeoutId);
        try {
          // The background worker aborts the in-flight fetch onDisconnect.
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
    let finished = false;
    // Accumulates native tool-call fragments from either provider shape.
    const toolState = SELECT_TO_AI_TOOLS.createToolCallAccumulator();
    let toolArgsStreamed = "";

    function handleError(err, status = 0, respHeaders = {}) {
      // Idempotent: the timeout and a late port event must not both settle
      // this call.
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      try {
        port.disconnect();
      } catch (e) {}

      if (activeStreamPanel) {
        activeStreamPanel.style.display = "none";
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
          // Remember for the rest of the session so auto-screenshots stop.
          visionUnsupported = true;
          addLogEntry(
            "system",
            "Vision Unavailable",
            "The selected model does not support vision capabilities. Re-routing pure text payload...",
          );
          const fallbackMessage = `${userMessage}\n\n[SYSTEM WARNING: You previously requested a screenshot, but your current model does not support Computer Vision. The screenshot payload was rejected by the provider. Please proceed using purely the text-based DOM context. Do NOT use the "request_screenshot" action again.]`;
          setTimeout(() => {
            if (callRunId !== runId) return;
            callLLM(systemPrompt, fallbackMessage, callback, null, 0, options);
          }, 500);
          return;
        }
      }

      // Some models/gateways reject native tools or tool_choice with a 400.
      // Flip to the text-JSON protocol for the rest of the session and retry
      // once, so nothing regresses versus the pre-tool-calling behavior.
      if (
        status === 400 &&
        activeTool &&
        !toolsUnsupported &&
        /tool|function/i.test(err.message || "")
      ) {
        toolsUnsupported = true;
        addLogEntry(
          "system",
          "Tool Calling Unsupported",
          "Provider rejected native tools. Falling back to the text-JSON protocol for this session.",
        );
        setTimeout(() => {
          if (callRunId !== runId) return;
          callLLM(
            systemPrompt,
            userMessage,
            callback,
            screenshotDataUrl,
            attempt,
            options,
          );
        }, 250);
        return;
      }

      // Some OpenAI-compatible providers reject response_format /
      // stream_options with a 400. Drop the extras once and retry.
      if (
        status === 400 &&
        provider !== "anthropic" &&
        !compatParamsUnsupported &&
        /response_format|json_object|json_mode|stream_options|unsupported|unrecognized|unknown (?:field|parameter|argument)/i.test(
          err.message || "",
        )
      ) {
        compatParamsUnsupported = true;
        addLogEntry(
          "system",
          "Compatibility Retry",
          "Provider rejected response_format/stream_options. Retrying once without them.",
        );
        setTimeout(() => {
          if (callRunId !== runId) return;
          callLLM(
            systemPrompt,
            userMessage,
            callback,
            screenshotDataUrl,
            attempt,
            options,
          );
        }, 250);
        return;
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
          // A retry scheduled before Stop (or before a new run started)
          // must never fire into the wrong run.
          if (callRunId !== runId) return;
          callLLM(
            systemPrompt,
            userMessage,
            callback,
            screenshotDataUrl,
            attempt + 1,
            options,
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

              // Native tool-call fragments, OpenAI-compatible shape:
              // choices[0].delta.tool_calls[{index, function:{name, arguments}}]
              const deltaToolCalls = parsed.choices?.[0]?.delta?.tool_calls;
              if (deltaToolCalls) {
                SELECT_TO_AI_TOOLS.accumulateOpenAIToolCallDelta(
                  toolState,
                  deltaToolCalls,
                );
                for (const fragment of deltaToolCalls) {
                  if (fragment?.function?.arguments) {
                    toolArgsStreamed += fragment.function.arguments;
                  }
                }
              }
              // Native tool-use events, Anthropic shape:
              // content_block_start (tool_use) + input_json_delta chunks.
              SELECT_TO_AI_TOOLS.accumulateAnthropicEvent(toolState, parsed);
              if (
                parsed.type === "content_block_delta" &&
                parsed.delta?.type === "input_json_delta" &&
                parsed.delta.partial_json
              ) {
                toolArgsStreamed += parsed.delta.partial_json;
              }

              const combinedToken = reasoningToken + contentToken;

              if (combinedToken) {
                replyText += combinedToken;
              }
              if ((combinedToken || toolArgsStreamed) && activeStreamText) {
                activeStreamText.textContent = replyText + toolArgsStreamed;
                activeStreamText.scrollTop = activeStreamText.scrollHeight;
              }

              // OpenAI-compatible: usage on the final chunk (needs
              // stream_options.include_usage). Anthropic: input tokens on
              // message_start (nested under message), output tokens on
              // message_delta (top-level usage).
              const usagePayload =
                parsed.usage || (parsed.message && parsed.message.usage);
              if (usagePayload) {
                usageProvided = true;
                accumulateUsage(usagePayload, model);
              }
            } catch (e) {
              // Substring mismatch/partial chunk JSON
            }
          }
        }
      } else if (msg.type === "done") {
        if (finished) return;
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
            (systemPromptText.length + userMessage.length) / 4,
          );
          const completionTokensEst = Math.ceil(
            (replyText.length + toolArgsStreamed.length) / 4,
          );
          accumulateUsage(
            {
              prompt_tokens: promptTokensEst,
              completion_tokens: completionTokensEst,
            },
            model,
            true, // estimated, cost badge shows an "est." qualifier
          );
        }

        // Primary path: the structured tool call. Its schema-validated
        // arguments ARE the action object, no prose parsing involved.
        if (activeTool) {
          const toolCalls = SELECT_TO_AI_TOOLS.finalizeToolCalls(toolState);
          const usableCall = toolCalls.find(
            (call) => call.args && typeof call.args === "object",
          );
          if (usableCall) {
            parseFailureCount = 0;
            callback(usableCall.args);
            return;
          }
          // The model returned no (parseable) tool call, fall through to
          // the text protocol so prose-answering models still work.
        }

        const parsedText = SELECT_TO_AI_TOOLS.parseTextAction(replyText);
        if (parsedText) {
          parseFailureCount = 0;
          callback(parsedText);
          return;
        }

        console.error("No structured output in reply:", replyText);
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
              `API response did not contain a valid tool call or JSON object. (Failure ${parseFailureCount}/${maxParseFailures})`,
            ),
          );
        }
      }
    });

    try {
      port.postMessage({
        url: endpoint,
        // The background policy needs the provider to know which extra
        // gateway origin (the hosted relay) this request may target.
        provider: provider,
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
