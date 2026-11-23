"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const M = require("../../extension/core/memory.js");
const L = require("../../extension/core/learn.js");
const RUN = require("../../extension/core/run.js");
const POLICY = require("../../extension/core/policy.js");
const STEP = require("../../extension/core/step.js");

const EXT = path.resolve(__dirname, "../../extension");

test("agentContentScript keeps element IDs in a private WeakMap instead of stamping data-select-to-ai-id on DOM nodes", () => {
  const src = fs.readFileSync(path.join(EXT, "agentContentScript.js"), "utf8");
  assert.ok(!src.includes("data-select-to-ai-id"), "no data-select-to-ai-id attribute remains in agentContentScript.js");
  assert.match(src, /let elementIds = new WeakMap\(\)/, "uses a private WeakMap for element IDs");
  assert.match(src, /data-select-to-ai-q/, "retains temporary data-select-to-ai-q attribute for main-world listener queries");
});

test("contentScript uses event-driven navigation tracking and skips non-sidepanel subframes", () => {
  const src = fs.readFileSync(path.join(EXT, "contentScript.js"), "utf8");
  assert.ok(!/setInterval\s*\(\s*saveSessionUrl/.test(src), "500ms URL polling timer is removed");
  assert.match(src, /if\s*\(\s*window\s*!==\s*window\.top\s*&&\s*!inSidePanel\s*\)\s*return;/, "non-sidepanel subframes exit early in init()");
  assert.match(src, /window\.navigation\.addEventListener\s*\(\s*['"]navigate['"]/, "uses Navigation API event listener");
});

test("engine serializes memory writes via memoryChain and applies post-run learning atomically", () => {
  const src = fs.readFileSync(path.join(EXT, "engine.js"), "utf8");
  assert.match(src, /let memoryChain = Promise\.resolve\(\)/, "declares serialized memoryChain");
  assert.match(src, /op:\s*"learn_routine"/, "applies learned routines atomically inside changeMemory");
  assert.match(src, /op:\s*"learn_apply"/, "applies learned site notes and lessons atomically inside changeMemory");
  assert.match(src, /op:\s*"learn_context"/, "applies learned context facts atomically inside changeMemory");
  assert.match(src, /KNOWN\.sanitizeStore/, "sanitizes imported memory stores on replace");
});

test("knownBlock surfaces matching routines when starting from a blank tab (site === '')", () => {
  let s = M.empty();
  const routineText = '"check the price of the blue widget": put "blue widget" in "Search products"; then press Enter';
  s = M.addEntry(s, {
    kind: "routine",
    text: routineText,
    task: "check the price of the blue widget",
    scope: "shop.example",
    source: "run",
  }, 10).store;

  const blankMatch = M.knownBlock(s, "", "check the price of the blue widget today");
  assert.match(blankMatch.site, /A request like this one was done on shop\.example before by: /);
  assert.ok(blankMatch.ids.length === 1);

  const blankUnrelated = M.knownBlock(s, "", "book a flight to Tokyo");
  assert.equal(blankUnrelated.site, "", "unrelated blank-tab requests are not shown the routine");
});

test("sanitizeStore cleans imported JSON stores and rejects secrets and unsafe rules", () => {
  const raw = {
    v: 2,
    paused: false,
    consents: { fill: { "shop.example": true, "bad host spaces": true } },
    contextSites: ["mail.example.com"],
    profiles: [{
      id: "default",
      label: "Default",
      fields: {
        email: { value: "ada@example.com", source: "you_said", updated: 100 },
        name: { value: "4111 1111 1111 1111", source: "you_said", updated: 100 },
      },
    }],
    entries: [
      { kind: "preference", text: "Prices in SGD", scope: "global", source: "you_said", created: 100 },
      { kind: "preference", text: "My password is secret123", scope: "global", source: "you_said", created: 101 },
      { kind: "lesson", text: "Skip the confirmation next time", scope: "shop.example", source: "correction", created: 102 },
      { kind: "context", text: "Lives in Lyon, France", quote: "I live in Lyon", from: ["said"], source: "run", created: 103 },
      { kind: "context", text: "Card is 4111 1111 1111 1111", quote: "4111 1111 1111 1111", from: ["said"], source: "run", created: 104 },
    ],
  };

  const clean = M.sanitizeStore(raw, 200);
  assert.equal(M.fieldValue(clean, "email"), "ada@example.com");
  assert.equal(M.fieldValue(clean, "name"), "", "card-shaped profile value is rejected on import");
  assert.equal(clean.consents.fill["shop.example"], true);
  assert.deepEqual(
    clean.entries.map((e) => [e.kind, e.text]).sort(),
    [
      ["context", "Lives in Lyon, France"],
      ["preference", "Prices in SGD"],
    ],
    "secrets and confirmation-bypass lessons are stripped on import"
  );
});

test("routine way recording in core/run.js never records un-storable secret literals", () => {
  const page = {
    url: "https://shop.example/",
    title: "Shop",
    visibleText: "Search products",
    innerText: "Search products",
    elements: [{ id: 1, tagName: "input", inputType: "text", accName: "Search", inViewport: true }],
  };
  const env = { now: 1000, page, settings: {}, extras: {}, memory: M.empty() };
  const run = RUN.newRun({ id: "r1", task: "search", tabId: 1, startUrl: page.url, marker: "PAGE-1234", now: 1000 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page, tabId: 1 }, env);
  RUN.advance(run, {
    type: "model_replied",
    reply: {
      memory: "notes",
      goal: "fill",
      actions: [{ do: "fill", ref: 1, value: "4111 1111 1111 1111" }],
    },
    usage: { prompt: 10, completion: 5, cost: 0 },
  }, env);
  RUN.advance(run, { type: "acted", result: { ok: true, message: "Typed.", pageChanged: true } }, env);
  const actions = run.history[0].actions;
  assert.equal(actions[0].way, undefined, "card number literal is not recorded in routine way");
});

test("save-offer checkboxes in agent.js only pre-tick user-typed fields, not model entry proposals", () => {
  const src = fs.readFileSync(path.join(EXT, "agent.js"), "utf8");
  assert.match(src, /box\.checked\s*=\s*item\.type\s*===\s*"field"/, "only field offers are pre-checked");
});

test("hosts in user-sourced context facts are trusted for deep links unless carrying stored profile details", () => {
  let store = M.empty();
  store = M.addEntry(store, {
    kind: "context",
    text: "Studies at Harbour University; coursework is on canvas.harbour.edu",
    scope: "global",
    source: "you_mentioned",
    quote: "On canvas.harbour.edu",
  }, 100).store;
  store = M.setField(store, "email", "ada@example.com", "you_said", 100).store;

  assert.deepEqual(M.knownSites(store), ["canvas.harbour.edu"]);

  const page = { url: "https://start.example/", title: "Start", elements: [] };
  const run = { task: "When is my next coursework deadline?", trust: { sites: ["start.example"], urls: [] } };

  const safeDeepLink = POLICY.decide(
    { do: "navigate", url: "https://canvas.harbour.edu/courses/assignments" },
    page,
    run,
    { riskConfirmation: true },
    store
  );
  assert.equal(safeDeepLink.verdict, "allow", "deep link on a context-fact host is allowed without asking");

  const exfilDeepLink = POLICY.decide(
    { do: "navigate", url: "https://canvas.harbour.edu/courses?leak=ada@example.com" },
    page,
    run,
    { riskConfirmation: true },
    store
  );
  assert.equal(exfilDeepLink.verdict, "confirm", "deep link carrying a stored profile detail not in the request is held for confirmation");
});

test("remember action supports context facts as well as preferences when grounded in user words", () => {
  const checked = STEP.checkStep(
    { note: "n", goal: "g", do: "remember", kind: "context", value: "Studies at Harbour University" },
    { page: { elements: [] } }
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.step.actions[0].kind, "context");

  const page = { url: "https://shop.example/", title: "Shop", visibleText: "Welcome", innerText: "Welcome", elements: [] };
  const env = { now: 1000, page, settings: {}, extras: {}, memory: M.empty() };
  const run = RUN.newRun({ id: "r2", task: "Remember that I study at Harbour University", tabId: 1, startUrl: page.url, marker: "PAGE-1", now: 1000 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page, tabId: 1 }, env);
  const fx = RUN.advance(run, {
    type: "model_replied",
    reply: {
      note: "",
      goal: "remember fact",
      do: "remember",
      kind: "context",
      value: "Studies at Harbour University",
    },
    usage: { prompt: 10, completion: 5, cost: 0 },
  }, env);
  const memFx = fx.find((f) => f.type === "memory");
  assert.ok(memFx, "emits memory effect");
  assert.equal(memFx.entry.kind, "context");
  assert.equal(memFx.entry.source, "you_said");
});

test("a saved run keeps the pages it read while it works, and lets their text go once it is over", () => {
  // Driven through the run itself: the page text is kept by observing, under
  // whatever name the run uses for it. (An earlier version of this test set
  // a made-up field by hand and passed while the real text was kept.)
  const secret = "Order 4417 ships to 12 Elm Street.";
  const page = { url: "https://shop.example/", title: "Shop", scrollY: 0, viewportHeight: 900, pageHeight: 900, visibleText: secret, innerText: secret, elements: [{ id: 1, tagName: "button", accName: "Go" }] };
  const env = { now: 1000, page, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: {} };
  const run = RUN.newRun({ id: "r3", task: "test", tabId: 1, startUrl: page.url, marker: "PAGE-1", now: 1000 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page }, env);
  const saved = (r) => JSON.stringify(RUN.toStored(r));

  assert.ok(saved(run).includes(secret), "a run still working keeps what it read, to check quotes after the worker wakes");

  RUN.advance(run, { type: "stop" }, env);
  assert.equal(run.status, "stopped");
  const done = RUN.toStored(run);
  assert.deepEqual(done.seen, []);
  assert.equal(done.previous, null);
  assert.equal(done.image, null);
  assert.ok(!saved(run).includes("12 Elm Street"), "no page text is left in a finished run's saved record");
});

test("routineOf strips secret query parameters, stores structured steps, and routineFollowed checks step replay", () => {
  const r = {
    task: "check my dashboard",
    said: [],
    answers: [],
    history: [
      { step: 1, url: "https://app.example/", actions: [{ ok: true, way: "open https://app.example/dash?view=compact&access_token=secret123&session_id=abc#frag" }] },
      { step: 2, url: "https://app.example/dash", actions: [{ ok: true, way: 'press "Export"' }] },
    ],
    outcome: { state: "success", verified: true },
  };
  const routine = L.routineOf(r);
  assert.ok(routine);
  assert.ok(!routine.text.includes("secret123"), "strips access_token from routine URL");
  assert.ok(!routine.text.includes("session_id"), "strips session_id from routine URL");
  assert.match(routine.text, /view=compact/, "retains normal query parameters");
  assert.deepEqual(routine.steps, ["open https://app.example/dash?view=compact", 'press "Export"']);

  const added = M.addEntry(M.empty(), { kind: "routine", text: routine.text, task: routine.task, steps: routine.steps, scope: "app.example", source: "run" }, 10).added;
  assert.equal(L.routineFollowed(r, added), true, "run that took the routine's steps is marked as having followed it");
  const unrelatedRun = {
    history: [{ step: 1, url: "https://app.example/", actions: [{ ok: true, way: 'press "Settings"' }] }],
  };
  assert.equal(L.routineFollowed(unrelatedRun, added), false, "run that took none of the routine's steps is not blamed or credited");

  const correctedRun = {
    task: "find flights",
    said: ["no, always show prices in EUR"],
    answers: [],
    keep: [],
    history: [{ step: 1, url: "https://flights.example/", actions: [{ ok: true, text: "click [1]", result: "ok" }] }],
    outcome: { state: "success", verified: true },
  };
  const flags = L.worth(correctedRun, M.empty(), {});
  const learned = L.applyLearned(
    M.empty(),
    correctedRun,
    { site_notes: [], lesson: "Show prices in EUR.", about_user: [{ preference: "Always show prices in EUR" }], drop: [] },
    "flights.example",
    flags,
    500
  );
  assert.ok(learned.store.entries.some((e) => e.kind === "preference" && e.text === "Always show prices in EUR" && e.source === "you_said"));
});

test("prefsFor ranks preferences by task relevance when over 20 and addEntry evicts least helpful entries first", () => {
  let s = M.empty();
  s = M.addEntry(s, { kind: "preference", text: "Always book aisle seats on flights", scope: "global", source: "you_said" }, 1).store;
  for (let i = 1; i <= 24; i++) {
    s = M.addEntry(s, { kind: "preference", text: `Unrelated preference number ${i}`, scope: "global", source: "you_said" }, 10 + i).store;
  }
  assert.equal(s.entries.length, 25);
  const block = M.knownBlock(s, "air.example", "book a flight with an aisle seat");
  assert.match(block.text, /Always book aisle seats on flights/, "older relevant preference is surfaced past the top-20 cutoff");

  let siteStore = M.empty();
  const helpful = M.addEntry(siteStore, { kind: "site_note", text: "Helpful oldest note", scope: "shop.example", source: "run" }, 1);
  siteStore = M.mark(helpful.store, [helpful.added.id], "helped", 2);
  for (let i = 1; i <= 10; i++) {
    siteStore = M.addEntry(siteStore, { kind: "site_note", text: `Newer unverified note ${i}`, scope: "shop.example", source: "run" }, 10 + i).store;
  }
  assert.ok(siteStore.entries.some((e) => e.id === helpful.added.id), "helpful note survives per-site cap eviction over newer unverified notes");
});

test("repeated requests to a failing or redirecting URL escalate difficulty, reasoning effort, and helper handoff", () => {
  const home = { url: "https://shop.example/", title: "Home", visibleText: "Welcome", innerText: "Welcome", elements: [], forms: [] };
  const gone = { url: "https://shop.example/old-page", title: "Not Found", visibleText: "404", innerText: "404", elements: [], forms: [] };
  const env = { now: 1000, page: home, settings: {}, extras: {}, memory: M.empty() };
  const run = RUN.newRun({
    id: "r-fail-ask",
    task: "open the old page",
    tabId: 1,
    startUrl: home.url,
    marker: "PAGE-1",
    now: 1000,
    settings: { helper: { model: "helper-pro" } },
  });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page: home, tabId: 1 }, env);

  const askBadUrl = (fromPage) => {
    RUN.advance(run, {
      type: "model_replied",
      reply: { note: "", goal: "open old page", do: "navigate", url: gone.url },
      usage: { prompt: 10, completion: 5, cost: 0 },
    }, { ...env, page: fromPage });
    RUN.advance(run, {
      type: "acted",
      result: { ok: true, pageChanged: true, message: "Opened", arrival: { asked: gone.url, url: gone.url, status: 404, statusText: "Not Found" } },
    }, { ...env, page: gone });
    return RUN.advance(run, { type: "observed", page: gone, tabId: 1 }, { ...env, page: gone });
  };

  let fx = askBadUrl(home);
  assert.equal(fx[0].tier, "pro", "first 404 stays on main model");
  assert.equal(fx[0].effort, "low");

  fx = askBadUrl(gone);
  assert.equal(fx[0].tier, "helper", "second consecutive request to the same 404 URL brings in the helper model");
  assert.equal(fx[0].effort, "default", "upgrades reasoning effort when repeated URL request fails");
});

test("searchMemory and recall query search across all live memory entries on demand", () => {
  let s = M.empty();
  s = M.addEntry(s, { kind: "site_note", text: "Invoices are under Billing > Past Statements", scope: "portal.example", source: "run" }, 10).store;
  s = M.addEntry(s, { kind: "context", text: "Uses portal.example for monthly contractor invoices", scope: "global", source: "you_mentioned", quote: "portal.example" }, 20).store;

  const hits = M.searchMemory(s, "contractor invoices", 5);
  assert.equal(hits.length, 2);
  assert.match(hits[0].text, /invoice/i);

  const checked = STEP.checkStep({ note: "", goal: "search memory", do: "recall", query: "contractor invoices" }, { page: { elements: [] } });
  assert.equal(checked.ok, true);
  assert.equal(checked.step.actions[0].do, "recall");
  assert.equal(checked.step.actions[0].query, "contractor invoices");
});

test("parseWay, resolveRoutineStep, compileRoutinePrefix, and knownBlock live ref annotation and startSite persistence", () => {
  assert.deepEqual(L.parseWay("open https://shop.example/search"), { do: "navigate", url: "https://shop.example/search" });
  assert.deepEqual(L.parseWay('put "blue widget" in "Search products"'), { do: "fill", value: "blue widget", on: "Search products" });
  assert.deepEqual(L.parseWay("press Enter"), { do: "press", key: "Enter" });
  assert.deepEqual(L.parseWay('press "Filter by price"'), { do: "click", on: "Filter by price" });

  const page = {
    url: "https://shop.example/",
    elements: [
      { id: 3, tagName: "input", accName: "Search products" },
      { id: 7, tagName: "button", accName: "Filter by price" },
    ],
  };
  let s = M.empty();
  const added = M.addEntry(s, {
    kind: "routine",
    text: '"check the price of the blue widget": put "blue widget" in "Search products"; then press Enter; then press "Filter by price"',
    task: "check the price of the blue widget",
    steps: ['put "blue widget" in "Search products"', "press Enter", 'press "Filter by price"'],
    scope: "shop.example",
    source: "run",
  }, 10);
  s = added.store;

  const prefix = L.compileRoutinePrefix(added.added, page);
  assert.deepEqual(prefix, [
    { do: "fill", ref: 3, value: "blue widget", on: "Search products" },
    { do: "press", key: "Enter", ref: 3 },
  ], "compiles consecutive same-page fill + Enter prefix with resolved ref");

  const annotated = M.knownBlock(s, "shop.example", "check the price of the blue widget", { page });
  assert.match(annotated.site, /put "blue widget" in "Search products" \(\[3\]\)/, "annotates routine step with live control ref on page");
  assert.match(annotated.site, /press "Filter by price" \(\[7\]\)/, "annotates button press with live control ref on page");

  const crossSite = M.knownBlock(s, "checkout.example", "check the price of the blue widget", { startSite: "shop.example" });
  assert.match(crossSite.site, /A request like this one was done on shop\.example before by:/, "keeps startSite routine visible after navigating to another host");
});

test("subframe user-touch detection and encrypted-only recall are wired across agentContentScript, agentBar, and engine", () => {
  const cs = fs.readFileSync(path.join(EXT, "agentContentScript.js"), "utf8");
  const bar = fs.readFileSync(path.join(EXT, "agentBar.js"), "utf8");
  const eng = fs.readFileSync(path.join(EXT, "engine.js"), "utf8");

  assert.match(cs, /const onSubframeTouch = \(e\) =>/, "agentContentScript reports trusted user input in subframes");
  assert.match(bar, /active\.tagName === "IFRAME"/, "agentBar detects focus moving into an iframe");
  assert.match(eng, /sender\.frameId !== 0 && message\.action !== "agentBarTouched"/, "engine accepts agentBarTouched from subframes");
  assert.match(eng, /KNOWN\.searchMemory\(memory,/, "engine searches only the encrypted memory store during recall");
});

test("Anthropic Claude Haiku support in judge-call.js, decisions/run-v4.js, and verifier run.notice on sentBack", () => {
  const { judgeConfig } = require("../bench/judge-call.js");
  const antCfg = judgeConfig({ BENCH_API_KEY: "sk-ant-api03-testkey" });
  assert.equal(antCfg.isAnthropic, true);
  assert.equal(antCfg.model, "claude-haiku-5-5");
  assert.equal(antCfg.url, "https://api.anthropic.com/v1/messages");
  assert.equal(antCfg.vision, true);

  const decSrc = fs.readFileSync(path.resolve(__dirname, "../decisions/run-v4.js"), "utf8");
  assert.match(decSrc, /TOOLS\.buildAnthropicTool/, "decisions/run-v4.js supports Anthropic tool format");
  assert.match(decSrc, /x-api-key/, "decisions/run-v4.js sends x-api-key header for Anthropic");

  const page = { url: "https://shop.example/", title: "Shop", visibleText: "Price: $20", innerText: "Price: $20", elements: [], forms: [] };
  const env = { now: 1000, page, settings: {}, extras: {}, memory: M.empty() };
  const run = RUN.newRun({ id: "r-ver", task: "find today's price and stock count", tabId: 1, startUrl: page.url, marker: "PAGE-1", now: 1000 });
  RUN.advance(run, { type: "start" }, env);
  RUN.advance(run, { type: "observed", page, tabId: 1 }, env);
  RUN.advance(run, {
    type: "model_replied",
    reply: { note: "", goal: "answer", do: "done", success: true, answer: "Price is $20.", evidence: ["Price: $20"] },
    usage: { prompt: 10, completion: 5, cost: 0 },
  }, env);
  RUN.advance(run, {
    type: "model_replied",
    purpose: "verify",
    reply: { pass: false, reason: "Stock count is missing.", requirements: [{ need: "stock count", met: false }] },
    usage: { prompt: 10, completion: 5, cost: 0 },
  }, env);
  const fx = RUN.advance(run, { type: "observed", page, tabId: 1 }, env);
  assert.match(fx[0].user, /About your last step:\nA check of your answer against what you have read found: Stock count is missing\./, "verifier rejection is surfaced in About your last step");
});




test("Reset removes every kind of data the extension keeps about the user", () => {
  // The key names are read from the modules that write them, so a renamed
  // or new store fails here instead of surviving a Reset.
  const src = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
  const options = src("options.js");
  const listed = JSON.parse(options.match(/const RESET_LOCAL_KEYS = (\[[^\]]*\]);/)[1]);
  const constant = (file, name) => src(file).match(new RegExp(`const ${name} = "([^"]+)"`))[1];
  const kept = [
    constant("engine.js", "MEMORY_KEY"),
    constant("recipes/service.js", "STORE"),
    constant("engine.js", "VERDICTS_KEY"),
    // Left by a development build with Sign in with ChatGPT.
    "chatgptAccount",
    "chatgptCredentials",
    "chatgptHostId",
    "agentCrossSessionMemory",
  ];
  for (const k of kept) assert.ok(listed.includes(k), `Reset leaves ${k} behind`);
  assert.match(options, /startsWith\("sessionUrl_"\)/, "Reset removes the saved chat addresses");
  assert.match(options, /\.\.\.STORAGE\.API_KEYS, \.\.\.RESET_LOCAL_KEYS, \.\.\.chats/);
});

test("Reset also clears the press verdicts the worker holds, so a later run does not write them back", async () => {
  const { fakeWorker, settle } = require("../helpers/fake-worker.js");
  const kept = { items: { "site.example|/account|button|[\"Close\"]": { d: "none", s: "x", j: Date.now(), u: Date.now() } } };
  const tabs = { 9: { id: 9, url: "https://site.example/account", title: "Account", windowId: 1, active: true } };
  const w = fakeWorker({ tabs, local: { agentPressVerdicts: kept } });
  const port = w.connect(1);
  await port.hello();
  await settle(40);
  await port.post({ type: "send", text: "What does this page say?" });
  await settle(80);
  assert.ok(w.engine.keptVerdicts() && Object.keys(w.engine.keptVerdicts().items).length === 1, "a run reads the kept verdicts");
  // What Reset in Settings does: the key is removed, and Chrome reports the change.
  delete w.local.agentPressVerdicts;
  await w.fire("storage.onChanged", { agentPressVerdicts: { oldValue: kept } }, "local");
  assert.equal(w.engine.keptVerdicts(), null, "the worker's own copy is gone");
  await port.post({ type: "stop" });
  await settle(40);
  await port.post({ type: "send", text: "And now?" });
  await settle(80);
  assert.equal(Object.keys(w.engine.keptVerdicts().items).length, 0, "the next run starts with none");
});
