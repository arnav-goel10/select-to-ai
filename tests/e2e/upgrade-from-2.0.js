/**
 * Update from the store version (plan: upgrade-from-2.0).
 *
 *   node tests/e2e/upgrade-from-2.0.js [buildDir]
 *
 * buildDir (default PACKAGE_DIR, else extension/) is the 4.0 build, ideally
 * the unzipped store package. The test:
 *   1. generates a throwaway signing key (in memory, never written to the
 *      repo) and puts its public half in a copy of the 2.0 manifest
 *      (tests/fixtures/v2.0/manifest.json), so the extension gets a fixed id;
 *   2. loads that 2.0 stand-in in a fresh profile and writes the 2.0 storage
 *      shapes from tests/fixtures/v2.0/storage-seed.json;
 *   3. closes Chrome, replaces the directory with the 4.0 build carrying the
 *      same key, and opens the same profile again, which Chrome treats as an
 *      update of the same extension;
 *   4. checks what a 2.0 user meets: the worker runs, the three right-click
 *      items exist, settings are migrated and kept, legacy keys are gone and
 *      no tab opened.
 *
 * The 2.0 stand-in has the real 2.0 manifest and empty scripts: only the
 * manifest and the stored settings carry over an update, so the 2.0 code
 * itself is not needed. An unpacked load never shows Chrome's update prompt;
 * the prompt is covered by tests/contract/permission-warning-diff.js.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.resolve(process.argv[2] || process.env.PACKAGE_DIR || path.join(ROOT, "extension"));
const FIXTURE = path.join(ROOT, "tests/fixtures/v2.0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const id = [...crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  return { key: der.toString("base64"), id };
}

function writeStandIn(dir, key) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, "manifest.json"), "utf8"));
  manifest.key = key;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "background.js"), "// 2.0 stand-in for the update test\n");
  fs.writeFileSync(path.join(dir, "contentScript.js"), "\n");
  fs.writeFileSync(path.join(dir, "rules.json"), "[]\n");
  for (const page of ["popup.html", "sidepanel.html"]) fs.writeFileSync(path.join(dir, page), "<!doctype html><title>2.0</title>\n");
  fs.copyFileSync(path.join(BUILD, "icon128.png"), path.join(dir, "logo.png"));
}

function writeBuild(dir, key) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(BUILD, dir, { recursive: true });
  fs.rmSync(path.join(dir, "_metadata"), { recursive: true, force: true });
  const file = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.key = key;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest.version;
}

async function open(puppeteer, extDir, profile, id) {
  const browser = await puppeteer.launch({
    headless: !process.env.E2E_HEADFUL,
    userDataDir: profile,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run", "--disable-features=DialMediaRouteProvider", "--enable-logging=stderr", "--v=0"],
  });
  const errors = [];
  // A throw while the worker's scripts load happens before a debugger can
  // attach, so Chrome's own log of the worker's console is read as well.
  const proc = browser.process();
  if (proc && proc.stderr) {
    proc.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.includes(`chrome-extension://${id}/`) && /Uncaught/.test(line)) errors.push(line.replace(/^\[[^\]]*\]\s*/, "").trim());
      }
    });
  }
  const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}/`), { timeout: 20000 })
    .catch(() => null);
  if (target) {
    const cdp = await target.createCDPSession();
    cdp.on("Runtime.exceptionThrown", (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description) || e.exceptionDetails.text));
    await cdp.send("Runtime.enable");
  }
  return { browser, target, worker: target ? await target.worker() : null, errors };
}

async function main() {
  const puppeteer = require("puppeteer");
  const seed = JSON.parse(fs.readFileSync(path.join(FIXTURE, "storage-seed.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-upgrade-"));
  const extDir = path.join(tmp, "extension");
  const profile = path.join(tmp, "profile");
  const { key, id } = testKey();
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  try {
    // 1 and 2: the 2.0 user.
    writeStandIn(extDir, key);
    let s = await open(puppeteer, extDir, profile, id);
    if (!s.worker) throw new Error("the 2.0 stand-in did not start, so there is nothing to update from");
    await s.worker.evaluate((data) => Promise.all([chrome.storage.sync.set(data.sync), chrome.storage.local.set(data.local)]), seed);
    const v2 = await s.worker.evaluate(() => chrome.runtime.getManifest().version);
    console.log(`2.0 stand-in running as ${id}, version ${v2}, storage seeded`);
    await s.browser.close();
    await sleep(500);

    // 3: the update.
    const version = writeBuild(extDir, key);
    s = await open(puppeteer, extDir, profile, id);
    check("worker starts after the update, under the same id", s.worker, s.worker ? "" : "no service worker for this id within 20 s");
    if (!s.worker) { await s.browser.close(); return report(checks); }
    await sleep(2500); // onInstalled and the migrations run
    const running = await s.worker.evaluate(() => chrome.runtime.getManifest().version);
    check(`running version is the build (${version})`, running === version, `running ${running}`);
    // What the updated build was granted, so a missing API in the worker
    // (for example a permission the update added) is explained in the log.
    const grants = await s.worker.evaluate(async () => ({ all: await chrome.permissions.getAll(), notifications: typeof chrome.notifications, debugger: typeof chrome.debugger }));
    console.log(`granted after update: ${JSON.stringify(grants.all)}`);
    console.log(`chrome.notifications is ${grants.notifications}, chrome.debugger is ${grants.debugger}`);
    const engine = await s.worker.evaluate(() => typeof self.SELECT_TO_AI_ENGINE);
    check("every worker script loaded (engine present)", engine !== "undefined", `self.SELECT_TO_AI_ENGINE is ${engine}`);

    const sync = await s.worker.evaluate(() => chrome.storage.sync.get(null));
    const local = await s.worker.evaluate(() => chrome.storage.local.get(null));
    console.log(`sync after update: ${JSON.stringify(sync)}`);
    console.log(`local keys after update: ${Object.keys(local).join(", ")}`);
    check("a setting the user chose is kept (autoSend true)", sync.autoSend === true, `autoSend ${JSON.stringify(sync.autoSend)}`);
    check("showPerplexity is true (2.0 showed Perplexity when unset)", sync.showPerplexity === true, `showPerplexity ${JSON.stringify(sync.showPerplexity)}`);
    check("autoContext is false (2.0 default when unset)", sync.autoContext === false, `autoContext ${JSON.stringify(sync.autoContext)}`);
    check("openingMode sidebarWindow is migrated to sidePanel", sync.openingMode === "sidePanel", `openingMode ${JSON.stringify(sync.openingMode)}`);
    const left = seed.legacy.filter((k) => k in sync);
    check(`legacy keys removed (${seed.legacy.join(", ")})`, !left.length, left.length ? `still stored: ${left.join(", ")}` : "");

    // The right-click items. Chrome has no API to list them, so the create
    // calls are recorded while a settings change makes the worker rebuild
    // the menu from the same settings it built it from at start.
    const menus = await s.worker.evaluate(async () => {
      const made = [];
      const real = chrome.contextMenus.create;
      chrome.contextMenus.create = function (props, cb) { made.push(props.title || props.id); return real.call(this, props, cb); };
      await chrome.storage.sync.set({ __menuProbe: Date.now() });
      await new Promise((r) => setTimeout(r, 1200));
      await chrome.storage.sync.remove("__menuProbe");
      await new Promise((r) => setTimeout(r, 600));
      chrome.contextMenus.create = real;
      return made;
    });
    console.log(`right-click items: ${JSON.stringify(menus)}`);
    for (const name of ["ChatGPT", "Gemini", "Perplexity"]) {
      check(`right-click item for ${name}`, menus.some((t) => t === `Send to ${name}`), "");
    }

    const tabs = (await s.browser.pages()).map((p) => p.url()).filter((u) => u.startsWith(`chrome-extension://${id}/`));
    check("no tab opened on update", !tabs.length, tabs.join(", "));
    check("no uncaught worker error after the update", !s.errors.length, s.errors.join(" | "));
    await s.browser.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return report(checks);
}

function report(checks) {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${!c.ok && c.detail ? `\n      ${c.detail}` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} update checks passed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
