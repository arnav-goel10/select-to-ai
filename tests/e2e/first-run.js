/**
 * Select to AI - first run of the store package on public sites.
 *
 *   node tests/e2e/first-run.js            (headless; E2E_HEADFUL=1 to watch)
 *
 * Builds dist/select-to-ai-extension.zip, unzips it, and loads exactly that
 * into a fresh Chromium profile (Playwright's), as a new user would get it.
 *
 * Part 1, the package as shipped: the welcome page Chrome opens on install,
 * the toolbar popup, Settings, and the agent asked to work on Wikipedia
 * before the user has allowed any site (it must ask for access, not fail).
 *
 * Part 2, the same package with access to three public sites already
 * granted, as after the user clicks Allow (Chrome's permission prompt cannot
 * be clicked by automation, so the test copy's manifest lists the three
 * hosts; nothing else changes). The agent reads and acts on the live sites:
 * Hacker News, a Wikipedia search typed into the real search box, and
 * GitHub Trending. The model is a scripted local gateway that reads the
 * page text the extension sends it and picks the next step, so no API key
 * or paid call is needed; it shows the extension's own flows work on real
 * pages, not how well any model does.
 *
 * Screenshots go to docs/screens/. The browser and gateway are closed at
 * the end, and the profile and unzipped copy are deleted.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const SHOTS = path.join(ROOT, "docs/screens");
const PORT = 8931;
const TIMEOUT_MS = 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the gateway

const sse = (name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {} }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join("\n") : "");
const urlOf = (t) => ((t.match(/^Current page: .* \| (\S+)$/m) || [])[1] || "");
/** The live element list: [id] role "name" lines, as the extension writes them. */
function elementsOf(t) {
  const at = Math.max(t.lastIndexOf("Interactive elements ("), t.lastIndexOf("\nControls:\n"));
  const list = at >= 0 ? t.slice(at) : t;
  const out = [];
  const re = /^[ \t]*\*?\[(\d+)\] (\w+)(?:\(([\w-]+)\))?(?: "([^"]*)")?(.*)$/gm;
  let m;
  while ((m = re.exec(list))) out.push({ id: Number(m[1]), tag: m[2].toLowerCase(), type: m[3] || "", name: m[4] || "", rest: m[5] || "" });
  return out;
}
const step = (goal, actions) => ({ memory: "", goal, actions });
const done = (answer, evidence) => step("Answer", [{ do: "done", success: true, answer, evidence }]);

/** One policy per task: what a person would do next on the page in front of them. */
const POLICIES = {
  hn(ctx) {
    if (!/news\.ycombinator\.com/.test(ctx.url)) return step("Open Hacker News", [{ do: "navigate", url: "https://news.ycombinator.com/" }]);
    const nav = /^(Hacker News|new|past|comments|ask|show|jobs|submit|login|hide|More|\d+ comments?|discuss)$/i;
    // The first link long enough to be a title: the extension lists links as "a", cutting long names with "…".
    const story = ctx.elements.find((e) => (e.tag === "a" || e.tag === "link") && e.name.length > 15 && !nav.test(e.name) && !/^\d+ (points?|comments?)/.test(e.name));
    if (!story) throw new Error("no story link in the element list");
    const title = story.name.replace(/…$/, "").trim();
    return done(`The top story on Hacker News right now is "${title}".`, [title]);
  },
  wiki(ctx) {
    if (/\/wiki\/Ada_Lovelace/.test(ctx.url)) {
      const born = ctx.userText.match(/\b(\d{1,2} December 1815)\b/);
      if (!born) return step("Find her birth date", [{ do: "read", query: "born December 1815" }]);
      return done(`Ada Lovelace was born on ${born[1]}.`, [born[1]]);
    }
    const box = ctx.elements.find((e) => /search/i.test(`${e.tag} ${e.type} ${e.name}`) && /input|searchbox|combobox|textbox/.test(`${e.tag} ${e.type}`));
    if (!box) throw new Error("no search box on the Wikipedia page");
    return step("Search for Ada Lovelace", [{ do: "fill", ref: box.id, value: "Ada Lovelace" }, { do: "press", key: "Enter", ref: box.id }]);
  },
  github(ctx) {
    if (!/github\.com\/trending/.test(ctx.url)) return step("Open GitHub Trending", [{ do: "navigate", url: "https://github.com/trending" }]);
    // The first link named "owner / name" whose address is that repository.
    const link = ctx.elements.find((e) => e.tag === "a" && /^[\w.-]+ \/ [\w.-]+$/.test(e.name) && e.rest.includes(`→ /${e.name.replace(" / ", "/")}`));
    if (!link) throw new Error("no owner / name repository link on GitHub Trending");
    return done(`The top repository on GitHub Trending today is ${link.name.replace(" / ", "/")}.`, [link.name]);
  },
};

function gateway() {
  const state = { policy: null, steps: [], errors: [], calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
      state.calls++;
      const body = JSON.parse(raw || "{}");
      const tool = body.tools && body.tools[0] && body.tools[0].function && body.tools[0].function.name;
      const userText = text((body.messages || [])[1] && body.messages[1].content);
      let reply;
      if (tool === "step") {
        const ctx = { url: urlOf(userText), elements: elementsOf(userText), userText };
        if (process.env.FIRST_RUN_DUMP) fs.writeFileSync(path.join(process.env.FIRST_RUN_DUMP, `${state.policy}-${state.steps.length}.txt`), userText);
        try { reply = POLICIES[state.policy](ctx); } catch (e) { state.errors.push(`${state.policy}: ${e.message} at ${ctx.url}`); reply = step("Give up", [{ do: "done", success: false, answer: `Scripted policy could not go on: ${e.message}` }]); }
        state.steps.push({ url: ctx.url, actions: reply.actions.map((a) => a.do) });
      } else if (tool === "verdict") reply = { requirements: [{ need: "what was asked", met: true }], pass: true, reason: "The quotes support the answer." };
      else if (tool === "press_check") reply = { does: "nothing", why: "Scripted: a search or a link." };
      else if (tool === "form_check") reply = { sends: false, why: "Scripted: a search form." };
      else if (tool === "learned") reply = { site_notes: [], lesson: "", about_user: [], drop: [] };
      else if (tool === "context") reply = { items: [] };
      else if (tool === "addressed_check") reply = { addressed: false };
      else reply = {};
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(tool || "answer", reply));
    });
  });
  return { state, listen: () => new Promise((r) => server.listen(PORT, "127.0.0.1", r)), close: () => new Promise((r) => server.close(r)) };
}

// ------------------------------------------------------------ the browser

async function launch(extDir, profile) {
  const { chromium } = require("playwright");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.E2E_HEADFUL,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run"],
    viewport: { width: 1280, height: 800 },
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
  return { context, worker, id: new URL(worker.url()).host };
}

const useGateway = (worker) => Promise.all([
  worker.evaluate((base) => chrome.storage.sync.set({ agentActiveProvider: "custom", agentCustomUrl: `${base}/v1`, agentModel: "first-run-scripted", showAgent: true, agentRiskConfirmation: true, agentLearning: false, openingMode: "tab" }), `http://127.0.0.1:${PORT}`),
  // The user already agreed to what the agent sends to this server.
  worker.evaluate((base) => chrome.storage.local.set({ onboardingComplete: true, agentDataConsent: { [`custom ${base}`]: Date.now() } }), `http://127.0.0.1:${PORT}`),
]);

const tabIdOf = (worker, prefix) => worker.evaluate(async (p) => ((await chrome.tabs.query({})).find((t) => (t.url || "").startsWith(p)) || {}).id, prefix);

/** Runs one task from the agent page on the tab it was asked about, and waits for its answer or a card. */
async function task(context, worker, id, startUrl, words, gw, policy) {
  gw.state.policy = policy;
  const site = await context.newPage();
  await site.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  const tabId = await tabIdOf(worker, startUrl.replace(/\/$/, ""));
  const agent = await context.newPage();
  await agent.goto(`chrome-extension://${id}/agent.html?task=${encodeURIComponent(words)}&autostart=1&fresh=1${tabId ? `&tabId=${tabId}` : ""}`);
  const start = Date.now();
  let seen = null;
  while (Date.now() - start < TIMEOUT_MS) {
    seen = await agent.evaluate(() => {
      const boxes = [...document.querySelectorAll(".final-answer-box")].filter((b) => getComputedStyle(b).display !== "none" && (b.innerText || "").trim());
      const cards = [...document.querySelectorAll(".confirmation-bubble")].map((c) => (c.innerText || "").replace(/\s+/g, " ").trim());
      return { answer: boxes.length ? boxes[boxes.length - 1].innerText.trim() : "", cards, busy: !!document.querySelector(".agent-run-status.running, .tl-running") };
    }).catch(() => null);
    if (seen && (seen.answer || seen.cards.length)) break;
    await sleep(500);
  }
  await sleep(800);
  return { site, agent, seen, ms: Date.now() - start };
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-first-run-"));
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
  const gw = gateway();
  let browser = null;
  try {
    // The store package, unzipped as Chrome would.
    execFileSync("node", [path.join(ROOT, "scripts/package-extension.mjs")], { cwd: ROOT, stdio: "inherit" });
    const shipped = path.join(tmp, "shipped");
    fs.mkdirSync(shipped);
    execFileSync("unzip", ["-q", path.join(ROOT, "dist/select-to-ai-extension.zip"), "-d", shipped]);
    const version = JSON.parse(fs.readFileSync(path.join(shipped, "manifest.json"), "utf8")).version;
    console.log(`Loaded package version ${version}`);
    await gw.listen();

    // ---- Part 1: the package as shipped, a brand new user.
    browser = await launch(shipped, path.join(tmp, "profile-1"));
    const { context, worker, id } = browser;
    let welcome = context.pages().find((p) => p.url().includes("/welcome.html"));
    for (let i = 0; !welcome && i < 20; i++) { await sleep(250); welcome = context.pages().find((p) => p.url().includes("/welcome.html")); }
    check("Chrome opens the welcome page on install", !!welcome);
    if (welcome) {
      await welcome.waitForLoadState("load");
      await welcome.bringToFront();
      await sleep(600);
      await welcome.screenshot({ path: path.join(SHOTS, "01-welcome.png") });
      const body = await welcome.evaluate(() => document.body.innerText);
      check("the welcome page offers OpenRouter and does not offer the ChatGPT plan", /Continue with OpenRouter/.test(body) && !/ChatGPT plan/.test(body));
      const key = await welcome.evaluate(() => document.getElementById("kbdPalette").textContent);
      check("the welcome page shows the real quick box key", /Alt K|⌃⇧Q/.test(key), key);
    }
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await sleep(600);
    await popup.screenshot({ path: path.join(SHOTS, "02-popup.png") });
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html`);
    await sleep(800);
    await settings.screenshot({ path: path.join(SHOTS, "03-settings.png"), fullPage: false });
    const chatgptOffered = await settings.evaluate(() => { const o = document.querySelector('#provider option[value="chatgpt"]'); return !!o && !o.hidden && !o.disabled; });
    check("Settings does not offer Sign in with ChatGPT", !chatgptOffered);

    await useGateway(worker);
    const asked = await task(context, worker, id, "https://en.wikipedia.org/wiki/Main_Page", "Search Wikipedia for Ada Lovelace and tell me when she was born.", gw, "wiki");
    await asked.agent.bringToFront();
    await asked.agent.screenshot({ path: path.join(SHOTS, "04-asks-for-site-access.png") });
    const access = asked.seen && [...asked.seen.cards, asked.seen.answer].join(" ");
    check("with no site allowed, the agent asks for access to Wikipedia instead of failing silently", /allow|access|permission/i.test(access || ""), (access || "nothing shown").slice(0, 140));
    await context.close();
    browser = null;

    // ---- Part 2: the same package with the three sites allowed.
    const allowed = path.join(tmp, "allowed");
    fs.cpSync(shipped, allowed, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(allowed, "manifest.json"), "utf8"));
    m.host_permissions.push("https://news.ycombinator.com/*", "https://en.wikipedia.org/*", "https://github.com/*");
    fs.writeFileSync(path.join(allowed, "manifest.json"), JSON.stringify(m, null, 2));
    browser = await launch(allowed, path.join(tmp, "profile-2"));
    await useGateway(browser.worker);
    for (const p of browser.context.pages()) if (p.url().includes("/welcome.html")) await p.close();

    const runs = [
      ["hn", "https://news.ycombinator.com/", "What's the top story on Hacker News right now?", /top story on Hacker News right now is "/, "05-hacker-news.png"],
      ["wiki", "https://en.wikipedia.org/wiki/Main_Page", "Search Wikipedia for Ada Lovelace and tell me when she was born.", /10 December 1815/, "06-wikipedia-search.png"],
      ["github", "https://github.com/trending", "What is the top repository on GitHub Trending today?", /top repository on GitHub Trending today is \S+\/\S+/, "07-github-trending.png"],
    ];
    for (const [policy, start, words, want, shot] of runs) {
      const before = gw.state.steps.length;
      const r = await task(browser.context, browser.worker, browser.id, start, words, gw, policy);
      await r.agent.bringToFront();
      await r.agent.screenshot({ path: path.join(SHOTS, shot) });
      const acts = gw.state.steps.slice(before).map((s) => s.actions.join("+")).join(", ");
      const answer = (r.seen && r.seen.answer) || "";
      check(`${policy}: answered on the live site`, want.test(answer), `${(r.ms / 1000).toFixed(1)} s, steps: ${acts || "none"}; ${answer.split("\n")[0].slice(0, 120) || (r.seen ? r.seen.cards.join(" | ").slice(0, 120) : "")}`);
      if (policy === "wiki") {
        await r.site.bringToFront();
        await r.site.screenshot({ path: path.join(SHOTS, "06b-wikipedia-after-search.png") });
        check("wiki: the search was typed into the real box and opened the article", /\/wiki\/Ada_Lovelace/.test(r.site.url()), r.site.url());
      }
    }
    if (gw.state.errors.length) console.log(`policy errors:\n  ${gw.state.errors.join("\n  ")}`);
  } catch (e) {
    check("the run finished", false, e.message.split("\n")[0]);
  } finally {
    if (browser) await browser.context.close().catch(() => {});
    await gw.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} first-run checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
