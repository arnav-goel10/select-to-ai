/**
 * Select to AI - Localization helper.
 *
 * Thin wrapper over chrome.i18n.getMessage with graceful fallback to the
 * key's default (English) text when a message is missing or when running
 * under Node tests. UI pages can call SELECT_TO_AI_I18N.t('welcomeTitle').
 *
 * Loaded by extension pages before their logic scripts. Exposes
 * SELECT_TO_AI_I18N; also CommonJS-exported for Node tests.
 */
(function initI18n(root) {
  "use strict";

  // Fallback catalog mirrors _locales/en/messages.json so tests and any
  // surface without the i18n API still render sensible strings.
  const FALLBACKS = {
    appName: "Select to AI",
    appShortName: "Select to AI",
    appDescription:
      "Send selected text to leading AI assistants or run bounded browser workflows with explicit permissions and safety limits.",
    contextMenuAgent: "Send to AI Browser Agent",
    notificationTaskCompleteTitle: "Select to AI",
    notificationTaskCompleteBody: "Task completed",
    omniboxKeywordHint: "ai",
    welcomeTitle: "How can I assist you on this page?",
    welcomeDescription:
      "Input an instruction. The browser agent will plan a checklist, interact with page components, and validate the output.",
  };

  function t(key, substitutions) {
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.i18n &&
        typeof chrome.i18n.getMessage === "function"
      ) {
        const message = chrome.i18n.getMessage(key, substitutions);
        if (message) return message;
      }
    } catch (_err) {
      // Fall through to fallbacks.
    }
    return FALLBACKS[key] || key;
  }

  root.SELECT_TO_AI_I18N = Object.freeze({ t, FALLBACKS });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_I18N;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
