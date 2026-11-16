/**
 * Permission warning diff (plan: permission-warning-diff).
 *
 *   node tests/contract/permission-warning-diff.js [extensionDir]
 *
 * Chrome disables an updated extension until the user accepts any permission
 * warning the old version did not show. This asks Chrome itself, through
 * chrome.management.getPermissionWarningsByManifest in a test-only helper
 * extension (tests/helpers/warning-probe-extension), for the warnings of
 * the 2.0 manifest the store users have (tests/fixtures/v2.0/manifest.json,
 * from commit 2f1afab of the original repository) and of the manifest under
 * test, and fails on any warning string the 2.0 manifest does not produce.
 *
 * The manifest under test is extensionDir/manifest.json (default: the
 * unzipped package in PACKAGE_DIR, else extension/). Runs in Chromium, on CI.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const PROBE = path.join(ROOT, "tests/helpers/warning-probe-extension");
const OLD = path.join(ROOT, "tests/fixtures/v2.0/manifest.json");
const dir = path.resolve(process.argv[2] || process.env.PACKAGE_DIR || path.join(ROOT, "extension"));
const NEW = path.join(dir, "manifest.json");

async function main() {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({
    headless: !process.env.E2E_HEADFUL,
    args: [`--disable-extensions-except=${PROBE}`, `--load-extension=${PROBE}`, "--no-first-run"],
  });
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 });
    const worker = await target.worker();
    const ask = (file) => worker.evaluate((text) => self.warningsFor(text), fs.readFileSync(file, "utf8"));
    const before = await ask(OLD);
    const after = await ask(NEW);
    console.log(`Chrome ${await browser.version()}`);
    console.log(`\n2.0 manifest (${path.relative(ROOT, OLD)}) warns:`);
    before.forEach((w) => console.log(`  - ${w}`));
    console.log(`\nmanifest under test (${path.relative(ROOT, NEW) || NEW}) warns:`);
    after.forEach((w) => console.log(`  - ${w}`));
    // The probe must see the 2.0 warnings (tabs and the three hosts), or an
    // empty answer would pass every manifest.
    if (!before.length) throw new Error("the probe returned no warnings for the 2.0 manifest, so it is not measuring anything");
    const added = after.filter((w) => !before.includes(w));
    console.log(`\nnew warnings a 2.0 user would have to accept: ${added.length}`);
    added.forEach((w) => console.log(`  + ${w}`));
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Permission warnings, 2.0 to this build\n\n${added.length ? added.map((w) => `- new: ${w}`).join("\n") : "No new warnings."}\n`);
    }
    return added.length ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
