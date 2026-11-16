"use strict";
// The "What is new in 4.0" note (plan item 3). The worker writes a notice on
// an update from before 4.0 and the popup shows it until "Got it". These
// tests run the real worker migration, hand the storage it wrote to the real
// popup script, and read what the popup shows. No tab is opened on update,
// so the toolbar icon carries "New" while the note is unread.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackground, settle } = require("../helpers/background-harness.js");
const { loadPage } = require("../helpers/page-harness.js");
const CONFIG = require("../../extension/config.js");

const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/v2.0/storage-seed.json"), "utf8"));

/** The worker after onInstalled, with whatever it wrote to storage. */
async function installed(details, seed = {}) {
  const bg = loadBackground({ sync: seed.sync, local: seed.local });
  await settle();
  bg.chrome.runtime.onInstalled.fire(details);
  await settle(12);
  return bg;
}

/** The popup, opened on the storage a worker left behind. */
async function popupOn(bg, extra = {}) {
  const page = loadPage({ html: "popup.html", sync: bg.chrome.storage.sync.data, local: bg.chrome.storage.local.data, ...extra });
  await settle(8);
  return page;
}

test("worker and popup name the notice by the same key, from config.js", () => {
  assert.equal(typeof CONFIG.STORAGE.UPGRADE_NOTICE, "string");
  const read = (f) => fs.readFileSync(path.join(__dirname, "../../extension", f), "utf8");
  for (const file of ["background.js", "popup.js"]) {
    assert.match(read(file), /STORAGE\.UPGRADE_NOTICE/, `${file} takes the key from config.js`);
    assert.ok(!/['"]whatsNew40['"]/.test(read(file)), `${file} has no key of its own`);
  }
});

test("a 2.0 user who updates sees the note in the popup, once", async () => {
  const bg = await installed({ reason: "update", previousVersion: "2.0" }, SEED);
  assert.equal(bg.calls.tabsCreate.length, 0, "the update opens no tab");
  const popup = await popupOn(bg);
  assert.deepEqual(popup.errors, []);
  assert.equal(popup.visible("whatsNew"), true, "the note is on show");

  popup.$("whatsNewClose").click();
  await settle(4);
  assert.equal(popup.visible("whatsNew"), false, "Got it puts it away");
  assert.ok(!(CONFIG.STORAGE.UPGRADE_NOTICE in popup.chrome.storage.local.data), "and removes the notice");

  const again = loadPage({ html: "popup.html", sync: popup.chrome.storage.sync.data, local: popup.chrome.storage.local.data });
  await settle(8);
  assert.equal(again.visible("whatsNew"), false, "the next popup does not show it again");
});

test("a 3.x user who updates sees the note too", async () => {
  const bg = await installed({ reason: "update", previousVersion: "3.3.1" });
  assert.equal((await popupOn(bg)).visible("whatsNew"), true);
});

test("no note on a fresh install or on an update within 4.x", async () => {
  for (const details of [{ reason: "install" }, { reason: "update", previousVersion: "4.0.0" }]) {
    const bg = await installed(details);
    assert.equal((await popupOn(bg)).visible("whatsNew"), false, JSON.stringify(details));
  }
});

test("the toolbar icon says New while the note is unread, and is cleared with it", async () => {
  const bg = await installed({ reason: "update", previousVersion: "2.0" }, SEED);
  assert.equal(bg.calls.badge.at(-1), "New");

  // The popup's "Got it" removes the notice; the worker hears of it.
  bg.chrome.storage.local.remove(CONFIG.STORAGE.UPGRADE_NOTICE);
  await settle(6);
  assert.equal(bg.calls.badge.at(-1), "");
});

test("a worker that starts with the note unread puts the badge back", async () => {
  const unread = loadBackground({ local: { [CONFIG.STORAGE.UPGRADE_NOTICE]: { from: "2.0", at: 1 } } });
  await settle();
  assert.deepEqual(unread.calls.badge, ["New"]);

  const read = loadBackground({});
  await settle();
  assert.deepEqual(read.calls.badge, [], "and sets none when there is nothing to read");
});
