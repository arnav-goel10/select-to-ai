const test = require("node:test");
const assert = require("node:assert/strict");
const targets = require("../../extension/browserTargets.js");

test("chrome and edge targets exist with packaging metadata", () => {
  const ids = targets.listTargets().map((t) => t.id);
  assert.ok(ids.includes("chrome"));
  assert.ok(ids.includes("edge"));
  assert.match(targets.getTarget("edge").zipName, /edge/);
});

test("unknown targets are rejected cleanly", () => {
  assert.equal(targets.getTarget("firefox"), null);
  assert.deepEqual(targets.checkCompatibility("safari", {}), [
    'Unknown browser target "safari".',
  ]);
});

test("edge compatibility flags sidePanel floor requirement without errors on modern manifest", () => {
  const issues = targets.checkCompatibility("edge", {
    permissions: ["sidePanel", "storage"],
  });
  // Informational: sidePanel needs Edge 114+, which the manifest's
  // minimum_chrome_version already covers. The check surfaces it as data.
  assert.equal(issues.length, 1);
  assert.match(issues[0], /114\+/);
});
