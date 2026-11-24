/**
 * Select to AI - optional permissions in one place.
 *
 * 4.0 updates a 2.0 install without a new permission prompt, so everything
 * new is optional: desktop notifications, Claude, perplexity.ai without www,
 * provider API hosts, local servers and the sites the agent works on. An
 * optional API is undefined until it is granted, and touching it then throws.
 * Every caller goes through these helpers instead, and they never throw:
 * each one resolves to a plain answer (null, false, an empty list) when the
 * API or the grant is missing.
 *
 * Loaded by the service worker (importScripts), by extension pages (script
 * tag) and by Node tests (require). Pass a chrome stand-in to create() in
 * tests; the default export uses the real one.
 */
(function initGrants(root) {
  "use strict";

  // Assistants whose hosts are optional in 4.0. Their content script is
  // registered at run time once the user grants the host.
  const ASSISTANT_HOSTS = Object.freeze({
    claude: "https://claude.ai/*",
    perplexityApex: "https://perplexity.ai/*",
  });
  const ASSISTANT_SCRIPT_ID = "select-to-ai-assistants";
  const ASSISTANT_SCRIPT_FILES = Object.freeze(["config.js", "contentScript.js"]);

  // Shown when a tab has no usable icon: a plain globe, so no site is asked.
  const GENERIC_ICON = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#8a8b8f" stroke-width="1.2">'
    + '<circle cx="8" cy="8" r="6.4"/><ellipse cx="8" cy="8" rx="2.8" ry="6.4"/><path d="M1.6 8h12.8M2.6 4.8h10.8M2.6 11.2h10.8"/></svg>',
  );

  /**
   * The match pattern for exactly one origin, from an origin, a URL or a
   * pattern: "https://api.openai.com/v1/chat" -> "https://api.openai.com/*".
   * Ports are kept. Anything else (wildcards, other schemes, junk) is null.
   */
  function originPattern(input) {
    let text = String(input || "").trim();
    if (!text) return null;
    if (text.endsWith("/*")) text = text.slice(0, -1);
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname || url.hostname.includes("*") || url.username || url.password) return null;
    return `${url.protocol}//${url.host}/*`;
  }

  function patternsOf(input) {
    const list = Array.isArray(input) ? input : [input];
    const out = [];
    for (const item of list) {
      const p = originPattern(item);
      if (!p) return null;
      if (!out.includes(p)) out.push(p);
    }
    return out.length ? out : null;
  }

  function create(chromeApi) {
    const api = () => chromeApi || (typeof chrome !== "undefined" ? chrome : undefined);
    const notifications = () => { const c = api(); return c && c.notifications; };
    const permissions = () => { const c = api(); return c && c.permissions; };
    const scripting = () => { const c = api(); return c && c.scripting; };
    const lastError = () => { const c = api(); return c && c.runtime && c.runtime.lastError; };

    // Calls an extension API that takes a callback and resolves with its
    // value, or with `fallback` on lastError or a throw.
    const call = (fn, args, fallback) => new Promise((resolve) => {
      try {
        const maybe = fn(...args, (value) => { resolve(lastError() ? fallback : value); });
        if (maybe && typeof maybe.then === "function") maybe.then(resolve, () => resolve(fallback));
      } catch {
        resolve(fallback);
      }
    });

    /**
     * Shows a desktop notification if the user granted notifications.
     * notify(options) or notify(id, options). Resolves to the notification
     * id, or null when notifications are not granted or Chrome refused.
     */
    function notify(idOrOptions, maybeOptions) {
      const n = notifications();
      if (!n || typeof n.create !== "function") return Promise.resolve(null);
      const hasId = typeof idOrOptions === "string";
      const options = { type: "basic", iconUrl: "icon128.png", title: "Select to AI", message: "", ...((hasId ? maybeOptions : idOrOptions) || {}) };
      const args = hasId ? [idOrOptions, options] : [options];
      return call(n.create.bind(n), args, null).then((id) => (id === undefined ? null : id));
    }

    /** Clears a notification. Resolves true if one was cleared. */
    function clearNotice(id) {
      const n = notifications();
      if (!n || typeof n.clear !== "function" || !id) return Promise.resolve(false);
      return call(n.clear.bind(n), [String(id)], false).then((v) => v === true);
    }

    // Handlers waiting for clicks, and whether they are attached to the
    // notifications API yet.
    const clickHandlers = [];
    let attached = false;
    let watching = false;
    const dispatch = (id, buttonIndex) => {
      for (const h of clickHandlers) {
        try { h(id, buttonIndex); } catch { /* one handler never stops the others */ }
      }
    };
    const attach = () => {
      const n = notifications();
      if (attached || !n || !n.onClicked || !n.onButtonClicked) return false;
      n.onClicked.addListener((id) => dispatch(id, null));
      n.onButtonClicked.addListener((id, index) => dispatch(id, index));
      attached = true;
      return true;
    };

    /**
     * Calls handler(id, buttonIndex) when a notification or one of its
     * buttons is clicked (buttonIndex null for the body). Call it at the top
     * level of the worker: when notifications are granted it attaches at
     * once, so a click wakes the worker; when they are not, it attaches as
     * soon as the user grants them. Adding the same handler twice is a no-op.
     * Returns whether the listeners are attached now.
     */
    function onNoticeClicked(handler) {
      if (typeof handler === "function" && !clickHandlers.includes(handler)) clickHandlers.push(handler);
      if (attach()) return true;
      const p = permissions();
      if (!watching && p && p.onAdded && typeof p.onAdded.addListener === "function") {
        watching = true;
        try {
          p.onAdded.addListener((added) => {
            if (added && (added.permissions || []).includes("notifications")) attach();
          });
        } catch { /* nothing to watch */ }
      }
      return false;
    }

    /** Whether the host of this origin or URL is granted (required or optional). */
    function hasHost(originOrUrl) {
      const p = permissions();
      const origins = patternsOf(originOrUrl);
      if (!p || typeof p.contains !== "function" || !origins) return Promise.resolve(false);
      return call(p.contains.bind(p), [{ origins }], false).then((v) => v === true);
    }

    /**
     * Asks the user for exactly the given origin(s), as "<origin>/*". Call it
     * straight from the click that needs it: Chrome only shows the prompt
     * inside a user gesture, so nothing is awaited before the request.
     * Resolves true if granted.
     */
    function requestHost(originOrUrl) {
      const p = permissions();
      const origins = patternsOf(originOrUrl);
      if (!p || typeof p.request !== "function" || !origins) return Promise.resolve(false);
      return call(p.request.bind(p), [{ origins }], false).then((v) => v === true);
    }

    /** Whether notifications are granted. */
    function hasNotifications() {
      const p = permissions();
      if (!p || typeof p.contains !== "function") return Promise.resolve(false);
      return call(p.contains.bind(p), [{ permissions: ["notifications"] }], false).then((v) => v === true);
    }

    /** Asks for notifications, from a user gesture. Resolves true if granted. */
    function requestNotifications() {
      const p = permissions();
      if (!p || typeof p.request !== "function") return Promise.resolve(false);
      return call(p.request.bind(p), [{ permissions: ["notifications"] }], false).then((v) => v === true);
    }

    // One registration at a time, so two calls never race to register the
    // same script id.
    let chain = Promise.resolve();

    /**
     * Makes the assistant content script run on the optional assistant hosts
     * the user granted (Claude, perplexity.ai without www), and on none of
     * the others. Safe to call any number of times: it keeps exactly one
     * registration, updated in place. Call it at worker start and after a
     * grant or removal. Resolves to the match patterns now registered.
     */
    function registerAssistantScripts() {
      const run = chain.then(async () => {
        const s = scripting();
        if (!s || typeof s.getRegisteredContentScripts !== "function") return [];
        const matches = [];
        for (const pattern of Object.values(ASSISTANT_HOSTS)) {
          if (await hasHost(pattern)) matches.push(pattern);
        }
        const existing = await call(s.getRegisteredContentScripts.bind(s), [{ ids: [ASSISTANT_SCRIPT_ID] }], []);
        const registered = Array.isArray(existing) && existing.some((x) => x && x.id === ASSISTANT_SCRIPT_ID);
        if (!matches.length) {
          if (registered) await call(s.unregisterContentScripts.bind(s), [{ ids: [ASSISTANT_SCRIPT_ID] }], undefined);
          return [];
        }
        const script = {
          id: ASSISTANT_SCRIPT_ID,
          matches,
          js: [...ASSISTANT_SCRIPT_FILES],
          allFrames: true,
          persistAcrossSessions: true,
          runAt: "document_idle",
        };
        if (registered) await call(s.updateContentScripts.bind(s), [[script]], undefined);
        else await call(s.registerContentScripts.bind(s), [[script]], undefined);
        return matches;
      });
      chain = run.catch(() => []);
      return chain;
    }

    /**
     * An icon for a tab or URL without the favicon permission: the tab's own
     * favIconUrl when it is a web or data image, else a generic globe. For a
     * URL, pass the open tabs to use the icon of a tab on the same origin.
     */
    function faviconFor(tabOrUrl, tabs) {
      const usable = (src) => typeof src === "string" && /^(https?:|data:image\/)/i.test(src);
      if (tabOrUrl && typeof tabOrUrl === "object") return usable(tabOrUrl.favIconUrl) ? tabOrUrl.favIconUrl : GENERIC_ICON;
      const pattern = originPattern(tabOrUrl);
      if (pattern && Array.isArray(tabs)) {
        const same = tabs.find((t) => t && usable(t.favIconUrl) && originPattern(t.url) === pattern);
        if (same) return same.favIconUrl;
      }
      return GENERIC_ICON;
    }

    return Object.freeze({
      notify, clearNotice, onNoticeClicked, hasNotifications, requestNotifications,
      hasHost, requestHost, registerAssistantScripts, faviconFor,
    });
  }

  const api = Object.freeze({
    ...create(),
    create, originPattern, ASSISTANT_HOSTS, ASSISTANT_SCRIPT_ID, GENERIC_ICON,
  });
  root.SELECT_TO_AI_GRANTS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
