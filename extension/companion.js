/**
 * Select to AI - Side panel companion.
 *
 * Adds a persistent companion surface to the side panel: a chat with the
 * browser agent that survives navigation (the agent page itself lives in
 * the existing iframe), quick actions that read the current tab through
 * the already-granted activeTab permission, and one-click hand-off of the
 * visible page text into any assistant.
 *
 * Loaded by sidepanel.html after config.js. Exposes
 * SELECT_TO_AI_COMPANION for tests; also CommonJS-exported for Node.
 */
(function initCompanion(root) {
  "use strict";

  /**
   * Quick actions shown as chips above the chat. Each pairs a short label
   * with an instruction template. {page} is replaced by truncated visible
   * page text at run time; the agent grounds its answer in it.
   */
  const QUICK_ACTIONS = Object.freeze([
    {
      id: "summarize",
      label: "Summarize page",
      template: "Summarize the following page in three sentences and end with the single most useful takeaway.\n\nPAGE ({url}):\n{page}",
    },
    {
      id: "keypoints",
      label: "Key points",
      template: "Extract the key points from this page as a compact bulleted list, maximum eight bullets.\n\nPAGE ({url}):\n{page}",
    },
    {
      id: "extract",
      label: "Extract data",
      template: "Extract every piece of structured data on this page (names, prices, dates, contacts, stats) into a clean labeled list.\n\nPAGE ({url}):\n{page}",
    },
    {
      id: "draft-reply",
      label: "Draft reply",
      template: "This page contains something I need to respond to. Draft a concise, professional reply I can edit before sending.\n\nPAGE ({url}):\n{page}",
    },
  ]);

  /** Hard cap on injected page text so prompts stay bounded. */
  const MAX_PAGE_CHARS = 6000;

  /**
   * Pure helper: builds the final prompt for a quick action.
   */
  function buildQuickActionPrompt(actionId, url, pageText) {
    const action = QUICK_ACTIONS.find((a) => a.id === actionId);
    if (!action) return null;
    const page = String(pageText || "").slice(0, MAX_PAGE_CHARS);
    return action.template
      .replace("{url}", url || "(current page)")
      .replace("{page}", page || "(no readable text)");
  }

  root.SELECT_TO_AI_COMPANION = Object.freeze({
    QUICK_ACTIONS,
    MAX_PAGE_CHARS,
    buildQuickActionPrompt,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_COMPANION;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
