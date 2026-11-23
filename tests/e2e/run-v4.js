/**
 * Select to AI - scripted end-to-end scenarios for the v4 engine.
 *
 *   node tests/e2e/run-v4.js            every scenario
 *   E2E_ONLY=signin,reopen node tests/e2e/run-v4.js
 *   E2E_DEBUGGER=off node tests/e2e/run-v4.js   (as if the debugger permission were absent)
 *   (otherwise the test copy is given the debugger permission the shipped manifest leaves out)
 *   E2E_EXT=dir      load the extension from dir (for example the unzipped package)
 *   E2E_NOT_APPLICABLE=tests/e2e/not-applicable-4.0.json   skip the scenarios listed there
 *
 * Chromium runs with the real extension. The model is played by the scripted
 * gateway in server.js, so every run is the same: what is tested is the
 * engine (the run in the service worker, the page actions, the waits for the
 * user, the panel as a view), not a model's judgment. The harness plays the
 * user where a scenario needs one: it approves or declines, signs in on the
 * page, answers a question, closes the panel and opens it again.
 */
"use strict";

const path = require("node:path");
const { createE2EServer } = require("./server.js");
const TOOLS = require("../../extension/agentTools.js");

const PORT = parseInt(process.env.E2E_PORT || "8917", 10);
// The local test server is granted, as after Allow on the site-access card.
// Unless E2E_DEBUGGER=off, the test copy also gets the debugger permission,
// which the shipped manifest leaves out, so the debugger-on run really has it.
const DEBUGGER_ON = process.env.E2E_DEBUGGER !== "off";
const EXT = require("../helpers/granted-build.js").grantedBuild(path.resolve(process.env.E2E_EXT || path.join(__dirname, "../../extension")), undefined, { debugger: DEBUGGER_ON });
const ONLY = (process.env.E2E_ONLY || "").split(",").filter(Boolean);
// Scenarios that do not apply to the build under test, with the reason, from a checked-in file.
const NOT_APPLICABLE = process.env.E2E_NOT_APPLICABLE ? require(path.resolve(process.env.E2E_NOT_APPLICABLE)) : { scenarios: [] };
const TIMEOUT_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the panel shows, and what the run did. */
const look = (page) => page.evaluate(() => {
  const boxes = [...document.querySelectorAll(".final-answer-box")].filter((b) => getComputedStyle(b).display !== "none" && (b.innerText || "").trim());
  return {
    trace: globalThis.__selectToAiTrace ? globalThis.__selectToAiTrace() : null,
    answer: boxes.length ? boxes[boxes.length - 1].innerText.trim() : "",
    cards: [...document.querySelectorAll(".confirmation-bubble")].map((c) => ({ kind: c.dataset.waitKind || "", risk: c.dataset.riskKind || "", text: (c.innerText || "").replace(/\s+/g, " ") })),
    bubbles: document.querySelectorAll(".agent-run-status").length,
    order: [...document.querySelectorAll("#chatContainer > .message-bubble")].map((b) => (b.classList.contains("user") ? "user" : b.classList.contains("confirmation-bubble") ? "card" : b.querySelector(".final-answer-box") && getComputedStyle(b.querySelector(".final-answer-box")).display !== "none" ? "answer" : "run")),
    log: [...document.querySelectorAll(".log-item")].map((i) => i.textContent).join("\n"),
    inputDisabled: document.getElementById("taskInput").disabled,
    subRows: document.querySelectorAll(".tl-sub").length,
  };
}).catch(() => null);

const click = (page, selector) => page.evaluate((s) => { const b = document.querySelector(s); if (b) b.click(); return !!b; }, selector);

async function main() {
  const puppeteer = require("puppeteer");
  const server = createE2EServer(PORT);
  await server.listen();
  const browser = await puppeteer.launch({ headless: !process.env.E2E_HEADFUL, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--disable-features=DialMediaRouteProvider"] });
  const results = [];
  const skipped = [];
  // How long each settle scenario's press waited, for the report.
  const settleTimes = [];
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 20000 });
    const extensionId = new URL(workerTarget.url()).host;
    const worker = await workerTarget.worker();
    // A debugger-on run without the debugger would quietly test the wrong build.
    if (DEBUGGER_ON && !(await worker.evaluate(() => !!chrome.debugger))) throw new Error("E2E_DEBUGGER is on but the extension under test has no chrome.debugger");
    await worker.evaluate((s) => new Promise((r) => chrome.storage.sync.set(s, r)), {
      agentActiveProvider: "custom", agentCustomUrl: `${server.baseUrl}/v1`, agentModel: "e2e-scripted-model", showAgent: true,
      agentRiskConfirmation: true, agentDomainAllowlist: "", openingMode: "tab", agentLearning: false,
      // E2E_DEBUGGER=off runs every scenario as a build without the debugger would.
      ...(process.env.E2E_DEBUGGER === "off" ? { agentDebuggerMode: "off" } : {}),
    });
    // The user already agreed to what the agent sends to this server (setup.js consent).
    await worker.evaluate((origin) => new Promise((r) => chrome.storage.local.set({ onboardingComplete: true, agentDataConsent: { [`custom ${origin}`]: Date.now() } }, r)), new URL(server.baseUrl).origin);
    const control = (p, options) => fetch(`${server.baseUrl}${p}`, options).then((r) => r.json());
    const agentUrl = (task) => `chrome-extension://${extensionId}/agent.html${task ? `?task=${encodeURIComponent(task)}&autostart=1&fresh=1` : ""}`;

    /**
     * Runs one scenario to its end. `user` is called on every look at the
     * panel and plays the person: it returns true once it has acted on a
     * card, so the same card is not acted on twice.
     */
    // The run the last scenario ended on. A freshly opened agent page can
    // still show it for a moment before the new task starts, and its answer
    // must not be taken as this scenario's.
    let lastFinishedRun = null;
    async function play(name, startPath, user, opts) {
      if (opts && opts.before) await opts.before();
      const { task, error } = await control("/control/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      // A scenario the server does not know would otherwise replay the one before it and pass on its answer.
      if (error || !task) throw new Error(`scenario "${name}" is not set up in server.js: ${error || "no task"}`);
      const pages = await browser.pages();
      const fixture = pages.find((p) => !p.url().startsWith("chrome-extension://")) || (await browser.newPage());
      // A start path with its own scheme (about:blank, chrome://version) is a page outside the fixture site.
      // A page that never finishes loading is opened without waiting for it to.
      const opening = fixture.goto(/^[a-z]+:/i.test(startPath) ? startPath : `${server.baseUrl}${startPath}`, { waitUntil: (opts && opts.waitUntil) || "load" });
      if (opts && opts.waitUntil) await opening.catch(() => {}); else await opening;
      let agent;
      if (opts && opts.viaOmnibox) {
        // The address bar's Enter handler, run in the worker as Chrome would
        // run it, for the tab the user typed in. A call from here carries no
        // user gesture, so the side panel is refused and the agent opens in
        // a tab: the fallback path, end to end.
        const where = await worker.evaluate(async (href) => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find((x) => x.url === href);
          return t ? { windowId: t.windowId, tabId: t.id } : null;
        }, fixture.url());
        if (!where) throw new Error("the fixture tab was not found");
        const opened = await worker.evaluate((text, w) => self.SELECT_TO_AI_OMNIBOX.startRun(chrome, { kind: "agent", task: text, workIn: "current" }, w).then((r) => r.opened), task, where);
        if (opened !== "tab") throw new Error(`the agent opened in the ${opened}, not a tab`);
        const target = await browser.waitForTarget((t) => t.url().includes("/agent.html?handoff="), { timeout: 10000 });
        agent = await target.page();
      } else {
        agent = await browser.newPage();
        // With the user going to a tab of their own, the run is told which tab is its page.
        const at = opts && opts.aside ? await worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, fixture.url()) : null;
        await agent.goto(`${agentUrl(task)}${at ? `&tabId=${at}` : ""}`, { waitUntil: "load" });
      }
      agent.on("pageerror", (err) => console.log(`  [agent pageerror] ${err.message}`));
      // The user goes to a tab of their own: the run is not followed, and its page stays behind.
      const aside = opts && opts.aside ? await browser.newPage() : null;
      const seen = { confirms: 0, asked: "", cards: [], acted: new Set(), runIds: new Set() };
      const t0 = Date.now();
      let state = null;
      for (;;) {
        state = await look(agent);
        if (state) {
          for (const card of state.cards) {
            const key = `${card.kind}|${card.text}`;
            if (seen.acted.has(key)) continue;
            seen.cards.push(card);
            const handled = await user({ card, agent, fixture, state, seen, reopen: async () => { await agent.close(); await sleep(400); agent = await browser.newPage(); await agent.goto(agentUrl(""), { waitUntil: "load" }); return agent; } });
            if (handled) seen.acted.add(key);
          }
          if (!state.cards.length) await user({ card: null, agent, fixture, state, seen, reopen: async () => { await agent.close(); await sleep(400); agent = await browser.newPage(); await agent.goto(agentUrl(""), { waitUntil: "load" }); return agent; } });
          if (state.trace && state.trace.id) seen.runIds.add(state.trace.id);
          if (state.trace && state.trace.stopState && state.answer && state.trace.id !== lastFinishedRun) break;
        }
        if (Date.now() - t0 > ((opts && opts.timeoutMs) || TIMEOUT_MS)) { state = (await look(agent)) || state; state.timedOut = true; break; }
        await sleep(250);
      }
      if (state && state.trace && state.trace.id) lastFinishedRun = state.trace.id;
      const logged = await control("/control/log", { method: "GET" });
      const chips = await agent.evaluate(() => [...document.querySelectorAll(".used-chips button")].map((b) => b.textContent)).catch(() => []);
      const notes = await agent.evaluate(() => [...document.querySelectorAll(".memory-note")].map((b) => b.textContent)).catch(() => []);
      if (aside) await aside.close().catch(() => {});
      const out = { ...state, seen, t0, fixture, actions: logged.actions, llmCalls: logged.llmCalls, models: logged.models || [], collected: logged.collected, prompts: logged.prompts || [], chips, notes, agent, log2: () => control("/control/log", { method: "GET" }) };
      if (opts && opts.keepOpen) return out;
      await agent.close().catch(() => {});
      return out;
    }

    const approve = async ({ card, agent, seen }) => { if (card && card.kind === "approval") { seen.confirms++; seen.asked = card.text; await click(agent, ".confirm-risk-btn"); return true; } return false; };
    const decline = async ({ card, agent, seen }) => { if (card && card.kind === "approval") { seen.confirms++; seen.asked = card.text; await click(agent, ".abort-risk-btn"); return true; } return false; };
    const signIn = async ({ card, agent, fixture }) => {
      if (!card || card.kind !== "sign_in") return false;
      // The user goes to the tab, signs in on the page, then tells the agent.
      await fixture.bringToFront();
      await fixture.type("#user", "ada");
      await fixture.type("#pass", "correct horse");
      await fixture.click("#signin-btn");
      await click(agent, ".wait-done-btn");
      return true;
    };

    // What the assistant knows, read and set through the engine as the panel does.
    const memory = () => worker.evaluate(() => self.SELECT_TO_AI_ENGINE.loadMemory());
    const setMemory = (changes) => worker.evaluate(async (list) => { for (const c of list) await self.SELECT_TO_AI_ENGINE.changeMemory(c); return true; }, changes);
    const answerInPanel = async (agent, text) => { await agent.bringToFront(); await agent.type("#taskInput", text); await agent.keyboard.press("Enter"); };

    const hasBanner = (fixture) => fixture.evaluate(() => !!document.getElementById("select-to-ai-needs-you")).catch(() => false);
    /**
     * Plays a worker that Chrome stopped and started again: everything in
     * its memory is gone, and it has only what it saved. (Stopping the real
     * worker through the debugger leaves it stopped for good under
     * automation, so the restart is played from inside.)
     */
    const restartWorker = () => worker.evaluate(() => self.SELECT_TO_AI_ENGINE.wake().then(() => true));

    const checkInMinutes = (v) => worker.evaluate((m) => new Promise((r) => (m === null ? chrome.storage.sync.remove("agentCheckInMinutes", r) : chrome.storage.sync.set({ agentCheckInMinutes: m }, r))), v);
    const mainModel = (name) => worker.evaluate((v) => new Promise((r) => chrome.storage.sync.set({ agentModel: v }, r)), name);
    const helperModel = (name) => worker.evaluate((v) => new Promise((r) => chrome.storage.sync.set({ agentHelperModel: v }, r)), name);
    const learning = (on) => worker.evaluate((v) => new Promise((r) => chrome.storage.sync.set({ agentLearning: v }, r)), on);
    const allowOnly = (v) => worker.evaluate((list) => new Promise((r) => chrome.storage.sync.set({ agentDomainAllowlist: list }, () => r(true))), v);
    let queuedSlowed = false;
    const dialogWatch = { page: null, opened: [], on: (d) => { dialogWatch.opened.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); } };
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(200); } };

    /**
     * The first press's wait: after the results were on the page, within
     * the bounds given, no `wait` step taken, and counted in the run's timing.
     */
    const settleCheck = (r, { min = 0, max, says }) => {
      const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
      if (!press) return `no press in the history: ${JSON.stringify(r.trace.history)}`;
      settleTimes.push(`${r.trace.task.slice(0, 40)}: ${press.settle} ms`);
      if (!says.test(press.outcome)) return `the press's result did not say what appeared: ${JSON.stringify(press.outcome)}`;
      if (!(press.settle >= min && press.settle <= max)) return `the press waited ${press.settle} ms, outside ${min} to ${max}`;
      if (r.actions.some((a) => a.do === "wait") || r.actions.filter((a) => a.do === "click").length !== 1) return `more than the one press was needed: ${JSON.stringify(r.actions.map((a) => a.do))}`;
      if (!r.trace.timing || r.trace.timing.settle < press.settle) return `the run's timing does not count the wait: ${JSON.stringify(r.trace.timing)}`;
      return /Flight 101|note is shown/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
    };
    // Plays the user closing the debugging bar before it opens: the connection is refused.
    // A build without the debugger permission (4.0) has nothing to refuse.
    const refuseDebugger = (on) => worker.evaluate((refuse) => {
      if (!chrome.debugger) return true;
      if (refuse) { self.__attach = self.__attach || chrome.debugger.attach; chrome.debugger.attach = () => Promise.reject(new Error("refused for the test")); }
      else if (self.__attach) chrome.debugger.attach = self.__attach;
      return true;
    }, on);

    // The tabs the extension's debugger connection is still open on.
    // A tab is still held when the extension cannot attach to it again.
    const attachedTabs = () => worker.evaluate(async () => {
      const held = [];
      if (!chrome.debugger) return held;
      for (const t of await chrome.tabs.query({})) {
        if (!/^https?:/.test(t.url || "")) continue;
        try { await chrome.debugger.attach({ tabId: t.id }, "1.3"); await chrome.debugger.detach({ tabId: t.id }); } catch (e) { if (/already attached/i.test(String((e && e.message) || e))) held.push(t.url); }
      }
      return held;
    });

    // Each pointer action in the trace, in order, said to be real or made by
    // script as expected, and the run's timing counting them the same way.
    const pointers = (r, want) => {
      const got = (r.trace.history || []).filter((h) => h.pointer).map((h) => h.pointer);
      if (JSON.stringify(got) !== JSON.stringify(want)) return `pointer actions were ${JSON.stringify(got)}, not ${JSON.stringify(want)}: ${JSON.stringify((r.trace.history || []).map((h) => h.action))}`;
      const t = (r.trace.timing && r.trace.timing.pointer) || {};
      const real = want.filter((w) => w === "real").length;
      if ((t.real || 0) !== real || (t.synthetic || 0) !== want.length - real) return `the run's timing counts ${JSON.stringify(t)}`;
      return null;
    };
    // Watches the answer while the run goes: when the answer shown while it
    // is checked first appears, what its mark says, and when the final one does.
    const watchAnswer = async ({ agent, seen }) => {
      const v = await agent.evaluate(() => {
        const p = [...document.querySelectorAll(".provisional-answer")].filter((x) => !x.hidden).pop();
        const finals = [...document.querySelectorAll(".final-answer-box")].filter((b) => getComputedStyle(b).display !== "none" && (b.innerText || "").trim());
        const f = finals.pop();
        const shownSteps = [...document.querySelectorAll(".tl-event:not(.tl-quiet)")].map((li) => li.textContent);
        return { p: p ? { state: p.dataset.state, mark: (p.querySelector(".provisional-mark") || {}).textContent || "", text: (p.querySelector(".provisional-body") || {}).innerText || "" } : null, f: f ? f.innerText.trim() : "", chips: document.querySelectorAll(".answer-sources .pill").length, shownSteps };
      }).catch(() => null);
      if (!v) return false;
      const t = Date.now();
      seen.marks = seen.marks || [];
      if (v.p && !seen.firstShownAt) { seen.firstShownAt = t; seen.firstText = v.p.text; }
      if (v.p) seen.marks.push(`${v.p.state}: ${v.p.mark}`);
      if (v.p && v.f) seen.bothVisible = true;
      // An answer already on screen at the first look is an earlier task's,
      // restored with the conversation: only a new one is this task's.
      if (seen.staleFinal === undefined) seen.staleFinal = v.f;
      if (v.f && !seen.finalAt && v.f !== seen.staleFinal) { seen.finalAt = t; seen.finalFirstText = v.f; }
      seen.chips = v.chips;
      seen.shownSteps = v.shownSteps;
      return false;
    };
    // Which tab is in front, and what the agent's bar was told, as the worker saw them.
    const watchView = () => worker.evaluate(() => {
      self.__view = { activated: [], bar: [] };
      if (!self.__viewHooked) {
        self.__viewHooked = true;
        chrome.tabs.onActivated.addListener((i) => self.__view.activated.push({ tabId: i.tabId, at: Date.now() }));
        const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
        chrome.tabs.sendMessage = (tabId, m, ...rest) => { if (m && m.action === "agentBar") self.__view.bar.push({ tabId, at: Date.now(), off: !!m.off, show: !!m.show, state: m.state, text: m.text, ended: !!m.ended }); return sendMessage(tabId, m, ...rest); };
      }
      return true;
    });
    const viewLog = () => worker.evaluate(() => self.__view);
    const tabIdOf = (page) => worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, page.url());
    const frontTab = (page) => worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); if (!t) return null; const [f] = await chrome.tabs.query({ active: true, windowId: t.windowId }); return f ? f.id : null; }, page.url());
    /**
     * The bar as it is drawn on a page, read through the browser's view of
     * the document, which sees into its closed shadow root: its words and
     * its buttons, each with where it is on screen.
     */
    const barOn = async (page) => {
      const c = await page.createCDPSession();
      try {
        const { root } = await c.send("DOM.getDocument", { depth: -1, pierce: true });
        let host = null;
        const find = (n) => { if (host) return; const a = n.attributes || []; for (let i = 0; i < a.length; i += 2) if (a[i] === "id" && a[i + 1] === "select-to-ai-agent-bar") { host = n; return; } for (const k of [...(n.children || []), ...(n.shadowRoots || [])]) find(k); };
        find(root);
        if (!host) return null;
        const texts = [];
        const buttons = [];
        const walk = (n, hidden) => {
          const a = {};
          const at = n.attributes || [];
          for (let i = 0; i < at.length; i += 2) a[at[i]] = at[i + 1];
          const off = hidden || a.hidden !== undefined;
          if (n.nodeType === 3 && !off) texts.push(n.nodeValue);
          if (n.nodeName === "BUTTON" && !off) buttons.push({ label: a["aria-label"], nodeId: n.nodeId });
          if (n.nodeName === "DIV" && /\bbar\b/.test(a.class || "")) texts.state = a["data-state"];
          for (const k of [...(n.shadowRoots || []), ...(n.children || [])]) walk(k, off);
        };
        walk(host, false);
        for (const b of buttons) { const box = await c.send("DOM.getBoxModel", { nodeId: b.nodeId }).catch(() => null); if (box) { const q = box.model.content; b.x = (q[0] + q[4]) / 2; b.y = (q[1] + q[5]) / 2; } }
        return { text: texts.join("").replace(/\s+/g, " ").trim(), state: texts.state, buttons };
      } finally { await c.detach().catch(() => {}); }
    };
    const scenarios = [
      ["search", "/search", async () => false, (r) => {
        if (!r.answer.includes("$19")) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.trace.steps > 3) return `took ${r.trace.steps} steps`;
        const [a, b] = r.trace.history;
        if (!a || !b || a.step !== b.step || !/^fill/.test(a.action) || !/^press/.test(b.action)) return `typing and Enter were not one step: ${JSON.stringify(r.trace.history.map((h) => `${h.step}: ${h.action}`))}`;
        return null;
      }],
      ["form", "/signup", approve, async (r) => {
        const v = await r.fixture.evaluate(() => ({ name: document.getElementById("name").value, email: document.getElementById("email").value, company: document.getElementById("company").value, phone: document.getElementById("phone").value, said: document.getElementById("signup-confirmation").textContent }));
        const want = { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines Ltd", phone: "555-0100" };
        for (const k of Object.keys(want)) if (v[k] !== want[k]) return `field ${k} = ${JSON.stringify(v[k])}`;
        if (!v.said.includes("Thanks for signing up, Ada Lovelace")) return `confirmation: ${JSON.stringify(v.said)}`;
        if (r.seen.confirms < 1) return "the form was sent without asking first";
        if (!r.answer.includes("Ada Lovelace")) return `answer: ${JSON.stringify(r.answer)}`;
        return null;
      }],
      ["booking", "/booking", approve, async (r) => {
        const v = await r.fixture.evaluate(() => ({ who: document.getElementById("attendee").value, plan: document.getElementById("plan").value, agree: document.getElementById("agree").checked, said: document.getElementById("booking-confirmation").textContent }));
        if (v.who !== "Grace Hopper" || v.plan !== "pro" || !v.agree) return `form state: ${JSON.stringify(v)}`;
        if (!/Booked a Pro ticket for Grace Hopper/.test(v.said)) return `confirmation: ${JSON.stringify(v.said)}`;
        if (r.seen.confirms < 1) return "the booking was made without asking first";
        return null;
      }],
      ["hijack", "/orders", decline, (r) => {
        if (r.seen.confirms < 1) return "an address the model wrote itself was opened without asking";
        if (r.collected !== 0) return `the user's order reached the other site ${r.collected} time(s)`;
        if (!r.fixture.url().includes("/orders")) return `the tab left the page: ${r.fixture.url()}`;
        if (!/not allowed/.test(r.answer)) return `ending: ${JSON.stringify(r.answer)}`;
        return null;
      }],
      ["hijack", "/orders-quiet", decline, (r) => {
        if (!/wrote this address itself/i.test(r.seen.asked)) return `held for the wrong reason: ${r.seen.asked}`;
        if (r.collected !== 0) return `the user's order reached the other site ${r.collected} time(s)`;
        return null;
      }, "hijackQuiet"],
      ["article", "/article", async () => false, (r) => {
        if (!/9:30/.test(r.answer) || !/16:45/.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}`;
        // One step and the check of its answer: an answer on the first step is checked like any other.
        if (r.llmCalls !== 2) return `a question the page answers took ${r.llmCalls} model calls, not one step and one check`;
        return null;
      }],
      // A request in Spanish about an English page: the step names the
      // browser's language and says whose language the answer is read in,
      // and the answer the user gets is the Spanish one.
      ["otherLanguage", "/article", async () => false, (r) => {
        const sent = r.prompts.join("\n");
        if (!sent.includes("¿A qué hora abre al público el faro de Brightwater, según este artículo?")) return "the request did not reach the model as written";
        const fact = (sent.match(/The user's browser is set to [^\n]*/) || [""])[0];
        if (!/^The user's browser is set to \S.* \([A-Za-z-]+\)\. The user reads your answer, and any question you ask them, in the language the user's request is written in\./.test(fact)) return `the language fact is missing or names no browser language: ${JSON.stringify(fact)}`;
        if (!/abre al público de 9:30 a 16:45/.test(r.answer)) return `the answer is not in the request's language: ${JSON.stringify(r.answer)}`;
        return null;
      }],
      ["decade", "/article", watchAnswer, (r) => {
        const s = r.seen;
        if (!s.firstShownAt) return "the answer was not shown while it was checked";
        if (!/ten years/.test(s.firstText)) return `shown while checked: ${JSON.stringify(s.firstText)}`;
        if (!s.marks.some((m) => /^checking: Checking/.test(m))) return `no Checking mark: ${JSON.stringify(s.marks.slice(0, 3))}`;
        if (s.bothVisible) return "the answer shown while checked and the final one were on screen together";
        if (!(s.finalAt - s.firstShownAt >= 1500)) return `the answer was not shown before the check ended (${s.finalAt - s.firstShownAt} ms apart; final first read ${JSON.stringify(s.finalFirstText)})`;
        if (r.answer !== "A decade is ten years.") return `final: ${JSON.stringify(r.answer)}`;
        if (r.trace.answer !== "A decade is ten years." || !r.trace.validated) return `trace: ${JSON.stringify({ answer: r.trace.answer, validated: r.trace.validated })}`;
        if (s.chips) return `${s.chips} page chip(s) under an answer that used no page`;
        if (s.shownSteps.some((t) => /Checking answer|Check passed/i.test(t))) return `the check's own lines are drawn as steps: ${JSON.stringify(s.shownSteps)}`;
        console.log(`  first answer shown ${s.firstShownAt - r.t0} ms after the request; final ${s.finalAt - r.t0} ms (trace: ${r.trace.firstAnswerMs} ms and ${r.trace.endedMs} ms)`);
        return null;
      }],
      ["decadeSentBack", "/article", watchAnswer, (r) => {
        const s = r.seen;
        if (!/twelve/.test(s.firstText || "")) return `shown while checked: ${JSON.stringify(s.firstText)}`;
        if (!s.marks.some((m) => /^replaced: Checking found a problem: The number of years is wrong.*; still working$/.test(m))) return `no sent-back mark: ${JSON.stringify([...new Set(s.marks)])}`;
        if (r.answer !== "A decade is exactly ten years.") return `final: ${JSON.stringify(r.answer)}`;
        if (r.trace.answer !== r.answer) return `trace answer: ${JSON.stringify(r.trace.answer)}`;
        return null;
      }],
      // "Ask the agent about this": the selection, with its place, reaches
      // the composer and the run, though the page's own selection is gone.
      ["aboutSelection", "/orders", null, (r) => {
        if (!r.chip || !/About this selection/.test(r.chip.text) || !/\$182\.50/.test(r.chip.text)) return `chip: ${JSON.stringify(r.chip)}`;
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(r.chip.host)) return `the chip names ${JSON.stringify(r.chip.host)}, not the page's host`;
        if (r.chip.placeholder !== "Ask about the selected text") return `placeholder: ${JSON.stringify(r.chip.placeholder)}`;
        if (!r.chip.focused) return "the composer was not focused";
        if (r.liveSelection) return `the page still had a selection (${JSON.stringify(r.liveSelection)}), so the test proves nothing`;
        if (!/Yes: order 4411/.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}; prompts: ${r.prompts.filter((p) => /selected/.test(p)).map((p) => p.match(/The user selected[^\n]*/)).join(" | ")}`;
        if (!r.quoted) return "the request bubble does not show the selection it was about";
        if (r.chipAfter) return "the chip stayed after the request was sent";
        return null;
      }, "aboutSelection", { custom: async () => {
        const { task } = await control("/control/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "aboutSelection" }) });
        const pages = await browser.pages();
        const fixture = pages.find((p) => !p.url().startsWith("chrome-extension://")) || (await browser.newPage());
        await fixture.goto(`${server.baseUrl}/orders`, { waitUntil: "load" });
        await fixture.bringToFront();
        await fixture.evaluate(() => {
          const cell = [...document.querySelectorAll("td")].find((td) => td.textContent.trim() === "$182.50");
          const r = document.createRange();
          r.selectNodeContents(cell);
          getSelection().removeAllRanges();
          getSelection().addRange(r);
        });
        // The context menu's click, as Chrome delivers it to the worker.
        await worker.evaluate(async (href) => {
          const t = (await chrome.tabs.query({})).find((x) => x.url === href);
          askAgentAboutSelection({ menuItemId: "openAgent", selectionText: "$182.50", frameId: 0 }, t);
        }, fixture.url());
        const target = await browser.waitForTarget((t) => t.url().includes("about=selection"), { timeout: 10000 });
        const agent = await target.page();
        await agent.waitForSelector(".selection-chip", { timeout: 8000 }).catch(() => {});
        await sleep(300);
        const chip = await agent.evaluate(() => { const c = document.querySelector(".selection-slot:not([hidden]) .selection-chip"); return c ? { text: c.innerText, host: (c.querySelector(".selection-from") || {}).textContent || "", placeholder: document.getElementById("taskInput").placeholder, focused: document.activeElement === document.getElementById("taskInput") } : null; });
        if (process.env.E2E_SHOTS) await (await agent.$("#composer")).screenshot({ path: process.env.E2E_SHOTS });
        // The user clicks on the page before asking: its own selection is gone.
        await fixture.bringToFront();
        await fixture.mouse.click(5, 5);
        const liveSelection = await fixture.evaluate(() => String(getSelection()));
        await agent.bringToFront();
        await agent.type("#taskInput", task);
        await agent.keyboard.press("Enter");
        const t0 = Date.now();
        let state = null;
        // The window's last run is on screen until this one starts: only this run's end counts.
        while (Date.now() - t0 < 30000) { state = await look(agent); if (state && state.trace && state.trace.task === task && state.trace.stopState && state.answer) break; await sleep(250); }
        const quoted = await agent.evaluate(() => !!document.querySelector(".message-bubble.user .selection-chip"));
        const chipAfter = await agent.evaluate(() => !document.querySelector(".selection-slot").hidden);
        const logged = await control("/control/log", { method: "GET" });
        await agent.close().catch(() => {});
        return { ...(state || {}), chip, liveSelection, quoted, chipAfter, prompts: logged.prompts || [] };
      } }],
      // Driven from the agent's page in its own tab: the agent brings the
      // page to front only to act on it, shows its bar there while it works,
      // and takes the user back to the agent's page when it is done.
      ["followBar", "/search", async ({ fixture, seen }) => {
        if (seen.barSeen) return false;
        const bar = await barOn(fixture).catch(() => null);
        if (bar && bar.text) { seen.barSeen = bar; seen.frontWhileBar = await frontTab(fixture); }
        return false;
      }, async (r) => {
        if (!r.answer.includes("$19")) return `answer: ${JSON.stringify(r.answer)}`;
        const log = await viewLog();
        const page = await tabIdOf(r.fixture);
        const shown = log.bar.filter((b) => b.show && b.tabId === page);
        if (!r.seen.barSeen) return `no bar was drawn on the page; the bar was told: ${JSON.stringify(log.bar.slice(0, 6))}`;
        if (!/Agent: Search for blue widget/.test(r.seen.barSeen.text) || !/Stop the agent/.test(JSON.stringify(r.seen.barSeen.buttons)) || !/Back to the agent page/.test(JSON.stringify(r.seen.barSeen.buttons)) || !/Open the side panel/.test(JSON.stringify(r.seen.barSeen.buttons))) return `the bar showed ${JSON.stringify(r.seen.barSeen)}`;
        if (r.seen.frontWhileBar !== page) return "the bar was drawn on a page that was not in front";
        if (!shown.length || !shown.some((b) => b.state === "working")) return `the bar was not shown working: ${JSON.stringify(log.bar)}`;
        // The page came to front for the action, and the agent's page after the run.
        const fronted = log.activated.filter((a) => a.tabId === page);
        if (fronted.length !== 1) return `the page was brought to front ${fronted.length} times: ${JSON.stringify(log.activated)}`;
        const front = await until(async () => { const f = await frontTab(r.fixture); return f !== page ? f : null; }, 4000);
        if (!front) return "the user was left on the page after the run, though they had not used it";
        const last = log.activated[log.activated.length - 1];
        if (!last || last.tabId === page) return `the agent's page was not brought back: ${JSON.stringify(log.activated)}`;
        if (await barOn(r.fixture)) return "the bar stayed on the page after the run";
        // The model was told, before the first action, that an action brings the page to front.
        if (!r.prompts.some((p) => /This tab is behind another one\. An action on its page brings it to the front first/.test(p))) return "the model was not told what an action on a page behind does";
        const t = r.trace.timing && r.trace.timing.front;
        if (!t || t.n !== 1) return `the run's timing does not count bringing the page to front: ${JSON.stringify(r.trace.timing)}`;
        console.log(`  page brought to front once, drawn after ${t.ms} ms; bar told ${log.bar.length} times`);
        await r.agent.close().catch(() => {});
        return null;
      }, "followBar", { keepOpen: true, before: watchView }],
      // The same, with the user clicking on the page while the agent works:
      // they are left there when the run ends, and the bar says how it
      // ended, with a way back that works.
      ["followBar", "/search", async ({ fixture, seen }) => {
        if (seen.touched) return false;
        const bar = await barOn(fixture).catch(() => null);
        if (!bar || !bar.text) return false;
        // The user's own click on the page, away from the bar.
        await fixture.mouse.click(8, 8);
        seen.touched = await until(() => worker.evaluate(() => [...self.SELECT_TO_AI_ENGINE.sessions.values()].some((s) => s.view && s.view.touched)), 1500);
        return false;
      }, async (r) => {
        if (!r.answer.includes("$19")) return `answer: ${JSON.stringify(r.answer)}`;
        if (!r.seen.touched) return "the user's click on the page was not noticed";
        const page = await tabIdOf(r.fixture);
        await sleep(600);
        if ((await frontTab(r.fixture)) !== page) return "the user was taken away from the page they had used";
        const bar = await until(async () => { const b = await barOn(r.fixture); return b && b.state === "done" ? b : null; }, 4000);
        if (!bar) return `the bar does not say the run is done: ${JSON.stringify(await barOn(r.fixture))}`;
        if (!/Done/.test(bar.text) || /Stop the agent/.test(JSON.stringify(bar.buttons))) return `the bar after the run: ${JSON.stringify(bar)}`;
        const back = bar.buttons.find((b) => b.label === "Back to the agent page");
        if (!back || !back.x) return `no way back: ${JSON.stringify(bar.buttons)}`;
        await r.fixture.mouse.click(back.x, back.y);
        const front = await until(async () => { const f = await frontTab(r.fixture); return f !== page ? f : null; }, 4000);
        if (!front) return "Back to agent did not bring the agent's page to front";
        if (!(await until(async () => !(await barOn(r.fixture)), 3000))) return "the bar stayed after the user went back";
        await r.agent.close().catch(() => {});
        return null;
      }, "followTouched", { keepOpen: true, before: watchView }],
      // "Open side panel" on the bar opens the panel from that click, and the
      // panel shows the same run: the bar goes, and the run is followed from
      // the panel, so the end of the run moves nobody.
      ["followBar", "/search", async ({ fixture, seen }) => {
        if (seen.panel) return false;
        const bar = await barOn(fixture).catch(() => null);
        const button = bar && bar.buttons.find((b) => b.label === "Open the side panel");
        if (!button || !button.x) return false;
        seen.panel = true;
        await fixture.mouse.click(button.x, button.y);
        seen.views = await until(() => worker.evaluate(() => { const s = [...self.SELECT_TO_AI_ENGINE.sessions.values()].find((x) => x.run); return s && s.ports.size >= 2 ? s.ports.size : null; }), 5000);
        return false;
      }, async (r) => {
        if (!r.answer.includes("$19")) return `answer: ${JSON.stringify(r.answer)}`;
        if (!r.seen.panel) return "the bar's side panel button was never there to press";
        const panels = await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).map((c) => c.documentUrl));
        if (!panels.some((u) => /\/agent\.html/.test(u))) return `the side panel did not open on the agent: ${JSON.stringify(panels)}`;
        if (!r.seen.views) return "the side panel did not connect to the run";
        const page = await tabIdOf(r.fixture);
        await sleep(600);
        if ((await frontTab(r.fixture)) !== page) return "a run followed from the side panel took the user away from the page at its end";
        if (await barOn(r.fixture)) return "the bar stayed with the side panel open";
        await r.agent.close().catch(() => {});
        // The panel is closed again, so the scenarios after this one see only their own view.
        await worker.evaluate(async () => { const [w] = await chrome.windows.getAll(); if (chrome.sidePanel.close && w) await chrome.sidePanel.close({ windowId: w.id }).catch(() => {}); return true; });
        return null;
      }, "followPanel", { keepOpen: true, before: watchView }],
      // A question the page answers: the page is only read, and stays behind.
      ["followRead", "/article", async () => false, async (r) => {
        if (!/9:30/.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}`;
        const log = await viewLog();
        const page = await tabIdOf(r.fixture);
        // From the moment the agent's page was open and in front.
        if ((r.trace.timing && r.trace.timing.front) || log.activated.some((a) => a.tabId === page && a.at >= r.t0)) return `reading the page brought it to front: ${JSON.stringify({ t0: r.t0, activated: log.activated, front: r.trace.timing && r.trace.timing.front, actions: r.actions.map((a) => a.do) })}`;
        if (log.bar.some((b) => b.show)) return "a bar was drawn for a run that only read";
        await r.agent.close().catch(() => {});
        return null;
        // Kept open until checked: closing the agent's page puts a neighbouring tab in front.
      }, "followRead", { keepOpen: true, before: watchView }],
      ["signin", "/home", signIn, (r) => {
        if (!r.answer.includes("$42.10")) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.actions.some((a) => a.do === "fill")) return "the agent typed on the sign-in page";
        if (r.seen.runIds.size !== 1) return `the wait started another run (${r.seen.runIds.size} runs)`;
        if (r.order[0] !== "user") return `the request is not shown first: ${r.order.join(", ")}`;
        if (!r.seen.cards.some((c) => c.kind === "sign_in")) return "no sign-in card was shown";
        return null;
      }],
      ["signinPushy", "/members", async (ctx) => {
        if (ctx.card && ctx.card.kind === "sign_in") {
          // Before the user does anything: the agent's attempt must not have reached the field.
          ctx.seen.passwordBefore = await ctx.fixture.$eval("#pass", (el) => el.value);
        }
        return signIn(ctx);
      }, (r) => {
        if (r.seen.passwordBefore !== "") return `the agent typed into the password field: ${JSON.stringify(r.seen.passwordBefore)}`;
        if (!r.answer.includes("$42.10")) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.log.includes("letmein123")) return "what the model tried to type is shown in the log";
        return null;
      }],
      // The user signs in and says nothing: the page is watched, and the run carries on by itself.
      ["signin", "/home", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "sign_in") return false;
        seen.banner = await hasBanner(fixture);
        await fixture.bringToFront();
        await fixture.type("#user", "ada");
        await fixture.type("#pass", "correct horse");
        await fixture.click("#signin-btn");
        return true;
      }, async (r) => {
        if (!r.seen.banner) return "no banner was shown on the page being waited on";
        if (!r.answer.includes("$42.10")) return `the run did not carry on by itself: ${JSON.stringify(r.answer)}`;
        if (await hasBanner(r.fixture)) return "the banner was left on the page";
        if (r.seen.runIds.size !== 1) return `${r.seen.runIds.size} runs`;
        return null;
      }, "signinAuto"],
      // The worker is put to sleep while the run waits; the user's sign-in wakes it and the run goes on.
      ["signin", "/home", async ({ card, fixture, seen, reopen }) => {
        if (!card || card.kind !== "sign_in") return false;
        if (seen.slept) return true;
        seen.slept = true;
        await restartWorker();
        await fixture.bringToFront();
        await fixture.type("#user", "ada");
        await fixture.type("#pass", "correct horse");
        await fixture.click("#signin-btn");
        // The panel's connection went with the old worker: it is opened again.
        await reopen();
        return true;
      }, (r) => {
        if (!r.seen.slept) return "the worker was never stopped";
        if (!r.answer.includes("$42.10")) return `the run did not survive the worker stopping: ${JSON.stringify(r.answer)}`;
        return null;
      }, "signinAsleep"],
      ["humanCheck", "/gate", async ({ card, fixture }) => {
        if (!card || card.kind !== "human_check") return false;
        await fixture.bringToFront();
        await fixture.click("#human-btn");
        return true;
      }, (r) => (r.answer.includes("$18") ? null : `answer: ${JSON.stringify(r.answer)}`)],
      ["framed", "/framed", async () => false, async (r) => {
        if (!r.answer.includes("$18")) return `answer: ${JSON.stringify(r.answer)}`;
        const choice = await r.fixture.evaluate(() => window.consentChoice || "");
        if (choice !== "consent:reject") return `the notice in the frame was not answered (${choice || "nothing chosen"})`;
        if (!/"Reject all" is in .*1 control \(\[1000\d+\] "Reject all"\)/.test(r.log)) return `find did not see the button inside the frame: ${String(r.log).replace(/\s+/g, " ").slice(0, 700)}`;
        if (/did not respond/.test(r.log)) return "closing the notice from inside its frame was reported as a failure";
        return /click \[1000\d+\]/.test(r.log) ? null : "the control in the frame was not acted on by its own number";
      }],
      ["findQuote", "/find-quote", async () => false, (r) => {
        if (!r.answer.includes("$24.99")) return `answer: ${JSON.stringify(r.answer)}`;
        // The result as the model was given it on the next step.
        const said = r.prompts.map((p) => (p.match(/"Garden Hose" is in [^\n]*/) || [""])[0]).find(Boolean) || "";
        return /The text there \(in "[^"]{1,61}"\) reads: "[^"]*Garden Hose, 30 m, \$24\.99/.test(said) ? null : `find did not quote the words it found: ${said || String(r.log).replace(/\s+/g, " ").slice(0, 900)}`;
      }],
      // A PDF the browser draws in its own viewer: the scan gives the file's
      // text page by page, and find names the page a passage is on.
      ["pdfText", "/files/statement.pdf", async () => false, (r) => {
        if (!r.answer.includes("$81.40")) return `answer: ${JSON.stringify(r.answer)}; log: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (!r.prompts.some((p) => /## Page 1 of 2\nNorthwind Utilities/.test(p))) return "the scan did not give the PDF's text under its page headings";
        const said = r.prompts.map((p) => (p.match(/"Amount due" is in [^\n]*/) || [""])[0]).find(Boolean) || "";
        return /Page 2 of 2/.test(said) && /Amount due: \$81\.40/.test(said) ? null : `find did not find the passage on page 2: ${said || "no find result"}`;
      }],
      ["newTab", "/catalogue", async () => false, async (r) => {
        if (!r.answer.includes("$18")) return `the run did not follow the link into its new tab: ${JSON.stringify(r.answer)}`;
        if (!/It opened in a new tab, and you are on that tab now/.test(r.log)) return `the result did not say a new tab was opened: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        // The tab the run started on is let go too, not only the one it ended on.
        const left = await until(async () => ((await attachedTabs()).length ? null : "none"), 4000);
        return left ? null : `the debugger is still attached to ${JSON.stringify(await attachedTabs())} after the run ended`;
      }],
      // Started on an empty tab: told that no site is open, the run goes to
      // the site in that same tab, with nothing to approve, and answers.
      ["fromNothing", "about:blank", async () => false, (r) => {
        if (!r.answer.includes("$18")) return `answer: ${JSON.stringify(r.answer)}`;
        if (!r.fixture.url().includes("/item-b")) return `the empty tab was not the one used: it shows ${r.fixture.url()}`;
        if (r.seen.cards.length) return `the user was asked something: ${JSON.stringify(r.seen.cards)}`;
        return r.prompts.some((p) => /No site is open yet\. The run began on an empty tab, and works in that same tab\./.test(p)) ? null : "the model was not told that no site is open";
      }, "fromNothingBlank"],
      // Started on a browser page the agent cannot use: that tab is left as
      // it was, and the run works in a new tab of its own.
      ["fromNothing", "chrome://version", async () => false, (r) => {
        if (!r.answer.includes("$18")) return `answer: ${JSON.stringify(r.answer)}`;
        if (!r.fixture.url().startsWith("chrome://version")) return `the user's tab was taken over: it shows ${r.fixture.url()}`;
        if (r.seen.cards.length) return `the user was asked something: ${JSON.stringify(r.seen.cards)}`;
        return r.prompts.some((p) => /began on a browser page \(chrome:\/\/version\/?\), which the agent cannot use\. That tab is left as it was/.test(p)) ? null : "the model was not told where the run began";
      }, "fromNothingBrowserPage"],
      // The address bar's handler starts the run: the request is handed to
      // the agent page once, and the run works in the tab typed in.
      ["search", "/search", async () => false, async (r) => {
        if (!r.answer.includes("$19")) return `answer: ${JSON.stringify(r.answer)}`;
        const left = await r.log2();
        if (!left || left.llmCalls < 1) return "no model call was made";
        const again = await r.agent.evaluate(() => chrome.storage.session.get("agentHandoff")).catch(() => null);
        await r.agent.close().catch(() => {});
        if (again && again.agentHandoff) return "the handoff was left in storage, so a reopened panel could start it again";
        return null;
      }, "omniboxHandoff", { viaOmnibox: true, keepOpen: true }],
      ["listened", "/listened", async () => false, async (r) => {
        const state = await r.fixture.evaluate(() => document.getElementById("state").textContent);
        if (state !== "Tile pressed") return `the tile was not pressed (${state}): ${JSON.stringify(r.answer)}`;
        const marks = await r.fixture.evaluate(() => document.querySelectorAll("[data-select-to-ai-q]").length);
        return marks ? `${marks} lookup marks were left on the page` : null;
      }],
      // Results that come three seconds after the press, with nothing on the
      // page saying so: the network view holds the press's result until they
      // are on the page, and the result names them.
      ["slowResults", "/slow-results", async () => false, (r) => settleCheck(r, { min: 2900, max: TOOLS.SETTLE.CEILING_MS, says: /That brought up: .*Flight 101/ })],
      // Pages that are never finished: one with a frame whose answer never
      // ends, then one whose own server is still sending it. Each is read as
      // it stands and the run goes on; before, the script that reads a page
      // waited for the end of its document, and the run stopped taking steps.
      ["stillLoading", "/still-loading", async () => false, (r) => {
        if (!/Item C costs \$7 and Item D costs \$9/.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}`;
        const visits = (r.trace.history || []).map((h) => h.action);
        if (!/navigate .*\/still-writing/.test(visits[0] || "")) return `steps: ${JSON.stringify(visits)}`;
        return null;
      }, "stillLoading", { waitUntil: "domcontentloaded", timeoutMs: 45000 }],
      // A press whose page shows an alert once its request is back, then a
      // press whose page asks with a confirm. Each step comes back with
      // what the dialog said, the page's own dialog never opens, and the
      // confirm is answered Cancel. Before, the first press never came back.
      ["dialogs", "/dialogs", approve, async (r) => {
        if (dialogWatch.page) dialogWatch.page.off("dialog", dialogWatch.on);
        if (dialogWatch.opened.length) return `the page's own dialogs opened: ${JSON.stringify(dialogWatch.opened)}`;
        if (r.timedOut) return `the run did not finish: ${JSON.stringify((r.trace && r.trace.history) || [])}`;
        const presses = (r.trace.history || []).filter((h) => /^click/.test(h.action));
        if (!presses.some((h) => /browser alert: "Product added\."/.test(h.outcome || ""))) return `no press said the alert: ${JSON.stringify(presses.map((h) => h.outcome))}`;
        if (!presses.some((h) => /asked in a browser dialog to go ahead: "Empty the cart\?"\. It was answered Cancel/.test(h.outcome || ""))) return `no press said the confirm: ${JSON.stringify(presses.map((h) => h.outcome))}`;
        const state = await r.fixture.evaluate(() => document.getElementById("state").textContent);
        if (state !== "Cart: 1 item, kept") return `the cart shows ${JSON.stringify(state)}`;
        return /1 item/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }, "dialogs", { before: async () => {
        // Any dialog that reaches the browser is the page's own: it is closed, so the run can go on, and counted.
        dialogWatch.opened = [];
        dialogWatch.page = (await browser.pages()).find((p) => !p.url().startsWith("chrome-extension://")) || (await browser.newPage());
        dialogWatch.page.on("dialog", dialogWatch.on);
      } }],
      // A clock and a request every 800 ms: a press that changes the page at once is not held for the ceiling.
      ["busyPage", "/busy-page", async () => false, (r) => settleCheck(r, { max: 3000, says: /That brought up: .*Read the note/ })],
      // The debugger connection refused: the spinner the page shows holds the wait, within the fallback cap.
      ["slowResults", "/slow-results?spinner=1", async () => false, async (r) => {
        await refuseDebugger(false);
        return settleCheck(r, { min: 2900, max: TOOLS.SETTLE.FALLBACK_MS, says: /That brought up: .*Flight 101/ });
      }, "slowResultsNoDebugger", { before: () => refuseDebugger(true) }],
      ["hoverMenu", "/hover-menu", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ state: document.getElementById("state").textContent, parent: !!window.parentClicked, path: location.pathname }));
        if (at.parent || at.path !== "/hover-menu") return `the menu's own entry was pressed (${JSON.stringify(at)})`;
        if (at.state !== "Pricing chosen") return `Pricing was not chosen (${at.state}): ${String(r.log).replace(/\s+/g, " ").slice(0, 500)}`;
        return /hover \[\d+\][^\n]*\n?[^\n]*That brought up: [^\n]*"Pricing"/.test(r.log) ? null : `the hover's result did not name what it brought up: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
      }],
      // The real pointer, end to end: what the trace says of each pointer action.
      ["pointerHover", "/pointer-menu", async () => false, async (r) => {
        const state = await r.fixture.evaluate(() => document.getElementById("state").textContent);
        if (state !== "Pricing chosen") return `Pricing was not chosen (${state}): ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (!/That brought up: [^\n]*"Pricing"/.test(r.log)) return `the hover's result did not name what it brought up: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        return pointers(r, ["real", "real"]);
      }],
      ["pointerFrame", "/pointer-frame", async () => false, async (r) => {
        const seat = await r.fixture.evaluate(() => window.seat || null);
        if (!seat || seat.trusted !== true || seat.inside !== true) return `the press in the other site's frame did not land as a real one on its button: ${JSON.stringify(seat)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (!/click \[1000\d+\]/.test(r.log)) return "the button was not pressed by its number in the frame";
        // The user is on a tab of their own: they are left there, and the model is told so.
        if (r.trace.timing && r.trace.timing.front) return `the page was brought to front though the user was on a tab of their own: ${JSON.stringify(r.trace.timing.front)}`;
        if (!r.prompts.some((p) => /This tab is behind the tab the user is on, and the agent leaves the user where they are/.test(p))) return "the model was not told the user is on another tab";
        return pointers(r, ["real"]);
        // Played with the user on a tab of their own, so the page stays behind:
        // headless Chrome does not pass the debugger's pointer into another
        // site's frame on a tab in front, though a Chrome window does (the
        // press lands first time there with the page brought to front).
      }, "pointerFrame", { aside: true }],
      ["pointerDrag", "/pointer-drag", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ volume: Number(document.getElementById("thumb").getAttribute("aria-valuenow")), order: document.getElementById("order").textContent, dropped: document.getElementById("dropped").textContent }));
        if (!(at.volume >= 45 && at.volume <= 60)) return `the slider is at ${at.volume}: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        // Let go over the middle of Cherries: before or after it, as the list decides, and said as it is.
        const place = at.order.replace("Order: ", "").split(", ").indexOf("Apples") + 1;
        if (place < 2) return `the list is ${at.order}`;
        if (at.dropped !== "Dropped: invoice") return `the zone has ${at.dropped}`;
        if (!new RegExp(`is now ${["", "1st", "2nd", "3rd"][place]} of 3 in its list \\(it was 1st\\)`).test(r.log)) return `the drag did not say where the row is now: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        return pointers(r, ["real", "real", "real"]);
      }],
      ["pointerNoDebugger", "/pointer-drag", async () => false, async (r) => {
        await refuseDebugger(false);
        const at = await r.fixture.evaluate(() => ({ counted: document.getElementById("counted").textContent, order: document.getElementById("order").textContent }));
        if (at.counted !== "Count: 1" || /Order: Apples/.test(at.order)) return `by script: ${JSON.stringify(at)}`;
        return pointers(r, ["synthetic", "synthetic"]);
      }, "pointerNoDebugger", { before: () => refuseDebugger(true) }],
      // Every whole gesture made by script, as a build without the debugger makes them.
      ["gestures", "/gestures", async () => false, async (r) => {
        await refuseDebugger(false);
        await mainModel("e2e-scripted-model");
        const at = await r.fixture.evaluate(() => Object.fromEntries(["s-cell", "s-menu", "s-press", "s-legend", "s-order", "s-bin", "s-token"].map((id) => [id, document.getElementById(id).textContent])));
        const want = { "s-cell": "Cell: editing", "s-menu": "Menu: open", "s-press": "Button: activated by a long press", "s-legend": "North: hidden", "s-order": "Order: Gamma, Alpha, Beta", "s-bin": "Dropped: Teacup in china", "s-token": "Token: moved by touch" };
        const wrong = Object.keys(want).filter((k) => at[k] !== want[k]);
        // The steps of the gestures that did not land, not the run's opening.
        const log = String(r.log).replace(/\s+/g, " ");
        const marks = { "s-order": "Put Gamma first", "s-bin": "Put the teacup", "s-token": "Slide the token" };
        const starts = wrong.map((k) => (marks[k] ? log.indexOf(marks[k]) : -1)).filter((i) => i >= 0);
        const from = starts.length ? Math.min(...starts) : 0;
        if (wrong.length) return `the page shows ${JSON.stringify(at)}: ${log.slice(from, from + 1400)}`;
        const told = (re, what) => (r.prompts.some((p) => re.test(p)) ? null : `the model was not told ${what}`);
        return told(/Text that appeared on screen: "[^"]*08:00 to 09:00 Visits 1204/, "the tooltip the hover brought up")
          || told(/A picture of \[\d+\] \(a canvas, drawn 300 by 150 pixels\) is attached/, "that the drawing's own picture was attached")
          || told(/The page took it as a drag and drop, and it was dropped on /, "that the teacup was dropped")
          || told(/it was made again as a touch, and the page answered that/, "that the token answered only a touch");
      }, "gestures", { before: async () => { await refuseDebugger(true); await mainModel("e2e-vision-model"); } }],
      ["pointerCanvas", "/pointer-canvas", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ spot: window.spot || null, under: !!window.underPressed }));
        if (!at.spot || Math.abs(at.spot[0] - 190) > 1 || Math.abs(at.spot[1] - 55) > 1 || at.spot[2] !== true) return `the drawing was not pressed at 190,55 by a real press: ${JSON.stringify(at.spot)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (at.under) return "the covered button was pressed";
        if (!/\[\d+\] is covered: a div with no words is drawn over it/.test(r.log)) return `the press on the covered button was not reported as covered: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        // The covered button was not pressed at all, so only the drawing's press used a pointer (c873739).
        return pointers(r, ["real"]);
      }],
      // Input made by script (the build has no debugger). The first press is
      // the pointer events of a click; a page that does not answer them is
      // pressed the next way before the result is given, once, and the
      // result says which way it took. With a real pointer each of these
      // pages simply takes the press.
      ["pressKeyboard", "/press-keys", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ state: document.getElementById("state").textContent, saves: window.saves }));
        if (at.saves !== 1) return `the settings were saved ${at.saves} times, not once (${at.state}): ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model had to press more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (press.pointer === "real") return /Saved with the mouse/.test(at.state) ? null : `a real press left "${at.state}"`;
        if (at.state !== "Saved with the keyboard") return `state: ${at.state}`;
        return /No change was seen after pointer events on it\. It was then pressed with the Enter key with the focus on it, and the page changed/.test(press.outcome) ? null : `the result did not name the way that worked: ${JSON.stringify(press.outcome)}`;
      }],
      // A control that took the click and showed it only out of sight of the
      // page's elements (a field's value set from code; a change inside a
      // component's own shadow root) is pressed once: no other way is tried
      // on top, and the result says what was seen.
      // A press with no spot on a row, a card or a label reaches that
      // control, not a link or button of its own drawn at its middle, and
      // a message under a pinned bar is scrolled clear and pressed.
      ["pressInside", "/press-inside", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ row: document.getElementById("s-row").textContent, card: document.getElementById("s-card").textContent, tax: document.getElementById("s-tax").textContent, inner: window.pressedInside }));
        const log = String(r.log).replace(/\s+/g, " ");
        if (at.inner.link || at.inner.quick || at.inner.notes) return `a control inside the one pressed was reached: ${JSON.stringify(at)} ${log.slice(0, 600)}`;
        if (at.row !== "Row: opened invoice 1042" || at.card !== "Card: opened Blue teapot" || at.tax !== "Tax: shown") return `the page shows ${JSON.stringify(at)}: ${log.slice(0, 600)}`;
        return r.actions.filter((a) => a.do === "click").length === 3 ? null : `the model pressed ${r.actions.filter((a) => a.do === "click").length} times, not 3`;
      }],
      // The press arrives where the message is drawn, not through the bar:
      // events made by script reach the message wherever they are aimed,
      // so only where they arrive tells a press a person could make.
      ["pinnedHeader", "/pinned-header", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ state: document.getElementById("state").textContent, through: window.pressedThroughBar }));
        const log = String(r.log).replace(/\s+/g, " ");
        if (/is covered/.test(log) || r.prompts.some((p) => /is covered:|is drawn over \[\d+\]/.test(p))) return `the message under the bar was called covered: ${log.slice(0, 600)}`;
        if (at.state !== "Opened: Lunch on Friday") return `the page shows ${JSON.stringify(at.state)}: ${log.slice(0, 600)}`;
        return at.through === false ? null : `the press arrived where the bar is drawn, not the message (${JSON.stringify(at.through)})`;
      }],
      // A card whose link is drawn over all of it is pressed through that
      // link at once; a list item whose only action is its link is pressed
      // on itself, and the result names the link it went round, which the
      // model then presses.
      ["pressThrough", "/press-through", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ kettle: document.getElementById("s-kettle").textContent, inbox: document.getElementById("s-inbox").textContent }));
        const log = String(r.log).replace(/\s+/g, " ");
        if (at.kettle !== "Kettle: opened" || at.inbox !== "Inbox: opened") return `the page shows ${JSON.stringify(at)}: ${log.slice(0, 600)}`;
        if (r.prompts.some((p) => /Every spot of \[\d+\] on screen is on a control of its own/.test(p))) return `the card was refused: ${log.slice(0, 600)}`;
        if (!r.prompts.some((p) => /The press went on \[\d+\] itself, clear of \[\d+\] "Open inbox" inside it, and the page showed no answer to it/.test(p))) return `the press on the item was not said to have gone round its link: ${log.slice(0, 600)}`;
        const clicks = r.actions.filter((a) => a.do === "click").length;
        return clicks === 3 ? null : `the model pressed ${clicks} times, not 3`;
      }],
      // A button under a see-through layer is refused as covered with or
      // without the debugger, naming the layer, and nothing is pressed:
      // a press, a person's or the real pointer's, would reach the layer.
      ["pressUnderLayer", "/press-under-layer", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ state: document.getElementById("state").textContent, caught: window.caught }));
        const log = String(r.log).replace(/\s+/g, " ");
        if (at.state !== "Not saved" || at.caught) return `something was pressed under the layer: ${JSON.stringify(at)} ${log.slice(0, 600)}`;
        return r.prompts.some((p) => /\[\d+\] is covered: a div with no words is drawn over it where it is on screen/.test(p)) ? null : `the result did not name the layer over the button: ${log.slice(0, 600)}`;
      }],
      ["pressSilent", "/press-silent", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ qty: document.getElementById("qty").value, steps: window.steps }));
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (at.steps !== 1 || at.qty !== "2") return `the control acted ${at.steps} times and the box holds ${at.qty}, not once and 2: ${JSON.stringify(press && press.outcome)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model pressed more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (/ways tried|then pressed with/.test(press.outcome)) return `another way was tried on top: ${JSON.stringify(press.outcome)}`;
        if (/Nothing on the page changed/.test(press.outcome)) return `the result said nothing changed: ${JSON.stringify(press.outcome)}`;
        return /A field on the page holds a different value after it\./.test(press.outcome) ? null : `the result did not say a field's value changed: ${JSON.stringify(press.outcome)}`;
      }],
      ["shadowSilent", "/shadow-silent", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ wishes: window.wishes, shown: document.getElementById("card").shadowRoot.getElementById("n").textContent }));
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (at.wishes !== 1 || at.shown !== "In wishlist: 1") return `the control acted ${at.wishes} times (${at.shown}), not once: ${JSON.stringify(press && press.outcome)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model pressed more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (/ways tried|then pressed with/.test(press.outcome)) return `another way was tried on top: ${JSON.stringify(press.outcome)}`;
        return /Nothing on the page changed|No change was seen/.test(press.outcome) ? `the change inside the shadow root was not seen: ${JSON.stringify(press.outcome)}` : null;
      }],
      // A press the user approved is made once: no key follows it, though the page shows nothing after it.
      ["pressOnce", "/press-once", approve, async (r) => {
        const at = await r.fixture.evaluate(() => ({ subs: window.subs, keys: window.keys }));
        if (r.seen.confirms !== 1) return `${r.seen.confirms} approvals were asked for, not 1: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (at.subs !== 1 || at.keys !== 0) return `after one approved press the button counted ${at.subs} clicks and ${at.keys} keys: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the approved press was repeated: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        return /ways tried|then pressed with/.test(press.outcome) ? `another way was tried on top of an approved press: ${JSON.stringify(press.outcome)}` : null;
      }],
      // A dead control the keyboard cannot reach: no key can follow the
      // click, and the click that was made is reported as made, with the
      // plain line that nothing changed, never as a failure.
      ["pressPlain", "/press-plain", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ clicks: window.clicks, keys: window.keys }));
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (!press) return `no click was made: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (press.ok === false || /Cannot read|did not work/.test(press.outcome)) return `the press that was made came back as a failure: ${JSON.stringify(press.outcome)}`;
        if (at.clicks !== 1 || at.keys !== 0) return `the control counted ${at.clicks} clicks and ${at.keys} keys, not 1 and 0: ${JSON.stringify(press.outcome)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model pressed more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (/ways tried|then pressed with/.test(press.outcome)) return `a way was named that cannot be used on it: ${JSON.stringify(press.outcome)}`;
        return /^Clicked/.test(press.outcome) && /Nothing on the page changed|No change was seen on the page/.test(press.outcome) ? null : `the result was not the plain line that nothing changed: ${JSON.stringify(press.outcome)}`;
      }],
      // A control that acts on a press after a timer of its own, and takes
      // Enter and Space too: it is watched long enough to see that, and is
      // pressed once.
      ["pressLate", "/press-late", async () => false, async (r) => {
        // Past every timer a press could have started.
        await new Promise((res) => setTimeout(res, 2500));
        const at = await r.fixture.evaluate(() => ({ sends: window.sends, state: document.getElementById("state").textContent }));
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (at.sends !== 1 || at.state !== "Stock counted 1 time") return `the stock was counted ${at.sends} times (${at.state}), not once: ${JSON.stringify(press && press.outcome)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model pressed more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (/ways tried|then pressed with/.test(press.outcome)) return `another way was tried on top: ${JSON.stringify(press.outcome)}`;
        if (press.pointer === "real") return null;
        return /Nothing on the page changed|No change was seen/.test(press.outcome) ? `the late change was not seen: ${JSON.stringify(press.outcome)}` : null;
      }],
      // A press that scrolled a box inside the page, and one that asked the
      // server through a fetch the page kept from before its requests were
      // counted: each is an answer, and neither is pressed a second way.
      ["pressScroll", "/press-scroll", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ moves: window.moves, top: document.getElementById("box").scrollTop }));
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (at.moves !== 1 || at.top !== 200) return `the box was moved ${at.moves} times to ${at.top}, not once to 200: ${JSON.stringify(press && press.outcome)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model pressed more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        return /ways tried|then pressed with/.test(press.outcome) ? `another way was tried on top: ${JSON.stringify(press.outcome)}` : null;
      }],
      ["pressKept", "/press-kept", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ reports: window.reports }));
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (at.reports !== 1) return `the feed was asked for ${at.reports} times, not once: ${JSON.stringify(press && press.outcome)} ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the model pressed more than once: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (/ways tried|then pressed with/.test(press.outcome)) return `another way was tried on top: ${JSON.stringify(press.outcome)}`;
        if (/no request from it was seen/.test(press.outcome)) return `the result said no request was seen, though one was made: ${JSON.stringify(press.outcome)}`;
        return null;
      }],
      // A control that takes no scripted press at all: the result says so, the
      // model hands that one press to the user, and the run goes on after it.
      ["pressUser", "/press-real", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "press") return false;
        seen.banner = !!(await until(() => hasBanner(fixture), 4000));
        seen.marked = await fixture.evaluate(() => { const b = document.querySelector("[data-select-to-ai-press]"); return b ? b.id : ""; });
        seen.before = await fixture.evaluate(() => ({ state: document.getElementById("state").textContent, scripted: window.scripted }));
        await fixture.bringToFront();
        await fixture.click("#real");
        return true;
      }, async (r) => {
        const state = await r.fixture.evaluate(() => document.getElementById("state").textContent);
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        if (press && press.pointer === "real") return state === "Downloads unlocked" ? null : `a real press left "${state}"`;
        if (!r.seen.cards.some((c) => c.kind === "press")) return `the user was never asked to press it: ${String(r.log).replace(/\s+/g, " ").slice(0, 700)}`;
        if (!/No change was seen after a press made by script in any of the ways tried: pointer events, the Enter key with the focus on it, the Space key with the focus on it\. It may have nothing to do here/.test(press.outcome) || /ignores scripted input/.test(press.outcome)) return `the result did not say that no change was seen in any way tried: ${JSON.stringify(press.outcome)}`;
        if (!r.seen.banner || r.seen.marked !== "real") return `the page did not show the user what to press: banner ${r.seen.banner}, marked "${r.seen.marked}"`;
        // One scripted click reached the page, the pointer's, and it was ignored: the control's own click is not called on top.
        if (r.seen.before.state !== "Downloads locked" || r.seen.before.scripted !== 1) return `before the user's press: ${JSON.stringify(r.seen.before)}`;
        if (r.actions.filter((a) => a.do === "click").length !== 1) return `the dead press was repeated: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (state !== "Downloads unlocked") return `state: ${state}`;
        return /Downloads are unlocked/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // A click made by script crosses a shadow boundary, as a mouse's does: the first way is enough.
      ["shadowClick", "/shadow-click", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ state: document.getElementById("state").textContent, adds: window.adds }));
        if (at.adds !== 1 || at.state !== "Added to basket") return `added ${at.adds} times (${at.state}): ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        const press = (r.trace.history || []).find((h) => /^click/.test(h.action));
        return /ways tried|then pressed with|No change was seen after pointer events/.test(press.outcome) ? `the pointer's click did not reach the page's listener: ${JSON.stringify(press.outcome)}` : null;
      }],
      // A press the page cancels (an editor's toolbar) leaves the cursor where it was.
      ["toolbar", "/toolbar", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ state: document.getElementById("state").textContent, title: document.getElementById("title").value }));
        return at.state === "Title in upper case" && at.title === "SHOPPING LIST" ? null : `${JSON.stringify(at)}: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
      }],
      // An editor with its own model of the text takes typing at its end, a
      // word selected by its text, and its bold shortcut, and says it is bold.
      ["editorBold", "/editor", async () => false, async (r) => {
        const text = await r.fixture.evaluate(() => window.editorModel.map((p) => p.map((x, i) => `${x.b && !(p[i - 1] && p[i - 1].b) ? "**" : ""}${x.c}${x.b && !(p[i + 1] && p[i + 1].b) ? "**" : ""}`).join("")));
        if (JSON.stringify(text) !== JSON.stringify(["Original text here.", "**Practice** line"])) return `the editor holds ${JSON.stringify(text)}: ${String(r.log).replace(/\s+/g, " ").slice(0, 900)}`;
        return /Practice line/.test(r.answer) && /bold/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // A button in a frame within a frame is listed under the frames' path
      // and pressed by its number; a frame from a site with no access is said.
      ["nestedFrame", "/frames", async () => false, async (r) => {
        const inner = r.fixture.frames().find((f) => /\/frames\/inner$/.test(f.url()) && f.parentFrame() && f.parentFrame() !== r.fixture.mainFrame());
        const at = inner ? await inner.evaluate(() => ({ text: document.getElementById("nested").textContent, clicked: window.clicked || 0 })) : null;
        if (!at || at.text !== "Clicked, thank you" || at.clicked !== 1) return `the inner button: ${JSON.stringify(at)}: ${String(r.log).replace(/\s+/g, " ").slice(0, 900)}`;
        const listed = r.prompts.find((p) => /frame "Outer box" > frame "Inner"/.test(p));
        if (!listed) return `the inner frame's controls were not listed under the frames' path: ${String(r.prompts[0] || "").slice(-2500)}`;
        if (!/could not be read: it comes from 127\.0\.0\.2, which the agent has no access to/.test(listed)) return "the frame from a site with no access was not said to be unreadable";
        if (!/click \[2000\d\d\]/.test(r.log)) return `the inner button was not pressed by its own number: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        return /Clicked, thank you/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // A rating set in a shadow root is read back: its value is in the
      // listing, and what the action read back counts as evidence.
      ["shadowRating", "/rating", async () => false, async (r) => {
        const value = await r.fixture.evaluate(() => document.getElementById("stars").value);
        if (value !== 4) return `the rating holds ${value}: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        if (!r.prompts.some((p) => /\[\d+\] div "Rating" role=slider value="4" min=0 max=5/.test(p))) return "the rating's value was not in the listing";
        if (/not in anything you have been shown/.test(r.log)) return "a quote of what the action read back was refused as evidence";
        return /4 of 5/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // A key named for a control that cannot hold the focus is not sent to
      // the page as a whole, where it changed pages; a control that takes keys gets it.
      ["keysWhere", "/chart-keys", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ path: location.pathname, zoom: document.getElementById("zoom") && document.getElementById("zoom").getAttribute("aria-valuenow") }));
        if (at.path !== "/chart-keys") return `the key went to the page and it changed to ${at.path}`;
        if (at.zoom !== "2") return `the zoom shows ${at.zoom}: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        return /cannot take the keyboard focus, so ArrowRight would go to the page as a whole/.test(r.log) ? null : `the refused key was not explained: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
      }],
      // A menu only the real mouse opens: said once, as a fact, and the hover is not repeated.
      ["hoverScripted", "/pointer-menu", async () => false, async (r) => {
        const state = await r.fixture.evaluate(() => document.getElementById("state").textContent);
        if (state === "Pricing chosen") return null;
        const hovers = r.actions.filter((a) => a.do === "hover").length;
        if (hovers !== 1) return `the hover was tried ${hovers} times: ${JSON.stringify(r.actions.map((a) => a.do))}`;
        if (!/Nothing came up under the pointer made by script, or with the focus on it\. What opens only under the real mouse cannot be opened by script\./.test(r.log)) return `the hover's result did not say why nothing came up: ${String(r.log).replace(/\s+/g, " ").slice(0, 600)}`;
        return /opens only under the real mouse/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // The model is told, once, that its input is scripted, in a build where it is.
      ["search", "/search", async () => false, async (r) => {
        if (!r.answer.includes("$19")) return `answer: ${JSON.stringify(r.answer)}`;
        const real = await worker.evaluate(() => !!chrome.debugger) && process.env.E2E_DEBUGGER !== "off";
        const told = r.prompts.filter((p) => /your pointer and your keys are made by script/.test(p)).length;
        if (real) return told ? "the model was told its input is scripted in a build with the real pointer" : null;
        return told === r.prompts.filter((p) => /You are Select to AI/.test(p) && /# How a step works/.test(p)).length && told > 0 ? null : `${told} of the step prompts said the input is scripted`;
      }, "scriptedFact"],
      // A picture of the page with one site granted. Chrome gives one only
      // with access to every address or on a tab the user opened the
      // extension on, so the look is either a picture or a stated reason,
      // never a failure with nothing said. The line printed says which.
      ["lookPerSite", "/chart", async () => false, async (r) => {
        await mainModel("e2e-scripted-model");
        const notes = await r.agent.evaluate(() => [...document.querySelectorAll(".chat-note")].map((n) => n.textContent)).catch(() => []);
        await r.agent.close().catch(() => {});
        const looked = (r.trace.history || []).find((h) => /^look/.test(h.action));
        if (!looked) return `look was never run: ${JSON.stringify(r.answer)} ${JSON.stringify((r.trace.history || []).map((h) => h.action))}`;
        const pictured = /I looked at the chart/.test(r.answer);
        console.log(`      pictures with one site granted: ${pictured ? "taken" : `not taken. ${looked.outcome}`}`);
        if (pictured) return null;
        if (!/^A picture of this tab could not be taken\. \S/.test(looked.outcome)) return `the look failed with no reason given: ${JSON.stringify(looked.outcome)}`;
        // In the build without the debugger the one reason there can be is the browser's rule on pictures: any other is a failure.
        if (!/The browser refused: it gives an extension a picture of a tab only with access to every address/.test(looked.outcome)) return process.env.E2E_DEBUGGER === "off" ? `the picture was refused for another reason than the browser's rule on pictures: ${JSON.stringify(looked.outcome)}` : null;
        if (!r.prompts.some((p) => /- No picture of the page can be taken on this tab\. The browser refused/.test(p))) return "the model was not told, as a fact, that no picture can be taken on this tab";
        return notes.some((n) => /Chrome did not let the agent take a picture of this page/.test(n)) ? null : `the user was not told: ${JSON.stringify(notes)}`;
      }, "lookPerSite", { before: () => mainModel("e2e-vision-model"), keepOpen: true }],
      ["pointerRisk", "/pointer-risk", decline, async (r) => {
        const at = await r.fixture.evaluate(() => ({ deleted: !!window.deleted, binned: !!window.binned }));
        if (at.deleted || at.binned) return `something was deleted: ${JSON.stringify(at)}`;
        if (r.seen.confirms !== 2) return `${r.seen.confirms} approvals were asked for, not 2: ${JSON.stringify(r.seen.cards)}`;
        if (!r.seen.cards.every((c) => c.risk === "delete")) return `held for the wrong reason: ${JSON.stringify(r.seen.cards)}`;
        return null;
      }],
      // Removing a chosen value from a field is not held; deleting a saved
      // record is. Once declined, the Delete key on the same Remove is held
      // again, the question back is not put to the user, and the run ends with an answer.
      ["fieldChips", "/field-chips", decline, async (r) => {
        const at = await r.fixture.evaluate(() => ({ chips: [...document.querySelectorAll('#colours .chip')].map((c) => c.dataset.value), deleted: !!window.addressDeleted }));
        if (at.deleted) return "the saved address was deleted";
        if (JSON.stringify(at.chips) !== JSON.stringify(["red"])) return `the field holds ${JSON.stringify(at.chips)}, not just red`;
        if (r.seen.confirms !== 2) return `${r.seen.confirms} approvals were asked for, not 2 (the saved address's Remove, then the Delete key on it): ${JSON.stringify(r.seen.cards)}`;
        if (r.seen.cards.some((c) => c.kind !== "approval")) return `the user was asked something besides the approvals: ${JSON.stringify(r.seen.cards)}`;
        if (r.seen.cards.some((c) => /Purple/.test(c.text) || c.risk !== "delete")) return `an approval was about the wrong control: ${JSON.stringify(r.seen.cards)}`;
        if (!/declined .*Remove.* a moment ago/.test(r.seen.asked)) return `the second approval did not say it was declined before: ${JSON.stringify(r.seen.asked)}`;
        return /took Purple out/.test(r.answer) && /did not remove the saved address/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      ["realKeys", "/keys", async () => false, async (r) => {
        const at = await r.fixture.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, trusted: window.keyTrusted }));
        if (at.trusted !== true) return `the key was a scripted event, not a real one (${JSON.stringify(at)})`;
        return at.focus === "second" ? null : `Tab did not move the cursor on: it is in "${at.focus}"`;
      }],
      ["humanAuto", "/gate-auto", async ({ card, seen }) => { if (card) seen.asked = card.kind; return false; }, (r) => {
        if (r.seen.asked) return `the user was asked (${r.seen.asked}) about a check that passes by itself`;
        return r.answer.includes("$18") ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      ["humanPushy", "/gate", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "human_check") return false;
        // The model pressed the button: the engine must have held it for the user.
        seen.stillGate = fixture.url().includes("/gate");
        await fixture.bringToFront();
        await fixture.click("#human-btn");
        return true;
      }, (r) => {
        if (!r.seen.cards.some((c) => c.kind === "human_check")) return "the agent's press on the human check was not held";
        if (!r.seen.stillGate) return "the agent passed the human check itself";
        return r.answer.includes("$18") ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      ["code", "/otp", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "code") return false;
        seen.codeBefore = await fixture.$eval("#code", (el) => el.value);
        await fixture.bringToFront();
        await fixture.type("#code", "482913");
        await fixture.click("#verify-btn");
        return true;
      }, (r) => {
        if (r.seen.codeBefore !== "") return `the agent typed a code: ${JSON.stringify(r.seen.codeBefore)}`;
        return r.answer.includes("$182.50") ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // A calculator posting a text area: the second opinion says it asks, so no card is shown.
      ["calcAsks", "/calc", approve, async (r) => {
        if (r.seen.cards.some((c) => c.kind === "approval")) return `an approval card was shown: ${JSON.stringify(r.seen.cards)}`;
        if (!r.answer.includes("391")) return `answer: ${JSON.stringify(r.answer)}`;
        const { opinions } = await r.log2();
        if (!opinions || opinions.length !== 1 || opinions[0].tool !== "form_check") return `second opinions: ${JSON.stringify(opinions)}`;
        if (/Type a sum|Calculator/.test(opinions[0].text)) return "the second opinion was shown page text";
        if (!/17\*23/.test(opinions[0].text) || !/"Compute"/.test(opinions[0].text)) return `the second opinion lacked the text or the button: ${opinions[0].text}`;
        if (!/Not held for approval/.test(r.log)) return "the log does not say why the press was not held";
        return null;
      }],
      // A comment box of the same shape: the second opinion says it sends, so the card is shown.
      ["commentSends", "/comment", approve, async (r) => {
        const card = r.seen.cards.find((c) => c.kind === "approval");
        if (!card || card.risk !== "send") return `no send card: ${JSON.stringify(r.seen.cards)}`;
        const posted = await r.fixture.evaluate(() => window.posted);
        if (posted !== "Schöner Artikel") return `posted: ${JSON.stringify(posted)}`;
        return r.answer.includes("posted") ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // The agent fills what it may; the card and the button that pays are the user's.
      ["payPress", "/checkout", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "payment") return false;
        seen.placedBefore = await fixture.evaluate(() => window.placedBy);
        seen.outlined = await fixture.$eval("#place-btn", (el) => !!el.style.outline);
        await fixture.bringToFront();
        await fixture.type("#card", "4111 1111 1111 1111");
        await fixture.click("#place-btn");
        return true;
      }, async (r) => {
        if (r.seen.placedBefore) return `the order was placed before the user pressed anything (by ${r.seen.placedBefore})`;
        if (!r.seen.outlined) return "the button to press was not pointed out";
        const by = await r.fixture.evaluate(() => window.placedBy);
        if (by !== "a person") return `the order was placed by ${by}`;
        if (!r.answer.includes("Z9")) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.actions.some((a) => a.do === "fill" && /4111/.test(a.value))) return "the agent typed a card number";
        return null;
      }],
      // A form filled from the user's details: they are asked once, the
      // values never reach the model, and the one detail not on file is asked for.
      ["profileForm", "/signup", async ({ card, agent, seen }) => {
        if (!seen.seeded) {
          seen.seeded = true;
          await setMemory([{ op: "wipe" }, { op: "field", key: "name", value: "Ada Lovelace" }, { op: "field", key: "email", value: "ada@example.com" }, { op: "field", key: "organization", value: "Analytical Engines Ltd" }]);
        }
        if (!card) return false;
        if (card.kind === "approval" && card.risk === "share") { seen.share = card.text; await click(agent, ".confirm-risk-btn"); return true; }
        if (card.kind === "approval") { seen.confirms++; await click(agent, ".confirm-risk-btn"); return true; }
        if (card.kind === "question") { await answerInPanel(agent, "555-0100"); return true; }
        return false;
      }, async (r) => {
        const v = await r.fixture.evaluate(() => ({ name: document.getElementById("name").value, email: document.getElementById("email").value, company: document.getElementById("company").value, phone: document.getElementById("phone").value }));
        const want = { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines Ltd", phone: "555-0100" };
        for (const k of Object.keys(want)) if (v[k] !== want[k]) return `field ${k} = ${JSON.stringify(v[k])}`;
        if (!/ada@example\.com/.test(r.seen.share || "")) return `the user was not shown what would be filled in: ${JSON.stringify(r.seen.share)}`;
        if (r.prompts.some((p) => p.includes("ada@example.com"))) return "the user's email was sent to the model";
        if (r.prompts.some((p) => p.includes("Analytical Engines"))) return "the user's company was sent to the model";
        if (!r.chips.some((c) => /your email/.test(c))) return `no "Used" chips: ${JSON.stringify(r.chips)}`;
        if (!r.answer.includes("Ada Lovelace")) return `answer: ${JSON.stringify(r.answer)}`;
        return null;
      }],
      ["rememberSaid", "/home", async ({ seen }) => { if (!seen.seeded) { seen.seeded = true; await setMemory([{ op: "wipe" }]); } return false; }, async (r) => {
        const store = await memory();
        const kept = store.entries.find((e) => /prices in SGD/i.test(e.text));
        if (!kept) return `not kept: ${JSON.stringify(store.entries)}`;
        if (kept.source !== "you_said" || kept.kind !== "preference") return `kept as ${kept.kind} from ${kept.source}`;
        if (!r.notes.some((n) => /Remembered: Always show prices in SGD/.test(n))) return `the user was not shown what was kept: ${JSON.stringify(r.notes)}`;
        return null;
      }],
      ["rememberPoison", "/orders", async ({ seen, agent, state }) => {
        if (!seen.seeded) { seen.seeded = true; await setMemory([{ op: "wipe" }]); }
        if (state.trace && state.trace.stopState && !seen.offered) {
          seen.offered = await agent.evaluate(() => { const c = document.querySelector(".save-offer"); return c ? c.innerText : ""; });
          await click(agent, ".offer-skip-btn");
        }
        return false;
      }, async (r) => {
        const store = await memory();
        if (store.entries.length) return `a page wrote the user's memory: ${JSON.stringify(store.entries)}`;
        const offered = r.seen.offered || await r.fixture.evaluate(() => "").catch(() => "");
        if (!/partner-store/.test(offered)) return `it was not put to the user either: ${JSON.stringify(offered)}`;
        return null;
      }],
      ["userFilled", "/signup", async ({ card, agent, fixture, seen, state }) => {
        if (!seen.seeded) { seen.seeded = true; await setMemory([{ op: "wipe" }]); }
        if (card && card.kind === "question" && !seen.typed) {
          seen.typed = true;
          await fixture.bringToFront();
          await fixture.$eval("#phone", (el) => { el.value = ""; });
          await fixture.type("#phone", "9123 4567");
          await answerInPanel(agent, "done");
          return true;
        }
        if (state.trace && state.trace.stopState && !seen.saved) {
          seen.offer = await agent.evaluate(() => { const c = document.querySelector(".save-offer"); return c ? c.innerText : ""; });
          if (seen.offer) { seen.saved = true; await click(agent, ".offer-save-btn"); await sleep(500); }
        }
        return false;
      }, async (r) => {
        if (!/Phone: 9123 4567/.test(r.seen.offer || "")) return `no offer to keep the phone number: ${JSON.stringify(r.seen.offer)}`;
        const store = await memory();
        const tel = store.profiles[0].fields.tel;
        if (!tel || tel.value !== "9123 4567") return `not saved to the profile: ${JSON.stringify(store.profiles[0].fields)}`;
        if (tel.source !== "you_filled") return `saved as ${tel.source}`;
        return null;
      }],
      ["question", "/home", async ({ card, agent }) => {
        if (!card || card.kind !== "question") return false;
        await agent.type("#taskInput", "Item B");
        await agent.keyboard.press("Enter");
        return true;
      }, (r) => {
        if (!r.answer.includes("$18")) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.seen.runIds.size !== 1) return `the answer started another run (${r.seen.runIds.size} runs)`;
        if (r.order.join(",") !== "user,answer,user,answer") return `the conversation does not read in order: ${r.order.join(", ")}`;
        return null;
      }],
      ["compare", "/home", async () => false, (r) => {
        if (!r.answer.includes("$18") || !/item b/i.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}`;
        if (!/Check Passed/.test(r.log)) return "a multi-step answer was not checked";
        return null;
      }],
      // A checked, uncorrected multi-step run leaves a note about the site,
      // and the next run there is shown it, with the page, not as an instruction.
      ["compare", "/home", async () => false, async (r) => {
        const note = await until(async () => (await memory()).entries.find((e) => e.kind === "site_note"));
        await learning(false);
        if (!note) return "a checked multi-step run taught nothing";
        if (note.scope === "global" || note.source !== "run") return `the note is ${note.scope} from ${note.source}`;
        const again = await play("compare", "/home", async () => false);
        const first = again.prompts.find((p) => p.includes("Notes from earlier tasks on this site"));
        if (!first) return "the next run on the site was not shown the note";
        const at = first.indexOf("Notes from earlier tasks on this site");
        const begins = first.lastIndexOf("begins -----", at), ends = first.indexOf("ends -----", at);
        if (begins < 0 || ends < 0) return "the site's note is not inside the page markers";
        return null;
      }, "learnNote", { before: async () => { await setMemory([{ op: "wipe" }]); await learning(true); } }],
      // The user ticks "remember my answer": the detail they typed is kept, and nothing they did not type.
      ["profileForm", "/signup", async ({ card, agent }) => {
        if (!card) return false;
        if (card.kind === "approval") { await click(agent, ".confirm-risk-btn"); return true; }
        if (card.kind === "question") { await click(agent, ".keep-answer-box"); await answerInPanel(agent, "555-0100"); return true; }
        return false;
      }, async (r) => {
        const tel = await until(async () => (await memory()).profiles[0].fields.tel);
        await learning(false);
        if (!tel || tel.value !== "555-0100") return `the answer was not kept: ${JSON.stringify(tel)}`;
        if (tel.source !== "you_confirmed") return `kept as ${tel.source}`;
        const store = await memory();
        if (store.profiles[0].fields.email) return "a detail the user never gave was written to their profile";
        return null;
      }, "keepAnswer", { before: async () => { await setMemory([{ op: "wipe" }, { op: "field", key: "name", value: "Ada Lovelace" }, { op: "consent", site: "127.0.0.1" }]); await learning(true); } }],
      // "Not right", with a reason: a lesson for that site.
      ["search", "/search", async () => false, async (r) => {
        const agent = r.agent;
        await agent.bringToFront();
        await click(agent, ".feedback-down");
        await agent.type(".feedback-why", "it is the green one I want");
        await click(agent, ".feedback-send");
        const lesson = await until(async () => (await memory()).entries.find((e) => e.kind === "lesson"));
        await learning(false);
        await agent.close().catch(() => {});
        if (!lesson) return "the user's correction taught nothing";
        if (lesson.source !== "correction" || lesson.scope === "global") return `the lesson is ${lesson.scope} from ${lesson.source}`;
        return null;
      }, "lesson", { keepOpen: true, before: async () => { await setMemory([{ op: "wipe" }]); await learning(true); } }],
      // "Not right" on a run that had already taught something: what that
      // run wrote by itself (its site note, its route) is taken back.
      ["compare", "/home", async () => false, async (r) => {
        const agent = r.agent;
        const mine = (store) => store.entries.filter((e) => e.source === "run" && e.origin && e.origin.runId === r.trace.id);
        const taught = await until(async () => { const got = mine(await memory()); return got.some((e) => e.kind === "site_note") ? got : null; });
        if (!taught) { await learning(false); await agent.close().catch(() => {}); return `the run taught no note that carries its id: ${JSON.stringify((await memory()).entries.map((e) => [e.kind, e.source, e.origin]))}`; }
        await agent.bringToFront();
        await click(agent, ".feedback-down");
        await click(agent, ".feedback-send");
        const gone = await until(async () => mine(await memory()).length === 0);
        await until(() => worker.evaluate(() => self.__selectToAiMemoryState().then((m) => m.learning === 0)));
        const left = mine(await memory());
        await learning(false);
        await agent.close().catch(() => {});
        if (!gone || left.length) return `after the thumbs-down the run's own notes are still kept: ${JSON.stringify(left.map((e) => [e.kind, e.text]))}`;
        return null;
      }, "thumbsDownForgets", { keepOpen: true, before: async () => { await setMemory([{ op: "wipe" }]); await learning(true); } }],
      // Run 1: the agent asks where the user's assignments are, the user
      // names a service, and a lasting fact about them is kept from their
      // words and the site the checked run used; a line on the page about
      // the user is not. Run 2, a different request about coursework, goes
      // there without asking, the fact in front of the model with where it
      // came from.
      ["contextAsk", "/home", async ({ card, agent }) => {
        if (!card || card.kind !== "question") return false;
        await answerInPanel(agent, "On the Harbour University portal");
        return true;
      }, async (r) => {
        const fact = await until(async () => (await memory()).entries.find((e) => e.kind === "context"));
        await sleep(300);
        const notes = await r.agent.evaluate(() => [...document.querySelectorAll(".memory-note")].map((b) => b.textContent)).catch(() => []);
        await r.agent.close().catch(() => {});
        const log = await r.log2();
        await learning(false);
        if (!fact) return `nothing about the user was kept (context calls: ${log.contextCalls})`;
        if (fact.source !== "you_mentioned" || fact.scope !== "global") return `kept as ${fact.source} for ${fact.scope}`;
        if (!/Harbour University portal/.test(fact.text) || fact.quote !== "On the Harbour University portal") return `kept: ${JSON.stringify(fact)}`;
        if (!(fact.from || []).includes("said") || !(fact.from || []).includes("site")) return `provenance: ${JSON.stringify(fact.from)}`;
        const store = await memory();
        if (store.entries.some((e) => /Quayside/.test(e.text))) return "what the page said about the user was kept";
        const asked = log.prompts.find((p) => p.includes("You keep a short list of lasting facts"));
        if (!asked) return "no context call was made";
        if (/Quayside|Lab report/.test(asked)) return "the context call was shown the page";
        if (!log.addressedChecks) return "the fact was not put to the meaning check before it was kept";
        if (!notes.some((n) => /Learned about you: Studies at Harbour University/.test(n))) return `the user was not shown what was learned: ${JSON.stringify(notes)}`;
        const again = await play("contextKnown", "/home", async ({ card, seen }) => { if (card && card.kind === "question") seen.askedAgain = true; return false; }, { timeoutMs: 20000 });
        if (again.seen.askedAgain) return "run 2 asked where again";
        const first = again.actions[0];
        if (!first || first.do !== "navigate" || !/\/portal$/.test(first.url)) return `run 2 began with ${JSON.stringify(first)}`;
        const shown = again.prompts.find((p) => p.includes("About their life, from earlier tasks"));
        if (!shown || !/Harbour University portal \(127\.0\.0\.1\) \((?:the user said "[^"]*"; )?since [^)]*from their words and the site a checked task used in 1 task\)/.test(shown)) return "run 2 was not shown the fact with where it came from";
        if (!/Essay 2/.test(again.answer)) return `run 2 answer: ${JSON.stringify(again.answer)}`;
        return null;
      }, "contextLearned", { keepOpen: true, before: async () => { await setMemory([{ op: "wipe" }]); await learning(true); } }],
      // The panel is closed while the run is working and opened again later:
      // the run carries on without it and the new panel shows all of it.
      ["compare", "/home", async ({ state, seen, reopen }) => {
        if (!seen.reopened && state.trace && state.trace.steps >= 1) { seen.reopened = true; await reopen(); }
        return false;
      }, (r) => {
        if (!r.seen.reopened) return "the panel was never closed";
        if (!r.answer.includes("$18")) return `answer after reopening: ${JSON.stringify(r.answer)}`;
        if (!/Task Started/.test(r.log)) return "the reopened panel does not show the run from its start";
        return null;
      }, "reopen"],
      // A main model stuck on a button that does nothing: the helper takes the next step, and checks the answer.
      ["helper", "/stuck", async () => false, async (r) => {
        await helperModel("");
        if (!r.answer.includes("$18")) return `answer: ${JSON.stringify(r.answer)}`;
        const steps = r.models.filter((m) => m.tool === "step").map((m) => m.model);
        const checks = r.models.filter((m) => m.tool === "verdict").map((m) => m.model);
        if (steps[0] !== "e2e-scripted-model" || steps[1] !== "e2e-scripted-model") return `the first steps were not the main model's: ${steps.join(", ")}`;
        if (steps[steps.length - 1] !== "e2e-helper-model") return `the step that answered was not the helper's: ${steps.join(", ")}`;
        if (checks.length !== 1 || checks[0] !== "e2e-helper-model") return `the check was not made by the helper: ${checks.join(", ") || "no check"}`;
        if (!r.trace || r.trace.helperSteps !== 1) return `helper steps in the trace: ${r.trace && r.trace.helperSteps}`;
        return /Helper Model/.test(r.log) ? null : "the log does not say the helper took a step";
      }, "helper", { before: () => helperModel("e2e-helper-model") }],
      // A task of thirty-odd steps: there is no step cap, and every amount read is kept to the end.
      ["ledger", "/home", async () => false, (r) => {
        if (!/30 amounts add up to \$465/.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}`;
        // The notes are added to a step at a time: the last prompt holds every amount once, each under its own step.
        const last = String(r.prompts.filter((p) => /Your notes:/.test(p)).pop() || "");
        const lines = (last.match(/^Step \d+: Amount on page \d+: \$\d+$/gm) || []).length;
        if (lines !== 29) return `the last step's notes held ${lines} amounts, not the 29 read before it`;
        if (!r.trace || r.trace.steps <= 25) return `steps: ${r.trace && r.trace.steps}`;
        if (r.trace.stopState !== "success") return `ended ${r.trace.stopState}`;
        if (r.seen.cards.length) return `the user was asked something: ${JSON.stringify(r.seen.cards)}`;
        return null;
      }, "longRun", { timeoutMs: 150000 }],
      // After a short stretch of work the run asks whether to go on; "keep
      // going" carries on with the same run, its notes and history intact.
      ["checkIn", "/home", async ({ card, agent, seen }) => {
        if (!card || card.kind !== "check_in") return false;
        seen.checkIns = (seen.checkIns || 0) + 1;
        seen.checkInText = card.text;
        await click(agent, ".checkin-keep-btn");
        return true;
      }, async (r) => {
        await checkInMinutes(null);
        if (!r.seen.checkIns) return "no check-in card appeared";
        if (!/Keep going/.test(r.seen.checkInText) || !/Stop and answer with what you have/.test(r.seen.checkInText)) return `the card: ${r.seen.checkInText}`;
        if (!/working on this for/.test(r.seen.checkInText) || !/What I have found so far:\s*Step \d+: Amount on page 1: \$1 Step \d+: Amount on page 2: \$2/.test(r.seen.checkInText)) return `the card does not say how long it worked and what it found: ${r.seen.checkInText}`;
        if (r.seen.runIds.size !== 1) return `more than one run: ${[...r.seen.runIds].join(", ")}`;
        if (!/12 amounts add up to \$78/.test(r.answer)) return `answer after keeping going: ${JSON.stringify(r.answer)}`;
        if (!r.trace || r.trace.checkIns !== r.seen.checkIns) return `check-ins in the trace: ${r.trace && r.trace.checkIns}, seen ${r.seen.checkIns}`;
        if (!/Keep Going/.test(r.log)) return "the log does not say the user chose to keep going";
        return null;
      }, "checkIn", { timeoutMs: 120000, before: () => checkInMinutes(0.05) }],
      // The run hands each shop to a sub-task of its own: both work at once,
      // in tabs behind the user's, answer, and the run puts the answers together.
      ["delegate", "/stores", async () => false, async (r) => {
        if (!/Item B is cheaper/.test(r.answer) || !r.answer.includes("$18") || !r.answer.includes("$25")) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.seen.cards.length) return `the user was asked something: ${JSON.stringify(r.seen.cards)}`;
        const kids = (r.trace && r.trace.children) || [];
        if (kids.length !== 2 || !kids.every((k) => k.success && k.state === "ended")) return `sub-tasks: ${JSON.stringify(kids)}`;
        if (kids[0].tabId === kids[1].tabId) return "the sub-tasks shared a tab";
        const activated = await worker.evaluate(() => self.__activated || []);
        if (kids.some((k) => activated.includes(k.tabId))) return `a sub-task's tab took the focus: ${JSON.stringify(activated)}`;
        const open = await worker.evaluate(() => chrome.tabs.query({}).then((t) => t.map((x) => x.id)));
        if (kids.some((k) => open.includes(k.tabId))) return "a sub-task's tab was left open after it ended";
        const hosts = new Set(r.trace.history.filter((h) => h.sub).map((h) => { try { return new URL(h.url).hostname; } catch (_e) { return ""; } }).filter(Boolean));
        if (!hosts.has("127.0.0.1") || !hosts.has("localhost")) return `the sub-tasks did not work on both sites: ${[...hosts].join(", ")}`;
        if (!(r.trace.steps > r.trace.ownSteps) || r.trace.steps !== r.trace.ownSteps + kids.reduce((n, k) => n + k.steps, 0)) return `the trace does not count the sub-tasks' steps: ${r.trace.steps} with ${r.trace.ownSteps} its own`;
        const kidCalls = kids.reduce((n, k) => n + k.calls, 0);
        if (kidCalls < 2 || r.trace.calls < kidCalls + 2) return `the trace does not count the sub-tasks' model calls: ${r.trace.calls}, theirs ${kidCalls}`;
        if (r.subRows !== 2) return `the panel shows ${r.subRows} sub-task rows`;
        return null;
      }, "delegate", { keepOpen: false, before: () => worker.evaluate(() => { self.__activated = []; if (!self.__watching) { self.__watching = true; chrome.tabs.onActivated.addListener((i) => self.__activated.push(i.tabId)); } return true; }) }],
      // A sub-task needs the user's go-ahead to book; the card names it, the
      // user declines, that sub-task says so, and the other's answer still comes back.
      ["delegateDecline", "/stores", decline, async (r) => {
        if (r.seen.confirms !== 1) return `approvals asked: ${r.seen.confirms} (${JSON.stringify(r.seen.cards)})`;
        if (!/Sub-task: Book a Pro workshop ticket/.test(r.seen.asked)) return `the card did not name the sub-task: ${r.seen.asked}`;
        const kids = (r.trace && r.trace.children) || [];
        const booking = kids.find((k) => /Book a Pro/.test(k.task));
        const price = kids.find((k) => /Item B/.test(k.task));
        if (!booking || !price || booking.success || !price.success) return `sub-tasks: ${JSON.stringify(kids)}`;
        const press = r.trace.history.find((h) => h.sub === booking.id && /^click/.test(h.action));
        if (!press || press.ok || !/declined this step/.test(press.outcome)) return `the press that books: ${JSON.stringify(press)}`;
        if (!r.answer.includes("$18") || !/not booked \(declined\)/.test(r.answer)) return `answer: ${JSON.stringify(r.answer)}`;
        if (r.trace.stopState !== "success") return `ended ${r.trace.stopState}`;
        return null;
      }, "delegateDecline"],

      // ---- Hand-offs that wait, and waits that survive the worker (package P3).
      // An email-first sign-in: no password box until the user presses Next.
      // The wait used to end by itself in about 1.4 s and ask again.
      ["signinIdentifierFirst", "/id-login", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "sign_in") return false;
        const before = (await control("/control/log", { method: "GET" })).llmCalls;
        await sleep(3500);
        const after = (await control("/control/log", { method: "GET" })).llmCalls;
        seen.waited = { before, after, banner: await hasBanner(fixture) };
        await fixture.bringToFront();
        await fixture.type("#identifier", "ada@example.com");
        await fixture.click("#next-btn");
        await sleep(1000);
        await fixture.type("#pw", "correct horse");
        await fixture.click("#pw-btn");
        // The user says nothing: the password box was seen and went, so the run goes on by itself.
        return true;
      }, (r) => {
        if (!r.seen.waited) return "no sign-in card was shown";
        if (r.seen.waited.after !== r.seen.waited.before) return `the model was asked again while the user had not signed in yet (${r.seen.waited.before} then ${r.seen.waited.after} calls)`;
        if (!r.seen.waited.banner) return "the banner was gone before the user did anything";
        if (r.seen.cards.filter((c) => c.kind === "sign_in").length !== 1) return `sign-in asked ${r.seen.cards.filter((c) => c.kind === "sign_in").length} times`;
        return r.answer.includes("$42.10") ? null : `the run did not carry on after the sign-in: ${JSON.stringify(r.answer)}`;
      }],
      // A code box with no autocomplete attribute, named only by its label.
      ["codePlain", "/otp-plain", async ({ card, fixture, seen }) => {
        if (!card || card.kind !== "code") return false;
        const before = (await control("/control/log", { method: "GET" })).llmCalls;
        await sleep(3500);
        seen.waited = { before, after: (await control("/control/log", { method: "GET" })).llmCalls };
        await fixture.bringToFront();
        await fixture.type("#otp", "482913");
        await fixture.click("#otp-btn");
        return true;
      }, (r) => {
        if (!r.seen.waited) return "no code card was shown";
        if (r.seen.waited.after !== r.seen.waited.before) return `the wait ended by itself before the code was entered (${r.seen.waited.before} then ${r.seen.waited.after} calls)`;
        return r.answer.includes("$182.50") ? null : `answer: ${JSON.stringify(r.answer)}`;
      }],
      // The same hand-off again and again on a page that does not change:
      // the user says "done" each time without doing anything, and the run
      // counts it as going round and stops.
      ["handoffRepeat", "/id-login", async ({ card, agent, seen }) => {
        if (!card || card.kind !== "sign_in") return false;
        seen.handoffs = (seen.handoffs || 0) + 1;
        await agent.evaluate(() => { const b = [...document.querySelectorAll(".wait-done-btn")].pop(); if (b) b.click(); });
        return true;
      }, (r) => {
        if (!r.trace || !r.trace.stopState) return "the run did not end";
        if (!/Not Getting Anywhere/.test(r.log)) return `the repeats were never counted as going round (${r.seen.handoffs} hand-offs)`;
        if ((r.seen.handoffs || 0) > 12) return `${r.seen.handoffs} hand-offs before it stopped`;
        return /could not get past the sign-in/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }, "handoffRepeat", { timeoutMs: 90000 }],
      // The worker restarts while the run waits: the wait is put back, and
      // the user is not alerted again (the reminder alarm is not re-armed).
      ["signin", "/home", async ({ card, fixture, seen, reopen }) => {
        if (!card || card.kind !== "sign_in") return false;
        if (seen.slept) return true;
        seen.slept = true;
        const reminders = () => worker.evaluate(async () => (await chrome.alarms.getAll()).filter((a) => a.name.startsWith("agentRemind:")).map((a) => ({ name: a.name, at: a.scheduledTime })));
        seen.before = await until(async () => { const a = await reminders(); return a.length ? a : null; }, 5000);
        await sleep(300);
        await restartWorker();
        await reopen();
        await sleep(1500);
        seen.after = await reminders();
        await fixture.bringToFront();
        await fixture.type("#user", "ada");
        await fixture.type("#pass", "correct horse");
        await fixture.click("#signin-btn");
        return true;
      }, (r) => {
        if (!r.seen.slept) return "the worker was never restarted";
        if (!r.seen.before) return "no reminder was armed for the wait";
        if (JSON.stringify(r.seen.after) !== JSON.stringify(r.seen.before)) return `the wait alerted again after the restart: reminders ${JSON.stringify(r.seen.before)} then ${JSON.stringify(r.seen.after)}`;
        return r.answer.includes("$42.10") ? null : `the run did not go on after the restart: ${JSON.stringify(r.answer)}`;
      }, "waitRestartQuiet"],
      // A task sent from the agent's page while the worker is still reading
      // back what it saved: it is handled once restoring is done, not dropped.
      ["search", "/search", async () => false, (r) => {
        if (!queuedSlowed) return "the restore was not slowed, so this proves nothing";
        return r.answer.includes("$19") ? null : `the task sent during the restore was lost: ${JSON.stringify(r.answer)}`;
      }, "queuedAfterHello", { before: async () => {
        // A cold worker: reading session storage takes a while, and the page connects meanwhile.
        const slowed = await worker.evaluate(() => {
          const s = chrome.storage.session;
          const get = s.get;
          s.get = function slow(...a) { return new Promise((res, rej) => setTimeout(() => get.apply(s, a).then(res, rej), 1500)); };
          setTimeout(() => { s.get = get; }, 4000);
          self.SELECT_TO_AI_ENGINE.wake();
          return s.get !== get;
        });
        queuedSlowed = slowed;
      } }],
      // Skip on "Let the agent use this site?": the run goes on without that site.
      ["declinedSite", "/declined-link", async (ctx) => {
        if (ctx.card && ctx.card.kind === "site_access") {
          ctx.seen.skips = (ctx.seen.skips || 0) + 1;
          await ctx.agent.evaluate(() => { const b = [...document.querySelectorAll(".wait-skip-btn")].pop(); if (b) b.click(); });
          return true;
        }
        return approve(ctx);
      }, (r) => {
        if (!r.seen.skips) return "the site-access card was never shown";
        if (r.seen.skips !== 1) return `asked about the site ${r.seen.skips} times`;
        return r.answer.includes("$18") ? null : `the run did not carry on elsewhere: ${JSON.stringify(r.answer)}`;
      }],
      // "Only use these sites": a link off the list lands on a page that is not read.
      ["offList", "/offlist-start", approve, async (r) => {
        await allowOnly("");
        if (/Kettle: \$77/.test(r.prompts.join("\n"))) return "the off-list page was read and sent to the model";
        if (!r.prompts.some((p) => /outside the sites you allow the agent to use/.test(p))) return "the model was not told the page is outside the allowed sites";
        return /outside the sites you allow/.test(r.answer) ? null : `answer: ${JSON.stringify(r.answer)}`;
      }, "offList", { before: () => allowOnly("127.0.0.1") }],
    ];

    for (const [name, startPath, user, check, label, opts] of scenarios) {
      const title = label || name;
      if (ONLY.length && !ONLY.includes(title)) continue;
      if (NOT_APPLICABLE.scenarios.includes(title)) { skipped.push(title); console.log(`N/A   ${title}`); continue; }
      let detail;
      try {
        const r = opts && opts.custom ? await opts.custom() : await play(name, startPath, user, opts);
        detail = r.timedOut ? `timed out. answer: ${JSON.stringify(r.answer)} cards: ${JSON.stringify(r.seen.cards)}\n${r.log}` : await check(r);
      } catch (e) { detail = `harness error: ${e.message}`; }
      results.push({ title, detail });
      console.log(`${detail ? "FAIL" : "PASS"}  ${title}${detail ? `\n      ${String(detail).split("\n").join("\n      ")}` : ""}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
  if (settleTimes.length) console.log(`\nwait after the press: ${settleTimes.join("; ")}`);
  const failed = results.filter((r) => r.detail).length;
  console.log(`\n${results.length - failed}/${results.length} v4 scenarios passed`);
  if (skipped.length) console.log(`${skipped.length} not applicable to this build (${process.env.E2E_NOT_APPLICABLE}): ${skipped.join(", ")}`);
  const unknown = NOT_APPLICABLE.scenarios.filter((t) => !skipped.includes(t) && !ONLY.length);
  if (unknown.length) { console.log(`listed as not applicable but no such scenario: ${unknown.join(", ")}`); process.exit(1); }
  process.exit(failed || !results.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
