"use strict";
// Test-only. Runs extension/background.js in a Node vm with a chrome
// stand-in, the way Chrome runs the classic service worker: the shared
// scripts (config, defaults, security, omnibox, grants) load for real, the
// agent's scripts are skipped (or made to throw), and every top-level
// function and binding stays reachable through run().
//
// Storage answers on a later turn of the event loop, as Chrome's does, so a
// handler that reads the cache before storage has answered can be caught.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.resolve(__dirname, "../../extension");
const AGENT_FILE = "engine.js";

const tick = () => new Promise((r) => setImmediate(r));
async function settle(times = 6) { for (let i = 0; i < times; i++) await tick(); }

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener: (fn) => listeners.includes(fn),
    fire: (...a) => listeners.slice().forEach((fn) => fn(...a)),
  };
}

function storageArea(name, onChanged, log) {
  const data = {};
  const later = (fn) => setImmediate(fn);
  const pick = (keys) => {
    if (keys == null) return { ...data };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
    return out;
  };
  const done = (value, cb) => {
    if (typeof cb === "function") { later(() => cb(value)); return undefined; }
    return new Promise((r) => later(() => r(value)));
  };
  const area = {
    data,
    get(keys, cb) { if (typeof keys === "function") { cb = keys; keys = null; } return done(pick(keys), cb); },
    set(items, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); }
      log.push({ area: name, op: "set", items: structuredClone(items) });
      later(() => onChanged.fire(changes, name));
      return done(undefined, cb);
    },
    remove(keys, cb) {
      const list = typeof keys === "string" ? [keys] : keys;
      const changes = {};
      for (const k of list) if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
      log.push({ area: name, op: "remove", keys: list.slice() });
      if (Object.keys(changes).length) later(() => onChanged.fire(changes, name));
      return done(undefined, cb);
    },
  };
  return area;
}

/**
 * Loads background.js. Options:
 *   sync, local     initial storage contents
 *   granted         origins and permissions granted (e.g. "https://claude.ai/*")
 *   agentThrows     make the agent's importScripts throw
 *   tabs            tabs chrome.tabs.query returns
 *   gesture         whether sidePanel.open succeeds (default true)
 */
function loadBackground(opts = {}) {
  const log = [];
  const calls = { sidePanelOpen: [], tabsCreate: [], sendMessage: [], menus: [], removeAll: 0, notify: [], sessionRules: [], badge: [] };
  const storageChanged = event();
  const granted = new Set(opts.granted || []);
  let nextTabId = 100;
  const menuItems = new Map();

  const chrome = {
    runtime: {
      id: "testextensionid",
      lastError: undefined,
      onInstalled: event(), onStartup: event(), onMessage: event(),
      getURL: (p) => `chrome-extension://testextensionid/${String(p).replace(/^\//, "")}`,
      getManifest: () => ({ version: "4.0.0" }),
      openOptionsPage: () => {},
    },
    storage: { onChanged: storageChanged },
    contextMenus: {
      onClicked: event(),
      removeAll(cb) { calls.removeAll += 1; menuItems.clear(); setImmediate(() => cb && cb()); },
      create(props, cb) {
        if (menuItems.has(props.id)) {
          chrome.runtime.lastError = { message: `Cannot create item with duplicate id ${props.id}` };
          try { cb && cb(); } finally { chrome.runtime.lastError = undefined; }
          return props.id;
        }
        menuItems.set(props.id, { ...props });
        calls.menus.push({ ...props });
        setImmediate(() => cb && cb());
        return props.id;
      },
    },
    permissions: {
      onAdded: event(), onRemoved: event(),
      contains(q, cb) {
        const ok = [...(q.origins || []), ...(q.permissions || [])].every((x) => granted.has(x));
        setImmediate(() => cb(ok));
      },
    },
    sidePanel: {
      open(options, cb) {
        calls.sidePanelOpen.push({ options, at: log.length });
        if (opts.gesture === false) chrome.runtime.lastError = { message: "sidePanel.open() may only be called in response to a user gesture." };
        try { cb && cb(); } finally { chrome.runtime.lastError = undefined; }
      },
    },
    tabs: {
      TAB_ID_NONE: -1,
      onUpdated: event(), onRemoved: event(), onActivated: event(),
      create(props, cb) {
        const tab = { id: nextTabId++, url: props.url, windowId: 1 };
        calls.tabsCreate.push({ ...props, id: tab.id, at: log.length });
        setImmediate(() => cb && cb(tab));
      },
      query(q, cb) { setImmediate(() => cb(opts.tabs || [])); },
      sendMessage(tabId, message, options, cb) {
        calls.sendMessage.push({ tabId, message, options });
        const reply = opts.onSendMessage ? opts.onSendMessage(tabId, message, calls.sendMessage.length) : { status: "success" };
        setImmediate(() => {
          if (reply instanceof Error) chrome.runtime.lastError = { message: reply.message };
          try { cb && cb(reply instanceof Error ? undefined : reply); } finally { chrome.runtime.lastError = undefined; }
        });
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: event(),
      getCurrent(cb) { setImmediate(() => cb({ id: 1 })); },
      getLastFocused(o, cb) { setImmediate(() => cb({ id: 1 })); },
    },
    declarativeNetRequest: {
      updateSessionRules(rules, cb) { calls.sessionRules.push(rules); setImmediate(() => cb && cb()); },
    },
    commands: { onCommand: event() },
    action: { setBadgeText(details, cb) { calls.badge.push(details.text); setImmediate(() => cb && cb()); } },
    scripting: {
      executeScript(o, cb) { setImmediate(() => cb && cb([])); },
      getRegisteredContentScripts(f, cb) { setImmediate(() => cb([])); },
      registerContentScripts(s, cb) { setImmediate(() => cb && cb()); },
      updateContentScripts(s, cb) { setImmediate(() => cb && cb()); },
      unregisterContentScripts(s, cb) { setImmediate(() => cb && cb()); },
    },
  };
  chrome.storage.sync = storageArea("sync", storageChanged, log);
  chrome.storage.local = storageArea("local", storageChanged, log);
  chrome.storage.session = storageArea("session", storageChanged, log);
  Object.assign(chrome.storage.sync.data, structuredClone(opts.sync || {}));
  Object.assign(chrome.storage.local.data, structuredClone(opts.local || {}));
  if (opts.notifications) {
    chrome.notifications = { create(o, cb) { calls.notify.push(o); setImmediate(() => cb && cb("n1")); }, clear() {}, onClicked: event(), onButtonClicked: event() };
  }

  const errors = [];
  const context = {
    chrome,
    console: { log() {}, warn() {}, info() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(" ")) },
    // Unref'd, so the worker's 30 s give-up timers do not hold the test run open.
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); if (t && t.unref) t.unref(); return t; },
    clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, fetch: () => Promise.reject(new Error("no network in tests")),
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...files) => {
    if (files.includes(AGENT_FILE)) {
      if (opts.agentThrows) throw new Error("agent script failed to load (test)");
      return; // the agent is not under test here
    }
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), context, { filename: f });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), context, { filename: "background.js" });

  const run = (code) => vm.runInContext(code, context);
  return {
    chrome, calls, log, errors, run, settle, menuItems,
    grant(origin) { granted.add(origin); chrome.permissions.onAdded.fire({ origins: [origin], permissions: [] }); },
    click(info, tab) { return run("onMenuClicked")(info, tab); },
    menuTitles() { return calls.menus.map((m) => m.title); },
    currentMenu() { return [...menuItems.values()]; },
  };
}

module.exports = { loadBackground, settle, tick, event, storageArea };
