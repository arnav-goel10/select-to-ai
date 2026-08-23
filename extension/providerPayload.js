/**
 * Select to AI - Provider payload builders.
 *
 * Pure helpers for constructing provider-specific request pieces (system
 * content shapes, prompt-caching splits, error-message cleanup). No DOM,
 * no chrome.* APIs: everything is injected — the caller supplies whether
 * prompt caching is enabled and what the stable cacheable block is.
 *
 * Loaded by agent.html before agent.js. Exposes
 * SELECT_TO_AI_PROVIDER_PAYLOAD; also CommonJS-exported for Node tests.
 */
(function initProviderPayload(root) {
  "use strict";

  /** Parses a `data:` URL into {mediaType, base64Data}, or null. */
  function parseDataUrl(dataUrl) {
    if (!dataUrl) return null;
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        mediaType: match[1],
        base64Data: match[2],
      };
    }
    return null;
  }

  /**
   * Whether this provider/model pair supports explicit prompt-cache_control
   * blocks. cachingEnabled reflects the user setting; the model families
   * that accept ephemeral cache_control are Anthropic models everywhere and
   * Claude/Qwen ids behind OpenRouter.
   */
  function supportsExplicitPromptCaching(provider, model, cachingEnabled) {
    if (cachingEnabled === false) return false;
    const modelId = String(model || "").toLowerCase();
    if (provider === "anthropic") return true;
    if (provider !== "openrouter") return false;
    return (
      modelId.includes("anthropic/") ||
      modelId.includes("claude") ||
      modelId.includes("qwen/")
    );
  }

  /** Joins a string-or-parts system prompt into one plain string. */
  function systemPromptToText(systemPrompt) {
    if (Array.isArray(systemPrompt)) {
      return systemPrompt.map((part) => part.text || "").join("");
    }
    return String(systemPrompt || "");
  }

  /**
   * Splits a system prompt into [static | dynamic] parts for caching.
   * Callers that already know the split pass an array of {text, cacheable}
   * parts directly; that IS the real static block, so it is used verbatim.
   * String prompts fall back to marking the embedded browser-capability
   * block (the only stable region of legacy prompts) as cacheable; the
   * stableBlock is injected by the caller.
   */
  function splitSystemPromptForCaching(systemPrompt, stableBlock) {
    if (Array.isArray(systemPrompt)) {
      return systemPrompt.filter(
        (part) => part && part.text && part.text.trim().length > 0,
      );
    }
    const text = String(systemPrompt || "");
    const block = String(stableBlock || "");
    if (!block || !text) return [{ text, cacheable: false }];
    const idx = text.indexOf(block);
    if (idx === -1) {
      return [{ text, cacheable: false }];
    }
    return [
      { text: text.slice(0, idx), cacheable: false },
      { text: block, cacheable: true },
      { text: text.slice(idx + block.length), cacheable: false },
    ].filter((part) => part.text && part.text.trim().length > 0);
  }

  /**
   * Anthropic `system` field: plain string when explicit caching is not
   * available, otherwise cache-marked text blocks (static first).
   */
  function buildAnthropicSystemContent(
    systemPrompt,
    provider,
    model,
    cachingEnabled,
    stableBlock,
  ) {
    if (!supportsExplicitPromptCaching(provider, model, cachingEnabled)) {
      // Static-first ordering still helps providers with automatic
      // prefix caching even when explicit cache_control is unsupported.
      return systemPromptToText(systemPrompt);
    }
    return splitSystemPromptForCaching(systemPrompt, stableBlock).map((part) => {
      const block = { type: "text", text: part.text };
      if (part.cacheable) {
        block.cache_control = { type: "ephemeral" };
      }
      return block;
    });
  }

  /**
   * OpenAI-compatible `system` message: plain string when explicit caching
   * is not available, otherwise cache-marked content parts (static first).
   */
  function buildOpenAICompatibleSystemMessage(
    systemPrompt,
    provider,
    model,
    cachingEnabled,
    stableBlock,
  ) {
    if (!supportsExplicitPromptCaching(provider, model, cachingEnabled)) {
      // Plain string, static half first: automatic-prefix-caching friendly
      // (OpenAI, DeepSeek, Groq, and most gateways cache shared prefixes).
      return { role: "system", content: systemPromptToText(systemPrompt) };
    }
    return {
      role: "system",
      content: splitSystemPromptForCaching(systemPrompt, stableBlock).map((part) => {
        const block = { type: "text", text: part.text };
        if (part.cacheable) {
          block.cache_control = { type: "ephemeral" };
        }
        return block;
      }),
    };
  }

  /**
   * Cleans a raw provider error payload into a short human-readable line:
   * unwraps JSON envelopes ({error:{message}} / {message}), bracket-wrapped
   * arrays (Google-style), and truncates long plain text.
   */
  function cleanErrorMessage(rawErrorText, status) {
    if (!rawErrorText) return `API error (HTTP ${status || "unknown"})`;

    let trimmed = rawErrorText.trim();
    try {
      // Un-wrap array if it's wrapped in square brackets (e.g. Google APIs
      // or custom endpoints).
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const arr = JSON.parse(trimmed);
        if (arr && arr[0]) {
          trimmed =
            typeof arr[0] === "object" ? JSON.stringify(arr[0]) : String(arr[0]);
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
    } catch (_err) {
      // Not JSON; fall through to plain-text handling.
    }

    // If it's plain text but too long, truncate it
    if (rawErrorText.length > 200) {
      return rawErrorText.substring(0, 200) + "...";
    }
    return rawErrorText;
  }

  root.SELECT_TO_AI_PROVIDER_PAYLOAD = Object.freeze({
    parseDataUrl,
    supportsExplicitPromptCaching,
    systemPromptToText,
    splitSystemPromptForCaching,
    buildAnthropicSystemContent,
    buildOpenAICompatibleSystemMessage,
    cleanErrorMessage,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_PROVIDER_PAYLOAD;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
