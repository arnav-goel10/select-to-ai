/**
 * The worker with no optional grant (plan: worker-no-optional-grants).
 *
 *   node tests/e2e/worker-no-optional-grants.js [buildDir]
 *
 * Loads the build (default PACKAGE_DIR, else extension/) in a fresh profile
 * with only the grants the shipped 4.0 manifest may hold: notifications
 * optional and not granted, host access to the three 2.0 hosts only, no
 * claude.ai and no provider host. If the build's manifest still asks for
 * more, a copy is cut down to that shape first and each change is printed,
 * so this test checks the code against the manifest that will ship.
 *
 * Then it checks that the service worker starts with no uncaught error and
 * that one right-click send to ChatGPT opens a new tab, by calling the
 * worker's context menu handler by name (onMenuClicked), as Chrome would.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.resolve(process.argv[2] || process.env.PACKAGE_DIR || path.join(ROOT, "extension"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shippedShape(dir) {
  const { ALLOWED_HOSTS } = await import(require("node:url").pathToFileURL(path.join(ROOT, "scripts/check-manifest.mjs")).href);
  const file = path.join(dir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const changes = [];
  const optional = new Set(m.optional_permissions || []);
  m.permissions = (m.permissions || []).filter((p) => {
    if (p === "notifications") { optional.add(p); changes.push("notifications moved to optional_permissions"); return false; }
    if (p === "debugger" || p === "favicon") { changes.push(`${p} removed`); return false; }
    return true;
  });
  if (optional.size) m.optional_permissions = [...optional];
  const hosts = (m.host_permissions || []).filter((h) => ALLOWED_HOSTS.includes(h));
  if (hosts.length !== (m.host_permissions || []).length) {
    changes.push(`host_permissions cut to ${hosts.join(", ")} (was ${m.host_permissions.length})`);
    m.host_permissions = hosts;
  }
  (m.content_scripts || []).forEach((c, i) => {
    const matches = (c.matches || []).filter((x) => ALLOWED_HOSTS.includes(x));
    if (matches.length !== (c.matches || []).length) { changes.push(`content_scripts[${i}] matches cut to the three 2.0 hosts`); c.matches = matches; }
  });
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  return changes;
}

async function main() {
  const puppeteer = require("puppeteer");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-nogrants-"));
  const extDir = path.join(tmp, "extension");
  fs.cpSync(BUILD, extDir, { recursive: true });
  fs.rmSync(path.join(extDir, "_metadata"), { recursive: true, force: true });
  const changes = await shippedShape(extDir);
  console.log(changes.length ? `manifest cut to the shipped shape:\n  ${changes.join("\n  ")}` : "manifest already has the shipped shape");

  const page = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Article</title><p id=t>Some text worth asking about.</p>"); });
  await new Promise((r) => page.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${page.address().port}/article`;

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const browser = await puppeteer.launch({
    headless: !process.env.E2E_HEADFUL,
    userDataDir: path.join(tmp, "profile"),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run", "--disable-features=DialMediaRouteProvider"],
  });
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 }).catch(() => null);
    check("service worker starts", target, "no service worker within 20 s (a top-level throw, for example chrome.notifications used while not granted, stops registration)");
    if (!target) return report(checks);
    const errors = [];
    const cdp = await target.createCDPSession();
    cdp.on("Runtime.exceptionThrown", (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description) || e.exceptionDetails.text));
    await cdp.send("Runtime.enable");
    const worker = await target.worker();
    await sleep(1500);

    const grants = await worker.evaluate(async () => ({ api: typeof chrome.notifications, all: await chrome.permissions.getAll() }));
    console.log(`granted: ${JSON.stringify(grants.all)}`);
    check("notifications is not granted", grants.api === "undefined" && !grants.all.permissions.includes("notifications"), `chrome.notifications is ${grants.api}`);
    check("every worker script loaded (engine present)", await worker.evaluate(() => typeof self.SELECT_TO_AI_ENGINE !== "undefined"), "self.SELECT_TO_AI_ENGINE is undefined");

    const handler = await worker.evaluate(() => typeof onMenuClicked);
    check("the right-click handler is reachable by name (onMenuClicked)", handler === "function", `typeof onMenuClicked is ${handler}; name the chrome.contextMenus.onClicked listener so a test can call it`);
    if (handler === "function") {
      await worker.evaluate(() => chrome.storage.sync.set({ openingMode: "tab", autoSend: false }));
      await sleep(500);
      const fixture = await browser.newPage();
      await fixture.goto(pageUrl, { waitUntil: "load" });
      const sent = await worker.evaluate(async (href) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === href);
        if (!tab) return { error: "fixture tab not found" };
        const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
        try {
          onMenuClicked({ menuItemId: "openChatGPT", selectionText: "Some text worth asking about.", pageUrl: href, frameId: 0, editable: false }, tab);
        } catch (e) { return { error: `threw: ${e && e.message}` }; }
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const made = (await chrome.tabs.query({})).filter((t) => !before.has(t.id));
          const hit = made.find((t) => /^https:\/\/chatgpt\.com\//.test(t.pendingUrl || t.url || ""));
          if (hit) return { url: hit.pendingUrl || hit.url };
        }
        return { error: "no chatgpt.com tab opened within 10 s" };
      }, pageUrl);
      check("a right-click send to ChatGPT opens a chatgpt.com tab", sent.url, sent.error);
    }
    await sleep(500);
    check("no uncaught worker error", !errors.length, errors.join(" | "));
  } finally {
    await browser.close().catch(() => {});
    page.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return report(checks);
}

function report(checks) {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${!c.ok && c.detail ? `\n      ${c.detail}` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
