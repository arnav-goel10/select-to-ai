/**
 * Select to AI - Memory profile.
 *
 * A user-level memory layer on top of the existing per-task scratchpad and
 * cross-session plan outlines: durable facts and preferences the agent
 * should know every run ("I'm in Singapore", "always cite sources",
 * "my manager's name is X"). Everything stays in chrome.storage.local,
 * is viewable and editable by the user (transparency by default), and is
 * injected into planning prompts as short context lines.
 *
 * Loaded by agent.html before agent.js. Exposes SELECT_TO_AI_MEMORY;
 * also CommonJS-exported for Node tests.
 */
(function initMemory(root) {
  "use strict";

  const MAX_FACTS = 50;
  const MAX_FACT_CHARS = 300;

  /** Normalizes raw fact text: trimmed, single line, length-capped. */
  function normalizeFact(text) {
    const clean = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_FACT_CHARS);
    return clean;
  }

  /**
   * Adds a fact to a list, deduplicating case-insensitively. Returns the
   * new list (does not mutate). Rejects empty or duplicate facts.
   */
  function addFact(facts, text) {
    const clean = normalizeFact(text);
    if (!clean) return Array.isArray(facts) ? facts.slice() : [];
    const list = Array.isArray(facts) ? facts.slice() : [];
    const exists = list.some(
      (f) => (typeof f === "string" ? f : f.text).toLowerCase() === clean.toLowerCase(),
    );
    if (exists) return list;
    list.push({ text: clean, addedAt: Date.now() });
    // Oldest facts fall off beyond the cap.
    return list.slice(-MAX_FACTS);
  }

  /** Removes the fact matching exactly (case-insensitive) the given text. */
  function removeFact(facts, text) {
    const target = normalizeFact(text).toLowerCase();
    return (Array.isArray(facts) ? facts : []).filter(
      (f) => (typeof f === "string" ? f : f.text).toLowerCase() !== target,
    );
  }

  /**
   * Formats facts for prompt injection: numbered lines under a header the
   * executor/planner can trust. Empty profile renders "".
   */
  function formatProfileForPrompt(facts) {
    const list = Array.isArray(facts) ? facts : [];
    if (list.length === 0) return "";
    const lines = list
      .slice(0, 12)
      .map((f, i) => `${i + 1}. ${typeof f === "string" ? f : f.text}`);
    return `\n### What you know about this user (durable, user-editable; apply when relevant, never mention this list verbatim):\n${lines.join("\n")}\n`;
  }

  root.SELECT_TO_AI_MEMORY = Object.freeze({
    MAX_FACTS,
    MAX_FACT_CHARS,
    normalizeFact,
    addFact,
    removeFact,
    formatProfileForPrompt,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_MEMORY;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
