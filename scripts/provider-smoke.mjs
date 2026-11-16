#!/usr/bin/env node
// One live call per default model id in extension/defaults.js, so a model a
// provider has retired is found before a store upload and not by users.
//
// Keys come from the environment only (in CI, from repo secrets, see the
// provider-smoke job in .github/workflows/ci.yml). Nothing here prints a
// key or any part of one. A provider without a key is listed as skipped.
//
//   node scripts/provider-smoke.mjs           live calls for every key present
//   node scripts/provider-smoke.mjs --dry     list the calls, make none
//
// What is called, per provider with a key: the lite and pro fallback models,
// the free backup model, and the agent's default model. On OpenRouter also
// each id in OPENROUTER_FREE_CHAIN on its own (so a retired one is named),
// and the chain sent the way the extension sends it.
//
// Exit code 1 when any call fails, or when no key was given at all.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../extension/defaults.js");

const KEY_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  xai: "XAI_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

const dry = process.argv.includes("--dry");
const TIMEOUT_MS = 60000;

/** Every call to make, as {provider, model, label, extra}. */
function plan() {
  const calls = [];
  const seen = new Set();
  const add = (provider, model, label, extra) => {
    if (!model) return;
    const key = `${provider}|${model}|${extra ? JSON.stringify(extra) : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ provider, model, label, extra: extra || null });
  };
  for (const provider of Object.keys(D.PROVIDER_ENDPOINTS)) {
    const m = D.PROVIDER_FALLBACK_MODELS[provider] || {};
    add(provider, m.lite, "lite default");
    add(provider, m.pro, "pro default");
    const backup = D.FREE_BACKUPS.find((b) => b.provider === provider);
    if (backup) add(provider, backup.model, "free backup");
    if (provider === D.AGENT_DEFAULTS.activeProvider) add(provider, D.AGENT_DEFAULTS.model, "agent default");
  }
  for (const id of D.OPENROUTER_FREE_CHAIN) {
    if (id !== "openrouter/free") add("openrouter", id, "free chain member");
  }
  // The request exactly as llm.js sends the default free path.
  add("openrouter", "openrouter/free", "free chain as sent", D.openRouterOptions("openrouter/free", false));
  return calls;
}

function request(provider, model, key, extra) {
  const base = D.PROVIDER_ENDPOINTS[provider].baseUrl;
  const messages = [{ role: "user", content: "Reply with the word ok." }];
  if (provider === "anthropic") {
    return {
      url: base,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: { model, max_tokens: 16, messages },
    };
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
  if (provider === "openrouter") Object.assign(headers, D.OPENROUTER_ATTRIBUTION);
  return {
    url: `${base.replace(/\/$/, "")}/chat/completions`,
    headers,
    // Thinking models need room before they say anything.
    body: { model, max_tokens: 64, messages, ...(extra || {}) },
  };
}

/** The provider's own words, cut short, with anything key-shaped removed. */
function said(text, key) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  try {
    const j = JSON.parse(t);
    const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
    if (e) t = typeof e === "object" ? String(e.message || JSON.stringify(e)) : String(e);
  } catch (_e) { /* plain text */ }
  if (key) t = t.split(key).join("[key]");
  t = t.replace(/\b(sk|gsk|csk|xai|AIza)[-_A-Za-z0-9]{8,}/g, "[key]");
  return t.length > 160 ? `${t.slice(0, 159)}...` : t;
}

async function one(c, key) {
  const { url, headers, body } = request(c.provider, c.model, key, c.extra);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    const ms = Date.now() - started;
    let served = "";
    try { served = JSON.parse(text).model || ""; } catch (_e) { /* not JSON */ }
    if (res.ok) return { ok: true, status: res.status, ms, note: served && served !== c.model ? `served by ${served}` : "" };
    // A model that is busy or out of its free allowance exists: the id resolved.
    if (res.status === 429) return { ok: true, status: 429, ms, note: `rate limited, id resolved: ${said(text, key)}` };
    return { ok: false, status: res.status, ms, note: said(text, key) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, note: said((e && e.message) || e, key) };
  }
}

async function main() {
  const calls = plan();
  const rows = [];
  let made = 0;
  for (const c of calls) {
    const env = KEY_ENV[c.provider];
    const key = env ? String(process.env[env] || "").trim() : "";
    if (dry) { rows.push({ ...c, result: "planned", status: "", note: env ? `key from ${env}` : "no key variable" }); continue; }
    if (!key) { rows.push({ ...c, result: "skipped", status: "", note: `${env} not set` }); continue; }
    made += 1;
    const r = await one(c, key);
    rows.push({ ...c, result: r.ok ? "ok" : "FAIL", status: r.status, note: `${r.ms} ms${r.note ? `, ${r.note}` : ""}` });
  }
  for (const r of rows) {
    console.log(`${r.result.padEnd(8)} ${String(r.status).padEnd(4)} ${r.provider.padEnd(11)} ${r.model.padEnd(44)} ${r.label}${r.extra ? " (models list)" : ""}  ${r.note}`);
  }
  const failed = rows.filter((r) => r.result === "FAIL");
  const skipped = rows.filter((r) => r.result === "skipped");
  console.log(`\n${calls.length} calls planned, ${made} made, ${failed.length} failed, ${skipped.length} skipped for a missing key.`);
  if (dry) return;
  if (!made) { console.log("No provider key was set, so nothing was checked."); process.exitCode = 1; return; }
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(said((e && e.message) || e)); process.exitCode = 1; });
