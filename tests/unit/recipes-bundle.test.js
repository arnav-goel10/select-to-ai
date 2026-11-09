"use strict";
// The recipes core as the extension loads it (extension/recipes/vendor):
// generated from packages/recipes and in step with it, the same exports,
// no remote code, and loaded by the service worker before the engine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const VENDOR = path.join(ROOT, "extension/recipes/vendor");

test("the vendored recipes core and page script are what the build makes from packages/recipes", async () => {
  const { outputs } = await import(pathToFileURL(path.join(ROOT, "scripts/build-recipes.mjs")).href);
  for (const [file, text] of Object.entries(outputs())) {
    assert.equal(fs.readFileSync(path.join(VENDOR, file), "utf8"), text, `${file} is out of date: run node scripts/build-recipes.mjs`);
  }
});

test("the bundle exports what the package's modules export", async () => {
  const bundle = require(path.join(VENDOR, "recipes-core.js"));
  const core = path.join(ROOT, "packages/recipes/core");
  for (const f of fs.readdirSync(core)) {
    const mod = await import(pathToFileURL(path.join(core, f)).href);
    for (const k of Object.keys(mod)) assert.equal(typeof bundle[k], typeof mod[k], `${f}: ${k}`);
  }
  assert.equal(bundle.SCHEMA, "select-to-ai.recipe/1");
  assert.deepEqual(bundle.THRESHOLDS, (await import(pathToFileURL(path.join(core, "fingerprint.js")).href)).THRESHOLDS);
});

test("the bundle loads no code from anywhere and reaches nothing outside itself", () => {
  const text = fs.readFileSync(path.join(VENDOR, "recipes-core.js"), "utf8") + fs.readFileSync(path.join(VENDOR, "page.js"), "utf8");
  assert.doesNotMatch(text, /\bimport\s*\(|\bimportScripts\b|\beval\s*\(|new Function|https?:\/\/(?!x\b)[a-z]/i);
  assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|chrome\./);
});

test("the service worker loads the recipes scripts before the engine, and every one exists", () => {
  const bg = fs.readFileSync(path.join(ROOT, "extension/background.js"), "utf8");
  const files = ["recipes/vendor/recipes-core.js", "recipes/driver.js", "recipes/service.js"];
  const engineAt = bg.indexOf("'engine.js'");
  for (const f of files) {
    const at = bg.indexOf(`'${f}'`);
    assert.ok(at > 0 && at < engineAt, `${f} is loaded before engine.js`);
    assert.ok(fs.existsSync(path.join(ROOT, "extension", f)), f);
  }
});
