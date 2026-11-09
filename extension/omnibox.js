/**
 * Select to AI - the address bar entry.
 *
 * Typing the keyword, a space and a request, then Enter, starts an agent
 * run with that request: the agent opens in the side panel of the window
 * the user typed in (or in a tab, where the panel cannot be opened) and
 * starts as its own Run button would. The agent decides whether to answer,
 * open a site or act.
 *
 * The request reaches the panel as a one-time handoff kept in session
 * storage, named by an id in the panel's address. The panel takes it and
 * removes it, so opening the panel again later does not start the same
 * request a second time.
 *
 * Pure helpers and a handler that is given the chrome API it uses, so the
 * tests can hand it a stand-in.
 */
(function initOmnibox(root) {
  "use strict";

  const LIMIT = 400;
  const RECENT_SHOWN = 4;
  const HANDOFF_KEY = "agentHandoff";
  // A handoff older than this is not started: the panel that should have taken it never came.
  const HANDOFF_MS = 2 * 60000;

  function escape(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 3)}...` : text);
  const tidy = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, LIMIT);

  /**
   * Earlier requests that fit what is typed, newest first: every typed word
   * appears in the request. Nothing typed matches every request. The typed
   * text itself and repeats are left out.
   */
  function recentMatches(text, history, max) {
    const typed = tidy(text).toLowerCase();
    const words = typed.split(" ").filter(Boolean);
    const seen = new Set([typed]);
    const out = [];
    for (const item of history || []) {
      const task = tidy(item && typeof item === "object" ? item.task : item);
      const key = task.toLowerCase();
      if (!task || seen.has(key)) continue;
      if (words.length && !words.every((w) => key.includes(w))) continue;
      seen.add(key);
      out.push(task);
      if (out.length >= (max || RECENT_SHOWN)) break;
    }
    return out;
  }

  /**
   * What the address bar shows while the user types: the default row (what
   * Enter does) and the rows under it, earlier requests that fit.
   * @param text    what is typed after the keyword
   * @param history the run history, newest first: [{task}] or strings
   * @param opts    {agentOn}
   * @returns {defaultDescription, suggestions: [{content, description}]}
   */
  function suggestionsFor(text, history, opts) {
    const o = opts || {};
    if (o.agentOn === false) return { defaultDescription: "Set up the agent to start it from the address bar", suggestions: [] };
    const trimmed = tidy(text);
    const rows = recentMatches(trimmed, history, RECENT_SHOWN).map((task) => ({ content: task, description: `${escape(clip(task, 80))} <dim>· asked before</dim>` }));
    if (!trimmed) return { defaultDescription: "Ask Select to AI to find, compare, fill in or book anything", suggestions: rows };
    return { defaultDescription: `Ask Select to AI: <match>${escape(clip(trimmed, 60))}</match>`, suggestions: rows };
  }

  /**
   * What Enter does with the text: {kind: "agent", task, workIn} starts a
   * run. workIn is "current" (the tab the user typed in), "newForeground"
   * or "newBackground" (a new tab, from Alt+Enter or a middle click on a
   * row). null for nothing typed.
   */
  function planEntry(text, disposition) {
    const task = tidy(text);
    if (!task) return null;
    const workIn = disposition === "newForegroundTab" ? "newForeground" : disposition === "newBackgroundTab" ? "newBackground" : "current";
    return { kind: "agent", task, workIn };
  }

  /** The panel page that takes a handoff, for the tab the run works in. */
  function handoffPath(id, tabId) {
    return `agent.html?handoff=${encodeURIComponent(id)}${tabId !== null && tabId !== undefined ? `&tabId=${tabId}` : ""}`;
  }

  const newId = () => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /**
   * Starts a run from the address bar.
   *
   * chrome.sidePanel.open needs a user gesture. Since Chrome 131 an
   * omnibox Enter counts as one (crbug.com/325442903); before that, and
   * whenever the gesture has been spent by waiting on something first, the
   * call is refused. So the panel is asked for first, in the same turn as
   * the event, with the window id already known, and only then is anything
   * awaited. If the panel does not open, the agent opens in a tab instead.
   *
   * @param api   the chrome API (sidePanel, tabs, storage, runtime)
   * @param plan  from planEntry
   * @param where {windowId, tabId}: the window typed in and its active tab, known before Enter
   * @returns Promise<{opened: "panel"|"tab", id, tabId}>
   */
  function startRun(api, plan, where) {
    const w = where || {};
    const windowId = Number.isInteger(w.windowId) && w.windowId >= 0 ? w.windowId : null;
    let opening = null;
    if (windowId !== null && api.sidePanel && typeof api.sidePanel.open === "function") {
      try { opening = Promise.resolve(api.sidePanel.open({ windowId })); } catch (e) { opening = Promise.reject(e); }
    }
    if (opening) opening.catch(() => {});
    const id = newId();
    return (async () => {
      // The tab the run works in: the one typed in, or a new one at the
      // new-tab page, which the run then uses as its start.
      let tabId = Number.isInteger(w.tabId) ? w.tabId : null;
      if (plan.workIn !== "current") {
        const made = await api.tabs.create({ ...(windowId !== null ? { windowId } : {}), active: plan.workIn === "newForeground" }).catch(() => null);
        if (made && Number.isInteger(made.id)) tabId = made.id;
      }
      await api.storage.session.set({ [HANDOFF_KEY]: { id, task: plan.task, tabId, at: Date.now() } });
      const url = api.runtime.getURL(handoffPath(id, tabId));
      const panel = opening ? await opening.then(() => true, () => false) : false;
      if (panel) {
        await api.storage.local.set({ sidePanelState: { url, selectedText: "", autoSend: false, timestamp: Date.now() } });
        return { opened: "panel", id, tabId };
      }
      await api.tabs.create({ url, active: true, ...(windowId !== null ? { windowId } : {}) });
      return { opened: "tab", id, tabId };
    })();
  }

  /**
   * The panel's side: the request handed to this page, taken once. Returns
   * the task, or "" when there is none for this id (already taken, too old,
   * or another page's).
   */
  async function takeHandoff(storage, id, now) {
    if (!id) return "";
    const got = (await storage.get(HANDOFF_KEY)) || {};
    const h = got[HANDOFF_KEY];
    if (!h || h.id !== id) return "";
    await storage.remove(HANDOFF_KEY);
    if (!((now || Date.now()) - (h.at || 0) <= HANDOFF_MS)) return "";
    return tidy(h.task);
  }

  const api = Object.freeze({ LIMIT, HANDOFF_KEY, HANDOFF_MS, escape, recentMatches, suggestionsFor, planEntry, handoffPath, startRun, takeHandoff });
  root.SELECT_TO_AI_OMNIBOX = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
