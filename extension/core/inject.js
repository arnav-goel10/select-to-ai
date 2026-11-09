/**
 * Select to AI - running the extension's scripts in a page.
 *
 * The browser holds a script back until the document has been written to
 * its end, and a document that never ends (a server still sending the page,
 * an advertising frame that keeps its connection open) holds it back for
 * ever: an agent run that waited on one stopped taking steps for the rest of
 * its time (three runs of 105 on 6 Nov 2026), and a recipe replay waited the
 * same way. So the usual wait is kept, as the page then reads whole, but
 * only for IDLE_WAIT_MS. Then the script runs on what is there now, as a
 * person reads a page that is still loading. Every script and function sent
 * this way must be safe to run twice, since the held-back call may still
 * come: the content scripts guard against a second load, and the functions
 * only read or mark the page. A frame with no document yet is not waited on
 * past INJECT_MS more; the call then throws an error with `late: true`.
 *
 * Used by the agent engine (engine.js) and the recipes driver
 * (recipes/driver.js), so the two never wait on a page differently.
 */
(function initInject(root) {
  "use strict";

  const IDLE_WAIT_MS = 2000;
  const INJECT_MS = 3000;

  /**
   * @param {object} chrome  the extension's chrome object, or a stand-in
   * @param {object} target  chrome.scripting target ({tabId, frameIds?, allFrames?})
   * @param {object} what    {files} or {func, args}
   * @param {{idleMs?:number, injectMs?:number}} [o]  waits, for tests
   */
  async function inject(chrome, target, what, o) {
    const idleMs = (o && o.idleMs) || IDLE_WAIT_MS;
    const injectMs = (o && o.injectMs) || INJECT_MS;
    const late = Symbol("late");
    let timer = null;
    const within = (p, ms) => Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve(late), ms); })]).finally(() => clearTimeout(timer));
    const whole = chrome.scripting.executeScript({ target, ...what });
    whole.catch(() => {});
    const first = await within(whole, idleMs);
    if (first !== late) return first;
    const now = await within(chrome.scripting.executeScript({ target, injectImmediately: true, ...what }), injectMs);
    if (now !== late) return now;
    throw Object.assign(new Error("The page did not take the script in time."), { late: true });
  }

  const api = Object.freeze({ IDLE_WAIT_MS, INJECT_MS, inject });
  root.SELECT_TO_AI_INJECT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
