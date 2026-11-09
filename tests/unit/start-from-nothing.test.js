"use strict";
// Asking from the address bar, and a run that starts with no site open:
// the omnibox suggestions and Enter handler (omnibox.js, with a stand-in
// chrome API), the start-page kinds, the fact the model is given, and the
// rule for the first address of such a run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const OMNI = require("../../extension/omnibox.js");
const TOOLS = require("../../extension/agentTools.js");
const RUN = require("../../extension/core/run.js");
const POLICY = require("../../extension/core/policy.js");
const KNOWN = require("../../extension/core/memory.js");

// ------------------------------------------------------------ suggestions

test("the manifest's keyword is ai", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../extension/manifest.json"), "utf8"));
  assert.equal(manifest.omnibox.keyword, "ai");
});

test("Enter asks Select to AI, and the rows under it are earlier requests that fit", () => {
  const history = [{ task: "Find a cheap flight to Rome in May" }, { task: "Compare USB-C cables on Amazon" }, { task: "find a flight to Tokyo" }, { task: "Find a cheap flight to Rome in May" }];
  const shown = OMNI.suggestionsFor("flight", history, { agentOn: true });
  assert.equal(shown.defaultDescription, "Ask Select to AI: <match>flight</match>");
  const recent = shown.suggestions.filter((s) => /asked before/.test(s.description)).map((s) => s.content);
  assert.deepEqual(recent, ["Find a cheap flight to Rome in May", "find a flight to Tokyo"], "matching, newest first, no repeats");
});

test("with nothing typed the last few requests are offered", () => {
  const history = ["a1", "a2", "a3", "a4", "a5"].map((task) => ({ task }));
  const shown = OMNI.suggestionsFor("", history, { agentOn: true });
  assert.deepEqual(shown.suggestions.map((s) => s.content), ["a1", "a2", "a3", "a4"]);
  assert.match(shown.defaultDescription, /Ask Select to AI/);
});

test("suggestion text is escaped for the address bar's markup", () => {
  const shown = OMNI.suggestionsFor("<b>&\"x'", [{ task: "<i>old</i>" }], { agentOn: true });
  assert.equal(shown.defaultDescription, "Ask Select to AI: <match>&lt;b&gt;&amp;&quot;x&apos;</match>");
  assert.ok(shown.suggestions.every((s) => !/<i>/.test(s.description)));
});

test("a site name or a question is a request like any other: no other rows", () => {
  for (const text of ["github.com", "ask how do rate limiters work", "open github.com"]) {
    const shown = OMNI.suggestionsFor(text, [], { agentOn: true });
    assert.match(shown.defaultDescription, /^Ask Select to AI: /, text);
    assert.deepEqual(shown.suggestions, [], text);
  }
});

test("with the agent off nothing from the run history is shown", () => {
  const shown = OMNI.suggestionsFor("flight", [{ task: "flight to Rome" }], { agentOn: false });
  assert.ok(!shown.suggestions.some((s) => /asked before/.test(s.description)));
});

// --------------------------------------------------------------- Enter

test("Enter starts an agent run, in the current tab or a new one by disposition", () => {
  assert.deepEqual(OMNI.planEntry("  book a table for two tonight ", "currentTab"), { kind: "agent", task: "book a table for two tonight", workIn: "current" });
  assert.equal(OMNI.planEntry("x y", "newForegroundTab").workIn, "newForeground");
  assert.equal(OMNI.planEntry("x y", "newBackgroundTab").workIn, "newBackground");
  assert.equal(OMNI.planEntry("   ", "currentTab"), null);
});

test("ask and open in front go to the agent with the rest of the words", () => {
  assert.deepEqual(OMNI.planEntry("ask how do rate limiters work", "currentTab"), { kind: "agent", task: "ask how do rate limiters work", workIn: "current" });
  assert.deepEqual(OMNI.planEntry("open github.com", "currentTab"), { kind: "agent", task: "open github.com", workIn: "current" });
});

test("with the agent off, Enter in the address bar or the quick box opens the setup page", () => {
  const bg = fs.readFileSync(path.resolve(__dirname, "../../extension/background.js"), "utf8");
  const enter = bg.slice(bg.indexOf("chrome.omnibox.onInputEntered"));
  assert.match(enter.slice(0, 600), /if \(!cachedSettings\.showAgent\) \{ notifyAgentDisabled\(\); return; \}/);
  const palette = bg.slice(bg.indexOf("function runPaletteInput"));
  assert.match(palette.slice(0, 600), /if \(!cachedSettings\.showAgent\) \{ notifyAgentDisabled\(\); return; \}/);
});

/** A stand-in for the parts of the chrome API the handler uses, recording what it is asked. */
function fakeChrome({ panelFails } = {}) {
  const calls = [];
  const session = {};
  const local = {};
  let nextTab = 100;
  return {
    calls, session, local,
    sidePanel: { open: (o) => { calls.push(["sidePanel.open", o]); return panelFails ? Promise.reject(new Error("`sidePanel.open()` may only be called in response to a user gesture.")) : Promise.resolve(); } },
    tabs: { create: async (o) => { calls.push(["tabs.create", o]); return { id: nextTab++, ...o }; } },
    storage: {
      session: { set: async (o) => { calls.push(["session.set", Object.keys(o)]); Object.assign(session, o); }, get: async (k) => ({ [k]: session[k] }), remove: async (k) => { delete session[k]; } },
      local: { set: async (o) => { calls.push(["local.set", Object.keys(o)]); Object.assign(local, o); } },
    },
    runtime: { getURL: (p) => `chrome-extension://abc/${p}` },
  };
}

test("the side panel is asked for before anything is awaited, then the panel is pointed at the handoff", async () => {
  const api = fakeChrome();
  const plan = OMNI.planEntry("find a vegetarian restaurant near me", "currentTab");
  const pending = OMNI.startRun(api, plan, { windowId: 3, tabId: 42 });
  // In the event's own turn, before any await has let go of the gesture, the panel is the first call.
  assert.deepEqual(api.calls[0], ["sidePanel.open", { windowId: 3 }]);
  const out = await pending;
  assert.equal(out.opened, "panel");
  assert.equal(out.tabId, 42);
  assert.equal(api.local.sidePanelState.url, `chrome-extension://abc/agent.html?handoff=${out.id}&tabId=42`);
  assert.equal(api.session[OMNI.HANDOFF_KEY].task, "find a vegetarian restaurant near me");
  assert.ok(api.calls.findIndex((c) => c[0] === "session.set") < api.calls.findIndex((c) => c[0] === "local.set"), "the handoff is stored before the panel is sent to it");
});

test("a refused panel (older Chrome, or the gesture spent) opens the agent in a tab", async () => {
  const api = fakeChrome({ panelFails: true });
  const out = await OMNI.startRun(api, { kind: "agent", task: "x y", workIn: "current" }, { windowId: 3, tabId: 42 });
  assert.equal(out.opened, "tab");
  assert.equal(api.local.sidePanelState, undefined, "the panel's page is left as it was");
  const created = api.calls.filter((c) => c[0] === "tabs.create").map((c) => c[1]);
  assert.deepEqual(created, [{ url: `chrome-extension://abc/agent.html?handoff=${out.id}&tabId=42`, active: true, windowId: 3 }]);
});

test("no known window: no panel call, the agent opens in a tab", async () => {
  const api = fakeChrome();
  const out = await OMNI.startRun(api, { kind: "agent", task: "x y", workIn: "current" }, { windowId: null, tabId: null });
  assert.equal(out.opened, "tab");
  assert.ok(!api.calls.some((c) => c[0] === "sidePanel.open"));
});

test("Alt+Enter works in a new tab: a new-tab page made first, in front or behind", async () => {
  const api = fakeChrome();
  const out = await OMNI.startRun(api, { kind: "agent", task: "x y", workIn: "newBackground" }, { windowId: 3, tabId: 42 });
  assert.deepEqual(api.calls[0], ["sidePanel.open", { windowId: 3 }]);
  assert.deepEqual(api.calls[1], ["tabs.create", { windowId: 3, active: false }]);
  assert.equal(out.tabId, 100);
  assert.match(api.local.sidePanelState.url, /&tabId=100$/);
});

test("a handoff is taken once, only by its own id, and not when it is old", async () => {
  const api = fakeChrome();
  const out = await OMNI.startRun(api, { kind: "agent", task: "plan a weekend in Kyoto", workIn: "current" }, { windowId: 1, tabId: 2 });
  assert.equal(await OMNI.takeHandoff(api.storage.session, "someone-else"), "");
  assert.equal(await OMNI.takeHandoff(api.storage.session, out.id), "plan a weekend in Kyoto");
  assert.equal(await OMNI.takeHandoff(api.storage.session, out.id), "", "opening the panel again starts nothing");
  const old = await OMNI.startRun(api, { kind: "agent", task: "late", workIn: "current" }, { windowId: 1, tabId: 2 });
  assert.equal(await OMNI.takeHandoff(api.storage.session, old.id, Date.now() + OMNI.HANDOFF_MS + 1000), "");
});

test("the worker wires the keyword to the handler, and the panel takes the handoff", () => {
  const ext = path.resolve(__dirname, "../../extension");
  const bg = fs.readFileSync(path.join(ext, "background.js"), "utf8");
  assert.match(bg, /importScripts\([^)]*'omnibox\.js'/);
  assert.match(bg, /OMNI\.startRun\(chrome, plan, omniboxWhere\)/);
  const html = fs.readFileSync(path.join(ext, "agent.html"), "utf8");
  assert.ok(html.indexOf('<script src="omnibox.js">') > 0 && html.indexOf('<script src="omnibox.js">') < html.indexOf('<script src="agent.js">'));
  assert.match(fs.readFileSync(path.join(ext, "agent.js"), "utf8"), /OMNI\.takeHandoff\(chrome\.storage\.session, id\)/);
});

// ---------------------------------------------------- start from nothing

test("start pages the agent cannot work on are told apart from web pages", () => {
  assert.equal(TOOLS.startPageKind("chrome://newtab/"), "newtab");
  assert.equal(TOOLS.startPageKind("chrome://new-tab-page/"), "newtab");
  assert.equal(TOOLS.startPageKind("about:blank"), "blank");
  assert.equal(TOOLS.startPageKind(""), "blank");
  assert.equal(TOOLS.startPageKind("chrome://settings/"), "browser");
  assert.equal(TOOLS.startPageKind("chrome-extension://abc/agent.html"), "browser");
  assert.equal(TOOLS.startPageKind("file:///Users/me/notes.txt"), "browser");
  assert.equal(TOOLS.startPageKind("https://chromewebstore.google.com/detail/x"), "store");
  assert.equal(TOOLS.startPageKind("https://chrome.google.com/webstore/detail/x"), "store");
  assert.equal(TOOLS.startPageKind("https://example.org/paper.pdf"), "pdf");
  assert.equal(TOOLS.startPageKind("https://example.org/"), "");
  assert.equal(TOOLS.startPageKind("http://localhost:8917/home"), "");
});

const blank = () => ({ url: "", title: "New Tab", elements: [], innerText: "[No site is open in this tab yet.]", visibleText: "", protectedPage: true });
const settings = { riskConfirmation: true, allowlist: "" };
const fromNothing = (task, from) => RUN.newRun({ id: "r1", task, tabId: 9, startUrl: "", marker: "PAGE-abcd1234", now: 1, openedTab: from && !from.reused ? 9 : null, fromNothing: from || { from: "newtab", url: "", title: "", reused: true } });
const firstStep = (run, page) => {
  RUN.advance(run, { type: "start" }, { now: 1000, page, settings, extras: {} });
  return RUN.advance(run, { type: "observed", page }, { now: 1000, page, settings, extras: {} });
};

test("the model is told as a fact that no site is open, and where to go", () => {
  const run = fromNothing("find the cheapest flight to Rome in May");
  const fx = firstStep(run, blank());
  assert.equal(fx[0].type, "model");
  assert.match(fx[0].user, /No site is open yet\. The run began on the new-tab page, and works in that same tab\. Go where the request needs/);
  assert.doesNotMatch(fx[0].user, /cannot be read or acted on by extensions/);
});

test("a run moved off a page it cannot use says the user's tab was left as it was", () => {
  const run = fromNothing("find the cheapest flight to Rome in May", { from: "browser", url: "chrome://settings/", title: "Settings", reused: false });
  assert.deepEqual(run.openedTabs, [9], "the new tab is the run's own, so it may close it");
  const fx = firstStep(run, blank());
  assert.match(fx[0].user, /began on a browser page \(chrome:\/\/settings\/\), which the agent cannot use\. That tab is left as it was, and the run works in a new tab it opened\./);
});

test("a first look that found an error page moves the run to its new tab", () => {
  const run = RUN.newRun({ id: "r1", task: "news about Mars", tabId: 4, startUrl: "https://down.example/", marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, { now: 1000, settings, extras: {} });
  const page = blank();
  const fx = RUN.advance(run, { type: "observed", page, moved: { tabId: 11, openedTab: 11, fromNothing: { from: "error", url: "https://down.example/", title: "", reused: false } } }, { now: 1000, page, settings, extras: {} });
  assert.equal(run.tabId, 11);
  assert.deepEqual(run.openedTabs, [11]);
  assert.match(fx[0].user, /began on a page that failed to load \(https:\/\/down\.example\/\)/);
});

test("the first navigation can be the first step: no listing is needed for it", () => {
  const run = fromNothing("find the cheapest flight to Rome in May");
  const page = blank();
  firstStep(run, page);
  const fx = RUN.advance(run, { type: "model_replied", reply: { memory: "", goal: "search", actions: [{ do: "navigate", url: "https://duckduckgo.com/?q=cheapest+flight+to+rome+in+may" }] }, usage: { prompt: 1, completion: 1, cost: 0, model: "m" } }, { now: 1000, page, settings, extras: {} });
  assert.deepEqual(fx.map((f) => f.type), ["act"], "run at once, nothing to approve");
  assert.equal(fx[0].action.do, "navigate");
});

test("a search for the request's own words opens without asking; other words are held as before", () => {
  const run = fromNothing("find the cheapest flight to Rome in May");
  const page = blank();
  const allowed = (url) => POLICY.decide({ do: "navigate", url }, page, run, settings, KNOWN.empty()).verdict;
  assert.equal(allowed("https://duckduckgo.com/?q=cheapest+flight+to+Rome+in+May"), "allow");
  assert.equal(allowed("https://www.google.com/search?q=cheapest%20flights%20Rome%20May&hl=en"), "allow", "an ending on a word of the request is the same word");
  assert.equal(allowed("https://www.bing.com/search?q=flight+rome"), "allow");
  assert.equal(allowed("https://www.google.com/"), "allow", "a front page, as before");
  assert.equal(allowed("https://duckduckgo.com/?q=flight+rome+ada%40example.com"), "confirm", "a word the request does not hold");
  assert.equal(allowed("https://duckduckgo.com/?q=flight+rome&ref=abcdefghijklmnop"), "confirm", "anything beside the words");
  assert.equal(allowed("https://evil.example/search?q=flight+rome"), "confirm", "not a search engine");
  assert.equal(allowed("https://www.google.com/url/flight?q=rome"), "confirm", "not a results address");
});

test("a site the request names opens without asking", () => {
  const run = RUN.newRun({ id: "r1", task: "find a usb-c cable under 10 dollars on amazon.com", tabId: 9, startUrl: "", marker: "PAGE-abcd1234", now: 1, fromNothing: { from: "newtab", reused: true } });
  assert.equal(POLICY.decide({ do: "navigate", url: "https://www.amazon.com/s?k=usb-c+cable" }, blank(), run, settings, KNOWN.empty()).verdict, "allow");
});

test("an address carrying the user's stored details is held, even on a search", () => {
  let store = KNOWN.empty();
  store = KNOWN.setField(store, "email", "ada@example.com", "you_said", 1).store;
  store = KNOWN.setField(store, "tel", "+1 555 010 0199", "you_said", 1).store;
  const run = fromNothing("find dentists near ada example com");
  const page = blank();
  const verdict = POLICY.decide({ do: "navigate", url: "https://duckduckgo.com/?q=dentists+ada%40example.com" }, page, run, settings, store);
  assert.equal(verdict.verdict, "confirm");
  assert.equal(verdict.kind, "address");
  assert.match(verdict.why, /saved details/);
  assert.equal(POLICY.decide({ do: "navigate", url: "https://www.google.com/?n=15550100199" }, page, run, settings, store).verdict, "confirm", "a phone number written without its spaces");
  assert.equal(POLICY.decide({ do: "tabs", op: "open", url: "https://www.google.com/search?q=1+555+010+0199" }, page, run, settings, store).verdict, "confirm");
  // The user put it in the request themselves: that is theirs to send.
  const said = fromNothing("search for ada@example.com");
  assert.equal(POLICY.decide({ do: "navigate", url: "https://duckduckgo.com/?q=ada%40example.com" }, page, said, settings, store).verdict, "allow");
});

test("once a web page has been read the usual address rule is back", () => {
  const run = fromNothing("find the cheapest flight to Rome in May");
  firstStep(run, blank());
  const web = { url: "https://duckduckgo.com/?q=flight", title: "DDG", elements: [], innerText: "results", visibleText: "results" };
  RUN.advance(run, { type: "observed", page: web }, { now: 2000, page: web, settings, extras: {} });
  assert.equal(run.fromNothing.left, true);
  assert.equal(POLICY.firstAddress({ do: "navigate", url: "https://www.bing.com/search?q=flight+rome" }, run, KNOWN.empty()), null);
});

test("a run that began on a web page is not changed", () => {
  const run = RUN.newRun({ id: "r1", task: "flight rome", tabId: 4, startUrl: "https://shop.example/", marker: "PAGE-abcd1234", now: 1 });
  assert.equal(run.fromNothing, null);
  assert.equal(POLICY.decide({ do: "navigate", url: "https://www.bing.com/search?q=flight+rome" }, { url: "https://shop.example/", elements: [] }, run, settings, KNOWN.empty()).verdict, "confirm");
});

test("searchOfRequest and carriesDetail on their own", () => {
  assert.equal(TOOLS.searchOfRequest("https://search.brave.com/search?q=rome+flights", "Rome flights"), true);
  assert.equal(TOOLS.searchOfRequest("http://duckduckgo.com/?q=rome", "rome"), false, "https only");
  assert.equal(TOOLS.searchOfRequest("https://duckduckgo.com/", "rome"), false, "no words, no search");
  assert.equal(TOOLS.searchOfRequest("https://duckduckgo.com/?q=rome#x", "rome"), false);
  assert.equal(TOOLS.searchOfRequest("https://duckduckgo.com/?q=2024", "rome 20"), false, "a number is only the number the request holds");
  assert.equal(TOOLS.carriesDetail("https://x.example/?a=Ada+Lovelace", ["Ada Lovelace"], "flights"), true);
  assert.equal(TOOLS.carriesDetail("https://x.example/?a=Ada+Lovelace", ["Ada Lovelace"], "flights for Ada Lovelace"), false);
  assert.equal(TOOLS.carriesDetail("https://x.example/?a=US", ["US"], ""), false, "too short to tell");
});
