"use strict";
// Right-click sending in extension/background.js, run against a chrome
// stand-in (tests/helpers/background-harness.js). A "cold" click is one made
// before storage has answered, as on a worker the click itself woke.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, settle } = require("../helpers/background-harness.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAB = { id: 7, windowId: 3, url: "https://example.com/article", title: "Article" };
const CLAUDE = "https://claude.ai/*";

test("cold worker, New tab plus auto-send: the saved mode is honoured and the prompt goes in the URL", async () => {
  const bg = loadBackground({ sync: { openingMode: "tab", autoSend: true } });
  bg.click({ menuItemId: "openChatGPT|tab", selectionText: "hello world" }, TAB); // before storage answers
  assert.equal(bg.calls.sidePanelOpen.length, 0, "no side panel for a tab-mode item");
  await settle();
  assert.equal(bg.calls.tabsCreate.length, 1);
  assert.equal(bg.calls.tabsCreate[0].url, "https://chatgpt.com/?q=hello%20world");
});

test("cold worker, side panel: the panel opens inside the click and the text waits for the settings", async () => {
  const bg = loadBackground({ sync: { autoContext: true, autoSend: false } });
  bg.click({ menuItemId: "openGemini|panel", selectionText: "explain this" }, TAB);
  assert.equal(bg.calls.sidePanelOpen.length, 1, "opened synchronously, inside the gesture");
  assert.equal(bg.calls.sidePanelOpen[0].options.windowId, 3);
  await settle();
  const state = bg.chrome.storage.local.data.sidePanelState;
  assert.equal(state.url, "https://gemini.google.com/app");
  assert.equal(state.selectedText, "Context: https://example.com/article\n\nexplain this", "autoContext read from storage, not the default");
  assert.equal(state.autoSend, false);
});

test("an id without a mode suffix means the side panel on a cold worker, and the saved mode on a warm one", async () => {
  const cold = loadBackground({ sync: { openingMode: "tab" } });
  cold.click({ menuItemId: "openChatGPT", selectionText: "x" }, TAB);
  assert.equal(cold.calls.sidePanelOpen.length, 1);
  const warm = loadBackground({ sync: { openingMode: "tab" } });
  await settle();
  warm.click({ menuItemId: "openChatGPT", selectionText: "x" }, TAB);
  assert.equal(warm.calls.sidePanelOpen.length, 0);
  await settle();
  assert.equal(warm.calls.tabsCreate.length, 1);
});

test("menu ids carry the opening mode", async () => {
  const panel = loadBackground({ sync: {} });
  await settle(10);
  assert.ok(panel.currentMenu().filter((m) => m.id !== "parentFolder").every((m) => m.id.endsWith("|panel")));
  const tab = loadBackground({ sync: { openingMode: "tab" } });
  await settle(10);
  assert.ok(tab.currentMenu().filter((m) => m.id !== "parentFolder").every((m) => m.id.endsWith("|tab")));
});

test("a send opens the service's base URL (a new chat), not a saved conversation", async () => {
  const bg = loadBackground({ sync: { openingMode: "sidePanel" }, local: { "sessionUrl_chatgpt.com": "https://chatgpt.com/c/old-thread" } });
  await settle();
  bg.click({ menuItemId: "openChatGPT|panel", selectionText: "new question" }, TAB);
  await settle();
  assert.equal(bg.chrome.storage.local.data.sidePanelState.url, "https://chatgpt.com/");
});

test("prefill stays in the URL up to 2,000 encoded characters, past that the page-insert path is used", async () => {
  const bg = loadBackground({});
  const build = bg.run("buildPrefillUrl");
  const base = "https://chatgpt.com/";
  assert.ok(build(base, base, "a".repeat(2000), true));
  assert.equal(build(base, base, "a".repeat(2001), true), null);
  const cjk = "漢".repeat(300); // 9 encoded characters each: 2,700
  assert.equal(build(base, base, cjk, true), null);
});

test("a long CJK selection in New tab with auto-send goes in through the page", async () => {
  const bg = loadBackground({ sync: { openingMode: "tab", autoSend: true } });
  await settle();
  const text = "这是一篇文章".repeat(60); // 360 characters, 3,240 encoded
  bg.click({ menuItemId: "openPerplexity|tab", selectionText: text }, TAB);
  await settle();
  assert.equal(bg.calls.tabsCreate[0].url, "https://www.perplexity.ai/");
  bg.chrome.tabs.onUpdated.fire(bg.calls.tabsCreate[0].id, { status: "complete" });
  await settle();
  assert.equal(bg.calls.sendMessage.length, 1);
  assert.equal(bg.calls.sendMessage[0].message.selectedText, text);
  assert.equal(bg.calls.sendMessage[0].message.autoSend, true);
});

test("New tab delivery is retried until the content script answers, then stops", async () => {
  const bg = loadBackground({ sync: { openingMode: "tab" }, onSendMessage: (id, m, n) => (n <= 3 ? new Error("Receiving end does not exist.") : { status: "success" }) });
  await settle();
  bg.click({ menuItemId: "openGemini|tab", selectionText: "retry me" }, TAB);
  await settle();
  bg.chrome.tabs.onUpdated.fire(bg.calls.tabsCreate[0].id, { status: "complete" });
  await sleep(1400);
  assert.equal(bg.calls.sendMessage.length, 4);
  await sleep(700);
  assert.equal(bg.calls.sendMessage.length, 4, "no send after the first success");
  assert.equal(bg.chrome.tabs.onRemoved.listeners.length, 0, "listeners cleaned up");
});

test("New tab delivery gives up after 10 tries", async () => {
  const bg = loadBackground({ sync: { openingMode: "tab" }, onSendMessage: () => undefined });
  await settle();
  bg.click({ menuItemId: "openGemini|tab", selectionText: "nobody home" }, TAB);
  await settle();
  bg.chrome.tabs.onUpdated.fire(bg.calls.tabsCreate[0].id, { status: "complete" });
  await sleep(3600);
  assert.equal(bg.calls.sendMessage.length, 10);
});

test("a click with no tab does not throw and opens a tab", async () => {
  const bg = loadBackground({ sync: {} });
  await settle();
  assert.doesNotThrow(() => bg.click({ menuItemId: "openChatGPT|panel", selectionText: "no tab" }, undefined));
  assert.doesNotThrow(() => bg.click({ menuItemId: "openAgent|panel", selectionText: "no tab" }, undefined));
  assert.doesNotThrow(() => bg.click({ menuItemId: "openGemini|panel", selectionText: "no window" }, { id: -1 }));
  await settle();
  assert.equal(bg.calls.sidePanelOpen.length, 0);
  assert.equal(bg.calls.tabsCreate.length, 2);
});

test("zero assistants: no menu at all, not an empty parent", async () => {
  const bg = loadBackground({ sync: { showChatGPT: false, showGemini: false, showPerplexity: false, showClaude: false } });
  await settle(10);
  assert.deepEqual(bg.currentMenu(), []);
});

test("one assistant: a flat item", async () => {
  const bg = loadBackground({ sync: { showGemini: false } });
  await settle(10);
  assert.deepEqual(bg.currentMenu().map((m) => [m.id, m.title, m.parentId]), [["openChatGPT|panel", "Send to ChatGPT", undefined]]);
});

test("Claude appears only once claude.ai is granted, and the grant re-installs the frame rule", async () => {
  const bg = loadBackground({ sync: { showClaude: true } });
  await settle(10);
  assert.ok(!bg.currentMenu().some((m) => m.title === "Send to Claude"));
  const rules = bg.calls.sessionRules.length;
  bg.grant(CLAUDE);
  await settle(12);
  assert.ok(bg.currentMenu().some((m) => m.title === "Send to Claude"));
  assert.ok(bg.calls.sessionRules.length > rules, "frame rule installed again");
});

test("the frame rule no longer strips permissions-policy or feature-policy", async () => {
  const bg = loadBackground({});
  const headers = bg.calls.sessionRules[0].addRules[0].action.responseHeaders.map((h) => h.header);
  assert.ok(!headers.includes("permissions-policy"));
  assert.ok(!headers.includes("feature-policy"));
  assert.ok(headers.includes("x-frame-options"));
});

test("menu rebuilds run one at a time: many changes leave one correct menu", async () => {
  const bg = loadBackground({ sync: {} });
  await settle(10);
  for (let i = 0; i < 5; i++) bg.run("updateContextMenus")();
  bg.chrome.storage.sync.set({ showPerplexity: true });
  bg.chrome.storage.sync.set({ showGemini: false });
  await settle(30);
  assert.deepEqual(bg.currentMenu().map((m) => m.title), ["Select to AI", "Send to ChatGPT", "Send to Perplexity"]);
});

test("an error loading the agent does not stop right-click sending", async () => {
  const bg = loadBackground({ agentThrows: true, sync: { openingMode: "tab", autoSend: true } });
  assert.equal(bg.run("agentLoaded"), false);
  await settle(10);
  assert.ok(bg.currentMenu().some((m) => m.title === "Send to ChatGPT"));
  bg.click({ menuItemId: "openChatGPT|tab", selectionText: "still works" }, TAB);
  await settle();
  assert.equal(bg.calls.tabsCreate[0].url, "https://chatgpt.com/?q=still%20works");
});

test("quick box with the agent off opens the setup and keeps the typed text", async () => {
  const bg = loadBackground({ sync: { showAgent: false } });
  bg.chrome.runtime.onMessage.fire({ type: "SELECT_TO_AI_PALETTE_SUBMIT", text: "book a table", selection: "" }, { tab: { id: 9 } }, () => {});
  await settle();
  assert.equal(bg.calls.tabsCreate.length, 1);
  assert.match(bg.calls.tabsCreate[0].url, /welcome\.html\?step=connect$/);
  assert.equal(bg.chrome.storage.session.data.pendingAgentTask.text, "book a table");
});

test("quick box on a cold worker with the agent on starts the agent, not the setup", async () => {
  const bg = loadBackground({ sync: { showAgent: true } });
  bg.chrome.runtime.onMessage.fire({ type: "SELECT_TO_AI_PALETTE_SUBMIT", text: "summarise", selection: "" }, { tab: { id: 9 } }, () => {});
  await settle();
  assert.match(bg.calls.tabsCreate[0].url, /^agent\.html\?task=summarise&autostart=1&tabId=9$/);
});

test("Alt+A on a cold worker with the agent on opens the agent, not the setup", async () => {
  const bg = loadBackground({ sync: { showAgent: true } });
  bg.chrome.commands.onCommand.fire("run-agent", TAB);
  await settle();
  assert.ok(!bg.calls.tabsCreate.some((t) => /welcome/.test(t.url)));
  assert.match(bg.chrome.storage.local.data.sidePanelState.url, /agent\.html\?tabId=7$/);
});

test("the palette's can-not-open notice needs no notifications grant", async () => {
  const bg = loadBackground({});
  bg.chrome.scripting.executeScript = (o, cb) => setImmediate(() => { bg.chrome.runtime.lastError = { message: "Cannot access a chrome:// URL" }; try { cb(); } finally { bg.chrome.runtime.lastError = undefined; } });
  assert.doesNotThrow(() => bg.run("openCommandPalette")(TAB));
  await settle();
  assert.equal(bg.errors.length, 0);
});

test("the palette's notice is shown through grants.notify when notifications are granted", async () => {
  const bg = loadBackground({ notifications: true });
  bg.chrome.scripting.executeScript = (o, cb) => setImmediate(() => { bg.chrome.runtime.lastError = { message: "blocked" }; try { cb(); } finally { bg.chrome.runtime.lastError = undefined; } });
  bg.run("openCommandPalette")(TAB);
  await settle();
  assert.equal(bg.calls.notify.length, 1);
});
