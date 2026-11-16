// Store and review screenshots from a built extension (plan: screenshots).
//
//   EXT=dir node scripts/ui-shots.mjs [outDir]
//
// EXT is the extension to load (in CI the unzipped store package, not the
// source tree; default extension/). Every shot is 1280x800. The agent runs
// are played by the scripted model server in tests/e2e/server.js, so the
// pages show real engine output and need no provider key.
//
// Shots: popup, popup-upgrade (a 2.0 user's settings), options,
// welcome-install, right-click-send (a page with a selection and the agent
// asked about it in the side panel), side-panel, agent-result, needs-you
// (an approval card) and recipes (the Recipes sheet).
//
// Fails on any console error or page error, on a failed chrome-extension://
// request, on "undefined" or an em dash in the visible text, and on a PNG
// that is not 1280x800.
import puppeteer from "puppeteer";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createE2EServer } = require("../tests/e2e/server.js");

// The local test server is granted, as after Allow on the site-access card.
const EXT = require("../tests/helpers/granted-build.js").grantedBuild(path.resolve(process.env.EXT || "extension"));
const OUT = path.resolve(process.argv[2] || "store-screens");
const W = 1280;
const H = 800;
const PORT = parseInt(process.env.SHOTS_PORT || "8931", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const made = [];

const server = createE2EServer(PORT);
await server.listen();
const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--hide-scrollbars", "--disable-features=DialMediaRouteProvider", `--window-size=${W},${H + 120}`],
});

function watch(page, name) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The fixture pages come from the local test server (its missing
    // favicon.ico logs a 404). Only the extension's own pages are judged.
    const from = (m.location() && m.location().url) || page.url();
    if (!from.startsWith("chrome-extension://")) return;
    problems.push(`${name}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${name}: page error: ${e.message}`));
  page.on("requestfailed", (r) => { if (r.url().startsWith("chrome-extension://")) problems.push(`${name}: failed request ${r.url()}`); });
}

async function textProblems(page, name) {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url.startsWith("chrome-extension://")) continue;
    const text = await frame.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    if (/\bundefined\b/.test(text)) problems.push(`${name}: "undefined" in the text of ${url}`);
    if (text.includes("\u2014")) problems.push(`${name}: em dash in the text of ${url}`);
  }
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function shoot(page, name) {
  await textProblems(page, name);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const { w, h } = pngSize(file);
  if (w !== W || h !== H) problems.push(`${name}.png is ${w}x${h}, not ${W}x${H}`);
  made.push(`${name}.png`);
  console.log(`shot ${name}.png`);
}

async function newPage(name) {
  const page = await browser.newPage();
  watch(page, name);
  await page.setViewport({ width: W, height: H });
  return page;
}

// A page that shows other pages side by side, for shots of a page next to
// the side panel. It is the extension's own origin, so its pages can be framed.
async function composite(name, frames) {
  const page = await newPage(name);
  await page.goto(`chrome-extension://${id}/manifest.json`, { waitUntil: "load" });
  await page.evaluate((list, h) => {
    document.documentElement.innerHTML = "<head><style>html,body{margin:0;height:100%;background:#d9dde3;overflow:hidden}body{display:flex;gap:0}iframe{border:0;height:100%;background:#fff}.side{border-left:1px solid #c3c8cf}</style></head><body></body>";
    for (const f of list) {
      const el = document.createElement("iframe");
      el.src = f.src;
      el.style.width = `${f.width}px`;
      if (f.side) el.className = "side";
      document.body.appendChild(el);
    }
    return h;
  }, frames, H);
  await sleep(2500);
  return page;
}

async function storage(sync, local) {
  await worker.evaluate(async (s, l) => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.session.clear();
    await chrome.storage.sync.set(s);
    await chrome.storage.local.set(l);
  }, sync, local);
}

const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 });
const worker = await workerTarget.worker();
const id = new URL(workerTarget.url()).host;
await sleep(800);
for (const p of await browser.pages()) if (p.url().startsWith("chrome-extension")) await p.close();

const RUN_SETTINGS = {
  agentActiveProvider: "custom", agentCustomUrl: `${server.baseUrl}/v1`, agentModel: "e2e-scripted-model", showAgent: true,
  agentRiskConfirmation: true, agentDomainAllowlist: "", openingMode: "tab", agentLearning: false,
};
const control = (p, body) => fetch(`${server.baseUrl}${p}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());

try {
  // Install: no settings, onboarding not done.
  await storage({}, {});
  {
    const page = await newPage("welcome-install");
    await page.goto(`chrome-extension://${id}/welcome.html`, { waitUntil: "load" });
    await sleep(800);
    await shoot(page, "welcome-install");
    await page.close();
  }

  // An upgrader: the 2.0 settings, nothing of 4.0's.
  const seed = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/v2.0/storage-seed.json"), "utf8"));
  // whatsNew40 is the one-time flag the worker sets on the update, for the popup's banner.
  await storage(seed.sync, { ...seed.local, whatsNew40: true });
  {
    const page = await composite("popup-upgrade", [{ src: `chrome-extension://${id}/popup.html`, width: 380 }]);
    await shoot(page, "popup-upgrade");
    await page.close();
  }

  // Set up, with the scripted model as the provider, before the user has
  // agreed to what the agent sends: the consent card.
  await storage(RUN_SETTINGS, { onboardingComplete: true });
  {
    const page = await newPage("consent-card");
    await page.goto(`chrome-extension://${id}/agent.html?task=${encodeURIComponent("Summarize this page in 5 short bullet points.")}&autostart=1&fresh=1`, { waitUntil: "load" });
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && !(await page.$(".consent-card"))) await sleep(200);
    if (!(await page.$(".consent-card"))) problems.push("consent-card: no consent card on the agent page within 10 s");
    await sleep(400);
    await shoot(page, "consent-card");
    await page.close();
  }

  // From here on the user has agreed (setup.js keeps it per provider).
  await storage(RUN_SETTINGS, { onboardingComplete: true, agentDataConsent: { [`custom ${new URL(server.baseUrl).origin}`]: Date.now() } });
  {
    const page = await composite("popup", [{ src: `chrome-extension://${id}/popup.html`, width: 380 }]);
    await shoot(page, "popup");
    await page.close();
  }
  {
    const page = await newPage("options");
    await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
    await sleep(800);
    await shoot(page, "options");
    await page.close();
  }

  // A page with a selection, and the agent asked about it in the side panel.
  {
    const fixture = await newPage("right-click-send fixture");
    await fixture.goto(`${server.baseUrl}/article`, { waitUntil: "load" });
    await fixture.evaluate(() => {
      const p = document.querySelector("main p, article p, p");
      if (!p) return;
      const r = document.createRange();
      r.selectNodeContents(p);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    const tabId = await worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, fixture.url());
    const selected = await fixture.evaluate(() => String(getSelection()).trim().slice(0, 600));
    await worker.evaluate((tab, text, href) => chrome.storage.session.set({ [`agentSelection:${tab}`]: { text, title: "Article", url: href, heading: "", passage: "", row: "", column: "", tabId: tab, at: Date.now() } }), tabId, selected, fixture.url());
    const page = await composite("right-click-send", [
      { src: `${server.baseUrl}/article`, width: W - 400 },
      { src: `chrome-extension://${id}/agent.html?tabId=${tabId}&about=selection`, width: 400, side: true },
    ]);
    await shoot(page, "right-click-send");
    await page.close();

    await worker.evaluate((url) => chrome.storage.local.set({ sidePanelState: { url, selectedText: "", autoSend: false, timestamp: Date.now() } }), `chrome-extension://${id}/agent.html`);
    const panel = await composite("side-panel", [
      { src: `${server.baseUrl}/article`, width: W - 400 },
      { src: `chrome-extension://${id}/sidepanel.html`, width: 400, side: true },
    ]);
    await shoot(panel, "side-panel");
    await panel.close();
    await fixture.close();
  }

  // A run to its answer, and a run that stops to ask.
  async function run(scenario, startPath, name, until) {
    const { task, error } = await control("/control/scenario", { name: scenario });
    if (error || !task) throw new Error(`scenario ${scenario}: ${error || "no task"}`);
    const fixture = await newPage(`${name} fixture`);
    await fixture.goto(`${server.baseUrl}${startPath}`, { waitUntil: "load" });
    // The run is told which tab is its page, or it starts on the browser's
    // first blank tab instead of the fixture.
    const tabId = await worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, fixture.url());
    if (tabId == null) throw new Error(`${name}: the fixture tab was not found`);
    const agent = await newPage(name);
    await agent.goto(`chrome-extension://${id}/agent.html?task=${encodeURIComponent(task)}&autostart=1&fresh=1&tabId=${tabId}`, { waitUntil: "load" });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (await agent.evaluate(until).catch(() => false)) break;
      await sleep(250);
    }
    if (!(await agent.evaluate(until).catch(() => false))) problems.push(`${name}: the run did not reach the state to shoot within 60 s`);
    await agent.bringToFront();
    await sleep(600);
    await shoot(agent, name);
    return { agent, fixture };
  }
  {
    const { agent, fixture } = await run("search", "/search", "agent-result", () => [...document.querySelectorAll(".final-answer-box")].some((b) => getComputedStyle(b).display !== "none" && b.innerText.trim()));
    await agent.close();
    await fixture.close();
  }
  {
    const { agent, fixture } = await run("form", "/signup", "needs-you", () => !!document.querySelector(".confirmation-bubble"));
    await agent.evaluate(() => { const b = document.querySelector(".abort-risk-btn"); if (b) b.click(); });
    await sleep(1000);
    await agent.close();
    await fixture.close();
  }
  {
    const page = await newPage("recipes");
    await page.goto(`chrome-extension://${id}/agent.html`, { waitUntil: "load" });
    await sleep(600);
    const opened = await page.evaluate(() => { const b = document.getElementById("openRecipesBtn"); if (b) b.click(); return !!b; });
    if (!opened) problems.push("recipes: no Recipes button (#openRecipesBtn) on the agent page");
    await sleep(800);
    await shoot(page, "recipes");
    await page.close();
  }
} catch (e) {
  problems.push(`harness error: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close().catch(() => {});
  await server.close();
}

console.log(`\n${made.length} shots in ${OUT}: ${made.join(", ")}`);
if (problems.length) {
  console.log(`\n${problems.length} problems:`);
  for (const p of problems) console.log(`  - ${p}`);
}
process.exit(problems.length || made.length < 9 ? 1 : 0);
