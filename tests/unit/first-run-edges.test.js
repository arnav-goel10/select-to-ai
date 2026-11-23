"use strict";
// First-run and upgrade rough edges, each run through the real page or
// worker script:
// - a task from the popup reaches the side panel once, so reopening the
//   panel later starts nothing;
// - a run with no tab given, started from the agent's own tab, opens a
//   fresh tab rather than taking over another tab of the user's;
// - what was typed in the quick box while the agent was off is offered
//   whenever the agent is turned on, however that happens;
// - the quick box says why when Chrome keeps it off a page;
// - the popup never opens the side panel on a site the panel cannot show;
// - a fresh install shows Perplexity, as the welcome page says, and an
//   upgrade keeps what it had;
// - 2.0's right-click on the page itself opens the side panel again.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, settle: bgSettle } = require("../helpers/background-harness.js");
const { loadPage, settle } = require("../helpers/page-harness.js");
const { fakeWorker, settle: wSettle } = require("../helpers/fake-worker.js");

globalThis.SELECT_TO_AI_DEFAULTS = require("../../extension/defaults.js");
const OMNI = require("../../extension/omnibox.js");

const READY_AGENT = { sync: { showAgent: true, agentActiveProvider: "openrouter" }, local: { openrouterApiKey: "sk-or-v1-made-up" } };

// ------------------------------------------------- the popup's task, once

test("a task from the popup reaches the side panel once and is not kept in its saved address", async () => {
  const keyName = globalThis.SELECT_TO_AI_DEFAULTS.PROVIDER_ENDPOINTS.openrouter.keyName;
  const popup = loadPage({ html: "popup.html", sync: READY_AGENT.sync, local: { [keyName]: "sk-or-v1-made-up" } });
  await settle(8);
  assert.equal(popup.visible("taskForm"), true, "the agent is ready");
  popup.$("taskInput").value = "Find the cheapest option on this page";
  popup.$("taskForm").fire("submit");
  await settle(12);

  const state = popup.chrome.storage.local.data.sidePanelState;
  assert.ok(state && state.url, "the side panel was given an address");
  const url = new URL(state.url);
  assert.equal(url.searchParams.get("task"), null, "the task is not in the saved address");
  assert.equal(url.searchParams.get("autostart"), null);
  assert.equal(url.searchParams.get("tabId"), "5", "the run works on the tab behind the popup");
  const id = url.searchParams.get("handoff");
  assert.ok(id, "the task goes as a one-time handoff");
  assert.equal(popup.calls.sidePanelOpen.length, 1);

  // The panel takes it once; the same address opened again later finds nothing.
  const session = popup.chrome.storage.session;
  assert.equal(await OMNI.takeHandoff(session, id), "Find the cheapest option on this page");
  assert.equal(await OMNI.takeHandoff(session, id), "");
});

test("a task from the popup in tab mode still goes in the new tab's address", async () => {
  const keyName = globalThis.SELECT_TO_AI_DEFAULTS.PROVIDER_ENDPOINTS.openrouter.keyName;
  const popup = loadPage({ html: "popup.html", sync: { ...READY_AGENT.sync, openingMode: "tab" }, local: { [keyName]: "sk-or-v1-made-up" } });
  await settle(8);
  popup.$("taskInput").value = "Compare these two";
  popup.$("taskForm").fire("submit");
  await settle(12);
  assert.equal(popup.calls.tabsCreate.length, 1);
  assert.match(popup.calls.tabsCreate[0].url, /agent\.html\?tabId=5&task=Compare\+these\+two&autostart=1$/);
  assert.equal(popup.chrome.storage.local.data.sidePanelState, undefined, "the side panel's address is not touched");
});

// ------------------------------------------- a run from the agent's own tab

test("a run with no tab given, from the agent's own tab, starts in a fresh tab and leaves the user's tabs alone", async () => {
  const tabs = {
    1: { id: 1, url: "chrome-extension://x/agent.html", title: "Select to AI", windowId: 1, active: true },
    9: { id: 9, url: "https://mail.example/inbox", title: "Inbox", windowId: 1, active: false },
  };
  const w = fakeWorker({ tabs });
  const port = w.connect(1);
  await port.hello();
  await wSettle(40);
  await port.post({ type: "send", text: "What's the top story on the news site right now?" });
  await wSettle(80);
  const run = w.engine.sessions.get(1).run;
  assert.ok(run, "the run started");
  assert.notEqual(run.tabId, 9, "the user's mail tab is not taken over");
  assert.ok(run.tabId >= 500, "a fresh tab was opened for it");
  assert.ok(tabs[run.tabId], "the tab it works in is one the run opened");
  assert.equal(tabs[9].url, "https://mail.example/inbox");
});

async function endedRunIn(tabs, text) {
  const w = fakeWorker({ tabs });
  const port = w.connect(1);
  await port.hello();
  await wSettle(40);
  await port.post({ type: "send", text });
  await wSettle(80);
  const first = w.engine.sessions.get(1).run;
  await port.post({ type: "stop" });
  await wSettle(80);
  return { w, port, first };
}

test("a follow-up from the agent's own tab goes on in the tab the last run worked in", async () => {
  const tabs = {
    1: { id: 1, url: "chrome-extension://x/agent.html", title: "Select to AI", windowId: 1, active: true },
    9: { id: 9, url: "https://mail.example/inbox", title: "Inbox", windowId: 1, active: false },
  };
  const { w, port, first } = await endedRunIn(tabs, "Open Wikipedia and tell me today's featured article");
  const worked = first.tabId;
  assert.ok(tabs[worked], "the first run had a tab");
  // The run went to a page there.
  tabs[worked].url = "https://en.wikipedia.org/wiki/Main_Page";
  const before = Object.keys(tabs).length;
  await port.post({ type: "send", text: "Now open the first link in that article" });
  await wSettle(80);
  const next = w.engine.sessions.get(1).run;
  assert.notEqual(next.id, first.id, "a new run started");
  assert.equal(next.tabId, worked, "it works where the last run was");
  assert.equal(Object.keys(tabs).length, before, "no new tab was opened");
  assert.equal(tabs[9].url, "https://mail.example/inbox");
});

test("a follow-up whose earlier tab was closed starts in a fresh tab, not one of the user's", async () => {
  const tabs = {
    1: { id: 1, url: "chrome-extension://x/agent.html", title: "Select to AI", windowId: 1, active: true },
    9: { id: 9, url: "https://mail.example/inbox", title: "Inbox", windowId: 1, active: false },
  };
  const { w, port, first } = await endedRunIn(tabs, "Open Wikipedia and tell me today's featured article");
  delete tabs[first.tabId];
  await port.post({ type: "send", text: "Now open the first link in that article" });
  await wSettle(80);
  const next = w.engine.sessions.get(1).run;
  assert.notEqual(next.tabId, 9, "the user's mail tab is not taken over");
  assert.ok(tabs[next.tabId], "it has a tab");
  assert.equal(tabs[next.tabId].url, "about:blank", "a fresh tab was opened for it");
});

// --------------------------------- what was typed while the agent was off

/** The worker after the quick box kept a request with the agent off. */
async function keptRequest(extraSync = {}) {
  const bg = loadBackground({ sync: { showAgent: false, ...extraSync } });
  await bgSettle();
  bg.run("notifyAgentDisabled")("Summarise the reviews on this page", 42);
  await bgSettle();
  assert.match(bg.calls.tabsCreate.at(-1).url, /welcome\.html\?step=connect$/);
  assert.equal(bg.chrome.storage.session.data.pendingAgentTask.text, "Summarise the reviews on this page");
  bg.calls.tabsCreate.length = 0;
  return bg;
}

function offered(bg) {
  const opened = bg.calls.tabsCreate.filter((t) => /agent\.html/.test(t.url));
  assert.equal(opened.length, 1, "the agent opened once");
  return new URL(opened[0].url);
}

test("a request typed in the quick box with the agent off is offered once the welcome page connects", async () => {
  const bg = await keptRequest();
  // welcome.js connect writes the provider and turns the agent on.
  bg.chrome.storage.sync.set({ agentActiveProvider: "openrouter", agentModel: "x", showAgent: true });
  await bgSettle(20);
  const url = offered(bg);
  assert.equal(url.searchParams.get("task"), "Summarise the reviews on this page");
  assert.equal(url.searchParams.get("autostart"), null, "offered in the box, not started");
  assert.equal(url.searchParams.get("tabId"), "42", "on the tab it was typed on");
  assert.equal(bg.chrome.storage.session.data.pendingAgentTask, undefined, "taken once");
});

test("the same request is offered when the agent is turned on in Settings with a key already saved", async () => {
  const bg = await keptRequest({ agentActiveProvider: "openrouter" });
  // options.js: the agent switch.
  bg.chrome.storage.sync.set({ showAgent: true });
  await bgSettle(20);
  assert.equal(offered(bg).searchParams.get("task"), "Summarise the reviews on this page");
  // Turning it off and on again offers nothing more.
  bg.chrome.storage.sync.set({ showAgent: false });
  await bgSettle(10);
  bg.chrome.storage.sync.set({ showAgent: true });
  await bgSettle(20);
  assert.equal(bg.calls.tabsCreate.filter((t) => /agent\.html/.test(t.url)).length, 1);
});

test("a request typed long ago is not offered, and other settings changes offer nothing", async () => {
  const bg = await keptRequest();
  bg.chrome.storage.sync.set({ theme: "dark" });
  await bgSettle(10);
  assert.ok(bg.chrome.storage.session.data.pendingAgentTask, "still kept");
  bg.chrome.storage.session.data.pendingAgentTask.at = Date.now() - 2 * 3600000;
  bg.chrome.storage.sync.set({ showAgent: true });
  await bgSettle(20);
  assert.deepEqual(bg.calls.tabsCreate, []);
});

// ------------------------------------------- the quick box on a browser page

test("the quick box on a page Chrome keeps extensions off marks the icon for that tab", async () => {
  const bg = loadBackground({ injectFails: true });
  await bgSettle();
  bg.chrome.commands.onCommand.fire("open-palette", { id: 12, windowId: 1, url: "chrome://newtab/" });
  await bgSettle();
  assert.equal(bg.calls.tabBadges.length, 1);
  assert.equal(bg.calls.tabBadges[0].tabId, 12);
  assert.equal(bg.calls.titles.length, 1);
  assert.equal(bg.calls.titles[0].tabId, 12);
  assert.match(bg.calls.titles[0].title, /quick box cannot open on this page/);
});

test("the quick box mark is not the agent's 'needs you' mark, and the tab is recorded as marked", async () => {
  const bg = loadBackground({ injectFails: true });
  await bgSettle();
  bg.chrome.commands.onCommand.fire("open-palette", { id: 12, windowId: 1, url: "chrome://newtab/" });
  await bgSettle();
  // engine.js attention marks a run that needs the user with an orange "!".
  assert.notEqual(bg.calls.tabBadges[0].text, "!", "a different glyph");
  assert.equal(bg.calls.colors.length, 1, "with its own color");
  assert.equal(bg.calls.colors[0].tabId, 12);
  assert.notEqual(bg.calls.colors[0].color.toLowerCase(), "#c2410c");
  assert.deepEqual(bg.chrome.storage.session.data.iconTabMarks, { 12: "hint" });
});

/** A run saved by an earlier worker while it waits for an approval, with the quick box mark on tab 12. */
function waitingForApproval() {
  const RUN = require("../../extension/core/run.js");
  const run = RUN.newRun({ id: "r1", task: "Buy the cheapest one", tabId: 9, startUrl: "https://shop.example/", marker: "PAGE-abcd1234", now: 1 });
  run.status = "waiting";
  run.waits = 1;
  run.wait = { id: "r1-w1", kind: "approval", question: "Place the order for $12?", tabId: 9, since: 1 };
  return { "agentSession:1": { turns: [], run: JSON.parse(JSON.stringify(RUN.toStored(run))), extras: {} }, iconTabMarks: { 12: "hint" } };
}

test("a run that needs the user is shown over the quick box mark on that tab, and put back after", async () => {
  const tabs = {
    9: { id: 9, url: "https://shop.example/", title: "Shop", windowId: 1, active: false },
    12: { id: 12, url: "chrome://newtab/", title: "New Tab", windowId: 1, active: true },
  };
  const w = fakeWorker({ tabs, saved: waitingForApproval() });
  const port = w.connect(1);
  await port.hello();
  await wSettle(60);
  assert.ok(w.engine.sessions.get(1).attending.has("r1-w1"), "the wait is attended");
  const onTab = (list) => list.filter((d) => d.tabId === 12);
  assert.ok(w.calls.badges.some((b) => b.tabId === undefined && b.text === "!"), "window-wide mark");
  assert.ok(onTab(w.calls.badges).some((b) => b.text === "!"), "set on the marked tab too");
  assert.match(onTab(w.calls.titles).at(-1).title, /Select to AI needs you: Place the order/);
  // The wait ends: the tab is put back, not left saying "needs you".
  await port.post({ type: "stop" });
  await wSettle(80);
  assert.equal(onTab(w.calls.badges).at(-1).text, "");
  assert.equal(onTab(w.calls.titles).at(-1).title, "Select to AI");
});

test("the quick box on a website opens with no mark", async () => {
  const bg = loadBackground();
  await bgSettle();
  bg.chrome.commands.onCommand.fire("open-palette", { id: 12, windowId: 1, url: "https://example.com/" });
  await bgSettle();
  assert.equal(bg.calls.executes.length, 1);
  assert.deepEqual(bg.calls.tabBadges, []);
});

test("the popup's quick box row tells the popup whether it opened", async () => {
  for (const injectFails of [true, false]) {
    const bg = loadBackground({ injectFails, tabs: [{ id: 12, windowId: 1, url: "chrome://newtab/" }] });
    await bgSettle();
    let reply;
    const kept = bg.chrome.runtime.onMessage.listeners.map((fn) => fn({ action: "openPaletteFromPopup" }, { id: "testextensionid", url: "chrome-extension://testextensionid/popup.html" }, (r) => { reply = r; }));
    assert.ok(kept.includes(true), "the worker answers later");
    await bgSettle();
    assert.equal(reply && reply.opened, !injectFails);
  }
});

test("the popup stays open and says why when the quick box cannot open", async () => {
  const keyName = globalThis.SELECT_TO_AI_DEFAULTS.PROVIDER_ENDPOINTS.openrouter.keyName;
  const blocked = loadPage({ html: "popup.html", sync: READY_AGENT.sync, local: { [keyName]: "k" }, onMessage: () => ({ opened: false }) });
  await settle(8);
  blocked.$("openPaletteBtn").click();
  await settle(4);
  assert.equal(blocked.calls.closed, 0);
  assert.equal(blocked.visible("paletteNote"), true);

  const opened = loadPage({ html: "popup.html", sync: READY_AGENT.sync, local: { [keyName]: "k" }, onMessage: () => ({ opened: true }) });
  await settle(8);
  opened.$("openPaletteBtn").click();
  await settle(4);
  assert.equal(opened.calls.closed, 1);
  assert.equal(opened.visible("paletteNote"), false);
});

// ------------------------------------- the popup's side panel, never refused

async function openSidePanelFromPopup(extra) {
  const popup = loadPage({ html: "popup.html", ...extra });
  await settle(8);
  popup.$("openSidebarBtn").click();
  await settle(12);
  assert.equal(popup.calls.sidePanelOpen.length, 1, "the panel opens");
  return popup;
}

test("with ChatGPT and Gemini off, the popup opens the panel on Perplexity, not on a claude.ai Chrome does not hold", async () => {
  const popup = await openSidePanelFromPopup({ sync: { showChatGPT: false, showGemini: false, showPerplexity: true } });
  assert.match(popup.chrome.storage.local.data.sidePanelState.url, /perplexity\.ai/);
});

test("Claude is opened only once Chrome holds claude.ai", async () => {
  const off = { showChatGPT: false, showGemini: false, showPerplexity: false, showClaude: true };
  const without = await openSidePanelFromPopup({ sync: off });
  assert.equal(without.chrome.storage.local.data.sidePanelState, undefined, "no address the panel cannot show; it opens on its empty state");
  const held = await openSidePanelFromPopup({ sync: off, granted: ["https://claude.ai/*"] });
  assert.match(held.chrome.storage.local.data.sidePanelState.url, /claude\.ai/);
});

test("a saved claude.ai address is not reopened once Chrome no longer holds claude.ai", async () => {
  const popup = await openSidePanelFromPopup({
    sync: { showClaude: true },
    local: { sidePanelState: { url: "https://claude.ai/chat/1", timestamp: 1 } },
  });
  assert.match(popup.chrome.storage.local.data.sidePanelState.url, /chatgpt\.com/);
});

test("the side panel itself does not load a saved site its picker does not list", async () => {
  const panel = loadPage({
    html: "sidepanel.html",
    sync: { showClaude: true },
    local: { sidePanelState: { url: "https://claude.ai/chat/1", timestamp: Date.now() } },
  });
  await settle(12);
  const src = panel.$("contentFrame").src;
  assert.ok(src && !/claude\.ai/.test(src), `shows a listed site, not ${src}`);
  assert.match(src, /chatgpt\.com/);

  const held = loadPage({
    html: "sidepanel.html",
    sync: { showClaude: true },
    granted: ["https://claude.ai/*"],
    local: { sidePanelState: { url: "https://claude.ai/chat/1", timestamp: Date.now() } },
  });
  await settle(12);
  assert.equal(held.$("contentFrame").src, "https://claude.ai/chat/1", "a listed one is shown as before");
});

// ----------------------------------------------------- Perplexity on install

test("a fresh install shows Perplexity in the right-click menu", async () => {
  const bg = loadBackground();
  bg.chrome.runtime.onInstalled.fire({ reason: "install" });
  await bgSettle(20);
  assert.equal(bg.chrome.storage.sync.data.showPerplexity, true);
  assert.ok(bg.menuTitles().includes("Send to Perplexity"));
});

test("an upgrade keeps Perplexity as it was", async () => {
  for (const before of [undefined, false]) {
    const sync = before === undefined ? {} : { showPerplexity: before };
    const bg = loadBackground({ sync });
    bg.chrome.runtime.onInstalled.fire({ reason: "update", previousVersion: "3.2.0" });
    await bgSettle(20);
    assert.notEqual(bg.chrome.storage.sync.data.showPerplexity, true, `from ${before}`);
  }
  // A choice made before the install event is read is kept too.
  const chose = loadBackground({ sync: { showPerplexity: false } });
  chose.chrome.runtime.onInstalled.fire({ reason: "install" });
  await bgSettle(20);
  assert.equal(chose.chrome.storage.sync.data.showPerplexity, false);
});

// ---------------------------------------------- 2.0's page right-click item

test("right-clicking the page itself offers the side panel again, whatever is turned on", async () => {
  for (const sync of [{}, { showChatGPT: false, showGemini: false, showPerplexity: false, showClaude: false, showAgent: false }]) {
    const bg = loadBackground({ sync });
    await bgSettle(20);
    const item = bg.currentMenu().find((m) => (m.contexts || []).includes("page"));
    assert.ok(item, JSON.stringify(sync));
    assert.equal(item.title, "Open Select to AI side panel");
  }
});

test("its click opens the side panel inside the click, on a worker that just woke", async () => {
  const bg = loadBackground();
  await bgSettle(20);
  const id = bg.currentMenu().find((m) => (m.contexts || []).includes("page")).id;
  const cold = loadBackground();
  cold.click({ menuItemId: id }, { id: 4, windowId: 3, url: "https://example.com/" });
  assert.equal(cold.calls.sidePanelOpen.length, 1, "opened synchronously, before storage answered");
  assert.equal(cold.calls.sidePanelOpen[0].options.windowId, 3);
  await bgSettle(20);
  assert.match(cold.chrome.storage.local.data.sidePanelState.url, /chatgpt\.com/);
});
