/**
 * Select to AI - a card that arrives while the user types never takes their keys.
 *
 *   node tests/e2e/card-keys.js
 *
 * The agent page runs in Chromium with the real extension. Its port to the
 * service worker is replaced, before its scripts run, by one this test feeds
 * the same messages engine.js sends, and every message the page sends back
 * is kept. The keys are real key presses.
 *
 * Held to:
 * - an approval card arriving while the user types in the box leaves focus
 *   in the box, and their next Enter answers nothing;
 * - Enter on the card's own button does nothing until the card has been in
 *   view for a moment, then works;
 * - a key press that began before the card arrived does nothing on it;
 * - the card is said to screen readers;
 * - a pointer click on the button works at once.
 */
"use strict";

const path = require("node:path");
const assert = require("node:assert/strict");

const EXT = path.resolve(__dirname, "../../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_ = "https://shop.example/checkout";

const log = (role, title, text, act) => ({ k: "log", role, title, text, fold: false, ...(act ? { act } : {}) });
const status = (role, text) => ({ k: "status", role, text });
const TASK = "Buy the blue widget";
const JOURNAL = [
  status("executor", "Looking at the page…"),
  log("system", "Task Started", TASK),
  log("executor", "Step 1", "Go to the checkout"),
  log("executor", "Action", 'click [3] "Checkout"', { do: "click", ref: "3", control: "Checkout" }),
  log("executor", "Result", "The checkout page is open."),
  status("executor", "Step 2…"),
];
const trace = (extra) => ({ id: "run-1", task: TASK, steps: 2, running: true, waitingForUser: false, waitKind: "", stopState: "", activeMs: 9000, tokens: { prompt: 1, completion: 1 }, costUSD: 0, tabId: 1, history: [], ...extra });
const snapshot = { type: "snapshot", turns: [], run: { id: "run-1", task: TASK, status: "running", journal: JOURNAL, wait: null, trace: trace({}) } };
const askEntries = (id) => ({
  type: "entries", runId: "run-1", status: "waiting", trace: trace({ waitingForUser: true, waitKind: "approval" }),
  entries: [{ k: "ask", wait: { id, kind: "approval", risk: "pay", question: 'Pressing "Pay now" would spend money.', detail: ["On: Pay now"], tabId: 1 } }, status("idle", "Waiting for your go-ahead")],
});

async function main() {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"] });
  const failures = [];
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 20000 });
    const worker = await workerTarget.worker();
    const id = new URL(workerTarget.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.sync.set({ showAgent: true, agentActiveProvider: "openrouter" });
      await chrome.storage.local.set({ onboardingComplete: true, agentOpenRouterKey: "sk-or-v1-test" });
    });

    async function open() {
      const page = await browser.newPage();
      await page.setViewport({ width: 420, height: 800 });
      await page.evaluateOnNewDocument((tabUrl) => {
        const listeners = [];
        window.__posted = [];
        window.__deliver = (m) => listeners.forEach((f) => f(m));
        const realConnect = chrome.runtime.connect.bind(chrome.runtime);
        chrome.runtime.connect = (info) => {
          if (!info || info.name !== "agentView") return realConnect(info);
          window.__connected = true;
          return { onMessage: { addListener: (f) => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: (m) => window.__posted.push(m), disconnect() {} };
        };
        chrome.tabs.get = (tabId, cb) => cb({ id: tabId, url: tabUrl });
      }, URL_);
      await page.goto(`chrome-extension://${id}/agent.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__connected === true);
      await page.evaluate((m) => window.__deliver(m), snapshot);
      await sleep(400);
      return page;
    }
    const deliver = (page, m) => page.evaluate((x) => window.__deliver(x), m);
    const answers = (page) => page.evaluate(() => window.__posted.filter((m) => m.type === "approve" || m.type === "decline"));
    const check = async (name, fn) => {
      try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message}`); }
    };

    await check("a card arriving while the user types leaves focus in the box, and Enter answers nothing", async () => {
      const page = await open();
      await page.focus("#taskInput");
      await page.keyboard.type("also check the");
      await deliver(page, askEntries("w1"));
      await sleep(250);
      // The box is turned off while an approval waits, so focus may leave it
      // for the page itself; it never lands on the card.
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        return { id: a && a.id, onCard: !!(a && a.closest && a.closest(".confirmation-bubble")), onPage: a === document.body || a === document.getElementById("taskInput"), said: document.getElementById("liveAnnounce").textContent };
      });
      assert.equal(where.onCard, false, "focus moved onto the card");
      assert.ok(where.onPage, `focus moved to ${where.id}`);
      assert.match(where.said, /Allow this step\?/, "the card is said to screen readers");
      await page.keyboard.press("Enter");
      await page.keyboard.press(" ");
      await sleep(300);
      assert.deepEqual(await answers(page), [], "a key typed in the box answered the card");
      assert.ok(await page.$(".confirmation-bubble .confirm-risk-btn"), "the card is still waiting");
      // Once the card is answered, the cursor is back in the box with what was typed.
      await page.click(".confirmation-bubble .confirm-risk-btn");
      await deliver(page, { type: "entries", runId: "run-1", status: "running", trace: trace({}), entries: [{ k: "ask_done", id: "w1", how: "approved" }, log("system", "Allowed", "You allowed this step.")] });
      await sleep(200);
      const back = await page.evaluate(() => ({ id: document.activeElement && document.activeElement.id, value: document.getElementById("taskInput").value }));
      assert.equal(back.id, "taskInput", "the cursor is back in the box");
      assert.match(back.value, /also check the/);
      await page.close();
    });

    await check("Enter on the card's button does nothing until it has been in view for a moment, then works", async () => {
      const page = await open();
      await deliver(page, askEntries("w2"));
      await sleep(60);
      await page.focus(".confirmation-bubble .confirm-risk-btn");
      await page.keyboard.press("Enter");
      await sleep(100);
      assert.deepEqual(await answers(page), [], "Enter acted on a card that had only just arrived");
      await sleep(800);
      await page.keyboard.press("Enter");
      await sleep(150);
      const got = await answers(page);
      assert.equal(got.length, 1, `answers: ${JSON.stringify(got)}`);
      assert.equal(got[0].type, "approve");
      await page.close();
    });

    await check("a key that went down before the card arrived does nothing on it, even released late", async () => {
      const page = await open();
      await page.focus("#taskInput");
      await page.keyboard.down(" ");
      await deliver(page, askEntries("w3"));
      await sleep(900);
      // Focus lands on the button while the key is still held, as if moved there.
      await page.focus(".confirmation-bubble .confirm-risk-btn");
      // The held key repeats onto the button, then is let go there.
      await page.keyboard.down(" ");
      await page.keyboard.up(" ");
      await sleep(150);
      assert.deepEqual(await answers(page), [], "a press that began before the card answered it");
      await page.close();
    });

    await check("a pointer click on the button works at once", async () => {
      const page = await open();
      await deliver(page, askEntries("w4"));
      await sleep(80);
      await page.click(".confirmation-bubble .confirm-risk-btn");
      await sleep(150);
      const got = await answers(page);
      assert.equal(got.length, 1, `answers: ${JSON.stringify(got)}`);
      await page.close();
    });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log("\nall card key checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
