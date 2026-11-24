"use strict";
// What a run did, as the agent page was told it. The harnesses judge the
// trace beside what the panel shows, so it must be the trace the panel holds:
// the one in the last message its port was sent, followed the way agent.js
// follows them (a snapshot sets it, "started" clears it, "entries" for the
// run on show replace it, anything for another run is ignored). Reading the
// engine's own state instead gives a trace the page has not been sent yet,
// or one for a run the page has already moved past.
//
// watchViews(worker) adds a second onConnect listener in the extension's
// worker, next to the engine's, before any agent page opens. Chrome hands
// both listeners the same Port, so wrapping its postMessage sees every
// message the engine sends that page, from the first snapshot on. Nothing
// is added to the shipped build: the side panel carries no global for this.
//
// A worker Chrome stopped and started again has lost the listener. Until
// the page connects again under a new one, the trace is the engine's own,
// and only once the page has been sent all of it.

/** The extension's service worker, or null when it is not up. */
async function workerOf(browser) {
  const target = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"))
    || await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 3000 }).catch(() => null);
  return target ? target.worker() : null;
}

/** Runs in the worker: follows every agent page's port from here on. */
function installWatch() {
  if (self.__harnessViews) return true;
  const views = [];
  self.__harnessViews = views;
  const follow = (view, m) => {
    if (!m || typeof m !== "object") return;
    view.messages += 1;
    if (m.type === "snapshot") { view.runId = m.run ? m.run.id : ""; view.trace = m.run ? structuredClone(m.run.trace) : null; return; }
    if (m.type === "started") { view.runId = m.runId; view.trace = null; return; }
    if (m.runId !== view.runId) return;
    if (m.type === "entries") view.trace = structuredClone(m.trace);
  };
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "agentView") return;
    const view = { tabId: port.sender && port.sender.tab ? port.sender.tab.id : null, runId: "", trace: null, open: true, messages: 0 };
    views.push(view);
    const send = port.postMessage.bind(port);
    Object.defineProperty(port, "postMessage", { configurable: true, writable: true, value: (m) => { follow(view, m); return send(m); } });
    port.onDisconnect.addListener(() => { view.open = false; });
  });
  return true;
}

/** Starts following what each agent page is sent. Call once, before the first agent page opens. */
async function watchViews(worker) {
  return worker.evaluate(installWatch);
}

/** The trace the agent page `page` was last sent, or null. */
async function engineTrace(browser, page) {
  try {
    const where = await page.evaluate(() => new Promise((r) => chrome.tabs.getCurrent((t) => {
      void chrome.runtime.lastError;
      if (t) { r({ tabId: t.id, windowId: t.windowId }); return; }
      chrome.windows.getCurrent((w) => { void chrome.runtime.lastError; r({ tabId: null, windowId: w ? w.id : -1 }); });
    })));
    const worker = await workerOf(browser);
    if (!worker) return null;
    await worker.evaluate(installWatch);
    return await worker.evaluate(({ tabId, windowId }) => {
      const mine = self.__harnessViews.filter((v) => v.open && v.tabId === tabId);
      if (mine.length) return mine[mine.length - 1].trace;
      const engine = self.SELECT_TO_AI_ENGINE;
      const run = self.SELECT_TO_AI_RUN;
      const session = engine && engine.sessions.get(windowId);
      if (!session || !session.run || !run || !session.ports.size || session.sent !== session.run.journal.length) return null;
      return run.trace(session.run);
    }, where);
  } catch (_e) {
    return null;
  }
}

module.exports = { engineTrace, watchViews, workerOf };
