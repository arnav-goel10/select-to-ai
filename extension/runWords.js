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

  /** "https://www.example.com/?q=..." as "example.com". */
  function hostOf(url) {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, "") : "";
    } catch (_e) { return ""; }
  }

  // How each kind of action is said in a step row.
  const ACTION_VERB = {
    click: "Click", click_at: "Click a point on the page", double_click: "Double-click", right_click: "Right-click", hold: "Press and hold", hover: "Point at", drag: "Drag", fill: "Fill in", fill_details: "Fill in your details",
    recall: "Look up your details", remember: "Remember", press: "Press", scroll: "Scroll", navigate: "Open", back: "Go back",
    tabs: "Switch tabs", wait: "Wait for the page", look: "Look at the screen", read: "Read further", find: "Search the page", ask_user: "Ask you", done: "Answer",
    delegate: "Hand out sub-tasks",
  };
  // The actions a row names by the control they act on.
  const NAMES_CONTROL = new Set(["click", "double_click", "right_click", "hold", "hover", "drag", "fill"]);

  /**
   * An action as a step row says it, from the data the engine sends with it
   * ({do, ref, control, url, key}): the verb and the control's own name. The
   * action's words are never read for a name, since what was typed is in them.
   */
  function actionWords(act) {
    const a = act || {};
    const verb = ACTION_VERB[a.do] || "Act on the page";
    if (a.do === "navigate") { const host = hostOf(a.url); return host ? `Open ${host}` : verb; }
    if (a.do === "press" && a.key) return `Press ${a.key}`;
    if (NAMES_CONTROL.has(a.do) && a.control) return `${verb} "${a.control}"`;
    if (a.do === "fill") return "Fill in a field";
    return verb;
  }

  /** The control names an action carries as data: element 57 -> Sort by. */
  function namesFrom(act, into) {
    const names = into || new Map();
    if (act && act.ref !== undefined && act.control) names.set(String(act.ref), String(act.control));
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

  const api = Object.freeze({ hostOf, actionWords, namesFrom, plainResult, clipWords });
  root.SELECT_TO_AI_RUNWORDS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
