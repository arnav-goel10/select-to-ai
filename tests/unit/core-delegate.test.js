"use strict";
// Sub-tasks (the delegate action): a run hands independent parts of the
// request to runs of their own, each in its own tab, and carries on with
// what they bring back. Driven as the state machine, with no browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const STEP = require("../../extension/core/step.js");

const shopPage = (host, item, price, extra) => ({
  url: `https://${host}/`, title: `${host} shop`, scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: `${item} ${price}`, innerText: `Welcome. ${item} costs ${price}. In stock.`,
  elements: [
    { id: 1, tagName: "input", inputType: "search", accName: "Search products", role: "searchbox", formId: 0 },
    { id: 2, tagName: "button", accName: "Place order" },
  ],
  forms: [{ id: 0, search: true, fields: 1 }],
  ...extra,
});
const blank = { url: "about:blank", title: "", elements: [], innerText: "[No site is open in this tab yet.]", visibleText: "", protectedPage: true };
const home = shopPage("start.example", "Nothing", "$0", {
  elements: [
    { id: 1, tagName: "a", accName: "Shop A", url: "https://a.example/" },
    { id: 2, tagName: "a", accName: "Shop B", url: "https://b.example/" },
    { id: 3, tagName: "a", accName: "Shop C", url: "https://c.example/" },
    { id: 4, tagName: "a", accName: "Shop D", url: "https://d.example/" },
  ],
});

const usage = (cost) => ({ prompt: 100, completion: 10, cost: cost || 0, model: "m" });

/** A parent run with pages for its sub-tasks' tabs, by sub-task id. */
function harness(task, settings) {
  const pages = {};
  const env = (more) => ({
    now: 1000, page: home, settings: { riskConfirmation: true, allowlist: "", verify: false, ...(settings || {}) }, extras: {},
    childEnv: (id) => ({ page: pages[id] || null, extras: {} }),
    ...more,
  });
  const run = RUN.newRun({ id: "r1", task, tabId: 7, startUrl: home.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env());
  const first = RUN.advance(run, { type: "observed", page: home }, env());
  const child = (id, event) => RUN.advance(run, { type: "child", child: id, event }, env());
  return { run, pages, env, first, child };
}

const delegate = (h, tasks) => RUN.advance(h.run, { type: "model_replied", reply: { note: "", goal: "Check each shop at once", do: "delegate", tasks }, usage: usage() }, h.env());

/** Plays one sub-task from its tab opening to its answer. */
function playChild(h, id, page, answer, quote) {
  let fx = h.child(id, { type: "spawned", tabId: 100 + Number(id.slice(-1)) });
  assert.deepEqual(fx.map((f) => [f.type, f.fx && f.fx.type]), [["child_fx", "observe"]]);
  h.pages[id] = blank;
  fx = h.child(id, { type: "observed", page: blank });
  // Its first action is the address it was given, decided by the usual rules.
  assert.equal(fx[0].fx.type, "act");
  assert.equal(fx[0].fx.action.do, "navigate");
  fx = h.child(id, { type: "acted", result: { ok: true, pageChanged: true, message: `Opened ${page.url}` } });
  h.pages[id] = page;
  fx = h.child(id, { type: "observed", page });
  assert.equal(fx[0].fx.type, "model");
  return h.child(id, { type: "model_replied", reply: { note: "", goal: "Answer", do: "done", success: true, answer, evidence: [quote] }, usage: usage(0.001) });
}

test("the step tool offers delegate to a run the user started, and not to a sub-task", () => {
  const h = harness("Compare the Blue Widget's price at shop A and shop B.");
  assert.ok(h.first[0].tool.parameters.properties.do.enum.includes("delegate"));
  assert.ok(h.first[0].tool.parameters.properties.tasks, "the tasks field comes with it");
  assert.match(h.first[0].system, /delegate hands them out/);
  const sub = RUN.newRun({ id: "r1-s1", task: "price at A", tabId: 9, sub: { parent: "r1", request: "compare" } });
  RUN.advance(sub, { type: "start" }, h.env());
  const fx = RUN.advance(sub, { type: "observed", page: shopPage("a.example", "Blue Widget", "$19") }, h.env());
  assert.ok(!fx[0].tool.parameters.properties.do.enum.includes("delegate"));
  assert.ok(!fx[0].tool.parameters.properties.tasks);
  assert.match(fx[0].system, /You do one part of a larger request/);
  assert.doesNotMatch(fx[0].system, /delegate hands them out/);
  assert.match(fx[0].user, /The user's request, of which you do one part:\n"compare"/);
  assert.match(fx[0].user, /Your part, again: "price at A"/);
});

test("a sub-task cannot hand out sub-tasks: the reply is sent back with why", () => {
  const sub = RUN.newRun({ id: "r1-s1", task: "price at A", tabId: 9, sub: { parent: "r1", request: "compare" } });
  const page = shopPage("a.example", "Blue Widget", "$19");
  RUN.advance(sub, { type: "start" }, { now: 1, page });
  RUN.advance(sub, { type: "observed", page }, { now: 1, page });
  const fx = RUN.advance(sub, { type: "model_replied", reply: { note: "", goal: "split", do: "delegate", tasks: [{ task: "x" }] }, usage: usage() }, { now: 2, page });
  assert.equal(fx[0].type, "model", "asked again");
  assert.match(fx[0].user, /delegate is not available here/);
  assert.equal(sub.children.length, 0);
  assert.equal(STEP.checkAction({ do: "delegate", tasks: [{ task: "x" }] }, { canDelegate: false }).error.includes("not available"), true);
});

test("delegate starts its sub-tasks, each answers, and the run carries on with both answers", () => {
  const h = harness("Compare the Blue Widget's price at shop A and shop B.");
  let fx = delegate(h, [{ task: "Find the Blue Widget's price at shop A.", url: "https://a.example/" }, { task: "Find the Blue Widget's price at shop B.", url: "https://b.example/" }]);
  assert.deepEqual(fx, [{ type: "spawn", child: "r1-s1" }, { type: "spawn", child: "r1-s2" }]);
  assert.equal(h.run.children.length, 2);
  assert.equal(h.run.children[0].run.sub.request, h.run.task);
  assert.ok(h.run.journal.some((j) => j.k === "subtasks" && j.ids.length === 2));

  fx = playChild(h, "r1-s1", shopPage("a.example", "Blue Widget", "$19"), "It costs **$19** at shop A.", "Blue Widget costs $19");
  assert.deepEqual(fx.map((f) => [f.type, f.fx && f.fx.type]), [["child_fx", "end"]], "one ended; the other is still at work");
  assert.equal(h.run.delegation.ids.length, 2);
  fx = playChild(h, "r1-s2", shopPage("b.example", "Blue Widget", "$24"), "It costs **$24** at shop B.", "Blue Widget costs $24");
  assert.deepEqual(fx.map((f) => f.fx ? `${f.type}:${f.fx.type}` : f.type), ["child_fx:end", "observe"], "the last one ended: the run looks again");
  assert.equal(h.run.delegation, null);
  const result = h.run.history[h.run.history.length - 1].actions[0];
  assert.match(result.text, /^delegate 2 sub-tasks/);
  assert.equal(result.ok, true);
  assert.match(result.result, /2 sub-tasks ended: 2 answered/);

  // The parent is shown both answers, as page content, and can quote them.
  fx = RUN.advance(h.run, { type: "observed", page: home }, h.env());
  const shown = fx[0].user;
  const inPage = shown.slice(shown.indexOf("PAGE-abcd1234 begins"), shown.indexOf("PAGE-abcd1234 ends"));
  assert.match(inPage, /What your sub-tasks brought back/);
  assert.match(inPage, /It costs \*\*\$19\*\* at shop A/);
  assert.match(inPage, /It costs \*\*\$24\*\* at shop B/);
  fx = RUN.advance(h.run, { type: "model_replied", reply: { note: "", goal: "Answer", do: "done", success: true, answer: "Shop A is cheaper: $19 against $24.", evidence: ["Blue Widget costs $19", "Blue Widget costs $24"] }, usage: usage() }, h.env());
  assert.deepEqual(fx, [{ type: "end" }]);
  assert.equal(h.run.outcome.state, "success", "quotes from the sub-tasks' pages are found");

  // The trace counts the sub-tasks' steps and model calls, and lists their actions.
  const t = RUN.trace(h.run);
  assert.equal(t.ownSteps, 2);
  assert.equal(t.steps, 2 + 2 + 2);
  assert.equal(t.calls, 4, "two parent steps and one step in each sub-task");
  assert.equal(t.children.length, 2);
  assert.equal(t.children[0].calls, 1);
  assert.ok(t.history.some((x) => x.sub === "r1-s2" && /^navigate/.test(x.action)));
  assert.ok(Math.abs(t.costUSD - 0.002) < 1e-9);
});

test("a sub-task that fails comes back with what it found and why", () => {
  const h = harness("Compare the Blue Widget's price at shop A and shop B.");
  delegate(h, [{ task: "Price at A.", url: "https://a.example/" }, { task: "Price at B." }]);
  playChild(h, "r1-s1", shopPage("a.example", "Blue Widget", "$19"), "$19 at A.", "Blue Widget costs $19");
  h.child("r1-s2", { type: "spawned", tabId: 102 });
  h.pages["r1-s2"] = shopPage("b.example", "Blue Widget", "$24");
  h.child("r1-s2", { type: "observed", page: h.pages["r1-s2"] });
  h.child("r1-s2", { type: "model_replied", reply: { note: "Shop B lists the widget but hides the price behind sign-in.", goal: "Look", do: "find", query: "price" }, usage: usage() });
  const fx = h.child("r1-s2", { type: "model_failed", kind: "model", message: "The provider stopped answering." });
  assert.ok(fx.some((f) => f.type === "observe"));
  const result = h.run.history[h.run.history.length - 1].actions[0];
  assert.match(result.result, /2 sub-tasks ended: 1 answered, 1 did not finish/);
  const failed = h.run.delegated.find((r) => r.id === "r1-s2");
  assert.equal(failed.success, false);
  assert.match(failed.answer, /The provider stopped answering/);
  assert.match(failed.answer, /hides the price behind sign-in/, "its notes come back with it");
});

test("an approval inside a sub-task surfaces on the run, names the sub-task, and the user's no goes to that sub-task", () => {
  const h = harness("Order the Blue Widget at shop A and check its price at shop B.");
  delegate(h, [{ task: "Order the Blue Widget at shop A.", url: "https://a.example/" }, { task: "Price at B.", url: "https://b.example/" }]);
  const page = shopPage("a.example", "Blue Widget", "$19");
  h.child("r1-s1", { type: "spawned", tabId: 101 });
  h.pages["r1-s1"] = blank;
  h.child("r1-s1", { type: "observed", page: blank });
  h.child("r1-s1", { type: "acted", result: { ok: true, pageChanged: true, message: "Opened" } });
  h.pages["r1-s1"] = page;
  h.child("r1-s1", { type: "observed", page });
  const fx = h.child("r1-s1", { type: "model_replied", reply: { note: "", goal: "Order it", do: "click", ref: 2 }, usage: usage() });
  assert.equal(fx[0].type, "child_fx");
  assert.equal(fx[0].fx.type, "attention");
  const wait = h.run.children[0].run.wait;
  assert.equal(wait.kind, "approval");
  assert.equal(wait.tabId, 101, "the approval is about the sub-task's own tab");
  const ask = h.run.journal.find((j) => j.k === "ask");
  assert.equal(ask.wait.sub, "r1-s1");
  assert.match(ask.wait.subTask, /Order the Blue Widget at shop A/);
  assert.equal(h.run.status, "running", "the run goes on with its other sub-tasks");
  // The user declines, in the panel, by the wait's id.
  const after = RUN.advance(h.run, { type: "declined", id: wait.id }, h.env());
  assert.deepEqual(after.map((f) => `${f.type}:${f.fx.type}`), ["child_fx:observe"]);
  assert.match(h.run.children[0].run.history[1].actions[0].result, /The user declined this step/);
  assert.ok(h.run.journal.some((j) => j.k === "ask_done" && j.id === wait.id));
});

test("at most three sub-tasks run at once; the fourth starts when one ends", () => {
  const h = harness("Price at four shops.");
  const fx = delegate(h, ["A", "B", "C", "D"].map((x) => ({ task: `Price at ${x}.`, url: `https://${x.toLowerCase()}.example/` })));
  assert.deepEqual(fx.map((f) => f.child), ["r1-s1", "r1-s2", "r1-s3"]);
  assert.equal(h.run.children[3].state, "queued");
  const ended = playChild(h, "r1-s1", shopPage("a.example", "Blue Widget", "$19"), "$19", "Blue Widget costs $19");
  assert.deepEqual(ended.map((f) => (f.type === "spawn" ? `spawn ${f.child}` : `${f.type}:${f.fx.type}`)), ["child_fx:end", "spawn r1-s4"]);
  assert.equal(STEP.checkAction({ do: "delegate", tasks: [1, 2, 3, 4, 5].map((n) => ({ task: `t${n}` })) }, {}).error.includes("at most 4"), true);
});

test("the cost budget counts the sub-tasks' model calls, and stops them with the run", () => {
  const h = harness("Price at two shops.", { costBudget: 0.0015 });
  delegate(h, [{ task: "A", url: "https://a.example/" }, { task: "B", url: "https://b.example/" }]);
  playChild(h, "r1-s1", shopPage("a.example", "Blue Widget", "$19"), "$19", "Blue Widget costs $19");
  assert.equal(h.run.status, "running", "one sub-task's cost alone is under the budget");
  h.child("r1-s2", { type: "spawned", tabId: 102 });
  h.pages["r1-s2"] = shopPage("b.example", "Blue Widget", "$24");
  h.child("r1-s2", { type: "observed", page: blank });
  h.child("r1-s2", { type: "acted", result: { ok: true, pageChanged: true, message: "Opened" } });
  h.child("r1-s2", { type: "observed", page: h.pages["r1-s2"] });
  const fx = h.child("r1-s2", { type: "model_replied", reply: { note: "", goal: "look", do: "find", query: "price" }, usage: usage(0.001) });
  assert.equal(h.run.status, "failed");
  assert.equal(h.run.outcome.kind, "budget");
  assert.match(h.run.outcome.text, /counting its sub-tasks/);
  assert.equal(h.run.children[1].state, "ended");
  assert.equal(h.run.children[1].run.status, "stopped");
  assert.ok(fx.some((f) => f.type === "child_fx" && f.fx.type === "end"), "its tab is let go");
});

test("the model-call guard counts the sub-tasks' calls: their next steps wait for the user's say", () => {
  const h = harness("Price at two shops.");
  h.run.callCeiling = 3;
  delegate(h, [{ task: "A", url: "https://a.example/" }, { task: "B", url: "https://b.example/" }]);
  for (const [id, host] of [["r1-s1", "a.example"], ["r1-s2", "b.example"]]) {
    h.child(id, { type: "spawned", tabId: id === "r1-s1" ? 101 : 102 });
    h.child(id, { type: "observed", page: blank });
    h.child(id, { type: "acted", result: { ok: true, pageChanged: true, message: "Opened" } });
    h.pages[id] = shopPage(host, "Blue Widget", "$19");
  }
  let fx = h.child("r1-s1", { type: "observed", page: h.pages["r1-s1"] });
  assert.equal(fx[0].fx.type, "model");
  fx = h.child("r1-s1", { type: "model_replied", reply: { note: "", goal: "look", do: "find", query: "price" }, usage: usage() });
  assert.equal(h.run.usage.calls, 2);
  fx = h.child("r1-s1", { type: "acted", result: { ok: true, message: "found" } });
  fx = h.child("r1-s1", { type: "observed", page: h.pages["r1-s1"] });
  assert.equal(fx[0].fx.type, "model", "two calls of three: on it goes");
  h.child("r1-s1", { type: "model_replied", reply: { note: "", goal: "look", do: "find", query: "stock" }, usage: usage() });
  h.child("r1-s1", { type: "acted", result: { ok: true, message: "found" } });
  fx = h.child("r1-s1", { type: "observed", page: h.pages["r1-s1"] });
  assert.equal(h.run.status, "waiting");
  assert.equal(h.run.wait.kind, "check_in");
  assert.equal(h.run.wait.reason, "calls");
  assert.ok(!fx.some((f) => f.type === "child_fx" && f.fx.type === "model"), "the step waits");
  // The other sub-task's step waits too.
  fx = h.child("r1-s2", { type: "observed", page: h.pages["r1-s2"] });
  assert.deepEqual(fx, []);
  fx = RUN.advance(h.run, { type: "keep_going", id: h.run.wait.id }, h.env());
  assert.deepEqual(fx.map((f) => `${f.child}:${f.fx.type}`).sort(), ["r1-s1:model", "r1-s2:model"]);
  assert.equal(h.run.status, "running");
});

test("answer now at a check-in stops the sub-tasks, which bring back what they had", () => {
  const h = harness("Price at two shops.");
  h.run.callCeiling = 1;
  delegate(h, [{ task: "A", url: "https://a.example/" }]);
  h.child("r1-s1", { type: "spawned", tabId: 101 });
  h.child("r1-s1", { type: "observed", page: blank });
  h.child("r1-s1", { type: "acted", result: { ok: true, pageChanged: true, message: "Opened" } });
  h.pages["r1-s1"] = shopPage("a.example", "Blue Widget", "$19");
  h.child("r1-s1", { type: "observed", page: h.pages["r1-s1"] });
  assert.equal(h.run.wait.kind, "check_in");
  const fx = RUN.advance(h.run, { type: "wrap_up", id: h.run.wait.id }, h.env());
  assert.ok(fx.some((f) => f.type === "observe"), "the run takes its last step");
  assert.equal(h.run.children[0].result.state, "idle");
  assert.equal(h.run.finalStep, false);
  assert.ok(h.run.wrapUp);
});

test("stopping the run stops its sub-tasks, and a sub-task's tab closed ends only that sub-task", () => {
  const h = harness("Price at two shops.");
  delegate(h, [{ task: "A", url: "https://a.example/" }, { task: "B", url: "https://b.example/" }, { task: "C" }, { task: "D" }]);
  h.child("r1-s1", { type: "spawned", tabId: 101 });
  const closed = h.child("r1-s1", { type: "tab_closed" });
  assert.ok(closed.some((f) => f.type === "child_fx" && f.fx.type === "end"));
  assert.equal(h.run.status, "running");
  assert.equal(h.run.children[0].result.state, "error");
  const fx = RUN.advance(h.run, { type: "stop" }, h.env());
  assert.equal(h.run.status, "stopped");
  assert.ok(h.run.children.every((c) => c.state === "ended"));
  assert.ok(fx.some((f) => f.type === "end"));
  // A tab that comes after its sub-task was stopped is closed again.
  const late = h.child("r1-s2", { type: "spawned", tabId: 222 });
  assert.deepEqual(late, [{ type: "child_fx", child: "r1-s2", fx: { type: "end", tabId: 222 } }]);
});

test("a sub-task's question takes the user's next message as its answer", () => {
  const h = harness("Price at two shops.");
  delegate(h, [{ task: "A", url: "https://a.example/" }]);
  h.child("r1-s1", { type: "spawned", tabId: 101 });
  h.child("r1-s1", { type: "observed", page: blank });
  h.child("r1-s1", { type: "acted", result: { ok: true, pageChanged: true, message: "Opened" } });
  h.pages["r1-s1"] = shopPage("a.example", "Blue Widget", "$19");
  h.child("r1-s1", { type: "observed", page: h.pages["r1-s1"] });
  h.child("r1-s1", { type: "model_replied", reply: { note: "", goal: "ask", do: "ask_user", kind: "question", question: "Which colour?" }, usage: usage() });
  assert.equal(h.run.children[0].run.wait.kind, "question");
  const fx = RUN.advance(h.run, { type: "steer", text: "Blue" }, h.env());
  assert.equal(fx[0].fx.type, "observe");
  assert.deepEqual(h.run.children[0].run.answers, ["Blue"]);
});

test("a sub-task's start address is held to the user's request: one no page showed asks first", () => {
  const h = harness("Compare the widget at two shops.");
  delegate(h, [{ task: "Price at the made-up shop.", url: "https://made-up.example/widget?ref=1" }]);
  h.child("r1-s1", { type: "spawned", tabId: 101 });
  const fx = h.child("r1-s1", { type: "observed", page: blank });
  assert.equal(fx[0].fx.type, "attention");
  assert.equal(h.run.children[0].run.wait.risk, "address");
  // The instruction a model wrote adds no trust: only the user's request does.
  const child = h.run.children[0].run;
  assert.equal(child.request, h.run.task);
  assert.ok(!child.trust.sites.includes("made-up.example"));
});

test("a run saved mid-delegation picks its sub-tasks back up", () => {
  const h = harness("Price at two shops.");
  delegate(h, [{ task: "A", url: "https://a.example/" }, { task: "B" }]);
  h.child("r1-s1", { type: "spawned", tabId: 101 });
  const saved = JSON.parse(JSON.stringify(RUN.toStored(h.run)));
  const fx = RUN.advance(saved, { type: "resume" }, h.env());
  assert.deepEqual(fx.map((f) => (f.type === "spawn" ? `spawn ${f.child}` : `${f.child}:${f.fx.type}`)), ["r1-s1:observe", "spawn r1-s2"]);
});
