/**
 * Select to AI: the words a run shows on screen.
 *
 * The engine logs what each step did in the words the model reads: element
 * numbers such as [8] and full addresses with their tracking query. The step
 * rows on the agent page show the same facts the way a person says them: the
 * control by its name and the site by its host. The raw text stays in each
 * step's details and in the saved log.
 */
(function (root) {
  "use strict";

  /** "https://www.duckduckgo.com/?q=..." as "duckduckgo.com". */
  function hostOf(url) {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, "") : "";
    } catch (_e) { return ""; }
  }

  /** The names an action gave its element numbers: `click [57] "Sort by"` gives 57 -> Sort by. */
  function namesIn(text, into) {
    const names = into || new Map();
    for (const m of String(text || "").matchAll(/\[(\d+)\]\s*"([^"\n]{1,60})"/g)) names.set(m[1], m[2]);
    return names;
  }

  const atSentenceStart = (before) => /(^|[.!?:]\s+)$/.test(before);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /**
   * A step's result in plain words: element numbers become the control's
   * name (or "the control" when no name is known), and each address becomes
   * its site.
   */
  function plainResult(text, names) {
    const known = names || new Map();
    let out = String(text || "").replace(/\s+/g, " ").trim();
    out = out.replace(/https?:\/\/[^\s"'<>)\]]+/g, (url) => {
      const tail = (url.match(/[.,;:!?]+$/) || [""])[0];
      const host = hostOf(tail ? url.slice(0, -tail.length) : url);
      return (host || "the page") + tail;
    });
    out = out.replace(/\b(?:the )?elements? \[(\d+)\]|\[(\d+)\]/g, (whole, a, b, offset) => {
      const id = a || b;
      const name = known.get(id);
      const start = atSentenceStart(out.slice(0, offset));
      if (name) return `"${name}"`;
      const word = /element/.test(whole) ? "the control" : "it";
      return start ? cap(word) : word;
    });
    return out;
  }

  /** Cut at the last sentence or clause that fits, never mid-word. */
  function clipWords(text, max) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(", "));
    if (end > max * 0.5) return `${cut.slice(0, end).replace(/[.,;\s]+$/, "")}…`;
    const space = cut.lastIndexOf(" ");
    return `${cut.slice(0, space > 0 ? space : max).replace(/[.,;\s]+$/, "")}…`;
  }

  const api = Object.freeze({ hostOf, namesIn, plainResult, clipWords });
  root.SELECT_TO_AI_RUNWORDS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
