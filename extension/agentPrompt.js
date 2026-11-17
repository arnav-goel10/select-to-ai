/**
 * Select to AI - page text as the model reads it, as pure functions: the
 * page in reading order inside a budget, and the list of open tabs.
 *
 * Loaded by the service worker (importScripts) after agentTools.js, and by
 * Node via require(); both paths expose SELECT_TO_AI_PROMPT. Used by
 * core/context.js.
 */
(function initAgentPrompt(root) {
  "use strict";

  const TOOLS =
    root.SELECT_TO_AI_TOOLS ||
    (typeof require === "function" ? require("./agentTools.js") : null);

  /**
   * Page text in the order a reader needs it, inside a character budget:
   * where things are (outline), what is on screen, the passages that match
   * the task from anywhere on the page, then the start of the main content.
   */
  function composePageText(page, task, budget, out) {
    const full = page.innerText || "";
    if (!full.trim()) return "Page text: [No text content found]";
    const parts = [];
    let used = 0;
    const outline = (page.outline || [])
      .map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}${h.where === "on screen" ? "•" : h.where === "above" ? "↑" : "↓"} ${h.text}`)
      .join("\n");
    if (outline) {
      const o = outline.slice(0, 700);
      parts.push(`Page outline (• on screen, ↑ above, ↓ below; scroll with toText to reach a heading):\n${o}`);
      used += o.length;
    }
    const visible = (page.visibleText || "").slice(0, 1200);
    if (visible) {
      parts.push(`On screen now:\n${visible}`);
      used += visible.length;
    }
    const passages = TOOLS.relevantPassages(full, task, { max: 3, maxChars: 600 })
      .filter((p) => !visible.includes(p.slice(0, 60)));
    if (passages.length) {
      const block = passages.map((p) => `- ${p}`).join("\n");
      parts.push(`Passages matching the task, from anywhere on the page:\n${block}`);
      used += block.length;
    }
    const room = Math.max(600, budget - used);
    if (out) out.truncated = full.length > room;
    let start = full.slice(0, room);
    if (full.length > room) {
      const cut = Math.max(start.lastIndexOf("\n"), start.lastIndexOf(" "));
      start = (cut > 0 ? start.slice(0, cut) : start) + " …";
    }
    // How far into the page's text this goes, for reading on from there.
    if (out) out.shown = full.length > room ? start.length - 2 : full.length;
    // Say when this is the whole page, so the model does not spend a step reading what it already has.
    parts.push(full.length > room
      ? `Main content (from the top, first ${room} of ${full.length} characters; read the rest with the read action):\n${start}`
      : `Main content (the whole page; there is nothing more to read):\n${start}`);
    return parts.join("\n\n");
  }

  /** One line per open tab, marking the one the agent is on and the one in front. */
  function formatTabs(tabs) {
    return (tabs || [])
      .map((tab) => {
        const markers = [tab.current ? "agent-current" : "", tab.active ? "window-active" : ""].filter(Boolean).join(", ");
        return `Tab ${tab.id}${markers ? ` (${markers})` : ""}: "${tab.title}" | ${tab.url}`;
      })
      .join("\n");
  }

  const api = Object.freeze({
    composePageText,
    formatTabs,
  });

  root.SELECT_TO_AI_PROMPT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
