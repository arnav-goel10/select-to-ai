// A task handed to the agent page in its address (the quick box, the address
// bar, the benchmarks) starts once. Reloading the page must not start it again.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../extension/agent.js"), "utf8");

function forgetIn(href) {
  const start = source.indexOf("function forgetHandedTask()");
  assert.ok(start > 0, "agent.js defines forgetHandedTask");
  const end = source.indexOf("\n  }\n", start) + 4;
  const window = { location: { href } };
  const history = {
    state: null,
    replaceState(_s, _t, url) { window.location.href = new URL(url, href).href; },
  };
  new Function("window", "history", source.slice(start, end) + "\nforgetHandedTask();")(window, history);
  return window.location.href;
}

test("the handed task, its autostart and the handoff leave the address once taken", () => {
  const after = forgetIn("chrome-extension://id/agent.html?tabId=7&task=find+flights&autostart=1&handoff=abc#x");
  assert.equal(after, "chrome-extension://id/agent.html?tabId=7#x");
});

test("an address with nothing handed is left alone", () => {
  assert.equal(forgetIn("chrome-extension://id/agent.html?tabId=7"), "chrome-extension://id/agent.html?tabId=7");
});

test("the address is cleared before the handed task can start, and the handoff path clears it too", () => {
  const handed = source.slice(source.indexOf("function consumeHandedTask"));
  assert.ok(handed.indexOf("forgetHandedTask()") < handed.indexOf("startAgent("));
  const handoff = source.slice(source.indexOf("function consumeHandoff"), source.indexOf("function consumeHandedTask"));
  assert.ok(/forgetHandedTask\(\)/.test(handoff), "the handoff id is dropped from the address as well");
});
