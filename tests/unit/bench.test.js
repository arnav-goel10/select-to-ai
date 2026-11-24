"use strict";
// The arithmetic and parsing behind the end-to-end benchmark (tests/bench).
const test = require("node:test");
const assert = require("node:assert/strict");
const J = require("../bench/judge.js");

test("a verdict is read from the judge's reply, and an unmet key point overrides 'success'", () => {
  assert.deepEqual(J.parseVerdict('Here you go: {"key_points":["a","b"],"met":[true,true],"success":true,"reason":"ok"}'), { success: true, blocked: false, keyPoints: ["a", "b"], met: [true, true], reason: "ok" });
  const blocked = J.parseVerdict('{"success":true,"blocked":true,"reason":"a human check stood in the way"}');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.success, false, "a blocked run is never a pass");
  assert.equal(J.parseVerdict('{"key_points":["a","b"],"met":[true,false],"success":true,"reason":"x"}').success, false);
  assert.equal(J.parseVerdict('{"success":false,"reason":"no"}').success, false);
  assert.equal(J.parseVerdict("no json here"), null);
  assert.equal(J.parseVerdict('{"success":"yes"}'), null);
});

test("the judge is shown what the run did, not what the agent thought", () => {
  const msg = J.judgeMessage({
    task: "find the fee", startUrl: "https://a.example/", ending: "finished", answer: "The fee is $5.",
    history: [{ step: 1, ok: true, action: 'click [3]', on: "Fees", outcome: "URL changed" }, { step: 2, ok: false, action: "scroll down", on: "", outcome: "no observable page change" }],
    finalUrl: "https://a.example/fees", finalTitle: "Fees", finalText: "Delivery fee: $5", screenshots: [],
  });
  assert.match(msg, /1\. ok {3}click \[3\] on "Fees" -> URL changed/);
  assert.match(msg, /2\. FAIL scroll down -> no observable page change/);
  assert.match(msg, /Final page text \(excerpt\):\nDelivery fee: \$5/);
  assert.ok(!/thought|progress note/i.test(msg));
});

test("success is reported as a mean with its error, solved once, and solved every time", () => {
  const rows = [
    { id: "a", success: true, steps: 4, seconds: 20, costUSD: 0.01, ending: "finished" },
    { id: "a", success: true, steps: 6, seconds: 30, costUSD: 0.01, ending: "finished" },
    { id: "b", success: true, steps: 9, seconds: 60, costUSD: 0.02, ending: "finished" },
    { id: "b", success: false, steps: 25, seconds: 200, costUSD: 0.05, ending: "ran out of steps" },
    { id: "c", success: false, steps: 3, seconds: 15, costUSD: 0.0, ending: "asked the user" },
    { id: "c", success: false, steps: 3, seconds: 15, costUSD: 0.0, ending: "asked the user" },
  ];
  const s = J.summarise(rows);
  assert.equal(s.tasks, 3);
  assert.equal(s.runsPerTask, 2);
  assert.equal(s.success, 0.5);
  assert.ok(Math.abs(s.standardError - Math.sqrt(0.25 / 3)) < 1e-9);
  assert.ok(Math.abs(s.solvedOnce - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.solvedEveryTime - 1 / 3) < 1e-9);
  assert.deepEqual(s.endings, { passed: 3, "ran out of steps": 1, "asked the user": 2 });
  assert.equal(s.passed, 3);
  assert.ok(Math.abs(s.costUSD - 0.09) < 1e-9);
});

test("tasks load from this format or Online-Mind2Web's, and a sample is fixed and spread across levels", () => {
  const tasks = J.normaliseTasks([
    { id: "x", task: "do x", url: "https://x.example/", level: "easy" },
    { task_id: "y", confirmed_task: "do y", website: "https://y.example/", level: "hard" },
    { task_id: "bad", confirmed_task: "no url" },
  ]);
  assert.deepEqual(tasks.map((t) => t.id), ["x", "y"]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, task: "t", url: "https://e.example/", level: ["easy", "medium", "hard"][i % 3] }));
  const a = J.sampleTasks(many, 9, 7);
  assert.equal(a.length, 9);
  assert.deepEqual(a.map((t) => t.id), J.sampleTasks(many, 9, 7).map((t) => t.id), "the same seed gives the same sample");
  assert.notDeepEqual(a.map((t) => t.id), J.sampleTasks(many, 9, 8).map((t) => t.id));
  for (const level of ["easy", "medium", "hard"]) assert.equal(a.filter((t) => t.level === level).length, 3);
});

test("runs lost to the browser, the provider or the judge, and runs a site blocked, are left out of the rate", () => {
  const rows = [
    { id: "a", success: true, steps: 4, ending: "finished", history: [{ action: "click [3]" }, { action: "scroll down" }, { action: "find \"x\"" }, { action: "finish" }] },
    { id: "b", success: false, steps: 9, ending: "finished", history: [] },
    { id: "c", success: false, steps: 0, ending: "harness error: Connection closed." },
    { id: "d", success: false, steps: 0, ending: "provider unavailable" },
    { id: "e", success: false, steps: 5, ending: "finished", judgeFailed: true },
    { id: "f", success: false, steps: 2, ending: "asked the user", blocked: true },
  ];
  const s = J.summarise(rows);
  assert.equal(s.tasks, 2);
  assert.equal(s.success, 0.5);
  assert.equal(s.lost, 3);
  assert.equal(s.blocked, 1);
  assert.equal(s.findingShare, 0.5, "scroll and find are two of the four steps");
  assert.equal(s.endings["harness error"], 1);
  assert.equal(s.endings["blocked by the site"], 1);
  assert.equal(s.endings["not judged"], 1);
  assert.ok(Math.abs(s.successAllRuns - 1 / 6) < 1e-9, "with blocked and lost runs as failures, one task of six passed");
  assert.equal(s.tasksAllRuns, 6);
});

test("the judge sees what earlier pages said about the task, not only the last page", () => {
  const filler = "Lorem ipsum dolor sit amet consectetur. ".repeat(200);
  const msg = J.judgeMessage({
    task: "who are the top contributors", startUrl: "https://code.example/", ending: "finished", answer: "The top contributor is benibenj with 501 commits.",
    history: [], finalUrl: "https://code.example/graph", finalTitle: "Graph", finalText: "A chart.",
    pages: [{ url: "https://code.example/people", title: "People", text: `${filler}\nTop contributors: benibenj 501 commits\n${filler}` }, { url: "https://code.example/graph", title: "Graph", text: "A chart." }],
    screenshots: [],
  });
  assert.match(msg, /Pages visited earlier in the run \(excerpts\):\nPage: People \| https:\/\/code\.example\/people/);
  assert.match(msg, /benibenj 501 commits/);
  assert.equal((msg.match(/code\.example\/graph/g) || []).length, 1, "the final page is not repeated as an earlier one");
  assert.ok(msg.length < 6000, "a long page is cut down to the parts about the task");
});

test("excerpts are chosen by the task's words, not the answer's", () => {
  const filler = (n) => "Lorem ipsum dolor sit amet consectetur adipiscing. ".repeat(n);
  const page = `${filler(20)}\nSponsored: Deluxe Kettle Pro, best seller, buy now\n${filler(30)}\nResults sorted by price: Basic kettle 1.7 litre stainless steel $24, rated 4.6 stars\n${filler(30)}`;
  const task = "Find the cheapest stainless steel kettle rated at least 4 stars";
  const answer = "The Deluxe Kettle Pro, a best seller.";
  const ex = J.excerptFor(page, task, { opening: 200, windows: 1, size: 300 });
  assert.match(ex, /Basic kettle 1\.7 litre stainless steel \$24/, "the window the task points to is shown");
  assert.ok(!/Deluxe Kettle Pro/.test(ex), "words only the answer has do not pull in a window");
  // The old way, by the answer, would have shown the advert instead.
  assert.ok(!J.excerptFor(page, answer, { opening: 200, windows: 1, size: 300 }).includes("Basic kettle"));
});

test("a task word found everywhere on a page counts for less than a rare one", () => {
  const filler = "Lorem ipsum dolor sit amet consectetur adipiscing. ".repeat(10);
  const page = `${filler}${"kettle ".repeat(3)}${filler}`.repeat(6) + `${filler}\nkettle warranty: 5 years\n${filler}`;
  const ex = J.excerptFor(page, "How long is the kettle warranty?", { opening: 100, windows: 1, size: 200 });
  assert.match(ex, /kettle warranty: 5 years/);
});

test("the answer's quotes are located on the pages that contain them, and their text is shown", () => {
  const filler = "Lorem ipsum dolor sit amet consectetur adipiscing. ".repeat(60);
  const run = {
    task: "find the pronunciation of pandemic", startUrl: "https://dictionary.example/", ending: "finished",
    answer: 'Pronunciation: "pan-DEM-ik". Example: \u201cThe 1918 flu pandemic claimed millions of lives.\u201d Also "not on any page at all".',
    history: [], finalUrl: "https://other.example/pandemic", finalTitle: "pandemic", finalText: `${filler}\nThe 1918 flu\npandemic claimed millions of lives.\n${filler}`,
    pages: [{ url: "https://dictionary.example/", title: "Home", text: "Just a moment... pan-DEM-ik" }],
  };
  assert.deepEqual(J.quotesOf(run), ["pan-DEM-ik", "The 1918 flu pandemic claimed millions of lives.", "not on any page at all"]);
  assert.deepEqual(J.quotesOf({ answer: 'x "abcdef"', evidence: ["from the run's own list"] }), ["from the run's own list"]);
  const msg = J.judgeMessage(run);
  assert.match(msg, /- "pan-DEM-ik": on https:\/\/dictionary\.example\//);
  assert.match(msg, /- "The 1918 flu pandemic claimed millions of lives\.": on https:\/\/other\.example\/pandemic/, "a quote across a line break is still found");
  assert.match(msg, /- "not on any page at all": not in the captured page text/);
  assert.match(msg, /the site the task names: dictionary\.example/);
  assert.match(msg, /Final page text \(excerpt\):[\s\S]*1918 flu\npandemic claimed/, "the window around a quote is in the excerpt");
});

test("the judge's instructions hold the rules of a careful user, and say how many screenshots follow", () => {
  const sys = J.JUDGE_SYSTEM;
  assert.match(sys, /careful user/);
  assert.match(sys, /Paying is never required/);
  assert.match(sys, /book, buy, order or reserve is done when .* the point of confirming/);
  assert.match(sys, /another site fails/);
  assert.match(sys, /add nothing the task does not ask for/);
  assert.match(sys, /where the site has one; where it has none/);
  assert.match(sys, /another currency/);
  assert.match(sys, /screenshot/);
  assert.ok(sys.length < 3500, "the instructions stay short");
  assert.ok(!/\u2014/.test(sys));
  const msg = J.judgeMessage({ task: "t", startUrl: "https://www.shop.example/", ending: "finished", answer: "a", history: [], finalUrl: "https://www.shop.example/x", finalText: "x", screenshots: ["a.jpg", "b.jpg"] });
  assert.match(msg, /2 screenshot\(s\) of the run follow, oldest first: the last view of the pages it left most recently, then the final page\./);
  assert.match(msg, /the site the task names: shop\.example/);
  assert.ok(!/screenshot/.test(J.judgeMessage({ task: "t", startUrl: "https://a.example/", answer: "a", history: [], finalText: "x", screenshots: [] })));
});

test("the judge is shown the final page and the last view of each page the run left", () => {
  const files = ["00-step1.jpg", "01-step2.jpg", "02-step3.jpg", "03-step4.jpg", "04-step5.jpg", "05-step6.jpg", "06-final.jpg"];
  const history = [
    { step: 1, outcome: "Typed x" }, { step: 2, outcome: "Opened https://a.example/result" }, { step: 3, outcome: "Scrolled down." },
    { step: 4, outcome: "Clicked element [3]. The page changed: now at https://a.example/other" }, { step: 5, outcome: "Scrolled down." }, { step: 6, outcome: "Finished." },
  ];
  // The result page was last seen after step 3, before step 4 left it.
  assert.deepEqual(J.pickScreenshots(files, history, 3), ["00-step1.jpg", "02-step3.jpg", "06-final.jpg"]);
  assert.deepEqual(J.pickScreenshots(files, [], 3), ["04-step5.jpg", "05-step6.jpg", "06-final.jpg"], "with no page change, the latest");
  assert.deepEqual(J.pickScreenshots(files, history, 1), ["06-final.jpg"]);
  assert.deepEqual(J.pickScreenshots([], history, 3), []);
});

test("the default judge is not a driver and sees screenshots; another model is text only unless told", () => {
  const C = require("../bench/judge-call.js");
  // The agent's key is the judge's too only when both are on one endpoint.
  const d = C.judgeConfig({ BENCH_API_KEY: "k", BENCH_PROVIDER: "custom", BENCH_CUSTOM_URL: C.DEFAULT_JUDGE.url });
  assert.ok(!/gpt-oss-20b|nemotron-3-ultra/.test(d.model), "the judge is neither driver");
  assert.equal(d.vision, true);
  assert.equal(d.shots, 3);
  assert.equal(d.key, "k");
  assert.equal(d.problem, "");
  assert.equal(C.judgeConfig({ BENCH_JUDGE_VISION: "0" }).vision, false);
  assert.equal(C.judgeConfig({ BENCH_JUDGE_MODEL: "some/text-model" }).vision, false);
  assert.equal(C.judgeConfig({ BENCH_JUDGE_MODEL: "some/vl-model", BENCH_JUDGE_VISION: "1", BENCH_JUDGE_SHOTS: "2" }).shots, 2);
});

test("rejudging compares verdicts run by run and lists where they differ", () => {
  const R = require("../bench/rejudge.js");
  const rows = [{ id: "a", run: 1, success: true }, { id: "b", run: 1, success: false, blocked: true }, { id: "c", run: 1, success: false }, { id: "d", run: 1, success: false }];
  const labels = new Map([["a#1", { verdict: "pass" }], ["b#1", { verdict: "blocked" }], ["c#1", { verdict: "pass", why: "values in a screenshot" }]]);
  const a = R.agreement(rows, labels, R.outcomeOf);
  assert.equal(a.same, 2);
  assert.equal(a.total, 3, "a run with no label is not counted");
  assert.deepEqual(a.differ, [{ id: "c", run: 1, judged: "fail", expected: "pass", why: "values in a screenshot" }]);
});

test("the split never moves, sends every task that has been read to dev, and samples each site", () => {
  const tasks = Array.from({ length: 400 }, (_, i) => ({ id: `Site${i % 4}--${i}`, task: "t", url: "https://e.example/", level: `Site${i % 4}` }));
  const a = J.splitTasks(tasks, { inspected: ["Site0--0", "Site1--1"] });
  const b = J.splitTasks(tasks, { inspected: ["Site0--0", "Site1--1"] });
  assert.deepEqual(a.heldOut.map((t) => t.id), b.heldOut.map((t) => t.id));
  assert.ok(a.dev.some((t) => t.id === "Site0--0") && a.dev.some((t) => t.id === "Site1--1"));
  assert.ok(!a.heldOut.some((t) => t.id === "Site0--0"));
  assert.ok(a.dev.length > 120 && a.dev.length < 200, `about 40% in dev, got ${a.dev.length}`);
  for (const site of ["Site0", "Site1", "Site2", "Site3"]) assert.ok(a.heldOut.filter((t) => t.level === site).length > 40, "every site is in the held-out set");
  const sample = J.samplePerGroup(a.heldOut, 5);
  assert.equal(sample.length, 20);
  assert.deepEqual(sample.map((t) => t.id), J.samplePerGroup(a.heldOut, 5).map((t) => t.id));
});
