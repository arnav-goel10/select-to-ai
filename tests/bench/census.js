/**
 * The block census: each task's start page loaded once, with no model call,
 * in the bench's browser as a person's Chrome would be (headful, run under
 * xvfb in CI, the packed extension loaded, the browser's own user agent, no
 * flag hidden), and classed reachable, blocked, error or timeout by
 * om2w.js censusClass, which uses the engine's own human-check detection.
 *
 *   CENSUS_TASKS=<split file with "part" on each task> BENCH_EXTENSION=build \
 *     xvfb-run -a node tests/bench/census.js
 *
 * Env:
 *   CENSUS_TASKS   tasks in run.js's format, each with "part" (om2w.js split --part all)
 *   CENSUS_OUT     output folder (default tests/bench/out/census)
 *   BENCH_SHARD    "2/4": the second of four equal parts
 *   BENCH_EXTENSION the unpacked build to load (default extension/)
 *   CENSUS_WAIT_S  seconds to wait after the page's first content, for a
 *                  challenge to show or clear (default 8)
 *   BENCH_DRY      1: the tasks are fixture pages, served here (tests/e2e/server.js)
 *
 * Writes om2w-census-<shard>.json: counts per part and class, and for dev
 * tasks only, the site, its class and the HTTP status. Prints a line per dev
 * site and counts for the rest. Nothing of a sealed task (its id, text,
 * address or site) is printed or written, an error's text included.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const O = require("./om2w.js");

const EXT = process.env.BENCH_EXTENSION ? path.resolve(process.env.BENCH_EXTENSION) : path.resolve(__dirname, "../../extension");
const OUT = process.env.CENSUS_OUT || path.join(__dirname, "out", "census");
const SHARD = (process.env.BENCH_SHARD || "").match(/^(\d+)\/(\d+)$/);
const WAIT_MS = Math.max(0, parseInt(process.env.CENSUS_WAIT_S || "8", 10)) * 1000;
const DRY = process.env.BENCH_DRY === "1";
const OPEN_PARTS = new Set(["dev", "fixture"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: what the class is decided from. */
function observeInPage(selectors) {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width >= 60 && r.height >= 40 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".grecaptcha-badge"); };
  let widget = false;
  try { widget = Array.from(document.querySelectorAll(selectors.join(", "))).some(shown); } catch (_e) { widget = false; }
  return {
    title: document.title,
    url: location.href,
    text: document.body ? (document.body.innerText || "").slice(0, 3000) : "",
    elements: Math.min(20, document.querySelectorAll("a, button, input, select, textarea").length),
    widget,
  };
}

async function observe(browser, url, selectors) {
  const page = await browser.newPage();
  const obs = { navError: false, timedOut: false, status: 0 };
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    obs.status = res ? res.status() : 0;
  } catch (e) {
    if (/timeout/i.test(String(e && e.name)) || /timeout/i.test(String(e && e.message))) obs.timedOut = true;
    else obs.navError = true;
  }
  await sleep(WAIT_MS);
  Object.assign(obs, await page.evaluate(observeInPage, selectors).catch(() => ({ text: "" })));
  await page.close().catch(() => {});
  return obs;
}

const WITHHELD = "The census stopped with an error; the detail is withheld, since it can name a sealed task.";
process.on("uncaughtException", () => { console.error(WITHHELD); process.exit(1); });
process.on("unhandledRejection", () => { console.error(WITHHELD); process.exit(1); });

(async () => {
  const all = JSON.parse(fs.readFileSync(process.env.CENSUS_TASKS, "utf8"));
  const tasks = SHARD ? all.filter((_, i) => i % Number(SHARD[2]) === Number(SHARD[1]) - 1) : all;
  fs.mkdirSync(OUT, { recursive: true });
  const selectors = O.engineWidgetSelectors(EXT);
  const loaded = fs.mkdtempSync(path.join(os.tmpdir(), `census-extension-${process.pid}-`));
  fs.cpSync(EXT, loaded, { recursive: true });
  // The same grant every bench run has: access to every site, as a user who chose "allow on all sites".
  const mf = path.join(loaded, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "https://*/*", "http://*/*"])];
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
  const dryServer = DRY ? require("../e2e/server.js").createE2EServer(require("./trial.js").DRY_PORT) : null;
  if (dryServer) await dryServer.listen();
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`, "--no-first-run", "--window-size=1280,900", "--disable-features=DialMediaRouteProvider"],
  });
  const counts = {};
  const devSites = [];
  let done = 0;
  try {
    for (const t of tasks) {
      const part = t.part || "fixture";
      let cls = "error";
      let status = 0;
      try {
        const obs = await observe(browser, t.url, selectors);
        cls = O.censusClass(obs);
        status = obs.status;
      } catch (_e) { cls = "error"; }
      counts[part] = counts[part] || Object.fromEntries(O.CENSUS_CLASSES.map((k) => [k, 0]));
      counts[part][cls]++;
      done++;
      if (OPEN_PARTS.has(part)) {
        const site = O.siteOfUrl(t.url);
        devSites.push({ site, class: cls, status });
        console.log(`${cls.padEnd(9)} ${site} (${part}, HTTP ${status || "-"})`);
      } else console.log(`page ${done} of ${tasks.length} done`);
    }
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(loaded, { recursive: true, force: true });
    if (dryServer) await dryServer.close().catch(() => {});
  }
  const name = `om2w-census-${SHARD ? `${SHARD[1]}of${SHARD[2]}` : "1of1"}.json`;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify({ dry: DRY, counts, devSites }, null, 2));
  console.log(`\nCensus: ${done} page(s). ${Object.entries(counts).map(([p, c]) => `${p}: ${O.CENSUS_CLASSES.map((k) => `${k} ${c[k]}`).join(", ")}`).join("; ")}.`);
})().catch(() => { console.error(WITHHELD); process.exit(1); });
