"use strict";
// What an update does to stored settings (extension/background.js
// onInstalled). The previousVersion matrix: a 2.0 user gets the settings 2.0
// was showing written out, 3.x users are left alone, a fresh install writes
// nothing, and only an update from below 4.0.0 leaves the popup's one-time
// notice. No update opens a tab.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackground, settle } = require("../helpers/background-harness.js");

const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/v2.0/storage-seed.json"), "utf8"));

async function update(previousVersion, sync, extra = {}) {
  const bg = loadBackground({ sync, local: extra.local });
  await settle();
  const before = bg.calls.tabsCreate.length;
  bg.chrome.runtime.onInstalled.fire(previousVersion === null ? { reason: "install" } : { reason: "update", previousVersion });
  await settle(12);
  return { bg, sync: bg.chrome.storage.sync.data, local: bg.chrome.storage.local.data, tabs: bg.calls.tabsCreate.slice(before) };
}

test("2.0 seed: Perplexity on, page address off, popup window becomes the side panel, legacy keys gone", async () => {
  const { sync, local, tabs, bg } = await update("2.0", SEED.sync, { local: SEED.local });
  assert.equal(sync.showPerplexity, true);
  assert.equal(sync.autoContext, false);
  assert.equal(sync.openingMode, "sidePanel");
  assert.equal(sync.autoSend, true, "a setting the user chose is kept");
  for (const k of SEED.legacy) assert.ok(!(k in sync), `${k} removed`);
  for (const k of ["showChatGPT", "showGemini"]) assert.ok(!(k in sync), `${k} stays unset (read as on)`);
  assert.ok(local.upgradeNotice && local.upgradeNotice.from === "2.0", "notice for the popup");
  assert.equal(tabs.length, 0, "no tab opened on update");
  const titles = bg.currentMenu().map((m) => m.title);
  assert.deepEqual(titles, ["Select to AI", "Send to ChatGPT", "Send to Gemini", "Send to Perplexity"]);
});

test("2.0 with choices made keeps them: Perplexity off, auto-context on, new tab", async () => {
  const { sync } = await update("2.0", { showPerplexity: false, autoContext: true, openingMode: "tab", sidebarMode: false });
  assert.equal(sync.showPerplexity, false);
  assert.equal(sync.autoContext, true);
  assert.equal(sync.openingMode, "tab");
  assert.ok(!("sidebarMode" in sync));
});

test("2.0 with nothing stored at all still gets explicit values", async () => {
  const { sync } = await update("2.0", {});
  assert.deepEqual({ ...sync }, { showPerplexity: true, autoContext: false, openingMode: "sidePanel" });
});

test("3.3.1: settings are not rewritten, the notice is set", async () => {
  const { sync, local, tabs } = await update("3.3.1", { openingMode: "tab" });
  assert.deepEqual({ ...sync }, { openingMode: "tab" });
  assert.ok(local.upgradeNotice && local.upgradeNotice.from === "3.3.1");
  assert.equal(tabs.length, 0);
});

test("4.0.0 to a later 4.x: no notice", async () => {
  const { local } = await update("4.0.0", {});
  assert.ok(!("upgradeNotice" in local));
});

test("fresh install: nothing migrated, no notice, the welcome page opens", async () => {
  const { sync, local, tabs } = await update(null, {});
  assert.deepEqual({ ...sync }, {});
  assert.ok(!("upgradeNotice" in local));
  assert.equal(tabs.length, 1);
  assert.match(tabs[0].url, /welcome\.html$/);
});

test("auto-context is off by default for everyone, including a fresh install", async () => {
  const bg = loadBackground({ sync: {} });
  await settle();
  assert.equal(bg.run("cachedSettings.autoContext"), false);
  const options = fs.readFileSync(path.join(__dirname, "../../extension/options.js"), "utf8");
  assert.match(options, /autoContext: \(s\) => s\.autoContext === true/);
});

test("version helpers", () => {
  const bg = loadBackground({});
  const major = bg.run("majorVersion");
  const cmp = bg.run("compareVersions");
  assert.equal(major("2.0"), 2);
  assert.equal(major("3.3.1"), 3);
  assert.ok(Number.isNaN(major(undefined)));
  assert.equal(cmp("3.9.9", "4.0.0"), -1);
  assert.equal(cmp("4.0", "4.0.0"), 0);
  assert.equal(cmp("4.0.1", "4.0.0"), 1);
});
