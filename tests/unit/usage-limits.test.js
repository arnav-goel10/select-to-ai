const test = require("node:test");
const assert = require("node:assert/strict");
const { describeLimit } = require("../../extension/usageLimits.js");

// OpenRouter's real reply when a key's free-model daily limit is spent (Sep 2026).
const NOW = Date.UTC(2026, 8, 29, 18, 55);
const RESET = Date.UTC(2026, 8, 30, 0, 0);
const body = (limit, source = "free-models-per-day-high-balance") => JSON.stringify({
  error: {
    message: `Rate limit exceeded: ${source}. `, code: 429,
    metadata: { headers: { "X-RateLimit-Limit": String(limit), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(RESET) }, limit_source: "openrouter_free_tier_daily" },
  },
});

test("OpenRouter free daily limit: says it is used up, the real limit, and when it comes back", () => {
  const r = describeLimit({ provider: "openrouter", model: "openrouter/free", status: 429, body: body(1000), headers: {}, now: NOW });
  assert.equal(r.kind, "free-daily");
  assert.match(r.message, /free OpenRouter requests are used up/);
  assert.match(r.message, /1,000 free requests a day/);
  assert.match(r.message, /in about 5 hours/);
  assert.match(r.message, /paid model in Settings/);
  assert.doesNotMatch(r.message, /\$10/, "a key already on the 1,000 tier is not told to buy its way there");
  assert.match(r.short, /come back at .+ \(in about 5 hours\)/);
});

test("low-tier key is told how the free limit is raised", () => {
  const r = describeLimit({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", status: 429, body: body(50, "free-models-per-day"), now: NOW });
  assert.match(r.message, /50 free requests a day/);
  assert.match(r.message, /\$10 of credit/);
});

test("limit and reset also read from real response headers", () => {
  const r = describeLimit({
    provider: "openrouter", model: "openrouter/free", status: 429,
    body: JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day" } }),
    headers: { "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET) }, now: NOW,
  });
  assert.equal(r.limit, 1000);
  assert.equal(r.resetAt, RESET);
});

test("a short per-minute 429 is not a usage limit, so ordinary retries still run", () => {
  const r = describeLimit({
    provider: "openrouter", model: "openrouter/free", status: 429,
    body: JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-min." } }),
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 40000) }, now: NOW,
  });
  assert.equal(r, null);
  assert.equal(describeLimit({ provider: "openai", status: 429, body: '{"error":{"message":"Rate limit reached for requests"}}', now: NOW }), null);
  assert.equal(describeLimit({ provider: "openai", status: 500, body: "oops", now: NOW }), null);
});

test("out of credit and other providers' quotas", () => {
  const credit = describeLimit({ provider: "openrouter", model: "anthropic/claude-sonnet-5", status: 402, body: '{"error":{"message":"Insufficient credits"}}', now: NOW });
  assert.equal(credit.kind, "no-credit");
  assert.match(credit.message, /out of credit/);
  const openai = describeLimit({ provider: "openai", model: "gpt-5", status: 429, body: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}', now: NOW });
  assert.ok(openai);
  assert.match(openai.message, /OpenAI/);
});

// Backup provider: the agent page names the backup only while it stands in.
const fs = require("node:fs");
const path = require("node:path");
const agent = fs.readFileSync(path.join(__dirname, "../../extension/agent.js"), "utf8");
const defaults = require("../../extension/defaults.js");

test("the agent page names a backup only when the user chose one and it has a key", () => {
  const usable = agent.slice(agent.indexOf("function usableBackup"), agent.indexOf("function applyProviderPause"));
  assert.match(usable, /config\.agentBackupProvider/, "only the provider picked in Settings");
  assert.match(usable, /hasProviderCredentials\(to\)/, "and only with a key saved");
  const pause = agent.slice(agent.indexOf("function applyProviderPause"), agent.indexOf("/** A one-line note"));
  assert.match(pause, /pause\.until > Date\.now\(\)/, "a pause that has run out is not shown");
});

test("free backups are real providers with endpoints and default models", () => {
  assert.deepEqual(defaults.FREE_BACKUPS.map((b) => b.provider), ["gemini", "cerebras", "groq"]);
  for (const b of defaults.FREE_BACKUPS) {
    assert.ok(defaults.PROVIDER_ENDPOINTS[b.provider], b.provider);
    assert.ok(defaults.PROVIDER_FALLBACK_MODELS[b.provider].lite, b.provider);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../extension/manifest.json"), "utf8"));
  // Provider hosts are optional in 4.0 and asked for in the click that needs them.
  assert.ok(!manifest.host_permissions.includes("https://api.cerebras.ai/*"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"), "api.cerebras.ai can be granted");
});

test("new key formats are accepted and never stored as memories", () => {
  const agent = fs.readFileSync(path.join(__dirname, "../../extension/agent.js"), "utf8");
  // Google AI Studio issues "AQ." keys as well as "AIza" ones (Oct 2026).
  assert.match(agent, /provider === "gemini" && !\/\^\(AIza\|AQ\\\.\)\/\.test\(key\)/);
  // The welcome page reads the provider off the key with setup.js.
  const SETUP = require("../../extension/setup.js");
  assert.equal(SETUP.routeKey("AQ.Zz0Example-KeyForTests").provider, "gemini");
  assert.equal(SETUP.routeKey("AIzaExampleKeyForTests").provider, "gemini");
  assert.equal(SETUP.routeKey("mstrl_ExampleKeyForTests0000").provider, "mistral");
  const KNOWN = require("../../extension/core/memory.js");
  for (const secret of ["my key is AQ.Zz0Example-KeyForTests-0000000000-abcd", "csk-0000example0000test0000", "mstrl_ExampleKeyForTests0000", "nvapi-ExampleKeyForTests-00000"]) {
    assert.equal(KNOWN.isStorable(secret), false, secret.slice(0, 12));
  }
  assert.equal(KNOWN.isStorable("I shop in SGD"), true);
});
