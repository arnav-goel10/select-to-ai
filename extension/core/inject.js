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

  /**
   * Runs a script in a page at once, without the usual wait for the page to
   * be read whole: for a script that needs nothing from the page. Resolves
   * with what the browser answers, or null when the page does not take it
   * within INJECT_MS or cannot be reached.
   */
  function injectNow(chrome, target, what, o) {
    const injectMs = (o && o.injectMs) || INJECT_MS;
    let timer = null;
    const sent = Promise.resolve().then(() => chrome.scripting.executeScript({ target, injectImmediately: true, ...what })).catch(() => null);
    return Promise.race([sent, new Promise((resolve) => { timer = setTimeout(() => resolve(null), injectMs); })]).finally(() => clearTimeout(timer));
  }

  // The name of the event the page's own world tells the content script
  // about its requests with is made by the content script, anew for each
  // page, and comes to the engine with the listing. This is the shape a
  // name must have to be used.
  const NET_EVENT = /^n[0-9a-f]{12,40}$/;

  /**
   * Runs in the page's own world, where the page's fetch and XMLHttpRequest
   * live. It says when each call begins and when it ends, so the wait after
   * an action can tell a page that is still waiting for an answer from one
   * that has nothing more to do. A build without the debugger has no other
   * way to know. Only that a call began or ended, its kind and its address
   * are said; nothing of what was sent or came back is read, and each call
   * goes to the page's own function unchanged. Nothing is left on the
   * window to say it ran: the content script knows from its "hello", and
   * the engine does not send it to a page that has said so.
   *
   * It is sent to the page as its source, so it uses nothing from this file.
   */
  function netShim(name) {
    const w = window;
    const say = (d) => { try { document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(d) })); } catch (_e) { /* the page goes on regardless */ } };
    let count = 0;
    const begin = (kind, url) => { const id = `${kind}${++count}`; say({ t: "start", id, kind, url: String(url || "").slice(0, 300) }); return id; };
    const end = (id) => say({ t: "end", id });
    const pageFetch = w.fetch;
    if (typeof pageFetch === "function") {
      w.fetch = function fetch(input) {
        const id = begin("Fetch", input && typeof input === "object" && "url" in input ? input.url : input);
        let answer;
        try { answer = pageFetch.apply(this, arguments); } catch (e) { end(id); throw e; }
        if (answer && typeof answer.then === "function") answer.then(() => end(id), () => end(id));
        else end(id);
        return answer;
      };
    }
    const proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (proto && typeof proto.open === "function" && typeof proto.send === "function") {
      const pageOpen = proto.open;
      const pageSend = proto.send;
      const asked = new WeakMap();
      proto.open = function open(_method, url) { asked.set(this, url); return pageOpen.apply(this, arguments); };
      proto.send = function send() {
        const id = begin("XHR", asked.get(this));
        try { this.addEventListener("loadend", () => end(id), { once: true }); } catch (_e) { /* ended below if it throws */ }
        try { return pageSend.apply(this, arguments); } catch (e) { end(id); throw e; }
      };
    }
    say({ t: "hello" });
    return true;
  }

  const api = Object.freeze({ IDLE_WAIT_MS, INJECT_MS, NET_EVENT, inject, injectNow, netShim });
  root.SELECT_TO_AI_INJECT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
