"use strict";
// Test-only. Runs an extension page's scripts (popup, settings, welcome) in
// a Node vm against a small document stand-in and a chrome stand-in.
//
// The document knows the page's real ids: an element exists only if the
// page's HTML has that id, and starts hidden only if the HTML says so. A
// script that asks for an id the page lacks gets null, as in the browser.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { event, storageArea, settle } = require("./background-harness.js");

const EXT = path.resolve(__dirname, "../../extension");

class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag || "div").toUpperCase();
    this.id = attrs.id || "";
    this.hidden = !!attrs.hidden;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.type = attrs.type || "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  get firstChild() { if (!this.children.length) this.children.push(new El("span")); return this.children[0]; }
  get lastChild() { if (this.children.length < 2) { this.firstChild; this.children.push(new El("span")); } return this.children[this.children.length - 1]; }
  set innerHTML(_v) { this.children = []; }
  get innerHTML() { return ""; }
  appendChild(child) { this.children.push(child); return child; }
  append(...kids) { this.children.push(...kids); }
  remove() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  select() {}
  scrollIntoView() {}
  requestSubmit() { return this.fire("submit"); }
  /** Runs the handlers for an event, as a real one would. */
  fire(type, init = {}) {
    const e = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...init };
    const on = this[`on${type}`];
    const out = [];
    if (typeof on === "function") out.push(on.call(this, e));
    for (const fn of this.listeners[type] || []) out.push(fn.call(this, e));
    return out;
  }
  click() { return this.fire("click"); }
}

/** The ids in a page's HTML, with whether each starts hidden and its type. */
function idsOf(html) {
  const out = new Map();
  for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const type = (m[2].match(/\btype="([^"]+)"/) || [])[1] || "";
    out.set(m[3], { tag: m[1], hidden: /\shidden(?=[\s/=>]|$)/.test(m[2]), type });
  }
  return out;
}

/**
 * Loads a page. Options:
 *   html       the page's file name in extension/ (its ids are the document)
 *   scripts    files to run, in order (default: the page's own script tags)
 *   sync,local initial storage contents
 *   granted    origins and permissions already granted
 *   grantOnRequest  whether a permission request is allowed (default true)
 *   search     location.search
 *   globals    extra globals for the page (fetch, crypto, ...)
 */
function loadPage(opts) {
  const html = fs.readFileSync(path.join(EXT, opts.html), "utf8");
  const scripts = opts.scripts || [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const known = idsOf(html);
  const elements = new Map();
  const made = [];
  const calls = { request: [], removed: [], tabsCreate: [], closed: 0, sidePanelOpen: [], messages: [], optionsOpened: 0 };
  const granted = new Set(opts.granted || []);
  const storageChanged = event();
  const log = [];
  const permissionsAdded = event();
  const permissionsRemoved = event();

  const byId = (id) => {
    if (!known.has(id)) return null;
    if (!elements.has(id)) elements.set(id, new El(known.get(id).tag, { id, ...known.get(id) }));
    return elements.get(id);
  };
  const ready = [];
  const document = {
    documentElement: new El("html"),
    body: new El("body"),
    getElementById: byId,
    // Selectors are not parsed: a lookup by selector finds a stand-in, and a
    // list by selector is empty unless the test names its elements.
    querySelector: (sel) => (opts.select && opts.select[sel]) || new El("div"),
    querySelectorAll: (sel) => (opts.selectAll && opts.selectAll[sel]) || [],
    createElement: (tag) => { const e = new El(tag); made.push(e); return e; },
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener: (type, fn) => { if (type === "DOMContentLoaded") ready.push(fn); },
  };

  const all = (q) => [...((q && q.origins) || []), ...((q && q.permissions) || [])];
  const chrome = {
    runtime: {
      id: "testextensionid",
      lastError: undefined,
      getURL: (p) => `chrome-extension://testextensionid/${String(p).replace(/^\//, "")}`,
      getManifest: () => ({ version: "4.0.0" }),
      openOptionsPage: () => { calls.optionsOpened += 1; },
      sendMessage: (m, cb) => { calls.messages.push(m); if (typeof cb === "function") setImmediate(() => cb()); },
      onMessage: event(),
    },
    storage: { onChanged: storageChanged },
    permissions: {
      onAdded: permissionsAdded, onRemoved: permissionsRemoved,
      contains(q, cb) { const ok = all(q).every((x) => granted.has(x)); setImmediate(() => cb(ok)); },
      request(q, cb) {
        calls.request.push(structuredClone(q));
        const ok = opts.grantOnRequest !== false;
        if (ok) for (const x of all(q)) granted.add(x);
        setImmediate(() => { if (cb) cb(ok); if (ok) permissionsAdded.fire(q); });
      },
      remove(q, cb) {
        calls.removed.push(structuredClone(q));
        for (const x of all(q)) granted.delete(x);
        setImmediate(() => { if (cb) cb(true); permissionsRemoved.fire(q); });
      },
    },
    commands: { getAll: (cb) => setImmediate(() => cb([])) },
    tabs: {
      create(props, cb) { calls.tabsCreate.push({ ...props }); setImmediate(() => cb && cb({ id: 7, url: props.url })); },
      query(q, cb) { setImmediate(() => cb([{ id: 5, windowId: 1, url: "https://example.com/" }])); },
    },
    windows: { getCurrent: (cb) => setImmediate(() => cb({ id: 1 })) },
    sidePanel: { open: (o) => { calls.sidePanelOpen.push(o); } },
    scripting: {
      getRegisteredContentScripts(f, cb) { setImmediate(() => cb([])); },
      registerContentScripts(s, cb) { setImmediate(() => cb && cb()); },
      updateContentScripts(s, cb) { setImmediate(() => cb && cb()); },
      unregisterContentScripts(s, cb) { setImmediate(() => cb && cb()); },
    },
    identity: {
      getRedirectURL: (p) => `https://testextensionid.chromiumapp.org/${p || ""}`,
      launchWebAuthFlow: () => Promise.resolve("https://testextensionid.chromiumapp.org/openrouter?code=test-code"),
    },
  };
  chrome.storage.sync = storageArea("sync", storageChanged, log);
  chrome.storage.local = storageArea("local", storageChanged, log);
  Object.assign(chrome.storage.sync.data, structuredClone(opts.sync || {}));
  Object.assign(chrome.storage.local.data, structuredClone(opts.local || {}));

  const errors = [];
  const context = {
    chrome, document,
    navigator: { platform: "Linux x86_64", language: "en-US", languages: ["en-US"] },
    location: { search: opts.search || "", hash: opts.hash || "", href: `chrome-extension://testextensionid/${opts.html}${opts.search || ""}` },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    close: () => { calls.closed += 1; },
    console: { log() {}, warn() {}, info() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(" ")) },
    // Timers run at once: a page's "show this half a second later" is not what is tested.
    setTimeout: (fn, _ms, ...a) => { const t = setImmediate(fn, ...a); return t; },
    clearTimeout: (t) => clearImmediate(t),
    setInterval: () => 0, clearInterval() {},
    setImmediate, queueMicrotask, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortSignal, btoa, atob,
    crypto: globalThis.crypto,
    fetch: () => Promise.reject(new Error("no network in tests")),
    ...(opts.globals || {}),
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), context, { filename: f });
  for (const fn of ready) fn({ type: "DOMContentLoaded" });

  return {
    chrome, calls, errors, made, settle, granted,
    $: byId,
    run: (code) => vm.runInContext(code, context),
    /** Whether the element with this id is on show. */
    visible: (id) => { const e = byId(id); if (!e) throw new Error(`no element with id ${id} in ${opts.html}`); return !e.hidden; },
  };
}

module.exports = { loadPage, El, idsOf, settle };
