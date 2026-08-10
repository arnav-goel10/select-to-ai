const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../../extension/security.js");
const config = require("../../extension/config.js");

test("allows only known provider origins", () => {
  assert.equal(
    security.validateProviderUrl("https://api.openai.com/v1/models").ok,
    true,
  );
  assert.equal(
    security.validateProviderUrl("https://api.openai.com.evil.example/steal").ok,
    false,
  );
  assert.equal(
    security.validateProviderUrl("https://attacker.example/collect").ok,
    false,
  );
});

test("custom gateways are origin-bound", () => {
  assert.equal(
    security.validateProviderUrl(
      "http://localhost:11434/v1/chat/completions",
      "http://localhost:11434/v1",
    ).ok,
    true,
  );
  assert.equal(
    security.validateProviderUrl(
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://localhost:11434/v1",
    ).ok,
    false,
  );
  assert.equal(
    security.validateProviderUrl(
      "http://gateway.example/v1/chat/completions",
      "http://gateway.example/v1",
    ).ok,
    false,
  );
  assert.equal(
    security.validateProviderUrl(
      "https://gateway.example/v1/chat/completions",
      "https://gateway.example/v1",
    ).ok,
    true,
  );
});

test("rejects unsafe schemes, credentials, methods, and oversized bodies", () => {
  assert.equal(security.validateProviderUrl("file:///etc/passwd").ok, false);
  assert.equal(
    security.validateProviderUrl("https://token@api.openai.com/v1/models").ok,
    false,
  );
  assert.equal(security.validateProxyOptions({ method: "DELETE" }).ok, false);
  assert.equal(
    security.validateProxyOptions({
      method: "POST",
      body: "x".repeat(security.MAX_PROXY_BODY_BYTES + 1),
    }).ok,
    false,
  );
});

test("normalizes safe requests and strips ambient credentials", () => {
  const result = security.validateProxyOptions({
    method: "post",
    headers: { Authorization: "Bearer test" },
    body: "{}",
    credentials: "include",
  });
  assert.equal(result.ok, true);
  assert.equal(result.options.method, "POST");
  assert.equal(result.options.credentials, "omit");
  assert.equal(result.options.cache, "no-store");
});

test("validates extension senders", () => {
  const runtimeId = "abcdefghijklmnop";
  assert.equal(
    security.isTrustedExtensionSender(
      {
        id: runtimeId,
        url: `chrome-extension://${runtimeId}/agent.html`,
      },
      runtimeId,
    ),
    true,
  );
  assert.equal(
    security.isTrustedExtensionSender(
      { id: runtimeId, url: "https://attacker.example" },
      runtimeId,
    ),
    false,
  );
});

test("domain allowlists match exact hosts and subdomains", () => {
  assert.equal(
    security.isUrlAllowedByDomains("https://docs.example.com/a", "example.com"),
    true,
  );
  assert.equal(
    security.isUrlAllowedByDomains("https://example.com.evil.test", "example.com"),
    false,
  );
  assert.equal(security.isUrlAllowedByDomains("chrome://settings", "example.com"), false);
});

test("API keys are isolated from synced settings", () => {
  assert.ok(config.STORAGE.API_KEYS.length >= 10);
  for (const key of config.STORAGE.API_KEYS) {
    assert.equal(config.STORAGE.SETTINGS.includes(key), false);
  }
});
