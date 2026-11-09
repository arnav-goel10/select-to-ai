/**
 * Signs the benchmark browser in to ChatGPT, once, so the benchmarks can run
 * the agent on the owner's own ChatGPT plan.
 *
 *   npm run bench:chatgpt-login
 *   CHATGPT_PROFILE=/some/folder npm run bench:chatgpt-login     another profile
 *   node tests/bench/chatgpt-profile.js --timeout 30              give up after 30s
 *
 * It opens the same browser the benchmark uses (Chrome for Testing, with a
 * copy of the extension allowed on every site) on a persistent profile
 * (default ~/.select-to-ai-bench/chatgpt-profile), at the extension's
 * settings with ChatGPT chosen. Click "Continue with ChatGPT" and sign in
 * yourself; the window closes when the account is connected, and the
 * account's email and models are printed. Only those are read, never a
 * token. Then run a benchmark on that profile:
 *
 *   BENCH_PROFILE=~/.select-to-ai-bench/chatgpt-profile BENCH_MODEL=<slug> node tests/bench/run.js
 *
 * BENCH_HELPER_MODEL may name a second slug; BENCH_API_KEY is not needed.
 * The same BENCH_PROFILE works for miniwob.js and for the arms of matrix.js.
 *
 * The extension is loaded with a manifest "key" kept in the profile
 * (select-to-ai-bench.json), so its id, under which the sign-in is stored,
 * is the same here and in every benchmark copy. Running this again on a
 * signed-in profile just reports the account.
 *
 * Env: CHATGPT_PROFILE (the profile folder), BENCH_EXTENSION (another build
 * of the extension, as in run.js).
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("./profile.js");

const EXT = process.env.BENCH_EXTENSION ? path.resolve(process.env.BENCH_EXTENSION) : path.resolve(__dirname, "../../extension");
const PROFILE = P.loginProfile(process.env);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** --timeout <seconds>: how long to wait for the sign-in (default 15 minutes). */
function timeoutMs(argv) {
  const i = argv.indexOf("--timeout");
  const s = i >= 0 ? parseInt(argv[i + 1], 10) : NaN;
  return (Number.isFinite(s) && s > 0 ? s : 15 * 60) * 1000;
}

async function main() {
  const limitMs = timeoutMs(process.argv.slice(2));
  const meta = P.ensureMeta(PROFILE, EXT);
  const loaded = P.copyExtension(EXT, fs.mkdtempSync(path.join(os.tmpdir(), "select-to-ai-ext-")), meta);
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: PROFILE,
    // A sign-in page may turn away a browser that says it is automated.
    ignoreDefaultArgs: ["--enable-automation"],
    args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`, "--no-first-run", "--disable-features=DialMediaRouteProvider",
      "--disable-blink-features=AutomationControlled", "--hide-crash-restore-bubble", "--window-size=1100,900"],
  });
  let closedByUser = true;
  browser.on("disconnected", () => { if (closedByUser) { console.log("\nThe window was closed before the sign-in finished."); cleanup(); process.exit(1); } });
  const cleanup = () => fs.rmSync(loaded, { recursive: true, force: true });
  const finish = async (code) => { closedByUser = false; await browser.close().catch(() => {}); cleanup(); process.exit(code); };

  try {
    const worker = await P.workerOf(browser, meta.extensionId);
    await worker.evaluate(() => Promise.all([
      chrome.storage.sync.set({ agentActiveProvider: "chatgpt", showAgent: true }),
      chrome.storage.local.set({ onboardingComplete: true }),
    ]));
    // A sign-in the benchmarks have renewed since is taken back first, so the
    // profile does not hold a spent refresh token.
    await P.syncCredentials(browser, meta.extensionId, PROFILE, 0, { renew: false }).catch(() => null);

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    for (const p of pages.slice(1)) await p.close().catch(() => {});
    const optionsUrl = `chrome-extension://${meta.extensionId}/options.html`;
    await page.goto(optionsUrl, { waitUntil: "load" });

    console.log(`Profile: ${PROFILE}\nExtension id: ${meta.extensionId} (from the profile's manifest key)\n`);
    console.log("Click Continue with ChatGPT and sign in; this window closes when you are signed in.");
    console.log(`Waiting up to ${Math.round(limitMs / 1000)}s.\n`);

    const t0 = Date.now();
    let said = "";
    while (Date.now() - t0 < limitMs) {
      // Read through any of the extension's pages; reopen the settings if they were closed.
      let view = (await browser.pages()).find((p) => p.url().startsWith(`chrome-extension://${meta.extensionId}/`));
      if (!view) { view = await browser.newPage(); await view.goto(optionsUrl, { waitUntil: "load" }).catch(() => {}); }
      const account = await P.readAccount(view).catch(() => null);
      if (account && account.signedIn && account.planEnabled) {
        // The record just signed in becomes the shared one the benchmarks start from.
        const synced = await P.syncCredentials(browser, meta.extensionId, PROFILE, 0, { renew: false }).catch((e) => ({ ok: false, why: e.message }));
        if (!synced.ok) console.log(`Note: the sign-in could not be read back (${synced.why}).`);
        console.log(`Signed in as ${account.email || "(no email given)"}.`);
        console.log(`Models (${account.models.length}):`);
        for (const m of account.models) console.log(`  ${m.name}  ${m.slug}`);
        console.log(`\nRun: BENCH_PROFILE=${PROFILE} BENCH_MODEL=<slug> node tests/bench/run.js`);
        await finish(0);
        return;
      }
      const now = account && account.signedIn && !account.planEnabled ? `Signed in as ${account.email || "your account"}, but ChatGPT plan use is off. Allow it in the window to go on.` : "";
      if (now && now !== said) { console.log(now); said = now; }
      await sleep(1500);
    }
    console.log("No ChatGPT account was connected before the timeout. Run this again when ready.");
    await finish(2);
  } catch (e) {
    console.error(e.message || e);
    await finish(1);
  }
}

if (require.main === module) main();
module.exports = { timeoutMs };
