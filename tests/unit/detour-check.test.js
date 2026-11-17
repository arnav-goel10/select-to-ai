"use strict";
// A human check on a site the run went to by itself (a search engine it
// typed an address for) does not end the run by asking the user: the model
// is told to go back and answer from what it has read. A check on the
// task's own site is still handed to the user, and every hand-off carries
// what the run had found before it.
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const POLICY = require("../../extension/core/policy.js");

const table = {
  url: "https://www.bbc.com/sport/football/premier-league/table", title: "Premier League table", scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Premier League table", innerText: "Premier League table. 1 Arsenal 10 9 0 1 15 5 10 27. Last Updated 9th November.",
  elements: [{ id: 1, tagName: "a", accName: "Arsenal", url: "https://www.bbc.com/sport/football/teams/arsenal" }],
};
const sorry = (url) => ({
  url: url || "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dpremier", title: "https://www.google.com/search?q=premier",
  scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Our systems have detected unusual traffic from your computer network.",
  innerText: "Our systems have detected unusual traffic from your computer network. I'm not a robot",
  elements: [{ id: 1, tagName: "input", inputType: "checkbox", accName: "I'm not a robot" }],
});
const env = (page) => ({ now: 1000, page, settings: { riskConfirmation: false, allowlist: "", verify: true }, extras: {} });
const reply = (run, page, actions, note) => RUN.advance(run, { type: "model_replied", reply: { note: note || "", goal: "g", actions }, usage: {} }, env(page));

// A run on the BBC table that wrote down the leader, then opened a search engine itself.
function detoured(page) {
  const run = RUN.newRun({ id: "r1", task: "Who is top of the Premier League right now, and on how many points?", tabId: 7, startUrl: table.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(table));
  RUN.advance(run, { type: "observed", page: table }, env(table));
  const fx = reply(run, table, [{ do: "navigate", url: "https://www.google.com/search?q=premier+league+table" }], "BBC table: Arsenal 1st on 27 points, updated 9 Nov.");
  assert.equal(fx[0].type, "act");
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Opened the page.", pageChanged: true } }, env(page));
  const seen = RUN.advance(run, { type: "observed", page }, env(page));
  return { run, seen };
}

test("a human check on a search engine the run opened itself is not handed to the user: the model is told to go back and answer", () => {
  const page = sorry();
  const { run, seen } = detoured(page);
  assert.equal(seen[0].type, "model");
  assert.match(seen[0].user, /human check on google\.com, a site you opened yourself that the request does not need/);
  const fx = reply(run, page, [{ do: "ask_user", kind: "human_check", question: "Please pass the check." }]);
  assert.notEqual(run.status, "waiting", "the run does not stop to ask the user");
  assert.equal(run.wait, null);
  assert.ok(!fx.some((f) => f.type === "attention"));
  assert.deepEqual(fx, [{ type: "observe" }]);
  const last = run.history[run.history.length - 1].actions[0];
  assert.equal(last.ok, false);
  assert.match(last.result, /Not handed to the user: this human check is on google\.com/);
  assert.match(last.result, /finish from what you have already read\. Say in your answer what you could not confirm\./);
});

test("a press on a detour's check is not run and does not hand off either", () => {
  const page = sorry();
  const { run } = detoured(page);
  const fx = reply(run, page, [{ do: "click", ref: 1 }]);
  assert.notEqual(run.status, "waiting");
  assert.deepEqual(fx, [{ type: "observe" }], "nothing on the check is pressed");
  assert.match(run.history[run.history.length - 1].actions[0].result, /Not handed to the user/);
});

test("a human check on the site the task is about is still handed to the user", () => {
  const page = sorry("https://www.bbc.com/sport/football/premier-league/table?check=1");
  const run = RUN.newRun({ id: "r1", task: "Who is top of the Premier League?", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  const seen = RUN.advance(run, { type: "observed", page }, env(page));
  assert.match(seen[0].user, /Only the user can pass it/);
  const fx = reply(run, page, [{ do: "ask_user", kind: "human_check", question: "Please pass the check." }]);
  assert.equal(fx[0].type, "attention");
  assert.equal(run.status, "waiting");
  assert.equal(run.wait.kind, "human_check");
});

test("a check on another site the task's own page led to (not an address the agent wrote) is still the user's", () => {
  const run = RUN.newRun({ id: "r1", task: "Book a table", tabId: 7, startUrl: table.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(table));
  RUN.advance(run, { type: "observed", page: table }, env(table));
  reply(run, table, [{ do: "click", ref: 1 }]);
  const page = sorry("https://booking.example/verify");
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Clicked.", pageChanged: true } }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  assert.equal(POLICY.detourSite(page, run), "");
  reply(run, page, [{ do: "ask_user", kind: "human_check", question: "Please pass the check." }]);
  assert.equal(run.status, "waiting");
  assert.equal(run.wait.kind, "human_check");
});

test("a site the request names is the task's own, even when the run opened it by address", () => {
  const run = RUN.newRun({ id: "r1", task: "on google.com, search for the table", tabId: 7, startUrl: table.url, marker: "PAGE-abcd1234", now: 1 });
  run.wentTo = ["google.com"];
  assert.equal(POLICY.detourSite(sorry(), run), "");
  run.task = "who is top?";
  assert.equal(POLICY.detourSite(sorry(), run), "google.com");
});

test("a hand-off to the user carries what the run had found before it", () => {
  const page = sorry("https://www.bbc.com/sport/football/premier-league/table?check=1");
  const run = RUN.newRun({ id: "r1", task: "Who is top of the Premier League?", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  reply(run, page, [{ do: "ask_user", kind: "human_check", question: "Please pass the check." }], "Arsenal were 1st on 27 points on the cached table.");
  assert.equal(run.status, "waiting");
  assert.match(run.wait.found, /Arsenal were 1st on 27 points/);
  const asked = run.journal.filter((j) => j.k === "ask").pop();
  assert.match(asked.wait.found, /Arsenal were 1st on 27 points/);
});

test("a hand-off with nothing found yet carries no findings", () => {
  const page = sorry("https://www.bbc.com/sport/football/premier-league/table?check=1");
  const run = RUN.newRun({ id: "r1", task: "Who is top of the Premier League?", tabId: 7, startUrl: page.url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(page));
  RUN.advance(run, { type: "observed", page }, env(page));
  reply(run, page, [{ do: "ask_user", kind: "human_check", question: "Please pass the check." }]);
  assert.equal(run.wait.found, undefined);
});

test("a press refused because something covers the control names no pointer: nothing was pressed", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../extension/agentContentScript.js"), "utf8");
  const body = src.match(/function coveredResult\(id, what, hovering\) \{[\s\S]*?\n    \}\n/);
  assert.ok(body, "coveredResult is in the content script");
  const coveredResult = new Function(`${body[0]}; return coveredResult;`)();
  const r = coveredResult(4, "a cookie banner", false);
  assert.equal(r.success, false);
  assert.equal(r.covered, true);
  assert.equal(r.pointer, undefined, "a refused press is not counted as a real pointer press");
  assert.match(r.error, /Nothing was pressed/);
});
