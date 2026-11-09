// A stand-in for the extension's chrome object over one Playwright page,
// so the extension's recipes driver can be tested in a real browser without
// loading the extension: content scripts are added to the page, messages to
// the tab go to the listener the agent's content script registers, and the
// tab's status is the document's readiness.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension");

const RUNTIME = () => {
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: "test",
    onMessage: { addListener: (fn) => { window.__s2aListener = fn; } },
    // No engine answers here: real pointer and keys fall back to scripted events.
    sendMessage: (m, cb) => { if (typeof cb === "function") setTimeout(() => cb(undefined), 0); },
    getURL: (p) => p,
    lastError: undefined,
  };
};

export async function chromeOver(page) {
  await page.addInitScript(RUNTIME);
  const src = new Map();
  const read = (f) => { if (!src.has(f)) src.set(f, fs.readFileSync(path.join(EXT, f), "utf8")); return src.get(f); };
  let loading = false;
  const calls = [];
  const chrome = {
    calls,
    scripting: {
      async executeScript({ files, func, args }) {
        if (files) {
          for (const f of files) await page.addScriptTag({ content: read(f) });
          return [{ result: undefined }];
        }
        const result = await page.evaluate(([code, a]) => (0, eval)(`(${code})`)(...a), [func.toString(), args || []]);
        return [{ result }];
      },
    },
    tabs: {
      async get(id) {
        let status = "complete";
        if (loading) status = "loading";
        else {
          try { status = (await page.evaluate(() => document.readyState)) === "loading" ? "loading" : "complete"; } catch { status = "loading"; }
        }
        return { id, url: page.url(), status, active: true };
      },
      async update(id, { url }) {
        calls.push(["update", url]);
        loading = true;
        try { await page.goto(url, { waitUntil: "domcontentloaded" }); } finally { loading = false; }
        return { id, url: page.url() };
      },
      async goBack() {
        loading = true;
        try { await page.goBack({ waitUntil: "domcontentloaded" }); } finally { loading = false; }
      },
      async sendMessage(_id, msg) {
        calls.push(["send", msg.data && msg.data.action]);
        return page.evaluate((m) => new Promise((resolve) => {
          if (!window.__s2aListener) { resolve(undefined); return; }
          const keep = window.__s2aListener(m, { id: "test" }, resolve);
          if (keep !== true) setTimeout(() => resolve(undefined), 0);
        }), msg);
      },
    },
  };
  return chrome;
}
