/**
 * Select to AI - Task history.
 *
 * A single, append-mostly log of everything the user runs through the
 * extension: popup tasks, address-bar tasks, playbook runs. Every entry
 * records what was asked, how it was routed, and how it ended so nothing
 * is lost between sessions. Stored locally (chrome.storage.local under
 * "taskHistory"), capped, newest-first.
 *
 * Pure logic here; storage wiring lives in the callers and background.js.
 * Exposes SELECT_TO_AI_TASK_HISTORY; also CommonJS-exported for Node tests.
 */
(function initTaskHistory(root) {
  "use strict";

  const STORAGE_KEY = "taskHistory";
  const MAX_ENTRIES = 60;

  const ROUTES = Object.freeze({
    AGENT: "agent",
    QUESTION: "question",
    SITE: "site",
    PLAYBOOK: "playbook",
    ROUTINE: "routine",
    QUICK_ACTION: "quick-action",
  });

  const STATUSES = Object.freeze({
    RUNNING: "running",
    SUCCESS: "success",
    ERROR: "error",
    STOPPED: "stopped",
    ASK_USER: "needs-input",
  });

  /**
   * Creates a history entry. route is one of ROUTES; status one of
   * STATUSES (RUNNING at creation). Extra fields are preserved.
   */
  function createEntry({ route, task, detail = "", status = STATUSES.RUNNING, ...rest }) {
    return {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      route,
      task: String(task || "").slice(0, 500),
      detail: String(detail || "").slice(0, 300),
      status,
      ...rest,
    };
  }

  /** Prepends an entry, caps the list, returns the new array (no mutation). */
  function prepend(history, entry) {
    const list = Array.isArray(history) ? history : [];
    return [entry, ...list].slice(0, MAX_ENTRIES);
  }

  /**
   * Updates an entry in place by id (e.g. running -> success). Returns the
   * new array; unchanged if the id is absent. Extra fields merge.
   */
  function updateEntry(history, id, patch) {
    if (!Array.isArray(history)) return [];
    return history.map((entry) =>
      entry.id === id ? { ...entry, ...patch } : entry,
    );
  }

  /** Case-insensitive prefix filter across task text and route. */
  function filterEntries(history, query) {
    const q = String(query || "").trim().toLowerCase();
    const list = Array.isArray(history) ? history : [];
    if (!q) return list;
    return list.filter(
      (e) =>
        (e.task || "").toLowerCase().includes(q) ||
        (e.route || "").toLowerCase().includes(q),
    );
  }

  root.SELECT_TO_AI_TASK_HISTORY = Object.freeze({
    STORAGE_KEY,
    MAX_ENTRIES,
    ROUTES,
    STATUSES,
    createEntry,
    prepend,
    updateEntry,
    filterEntries,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_TASK_HISTORY;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
