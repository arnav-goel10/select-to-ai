/**
 * Right-click sending end to end (plan: core-flow-e2e).
 *
 *   node tests/e2e/core-flow.js [buildDir]
 *
 * buildDir (default PACKAGE_DIR, else extension/) is loaded as it ships, with
 * no optional grant. chatgpt.com, www.perplexity.ai and gemini.google.com
 * are pointed at a local HTTPS stand-in (a throwaway self-signed certificate
 * made with openssl at run time, never written to the repo), so the real
 * content script runs on the real host names and nothing leaves the machine.
 *
 * Scenarios, each driven through the worker's own menu handler
 * (onMenuClicked), as Chrome calls it:
 *   1. worker stopped before the click, New tab plus auto-send: the saved mode
 *      and auto-send are honoured (a chatgpt.com/?q= tab, no side panel);
 *      then the same with the click landing before storage has answered;
 *   2. side panel on a cold worker: the stored auto-context is used;
 *   3. a send opens the base URL (a new chat) even with a saved conversation,
 *      and the text reaches the message box;
 *   4. a long CJK selection with auto-send takes the page-insert path and is
 *      sent there;
 *   5. New tab delivery is retried when the first messages are not answered;
 *   6. a click with no tab does not throw;
 *   7. zero assistants: no menu item at all, and the side panel page shows its
 *      empty state.
 * SHOTS_DIR=dir saves a screenshot of the empty side panel there.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.resolve(process.argv[2] || process.env.PACKAGE_DIR || path.join(ROOT, "extension"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOSTS = ["chatgpt.com", "www.perplexity.ai", "gemini.google.com"];

// The assistants' message boxes, shaped like the selectors in config.js. A
// press on send moves the text into a "user message" and empties the box,
// which is what the content script checks before it calls a send done.
function assistantPage(host) {
  const box = host === "www.perplexity.ai"
    ? '<textarea id="ask-input" placeholder="Ask anything"></textarea><button data-testid="submit-button" aria-label="Submit">Go</button>'
    : '<textarea id="mobile-composer-prompt" aria-label="Chat with ChatGPT"></textarea><button data-testid="send-button">Send</button>';
  return `<!doctype html><meta charset="utf-8"><title>${host} stand-in</title>
<main id="log"></main>${box}
<script>
  window.__sent = [];
  const input = document.querySelector("textarea");
  document.querySelector("button").addEventListener("click", () => {
    const text = input.value;
    if (!text.trim()) return;
    window.__sent.push(text);
    const m = document.createElement("div");
    m.setAttribute("data-message-role", "user");
    m.textContent = text;
    document.getElementById("log").appendChild(m);
    input.value = "";
  });
</script>`;
}

function certificate(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=chatgpt.com", "-addext", `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}`], { stdio: "pipe" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function main() {
  const puppeteer = require("puppeteer");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-coreflow-"));
  const extDir = path.join(tmp, "extension");
  fs.cpSync(BUILD, extDir, { recursive: true });
  fs.rmSync(path.join(extDir, "_metadata"), { recursive: true, force: true });

  const requests = [];
  const server = https.createServer(certificate(tmp), (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    requests.push({ host, url: req.url });
    if (host === "article.test") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Article</title><p>Some text worth asking about.</p>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(assistantPage(host));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const rules = [...HOSTS, "article.test"].map((h) => `MAP ${h} 127.0.0.1:${port}`).join(",");

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const browser = await puppeteer.launch({
    headless: !process.env.E2E_HEADFUL,
    acceptInsecureCerts: true,
    userDataDir: path.join(tmp, "profile"),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run",
      "--disable-features=DialMediaRouteProvider", `--host-resolver-rules=${rules}`, "--ignore-certificate-errors"],
  });

  const workerTarget = (previous) => browser.waitForTarget((t) => t !== previous && t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 }).catch(() => null);
  const errors = [];
  // The worker, driven over its own CDP session: evaluate(fn, ...args) runs
  // fn in the worker's global scope (so its top-level functions and bindings
  // are reachable) and returns the value. Puppeteer's WebWorker is not used,
  // because it can keep a handle to a worker that was stopped.
  async function attach(target) {
    const cdp = await target.createCDPSession();
    cdp.on("Runtime.exceptionThrown", (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description) || e.exceptionDetails.text));
    await cdp.send("Runtime.enable");
    const evaluate = async (fn, ...args) => {
      const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result ? r.result.value : undefined;
    };
    const close = async () => {
      const w = await target.worker();
      if (!w || typeof w.close !== "function") throw new Error("this Puppeteer has no WebWorker.close()");
      await w.close();
    };
    return { evaluate, close };
  }

  try {
    let target = await workerTarget();
    check("service worker starts", target, "no service worker within 20 s");
    if (!target) return report(checks);
    let worker = await attach(target);
    const extId = new URL(target.url()).host;
    await sleep(1500);

    const handler = await worker.evaluate(() => typeof onMenuClicked);
    check("the right-click handler is reachable by name (onMenuClicked)", handler === "function", `typeof onMenuClicked is ${handler}`);
    if (handler !== "function") return report(checks);

    // A source tab to right-click on.
    const article = await browser.newPage();
    await article.goto("https://article.test/", { waitUntil: "load" });
    const sourceTab = () => worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith("https://article.test/")));

    // Settings, then a wait until the menu has been rebuilt from them.
    const setSettings = async (sync, local) => {
      await worker.evaluate(async (s, l) => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set(s);
        if (l) await chrome.storage.local.set(l);
      }, sync, local || null);
      await sleep(800);
    };
    // New tabs opened by fn (run in the worker), by their address. Each step
    // is its own evaluate: the worker's CSP has no eval.
    const newTabsDuring = async (fn, arg) => {
      const before = await worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
      const result = await worker.evaluate(fn, arg);
      const made = await worker.evaluate(async (known) => {
        let list = [];
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          list = (await chrome.tabs.query({})).filter((t) => !known.includes(t.id)).map((t) => ({ id: t.id, url: t.pendingUrl || t.url || "" }));
          if (list.some((t) => t.url && t.url !== "about:blank")) break;
        }
        return list;
      }, before);
      return { result, made };
    };
    const closeTabs = async (ids) => {
      await worker.evaluate((list) => Promise.all(list.map((id) => chrome.tabs.remove(id).catch(() => {}))), ids);
      await sleep(400);
    };
    const pageFor = async (prefix) => {
      for (let i = 0; i < 40; i++) {
        const page = (await browser.pages()).find((p) => p.url().startsWith(prefix));
        if (page) return page;
        await sleep(250);
      }
      return null;
    };
    const waitFor = async (page, fn, arg) => {
      for (let i = 0; i < 40; i++) {
        const v = await page.evaluate(fn, arg).catch(() => null);
        if (v) return v;
        await sleep(250);
      }
      return null;
    };

    // 1. Worker stopped before the click, New tab plus auto-send.
    await setSettings({ openingMode: "tab", autoSend: true });
    const ids = await worker.evaluate(async () => {
      const made = [];
      const real = chrome.contextMenus.create;
      chrome.contextMenus.create = function (props, cb) { made.push(props.id); return real.call(this, props, cb); };
      await chrome.storage.sync.set({ __probe: 1 });
      await new Promise((r) => setTimeout(r, 900));
      chrome.contextMenus.create = real;
      await chrome.storage.sync.remove("__probe");
      return made;
    });
    check("menu ids carry the New tab mode", ids.includes("openChatGPT|tab"), `ids ${JSON.stringify(ids)}`);
    // Stop the worker, wake it from an extension page as a click would, and
    // find the new one. A restarted worker can come back under the same
    // target id, so every worker target is tried until one answers and has
    // lost the mark set before the stop (proof it is a fresh start).
    await worker.evaluate(() => { self.__coreFlowMark = 1; });
    let stopped = false;
    try { await worker.close(); stopped = true; } catch (e) { console.log(`could not stop the worker: ${e.message}`); }
    let restarted = null;
    const waker = await browser.newPage();
    await waker.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" }).catch(() => {});
    for (let i = 0; i < 40 && !restarted; i++) {
      await waker.evaluate(() => chrome.runtime.sendMessage({ type: "core-flow-wake" }).catch(() => {})).catch(() => {});
      await sleep(500);
      for (const t of browser.targets().filter((x) => x.type() === "service_worker" && x.url().endsWith("/background.js"))) {
        try {
          const cdp = await t.createCDPSession();
          const r = await cdp.send("Runtime.evaluate", { expression: "typeof self.__coreFlowMark", returnByValue: true });
          await cdp.detach().catch(() => {});
          if (r && r.result && r.result.value === "undefined") { restarted = t; break; }
        } catch { /* not ready yet */ }
      }
    }
    await waker.close().catch(() => {});
    check("worker restarts after it was stopped", stopped && restarted, stopped ? "no fresh service worker within 20 s" : "worker.close() failed");
    if (restarted) { target = restarted; worker = await attach(target); }
    else return report(checks);
    const tab1 = await sourceTab();
    const cold = await newTabsDuring(async (tab) => {
      onMenuClicked({ menuItemId: "openChatGPT|tab", selectionText: "hello world", frameId: 0 }, tab);
    }, tab1);
    const coldUrl = (cold.made.find((t) => t.url.startsWith("https://chatgpt.com/")) || {}).url || "";
    check("after a worker restart, New tab plus auto-send opens chatgpt.com/?q=", coldUrl === "https://chatgpt.com/?q=hello%20world", `tabs ${JSON.stringify(cold.made)}`);
    await closeTabs(cold.made.map((t) => t.id));

    // The click landing before storage has answered: the cache is put back
    // to what a just-started worker holds, and the click comes in the same
    // turn, before the read can finish.
    const race = await newTabsDuring(async (tab) => {
      cachedSettings = { ...DEFAULT_SETTINGS };
      settingsLoaded = false;
      updateCache();
      onMenuClicked({ menuItemId: "openChatGPT|tab", selectionText: "before storage", frameId: 0 }, tab);
      return cachedSettings.autoSend;
    }, tab1);
    const raceUrl = (race.made.find((t) => t.url.startsWith("https://chatgpt.com/")) || {}).url || "";
    check("a click before storage answers still uses the stored auto-send", race.result === false && raceUrl === "https://chatgpt.com/?q=before%20storage", `cache autoSend at click ${race.result}, tabs ${JSON.stringify(race.made)}`);
    await closeTabs(race.made.map((t) => t.id));

    // 2. Side panel on a cold worker: the panel cannot open without a real
    // gesture here, but the hand-off it reads must carry the stored settings.
    await setSettings({ autoContext: true, autoSend: false });
    const panel = await worker.evaluate(async (tab) => {
      cachedSettings = { ...DEFAULT_SETTINGS };
      settingsLoaded = false;
      updateCache();
      onMenuClicked({ menuItemId: "openGemini|panel", selectionText: "explain this", frameId: 0 }, tab);
      await new Promise((r) => setTimeout(r, 800));
      return (await chrome.storage.local.get("sidePanelState")).sidePanelState;
    }, await sourceTab());
    check("side panel hand-off uses the stored auto-context and the base URL",
      panel && panel.url === "https://gemini.google.com/app" && panel.selectedText === "Context: https://article.test/\n\nexplain this",
      JSON.stringify(panel));

    // 3. A new chat, not the saved conversation, and the text arrives.
    await setSettings({ openingMode: "tab", autoSend: false }, { "sessionUrl_chatgpt.com": "https://chatgpt.com/c/old-thread" });
    const fresh = await newTabsDuring(async (tab) => {
      onMenuClicked({ menuItemId: "openChatGPT|tab", selectionText: "a new question", frameId: 0 }, tab);
    }, await sourceTab());
    const freshUrl = (fresh.made[0] || {}).url || "";
    check("a send opens the base URL, not the saved conversation", freshUrl === "https://chatgpt.com/", `tabs ${JSON.stringify(fresh.made)}`);
    const chat = await pageFor("https://chatgpt.com/");
    const typed = chat && await waitFor(chat, () => { const v = document.querySelector("textarea").value; return v || null; });
    check("the text reaches the message box", typed === "a new question", `box holds ${JSON.stringify(typed)}`);
    await closeTabs(fresh.made.map((t) => t.id));

    // 4. Long CJK selection with auto-send: page-insert path, then sent.
    await setSettings({ openingMode: "tab", autoSend: true, showPerplexity: true });
    const long = "这是一篇很长的文章。".repeat(40); // 400 characters, 3,600 encoded
    const cjk = await newTabsDuring(async (args) => {
      onMenuClicked({ menuItemId: "openPerplexity|tab", selectionText: args.text, frameId: 0 }, args.tab);
    }, { text: long, tab: await sourceTab() });
    const cjkUrl = (cjk.made[0] || {}).url || "";
    check("a long CJK selection is not put in the URL", cjkUrl === "https://www.perplexity.ai/", `tab ${cjkUrl.slice(0, 120)}`);
    const pplx = await pageFor("https://www.perplexity.ai/");
    const sent = pplx && await waitFor(pplx, () => (window.__sent && window.__sent.length ? window.__sent[0] : null));
    check("the long selection is inserted and sent on the page", sent === long, `sent ${sent ? sent.length : 0} characters`);
    await closeTabs(cjk.made.map((t) => t.id));

    // 5. New tab delivery retried: the first two messages go unanswered.
    await setSettings({ openingMode: "tab", autoSend: false });
    const retry = await newTabsDuring(async (tab) => {
      self.__sends = 0;
      const real = chrome.tabs.sendMessage;
      self.__realSend = real;
      chrome.tabs.sendMessage = function (tabId, message, options, cb) {
        self.__sends += 1;
        if (self.__sends <= 2) { setTimeout(() => cb && cb(undefined), 0); return; }
        return real.call(chrome.tabs, tabId, message, options, cb);
      };
      onMenuClicked({ menuItemId: "openChatGPT|tab", selectionText: "delivered on retry", frameId: 0 }, tab);
    }, await sourceTab());
    const retryPage = await pageFor("https://chatgpt.com/");
    const retried = retryPage && await waitFor(retryPage, () => document.querySelector("textarea").value || null);
    const sends = await worker.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      chrome.tabs.sendMessage = self.__realSend;
      return self.__sends;
    });
    check("New tab delivery is retried and arrives", retried === "delivered on retry" && sends >= 3, `box ${JSON.stringify(retried)}, messages ${sends}`);
    await closeTabs(retry.made.map((t) => t.id));

    // 6. No tab.
    await setSettings({ autoSend: false });
    const noTab = await newTabsDuring(async () => {
      try { onMenuClicked({ menuItemId: "openChatGPT|panel", selectionText: "no tab", frameId: 0 }, undefined); return "ok"; } catch (e) { return `threw: ${e.message}`; }
    });
    check("a click with no tab does not throw", noTab.result === "ok", noTab.result);
    check("a click with no tab opens the assistant in a tab", noTab.made.some((t) => t.url.startsWith("https://chatgpt.com/")), JSON.stringify(noTab.made));
    await closeTabs(noTab.made.map((t) => t.id));

    // 7. Zero assistants.
    const zero = { showChatGPT: false, showGemini: false, showPerplexity: false, showClaude: false, showAgent: false };
    const made = await worker.evaluate(async (s) => {
      const list = [];
      const real = chrome.contextMenus.create;
      chrome.contextMenus.create = function (props, cb) { list.push(props.title || props.id); return real.call(this, props, cb); };
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(s);
      await new Promise((r) => setTimeout(r, 1200));
      chrome.contextMenus.create = real;
      return list;
    }, zero);
    check("zero assistants: no menu item and no empty parent", made.length === 0, `created ${JSON.stringify(made)}`);
    const side = await browser.newPage();
    await side.setViewport({ width: 400, height: 700 });
    await side.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: "load" });
    const empty = await waitFor(side, () => {
      const el = document.getElementById("emptyState");
      return el && !el.hidden && document.getElementById("contentFrame").hidden ? el.innerText : null;
    });
    check("zero assistants: the side panel shows its empty state", empty && /No assistant is turned on/.test(empty), `empty state ${JSON.stringify(empty)}`);
    if (process.env.SHOTS_DIR) {
      fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true });
      const file = path.join(process.env.SHOTS_DIR, "side-panel-empty.png");
      await side.screenshot({ path: file });
      console.log(`saved ${file}`);
    }
    const sideText = await side.evaluate(() => document.body.innerText);
    check("side panel text has no em dash and no 'undefined'", !/\u2014|undefined/.test(sideText), sideText);
    await side.close();

    check("no uncaught worker error", !errors.length, errors.join(" | "));
    console.log(`requests to the stand-in: ${requests.filter((r) => r.host !== "article.test").map((r) => `${r.host}${r.url.slice(0, 40)}`).join(", ")}`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return report(checks);
}

function report(checks) {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${!c.ok && c.detail ? `\n      ${c.detail}` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} core-flow checks passed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
