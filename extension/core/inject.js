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
  // about its requests and dialogs with is made by the content script,
  // anew for each page, and comes to the engine with the listing. This is
  // the shape a name must have to be used.
  const NET_EVENT = /^n[0-9a-f]{12,40}$/;

  /**
   * Runs in the page's own world, where the page's fetch, XMLHttpRequest
   * and dialogs live. A build without the debugger has no other way to see
   * either.
   *
   * Requests (o.net): it says when each call begins and when it ends, so
   * the wait after an action can tell a page that is still waiting for an
   * answer from one that has nothing more to do. Only that a call began or
   * ended, its kind and its address are said; nothing of what was sent or
   * came back is read, and each call goes to the page's own function
   * unchanged.
   *
   * Dialogs (o.dialogs): a browser alert, confirm or prompt stops the page
   * until someone closes it, and the extension cannot see or close one, so
   * a step that set one off waited on the page for the rest of the run
   * (seen 17 Nov 2026: 1021 s, stopped after two steps). Each is said
   * first, with its words. While the agent is working
   * on the page the content script answers that it has it (the event is
   * cancelled), and the page is given what closing the dialog gives: OK
   * for an alert, Cancel for a confirm or a prompt. Otherwise the page's
   * own dialog opens as before, so the user's own use of the page is not
   * changed. The check before leaving a page (beforeunload) is never
   * touched: it guards what the user typed and has not saved, and only the
   * user decides to drop that. A step it holds up ends at the bound on
   * every wait (ask), and the agent is told the page may be holding it.
   *
   * Nothing is left on the window to say it ran: the content script knows
   * from its "hello", and the engine does not send a part to a page that
   * has said it has it. It is sent to the page as its source, so it uses
   * nothing from this file.
   */
  function pageShim(name, o) {
    const w = window;
    const want = o || { net: true, dialogs: true };
    // True when the content script took the event: the agent has the page.
    const say = (d) => { try { return !document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(d), cancelable: true })); } catch (_e) { return false; } };
    if (want.net) {
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
    }
    if (want.dialogs) {
      const closed = { alert: undefined, confirm: false, prompt: null };
      for (const kind of ["alert", "confirm", "prompt"]) {
        const own = w[kind];
        if (typeof own !== "function") continue;
        w[kind] = function dialog(message) {
          if (say({ t: "dialog", kind, text: String(message === undefined ? "" : message).slice(0, 300) })) return closed[kind];
          return own.apply(this, arguments);
        };
      }
    }
    say({ t: "hello", net: !!want.net, dialogs: !!want.dialogs });
    return true;
  }

  /**
   * A message to a page's content script, waited on for at most `ms`.
   * A page held by a browser dialog, or busy in a script that never ends,
   * runs no script at all, the extension's included, so its answer can
   * never come; the wait for it is bounded like every other. Resolves with
   * { reply } (null when the page could not be reached), or { late: true }
   * when the page did not answer in time.
   */
  function ask(chrome, tabId, message, opts, ms) {
    let timer = null;
    const sent = Promise.resolve().then(() => chrome.tabs.sendMessage(tabId, message, opts)).then((reply) => ({ reply: reply === undefined ? null : reply }), () => ({ reply: null }));
    return Promise.race([sent, new Promise((resolve) => { timer = setTimeout(() => resolve({ reply: null, late: true }), ms); })]).finally(() => clearTimeout(timer));
  }

  // netShim is the older name, kept for what still calls it that.
  const api = Object.freeze({ IDLE_WAIT_MS, INJECT_MS, NET_EVENT, inject, injectNow, ask, pageShim, netShim: pageShim });
  root.SELECT_TO_AI_INJECT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
