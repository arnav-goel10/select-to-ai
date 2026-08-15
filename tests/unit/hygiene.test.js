const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const projectRoot = path.resolve(__dirname, "../..");
const extensionRoot = path.join(projectRoot, "extension");

const read = (relative) =>
  fs.readFileSync(path.join(projectRoot, relative), "utf8");

test("package.json version matches the manifest version", () => {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("extension/manifest.json"));
  assert.equal(pkg.version, manifest.version);
});

test("dead settings keys are gone from the storage schema", () => {
  const config = require("../../extension/config.js");
  for (const deadKey of [
    "perServiceAutoSend",
    "contextTemplate",
    "agentRoutingStrategy",
  ]) {
    assert.ok(
      !config.STORAGE.SETTINGS.includes(deadKey),
      `dead settings key "${deadKey}" still in STORAGE.SETTINGS`,
    );
  }
  // ... and nothing in the extension reads or writes them anymore.
  const sources = fs
    .readdirSync(extensionRoot)
    .filter((name) => name.endsWith(".js"));
  for (const name of sources) {
    const text = fs.readFileSync(path.join(extensionRoot, name), "utf8");
    for (const deadKey of [
      "perServiceAutoSend",
      "contextTemplate",
      "agentRoutingStrategy",
    ]) {
      assert.ok(
        !text.includes(deadKey),
        `dead settings key "${deadKey}" still referenced in extension/${name}`,
      );
    }
  }
});

test("the openWebUi remnant is fully removed", () => {
  // Scan code only — agent.html carries harmless CSS comments that mention
  // OpenWebUI as a styling reference.
  const sources = fs
    .readdirSync(extensionRoot)
    .filter((name) => name.endsWith(".js"));
  for (const name of sources) {
    const text = fs
      .readFileSync(path.join(extensionRoot, name), "utf8")
      .toLowerCase();
    assert.ok(
      !text.includes("openwebui") && !text.includes("open_webui"),
      `openWebUi remnant still referenced in extension/${name}`,
    );
  }
  // The localhost content-script injection existed only for openWebUi.
  const manifest = JSON.parse(read("extension/manifest.json"));
  for (const script of manifest.content_scripts || []) {
    for (const match of script.matches) {
      assert.ok(
        !match.includes("localhost") && !match.includes("127.0.0.1"),
        `content script still injected on ${match}`,
      );
    }
  }
});

test("risk confirmation dialog escapes model text and avoids duplicate ids", () => {
  const agent = read("extension/agent.js");
  assert.ok(
    !agent.includes('id="confirmRiskBtn"'),
    "risk dialog still uses a duplicate #confirmRiskBtn id",
  );
  assert.match(
    agent,
    /escapeHtml\(String\(actionObj\.action/,
    "risk dialog does not escape the LLM-provided action",
  );
  assert.match(
    agent,
    /escapeHtml\(explanation\)/,
    "risk dialog does not escape the LLM-provided explanation",
  );
});

test("cost accounting reads both OpenAI and Anthropic usage shapes", () => {
  const agent = read("extension/agent.js");
  assert.match(agent, /usage\.prompt_tokens \?\? usage\.input_tokens/);
  assert.match(agent, /usage\.completion_tokens \?\? usage\.output_tokens/);
  assert.match(agent, /stream_options = \{ include_usage: true \}/);
});

test("privacy policy does not overclaim cross-session memory usage", () => {
  const policy = read("PRIVACY_POLICY.md");
  // The old claim asserted the history *is used* for cross-session context.
  assert.ok(
    !policy.includes("`chrome.storage.local` to provide cross-session context"),
    "privacy policy still claims history is used for cross-session context",
  );
  // The accurate statement: written locally, not read back yet.
  assert.match(policy, /not currently read back into new tasks/);
});

test("security doc states the full header-removal scope of rules.json", () => {
  const doc = read("docs/security.md");
  assert.ok(
    !doc.includes("framing-related response headers only"),
    "security doc still understates the rules.json header removals",
  );
  for (const header of [
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Embedder-Policy",
    "Permissions-Policy",
  ]) {
    assert.ok(
      doc.includes(header),
      `security doc does not mention removal of ${header}`,
    );
  }
});
