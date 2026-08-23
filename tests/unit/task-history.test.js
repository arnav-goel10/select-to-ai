const test = require("node:test");
const assert = require("node:assert/strict");
const th = require("../../extension/taskHistory.js");

test("createEntry produces id, timestamp, capped fields", () => {
  const e = th.createEntry({ route: th.ROUTES.AGENT, task: "x".repeat(600) });
  assert.equal(e.route, "agent");
  assert.equal(e.task.length, 500);
  assert.equal(e.status, th.STATUSES.RUNNING);
  assert.ok(e.id.startsWith("t-"));
  assert.ok(typeof e.timestamp === "number");
});

test("prepend adds newest first and caps at MAX_ENTRIES", () => {
  let list = [];
  for (let i = 0; i < th.MAX_ENTRIES + 5; i++) {
    list = th.prepend(list, th.createEntry({ route: "agent", task: `t${i}` }));
  }
  assert.equal(list.length, th.MAX_ENTRIES);
  assert.equal(list[0].task, `t${th.MAX_ENTRIES + 4}`);
});

test("updateEntry patches by id and preserves others", () => {
  const a = th.createEntry({ route: "agent", task: "a" });
  const b = th.createEntry({ route: "site", task: "b" });
  const updated = th.updateEntry([a, b], a.id, {
    status: th.STATUSES.SUCCESS,
    detail: "done",
  });
  assert.equal(updated[0].status, "success");
  assert.equal(updated[0].detail, "done");
  assert.equal(updated[1].task, "b");
  // Unknown id is a no-op.
  assert.equal(th.updateEntry([a], "nope", { status: "error" })[0].status, "running");
});

test("filterEntries matches task text or route case-insensitively", () => {
  const list = [
    th.createEntry({ route: th.ROUTES.AGENT, task: "Find USB-C cable on Amazon" }),
    th.createEntry({ route: th.ROUTES.QUESTION, task: "what is a rate limiter" }),
    th.createEntry({ route: th.ROUTES.SITE, task: "youtube" }),
  ];
  assert.equal(th.filterEntries(list, "amazon").length, 1);
  assert.equal(th.filterEntries(list, "AGENT").length, 1);
  assert.equal(th.filterEntries(list, "").length, 3);
});
