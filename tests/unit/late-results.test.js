"use strict";
// Results that come late, in a build with no debugger. The page's own world
// counts its requests (core/inject.js), the content script reads that count
// while it waits after an action, and a wait that saw no change says what
// it could and could not see, not a flat "nothing changed".
const test = require("node:test");
const assert = require("node:assert/strict");
const TOOLS = require("../../extension/agentTools.js");
const CONTEXT = require("../../extension/core/context.js");
const INJECT = require("../../extension/core/inject.js");
const { CONTENT, build } = require("../helpers/content-source.js");
const { fakeWorker } = require("../helpers/fake-worker.js");

/** The content script's count of the page's requests, on a stand-in page. */
function counting() {
  const fns = build(["onPageNet", "pageRequests"], {
    pageNet: TOOLS.createNetworkTracker(), pageNetOpen: new Set(), pageNetAlive: false,
    location: { href: "https://shop.example/search" }, URL,
  });
  const say = (d) => fns.onPageNet({ detail: typeof d === "string" ? d : JSON.stringify(d) });
  return { ...fns, say };
}

// A name of the shape the content script makes.
const NAME = "n0123456789abcdef01234567";

test("the content script makes the name the page's world speaks under anew for each page, and gives it with the listing", () => {
  const made = CONTENT.match(/const NET_EVENT = (\(\(\) => \{[\s\S]*?\}\)\(\));/);
  assert.ok(made, "the name is made in the content script");
  const crypto = require("node:crypto").webcrypto;
  const a = new Function("crypto", `return ${made[1]}`)(crypto);
  const b = new Function("crypto", `return ${made[1]}`)(crypto);
  assert.match(a, INJECT.NET_EVENT);
  assert.notEqual(a, b);
  // With no random source it is still a name of that shape.
  assert.match(new Function("crypto", `return ${made[1]}`)(undefined), INJECT.NET_EVENT);
  assert.match(CONTENT, /netEvent: pageNet \? NET_EVENT : '',/);
  assert.ok(!/select-to-ai:net/.test(CONTENT), "no fixed name a page could speak under");
});

test("nothing is known of the page's requests until its world has said it is counting", () => {
  const c = counting();
  assert.equal(c.pageRequests(1000, 2000), null);
  c.say({ t: "hello" });
  const st = c.pageRequests(Date.now() - 500, Date.now());
  assert.deepEqual([st.open, st.asked], [0, false]);
});

test("a request the page began is open until it ends, and counts as asked after that", () => {
  const since = Date.now() - 1;
  // The agent is acting: what begins now is the action's doing (the tracker is told by the caller).
  const acting = build(["onPageNet", "pageRequests"], { pageNet: (() => { const t = TOOLS.createNetworkTracker(); t.begin(); return t; })(), pageNetOpen: new Set(), pageNetAlive: true, location: { href: "https://shop.example/" }, URL });
  acting.onPageNet({ detail: JSON.stringify({ t: "start", id: "Fetch1", kind: "Fetch", url: "/api/results" }) });
  let st = acting.pageRequests(since, Date.now() + 1);
  assert.deepEqual([st.open, st.asked], [1, true]);
  acting.onPageNet({ detail: JSON.stringify({ t: "end", id: "Fetch1" }) });
  st = acting.pageRequests(since, Date.now() + 1);
  assert.deepEqual([st.open, st.asked], [0, true]);
});

test("what a page sends under that name that is not a count is left alone", () => {
  const c = counting();
  c.say({ t: "hello" });
  const since = Date.now() - 1;
  for (const junk of ["not json", "null", "[1,2]", { t: "start", id: "", kind: "Fetch" }, { t: "start", id: "a", kind: "WebSocket" }, { t: "end", id: "never-started" }]) c.say(junk);
  assert.equal(c.pageRequests(since, Date.now() + 1).open, 0);
});

test("a page cannot hold the count open with more requests than a page makes", () => {
  const c = counting();
  c.say({ t: "hello" });
  for (let i = 0; i < 500; i++) c.say({ t: "start", id: `x${i}`, kind: "XHR", url: `/a/${i}` });
  // Each is ended by its id; the ones past the cap were never counted.
  for (let i = 0; i < 500; i++) c.say({ t: "end", id: `x${i}` });
  assert.equal(c.pageRequests(Date.now() - 1000, Date.now() + 1).open, 0);
});

test("the wait after an action uses the page's count when the browser gives no view", () => {
  // The source says so in one line; the scenarios in tests/e2e/run-v4.js (slowResults) run it.
  assert.match(CONTENT, /net = far \|\| pageRequests\(since, now\);/);
  assert.match(CONTENT, /netView: pageNetAlive,/);
});

test("no change with the requests in view and none made is said flatly, with how long the page was watched", () => {
  assert.equal(CONTEXT.noChangeNote({ ms: 430, loading: false, network: true, asked: false }), "Nothing on the page changed in the 0.4 seconds it was watched, and no request from it was seen.");
  // Not every request can be seen (a worker's, a socket's), so it is not said that none was made.
  assert.ok(!/asked its server for nothing/.test(CONTEXT.noChangeNote({ ms: 430, loading: false, network: true, asked: false })));
});

test("no change is not called nothing when the page's requests could not be seen", () => {
  const said = CONTEXT.noChangeNote({ ms: 410, loading: false, network: false });
  assert.ok(!/Nothing on the page changed/.test(said));
  assert.match(said, /^No change was seen on the page in the 0\.4 seconds it was watched\. Its requests cannot be seen here, so it may still be loading/);
  // Nothing measured about the wait at all: the same caution.
  assert.match(CONTEXT.noChangeNote(null), /^No change was seen on the page\. Its requests cannot be seen here/);
});

test("no change after the page asked its server for something says that it asked", () => {
  const said = CONTEXT.noChangeNote({ ms: 900, loading: false, network: true, asked: true });
  assert.match(said, /^No change was seen on the page in the 0\.9 seconds it was watched\. The page did ask its server for something/);
});

test("a wait that ended at its ceiling leaves what was going on to the still-loading note", () => {
  assert.equal(CONTEXT.noChangeNote({ ms: 8000, loading: true, network: false }), "No change was seen on the page in the 8 seconds it was watched.");
});

test("what the page did is said as before when it did something", () => {
  assert.equal(CONTEXT.effectNote({ urlChanged: true, newElementCount: 2 }, null), "The page address changed. 2 more controls on the page.");
  assert.equal(CONTEXT.effectNote({ domMutationCount: 3 }, null), "The page updated.");
  assert.equal(CONTEXT.effectNote({ noEffect: true }, { ms: 400, network: true, asked: false }), "Nothing on the page changed in the 0.4 seconds it was watched, and no request from it was seen.");
  assert.equal(CONTEXT.effectNote(null), "");
});

test("a script that needs nothing from the page is run at once, and a page that cannot take it is not waited on", async () => {
  const calls = [];
  const ok = { scripting: { executeScript: async (req) => { calls.push(req); return [{ result: true }]; } } };
  assert.deepEqual(await INJECT.injectNow(ok, { tabId: 4 }, { world: "MAIN", func: INJECT.netShim, args: [NAME] }), [{ result: true }]);
  assert.deepEqual([calls[0].injectImmediately, calls[0].world, calls[0].target.tabId], [true, "MAIN", 4]);
  const refused = { scripting: { executeScript: async () => { throw new Error("Cannot access contents of the page."); } } };
  assert.equal(await INJECT.injectNow(refused, { tabId: 4 }, { func() {} }), null);
  const never = { scripting: { executeScript: () => new Promise(() => {}) } };
  assert.equal(await INJECT.injectNow(never, { tabId: 4 }, { func() {} }, { injectMs: 20 }), null);
});

test("the engine starts the count in the page's world when it reads a page that has none", async () => {
  const scanOf = (netView, netEvent = NAME) => ({ elements: [], url: "https://shop.example/", title: "Shop", innerText: "", netView, netEvent });
  const session = () => ({ windowId: 1, run: { task: "t" }, settings: {}, items: { agentPressables: "off" }, touched: new Set(), frames: [] });
  const tab = { id: 9, url: "https://shop.example/", title: "Shop", windowId: 1 };
  const without = fakeWorker({ onTabMessage: (_id, m) => (m.action === "scan" ? scanOf(false) : undefined) });
  await without.engine.scan(session(), tab, () => {});
  const sent = without.calls.scripts.filter((s) => s.world === "MAIN");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].target.tabId, sent[0].injectImmediately, sent[0].args[0]], [9, true, NAME]);
  assert.equal(String(sent[0].func), String(INJECT.netShim));
  // A page already counting is not sent it again.
  const counted = fakeWorker({ onTabMessage: (_id, m) => (m.action === "scan" ? scanOf(true) : undefined) });
  await counted.engine.scan(session(), tab, () => {});
  assert.equal(counted.calls.scripts.filter((s) => s.world === "MAIN").length, 0);
  // A name that is not of the shape the content script makes is not sent into a page.
  for (const odd of ["", null, "click", "n12", "select-to-ai:net"]) {
    const w = fakeWorker({ onTabMessage: (_id, m) => (m.action === "scan" ? scanOf(false, odd) : undefined) });
    await w.engine.scan(session(), tab, () => {});
    assert.equal(w.calls.scripts.filter((s) => s.world === "MAIN").length, 0, String(odd));
  }
});
