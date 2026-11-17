/**
 * The data consent before the first provider request (plan: consent-gate).
 *
 *   node tests/e2e/consent.js [buildDir]
 *
 * Loads the build (default PACKAGE_DIR, else extension/) in Chromium with the
 * local test servers and two provider hosts granted, as after Allow. The
 * model is the scripted gateway in server.js, which counts every call it
 * gets, and provider requests from the welcome page are caught before they
 * leave. Checks, for a fresh install and for a profile upgraded from 2.0:
 *
 *   - a task typed in the agent page sends nothing until the user agrees
 *   - after Agree the request goes, and the consent is stored
 *   - a different provider is asked again, and Not now sends nothing
 *   - the welcome page sends a pasted key nowhere before Agree, then only
 *     to the provider its shape names, and names that provider on failure
 *   - Settings' Test sends nothing before Agree
 *   - the last assistant cannot be unticked while the agent is off
 *   - a task handed in the address while a run waits gets the handoff choice
 *   - a spent allowance (a played 429) holds the run on a card with its
 *     choices and asks nothing more of the provider; a provider chosen
 *     while it is held gets nothing until the user agrees, then the run
 *     carries on with it; Stop on the card ends the run with an answer
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createE2EServer } = require("./server.js");
const { grantedBuild, TEST_HOSTS } = require("../helpers/granted-build.js");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.resolve(process.argv[2] || process.env.PACKAGE_DIR || path.join(ROOT, "extension"));
const PROVIDER_HOSTS = ["https://api.openai.com/*", "https://api.deepseek.com/*"];
const EXT = grantedBuild(BUILD, [...TEST_HOSTS, ...PROVIDER_HOSTS]);
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/v2.0/storage-seed.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDER_ORIGIN = /^https:\/\/(api\.openai\.com|api\.deepseek\.com|openrouter\.ai|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.groq\.com|api\.together\.xyz|api\.x\.ai|opencode\.ai|api\.cerebras\.ai)\//;

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`); };

async function waitFor(fn, ms = 10000, every = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

async function main() {
  const puppeteer = require("puppeteer");
  const a = createE2EServer(parseInt(process.env.E2E_PORT || "8931", 10));
  const b = createE2EServer(parseInt(process.env.E2E_PORT_B || "8932", 10));
  await a.listen();
  await b.listen();
  const browser = await puppeteer.launch({
    headless: !process.env.E2E_HEADFUL,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--disable-features=DialMediaRouteProvider"],
  });
  const errors = [];
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 });
    const id = new URL(target.url()).host;
    const worker = await target.worker();
    await sleep(800);
    for (const p of await browser.pages()) if (p.url().startsWith("chrome-extension")) await p.close();

    const reset = (sync, local) => worker.evaluate(async (s, l) => {
      await chrome.storage.local.clear();
      await chrome.storage.sync.clear();
      await chrome.storage.session.clear();
      await chrome.storage.sync.set(s);
      await chrome.storage.local.set(l);
    }, sync, local);
    const consentStore = () => worker.evaluate(async () => (await chrome.storage.local.get("agentDataConsent")).agentDataConsent || {});
    const calls = async (server) => (await (await fetch(`${server.baseUrl}/control/log`)).json()).llmCalls || 0;
    const select = (server, name) => fetch(`${server.baseUrl}/control/scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json());
    const settingsFor = (server, extra) => ({ agentActiveProvider: "custom", agentCustomUrl: `${server.baseUrl}/v1`, agentModel: "e2e-scripted-model", showAgent: true, agentRiskConfirmation: true, agentDomainAllowlist: "", openingMode: "tab", agentLearning: false, ...(extra || {}) });
    const idFor = (server) => `custom ${new URL(server.baseUrl).origin}`;

    async function open(url, name) {
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(url, { waitUntil: "load" });
      return page;
    }

    // A task on the agent page: nothing leaves before Agree, then it goes.
    async function agentScenario(label, server, { agree }) {
      const { task } = await select(server, "search");
      const before = await calls(server);
      const page = await open(`chrome-extension://${id}/agent.html?task=${encodeURIComponent(task)}&autostart=1&fresh=1`, label);
      const card = await waitFor(() => page.$(".consent-card"), 10000);
      await sleep(1500);
      const quiet = (await calls(server)) - before;
      check(`${label}: the consent card is shown before anything is sent`, card, "no .consent-card within 10 s");
      check(`${label}: no request reached the provider before consent`, quiet === 0, `${quiet} model calls before Agree`);
      if (card) {
        const text = await page.$eval(".consent-card", (el) => el.innerText.replace(/\s+/g, " "));
        check(`${label}: the card names where the data goes`, text.includes(new URL(server.baseUrl).host), text);
        check(`${label}: the card has no em dash and no "undefined"`, !/\u2014|undefined/.test(text), text);
      }
      if (card && agree) {
        await page.click(".consent-agree");
        const sent = await waitFor(async () => ((await calls(server)) - before) > 0, 20000);
        check(`${label}: after Agree the task reaches the provider`, sent, "no model call within 20 s of Agree");
        const stored = await consentStore();
        check(`${label}: the consent is stored for this provider`, stored[idFor(server)] > 0, JSON.stringify(stored));
        // Stop the run, so the next scenario starts with none live.
        await page.evaluate(() => { const s = document.getElementById("liveStopBtn"); if (s) s.click(); });
        await sleep(800);
      } else if (card) {
        await page.click(".consent-cancel");
        await sleep(2000);
        check(`${label}: Not now sends nothing`, (await calls(server)) - before === 0, "a model call after Not now");
        const stored = await consentStore();
        check(`${label}: Not now stores no consent`, !stored[idFor(server)], JSON.stringify(stored));
      }
      await page.close();
    }

    // 1. Fresh install.
    await reset(settingsFor(a), { onboardingComplete: true });
    await agentScenario("fresh install", a, { agree: true });

    // 2. The provider changes: asked again, and Not now sends nothing.
    await worker.evaluate((s) => chrome.storage.sync.set(s), { agentCustomUrl: `${b.baseUrl}/v1` });
    await agentScenario("provider changed", b, { agree: false });

    // 3. A profile upgraded from 2.0, then connected to a provider.
    await reset({ ...SEED.sync, ...settingsFor(a) }, { ...SEED.local, onboardingComplete: true });
    await agentScenario("upgraded from 2.0", a, { agree: true });

    // 4. The welcome page: an OpenAI project key, with OpenAI answering 401.
    await reset({}, {});
    {
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(`welcome: ${e.message}`));
      const seen = [];
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (!PROVIDER_ORIGIN.test(req.url())) { req.continue(); return; }
        seen.push(req.url());
        if (req.method() === "OPTIONS") { req.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } }); return; }
        req.respond({ status: 401, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: { message: "Incorrect API key provided." } }) });
      });
      await page.goto(`chrome-extension://${id}/welcome.html`, { waitUntil: "load" });
      await page.type("#keyInput", "sk-proj-ExampleKeyForTests0000ExampleKeyForTests0000");
      await page.click("#useKey");
      const card = await waitFor(() => page.$("#consentSlot .consent-card"), 5000);
      await sleep(1000);
      check("welcome: the consent card comes before the key is checked", card, "no consent card in #consentSlot");
      check("welcome: no request to any provider before Agree", seen.length === 0, seen.join(" "));
      if (card) {
        const text = await page.$eval("#consentSlot .consent-card", (el) => el.innerText);
        check("welcome: the card names OpenAI for an sk-proj key", /OpenAI \(api\.openai\.com\)/.test(text), text);
        await page.click("#consentSlot .consent-agree");
        const said = await waitFor(() => page.$eval("#status", (el) => (/said/.test(el.innerText) ? el.innerText : "")), 15000);
        check("welcome: the key went to api.openai.com", seen.some((u) => u.startsWith("https://api.openai.com/")), seen.join(" "));
        check("welcome: an sk-proj key never goes to api.deepseek.com", !seen.some((u) => u.includes("api.deepseek.com")), seen.join(" "));
        check("welcome: the error names the provider tried first", said && /^OpenAI said the key was not accepted/.test(said.trim()), String(said));
        check("welcome: no other provider is offered for a project key", !(await page.$(".try-other")), "a try-other button is shown");
      }
      await page.close();
    }

    // 5. Settings: Test sends nothing before Agree.
    await reset(settingsFor(a), { onboardingComplete: true });
    {
      const before = await calls(a);
      const page = await open(`chrome-extension://${id}/options.html`, "options");
      await sleep(600);
      await page.click("#changeBtn");
      await page.click("#testBtn");
      const card = await waitFor(() => page.$("#consentSlot .consent-card"), 5000);
      await sleep(1000);
      check("settings: Test shows the consent card first", card, "no consent card in #consentSlot");
      check("settings: no request before Agree", (await calls(a)) - before === 0, "a model call before Agree");
      if (card) {
        await page.click("#consentSlot .consent-agree");
        const sent = await waitFor(async () => ((await calls(a)) - before) > 0, 15000);
        check("settings: after Agree the test request goes", sent, "no model call within 15 s");
      }

      // The last assistant stays on while the agent is off.
      await worker.evaluate((s) => chrome.storage.sync.set(s), { showAgent: false, showChatGPT: true, showGemini: false, showPerplexity: false, showClaude: false });
      await page.reload({ waitUntil: "load" });
      await sleep(800);
      await page.click('label.chip:has(#showChatGPT)');
      await sleep(600);
      const still = await page.$eval("#showChatGPT", (el) => el.checked);
      const saved = await worker.evaluate(async () => (await chrome.storage.sync.get("showChatGPT")).showChatGPT);
      check("settings: the last assistant cannot be unticked while the agent is off", still && saved !== false, `checked ${still}, stored ${saved}`);
      await page.close();
    }

    // 6. A task handed in the address while a run waits for the user.
    await reset(settingsFor(a), { onboardingComplete: true, agentDataConsent: { [idFor(a)]: Date.now() } });
    {
      const { task } = await select(a, "form");
      const fixture = await open(`${a.baseUrl}/signup`, "fixture");
      const tabId = await worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, fixture.url());
      const page = await open(`chrome-extension://${id}/agent.html?task=${encodeURIComponent(task)}&autostart=1&fresh=1&tabId=${tabId}`, "handoff");
      const waiting = await waitFor(() => page.$(".confirmation-bubble"), 60000, 300);
      check("handoff: the run stops to ask before it submits", waiting, "no confirmation card within 60 s");
      if (waiting) {
        await page.goto(`chrome-extension://${id}/agent.html?task=${encodeURIComponent("Tell me the page title")}&autostart=1&tabId=${tabId}`, { waitUntil: "load" });
        const choice = await waitFor(() => page.$(".handoff-choice"), 15000);
        check("handoff: a task handed in while a run waits gets the stop-or-queue choice", choice, "no .handoff-choice card");
        const still = await waitFor(() => page.$(".confirmation-bubble"), 5000);
        check("handoff: the waiting run is still there, not steered", still, "the confirmation card is gone");
        const abort = await page.$(".abort-risk-btn");
        if (abort) await abort.click();
      }
      await page.close();
      await fixture.close();
    }

    // 7. A spent allowance holds the run. A provider chosen while it is held is agreed to before anything goes to it.
    {
      const limit = (server, on) => fetch(`${server.baseUrl}/control/limit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) }).then((r) => r.json());
      const HOLD = ".confirmation-bubble[data-hold]";
      const working = (page) => page.evaluate(() => document.getElementById("actionBtn").classList.contains("stop-btn"));
      async function heldRun(label) {
        await reset(settingsFor(a), { onboardingComplete: true, agentDataConsent: { [idFor(a)]: Date.now() } });
        const { task } = await select(a, "search");
        await select(b, "search");
        await limit(a, true);
        const fixture = await open(`${a.baseUrl}/`, "fixture");
        const tabId = await worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, fixture.url());
        const page = await open(`chrome-extension://${id}/agent.html?task=${encodeURIComponent(task)}&autostart=1&fresh=1&tabId=${tabId}`, label);
        const card = await waitFor(() => page.$(HOLD), 60000, 300);
        check(`${label}: a spent allowance holds the run on a card`, card, "no hold card within 60 s");
        return { page, fixture, card };
      }

      let { page, fixture, card } = await heldRun("hold");
      if (card) {
        const text = await page.$eval(HOLD, (el) => el.innerText.replace(/\s+/g, " "));
        check("hold: the card says it is on hold and that nothing is lost", /On hold: out of requests for now/.test(text) && /Nothing is lost\./.test(text), text);
        check("hold: the card has no em dash and no \"undefined\"", !/\u2014|undefined/.test(text), text);
        const buttons = await page.$$eval(`${HOLD} button`, (list) => list.map((x) => x.textContent.trim()));
        check("hold: the card offers a backup, trying again and stopping with what was found", buttons.join(" | ") === "Set up a free backup | Try again | Stop and answer with what you have", buttons.join(" | "));
        const spent = await calls(a);
        await sleep(3000);
        check("hold: a held run asks the provider nothing more", (await calls(a)) === spent, `${(await calls(a)) - spent} more calls while held`);
        // Another provider is chosen in Settings while the run is held: the user never agreed to it.
        await worker.evaluate((s) => chrome.storage.sync.set(s), { agentCustomUrl: `${b.baseUrl}/v1` });
        const consent = await waitFor(() => page.$(".consent-card"), 10000);
        await sleep(1500);
        check("hold: a provider chosen while held is asked about first", consent, "no .consent-card within 10 s of the change");
        check("hold: nothing went to that provider before the user agreed", (await calls(b)) === 0, `${await calls(b)} calls reached it`);
        check("hold: the run is still held", await page.$(HOLD), "the hold card is gone");
        if (consent) {
          const said = await page.$eval(".consent-card", (el) => el.innerText.replace(/\s+/g, " "));
          check("hold: the consent card names the new provider", said.includes(new URL(b.baseUrl).host), said);
          await page.click(".consent-agree");
          const sent = await waitFor(async () => (await calls(b)) > 0, 20000);
          check("hold: after Agree the run carries on with the new provider", sent, "no model call within 20 s of Agree");
          check("hold: the consent is stored for it", (await consentStore())[idFor(b)] > 0, JSON.stringify(await consentStore()));
          check("hold: the hold card goes when the run carries on", await waitFor(async () => !(await page.$(HOLD)), 10000), "the hold card is still there");
        }
        await page.evaluate(() => { const s = document.getElementById("liveStopBtn"); if (s) s.click(); });
        await sleep(800);
      }
      await page.close();
      await fixture.close();

      // Stop on the card ends the run with what it has.
      ({ page, fixture, card } = await heldRun("hold stop"));
      if (card) {
        const spent = await calls(a);
        await page.click(`${HOLD} .hold-stop-btn`);
        const ended = await waitFor(async () => !(await page.$(HOLD)) && !(await working(page)), 15000);
        check("hold stop: the run ends", ended, "still held or working 15 s after Stop");
        const answer = await page.evaluate(() => document.getElementById("chatContainer").innerText.replace(/\s+/g, " "));
        check("hold stop: it ends with the provider's limit as its answer", /has reached its usage limit/.test(answer), answer.slice(-300));
        check("hold stop: stopping asks the provider nothing", (await calls(a)) === spent, `${(await calls(a)) - spent} calls after Stop`);
      }
      await page.close();
      await fixture.close();
      await limit(a, false);
    }

    check("no uncaught page error", !errors.length, errors.join(" | "));
  } finally {
    await browser.close().catch(() => {});
    await a.close();
    await b.close();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
