/**
 * Select to AI - which tab the user sees while a run works.
 *
 * What was measured (Chrome, a tab behind another in the same window, both
 * headless and in a window on screen): the page is not drawn there. Its
 * animation frames do not run, CSS transitions stand still and never end,
 * so a menu, a dialog or a date picker that animates open does not finish
 * opening. Everything else works: the page can be read, the browser's own
 * pointer and keys (through the debugger connection) reach it, and the
 * debugger connection pictures it where it is.
 *
 * So reading never needs a tab in front, and a tab is brought to front only
 * for an action on its page, and only when the user is following the run:
 * their window shows the agent's own page that started the run, or a tab
 * the run works in. A user who went to a tab of their own is left there.
 *
 * When the run ends, or stops to wait for something the user answers on
 * the agent's page, a user the agent brought to a page is taken back to
 * the agent's page; one who used that page themselves (clicked, typed or
 * scrolled on it) is left where they are.
 *
 * Pure functions.
 */
(function initView(root) {
  "use strict";

  // Actions that work the page itself, where what the page draws in
  // answer (a menu opening, a list of suggestions) is part of the result.
  const PAGE_ACTIONS = Object.freeze(new Set(["click", "click_at", "hover", "drag", "fill", "fill_details", "press", "scroll"]));
  // Waits the user meets on the page itself, where a banner asks them.
  const ON_PAGE_WAITS = Object.freeze(new Set(["sign_in", "human_check", "code", "payment", "press"]));

  const has = (list, id) => id !== null && id !== undefined && (list || []).includes(id);

  /** Whether an action works the page, so the page must be drawn for it. */
  const needsFront = (action) => !!action && PAGE_ACTIONS.has(action.do);

  /**
   * Whether the user is following the run in this window: what is in front
   * is the agent's page that started it, or a tab the run works or worked in.
   * @param v {front, home, tabs}
   */
  const following = (v) => !!v && v.front !== null && v.front !== undefined && (v.front === v.home || has(v.tabs, v.front));

  /**
   * Whether the run's tab is brought to front before this action.
   * @param v {action, background, tabId, front, home, tabs}
   *   background: a sub-task, which never takes the user's tab.
   */
  function bringToFront(v) {
    if (!v || v.background || !needsFront(v.action)) return false;
    if (v.tabId === null || v.tabId === undefined || v.front === v.tabId) return false;
    return following(v);
  }

  /**
   * How a tab the page opened during an action is left: it stays in front
   * only if the user was following the run. Returns the tab to put back in
   * front, or null.
   * @param v {before, after, home, tabs} before/after: the window's front tab around the action
   */
  function restoreAfterOpen(v) {
    if (!v || v.before === null || v.before === undefined || v.after === v.before) return null;
    return following({ front: v.before, home: v.home, tabs: v.tabs }) ? null : v.before;
  }

  /**
   * What happens to the user's view when the run ends or waits.
   * @param v {home, front, tabs, touched, wait}
   *   home: the agent page's tab that drives the run, or null (side panel)
   *   front: the tab in front in the working tab's window
   *   tabs: the tabs the run works or worked in
   *   touched: the user clicked, typed or scrolled on the page in front
   *   wait: the wait's kind, or "" when the run ended
   * @returns {focus: "home"|null, bar: "remove"|"keep"|"outcome"}
   *   bar "keep": the bar stays, saying what the run waits for;
   *   "outcome": it stays, saying how the run ended, with a way back.
   */
  function onSettle(v) {
    const none = { focus: null, bar: "remove" };
    if (!v || v.home === null || v.home === undefined) return none;
    // A pause for the provider ends by itself: nothing changes.
    if (v.wait === "pause") return { focus: null, bar: "keep" };
    const onRunTab = v.front !== v.home && has(v.tabs, v.front);
    // Something only the user can do on that page: they are where it is asked.
    if (v.wait && ON_PAGE_WAITS.has(v.wait)) return onRunTab ? { focus: null, bar: "keep" } : none;
    if (!onRunTab) return none;
    if (v.touched) return { focus: null, bar: v.wait ? "keep" : "outcome" };
    return { focus: "home", bar: "remove" };
  }

  /**
   * Whether the agent's bar is on a tab: the run is driven from the agent's
   * page, the tab is the run's own working tab and in front, and the run is
   * live or ended with the user left on that tab.
   * @param v {home, tabId, front, live, kept}
   */
  const showBar = (v) => !!v && v.home !== null && v.home !== undefined && v.tabId !== null && v.tabId !== undefined
    && v.front === v.tabId && v.tabId !== v.home && (!!v.live || !!v.kept);

  // What the bar says while the run waits, in the agent page's words.
  const WAIT_WORDS = Object.freeze({
    approval: "Waiting for your go-ahead", sign_in: "Waiting for you to sign in", human_check: "Waiting for you to pass a check",
    code: "Waiting for a code from you", payment: "Waiting for you to pay", press: "Waiting for you to press a button", site_access: "Waiting for access to this site",
    question: "Waiting for your answer", check_in: "Waiting for you: keep going?", pause: "Paused by the provider",
  });
  const HELD_WORDS = Object.freeze({ timed: "On hold until the provider takes requests again", open: "On hold: waiting for you" });
  const ENDED = Object.freeze({
    success: { state: "done", text: "Done. The answer is on the agent page." },
    unconfirmed: { state: "done", text: "Done, not confirmed. The answer is on the agent page." },
    error: { state: "failed", text: "Could not finish. The agent page says why." },
    limit: { state: "failed", text: "Usage limit reached." },
    idle: { state: "stopped", text: "Stopped." },
  });

  /**
   * What the bar shows for a run: {state, text}. state is working, needs,
   * done, failed or stopped, each drawn with its own colour and words.
   * @param run {status, wait, outcome, current, journal}
   */
  function barLine(run) {
    if (!run) return { state: "stopped", text: "" };
    if (run.outcome) return ENDED[run.outcome.state] || { state: "stopped", text: "Stopped." };
    if (run.status === "waiting") {
      const kind = run.wait && run.wait.kind;
      // A held run is not paused for a moment: it waits for the reset, or for the user.
      if (kind === "pause" && run.wait.hold) return run.wait.until ? { state: "working", text: HELD_WORDS.timed } : { state: "needs", text: HELD_WORDS.open };
      return { state: kind === "pause" ? "working" : "needs", text: WAIT_WORDS[kind] || "Waiting for you" };
    }
    const goal = run.current && String(run.current.goal || "").trim();
    if (goal) return { state: "working", text: goal };
    const journal = run.journal || [];
    for (let i = journal.length - 1; i >= 0; i--) if (journal[i].k === "status" && journal[i].text) return { state: "working", text: String(journal[i].text) };
    return { state: "working", text: "Starting" };
  }

  const api = Object.freeze({ PAGE_ACTIONS, ON_PAGE_WAITS, needsFront, following, bringToFront, restoreAfterOpen, onSettle, showBar, barLine, WAIT_WORDS });
  root.SELECT_TO_AI_VIEW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
