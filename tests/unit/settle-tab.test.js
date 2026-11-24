"use strict";
// The wait for a tab loading a page (engine.js settleTab): one routine for a
// page opened in a new tab and a page loaded in the same tab. Each case is
// run through both, from the click that starts it, in a worker made of
// stand-ins where the tab's events and requests come at set times.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const TOOLS = require(path.join(__dirname, "../../extension/agentTools.js"));
const START = "https://shop.example/start";
const PAGE = "https://shop.example/list";
const NEW_TAB = 501;
const SAME_TAB = 5;

/**
 * engine.js with a browser of stand-ins. `play(tabId, at)` is called when
 * the page starts loading (the click in this tab, or the new tab made), and
 * `at(ms, fn)` runs fn that long after.
 */
function worker(play) {
  const listeners = {};
  const event = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); }, removeListener: (fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); } });
  const anything = () => new Proxy(function stub() { return Promise.resolve(undefined); }, {
    get: (t, k) => (k === "then" ? undefined : k.startsWith && k.startsWith("on") ? event(k) : anything()),
    apply: () => Promise.resolve(undefined),
  });
  const tabs = new Map([[SAME_TAB, { id: SAME_TAB, url: START, status: "complete", windowId: 1, index: 0 }]]);
  const timers = new Set();
  const t0 = { at: 0 };
  const at = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const fire = (name, ...args) => { for (const fn of [...(listeners[name] || [])]) fn(...args); };
  // The page: the browser's events for the tab, and the requests the debugger sees.
  const page = {
    loading(tabId, url) { const t = tabs.get(tabId); t.status = "loading"; if (url) t.url = url; fire("tabs.onUpdated", tabId, { status: "loading", ...(url ? { url } : {}) }, { ...t }); },
    complete(tabId) { const t = tabs.get(tabId); t.status = "complete"; fire("tabs.onUpdated", tabId, { status: "complete" }, { ...t }); },
    address(tabId, url) { const t = tabs.get(tabId); t.url = url; fire("tabs.onUpdated", tabId, { url }, { ...t }); },
    request(tabId, id, type = "Fetch") { fire("debugger.onEvent", { tabId }, "Network.requestWillBeSent", { requestId: id, type, request: { url: `https://shop.example/api/${id}` } }); },
    finished(tabId, id) { fire("debugger.onEvent", { tabId }, "Network.loadingFinished", { requestId: id }); },
  };
  const start = (tabId) => { t0.at = Date.now(); play(tabId, at, page); };
  const chrome = new Proxy({
    debugger: {
      attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}),
      onDetach: event("debugger.onDetach"), onEvent: event("debugger.onEvent"),
    },
    runtime: { id: "x", getURL: (p) => `chrome-extension://x/${p || ""}`, onMessage: event("runtime.onMessage"), onConnect: event("runtime.onConnect"), sendMessage: () => Promise.resolve() },
    tabs: new Proxy({
      get: async (id) => (tabs.has(id) ? { ...tabs.get(id) } : Promise.reject(new Error("no tab"))),
      query: async () => [],
      update: async (id) => ({ ...tabs.get(id) }),
      create: async ({ url }) => {
        const t = { id: NEW_TAB, url: "", pendingUrl: url, status: "loading", windowId: 1, index: 1, openerTabId: SAME_TAB };
        tabs.set(NEW_TAB, t);
        start(NEW_TAB);
        return { ...t };
      },
      // The click: in this tab it starts the load; to a new tab it names the link.
      sendMessage: async (id, m) => {
        if (!m || m.action !== "interact") return undefined;
        if (play.newTab) return { success: true, message: "Clicked.", opensTab: PAGE };
        tabs.get(id).status = "loading";
        start(id);
        return { success: true, message: "Clicked.", outcome: {} };
      },
      onUpdated: event("tabs.onUpdated"), onCreated: event("tabs.onCreated"), onRemoved: event("tabs.onRemoved"),
    }, { get: (t, k) => (k in t ? t[k] : k.startsWith("on") ? event(`tabs.${k}`) : anything()) }),
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} }, sync: { get: async () => ({}), set: async () => {} }, onChanged: event("storage.onChanged") },
  }, { get: (t, k) => (k in t ? t[k] : anything()) });
  const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  const root = { chrome, console, setTimeout: later, clearTimeout, setInterval: () => 0, clearInterval: () => {}, URL, Promise, AbortController };
  root.globalThis = root;
  root.self = root;
  vm.createContext(root);
  const EXT = path.join(__dirname, "../../extension");
  for (const f of ["config.js", "defaults.js", "security.js", "publicSuffixes.js", "agentTools.js", "agentPrompt.js", "usageLimits.js", "pageSearch.js", "core/step.js", "core/observe.js", "core/memory.js", "core/context.js", "core/policy.js", "core/run.js", "core/llm.js", "core/learn.js", "core/view.js", "core/inject.js", "engine.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), root, { filename: f });
  }
  return { engine: root.SELECT_TO_AI_ENGINE, tabs, t0, stop: () => { for (const t of timers) clearTimeout(t); } };
}

/**
 * One click, through one of the two ways a page loads, with the page
 * played by `script(tabId, at, page)`. Returns when the wait ended (ms
 * after the load began), what the tab showed then, and the click's result.
 */
async function click(entry, script) {
  const play = (tabId, at, page) => script(tabId, at, page);
  play.newTab = entry === "new tab";
  const w = worker(play);
  const session = { windowId: 1, run: { id: "r1", status: "running", tabId: SAME_TAB, children: [], openedTabs: [] }, runners: new Map(), touched: new Set(), view: { home: null, tabs: [SAME_TAB], touched: false, watched: [], kept: null } };
  // The worker's own timers do not hold the process open (as in review-fixes.test.js): this does, while the click is waited for.
  const alive = setInterval(() => {}, 50);
  try {
    const result = await w.engine.interact(session, { do: "click", ref: 1 }, { action: "click", id: 1 }, true);
    const ended = Date.now() - w.t0.at;
    const tabId = play.newTab ? NEW_TAB : SAME_TAB;
    return { ended, tab: { ...w.tabs.get(tabId) }, result, engine: w.engine };
  } finally { clearInterval(alive); w.stop(); }
}

const ENTRIES = ["new tab", "same tab"];
// Timers in a busy test process run late by a little.
const SLACK = 250;
const { QUIET_MS, CEILING_MS } = TOOLS.SETTLE;

for (const entry of ENTRIES) {
  test(`${entry}: a tab that is complete while its requests are open is read once they are done`, async () => {
    const r = await click(entry, (id, at, page) => {
      at(100, () => page.request(id, "results"));
      at(150, () => page.complete(id));
      at(1200, () => page.finished(id, "results"));
    });
    assert.ok(r.ended >= 1200 + QUIET_MS - 50, `read at ${r.ended} ms, before the request was done and quiet`);
    assert.equal(r.result.ok, true);
  });

  test(`${entry}: a page that loads again after it was complete is read after the second load`, async () => {
    let secondDone = 0;
    const r = await click(entry, (id, at, page) => {
      at(100, () => page.complete(id));
      at(600, () => page.loading(id));
      at(900, () => { secondDone = Date.now(); page.complete(id); });
    });
    assert.ok(secondDone, "the second load ended");
    assert.ok(r.ended >= 900, `read at ${r.ended} ms, before the second load ended`);
    assert.equal(r.tab.status, "complete");
  });

  test(`${entry}: an address that changes inside the watch is the one read`, async () => {
    const r = await click(entry, (id, at, page) => {
      at(80, () => page.address(id, PAGE));
      at(150, () => page.complete(id));
      at(600, () => page.loading(id, `${PAGE}/real`));
      at(800, () => page.complete(id));
    });
    assert.ok(r.ended >= 800, `read at ${r.ended} ms, before the new address loaded`);
    assert.equal(r.tab.url, `${PAGE}/real`);
    assert.match(r.result.message, /shop\.example\/list\/real/, "the result names the new address");
  });

  test(`${entry}: an ordinary page pays at most the watch window, and never past the ceiling`, async () => {
    const r = await click(entry, (id, at, page) => {
      at(80, () => page.address(id, PAGE));
      at(150, () => page.complete(id));
    });
    const watch = r.engine.WATCH_MS;
    assert.ok(r.ended <= 150 + watch + SLACK, `read at ${r.ended} ms, past the load and the watch window`);
    assert.ok(r.ended >= 150 + watch - 50, `read at ${r.ended} ms: the watch did not run`);
    console.log(`  ${entry}, ordinary page: load ended at 150 ms, read at ${r.ended} ms`);
  });

  test(`${entry}: a first load that is over before the wait begins is still followed when the page replaces itself`, async () => {
    const r = await click(entry, (id, at, page) => {
      // A fast page: loaded and complete while the click is still answering.
      page.loading(id);
      page.complete(id);
      at(600, () => page.loading(id, `${PAGE}/real`));
      at(900, () => page.complete(id));
    });
    assert.ok(r.ended >= 900, `read at ${r.ended} ms, before the page that took its place loaded`);
    assert.equal(r.tab.url, `${PAGE}/real`);
  });

  test(`${entry}: a page that keeps loading again gets exactly one more wait`, async () => {
    const r = await click(entry, (id, at, page) => {
      at(100, () => page.complete(id));
      // Loads again every 800 ms, for as long as the test runs.
      for (let n = 0; n < 12; n++) {
        at(500 + n * 800, () => page.loading(id));
        at(700 + n * 800, () => page.complete(id));
      }
    });
    assert.ok(r.ended >= 700, `read at ${r.ended} ms, before the second load ended`);
    assert.ok(r.ended < 1300, `read at ${r.ended} ms: it waited for a third load`);
  });
}

for (const entry of ENTRIES) {
  test(`${entry}: a page that is never quiet is read at the ceiling, with the wait said`, async () => {
    const r = await click(entry, (id, at, page) => {
      at(100, () => page.complete(id));
      // A new request every 300 ms, each done in 250: never 400 ms of quiet.
      for (let n = 0; n * 300 < CEILING_MS + 3000; n++) {
        at(150 + n * 300, () => page.request(id, `poll${n}`));
        at(400 + n * 300, () => page.finished(id, `poll${n}`));
      }
      // And a second load inside the watch, which is waited for within the same ceiling.
      at(500, () => page.loading(id));
      at(700, () => page.complete(id));
    });
    assert.ok(r.ended <= CEILING_MS + SLACK, `read at ${r.ended} ms, past the ceiling of ${CEILING_MS}`);
    assert.ok(r.ended >= CEILING_MS - 600, `read at ${r.ended} ms, well before the ceiling`);
    assert.match(r.result.message, /still loading/);
  });
}

test("every way a page loads goes through the one wait", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../extension/engine.js"), "utf8");
  // settled, the load alone, is called only from inside settleTab.
  const body = src.slice(src.indexOf("async function settleTab("), src.indexOf("/** The model is told when the page was still loading"));
  const outside = src.replace(body, "");
  assert.equal((outside.match(/\bsettled\(/g) || []).length, 1, "settled is defined once and called only by settleTab");
  assert.equal(/\bloadSettled\(/.test(src), false, "no second way of waiting for a load");
  assert.ok((src.match(/\bsettleTab\(/g) || []).length >= 7, "new tabs, clicks, back and navigate all call settleTab");
});
