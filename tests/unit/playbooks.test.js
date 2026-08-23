const test = require("node:test");
const assert = require("node:assert/strict");
const pb = require("../../extension/playbooks.js");

test("bundled gallery has at least six valid playbooks with unique ids", () => {
  assert.ok(pb.BUNDLED.length >= 6);
  const ids = pb.BUNDLED.map((p) => p.id);
  assert.equal(ids.length, new Set(ids).size, "ids must be unique");
  for (const playbook of pb.BUNDLED) {
    const result = pb.normalizePlaybook(playbook);
    assert.ok(result.ok, `${playbook.id}: ${result.error}`);
  }
});

test("normalizePlaybook rejects bad schema versions and malformed ids", () => {
  assert.ok(!pb.normalizePlaybook({ ...pb.BUNDLED[0], schemaVersion: 99 }).ok);
  assert.ok(!pb.normalizePlaybook({ ...pb.BUNDLED[0], id: "Has Spaces!" }).ok);
  assert.ok(!pb.normalizePlaybook(null).ok);
  assert.ok(!pb.normalizePlaybook({ ...pb.BUNDLED[0], task: "" }).ok);
});

test("renderTask substitutes input and keeps placeholder when empty", () => {
  const playbook = pb.BUNDLED[0];
  const rendered = pb.renderTask(playbook, "wireless keyboard");
  assert.ok(rendered.includes("wireless keyboard"));
  assert.ok(!rendered.includes("{input}"));
  const blank = pb.renderTask(playbook, "");
  assert.ok(blank.includes("{input}"), "empty input must not silently drop the blank");
});

test("every bundled playbook prompt is self-contained and imperative", () => {
  for (const playbook of pb.BUNDLED) {
    assert.ok(playbook.task.length > 60, playbook.id);
    assert.match(playbook.task, /^(Search|Open|Navigate|Extract|Turn|Pull)/, playbook.id);
  }
});
