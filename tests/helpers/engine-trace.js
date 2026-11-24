"use strict";
// What a run did, as the engine holds it: read from the extension's worker
// through the engine's own module (SELECT_TO_AI_ENGINE and its sessions),
// the same trace it sends the agent page. The harnesses read it here, so the
// shipped side panel carries no global put there for them.
//
// The harnesses judge the trace beside what the panel shows, so it is the
// trace of the run the panel shows, as far as the panel has been sent it:
// none until the page has joined its session, none while the worker holds
// journal entries it has not sent the page yet (the end of a run is one), and
// none for a run whose request is not the last one in the panel (the run a
// fresh page clears, before it is cleared).

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
    const held = await worker.evaluate((id) => {
      const engine = self.SELECT_TO_AI_ENGINE;
      const run = self.SELECT_TO_AI_RUN;
      const session = engine && engine.sessions.get(id);
      if (!session || !session.run || !run) return null;
      return { trace: run.trace(session.run), sent: session.sent === session.run.journal.length, joined: session.ports.size > 0 };
    }, windowId);
    if (!held || !held.trace || !held.sent || !held.joined) return null;
    const asked = await page.evaluate(() => {
      const last = [...document.querySelectorAll(".message-bubble.user .bubble-content")].pop();
      return last ? last.textContent : "";
    });
    return asked.trim().endsWith(String(held.trace.task || "").trim()) && asked.trim() ? held.trace : null;
  } catch (_e) {
    return null;
  }
}

module.exports = { engineTrace, workerOf };
