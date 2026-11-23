"use strict";
// The service worker's agent code (engine.js and what it imports) run in a
// node vm with a chrome made of stand-ins. Listeners are kept so a test can
// fire them, and the calls that matter to a test are counted: notices,
// messages to tabs, badges, alarms and what is kept in session storage.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "../../extension");
const FILES = [
  "config.js", "defaults.js", "security.js", "core/grants.js", "publicSuffixes.js", "agentTools.js", "agentPrompt.js",
  "usageLimits.js", "pageSearch.js", "core/step.js", "core/observe.js", "core/memory.js", "core/context.js", "core/policy.js", "core/run.js",
  "core/llm.js", "core/learn.js", "core/view.js", "core/inject.js", "pdfText.js", "setup.js", "engine.js",
];

/**
 * @param {object} o
 *   saved          what chrome.storage.session holds when the worker starts
 *   notifications  whether the user granted notifications
 *   restoreDelayMs how long reading session storage takes (a cold worker)
 *   onTabMessage   (tabId, message, frameId) => reply, for chrome.tabs.sendMessage
 *   granted        origins granted, as "https://site.example" (the returned `granted` set may be added to)
 *   injectFails    chrome.scripting.executeScript rejects (no access to the page)
 *   tabs           {id: tab} the tabs that exist
 *   local, sync    what chrome.storage.local and .sync hold (a test may change them later)
 *   fetch          the worker's fetch, for a test that plays a provider's replies
 *   executeScript  (req) => what chrome.scripting.executeScript gives, in place of the default
 *   timerScale     how much shorter the worker's timers run (10 runs a 25 s wait in 2.5 s)
 */
function fakeWorker(o = {}) {
  const listeners = {};
  const calls = { notices: [], cleared: [], tabMessages: [], badges: [], alarms: [], localSets: [], executes: 0, scripts: [] };
  const session = { ...(o.saved || {}) };
  const local = { ...(o.local || {}) };
  const sync = { ...(o.sync || {}) };
  const event = (name) => ({
    addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    removeListener: (fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); },
    hasListener: () => false,
  });
  const anything = () => new Proxy(function stub() { return Promise.resolve(undefined); }, {
    get: (t, k) => (k === "then" ? undefined : typeof k === "string" && k.startsWith("on") ? event(k) : anything()),
    apply: () => Promise.resolve(undefined),
  });
  const later = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabs = o.tabs || { 9: { id: 9, url: "https://shop.example/account", title: "Account", windowId: 1, active: true } };
  const granted = new Set(o.granted || []);
  const chrome = new Proxy({
    runtime: { id: "x", getURL: (p) => `chrome-extension://x/${p || ""}`, onMessage: event("runtime.onMessage"), onConnect: event("runtime.onConnect"), sendMessage: () => Promise.resolve(), getContexts: async () => [] },
    tabs: new Proxy({
      get: async (id) => { if (!tabs[id]) throw new Error("No tab"); return tabs[id]; },
      query: async () => Object.values(tabs),
      update: async (id) => tabs[id],
      create: async (opts) => { const id = 500 + Object.keys(tabs).length; tabs[id] = { id, url: (opts && opts.url) || "about:blank", windowId: 1 }; return tabs[id]; },
      sendMessage: async (tabId, message, opts) => {
        calls.tabMessages.push({ tabId, message, frameId: (opts && opts.frameId) || 0 });
        return o.onTabMessage ? o.onTabMessage(tabId, message, (opts && opts.frameId) || 0) : undefined;
      },
      onRemoved: event("tabs.onRemoved"), onUpdated: event("tabs.onUpdated"), onActivated: event("tabs.onActivated"),
    }, { get: (t, k) => (k in t ? t[k] : typeof k === "string" && k.startsWith("on") ? event(`tabs.${k}`) : anything()) }),
    windows: new Proxy({ getLastFocused: async () => ({ id: 1, focused: false }), update: async () => ({}), getAll: async () => [{ id: 1 }] }, { get: (t, k) => (k in t ? t[k] : anything()) }),
    scripting: { executeScript: async (req) => { calls.executes += 1; calls.scripts.push(req); if (o.injectFails) throw new Error("Cannot access contents of the page."); return o.executeScript ? o.executeScript(req) : [{ result: "" }]; } },
    permissions: {
      contains: async (q) => (q.permissions || []).every((p) => p !== "notifications" || !!o.notifications) && (q.origins || []).every((x) => granted.has(String(x).replace(/\/\*$/, ""))),
      request: async () => false,
      onAdded: event("permissions.onAdded"), onRemoved: event("permissions.onRemoved"),
    },
    action: {
      setBadgeText: async (d) => { calls.badges.push(d); },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    },
    alarms: {
      create: async (name, info) => { calls.alarms.push({ name, info }); },
      clear: async () => true,
      onAlarm: event("alarms.onAlarm"),
    },
    idle: { queryState: async () => "active", onStateChanged: event("idle.onStateChanged") },
    storage: {
      session: {
        get: async (keys) => {
          if (o.restoreDelayMs) await later(o.restoreDelayMs);
          if (keys === null || keys === undefined) return { ...session };
          const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
          return Object.fromEntries(list.filter((k) => k in session).map((k) => [k, session[k]]));
        },
        set: async (items) => { Object.assign(session, JSON.parse(JSON.stringify(items))); },
        remove: async (k) => { for (const key of [].concat(k)) delete session[key]; },
      },
      local: { get: async () => ({ ...local }), set: async (items) => { calls.localSets.push(items); Object.assign(local, JSON.parse(JSON.stringify(items))); }, remove: async (k) => { for (const key of [].concat(k)) delete local[key]; } },
      sync: { get: async () => ({ ...sync }), set: async (items) => { Object.assign(sync, JSON.parse(JSON.stringify(items))); } },
      onChanged: event("storage.onChanged"),
    },
    ...(o.notifications ? {
      notifications: {
        create: (id, options) => { calls.notices.push(typeof id === "string" ? { id, ...options } : id); return Promise.resolve(typeof id === "string" ? id : "n"); },
        clear: (id) => { calls.cleared.push(id); return Promise.resolve(true); },
        onClicked: event("notifications.onClicked"), onButtonClicked: event("notifications.onButtonClicked"),
      },
    } : {}),
  }, { get: (t, k) => (k in t ? t[k] : k === "notifications" || k === "debugger" ? undefined : anything()) });

  const timer = (fn, ms) => { const t = setTimeout(fn, (ms || 0) / (o.timerScale || 1)); t.unref(); return t; };
  const root = { chrome, console, setTimeout: timer, clearTimeout, setInterval: () => 0, clearInterval: () => {}, URL, URLSearchParams, Promise, AbortController, TextEncoder, TextDecoder, DecompressionStream: globalThis.DecompressionStream, crypto: globalThis.crypto, fetch: o.fetch || (async () => { throw new Error("no network in tests"); }) };
  root.globalThis = root;
  root.self = root;
  vm.createContext(root);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), root, { filename: f });

  const fire = (name, ...args) => Promise.all((listeners[name] || []).map((fn) => fn(...args)));

  /** The agent's page connecting, as agent.js does: hello, then whatever it queued. */
  function connect(windowId) {
    const posted = [];
    const on = [];
    const port = {
      name: "agentView", sender: { id: "x", url: "chrome-extension://x/agent.html" },
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (fn) => on.push(fn) }, onDisconnect: { addListener: () => {} },
      disconnect: () => {},
    };
    for (const fn of listeners["runtime.onConnect"] || []) fn(port);
    // Sent the way Chrome delivers them: one after another, nobody waiting.
    const post = (m) => Promise.all(on.map((fn) => fn(m)));
    return { posted, post, hello: () => post({ type: "hello", windowId }) };
  }

  return { root, engine: root.SELECT_TO_AI_ENGINE, RUN: root.SELECT_TO_AI_RUN, calls, listeners, fire, connect, session, tabs, local, sync, granted };
}

/** Lets queued promises and short timers run. */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

module.exports = { fakeWorker, settle };
