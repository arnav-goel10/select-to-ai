"use strict";
// Running the benchmarks on a ChatGPT profile (tests/bench/profile.js): the
// environment, the extension's id, and the per-shard copy of the profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const P = require("../bench/profile.js");
const { timeoutMs } = require("../bench/chatgpt-profile.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-profile-test-"));

test("without BENCH_PROFILE nothing changes", () => {
  assert.equal(P.profileEnv({}), null);
  assert.equal(P.profileEnv({ BENCH_PROFILE: "  ", BENCH_PROVIDER: "mistral" }), null);
});

test("BENCH_PROFILE runs on ChatGPT with the model slugs given", () => {
  const cfg = P.profileEnv({ BENCH_PROFILE: "/tmp/p", BENCH_MODEL: "gpt-x", BENCH_HELPER_MODEL: "gpt-y" });
  assert.deepEqual(cfg, { profile: path.resolve("/tmp/p"), provider: "chatgpt", model: "gpt-x", helperModel: "gpt-y" });
  assert.equal(P.profileEnv({ BENCH_PROFILE: "/tmp/p", BENCH_MODEL: "gpt-x", BENCH_PROVIDER: "chatgpt" }).helperModel, "");
  assert.equal(P.profileEnv({ BENCH_PROFILE: "~/p", BENCH_MODEL: "m" }).profile, path.join(os.homedir(), "p"));
});

test("BENCH_PROFILE needs a model and refuses another provider", () => {
  assert.throws(() => P.profileEnv({ BENCH_PROFILE: "/tmp/p" }), /BENCH_MODEL/);
  assert.throws(() => P.profileEnv({ BENCH_PROFILE: "/tmp/p", BENCH_MODEL: "m", BENCH_PROVIDER: "openrouter" }), /BENCH_PROVIDER/);
});

test("the login profile defaults under the home folder and CHATGPT_PROFILE overrides it", () => {
  assert.equal(P.loginProfile({}), path.join(os.homedir(), ".select-to-ai-bench", "chatgpt-profile"));
  assert.equal(P.loginProfile({ CHATGPT_PROFILE: "/x/y" }), path.resolve("/x/y"));
});

test("the extension id follows from the manifest key as Chrome derives it", () => {
  const key = P.newExtensionKey();
  const id = P.extensionIdFromKey(key);
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(P.extensionIdFromKey(key), id, "the same key gives the same id");
  assert.notEqual(P.extensionIdFromKey(P.newExtensionKey()), id);
  // The key is a public key Chrome can parse.
  assert.equal(crypto.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).asymmetricKeyType, "rsa");
});

test("a profile keeps one key, so every copy of the extension gets the same id", () => {
  const dir = tmp();
  try {
    const a = P.ensureMeta(path.join(dir, "p"), "/src/extension");
    const b = P.ensureMeta(path.join(dir, "p"), "/elsewhere");
    assert.equal(b.key, a.key);
    assert.equal(b.extensionSource, "/src/extension", "the folder it was made with is recorded");
    assert.equal(a.extensionId, P.extensionIdFromKey(a.key));
    const patched = P.patchManifest({ name: "x", host_permissions: ["https://a.example/*"] }, a);
    assert.equal(patched.key, a.key);
    assert.deepEqual(patched.host_permissions, ["https://a.example/*", "https://*/*", "http://*/*"]);
    assert.equal(P.patchManifest({ name: "x" }, null).key, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a shard's copy of the profile leaves out locks and caches and keeps the storage", () => {
  const dir = tmp();
  try {
    const src = path.join(dir, "profile");
    P.ensureMeta(src, "/src");
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); };
    write("Default/Local Extension Settings/abc/000003.log", "storage");
    write("Default/IndexedDB/chrome-extension_abc_0.indexeddb.leveldb/CURRENT", "keys");
    write("Default/Cache/Cache_Data/data_0", "cache");
    write("Default/Code Cache/js/x", "cache");
    write("Local State", "{}");
    fs.mkdirSync(path.join(src, P.LOCK_DIR));
    fs.symlinkSync("host-1234", path.join(src, "SingletonLock"));
    const copy = P.copyProfile(src, dir);
    assert.notEqual(copy, src);
    assert.ok(fs.existsSync(path.join(copy, "Default/Local Extension Settings/abc/000003.log")));
    assert.ok(fs.existsSync(path.join(copy, "Default/IndexedDB/chrome-extension_abc_0.indexeddb.leveldb/CURRENT")));
    assert.ok(fs.existsSync(path.join(copy, "Local State")));
    assert.ok(fs.existsSync(path.join(copy, P.META_FILE)));
    assert.ok(!fs.existsSync(path.join(copy, "Default/Cache")));
    assert.ok(!fs.existsSync(path.join(copy, "Default/Code Cache")));
    assert.ok(!fs.existsSync(path.join(copy, P.LOCK_DIR)));
    assert.throws(() => fs.lstatSync(path.join(copy, "SingletonLock")), /ENOENT/);
    assert.notEqual(P.copyProfile(src, dir), copy, "each shard gets a folder of its own");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a folder the login script did not make is refused with the way to make one", () => {
  const dir = tmp();
  try {
    assert.throws(() => P.copyProfile(path.join(dir, "missing")), /bench:chatgpt-login/);
    assert.throws(() => P.copyProfile(dir), /bench:chatgpt-login/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the lock lets one holder in at a time and clears a stale one", async () => {
  const dir = tmp();
  try {
    const order = [];
    const hold = (name) => P.withLock(dir, async () => { order.push(`${name}+`); await new Promise((r) => setTimeout(r, 30)); order.push(`${name}-`); });
    await Promise.all([hold("a"), hold("b")]);
    assert.ok(/^(a\+,a-,b\+,b-|b\+,b-,a\+,a-)$/.test(order.join(",")), order.join(","));
    assert.ok(!fs.existsSync(path.join(dir, P.LOCK_DIR)));
    fs.mkdirSync(path.join(dir, P.LOCK_DIR));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(path.join(dir, P.LOCK_DIR), old, old);
    assert.equal(await P.withLock(dir, async () => "got it"), "got it");
    fs.mkdirSync(path.join(dir, P.LOCK_DIR));
    await assert.rejects(P.withLock(dir, async () => 1, { waitMs: 300 }), /Waited/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the shared sign-in record is kept beside the profile and read back", () => {
  const dir = tmp();
  try {
    assert.equal(P.readShared(dir), null);
    P.writeShared(dir, { iv: "aXY=", data: "ZGF0YQ==" });
    assert.deepEqual(P.readShared(dir), { iv: "aXY=", data: "ZGF0YQ==" });
    fs.writeFileSync(path.join(dir, P.CRED_FILE), "not json");
    assert.equal(P.readShared(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only a used-up plan stops the shard; a paused one does not", () => {
  assert.equal(P.isPlanLimit("provider limit"), true);
  assert.equal(P.isPlanLimit("provider limit (paused, still waiting at the timeout)"), false);
  assert.equal(P.isPlanLimit("finished"), false);
  // judge.js counts it as lost, not failed.
  const { isInfra } = require("../bench/judge.js");
  assert.equal(isInfra({ ending: "provider limit" }), true);
});

test("the login script's --timeout is read in seconds", () => {
  assert.equal(timeoutMs(["--timeout", "5"]), 5000);
  assert.equal(timeoutMs([]), 15 * 60 * 1000);
  assert.equal(timeoutMs(["--timeout", "x"]), 15 * 60 * 1000);
});
