"use strict";
// Progress as a stated fact: wandering between pages (revisits, searches
// that reach nothing new), stated once and given one helper spell; what
// counts as progress (a new page, the next page of results, new text read,
// a note); the helper keeping the steps until it gets the run moving; a
// rejected quote as difficulty; finds that matched nothing; and what a
// navigate's result says about where it landed, once or again and again.
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const STEP = require("../../extension/core/step.js");
const CONTEXT = require("../../extension/core/context.js");

const HOST = "https://news.example";
const page = (pathname, extra) => ({
  url: `${HOST}${pathname}`, title: pathname, scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: `Page ${pathname}`, innerText: `Page ${pathname}. Headlines and links. Laptops from $499.`,
  elements: [
    { id: 1, tagName: "input", inputType: "search", accName: "Search", role: "searchbox", formId: 0 },
    { id: 2, tagName: "button", accName: "Go", submits: true, formId: 0 },
    { id: 3, tagName: "a", accName: "Home", url: `${HOST}/` },
  ],
  forms: [{ id: 0, search: true, fields: 1, action: `${HOST}/search` }],
  ...extra,
});
const env = (p) => ({ now: 1000, page: p, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} });
const BIG = { model: "big-model", maxActions: 8, elementLimit: 320, pageBudget: 24000 };

function start(task, first, helper) {
  const run = RUN.newRun({ id: "p1", task, tabId: 7, startUrl: first.url, marker: "PAGE-abcd1234", now: 1, settings: helper ? { helper: BIG } : {} });
  RUN.advance(run, { type: "start" }, env(first));
  const fx = RUN.advance(run, { type: "observed", page: first }, env(first));
  return { run, fx };
}
/** One step: the model's reply, each action's result, and the page after. */
function step(run, at, actions, results, next, note) {
  RUN.advance(run, { type: "model_replied", reply: { note: note || "", goal: "g", do: actions[0].do, ...actions[0], then: actions.slice(1) }, usage: {} }, env(at));
  for (const r of results) RUN.advance(run, { type: "acted", result: { ok: true, message: "Done.", ...r } }, env(at));
  return RUN.advance(run, { type: "observed", page: next }, env(next));
}
const go = (run, from, to, note, arrival) => step(run, from, [{ do: "navigate", url: to.url }], [{ pageChanged: true, message: `Opened ${to.url}`, arrival: arrival || { asked: to.url, url: to.url, status: 200 } }], to, note);
const helperSays = (run) => run.journal.filter((j) => j.title === "Helper Model").map((j) => j.text);

test("rule R: a run that keeps arriving at pages it has been on is told so in numbers, and is in difficulty", () => {
  const hub = page("/");
  const { run } = start("find the market data section", hub);
  let at = hub;
  let fx;
  // Out to a new section and back to the front page, four times.
  for (let i = 1; i <= 4; i++) {
    const spoke = page(`/section-${i}`);
    go(run, at, spoke);
    fx = go(run, spoke, hub);
    at = hub;
  }
  assert.deepEqual(run.progress.wander, { rule: "revisits", count: 4, of: 8 });
  assert.match(fx[0].user, /4 of your last 8 steps arrived at a page you had already been on in this run\. You have been on 5 different pages in all\./);
  assert.equal(RUN.inDifficulty(run), "", "wandering is not difficulty: it does not count toward the stuck stop");
  assert.equal(run.stuck.steps, 0);
  assert.equal(run.progress.fired[0].rule, "revisits");
  assert.equal(run.progress.fired[0].step, 9);
  // Said once: the next step, still wandering, does not repeat it.
  fx = go(run, hub, page("/section-5"));
  assert.ok(run.progress.wander, "the window is still bad");
  assert.doesNotMatch(fx[0].user, /steps arrived at a page you had already been on/);
  assert.equal(run.progress.fired.length, 1);
  const t = RUN.trace(run);
  assert.equal(t.progress.pages, 6);
  assert.equal(t.progress.steps.length, 9);
  assert.deepEqual(t.progress.steps.map((s) => (s.revisit ? "R" : s.newPage ? "N" : "-")).join(""), "NRNRNRNRN");
});

test("rule R does not fire on a run that reaches a new page at each step, nor on three revisits", () => {
  const { run } = start("read every section", page("/"));
  let at = page("/");
  for (let i = 1; i <= 12; i++) { const next = page(`/s/${i}`); go(run, at, next); at = next; }
  assert.equal(run.progress.wander, null);
  assert.equal(RUN.inDifficulty(run), "");
  const three = start("x", page("/")).run;
  let here = page("/");
  for (let i = 1; i <= 3; i++) { go(three, here, page(`/a${i}`)); go(three, page(`/a${i}`), page("/")); here = page("/"); }
  go(three, here, page("/a9"));
  go(three, page("/a9"), page("/a10"));
  assert.equal(three.progress.wander, null, "three revisits in the last eight steps is not wandering");
});

test("rule Q: searches that keep reaching only search results are told so, and a new page among them stops it", () => {
  const home = page("/");
  const results = (q) => page(`/search?q=${encodeURIComponent(q)}`);
  const search = (run, at, q) => step(run, at, [{ do: "fill", ref: 1, value: q }, { do: "press", key: "Enter", ref: 1 }], [{}, { pageChanged: true, message: `Pressed Enter. The page changed: now at ${results(q).url}` }], results(q));
  const { run } = start("find the article about deforestation", home);
  let at = home;
  let fx;
  for (const q of ["deforestation", "deforestation impact", "deforestation 2026", "forest loss"]) { fx = search(run, at, q); at = results(q); }
  assert.ok(run.progress.steps.every((s) => s.search && !s.newPage), "results pages are searches, not new pages");
  assert.deepEqual(run.progress.wander, { rule: "searches", count: 4, of: 4 });
  assert.match(fx[0].user, /4 of your last 4 steps were searches, and none of those steps reached a new page other than search results, read more of a page, or added a note\./);
  assert.equal(RUN.inDifficulty(run), "");
  // The same searches with an article opened among them is not wandering.
  const other = start("find the article about deforestation", home).run;
  at = home;
  search(other, at, "deforestation");
  go(other, results("deforestation"), page("/news/article-1"));
  at = page("/news/article-1");
  for (const q of ["deforestation impact", "deforestation 2026", "forest loss"]) { search(other, at, q); at = results(q); }
  assert.equal(other.progress.wander, null);
});

test("a results address is told by structure: where a search form sends, or the text the run typed", () => {
  const P = RUN.PROGRESS;
  const p = { typed: [], searchForms: ["https://shop.example/find"] };
  assert.equal(P.isSearchAddress(p, "https://shop.example/find?k=mouse"), true, "where a search form seen in the run sends");
  assert.equal(P.isSearchAddress(p, "https://shop.example/find"), false, "with no query, it is the form's page");
  P.typedText(p, { do: "fill", value: "Lakers Celtics" }, "");
  assert.equal(P.isSearchAddress(p, "https://sport.example/search/_/q/lakers%20celtics"), true, "the typed words in the path");
  P.typedText(p, { do: "navigate", url: "https://www.example.org/s?query=blue+wool+socks&chip=M3" }, "blue socks");
  assert.equal(P.isSearchAddress(p, "https://www.example.org/s?query=blue+wool+socks&sid=99"), true, "a query of several words the model wrote");
  assert.equal(P.isSearchAddress(p, "https://www.example.org/p?chip=M3"), false, "a one-word choice is not a query");
  P.typedText(p, { do: "navigate", url: "https://www.example.org/s?q=deforestation" }, "articles on deforestation");
  assert.equal(P.isSearchAddress(p, "https://www.example.org/s?q=deforestation&token=x"), true, "a one-word query that is a word of the request");
});

test("wandering gives the helper one spell of at most three steps, clears the window when it hands back, and never ends the run", () => {
  const hub = page("/");
  const { run } = start("find the market data section", hub, true);
  const tiers = [];
  let fx;
  // Out and back four times: wandering begins as step 9 is asked for.
  for (let i = 1; i <= 4; i++) { go(run, hub, page(`/section-${i}`)); fx = go(run, page(`/section-${i}`), hub); tiers.push(fx[0].tier); }
  assert.equal(fx[0].tier, "helper");
  assert.match(helperSays(run).pop(), /takes step 9: 4 of the last 8 steps arrived at pages already visited in this run/);
  assert.match(fx[0].user, /4 of your last 8 steps arrived at a page you had already been on/);
  // The helper goes on going round: its spell ends after three steps all the same.
  const helperTiers = [];
  for (let i = 5; i <= 6; i++) {
    fx = go(run, hub, page(`/section-${i}`));
    helperTiers.push(fx[0].tier);
    fx = go(run, page(`/section-${i}`), hub);
    helperTiers.push(fx[0].tier);
  }
  // Step 9 (to section 5) reached a new page: progress, so the spell ends after one step.
  assert.deepEqual(helperTiers, ["pro", "pro", "pro", "pro"]);
  assert.deepEqual(RUN.trace(run).progress.handBacks, [{ from: 9, to: 9, steps: 1, progressed: true, wander: true }]);
  assert.equal(run.progress.wander, null, "the window started again when the helper handed back");
  assert.equal(run.wrapUp, null, "wandering never brings the stuck stop");
  // Going on through pages it has been on, in no repeating round, it wanders again: stated again, and a new spell.
  const order = [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3];
  let at = hub;
  let i = 0;
  while (run.progress.fired.length < 2 && i < order.length) { const back = page(`/section-${order[i]}`); i += 1; fx = go(run, at, back); at = back; }
  assert.equal(run.progress.fired.length, 2);
  assert.equal(fx[0].tier, "helper");
  assert.match(fx[0].user, /steps arrived at a page you had already been on/);
  // That spell makes no progress: three helper steps, then the main model, though the run still goes round.
  const spell = [];
  for (let k = 0; k < 4; k++) { const back = page(`/section-${order[i]}`); i += 1; fx = go(run, at, back); at = back; spell.push(fx[0].tier); }
  assert.deepEqual(spell, ["helper", "helper", "pro", "pro"]);
  const last = RUN.trace(run).progress.handBacks.pop();
  assert.equal(last.steps, 3);
  assert.equal(last.progressed, false);
  assert.equal(run.wrapUp, null);
  assert.equal(run.stuck.steps, 0);
  // Without a helper, the fact alone, once.
  const alone = start("find the market data section", hub).run;
  for (let k = 1; k <= 4; k++) { go(alone, hub, page(`/s-${k}`)); fx = go(alone, page(`/s-${k}`), hub); }
  assert.equal(fx[0].tier, "pro");
  assert.equal(alone.progress.due, null);
});

test("the helper keeps the steps until one makes progress, then hands back with what it did", () => {
  const home = page("/");
  const { run } = start("how much is the blue widget?", home, true);
  // Two presses with nothing to show for them: difficulty.
  step(run, home, [{ do: "click", ref: 2 }], [{ noEffect: true }], home);
  let fx = step(run, home, [{ do: "click", ref: 2 }], [{ noEffect: true }], home);
  assert.equal(fx[0].tier, "helper");
  // The helper's step changes the page in place: no new page, no note.
  fx = step(run, home, [{ do: "click", ref: 3 }], [{ pageChanged: true }], home);
  assert.equal(RUN.inDifficulty(run), "", "the run is out of difficulty");
  assert.equal(fx[0].tier, "helper", "but the helper has not got it moving yet");
  assert.match(helperSays(run).pop(), /none of its 1 step so far has made progress \(it takes up to 3\)/);
  // Its next step adds a note: progress, and the run goes back to the main model.
  fx = step(run, home, [{ do: "click", ref: 1 }], [{ pageChanged: true }], home, "Blue widget is $19 on the price list.");
  assert.equal(fx[0].tier, "pro");
  assert.match(fx[0].user, /The helper model took steps 3 to 4 and has handed back to you\. What it did:/);
  assert.match(fx[0].user, /It added to your notes: "Blue widget is \$19 on the price list\."/);
  assert.match(fx[0].user, /It reached no new page\./);
  assert.deepEqual(RUN.trace(run).progress.handBacks, [{ from: 3, to: 4, steps: 2, progressed: true }]);
  // Said once: the step after does not repeat it.
  fx = step(run, home, [{ do: "click", ref: 3 }], [{ pageChanged: true }], home);
  assert.doesNotMatch(fx[0].user, /has handed back to you/);
});

test("a helper that makes no progress hands back after three steps", () => {
  const home = page("/");
  const { run } = start("how much is the blue widget?", home, true);
  step(run, home, [{ do: "click", ref: 2 }], [{ noEffect: true }], home);
  step(run, home, [{ do: "click", ref: 2 }], [{ noEffect: true }], home);
  const tiers = [];
  let fx;
  for (const ref of [3, 1, 3]) { fx = step(run, home, [{ do: "click", ref }], [{ pageChanged: true }], home); tiers.push(fx[0].tier); }
  assert.deepEqual(tiers, ["helper", "helper", "pro"]);
  assert.match(fx[0].user, /The helper model took steps 3 to 5 and has handed back to you/);
  assert.match(fx[0].user, /It added nothing to your notes\./);
  // A helper step that reached a new page hands back at once.
  const other = start("how much is the blue widget?", home, true).run;
  step(other, home, [{ do: "click", ref: 2 }], [{ noEffect: true }], home);
  step(other, home, [{ do: "click", ref: 2 }], [{ noEffect: true }], home);
  fx = go(other, home, page("/p/blue-widget"));
  assert.equal(fx[0].tier, "pro");
  assert.match(fx[0].user, /It reached a new page: https:\/\/news\.example\/p\/blue-widget\./);
});

test("an answer whose quote is in nothing the run read puts the run in difficulty: the helper takes the next step", () => {
  const home = page("/");
  const { run } = start("how much are laptops?", home, true);
  const fx = step(run, home, [{ do: "done", success: true, answer: "From $399.", evidence: ["Laptops from $399"] }], [], home);
  assert.equal(fx[0].tier, "helper");
  assert.match(helperSays(run).pop(), /a quote in the answer was not in anything the run had read/);
  assert.match(fx[0].user, /the nearest text you were shown .*reads: "[^"]*Laptops from \$499/);
  // Without a helper, the same is difficulty for the run's own model.
  const alone = start("how much are laptops?", home).run;
  const own = step(alone, home, [{ do: "done", success: true, answer: "From $399.", evidence: ["Laptops from $399"] }], [], home);
  assert.equal(own[0].effort, "default", "the step after is taken as one in difficulty");
  assert.equal(alone.stuck.steps, 1, "and counts toward the stuck stop");
});

test("two finds in a row that matched nothing bring the helper in, without counting as failures", () => {
  const home = page("/");
  const { run } = start("find the market data", home, true);
  const miss = { ok: true, miss: true, pageChanged: true, message: "Nothing on this page has \"market data\", not in its text and not on any control. find matches words as the page writes them." };
  let fx = step(run, home, [{ do: "find", query: "market data" }], [miss], home);
  assert.equal(fx[0].tier, "pro", "one miss is information");
  fx = step(run, home, [{ do: "find", query: "stock prices" }], [miss], home);
  assert.equal(run.facts.failures, 0);
  assert.equal(fx[0].tier, "helper");
  assert.match(helperSays(run).pop(), /the last 2 finds in a row matched nothing on the page/);
  assert.equal(run.stuck.steps, 0, "and they do not count toward the stuck stop");
  assert.doesNotMatch(fx[0].user, /FAILED\. Nothing on this page/);
  assert.doesNotMatch(fx[0].user, /actions failed/);
  // Another action between two misses: no helper.
  const between = start("find the market data", home, true).run;
  step(between, home, [{ do: "find", query: "a" }], [miss], home);
  step(between, home, [{ do: "click", ref: 3 }], [{ pageChanged: true }], home);
  fx = step(between, home, [{ do: "find", query: "b" }], [miss], home);
  assert.equal(fx[0].tier, "pro");
  assert.equal(RUN.inDifficulty(between), "");
  // A miss between two failures leaves the count as it was.
  const mixed = start("x", home, true).run;
  step(mixed, home, [{ do: "click", ref: 99 }], [], home);
  step(mixed, home, [{ do: "find", query: "a" }], [miss], home);
  assert.equal(mixed.facts.failures, 1);
});

test("progress: the next page of the same search, and the first read of more of a page, count; a revisit does not", () => {
  const P = RUN.PROGRESS;
  assert.equal(P.nextPageOf("https://s.example/search?q=lamp", "https://s.example/search?q=lamp&page=2"), true, "a page number added");
  assert.equal(P.nextPageOf("https://s.example/search?q=lamp&start=10", "https://s.example/search?q=lamp&start=20"), true, "an offset changed");
  assert.equal(P.nextPageOf("https://s.example/search/lamp/2", "https://s.example/search/lamp/3"), true, "a number in the path");
  assert.equal(P.nextPageOf("https://s.example/search/lamp", "https://s.example/search/lamp/page/2"), true, "a page added to the path");
  assert.equal(P.nextPageOf("https://s.example/search?q=lamp", "https://s.example/search?q=desk"), false, "another search");
  assert.equal(P.nextPageOf("https://s.example/search?q=lamp", "https://s.example/search?q=lamp&sort=price"), false, "a choice that is not a number");
  assert.equal(P.nextPageOf("https://s.example/search?q=lamp&page=2", "https://t.example/search?q=lamp&page=3"), false, "another site");
  const home = page("/");
  const results = (n) => page(`/search?q=lamp${n > 1 ? `&page=${n}` : ""}`, { elements: [...home.elements, { id: 7, tagName: "a", accName: "6" }] });
  const { run } = start("find a brass lamp under $50", home);
  step(run, home, [{ do: "fill", ref: 1, value: "lamp" }, { do: "press", key: "Enter", ref: 1 }], [{}, { pageChanged: true, message: `now at ${results(1).url}` }], results(1));
  // Pages 2 to 5 by address, and a numbered control that pages in place.
  for (let n = 2; n <= 5; n++) go(run, results(n - 1), results(n));
  step(run, results(5), [{ do: "click", ref: 7 }], [{ pageChanged: true }], results(5));
  const recs = run.progress.steps;
  assert.deepEqual(recs.map((x) => (x.paged ? "P" : x.search ? "S" : x.newPage ? "N" : "-")).join(""), "SPPPPP");
  assert.ok(recs.slice(1).every(P.madeProgress), "each next page is progress");
  assert.equal(run.progress.wander, null, "paging through results is not wandering");
  // Reading more of a page: progress the first time, not when read again.
  const long = page("/doc", { innerText: `Doc. ${"word ".repeat(5000)}` });
  const reader = start("what does the doc say about lamps?", long).run;
  reader.textCut = true;
  step(reader, long, [{ do: "read" }], [{ pageChanged: true, read: { url: long.url, label: "part 2 of 3", text: "more words" }, message: "Read part 2 of 3." }], long);
  step(reader, long, [{ do: "read", part: 2 }], [{ pageChanged: true, read: { url: long.url, label: "part 2 of 3", text: "more words" }, message: "Read part 2 of 3." }], long);
  assert.deepEqual(reader.progress.steps.map((x) => !!x.read), [true, false]);
  assert.equal(P.madeProgress(reader.progress.steps[0]), true);
});

test("asking again for the address the tab is on is an arrival and a revisit; one that keeps failing is stated", () => {
  const home = page("/");
  const gone = page("/old/report");
  const fail = { asked: gone.url, url: gone.url, status: 404, statusText: "Not Found" };
  const { run } = start("open the annual report", home);
  let fx = go(run, home, gone, "", fail);
  assert.doesNotMatch(fx[0].user, /You have asked for/, "once is not again");
  fx = go(run, gone, gone, "", fail);
  const rec = run.progress.steps[run.progress.steps.length - 1];
  assert.equal(rec.url, gone.url, "the same address asked for again is an arrival");
  assert.equal(rec.revisit, true, "and a revisit");
  assert.equal(run.visits[gone.url], 2);
  assert.match(fx[0].user, /You have asked for https:\/\/news\.example\/old\/report 2 times; it failed each time with status 404 \(Not Found\)\./);
  // Said with the step after each such request, not on every step.
  fx = step(run, gone, [{ do: "click", ref: 3 }], [{ pageChanged: true }], gone);
  assert.doesNotMatch(fx[0].user, /You have asked for/);
  fx = go(run, gone, gone, "", fail);
  assert.match(fx[0].user, /asked for https:\/\/news\.example\/old\/report 3 times/);
  // The same address with a fragment is the same address; a success starts the count again.
  go(run, gone, page("/old/report#top"), "", { ...fail, asked: `${gone.url}#top` });
  assert.equal(run.progress.asks.find((x) => x.url === gone.url).n, 4);
  go(run, gone, gone, "", { asked: gone.url, url: gone.url, status: 200 });
  assert.equal(run.progress.asks.find((x) => x.url === gone.url).n, 0);
  // The same redirect each time counts; a load error too.
  const r = start("x", home).run;
  const moved = { asked: `${HOST}/a`, url: `${HOST}/`, status: 200 };
  go(r, home, page("/a"), "", moved);
  fx = go(r, home, page("/a"), "", moved);
  assert.match(fx[0].user, /asked for https:\/\/news\.example\/a 2 times; it failed each time with a redirect to https:\/\/news\.example\/\./);
  assert.equal(CONTEXT.arrivalFailure({ asked: "https://x.example/", url: "https://x.example/", error: "net::ERR_NAME_NOT_RESOLVED" }), "the error net::ERR_NAME_NOT_RESOLVED");
  assert.equal(CONTEXT.arrivalFailure({ asked: "https://x.example/a/", url: "https://www.x.example/a", status: 200 }), "");
});

test("find says it matches the page's own words, and a miss names the nearest words that are on the page", () => {
  const find = STEP.stepTool({ maxActions: 3 }).parameters.properties.do.description;
  assert.match(find, /find: .*It matches words as the page writes them/);
  assert.deepEqual(CONTEXT.nearestWords("cheap laptop", "Laptops from $499. Cheaper models below. The lap of honour.", 8), ["laptops", "cheaper"]);
  assert.deepEqual(CONTEXT.nearestWords("2026", "Published 05/03/2026 and 20261 items", 8), ["20261"]);
  assert.deepEqual(CONTEXT.nearestWords("zebra", "No such animal here.", 8), []);
});

test("a navigate's result says plainly when it did not land where it asked", () => {
  const note = CONTEXT.arrivalNote;
  assert.equal(note({ asked: "https://www.example.org/news/", url: "https://example.org/news", status: 200 }), "", "the same page, with or without www and a trailing slash");
  assert.match(note({ asked: "https://example.org/a", url: "https://example.org/a", status: 404 }), /^The site answered with status 404 \(Not Found\): what is shown is its error page, not the page at that address\.$/);
  assert.match(note({ asked: "https://example.org/a", url: "https://example.org/a", status: 503, statusText: "Busy" }), /status 503 \(Busy\)/);
  assert.equal(note({ asked: "https://nowhere.example/", url: "https://nowhere.example/", error: "net::ERR_NAME_NOT_RESOLVED" }), "The page did not load: net::ERR_NAME_NOT_RESOLVED.");
  assert.equal(note({ asked: "https://example.org/old/page", url: "https://example.org/", status: 200 }), "You asked for https://example.org/old/page, and the site sent you to another address: https://example.org/, its front page.");
  assert.equal(note({ asked: "https://example.org/x", url: "https://other.example/login", status: 200 }), "You asked for https://example.org/x, and were sent to a different site: https://other.example/login.");
});

test("the trace keeps each step's note and what it reached, for the benchmarks", () => {
  const home = page("/");
  const { run } = start("x", home);
  go(run, home, page("/a"), "Section A lists prices.");
  const t = RUN.trace(run);
  assert.equal(t.history[0].note, "Section A lists prices.");
  assert.equal(t.notes, "Step 1: Section A lists prices.");
  assert.deepEqual(t.progress.steps, [{ step: 1, url: `${HOST}/a`, revisit: false, search: false, newPage: true, note: true }]);
  assert.deepEqual(t.progress.wandering, []);
});
