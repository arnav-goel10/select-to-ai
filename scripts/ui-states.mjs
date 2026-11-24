// Renders the agent page in every state of a run, plus the other pages, for design review.
//   node scripts/ui-states.mjs [outDir]
//
// The run view is driven with scripted engine messages: the page's port to
// the service worker is replaced, before its scripts run, by one this script
// feeds snapshots, entries and streamed text, the same messages engine.js
// sends. The tab a run works in is reported at a fixed address. Every state
// is shot in light and dark, at 400 and 1280 pixels wide.
import puppeteer from "puppeteer";
import path from "node:path";
import fs from "node:fs";

const EXT = path.resolve("extension");
const OUT = path.resolve(process.argv[2] || "ui-states");
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--hide-scrollbars"],
});
const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker");
const worker = await workerTarget.worker();
const id = new URL(workerTarget.url()).host;
await new Promise((r) => setTimeout(r, 800));
for (const p of await browser.pages()) if (p.url().startsWith("chrome-extension")) await p.close();

async function storage(ready) {
  await worker.evaluate(async (ready) => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ showAgent: true, agentActiveProvider: "openrouter", ...(ready ? {} : {}) });
    await chrome.storage.local.set({ onboardingComplete: true, ...(ready ? { agentOpenRouterKey: "sk-or-v1-demo" } : {}) });
    const now = Date.now();
    await chrome.storage.local.set({
      agentCrossSessionMemory: [
        { task: "Find the cheapest one-way flight from Singapore to Tokyo on 14 November", timestamp: now - 4 * 60000, outcome: "success" },
        { task: "Compare the three laptops in my tabs on battery life", timestamp: now - 3 * 3600000, outcome: "unconfirmed" },
        { task: "Book a table for two at Burnt Ends on Friday at 8pm", timestamp: now - 26 * 3600000, outcome: "idle" },
        { task: "Download last month's invoice from the electricity account", timestamp: now - 3 * 86400000, outcome: "error" },
        { task: "Summarize this page in 5 short bullet points.", timestamp: now - 9 * 86400000, outcome: "success" },
      ],
    });
  }, ready);
}

// ------------------------------------------------------------ the scripted run
const TASK = "Find the cheapest one-way flight from Singapore to Tokyo on 14 November and tell me the airline and price.";
const FLIGHTS = "https://www.google.com/travel/flights?q=SIN-TYO";
const SITE2 = "https://www.zipair.net/en/booking";

const log = (role, title, text) => ({ k: "log", role, title, text, fold: false });
// What the run did for itself: kept for the saved log, not drawn as a step.
const quiet = (role, title, text) => ({ ...log(role, title, text), quiet: true });
const status = (role, text) => ({ k: "status", role, text });
const BASE = [
  status("executor", "Looking at the page…"),
  log("system", "Task Started", TASK),
  log("executor", "Step 1", "Open Google Flights and search for the route"),
  log("executor", "Action", `navigate ${FLIGHTS}`),
  log("executor", "Result", "Opened Google Flights. The page shows a search form with Where from, Where to and a date field."),
  status("executor", "Step 2…"),
  log("executor", "Step 2", "Enter Singapore and Tokyo as the cities"),
  log("executor", "Action", 'fill [14] "Where from?": "Singapore"'),
  log("executor", "Result", 'Filled "Where from?" with "Singapore". A list opened: Singapore (SIN), Singapore Changi.'),
  log("executor", "Action", 'fill [15] "Where to?": "Tokyo"'),
  log("executor", "Result", 'Filled "Where to?" with "Tokyo". A list opened: Tokyo (all airports), Narita, Haneda.'),
  status("executor", "Step 3…"),
  log("executor", "Step 3", "Set the date to 14 November, one way"),
  log("executor", "Action", 'click [22] "Departure"'),
  log("error", "Action Failed", "[22] is covered: a div with no words is drawn over it. Nothing changed."),
  log("executor", "Action", 'click [41] "One way"'),
  log("executor", "Result", "Trip type is now One way. A date picker opened on November 2026."),
  status("executor", "Step 4…"),
  log("executor", "Step 4", "Sort the results by price"),
  log("executor", "Action", 'click [57] "Sort by"'),
  log("executor", "Result", "Sorted by price. 38 flights listed, cheapest first: ZIPAIR S$248, Scoot S$265, Peach S$281."),
];
const history = [
  { step: 1, ok: true, action: `navigate ${FLIGHTS}`, url: FLIGHTS },
  { step: 2, ok: true, action: 'fill [14] "Where from?"', url: FLIGHTS },
  { step: 3, ok: true, action: 'click [41] "One way"', url: FLIGHTS },
  { step: 4, ok: true, action: 'click [57] "Sort by"', url: FLIGHTS },
];
const trace = (extra) => ({ id: "run-1", task: TASK, steps: 4, running: true, waitingForUser: false, waitKind: "", stopState: "", activeMs: 47000, tokens: { prompt: 41200, completion: 2900 }, costUSD: 0, tabId: 1, history, ...extra });
const snap = (status, journal, extra, wait) => ({ type: "snapshot", turns: [], run: { id: "run-1", task: TASK, status, journal, wait: wait || null, trace: trace(extra) } });
const ask = (wait) => ({ k: "ask", wait: { id: "w1", detail: [], tabId: 1, risk: "", ...wait } });

const ANSWER = [
  "The cheapest one-way flight from Singapore to Tokyo on **14 November** is **ZIPAIR ZG52, S$248**, leaving Changi at 23:55 and landing at Narita at 07:50 the next morning.",
  "",
  "### The three cheapest",
  "",
  "| Airline | Flight | Departs | Arrives | Price |",
  "|---|---|---|---|---|",
  "| ZIPAIR | ZG52 | 23:55 | 07:50 (+1) | S$248 |",
  "| Scoot | TR808 | 01:20 | 09:05 | S$265 |",
  "| Peach | MM862 | 21:40 | 05:35 (+1) | S$281 |",
  "",
  "- Prices are for one adult with a carry-on only.",
  "- ZIPAIR charges extra for checked bags and seat choice.",
].join("\n");
const DONE = [
  ...BASE,
  status("executor", "Step 5…"),
  log("executor", "Step 5", "Open the cheapest fare to check the final price"),
  log("executor", "Action", `tabs open ${SITE2}`),
  log("executor", "Result", "The ZIPAIR booking page shows ZG52 on 14 Nov at S$248 including taxes."),
  status("validator", "Checking the answer…"),
  quiet("validator", "Checking Answer", "Checking the answer against what was read."),
  quiet("validator", "Check Passed", "The price, flight and times all appear on the pages read."),
];
const SOURCES = [{ url: FLIGHTS, title: "Google Flights" }, { url: SITE2, title: "ZIPAIR booking" }];
// The answer shown at once while the check runs, then confirmed or sent back.
const CHECKING = [...DONE.slice(0, -1), quiet("system", "Reply Without Action", "The model answered without calling verdict. Asking again (1/2)."), { k: "provisional", text: ANSWER, sources: SOURCES, round: 1 }];
const WRONG = ANSWER.replace("23:55 and landing at Narita at 07:50 the next morning", "08:10 and landing at Haneda at 16:05");
const SENT_BACK = [...DONE.slice(0, -2), { k: "provisional", text: WRONG, sources: SOURCES, round: 1 }, log("validator", "Check Failed", "The departure and landing times are not on any page that was read."), { k: "provisional_replaced", why: "The departure and landing times are not on any page that was read." }, status("executor", "Step 6…"), log("executor", "Step 6", "Read the times on the ZIPAIR page"), status("executor", "Reading the flight times…")];
const historyDone = [...history, { step: 5, ok: true, action: `tabs open ${SITE2}`, url: SITE2 }];
const used = { details: [], notes: 2, kinds: { site_note: 1, preference: 1 } };

// A run that hands out sub-tasks: three stores checked side by side, each
// in its own tab, one of them waiting for the user's go-ahead.
const TASK3 = "Compare the price of the MacBook Air 13-inch M4 (16 GB, 256 GB) at Apple, Best Buy and Amazon, and tell me the cheapest.";
const STORES = [
  { id: "run-1-s1", task: "Find the price of the MacBook Air 13-inch M4 with 16 GB and 256 GB on Apple's store.", url: "https://www.apple.com/shop/buy-mac/macbook-air" },
  { id: "run-1-s2", task: "Find the price of the MacBook Air 13-inch M4 with 16 GB and 256 GB at Best Buy.", url: "https://www.bestbuy.com/" },
  { id: "run-1-s3", task: "Find the price of the MacBook Air 13-inch M4 with 16 GB and 256 GB on Amazon, sold by Amazon.", url: "https://www.amazon.com/" },
];
const sub = (id, e) => ({ ...e, sub: id });
const DELEGATING = [
  status("executor", "Looking at the page…"),
  log("system", "Task Started", TASK3),
  log("executor", "Step 1", "Check the three stores at the same time"),
  log("executor", "Action", "delegate 3 sub-tasks"),
  { k: "subtasks", ids: STORES.map((x) => x.id), tasks: STORES.map((x) => ({ id: x.id, task: x.task, url: x.url })) },
  status("executor", "3 sub-tasks running…"),
  ...STORES.map((x, i) => ({ k: "sub", id: x.id, state: "running", tabId: 11 + i })),
  sub("run-1-s1", status("executor", "Looking at the page…")),
  sub("run-1-s1", log("executor", "Step 1", "Open the address it was given")),
  sub("run-1-s1", log("executor", "Action", `navigate ${STORES[0].url}`)),
  sub("run-1-s1", log("executor", "Result", "Opened the MacBook Air page. It lists 13-inch and 15-inch models with their configurations.")),
  sub("run-1-s1", status("executor", "Step 2…")),
  sub("run-1-s1", log("executor", "Step 2", "Read the price of the 16 GB, 256 GB model")),
  sub("run-1-s1", log("executor", "Action", 'find "16GB 256GB"')),
  sub("run-1-s1", log("executor", "Result", '"16GB 256GB" is in 2 places in the text. The text there reads: "13-inch MacBook Air M4 10-Core CPU 8-Core GPU 16GB Unified Memory 256GB SSD Storage $999.00"')),
  sub("run-1-s1", status("validator", "Checking the answer…")),
  { k: "sub", id: "run-1-s1", state: "ended", outcome: "success", success: true, text: "Apple sells the 13-inch MacBook Air M4 with 16 GB and 256 GB for **$999.00**." },
  sub("run-1-s2", status("executor", "Looking at the page…")),
  sub("run-1-s2", log("executor", "Step 1", "Open the address it was given")),
  sub("run-1-s2", log("executor", "Action", `navigate ${STORES[1].url}`)),
  sub("run-1-s2", log("executor", "Result", "Opened Best Buy. A search box is at the top of the page.")),
  sub("run-1-s2", status("executor", "Step 2…")),
  sub("run-1-s2", log("executor", "Step 2", "Search for the MacBook Air M4")),
  sub("run-1-s2", log("executor", "Action", 'fill [4] "Search": "MacBook Air 13 M4 16GB 256GB"')),
  sub("run-1-s2", status("executor", "Step 3…")),
  sub("run-1-s3", status("executor", "Looking at the page…")),
  sub("run-1-s3", log("executor", "Step 1", "Open the address it was given")),
  sub("run-1-s3", log("executor", "Action", `navigate ${STORES[2].url}`)),
  sub("run-1-s3", log("executor", "Result", "Opened Amazon. A notice about cookies is on top of the page.")),
  sub("run-1-s3", status("executor", "Step 2…")),
  sub("run-1-s3", log("executor", "Step 2", "Open the listing from the search results")),
  { k: "ask", sub: "run-1-s3", wait: { id: "run-1-s3-w1", kind: "approval", risk: "address", question: "This opens an address that was not on any page the agent read.", detail: ["Address: https://www.amazon.com/dp/B0DZD9S5GC", "Why: Open the listing from the search results"], tabId: 13, sub: "run-1-s3", subTask: STORES[2].task } },
  sub("run-1-s3", status("idle", "Waiting for your go-ahead")),
];
const historyDelegating = [
  { step: 1, ok: true, action: "delegate 3 sub-tasks", url: "https://www.google.com/" },
  { step: 1, ok: true, action: `navigate ${STORES[0].url}`, url: STORES[0].url, sub: "run-1-s1" },
  { step: 2, ok: true, action: 'find "16GB 256GB"', url: STORES[0].url, sub: "run-1-s1" },
  { step: 1, ok: true, action: `navigate ${STORES[1].url}`, url: STORES[1].url, sub: "run-1-s2" },
  { step: 2, ok: true, action: "fill [4]", url: "https://www.bestbuy.com/site/searchpage.jsp?st=macbook+air", sub: "run-1-s2" },
  { step: 1, ok: true, action: `navigate ${STORES[2].url}`, url: STORES[2].url, sub: "run-1-s3" },
];
const ANSWER3 = [
  "The cheapest is **Amazon at $849.00**, $150 below Apple's price.",
  "",
  "| Store | Price | Notes |",
  "|---|---|---|",
  "| Amazon | $849.00 | Sold and shipped by Amazon |",
  "| Best Buy | $899.00 | Sale price, ends Sunday |",
  "| Apple | $999.00 | List price |",
].join("\n");
const DELEGATED = [
  ...DELEGATING.filter((e) => !(e.k === "ask") && !(e.sub === "run-1-s3" && e.k === "status" && e.role === "idle")),
  { k: "ask_done", id: "run-1-s3-w1", sub: "run-1-s3", how: "approved" },
  sub("run-1-s3", log("system", "Allowed", "You allowed this step.")),
  sub("run-1-s3", log("executor", "Result", "Opened the listing: Apple 2025 MacBook Air 13-inch M4, 16GB, 256GB, $849.00, ships from and sold by Amazon.")),
  { k: "sub", id: "run-1-s3", state: "ended", outcome: "success", success: true, text: "Amazon sells it for **$849.00**, shipped and sold by Amazon." },
  sub("run-1-s2", log("executor", "Result", "The results list the MacBook Air 13-inch M4 16GB 256GB at $899.00, was $999.00.")),
  { k: "sub", id: "run-1-s2", state: "ended", outcome: "success", success: true, text: "Best Buy has it for **$899.00** (was $999.00), sale ends Sunday." },
  log("executor", "Result", '3 sub-tasks ended: 3 answered. What each brought back is shown with the page, under "What your sub-tasks brought back".'),
  status("executor", "Step 2…"),
  log("executor", "Step 2", "Compare the three prices"),
  status("validator", "Checking the answer…"),
  log("validator", "Check Passed", "Each price is quoted from the store's own page."),
];
const historyDelegated = [...historyDelegating, { step: 2, ok: true, action: "open listing", url: "https://www.amazon.com/dp/B0DZD9S5GC", sub: "run-1-s3" }];
const snap3 = (status, journal, extra, wait) => ({ type: "snapshot", turns: [], run: { id: "run-1", task: TASK3, status, journal, wait: wait || null, trace: trace({ task: TASK3, ...extra }) } });

const STATES = {
  empty: { ready: true, msgs: [{ type: "snapshot", turns: [], run: null }] },
  nokey: { ready: false, msgs: [{ type: "snapshot", turns: [], run: null }] },
  working: {
    ready: true,
    msgs: [snap("running", [...BASE, status("executor", "Step 5…")]), { type: "stream", runId: "run-1", text: '{"note":"ZIPAIR S$248 is the cheapest","goal":"Open the cheapest fare to check the final price","do":"cli' }],
  },
  writing: {
    ready: true,
    msgs: [snap("running", [...DONE.slice(0, -3), status("executor", "Step 6…")], { steps: 5, history: historyDone }), { type: "stream", runId: "run-1", text: `{"goal":"Answer","do":"done","success":true,"answer":${JSON.stringify(ANSWER.slice(0, 260))}` }],
  },
  approval: {
    ready: true,
    msgs: [snap("waiting", [...BASE, status("executor", "Step 5…"), log("executor", "Step 5", "Continue to payment for the ZIPAIR fare"), status("executor", "Checking what this button does…"), log("system", "Second Check", 'Pressing "Continue to payment" looks like it would spend money: it moves to card details for S$248.'), ask({ kind: "approval", risk: "pay", question: 'Pressing "Continue to payment" would spend money: the ZIPAIR fare for S$248.', detail: ["On: Continue to payment", "Why: Continue to payment for the ZIPAIR fare"] }), status("idle", "Waiting for your go-ahead")], { waitingForUser: true, waitKind: "approval" }, { kind: "approval" })],
  },
  handover: {
    ready: true,
    msgs: [snap("waiting", [...BASE, status("executor", "Step 5…"), log("executor", "Step 5", "Sign in to see member fares"), ask({ kind: "sign_in", question: "zipair.net wants you to sign in before it shows member fares. Sign in on the page, and I'll carry on from there." }), status("idle", "Waiting for you")], { waitingForUser: true, waitKind: "sign_in" }, { kind: "sign_in" })],
  },
  checkin: {
    ready: true,
    msgs: [snap("waiting", [...BASE, log("system", "Checking In", "I have been working on this for 5 minutes."), ask({ kind: "check_in", question: "I have been working on this for 5 minutes and made 14 model calls.", notes: "Step 4: ZIPAIR ZG52 S$248, Scoot TR808 S$265, Peach MM862 S$281\nStep 4: prices are for one adult, carry-on only", period: 300000, reason: "time" }), status("idle", "Waiting for you")], { waitingForUser: true, waitKind: "check_in" }, { kind: "check_in" })],
  },
  paused: {
    ready: true,
    msgs: [snap("waiting", [...BASE, log("system", "Provider Asked To Wait", "OpenRouter says too many requests right now. Waiting 1 minute 35 seconds."), ask({ kind: "pause", question: "OpenRouter asked to wait: too many requests on the free models right now.", until: Date.now() + 95000 }), status("idle", "Waiting for the provider")], { waitingForUser: true, waitKind: "pause" }, { kind: "pause" })],
  },
  question: {
    ready: true,
    msgs: [snap("waiting", [...BASE, ask({ kind: "question", question: "The cheapest fare lands at Narita at 07:50. Do you want flights into Haneda only, or is Narita fine?" }), status("idle", "Waiting for you")], { waitingForUser: true, waitKind: "question" }, { kind: "question" })],
  },
  done: {
    ready: true,
    msgs: [snap("done", [...DONE, { k: "answer", state: "success", text: ANSWER, note: "", verified: true, sources: SOURCES, used }, { k: "memory", text: "Prefers prices in SGD" }, { k: "offer", id: "o1", items: [{ type: "entry", text: "On google.com/travel: sort by price before reading the list" }, { type: "field", label: "Home airport", value: "Singapore (SIN)" }] }], { running: false, stopState: "success", steps: 5, activeMs: 83000, history: historyDone, costUSD: 0.0213 })],
  },
  checking: {
    ready: true,
    msgs: [snap("running", CHECKING, { steps: 5, history: historyDone })],
  },
  // The check passes while the user watches: the answer stays where it is.
  "check-passed": {
    ready: true,
    msgs: [snap("running", CHECKING, { steps: 5, history: historyDone }), { type: "entries", runId: "run-1", status: "done", entries: [quiet("validator", "Check Passed", "The price, flight and times all appear on the pages read."), { k: "answer", state: "success", text: ANSWER, note: "", verified: true, sources: SOURCES, used }], trace: trace({ running: false, stopState: "success", steps: 5, activeMs: 83000, history: historyDone }) }],
  },
  "sent-back": {
    ready: true,
    msgs: [snap("running", SENT_BACK, { steps: 6, history: historyDone })],
  },
  // "Ask the agent about this": the selection waits above the composer.
  selection: {
    ready: true,
    query: "?tabId=1&about=selection",
    session: { "agentSelection:1": { text: "ZIPAIR ZG52 S$248", title: "Google Flights - Singapore to Tokyo", url: FLIGHTS, heading: "Cheapest flights", passage: "Departing flights. ZIPAIR ZG52 S$248 23:55 to 07:50 (+1). Scoot TR808 S$265.", row: "ZIPAIR", column: "Price", tabId: 1, at: Date.now() } },
    msgs: [{ type: "snapshot", turns: [], run: null }],
  },
  "selection-sent": {
    ready: true,
    msgs: [{ type: "snapshot", turns: [], run: { id: "run-1", task: "Is this the cheapest nonstop?", selection: { text: "ZIPAIR ZG52 S$248", title: "Google Flights", url: FLIGHTS }, status: "running", journal: BASE.slice(0, 5), wait: null, trace: trace({ task: "Is this the cheapest nonstop?", steps: 1 }) } }],
  },
  unconfirmed: {
    ready: true,
    msgs: [snap("done", [...DONE.slice(0, -1), log("validator", "Check Failed", "The landing time is not on any page that was read."), { k: "answer", state: "unconfirmed", text: ANSWER.split("\n")[0], note: "Not confirmed: the landing time at Narita was not on any page it read, so check it before you book.", verified: false, used: {} }], { running: false, stopState: "unconfirmed", steps: 5, activeMs: 91000, history: historyDone })],
  },
  delegating: {
    ready: true,
    msgs: [snap3("running", DELEGATING, { steps: 7, history: historyDelegating, activeMs: 38000 })],
  },
  "delegating-open": {
    ready: true,
    msgs: [snap3("running", DELEGATING, { steps: 7, history: historyDelegating, activeMs: 38000 })],
    // The user opens one sub-task's row to see its steps.
    after: (page) => page.evaluate(() => { const rows = document.querySelectorAll(".tl-sub-box"); if (rows[0]) rows[0].open = true; }),
  },
  delegated: {
    ready: true,
    msgs: [snap3("done", [...DELEGATED, { k: "answer", state: "success", text: ANSWER3, note: "", verified: true, used: {} }], { running: false, stopState: "success", steps: 9, activeMs: 71000, history: historyDelegated, costUSD: 0 })],
  },
  failed: {
    ready: true,
    msgs: [snap("done", [...BASE, status("executor", "Step 5…"), log("executor", "Step 5", "Open the cheapest fare"), log("executor", "Action", 'click [88] "ZIPAIR S$248"'), log("error", "Action Failed", "The page did not respond to the press after 3 tries."), { k: "answer", state: "error", text: "The flights page stopped responding after three tries, so I could not check the final price. The cheapest fare listed was ZIPAIR at S$248.", note: "", verified: null, used: {} }], { running: false, stopState: "error", steps: 5, activeMs: 64000 })],
  },
};

async function renderAgent(name, scheme, w, h) {
  const st = STATES[name];
  await storage(st.ready);
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument((tabUrl) => {
    const listeners = [];
    window.__deliver = (m) => listeners.forEach((f) => f(m));
    const realConnect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (info) => {
      if (!info || info.name !== "agentView") return realConnect(info);
      window.__connected = true;
      return { onMessage: { addListener: (f) => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: () => {}, disconnect() {} };
    };
    chrome.tabs.get = (tabId, cb) => cb({ id: tabId, url: tabUrl });
  }, FLIGHTS);
  if (st.session) await worker.evaluate((v) => chrome.storage.session.set(v), { ...st.session });
  await page.goto(`chrome-extension://${id}/agent.html${st.query || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__connected === true, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 150));
  for (const m of st.msgs) await page.evaluate((m) => window.__deliver(m), m);
  if (st.after) await st.after(page);
  await new Promise((r) => setTimeout(r, 900));
  // Scroll to where the user would be: the end of the run.
  await page.evaluate(() => { const v = document.getElementById("chatViewport"); v.scrollTop = v.scrollHeight; });
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: `${OUT}/agent-${name}-${w}-${scheme}.png` });
  await page.close();
  if (st.session) await worker.evaluate(() => chrome.storage.session.clear());
}

async function renderPage(file, label, scheme, w, h, full, ready = true, seed = null) {
  await storage(ready);
  if (seed) await worker.evaluate((s) => chrome.storage.local.set(s), seed);
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(`chrome-extension://${id}/${file}`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${OUT}/${label}-${scheme}.png`, fullPage: !!full });
  await page.close();
}

/** The memory panel, filled from the real memory module. */
async function renderMemory(scheme, w, h) {
  await storage(true);
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument(() => {
    const listeners = [];
    window.__deliver = (m) => listeners.forEach((f) => f(m));
    const realConnect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (info) => {
      if (!info || info.name !== "agentView") return realConnect(info);
      window.__connected = true;
      return { onMessage: { addListener: (f) => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: () => {}, disconnect() {} };
    };
  });
  await page.goto(`chrome-extension://${id}/agent.html#memory`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__connected === true, { timeout: 5000 });
  await page.evaluate(() => {
    const K = globalThis.SELECT_TO_AI_KNOWN;
    const now = Date.now();
    let s = K.empty();
    s = K.setField(s, "name", "Ada Lovelace", "you_said", now).store;
    s = K.setField(s, "email", "ada@example.com", "you_confirmed", now).store;
    s = K.addEntry(s, { kind: "preference", text: "Show prices in SGD", scope: "global", source: "you_said" }, now).store;
    s = K.addEntry(s, { kind: "site_note", text: "Sort by price before reading the list of flights", scope: "google.com", source: "run" }, now).store;
    s = { ...s, consents: { ...s.consents, fill: { "zipair.net": true } } };
    window.__deliver({ type: "snapshot", turns: [], run: null });
    window.__deliver({ type: "memory", store: s });
  });
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: `${OUT}/agent-memory-${w}-${scheme}.png` });
  await page.close();
}

// WIDTHS=360x780,1440x900 shoots other sizes.
const SIZES = (process.env.WIDTHS || "400x800,1280x860").split(",").map((x) => x.split("x").map(Number));
const SCHEMES = (process.env.SCHEMES || "light,dark").split(",");
for (const scheme of SCHEMES) {
  for (const [w, h] of SIZES) {
    for (const name of Object.keys(STATES)) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      await renderAgent(name, scheme, w, h);
    }
    if (!ONLY.length || ONLY.includes("memory")) await renderMemory(scheme, w, h);
  }
  if (!ONLY.length || ONLY.includes("pages")) {
    await renderPage("popup.html", "popup", scheme, 360, 520);
    await renderPage("popup.html", "popup-setup", scheme, 360, 520, false, false);
    await renderPage("options.html", "options", scheme, 1280, 900, true);
    await renderPage("options.html", "options-400", scheme, 400, 900, false);
    await renderPage("welcome.html", "welcome", scheme, 1280, 900, true, false);
    await renderPage("welcome.html", "welcome-400", scheme, 400, 900, false, false);
    await renderPage("sidepanel.html", "sidepanel", scheme, 400, 800);
    // An assistant site handed over by a right-click: the bar with the way back.
    // The frame is left blank here; outside a real side panel the sites refuse to be framed.
    await renderPage("sidepanel.html", "sidepanel-assistant", scheme, 400, 800, false, true, { sidePanelState: { url: "about:blank#chatgpt.com", selectedText: "", autoSend: false, timestamp: Date.now() } });
  }
}
await browser.close();
console.log(`shots in ${OUT}`);
