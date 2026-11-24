// Store and review screenshots from a built extension (plan: screenshots).
//
//   EXT=dir node scripts/ui-shots.mjs [outDir]
//
// EXT is the extension to load (in CI the unzipped store package, not the
// source tree; default extension/). Every shot is 1280x800. The agent runs
// are played by the scripted model server in tests/e2e/server.js, so the
// pages show real engine output and need no provider key.
//
// Shots: popup, popup-upgrade (a 2.0 user's settings), options (with the
// provider fields on show), welcome-install, right-click-send (a page with
// a selection and the agent asked about it in the side panel), side-panel,
// agent-result, needs-you (an approval card), recipes (the Recipes sheet),
// and the setup picker at each step in light and dark: setup-providers-*
// (every provider listed), setup-key-* (a provider picked) and setup-free-*
// (OpenRouter's free or paid choice, after a key check answered here, never
// by OpenRouter), plus setup-narrow (the picker 400 px wide).
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

// The local test server is granted, as after Allow on the site-access card,
// and OpenRouter's API host, as after Agree on the setup page's consent
// card. Its replies are played here (setupFree below), so nothing leaves.
const GRANTED = require("../tests/helpers/granted-build.js");
const EXT = GRANTED.grantedBuild(path.resolve(process.env.EXT || "extension"), [...GRANTED.TEST_HOSTS, "https://openrouter.ai/*"]);
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

  // The setup picker, at each step, in light and dark.
  const welcomeAt = async (name, theme) => {
    await storage(theme === "dark" ? { theme: "dark" } : { theme: "light" }, { agentDataConsent: { openrouter: Date.now() } });
    const page = await newPage(name);
    await page.goto(`chrome-extension://${id}/welcome.html?step=connect`, { waitUntil: "load" });
    await sleep(500);
    return page;
  };
  const toConnect = (page) => page.evaluate(() => { const c = document.getElementById("connect"); window.scrollTo(0, c.getBoundingClientRect().top + window.scrollY - 24); });
  const visibleNow = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.closest("[hidden]") && el.getClientRects().length > 0; }, sel);
  for (const theme of ["light", "dark"]) {
    {
      const name = `setup-providers-${theme}`;
      const page = await welcomeAt(name, theme);
      await page.evaluate(() => { document.getElementById("moreProviders").open = true; });
      await sleep(400);
      const cards = await page.$$eval(".prov", (els) => els.map((e) => e.id));
      if (cards.length < 12) problems.push(`${name}: ${cards.length} provider cards, not 12`);
      await toConnect(page);
      await sleep(300);
      await shoot(page, name);
      await page.close();
    }
    {
      const name = `setup-key-${theme}`;
      const page = await welcomeAt(name, theme);
      await page.click("#prov-anthropic");
      await sleep(400);
      if (!(await visibleNow(page, "#providerKey"))) problems.push(`${name}: no key field after picking Anthropic`);
      await toConnect(page);
      await sleep(200);
      await shoot(page, name);
      await page.close();
    }
    {
      const name = `setup-free-${theme}`;
      const page = await welcomeAt(name, theme);
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const url = req.url();
        if (!url.startsWith("https://openrouter.ai/")) { req.continue(); return; }
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
        if (req.method() === "OPTIONS") { req.respond({ status: 204, headers: cors }); return; }
        const body = /\/api\/v1\/key$/.test(url) ? { data: { is_free_tier: true } } : { choices: [{ message: { role: "assistant", content: "Hi" } }] };
        req.respond({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
      });
      await page.click("#prov-openrouter");
      await page.type("#providerKey", "sk-or-v1-placeholder-for-screenshots");
      await page.click("#connectKey");
      const t0 = Date.now();
      while (Date.now() - t0 < 10000 && !(await visibleNow(page, "#planFree"))) await sleep(200);
      if (!(await visibleNow(page, "#planFree"))) problems.push(`${name}: the free or paid choice did not show within 10 s`);
      await toConnect(page);
      await sleep(300);
      await shoot(page, name);
      await page.close();
    }
  }
  {
    await storage({ theme: "light" }, {});
    const page = await composite("setup-narrow", [{ src: `chrome-extension://${id}/welcome.html?step=connect`, width: 400 }]);
    const wide = await page.evaluate(() => { const d = document.querySelector("iframe").contentDocument; return d.documentElement.scrollWidth > d.documentElement.clientWidth; });
    if (wide) problems.push("setup-narrow: the picker scrolls sideways at 400 px");
    await shoot(page, "setup-narrow");
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
    if (!(await page.evaluate(() => { const el = document.getElementById("provider"); return !!el && !el.closest("[hidden]"); }))) problems.push("options: the provider dropdown is hidden");
    await page.evaluate(() => { const el = document.getElementById("h-agent"); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 16); });
    await sleep(200);
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
process.exit(problems.length || made.length < 16 ? 1 : 0);
