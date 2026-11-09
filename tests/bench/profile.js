/**
 * Running the benchmarks on the owner's own ChatGPT plan: a browser profile
 * he signed in to once (chatgpt-profile.js), copied for each shard.
 *
 * Nothing here reads a token. The sign-in lives in the extension's storage,
 * encrypted with a key that cannot be exported from the profile's
 * IndexedDB. What the harness moves between profiles is that encrypted
 * record, which no other browser can read.
 *
 * The extension's id: Chrome derives an unpacked extension's id from its
 * folder, unless the manifest has a "key", in which case the id comes from
 * the key. Storage and IndexedDB belong to the id, so every copy of the
 * extension loaded on the profile gets the profile's own "key" (kept in
 * select-to-ai-bench.json inside the profile), and with it the same id,
 * whatever folder it is copied to.
 *
 * Refresh tokens rotate: once spent, the old one is refused, and spending it
 * again may end the sign-in. Shards run on copies of the profile, so a token
 * one copy renews would be stale in the others. The latest encrypted record
 * is therefore kept beside the profile (select-to-ai-bench-credentials.json),
 * and before each run a shard, holding a lock, takes that record, renews the
 * access token if it would run out during the run, and puts the record back.
 * Renewal happens only there, so the same refresh token is never spent twice.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_PROFILE = path.join(os.homedir(), ".select-to-ai-bench", "chatgpt-profile");
const META_FILE = "select-to-ai-bench.json";
const CRED_FILE = "select-to-ai-bench-credentials.json";
const LOCK_DIR = "select-to-ai-bench.lock";
// A lock older than this was left by a process that died holding it.
const STALE_LOCK_MS = 120 * 1000;
const LOGIN_HINT = "Sign in first: npm run bench:chatgpt-login";

/**
 * The ChatGPT settings from the environment, or null when BENCH_PROFILE is
 * not set. Throws with a message for the owner when they do not fit.
 */
function profileEnv(env) {
  const raw = String(env.BENCH_PROFILE || "").trim();
  if (!raw) return null;
  if (env.BENCH_PROVIDER && env.BENCH_PROVIDER !== "chatgpt") throw new Error(`BENCH_PROFILE runs the agent on ChatGPT; BENCH_PROVIDER is "${env.BENCH_PROVIDER}". Leave BENCH_PROVIDER unset or set it to chatgpt.`);
  const model = String(env.BENCH_MODEL || "").trim();
  if (!model) throw new Error("With BENCH_PROFILE, set BENCH_MODEL to one of the account's model slugs (npm run bench:chatgpt-login lists them).");
  return { profile: path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir())), provider: "chatgpt", model, helperModel: String(env.BENCH_HELPER_MODEL || "").trim() };
}

/** The login script's profile folder: CHATGPT_PROFILE, or the default. */
function loginProfile(env) {
  const raw = String(env.CHATGPT_PROFILE || "").trim();
  return raw ? path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir())) : DEFAULT_PROFILE;
}

/** Chrome's extension id for a manifest "key" (base64 DER public key): the first 16 bytes of its SHA-256, as letters a to p. */
function extensionIdFromKey(key) {
  const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** A new manifest key. Only the public half is kept: Chrome needs nothing else to load an unpacked extension under it. */
function newExtensionKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function readMeta(profileDir) {
  const file = path.join(profileDir, META_FILE);
  if (!fs.existsSync(file)) return null;
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  return meta && meta.key ? meta : null;
}

/** The profile's record, made on first use: its manifest key, the extension id that follows from it, and the extension folder it was made with. */
function ensureMeta(profileDir, extensionSource) {
  fs.mkdirSync(profileDir, { recursive: true });
  const prior = readMeta(profileDir);
  if (prior) return prior;
  const key = newExtensionKey();
  const meta = { key, extensionId: extensionIdFromKey(key), extensionSource, createdAt: new Date().toISOString(), note: "The extension is loaded on this profile with this manifest key, so its id (and the sign-in stored under it) is the same whatever folder it is loaded from." };
  fs.writeFileSync(path.join(profileDir, META_FILE), JSON.stringify(meta, null, 2));
  return meta;
}

/** The manifest of a loaded copy: access to every site, and, on a profile, the profile's key. */
function patchManifest(manifest, meta) {
  const out = { ...manifest, host_permissions: [...new Set([...(manifest.host_permissions || []), "https://*/*", "http://*/*"])] };
  if (meta && meta.key) out.key = meta.key;
  return out;
}

/** Copies the extension to `dest` with its manifest patched. */
function copyExtension(src, dest, meta) {
  fs.cpSync(src, dest, { recursive: true });
  const manifestPath = path.join(dest, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(patchManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")), meta), null, 2));
  return dest;
}

// Left out of a copy: the running browser's locks, the harness's own lock,
// and caches Chrome rebuilds by itself. Matched by name at any depth.
const SKIP_NAMES = new Set([
  "SingletonLock", "SingletonSocket", "SingletonCookie", "RunningChromeVersion", LOCK_DIR,
  "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "GraphiteDawnCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "Crashpad", "component_crx_cache", "extensions_crx_cache", "Safe Browsing", "optimization_guide_model_store", "BrowserMetrics",
]);

/** Whether a profile entry, by its name, goes into a shard's copy. */
const copyable = (name) => !SKIP_NAMES.has(name) && !/^BrowserMetrics-.*\.pma$/.test(name);

/** A copy of the profile in a temp folder of its own, for one shard. Symbolic links are left out: Chrome's are its lock. */
function copyProfile(src, tmpRoot) {
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`BENCH_PROFILE ${src} is not a folder. ${LOGIN_HINT}`);
  if (!readMeta(src)) throw new Error(`${src} was not made by chatgpt-profile.js (no ${META_FILE}). ${LOGIN_HINT}`);
  const dest = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), "select-to-ai-profile-"));
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      if (from === src) return true;
      if (!copyable(path.basename(from))) return false;
      try { return !fs.lstatSync(from).isSymbolicLink(); } catch (_e) { return false; }
    },
  });
  return dest;
}

/** Runs `fn` holding the profile's lock (a folder: mkdir is atomic). */
async function withLock(profileDir, fn, o) {
  const lock = path.join(profileDir, LOCK_DIR);
  const waitMs = (o && o.waitMs) || 5 * 60 * 1000;
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (_e) { continue; }
      if (age > STALE_LOCK_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - t0 > waitMs) throw new Error(`Waited ${Math.round(waitMs / 1000)}s for ${lock}; remove it if no benchmark is running.`);
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** The latest encrypted sign-in record kept beside the profile, or null. */
function readShared(profileDir) {
  const file = path.join(profileDir, CRED_FILE);
  if (!fs.existsSync(file)) return null;
  try { const s = JSON.parse(fs.readFileSync(file, "utf8")); return s && s.record && s.record.data ? s.record : null; } catch (_e) { return null; }
}

function writeShared(profileDir, record) {
  const file = path.join(profileDir, CRED_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), note: "Encrypted with a key that never leaves this profile's IndexedDB.", record }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ------------------------------------------------- inside the extension

/** The service worker, woken through an extension page if it is asleep. */
async function workerOf(browser, extensionId) {
  const find = (ms) => browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extensionId}/`), { timeout: ms }).catch(() => null);
  let target = await find(3000);
  if (!target) {
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "load" }).catch(() => {});
    await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ action: "ping" }, () => { void chrome.runtime.lastError; r(); }))).catch(() => {});
    target = await find(10000);
    await page.close().catch(() => {});
  }
  if (!target) throw new Error("The extension's service worker did not start.");
  return target.worker();
}

/** The public part of the account: email, whether plan use is on, and the model list. Never the tokens. */
function readAccount(context) {
  return context.evaluate(() => new Promise((resolve) => chrome.storage.local.get("chatgptAccount", (r) => {
    const a = (r && r.chatgptAccount) || null;
    resolve(a ? { email: a.email || "", signedIn: !!a.signedIn, planEnabled: !!a.planEnabled, models: (a.models || []).map((m) => ({ slug: m.slug, name: m.name })) } : null);
  })));
}

/**
 * Runs in the service worker. Adopts `shared` (an encrypted record) if this
 * profile can read it, renews the access token if it has less than `needMs`
 * left (and `renew` is set), and hands back the encrypted record now kept.
 * Only the expiry and yes/no facts leave the worker, never a token.
 */
async function credentialStepInWorker(shared, needMs, renew) {
  const KEY = "chatgptCredentials";
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("select-to-ai", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const key = await new Promise((resolve) => { const r = db.transaction("keys").objectStore("keys").get("chatgpt"); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); });
  const bytes = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  const facts = async (rec) => {
    if (!key || !rec || !rec.data) return null;
    try {
      const c = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(rec.iv) }, key, bytes(rec.data))));
      return { expiresAt: Number(c.expires_at) || 0, live: !!c.access_token, renewable: !!c.refresh_token };
    } catch (_e) { return null; }
  };
  const stored = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
  let adopted = false;
  if (shared && (await facts(shared))) { await chrome.storage.local.set({ [KEY]: shared }); adopted = true; }
  let info = await facts(await stored());
  if (!info || !info.live) return { ok: false, adopted, why: "This profile has no ChatGPT sign-in that can be read." };
  let renewed = false;
  if (renew && info.expiresAt - Date.now() < needMs) {
    if (!info.renewable) return { ok: false, adopted, why: "The ChatGPT sign-in cannot be renewed." };
    try { await globalThis.SELECT_TO_AI_CHATGPT_CONNECT.accessToken(true); renewed = true; } catch (e) { return { ok: false, adopted, why: (e && e.message) || String(e) }; }
    info = await facts(await stored());
    if (!info || !info.live) return { ok: false, adopted, why: "The renewed sign-in could not be read back." };
  }
  return { ok: true, adopted, renewed, expiresAt: info.expiresAt, record: await stored() };
}

/**
 * Brings this browser's sign-in up to date with the shared record, renewing
 * it under the lock when it has less than `needMs` left, and saves the result
 * as the new shared record. {ok, why, renewed, expiresAt}.
 */
async function syncCredentials(browser, extensionId, profileDir, needMs, o) {
  const renew = !(o && o.renew === false);
  return withLock(profileDir, async () => {
    const worker = await workerOf(browser, extensionId);
    const step = await worker.evaluate(credentialStepInWorker, readShared(profileDir), needMs, renew);
    if (step.ok && step.record) writeShared(profileDir, step.record);
    return { ok: step.ok, why: step.why || "", renewed: !!step.renewed, adopted: !!step.adopted, expiresAt: step.expiresAt || 0 };
  });
}

/**
 * The checks before a shard's first run: the extension has the profile's id,
 * the account is signed in with plan use on, and the models asked for are
 * listed. Throws a message for the owner otherwise.
 */
async function checkAccount(browser, extensionId, meta, cfg) {
  if (extensionId !== meta.extensionId) throw new Error(`The extension loaded as ${extensionId}, not ${meta.extensionId} as on the profile; its sign-in would not be found. ${LOGIN_HINT}`);
  const account = await readAccount(await workerOf(browser, extensionId));
  if (!account || !account.signedIn) throw new Error(`No ChatGPT account is connected on ${cfg.profile}. ${LOGIN_HINT}`);
  if (!account.planEnabled) throw new Error(`${account.email || "The account"} is signed in on ${cfg.profile} but ChatGPT plan use is off. ${LOGIN_HINT}, and allow plan use.`);
  const slugs = account.models.map((m) => m.slug);
  for (const m of [cfg.model, cfg.helperModel].filter(Boolean)) {
    if (!slugs.includes(m)) throw new Error(`"${m}" is not among ${account.email || "the account"}'s models: ${slugs.join(", ") || "none listed"}.`);
  }
  return account;
}

/** Whether a run ended because the plan's usage ran out (as run.js and miniwob.js name it). */
const isPlanLimit = (ending) => /^provider limit$/.test(String(ending || ""));

module.exports = {
  DEFAULT_PROFILE, META_FILE, CRED_FILE, LOCK_DIR, LOGIN_HINT,
  profileEnv, loginProfile, extensionIdFromKey, newExtensionKey, readMeta, ensureMeta, patchManifest, copyExtension,
  copyable, copyProfile, withLock, readShared, writeShared,
  workerOf, readAccount, credentialStepInWorker, syncCredentials, checkAccount, isPlanLimit,
};
