/**
 * Select to AI - the recipes driver for the extension.
 *
 * Implements the RecipeDriver interface of packages/recipes (index.d.ts) on
 * one tab of the user's own browser: snapshots come from the shared in-page
 * script (vendor/page.js, run in the content scripts' isolated world), and
 * actions go through the agent's own content script (agentContentScript.js),
 * the same code that carries out the agent's clicks, typing and keys.
 * Navigation goes through chrome.tabs. Nothing here decides anything: it
 * reports what is on the page and does what it is told.
 *
 * Frames: the top frame only. Downloads: not reported.
 *
 * No globals beyond the chrome object it is given, so the same code runs in
 * the service worker and in tests (with a chrome stand-in over a page).
 */
(function initRecipesDriver(root) {
  "use strict";

  const INJECT = root.SELECT_TO_AI_INJECT || (typeof require === "function" ? require("../core/inject.js") : null);
  const PAGE_FILES = ["recipes/vendor/page.js"];
  const AGENT_FILES = ["agentTools.js", "agentContentScript.js"];
  const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  const ON = /^(on|true|checked|yes)$/i;
  const OFF = /^(off|false|unchecked|no)$/i;
  const firstLine = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 300);

  /* ------------------------------------------------------------ in the page */
  // Each runs in the page through chrome.scripting.executeScript({func}), so
  // each is self-contained.

  function pageSnapshot(o) {
    const S = window.__s2a;
    if (!S || S.v !== 6) return { missing: true };
    const s = S.snapshot({ texts: !!(o && o.texts) });
    if (o && o.probes && o.probes.length) {
      s.locs = {};
      for (const sel of o.probes) {
        try {
          const all = document.querySelectorAll(sel);
          const r = all.length === 1 ? S.refFor(all[0]) : null;
          s.locs[sel] = { n: all.length, refs: r ? [r] : [] };
        } catch (_) { s.locs[sel] = { n: 0, refs: [] }; }
      }
    }
    return s;
  }

  function pageDescribe(t) {
    const S = window.__s2a;
    if (!S || S.v !== 6) return { missing: true };
    let el = null;
    if (t.agentId !== undefined && t.agentId !== null) {
      const idOf = window.__selectToAiIdOf;
      const listed = window.__selectToAiListedElements;
      if (typeof idOf !== "function" || typeof listed !== "function") return { el: null, why: "the agent's content script is not on the page" };
      el = listed().find((x) => idOf(x) === Number(t.agentId)) || null;
    } else if (t.selector) {
      try { el = document.querySelector(t.selector); } catch (_) { return { el: null, why: `not a CSS selector: ${t.selector}` }; }
    }
    if (!el) return { el: null };
    return { el: S.describe(el) };
  }

  /**
   * The agent's id for the element behind a recipes ref, and what the
   * element is. For a press (`o.press`), whether something else is drawn
   * over its centre once it is on screen: a person could not press it, so
   * neither does a recipe (as Playwright's own checks refuse).
   */
  function pageAdopt(o) {
    const S = window.__s2a;
    if (!S || S.v !== 6) return { missing: true };
    const el = S.map.get(o.ref);
    if (!el || !el.isConnected) return { gone: true };
    if (typeof window.__selectToAiAdopt !== "function") return { noAgent: true };
    if (o.press) {
      try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) { /* not scrollable */ }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const root = el.getRootNode();
      const hit = r.width > 0 && r.height > 0 ? (root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y)) : null;
      const label = hit && hit.closest ? hit.closest("label") : null;
      const mine = !hit || hit === el || el.contains(hit) || (label && label.control === el);
      if (!mine) return { covered: String(hit.innerText || hit.getAttribute("aria-label") || hit.tagName).replace(/\s+/g, " ").trim().slice(0, 60) };
    }
    const role = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? String(el.type || "text").toLowerCase() : "";
    const kind = role || (type === "checkbox" || type === "radio" ? type : "");
    const checked = type === "checkbox" || type === "radio" ? !!el.checked : el.getAttribute("aria-checked") === "true";
    return { id: window.__selectToAiAdopt(el), tag, type, kind, checked };
  }

  function pageMut() {
    const S = window.__s2a;
    return S ? S.mut : -1;
  }

  /* ---------------------------------------------------------------- driver */

  /**
   * @param {object} deps
   * @param {object} deps.chrome   the extension's chrome object (or a stand-in)
   * @param {number} deps.tabId
   * @param {(ms:number)=>Promise<void>} [deps.sleep]
   * @param {object} [deps.network]  {mark(): number, since(mark): {method,url,type}[], busy(): number} for the tab, when the debugger's network view is on
   * @param {{settleQuietMs?:number, settleMaxMs?:number, loadMaxMs?:number}} [deps.opts]
   * @param {{idleMs?:number, injectMs?:number}} [deps.inject]  how long to wait on a page that has not finished loading (core/inject.js)
   */
  function createDriver(deps) {
    const chrome = deps.chrome;
    const tabId = deps.tabId;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const opts = { settleQuietMs: 200, settleMaxMs: 4000, loadMaxMs: 30000, ...(deps.opts || {}) };
    const network = deps.network || null;
    const target = { tabId, frameIds: [0] };

    // Through the engine's own way into a page (core/inject.js), so a page
    // that never finishes loading holds a replay no longer than a run.
    const into = (what) => INJECT.inject(chrome, target, what, deps.inject);
    async function run(func, args) {
      const out = await into({ func, args: args === undefined ? [] : [args] });
      return out && out[0] ? out[0].result : undefined;
    }
    const inject = (files) => into({ files });

    /** Runs func in the page with the in-page script installed; retried while the page is between documents. */
    async function inPage(func, args, tries = 25) {
      let last = null;
      for (let i = 0; i < tries; i++) {
        try {
          let r = await run(func, args);
          if (r && r.missing) { await inject(PAGE_FILES); r = await run(func, args); }
          if (r && !r.missing) return r;
          last = new Error("the page script did not start");
        } catch (e) { last = e; }
        await sleep(120);
      }
      throw new Error(`the page could not be read: ${firstLine(last)}`);
    }

    async function tab() {
      try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
    }

    /** Waits while the tab is loading a document, up to the load ceiling. */
    async function loaded(t0) {
      while (Date.now() - t0 < opts.loadMaxMs) {
        const t = await tab();
        if (!t) return false;
        if (t.status === "complete") return true;
        await sleep(100);
      }
      return false;
    }

    /** Quiet: no DOM changes (and no requests, when they are seen) for a moment. */
    async function settle(t0) {
      const start = Date.now();
      let last = null;
      let since = Date.now();
      while (Date.now() - start < opts.settleMaxMs) {
        const t = await tab();
        if (t && t.status === "loading") { await loaded(Date.now()); since = Date.now(); last = null; continue; }
        let mut = last;
        try { mut = await run(pageMut); } catch (_) { since = Date.now(); }
        if (mut !== last) { last = mut; since = Date.now(); }
        const busy = network ? network.busy() : 0;
        if (!busy && Date.now() - since >= opts.settleQuietMs) break;
        await sleep(60);
      }
      return Date.now() - t0;
    }

    const fix = (e) => {
      e.ref = `f0e${e.n}`;
      delete e.n;
      e.frame = 0;
      return e;
    };

    async function snapshot(o = {}) {
      const s = await inPage(pageSnapshot, { texts: !!o.texts, probes: o.probes || null });
      s.elements = (s.elements || []).map(fix);
      s.texts = (s.texts || []).map(fix);
      if (s.locs) for (const k of Object.keys(s.locs)) s.locs[k].refs = s.locs[k].refs.map((r) => `f0${r}`);
      if (!o.texts) delete s.texts;
      return s;
    }

    /**
     * A target as the caller recorded it: {ref} (a ref of a snapshot),
     * {agentId} (the agent's number for a control it listed), {selector}
     * or a CSS selector string.
     */
    async function locate(t) {
      if (t && typeof t === "object" && t.ref) {
        const s = await snapshot({ texts: true });
        const el = [...s.elements, ...(s.texts || [])].find((e) => e.ref === t.ref);
        return { ref: el ? t.ref : null, el: el || null, loc: null };
      }
      const what = typeof t === "string" ? { selector: t } : t || {};
      if (what.agentId === undefined && !what.selector) throw new Error("locate: pass {ref}, {agentId} or a CSS selector");
      const r = await inPage(pageDescribe, what);
      if (!r.el) return { ref: null, el: null, loc: null, why: r.why || "" };
      return { ref: `f0e${r.el.n}`, el: fix(r.el), loc: what.selector || null };
    }

    /** One message to the agent's content script, with it on the page. */
    async function agent(data) {
      await inject(AGENT_FILES);
      try {
        return await chrome.tabs.sendMessage(tabId, { action: "interact", data }, { frameId: 0 });
      } catch (e) {
        return { success: false, error: firstLine(e), lost: true };
      }
    }

    async function onRef(ref, press) {
      const m = /^f0e(\d+)$/.exec(String(ref || ""));
      if (!m) return { error: `the control ${ref} is not in the page's own frame` };
      await inject(AGENT_FILES);
      const r = await inPage(pageAdopt, { ref: `e${m[1]}`, press: !!press });
      if (r.gone) return { error: `the control ${ref} is no longer on the page` };
      if (r.covered) return { error: `something on top of it takes the click ("${r.covered}")` };
      if (r.noAgent || !r.id) return { error: "the agent's content script is not on the page" };
      return r;
    }

    /**
     * Perform one action. Never throws: failures come back as {ok:false, error}.
     * @param {{do:string, ref?:string, value?:string, key?:string, url?:string}} a
     */
    async function act(a) {
      const t0 = Date.now();
      const mark = network ? network.mark() : 0;
      const before = await tab();
      let res;
      try {
        if (a.do === "navigate") {
          await chrome.tabs.update(tabId, { url: a.url });
          await sleep(50);
          await loaded(t0);
          res = { success: true };
        } else if (a.do === "back") {
          await chrome.tabs.goBack(tabId);
          await sleep(50);
          await loaded(t0);
          res = { success: true };
        } else if (a.do === "press" && !a.ref) {
          res = await agent({ action: "keypress", text: a.key });
        } else if (["click", "hover", "fill", "press"].includes(a.do)) {
          const el = await onRef(a.ref, a.do === "click" || a.do === "hover");
          if (el.error) res = { success: false, error: el.error };
          else if (a.do === "click") res = await agent({ action: "click", id: el.id });
          else if (a.do === "hover") res = await agent({ action: "hover", id: el.id });
          else if (a.do === "press") res = await agent({ action: "keypress", id: el.id, text: a.key });
          else {
            const value = String(a.value == null ? "" : a.value);
            if (CHECKABLE.has(el.kind) && (ON.test(value) || OFF.test(value))) {
              const want = ON.test(value);
              if (el.checked === want) res = { success: true };
              else if (el.tag === "input") res = await agent({ action: "checkbox_toggle", id: el.id });
              else res = await agent({ action: "click", id: el.id });
            } else res = await agent({ action: "fill", id: el.id, value });
          }
        } else {
          return { ok: false, error: `unknown action ${a.do}` };
        }
      } catch (e) {
        res = { success: false, error: firstLine(e) };
      }
      // The page went away under the action: what a click that loads a new page looks like from here.
      if (res && res.lost) {
        const after = await tab();
        if (after && before && (after.url !== before.url || after.status === "loading")) res = { success: true };
      }
      if (res && res.success && res.opensTab) res = { success: false, error: `it opens ${res.opensTab} in a new tab, and a recipe works in one tab` };
      const settleMs = await settle(t0);
      const requests = network ? network.since(mark).filter((r) => ["XHR", "Fetch", "Document", "xhr", "fetch", "document"].includes(r.type)).map((r) => ({ method: r.method, url: r.url })) : [];
      if (!res || !res.success) return { ok: false, error: (res && res.error) || "the page did not respond", settleMs, requests, downloads: [] };
      return { ok: true, settleMs, requests, downloads: [] };
    }

    /** Re-checks on every change of the page (a short poll) until check() holds or the deadline passes. */
    async function waitForState(check, o = {}) {
      const t0 = Date.now();
      const deadlineMs = o.deadlineMs === undefined ? 5000 : o.deadlineMs;
      for (;;) {
        let snap;
        try { snap = await snapshot({ texts: !!o.texts, probes: o.probes || null }); } catch (e) {
          if (Date.now() - t0 >= deadlineMs) throw e;
          await sleep(150);
          continue;
        }
        if (check(snap)) return { held: true, snapshot: snap, elapsedMs: Date.now() - t0 };
        if (Date.now() - t0 >= deadlineMs) return { held: false, snapshot: snap, elapsedMs: Date.now() - t0 };
        await sleep(Math.min(150, Math.max(10, deadlineMs - (Date.now() - t0))));
      }
    }

    return { snapshot, locate, act, waitForState, tabId };
  }

  /**
   * What a tab asks for, seen through the debugger's network view (which the
   * agent's engine turns on for the tabs it works in). Only methods,
   * addresses and kinds are kept, never bodies.
   */
  function createNetworkView(chrome, tabId) {
    const seen = [];
    const open = new Set();
    let n = 0;
    const listen = (source, method, params) => {
      if (!source || source.tabId !== tabId || !params) return;
      if (method === "Network.requestWillBeSent" && params.request) {
        n++;
        open.add(params.requestId);
        seen.push({ n, method: String(params.request.method || "GET"), url: String(params.request.url || ""), type: String(params.type || "") });
        if (seen.length > 400) seen.shift();
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") open.delete(params.requestId);
    };
    const on = !!(chrome.debugger && chrome.debugger.onEvent);
    if (on) chrome.debugger.onEvent.addListener(listen);
    return {
      mark: () => n,
      since: (m) => seen.filter((r) => r.n > m),
      busy: () => 0,
      close: () => { if (on) chrome.debugger.onEvent.removeListener(listen); },
    };
  }

  const api = Object.freeze({ createDriver, createNetworkView, pageSnapshot, pageDescribe, pageAdopt });
  root.SELECT_TO_AI_RECIPES_DRIVER = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
