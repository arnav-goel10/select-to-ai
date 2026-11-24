"use strict";
// What a run did, as the engine holds it: read from the extension's worker
// through the engine's own module (SELECT_TO_AI_ENGINE and its sessions),
// the same trace it sends the agent page. The harnesses read it here, so the
// shipped side panel carries no global put there for them.

/** The extension's service worker, or null when it is not up. */
async function workerOf(browser) {
  const target = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"))
    || await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 3000 }).catch(() => null);
  return target ? target.worker() : null;
}

/**
 * The trace of the run in the agent page's window, or null. `page` is the
 * extension's agent page: its window is the session the engine keeps the run in.
 */
async function engineTrace(browser, page) {
  try {
    const windowId = await page.evaluate(() => new Promise((r) => chrome.windows.getCurrent((w) => { void chrome.runtime.lastError; r(w ? w.id : -1); })));
    const worker = await workerOf(browser);
    if (!worker) return null;
    return await worker.evaluate((id) => {
      const engine = self.SELECT_TO_AI_ENGINE;
      const run = self.SELECT_TO_AI_RUN;
      const session = engine && engine.sessions.get(id);
      return session && session.run && run ? run.trace(session.run) : null;
    }, windowId);
  } catch (_e) {
    return null;
  }
}

module.exports = { engineTrace, workerOf };
