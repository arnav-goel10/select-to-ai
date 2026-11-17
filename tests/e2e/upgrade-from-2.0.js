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
 *   3. replaces the directory with the 4.0 build carrying the same key and
 *      has the running extension reload itself, which Chrome treats as an
 *      update of the same extension (onInstalled reason "update");
 *   4. checks what a 2.0 user meets: the worker runs, the three right-click
 *      items exist, settings are migrated and kept, legacy keys are gone and
 *      no tab opened;
 *   5. opens the popup and Settings as the user would and checks that the
 *      "What is new in 4.0" note is shown once (with "New" on the toolbar
 *      icon until it is read), and that nothing about Claude is offered to a
 *      2.0 user, who never had a Claude item.
 *
 * A second pass updates from a 3.x stand-in (the same manifest with
 * claude.ai as a host every install held, as 3.x had). Whether Chrome keeps
 * that host once 4.0 makes it optional is measured and printed, and both
 * states are checked: with the host held "Send to Claude" is in the menu and
 * nothing is offered; without it the item cannot be shown, and the popup and
 * Settings each offer Claude back.
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

const CLAUDE = "https://claude.ai/*";

function writeStandIn(dir, key, from) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, "manifest.json"), "utf8"));
  manifest.key = key;
  if (from.version) manifest.version = from.version;
  if (from.claudeHost) {
    manifest.host_permissions.push(CLAUDE);
    manifest.content_scripts[0].matches.push(CLAUDE);
  }
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
  return { browser, errors, ...(await attach(browser, id, errors)) };
}

async function developerMode(browser) {
  const page = await browser.newPage();
  try {
    await page.goto("chrome://extensions/", { waitUntil: "load" });
    await page.evaluate(() => new Promise((resolve) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve)));
  } finally {
    await page.close().catch(() => {});
  }
}

// What chrome://extensions knows about the extension: enabled or not, why
// it is disabled, and the errors it recorded. For the log when a step fails.
async function extensionInfo(browser, id) {
  const page = await browser.newPage();
  try {
    await page.goto("chrome://extensions/", { waitUntil: "load" });
    return await page.evaluate((extId) => new Promise((resolve) => {
      chrome.developerPrivate.getExtensionInfo(extId, (info) => {
        if (!info) { resolve({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no such extension" }); return; }
        resolve({
          state: info.state, version: info.version, disableReasons: info.disableReasons,
          manifestErrors: (info.manifestErrors || []).map((e) => e.message),
          runtimeErrors: (info.runtimeErrors || []).map((e) => e.message),
        });
      });
    }), id);
  } catch (e) {
    return { error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// The extension's service worker, other than `previous` (the one a reload
// replaces), with uncaught exceptions collected from the moment it is found.
async function attach(browser, id, errors, previous) {
  const target = await browser.waitForTarget((t) => t !== previous && t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}/`), { timeout: 20000 })
    .catch(() => null);
  if (!target) return { target: null, worker: null };
  const cdp = await target.createCDPSession();
  cdp.on("Runtime.exceptionThrown", (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description) || e.exceptionDetails.text));
  await cdp.send("Runtime.enable");
  return { target, worker: await target.worker() };
}

// The right-click items. Chrome has no API to list them, so the create
// calls are recorded while a settings change makes the worker rebuild the
// menu from the same settings it built it from at start.
const menuTitles = (worker) => worker.evaluate(async () => {
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

/**
 * What an extension page shows once it has loaded: for each id, whether the
 * element is on show and, for a checkbox, whether it is ticked. `act` may
 * click something first (an id), and the page is read again after it.
 */
async function pageShows(browser, id, file, ids, act) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`chrome-extension://${id}/${file}`, { waitUntil: "load" });
    await sleep(700); // storage and permission answers land
    const read = () => page.evaluate((list) => Object.fromEntries(list.map((x) => {
      const el = document.getElementById(x);
      return [x, el ? { shown: !el.hidden && el.getClientRects().length > 0, checked: el.checked === true } : null];
    })), ids);
    const before = await read();
    let after = null;
    if (act) {
      await page.click(`#${act}`);
      await sleep(500);
      after = await read();
    }
    return { before, after, errors };
  } finally {
    await page.close().catch(() => {});
  }
}

const FROM_2 = { label: "2.0", version: null, claudeHost: false, v2: true };
// 3.x held claude.ai from the install and showed Claude unless it was turned off.
const FROM_3 = { label: "3.4.0", version: "3.4.0", claudeHost: true, v2: false, seed: { sync: { autoSend: true, openingMode: "tab" }, local: {} } };

async function updateFrom(puppeteer, from, checks) {
  const seed = from.seed || JSON.parse(fs.readFileSync(path.join(FIXTURE, "storage-seed.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-upgrade-"));
  const extDir = path.join(tmp, "extension");
  const profile = path.join(tmp, "profile");
  const { key, id } = testKey();
  const check = (name, ok, detail) => checks.push({ name: `[from ${from.label}] ${name}`, ok: !!ok, detail });
  console.log(`\n--- update from ${from.label} ---`);
  try {
    // 1 and 2: the user on the old version.
    writeStandIn(extDir, key, from);
    let s = await open(puppeteer, extDir, profile, id);
    if (!s.worker) throw new Error(`the ${from.label} stand-in did not start, so there is nothing to update from`);
    await s.worker.evaluate((data) => Promise.all([chrome.storage.sync.set(data.sync), chrome.storage.local.set(data.local)]), seed);
    const old = await s.worker.evaluate(() => chrome.runtime.getManifest().version);
    console.log(`${from.label} stand-in running as ${id}, version ${old}, storage seeded`);

    // 3: the update. The directory now holds the build, and the running
    // extension reloads itself from disk, so Chrome installs it over the old
    // version in the same profile and fires onInstalled with reason
    // "update". (Closing Chrome and relaunching on the changed directory is
    // not enough: the relaunched worker kept running the stand-in's cached
    // script.)
    const version = writeBuild(extDir, key);
    // Chrome keeps a reloaded unpacked extension enabled only in developer
    // mode (otherwise it is disabled as unsupportedDeveloperExtension).
    await developerMode(s.browser);
    await s.worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); }).catch(() => {});
    Object.assign(s, await attach(s.browser, id, s.errors, s.target));
    check("worker starts after the update, under the same id", s.worker, s.worker ? "" : "no new service worker for this id within 20 s");
    if (!s.worker) {
      console.log(`extension state: ${JSON.stringify(await extensionInfo(s.browser, id))}`);
      await s.browser.close();
      return;
    }
    await sleep(2500); // onInstalled and the migrations run
    const script = await s.worker.evaluate(() => typeof updateContextMenus).catch((e) => `error: ${e.message}`);
    check("the worker runs the build's background.js", script === "function", `typeof updateContextMenus is ${script}`);
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
    if (from.v2) {
      check("showPerplexity is true (2.0 showed Perplexity when unset)", sync.showPerplexity === true, `showPerplexity ${JSON.stringify(sync.showPerplexity)}`);
      check("autoContext is false (2.0 default when unset)", sync.autoContext === false, `autoContext ${JSON.stringify(sync.autoContext)}`);
      check("openingMode sidebarWindow is migrated to sidePanel", sync.openingMode === "sidePanel", `openingMode ${JSON.stringify(sync.openingMode)}`);
      const left = seed.legacy.filter((k) => k in sync);
      check(`legacy keys removed (${seed.legacy.join(", ")})`, !left.length, left.length ? `still stored: ${left.join(", ")}` : "");
    }

    const menus = await menuTitles(s.worker);
    console.log(`right-click items: ${JSON.stringify(menus)}`);
    if (from.v2) {
      for (const name of ["ChatGPT", "Gemini", "Perplexity"]) {
        check(`right-click item for ${name}`, menus.some((t) => t === `Send to ${name}`), "");
      }
    }

    const tabs = (await s.browser.pages()).map((p) => p.url()).filter((u) => u.startsWith(`chrome-extension://${id}/`));
    check("no tab opened on update", !tabs.length, tabs.join(", "));

    // 5: the note. The worker left a notice under the key the popup reads,
    // the toolbar icon says so, and the popup shows the note until "Got it".
    const noticeKey = await s.worker.evaluate(() => CONFIG.STORAGE.UPGRADE_NOTICE);
    const badge = () => s.worker.evaluate(() => chrome.action.getBadgeText({}));
    check("the worker left the notice the popup reads", local[noticeKey] && local[noticeKey].from === old, `local.${noticeKey} is ${JSON.stringify(local[noticeKey])}`);
    check("the toolbar icon says New while the note is unread", (await badge()) === "New", `badge text ${JSON.stringify(await badge())}`);
    const popupIds = ["whatsNew", "addClaudeBtn"];
    const first = await pageShows(s.browser, id, "popup.html", popupIds, "whatsNewClose");
    check("the popup shows What is new in 4.0", first.before.whatsNew && first.before.whatsNew.shown, JSON.stringify(first.before));
    check("Got it puts the note away", first.after && first.after.whatsNew && !first.after.whatsNew.shown, JSON.stringify(first.after));
    const second = await pageShows(s.browser, id, "popup.html", popupIds);
    check("the note is shown once: the next popup does not show it", second.before.whatsNew && !second.before.whatsNew.shown, JSON.stringify(second.before));
    check("the toolbar badge is cleared with the note", (await badge()) === "", `badge text ${JSON.stringify(await badge())}`);
    check("the popup ran without an error", !first.errors.length && !second.errors.length, [...first.errors, ...second.errors].join(" | "));

    // Claude. With the host held it is in the menu and nothing is offered;
    // without it the popup and Settings offer it back to a user who had it.
    const held = () => s.worker.evaluate((origin) => chrome.permissions.contains({ origins: [origin] }), CLAUDE);
    const optionIds = ["claudeBack", "showClaude"];
    const claudeState = async (label, isHeld, items) => {
      const popup = await pageShows(s.browser, id, "popup.html", popupIds);
      const options = await pageShows(s.browser, id, "options.html", optionIds);
      const inMenu = items.includes("Send to Claude");
      const offered = { popup: !!(popup.before.addClaudeBtn && popup.before.addClaudeBtn.shown), settings: !!(options.before.claudeBack && options.before.claudeBack.shown) };
      const chip = !!(options.before.showClaude && options.before.showClaude.checked);
      const detail = `menu ${JSON.stringify(items)}, popup ${JSON.stringify(popup.before)}, settings ${JSON.stringify(options.before)}`;
      if (isHeld) {
        check(`${label}: Send to Claude is in the right-click menu`, inMenu, detail);
        check(`${label}: nothing is offered, and the Settings chip is on`, !offered.popup && !offered.settings && chip, detail);
      } else {
        check(`${label}: the menu has no Claude item`, !inMenu, detail);
        check(`${label}: the popup offers Claude back`, offered.popup, detail);
        check(`${label}: Settings says Claude is missing and offers it back`, offered.settings && !chip, detail);
      }
      check(`${label}: Settings ran without an error`, !options.errors.length, options.errors.join(" | "));
    };
    const heldAfterUpdate = await held();
    if (from.v2) {
      // 2.0 had no Claude item, so there is nothing to give back.
      check("claude.ai is not held, as in 2.0", !heldAfterUpdate, "");
      check("nothing about Claude is recorded for a 2.0 user", !("showClaude" in sync), `showClaude ${JSON.stringify(sync.showClaude)}`);
      const popup = await pageShows(s.browser, id, "popup.html", popupIds);
      const options = await pageShows(s.browser, id, "options.html", optionIds);
      check("no Claude item, and none is offered back", !menus.includes("Send to Claude") && !popup.before.addClaudeBtn.shown && !options.before.claudeBack.shown, `popup ${JSON.stringify(popup.before)}, settings ${JSON.stringify(options.before)}`);
    } else {
      console.log(`MEASURED: after the update from ${from.label}, where claude.ai was a host every install held, Chrome ${heldAfterUpdate ? "still holds" : "no longer holds"} claude.ai`);
      check("that the user had Claude on is written down (showClaude true)", sync.showClaude === true, `showClaude ${JSON.stringify(sync.showClaude)}`);
      await claudeState(heldAfterUpdate ? "host kept" : "host not kept", heldAfterUpdate, menus);
      if (heldAfterUpdate) {
        // The other state: the host is taken away, as the user can do on Chrome's own page.
        await s.worker.evaluate((origin) => chrome.permissions.remove({ origins: [origin] }), CLAUDE).catch(() => false);
        await sleep(1500);
        const stillHeld = await held();
        check("the test could take claude.ai away to check the other state", !stillHeld, "chrome.permissions.remove left the host in place");
        if (!stillHeld) await claudeState("host taken away", false, await menuTitles(s.worker));
      } else {
        console.log("The state with the host held cannot be reached here (Chrome's prompt cannot be clicked by automation); tests/unit/claude-back.test.js covers it.");
      }
    }

    check("no uncaught worker error after the update", !s.errors.length, s.errors.join(" | "));
    await s.browser.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const puppeteer = require("puppeteer");
  const checks = [];
  await updateFrom(puppeteer, FROM_2, checks);
  await updateFrom(puppeteer, FROM_3, checks);
  return report(checks);
}

function report(checks) {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${!c.ok && c.detail ? `\n      ${c.detail}` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} update checks passed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
