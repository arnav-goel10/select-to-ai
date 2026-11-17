"use strict";
// "Send to Claude" is never dropped without a word (plan item 3).
//
// claude.ai was a host every install held up to 3.x and is asked for in 4.0.
// Whether Chrome carries the old grant over an update is not something the
// code can know in advance, so both states are covered: with the host held
// Claude is in the menu and nothing is offered, and without it the popup
// and Settings each offer one click that asks Chrome for claude.ai.
//
// 2.0 had no Claude item (tests/fixtures/v2.0/manifest.json lists ChatGPT,
// Gemini and Perplexity), so a 2.0 user loses nothing and is offered nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackground, settle } = require("../helpers/background-harness.js");
const { loadPage } = require("../helpers/page-harness.js");

const CLAUDE = "https://claude.ai/*";
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/v2.0/storage-seed.json"), "utf8"));

async function updated(previousVersion, sync, granted = []) {
  const bg = loadBackground({ sync, granted });
  await settle();
  bg.chrome.runtime.onInstalled.fire({ reason: "update", previousVersion });
  await settle(12);
  return bg;
}
const menu = (bg) => bg.currentMenu().map((m) => m.title);
async function page(html, bg, granted = [], extra = {}) {
  const p = loadPage({ html, sync: bg.chrome.storage.sync.data, local: bg.chrome.storage.local.data, granted, ...extra });
  await settle(10);
  return p;
}

test("3.x to 4.0 writes down that Claude was on, unless the user had turned it off", async () => {
  assert.equal((await updated("3.4.0", {})).chrome.storage.sync.data.showClaude, true);
  assert.equal((await updated("3.4.0", { showClaude: false })).chrome.storage.sync.data.showClaude, false);
  assert.ok(!("showClaude" in (await updated("4.0.0", {})).chrome.storage.sync.data), "nothing to record within 4.x");
});

test("2.0 had no Claude item: nothing is recorded and nothing is offered", async () => {
  const bg = await updated("2.0", SEED.sync);
  assert.ok(!("showClaude" in bg.chrome.storage.sync.data));
  assert.equal((await page("popup.html", bg)).visible("addClaudeBtn"), false);
  assert.equal((await page("options.html", bg)).visible("claudeBack"), false);
});

test("host kept over the update: Claude is in the menu and nothing is offered", async () => {
  const bg = await updated("3.4.0", {}, [CLAUDE]);
  assert.ok(menu(bg).includes("Send to Claude"));
  const popup = await page("popup.html", bg, [CLAUDE]);
  assert.equal(popup.visible("addClaudeBtn"), false);
  const options = await page("options.html", bg, [CLAUDE]);
  assert.deepEqual(options.errors, []);
  assert.equal(options.visible("claudeBack"), false);
  assert.equal(options.$("showClaude").checked, true);
});

test("host missing after the update: the popup offers Claude back, and one click asks Chrome for claude.ai", async () => {
  const bg = await updated("3.4.0", {});
  assert.ok(!menu(bg).includes("Send to Claude"), "the menu cannot show it without the host");
  const popup = await page("popup.html", bg);
  assert.deepEqual(popup.errors, []);
  assert.equal(popup.visible("addClaudeBtn"), true);

  popup.$("addClaudeBtn").click();
  assert.deepEqual(popup.calls.request, [{ origins: [CLAUDE] }], "asked for inside the click, and for claude.ai alone");
  await settle(6);
  assert.equal(popup.visible("addClaudeBtn"), false, "the row goes once the host is held");

  // The worker hears of the grant and puts the item back.
  bg.grant(CLAUDE);
  await settle(10);
  assert.ok(menu(bg).includes("Send to Claude"));
});

test("host missing and Chrome's prompt declined: the offer stays", async () => {
  const bg = await updated("3.4.0", {});
  const popup = await page("popup.html", bg, [], { grantOnRequest: false });
  popup.$("addClaudeBtn").click();
  await settle(6);
  assert.equal(popup.visible("addClaudeBtn"), true);
});

test("host missing after the update: Settings says so and adds Claude back in one click", async () => {
  const bg = await updated("3.4.0", {});
  const options = await page("options.html", bg);
  assert.deepEqual(options.errors, []);
  assert.equal(options.visible("claudeBack"), true);
  assert.equal(options.$("showClaude").checked, false, "the chip does not claim Claude is on");

  options.$("claudeBackAdd").click();
  assert.deepEqual(options.calls.request, [{ origins: [CLAUDE] }]);
  await settle(8);
  assert.equal(options.visible("claudeBack"), false);
  assert.equal(options.$("showClaude").checked, true);
  assert.equal(options.chrome.storage.sync.data.showClaude, true);
});

test("Settings: Leave it off turns Claude off for good, and the popup stops offering", async () => {
  const bg = await updated("3.4.0", {});
  const options = await page("options.html", bg);
  options.$("claudeBackOff").click();
  await settle(8);
  assert.equal(options.visible("claudeBack"), false);
  assert.equal(options.chrome.storage.sync.data.showClaude, false);
  assert.deepEqual(options.calls.request, [], "Chrome is asked for nothing");

  const popup = loadPage({ html: "popup.html", sync: options.chrome.storage.sync.data });
  await settle(10);
  assert.equal(popup.visible("addClaudeBtn"), false);
});

test("a grant made elsewhere while Settings is open clears the notice", async () => {
  const bg = await updated("3.4.0", {});
  const options = await page("options.html", bg);
  assert.equal(options.visible("claudeBack"), true);
  options.granted.add(CLAUDE);
  options.chrome.permissions.onAdded.fire({ origins: [CLAUDE] });
  await settle(6);
  assert.equal(options.visible("claudeBack"), false);
});
