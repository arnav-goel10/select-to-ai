"use strict";
// core/inject.js: the one way the engine and the recipes driver run their
// scripts in a page, so a page that never finishes loading holds neither.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const INJECT = require("../../extension/core/inject.js");

const EXT = path.resolve(__dirname, "../../extension");
const fast = { idleMs: 20, injectMs: 20 };

/** A chrome stand-in whose executeScript answers per call: "now", "never" or "fail". */
function chromeThat(...answers) {
  const calls = [];
  return {
    calls,
    scripting: {
      executeScript(req) {
        calls.push(req);
        const a = answers[Math.min(calls.length - 1, answers.length - 1)];
        if (a === "never") return new Promise(() => {});
        if (a === "fail") return Promise.reject(new Error("Frame with ID 0 was removed."));
        return Promise.resolve([{ result: `call ${calls.length}` }]);
      },
    },
  };
}

test("a page that takes the script at once is asked once, with the usual wait", async () => {
  const chrome = chromeThat("now");
  const out = await INJECT.inject(chrome, { tabId: 1 }, { files: ["a.js"] }, fast);
  assert.deepEqual(out, [{ result: "call 1" }]);
  assert.equal(chrome.calls.length, 1);
  assert.equal(chrome.calls[0].injectImmediately, undefined);
  assert.deepEqual(chrome.calls[0].files, ["a.js"]);
});

test("a page whose document never ends gets the script on what is there, without the wait", async () => {
  const chrome = chromeThat("never", "now");
  const out = await INJECT.inject(chrome, { tabId: 1, frameIds: [0] }, { func: () => 1, args: [] }, fast);
  assert.deepEqual(out, [{ result: "call 2" }]);
  assert.equal(chrome.calls.length, 2);
  assert.equal(chrome.calls[1].injectImmediately, true);
  assert.deepEqual(chrome.calls[1].target, { tabId: 1, frameIds: [0] });
});

test("a frame with no document at all ends in an error marked late", async () => {
  const chrome = chromeThat("never", "never");
  await assert.rejects(INJECT.inject(chrome, { tabId: 1 }, { files: ["a.js"] }, fast), (e) => e.late === true);
});

test("an error from the browser is passed on as it is, not turned into a wait", async () => {
  const chrome = chromeThat("fail");
  await assert.rejects(INJECT.inject(chrome, { tabId: 1 }, { files: ["a.js"] }, fast), /was removed/);
  assert.equal(chrome.calls.length, 1);
});

test("the default waits are two seconds for the document's end, then three for a bare frame", () => {
  assert.equal(INJECT.IDLE_WAIT_MS, 2000);
  assert.equal(INJECT.INJECT_MS, 3000);
});

test("the recipes driver waits on a page the same way the engine does", { timeout: 5000 }, async () => {
  const DRIVER = require("../../extension/recipes/driver.js");
  const chrome = chromeThat("never", "now");
  chrome.tabs = { get: async (id) => ({ id, status: "complete", url: "https://example.com/" }) };
  // The first call (the usual wait) never answers; the driver must not hang on it.
  chrome.scripting.executeScript = ((orig) => (req) => {
    const p = orig(req);
    return req.injectImmediately ? Promise.resolve([{ result: { missing: false, elements: [], url: "https://example.com/" } }]) : p;
  })(chrome.scripting.executeScript);
  const driver = DRIVER.createDriver({ chrome, tabId: 7, sleep: async () => {}, inject: fast });
  const snap = await driver.snapshot();
  assert.deepEqual(snap.elements, []);
  assert.ok(chrome.calls.some((c) => c.injectImmediately === true && c.target.tabId === 7));
});

test("no extension script calls chrome.scripting.executeScript on a page except through core/inject.js", () => {
  // The engine and the driver used to each have their own; one drifted.
  for (const f of ["engine.js", "recipes/driver.js"]) {
    const src = fs.readFileSync(path.join(EXT, f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    assert.ok(!/chrome\.scripting\.executeScript\(/.test(src), `${f} calls executeScript directly`);
  }
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const order = (name) => bg.indexOf(`'${name}'`);
  assert.ok(order("core/inject.js") > 0, "the worker loads core/inject.js");
  assert.ok(order("core/inject.js") < order("recipes/driver.js") && order("core/inject.js") < order("engine.js"), "before the driver and the engine");
});
