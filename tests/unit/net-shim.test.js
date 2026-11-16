"use strict";
// The page's own requests, counted without the debugger: a small function
// run in the page's world says when each fetch and XMLHttpRequest call
// begins and ends, and leaves the call itself as the page made it.
const test = require("node:test");
const assert = require("node:assert/strict");
const INJECT = require("../../extension/core/inject.js");

const tick = () => new Promise((r) => setImmediate(r));

/** A page's world, and the shim run in it from its source, as the browser runs it. */
function world(o = {}) {
  const said = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  const document = { dispatchEvent(e) { said.push({ name: e.type, ...JSON.parse(e.detail) }); return true; } };
  const fetchCalls = [];
  const window = {
    fetch: o.fetch || function pageFetch(...args) { fetchCalls.push({ self: this, args }); return (o.answer || (() => Promise.resolve("the answer")))(); },
  };
  class XMLHttpRequest {
    constructor() { this.listeners = {}; this.sent = []; this.opened = []; }
    open(...args) { this.opened.push(args); }
    send(...args) { this.sent.push(args); if (o.sendThrows) throw new Error("blocked"); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
  }
  window.XMLHttpRequest = XMLHttpRequest;
  const run = () => new Function("window", "document", "CustomEvent", `return (${INJECT.netShim.toString()})(${JSON.stringify(INJECT.NET_EVENT)});`)(window, document, CustomEvent);
  return { said, window, fetchCalls, run, XMLHttpRequest };
}

test("the shim says it is there, and a second run only says so again", () => {
  const w = world();
  assert.equal(w.run(), true);
  assert.deepEqual(w.said, [{ name: INJECT.NET_EVENT, t: "hello" }]);
  const wrapped = w.window.fetch;
  assert.equal(w.run(), true);
  assert.equal(w.window.fetch, wrapped, "fetch is not wrapped a second time");
  assert.deepEqual(w.said.map((e) => e.t), ["hello", "hello"]);
});

test("a fetch is said to begin and to end, and reaches the page's own fetch unchanged", async () => {
  const promise = Promise.resolve("the answer");
  const w = world({ answer: () => promise });
  w.run();
  const init = { method: "POST" };
  const got = w.window.fetch("/api/search?q=1", init);
  assert.equal(got, promise, "the page gets the very promise its own fetch returned");
  assert.deepEqual(w.fetchCalls[0].args, ["/api/search?q=1", init]);
  assert.deepEqual(w.said[1], { name: INJECT.NET_EVENT, t: "start", id: "Fetch1", kind: "Fetch", url: "/api/search?q=1" });
  await tick();
  assert.deepEqual(w.said[2], { name: INJECT.NET_EVENT, t: "end", id: "Fetch1" });
});

test("a fetch that fails is said to end too, and still fails for the page", async () => {
  const w = world({ answer: () => Promise.reject(new Error("offline")) });
  w.run();
  await assert.rejects(w.window.fetch(new (class Request { get url() { return "https://shop.example/api"; } })()), /offline/);
  await tick();
  assert.deepEqual(w.said.slice(1).map((e) => [e.t, e.url || ""]), [["start", "https://shop.example/api"], ["end", ""]]);
});

test("a fetch the page's own function refuses outright is not left open", () => {
  const w = world({ fetch() { throw new TypeError("bad input"); } });
  w.run();
  assert.throws(() => w.window.fetch(42), /bad input/);
  assert.deepEqual(w.said.slice(1).map((e) => e.t), ["start", "end"]);
});

test("an XMLHttpRequest is said to begin when sent and to end when it is over", () => {
  const w = world();
  w.run();
  const x = new w.XMLHttpRequest();
  x.open("GET", "/api/rows");
  assert.deepEqual(x.opened, [["GET", "/api/rows"]]);
  assert.equal(w.said.length, 1, "nothing is said until it is sent");
  x.send("body");
  assert.deepEqual(x.sent, [["body"]]);
  assert.deepEqual(w.said[1], { name: INJECT.NET_EVENT, t: "start", id: "XHR1", kind: "XHR", url: "/api/rows" });
  x.listeners.loadend();
  assert.deepEqual(w.said[2], { name: INJECT.NET_EVENT, t: "end", id: "XHR1" });
});

test("an XMLHttpRequest whose send throws is not left open", () => {
  const w = world({ sendThrows: true });
  w.run();
  const x = new w.XMLHttpRequest();
  x.open("GET", "/api/rows");
  assert.throws(() => x.send(), /blocked/);
  assert.deepEqual(w.said.slice(1).map((e) => e.t), ["start", "end"]);
});

test("only that a call began, its kind and its address are said", async () => {
  const w = world();
  w.run();
  w.window.fetch("/api/pay", { method: "POST", body: "card=4111", headers: { Authorization: "secret" } });
  await tick();
  assert.ok(!JSON.stringify(w.said).includes("4111") && !JSON.stringify(w.said).includes("secret"));
  assert.deepEqual(Object.keys(w.said[1]).sort(), ["id", "kind", "name", "t", "url"]);
});
