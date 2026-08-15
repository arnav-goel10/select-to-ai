/**
 * Select to AI - Agent tool-calling core.
 *
 * Pure, dependency-free logic shared by the agent panel (agent.html), the
 * page-injected content script, and Node.js unit tests:
 *
 * - The canonical `browser_action` tool schema (one discriminated tool) in
 *   both the OpenAI-compatible and Anthropic wire shapes.
 * - Validation of every tool call BEFORE dispatch (unknown action, bad ids,
 *   missing params) so garbage never reaches the page.
 * - Streaming accumulators for OpenAI `tool_calls` deltas and Anthropic
 *   `tool_use` / `input_json_delta` events.
 * - The legacy text-JSON fallback parser for models without tool support.
 * - Stable element-id allocation (ids survive re-scans within a page).
 * - Outcome-delta computation (did the action actually change anything?).
 * - Planner / validator response parsing.
 *
 * No chrome.* APIs, no DOM access: safe to inject into any page context.
 */
(function initAgentTools(root) {
  "use strict";

  // =========================================================================
  // Action space
  // =========================================================================

  const SCROLL_DIRECTIONS = Object.freeze(["down", "up", "left", "right"]);

  /**
   * Per-action parameter contract. `id: true` means a valid element id is
   * required; `idOptional: true` means an id is accepted but not required.
   */
  const ACTION_SPECS = Object.freeze({
    click: { id: true },
    double_click: { id: true },
    right_click: { id: true },
    hover: { id: true },
    type: { id: true, requiredStrings: ["text"] },
    clear: { id: true },
    select_option: { id: true, oneOf: ["optionText", "optionIndex"] },
    checkbox_toggle: { id: true },
    keypress: { idOptional: true, requiredStrings: ["text"] },
    scroll: { requiresScrollDirection: true, scrollTargetOptional: true },
    navigate: { requiredUrl: true },
    wait: { durationOptional: true },
    back: {},
    forward: {},
    open_tab: { requiredUrl: true },
    switch_tab: { requiredTabId: true },
    close_tab: { tabIdOptional: true },
    reload_tab: { tabIdOptional: true },
    list_tabs: {},
    request_screenshot: {},
    // finish's answer is validated by a dedicated check (clearer message).
    finish: { optionalStrings: ["evidence"] },
    ask_user: { requiredStrings: ["question"] },
    give_up: { requiredStrings: ["reason"] },
    remember: { requiredStrings: ["note"] },
    revise_plan: { requiresSubtasks: true },
  });

  const ACTION_NAMES = Object.freeze(Object.keys(ACTION_SPECS));

  // =========================================================================
  // Tool schemas (single discriminated tool)
  // =========================================================================

  const BROWSER_ACTION_PARAMETERS = Object.freeze({
    type: "object",
    properties: {
      thought: {
        type: "string",
        description:
          "Brief reasoning: what the current page state shows, what the last outcome implied, and why this action is the right next step.",
      },
      action: {
        type: "string",
        enum: ACTION_NAMES,
        description: "The single browser action to perform this step.",
      },
      id: {
        type: "integer",
        description:
          "Target element id from the CURRENT numbered element list (required for element actions).",
      },
      text: {
        type: "string",
        description:
          "Text to type (type), or key name for keypress: Enter, Tab, Escape, Backspace, ArrowDown, etc.",
      },
      url: {
        type: "string",
        description: "Fully qualified http(s) URL for navigate / open_tab.",
      },
      optionText: {
        type: "string",
        description: "Exact visible option text for select_option.",
      },
      optionIndex: {
        type: "integer",
        description: "Zero-based option index for select_option (alternative to optionText).",
      },
      scrollDirection: {
        type: "string",
        enum: SCROLL_DIRECTIONS,
        description: "Direction for scroll.",
      },
      scrollTarget: {
        type: "integer",
        description: "Optional element id of a scrollable container (scroll the window when omitted).",
      },
      duration: {
        type: "integer",
        description: "Milliseconds to wait (wait action, max 10000).",
      },
      tabId: {
        type: "integer",
        description: "Tab id for switch_tab / close_tab / reload_tab.",
      },
      answer: {
        type: "string",
        description:
          "finish only: the complete final answer to the user, grounded in what was read on the page. Must not be empty.",
      },
      evidence: {
        type: "string",
        description:
          "finish only: short quote or description of the on-page evidence that supports the answer.",
      },
      question: {
        type: "string",
        description: "ask_user only: the single question the user must answer before you can continue.",
      },
      note: {
        type: "string",
        description: "remember only: a fact worth keeping in your scratchpad for later steps (prices, names, URLs, partial findings).",
      },
      subtasks: {
        type: "array",
        description: "revise_plan only: the corrected remaining plan.",
        items: {
          type: "object",
          properties: {
            task: { type: "string" },
            postcondition: { type: "string" },
          },
          required: ["task"],
        },
      },
      completedSubtask: {
        type: "boolean",
        description:
          "Set true when the CURRENT subtask's postcondition has just been met, so the plan advances.",
      },
      reason: {
        type: "string",
        description: "One-line summary of what this action does (shown to the user).",
      },
    },
    required: ["thought", "action"],
  });

  const BROWSER_ACTION_DESCRIPTION =
    "Perform exactly one browser action per step. Element actions must use an id from the current numbered element list. Use finish only when the goal is met and you can cite on-page evidence; use ask_user when you need credentials, a CAPTCHA solved, or a decision; use give_up when the task is impossible.";

  const PLAN_PARAMETERS = Object.freeze({
    type: "object",
    properties: {
      subtasks: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        description: "Ordered subtasks that complete the user's task.",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "Imperative subtask description." },
            postcondition: {
              type: "string",
              description: "Observable page condition proving this subtask is done.",
            },
          },
          required: ["task", "postcondition"],
        },
      },
    },
    required: ["subtasks"],
  });

  const VALIDATION_PARAMETERS = Object.freeze({
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail"],
        description: "pass only when the claimed answer is supported by the page evidence.",
      },
      reason: {
        type: "string",
        description: "Why the verdict was reached; for fail, what evidence is missing.",
      },
    },
    required: ["verdict", "reason"],
  });

  function buildOpenAITool(name, description, parameters) {
    return {
      type: "function",
      function: { name, description, parameters },
    };
  }

  function buildAnthropicTool(name, description, parameters) {
    return { name, description, input_schema: parameters };
  }

  const TOOL_DEFS = Object.freeze({
    browser_action: {
      name: "browser_action",
      description: BROWSER_ACTION_DESCRIPTION,
      parameters: BROWSER_ACTION_PARAMETERS,
    },
    submit_plan: {
      name: "submit_plan",
      description: "Submit the ordered subtask plan for the user's browser task.",
      parameters: PLAN_PARAMETERS,
    },
    submit_validation: {
      name: "submit_validation",
      description: "Submit the verdict on whether the claimed answer is supported by the final page state.",
      parameters: VALIDATION_PARAMETERS,
    },
  });

  // =========================================================================
  // Tool-call validation (before dispatch)
  // =========================================================================

  function coerceInteger(value) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return parseInt(value.trim(), 10);
    }
    return null;
  }

  function normalizeUrl(url) {
    if (!url || typeof url !== "string") return "";
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  function isHttpUrl(url) {
    return /^https?:\/\/[^\s]+$/i.test(url);
  }

  function normalizeSubtasks(rawSubtasks) {
    if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) return null;
    const normalized = [];
    for (const item of rawSubtasks.slice(0, 8)) {
      if (typeof item === "string" && item.trim()) {
        normalized.push({ task: item.trim(), postcondition: "" });
      } else if (item && typeof item === "object" && typeof item.task === "string" && item.task.trim()) {
        normalized.push({
          task: item.task.trim(),
          postcondition: typeof item.postcondition === "string" ? item.postcondition.trim() : "",
        });
      }
    }
    return normalized.length > 0 ? normalized : null;
  }

  /**
   * Validates (and normalizes) a raw tool call BEFORE it is dispatched.
   *
   * @param {Object} raw - The parsed tool arguments.
   * @param {Object} [context]
   * @param {Set<number>|Array<number>} [context.validIds] - Element ids in the current scan.
   * @returns {{ok: true, action: Object} | {ok: false, error: string}}
   */
  function validateToolCall(raw, context = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "The tool call arguments were not a JSON object." };
    }

    const actionName = typeof raw.action === "string" ? raw.action.trim() : "";
    const spec = ACTION_SPECS[actionName];
    if (!spec) {
      return {
        ok: false,
        error: `Unknown action "${actionName || "(missing)"}". Valid actions: ${ACTION_NAMES.join(", ")}.`,
      };
    }

    const action = { ...raw, action: actionName };

    // Model leniency: keypress may arrive with "key" instead of "text"
    // (the dispatcher accepts both; normalize to "text").
    if (
      actionName === "keypress" &&
      (typeof action.text !== "string" || !action.text.trim()) &&
      typeof action.key === "string" &&
      action.key.trim()
    ) {
      action.text = action.key.trim();
    }

    const validIds =
      context.validIds instanceof Set
        ? context.validIds
        : Array.isArray(context.validIds)
          ? new Set(context.validIds)
          : null;

    const checkId = (field, required) => {
      const value = action[field];
      if (value === undefined || value === null || value === "") {
        if (required) {
          return `Action "${actionName}" requires an integer "${field}" from the current element list.`;
        }
        delete action[field];
        return "";
      }
      const coerced = coerceInteger(value);
      if (coerced === null || coerced < 1) {
        return `Parameter "${field}" must be a positive integer element id (got ${JSON.stringify(value)}).`;
      }
      if (validIds && validIds.size > 0 && !validIds.has(coerced)) {
        return `Element id ${coerced} is not in the current element list. Use only the numbered ids shown in the latest scan.`;
      }
      action[field] = coerced;
      return "";
    };

    if (spec.id) {
      const err = checkId("id", true);
      if (err) return { ok: false, error: err };
    } else if (spec.idOptional) {
      const err = checkId("id", false);
      if (err) return { ok: false, error: err };
    }

    if (spec.scrollTargetOptional && action.scrollTarget !== undefined && action.scrollTarget !== null) {
      const err = checkId("scrollTarget", false);
      if (err) return { ok: false, error: err };
    }

    for (const field of spec.requiredStrings || []) {
      if (typeof action[field] !== "string" || !action[field].trim()) {
        return {
          ok: false,
          error: `Action "${actionName}" requires a non-empty string "${field}".`,
        };
      }
      action[field] = field === "text" ? action[field] : action[field].trim();
    }

    if (spec.oneOf) {
      const hasText = typeof action.optionText === "string" && action.optionText.trim();
      const optionIndex = coerceInteger(action.optionIndex);
      if (!hasText && optionIndex === null) {
        return {
          ok: false,
          error: `Action "${actionName}" requires "optionText" (exact visible text) or "optionIndex".`,
        };
      }
      if (optionIndex !== null) {
        if (optionIndex < 0) {
          return { ok: false, error: `"optionIndex" must be a non-negative integer.` };
        }
        action.optionIndex = optionIndex;
      }
    }

    if (spec.requiresScrollDirection) {
      if (!SCROLL_DIRECTIONS.includes(action.scrollDirection)) {
        return {
          ok: false,
          error: `Action "scroll" requires "scrollDirection" as one of: ${SCROLL_DIRECTIONS.join(", ")}.`,
        };
      }
    }

    if (spec.requiredUrl) {
      const normalized = normalizeUrl(action.url);
      if (!normalized || !isHttpUrl(normalized)) {
        return {
          ok: false,
          error: `Action "${actionName}" requires a valid http(s) "url" (got ${JSON.stringify(action.url ?? null)}).`,
        };
      }
      action.url = normalized;
    }

    if (spec.requiredTabId) {
      const coerced = coerceInteger(action.tabId);
      if (coerced === null) {
        return { ok: false, error: `Action "${actionName}" requires an integer "tabId".` };
      }
      action.tabId = coerced;
    } else if (spec.tabIdOptional && action.tabId !== undefined && action.tabId !== null) {
      const coerced = coerceInteger(action.tabId);
      if (coerced === null) {
        delete action.tabId;
      } else {
        action.tabId = coerced;
      }
    }

    if (spec.durationOptional && action.duration !== undefined && action.duration !== null) {
      const coerced = coerceInteger(action.duration);
      action.duration = coerced === null ? 2000 : Math.max(0, Math.min(coerced, 10000));
    }

    if (spec.requiresSubtasks) {
      const normalized = normalizeSubtasks(action.subtasks);
      if (!normalized) {
        return {
          ok: false,
          error: `Action "revise_plan" requires a non-empty "subtasks" array of {task, postcondition} objects.`,
        };
      }
      action.subtasks = normalized;
    }

    if (actionName === "finish" && !String(action.answer || "").trim()) {
      return {
        ok: false,
        error: 'finish rejected: the "answer" field was empty. Provide the grounded final answer, or keep working.',
      };
    }

    return { ok: true, action };
  }

  // =========================================================================
  // Streaming tool-call accumulators
  // =========================================================================

  function createToolCallAccumulator() {
    return { calls: [] };
  }

  /**
   * Feeds one OpenAI-compatible streaming delta's `tool_calls` array.
   * Fragments arrive as {index, id?, function: {name?, arguments?}}.
   */
  function accumulateOpenAIToolCallDelta(state, deltaToolCalls) {
    if (!state || !Array.isArray(deltaToolCalls)) return;
    for (const fragment of deltaToolCalls) {
      if (!fragment || typeof fragment !== "object") continue;
      const index = Number.isInteger(fragment.index) ? fragment.index : 0;
      if (!state.calls[index]) {
        state.calls[index] = { id: "", name: "", arguments: "" };
      }
      const slot = state.calls[index];
      if (fragment.id) slot.id = fragment.id;
      if (fragment.function) {
        if (typeof fragment.function.name === "string") {
          slot.name += fragment.function.name;
        }
        if (typeof fragment.function.arguments === "string") {
          slot.arguments += fragment.function.arguments;
        }
      }
    }
  }

  /**
   * Feeds one Anthropic streaming event. Handles `content_block_start`
   * (tool_use) and `content_block_delta` (input_json_delta).
   */
  function accumulateAnthropicEvent(state, event) {
    if (!state || !event || typeof event !== "object") return;
    if (
      event.type === "content_block_start" &&
      event.content_block &&
      event.content_block.type === "tool_use"
    ) {
      const index = Number.isInteger(event.index) ? event.index : 0;
      state.calls[index] = {
        id: event.content_block.id || "",
        name: event.content_block.name || "",
        arguments: "",
      };
      return;
    }
    if (
      event.type === "content_block_delta" &&
      event.delta &&
      event.delta.type === "input_json_delta"
    ) {
      const index = Number.isInteger(event.index) ? event.index : 0;
      const slot = state.calls[index];
      if (slot && typeof event.delta.partial_json === "string") {
        slot.arguments += event.delta.partial_json;
      }
    }
  }

  /**
   * Finalizes accumulated tool calls into parsed {name, args} entries.
   * Entries whose JSON never parses are returned with an `error` field.
   */
  function finalizeToolCalls(state) {
    if (!state || !Array.isArray(state.calls)) return [];
    const results = [];
    for (const slot of state.calls) {
      if (!slot || !slot.name) continue;
      const rawArgs = (slot.arguments || "").trim();
      if (!rawArgs) {
        results.push({ name: slot.name, args: {} });
        continue;
      }
      try {
        results.push({ name: slot.name, args: JSON.parse(rawArgs) });
      } catch (err) {
        results.push({ name: slot.name, args: null, error: err.message, raw: rawArgs });
      }
    }
    return results;
  }

  // =========================================================================
  // Text-JSON fallback parsing (models / gateways without tool support)
  // =========================================================================

  /**
   * Extracts a JSON object from free-form model text: strips code fences,
   * tries a direct parse, then the greedy outermost-braces match.
   * @returns {Object|null}
   */
  function parseTextAction(replyText) {
    if (typeof replyText !== "string") return null;
    let jsonText = replyText.trim();
    if (!jsonText) return null;

    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```json/i, "")
        .replace(/^```/, "")
        .replace(/```$/, "")
        .trim();
    }

    try {
      const parsed = JSON.parse(jsonText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_err) {
      // fall through to brace extraction
    }

    const match = jsonText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch (_err) {
        return null;
      }
    }
    return null;
  }

  // =========================================================================
  // Stable element-id allocation
  // =========================================================================

  /**
   * Allocates stable element ids for one scan of a page.
   *
   * @param {Array<number|null>} previousIds - For each candidate (document
   *   order), the id previously stamped on it this page, or null.
   * @param {number} nextId - The page's monotonic next-id counter.
   * @returns {{ids: number[], nextId: number}} Assigned ids (previous ids are
   *   reused; new elements get fresh monotonic ids; duplicates and foreign
   *   ids are re-allocated) plus the advanced counter.
   */
  function assignStableElementIds(previousIds, nextId) {
    let counter = Number.isInteger(nextId) && nextId > 0 ? nextId : 1;
    const used = new Set();
    const source = Array.isArray(previousIds) ? previousIds : [];

    const ids = source.map((prev) => {
      const reusable =
        Number.isInteger(prev) && prev >= 1 && prev < counter && !used.has(prev);
      if (reusable) {
        used.add(prev);
        return prev;
      }
      while (used.has(counter)) counter++;
      const id = counter;
      used.add(id);
      counter++;
      return id;
    });

    return { ids, nextId: counter };
  }

  // =========================================================================
  // Outcome verification (cheap validator signal)
  // =========================================================================

  /**
   * Computes what actually changed on the page around an action.
   *
   * @param {Object} before - {url, title, scrollX, scrollY, elementCount}
   * @param {Object} after - same shape
   * @param {number} mutationCount - MutationObserver record count during settle.
   */
  function computeOutcomeDelta(before, after, mutationCount) {
    const b = before || {};
    const a = after || {};
    const mutations = Number.isFinite(mutationCount) ? Math.max(0, mutationCount) : 0;
    const urlChanged = String(b.url || "") !== String(a.url || "");
    const titleChanged = String(b.title || "") !== String(a.title || "");
    const scrollChanged =
      Math.abs((a.scrollY || 0) - (b.scrollY || 0)) > 2 ||
      Math.abs((a.scrollX || 0) - (b.scrollX || 0)) > 2;
    const newElementCount =
      Number.isFinite(a.elementCount) && Number.isFinite(b.elementCount)
        ? a.elementCount - b.elementCount
        : 0;
    const noEffect =
      !urlChanged && !titleChanged && !scrollChanged && mutations === 0 && newElementCount === 0;
    return {
      urlChanged,
      titleChanged,
      domMutationCount: mutations,
      newElementCount,
      scrollChanged,
      noEffect,
    };
  }

  /** Formats an outcome delta into the compact history string the model reads. */
  function formatOutcomeDelta(delta) {
    if (!delta || typeof delta !== "object") return "";
    const parts = [
      delta.urlChanged ? "URL changed" : "URL unchanged",
      delta.titleChanged ? "title changed" : "title unchanged",
      `${delta.domMutationCount || 0} DOM mutations`,
      `${delta.newElementCount > 0 ? "+" : ""}${delta.newElementCount || 0} interactive elements`,
      delta.scrollChanged ? "scroll changed" : "scroll unchanged",
    ];
    let text = `Outcome: ${parts.join("; ")}.`;
    if (delta.noEffect) {
      text +=
        " WARNING: no observable page change — the action may have been a no-op. Try a different element or approach.";
    }
    return text;
  }

  // =========================================================================
  // Minimal safe markdown rendering (final answers in the agent panel)
  // =========================================================================

  /** HTML-escapes a string (all five significant characters). */
  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /** Inline markdown on ALREADY-ESCAPED text: links, bold, italics. */
  function renderInlineMarkdown(escapedLine) {
    let out = escapedLine;
    // [text](https://url) — http(s) only, so javascript:/data: can never
    // become an href. The URL is already HTML-escaped.
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    // **bold**
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // *italic* (single asterisks left after bold)
    out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // _italic_ only when standing alone (never inside snake_case words)
    out = out.replace(
      /(^|\s)_([^_\n]+)_(?=$|\s|[.,;:!?)])/g,
      "$1<em>$2</em>",
    );
    return out;
  }

  /**
   * Renders a minimal, safe markdown subset to HTML: bold, italics, bullet
   * lists, and http(s) links (rel="noopener noreferrer"). EVERYTHING is
   * HTML-escaped first; only the tags this renderer itself emits exist in
   * the output, so model text can never inject markup.
   * @param {string} text
   * @returns {string} HTML string
   */
  function renderSafeMarkdown(text) {
    const escaped = escapeHtml(text);
    if (!escaped.trim()) return "";
    const lines = escaped.split(/\r?\n/);
    const parts = [];
    let listItems = null;

    const flushList = () => {
      if (listItems && listItems.length > 0) {
        parts.push(`<ul>${listItems.join("")}</ul>`);
      }
      listItems = null;
    };

    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        if (!listItems) listItems = [];
        listItems.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
        continue;
      }
      flushList();
      if (line.trim()) {
        parts.push(`<p>${renderInlineMarkdown(line)}</p>`);
      }
    }
    flushList();
    return parts.join("");
  }

  // =========================================================================
  // Planner / validator response parsing
  // =========================================================================

  /**
   * Parses a planner response ({subtasks: [...]}) into normalized subtasks.
   * @returns {Array<{task: string, postcondition: string}>|null}
   */
  function parsePlanResponse(obj) {
    if (!obj || typeof obj !== "object") return null;
    return normalizeSubtasks(obj.subtasks);
  }

  /**
   * Parses a validator response into {pass, reason}. Accepts verdict strings
   * ("pass"/"fail"/"yes"/"no"/"valid"/"invalid") or boolean fields.
   * @returns {{pass: boolean, reason: string}|null}
   */
  function parseValidatorResponse(obj) {
    if (!obj || typeof obj !== "object") return null;
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    if (typeof obj.verdict === "string") {
      const verdict = obj.verdict.trim().toLowerCase();
      if (["pass", "yes", "valid", "true", "supported"].includes(verdict)) {
        return { pass: true, reason };
      }
      if (["fail", "no", "invalid", "false", "unsupported"].includes(verdict)) {
        return { pass: false, reason };
      }
      return null;
    }
    for (const field of ["pass", "valid", "passed", "supported"]) {
      if (typeof obj[field] === "boolean") {
        return { pass: obj[field], reason };
      }
    }
    return null;
  }

  // =========================================================================
  // Export
  // =========================================================================

  const api = Object.freeze({
    ACTION_NAMES,
    ACTION_SPECS,
    TOOL_DEFS,
    buildOpenAITool,
    buildAnthropicTool,
    validateToolCall,
    normalizeUrl,
    createToolCallAccumulator,
    accumulateOpenAIToolCallDelta,
    accumulateAnthropicEvent,
    finalizeToolCalls,
    parseTextAction,
    assignStableElementIds,
    computeOutcomeDelta,
    formatOutcomeDelta,
    parsePlanResponse,
    parseValidatorResponse,
    escapeHtml,
    renderSafeMarkdown,
  });

  root.SELECT_TO_AI_TOOLS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
