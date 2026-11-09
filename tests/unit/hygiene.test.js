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
  // Scan code only, agent.html carries harmless CSS comments that mention
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

test("cards the run waits on show model text as text, never as markup", () => {
  const agent = read("extension/agent.js");
  assert.ok(!agent.includes('id="confirmRiskBtn"'), "a duplicate #confirmRiskBtn id");
  const start = agent.indexOf("function drawWait");
  const card = agent.slice(start, agent.indexOf("\n  }\n", start));
  assert.match(card, /text\.textContent = wait\.question/);
  assert.match(card, /row\.textContent = line/);
  assert.doesNotMatch(card, /innerHTML/, "a waiting card renders markup");
});

test("cost accounting reads both OpenAI and Anthropic usage shapes", () => {
  const llm = read("extension/core/llm.js");
  assert.match(llm, /u\.prompt_tokens \?\? u\.input_tokens/);
  assert.match(llm, /stream_options = \{ include_usage: true \}/);
});

test("privacy policy accurately describes the run history", () => {
  const policy = read("PRIVACY_POLICY.md");
  // The history keeps the words of the task, which include any text selected for the quick box.
  assert.match(policy, /Your last 20 tasks: the words you typed \(including any text you selected for the quick box\)/);
  assert.doesNotMatch(policy, /never page contents/, "a quick-box task carries the selected page text");
  assert.doesNotMatch(policy, /decision model|planning prompt|validator-confirmed/, "the policy still describes the removed loop or router");
  // ...and the engine writes only finished runs, with no page text.
  const engine = read("extension/engine.js");
  assert.match(engine, /\["success", "unconfirmed", "error", "limit", "idle"\]\.includes\(run\.outcome\.state\)\) \{\s*\/\/ The sidebar's list of recent tasks, each with how it ended\./);
  assert.match(engine, /\{ task: run\.task, subtasks: \[\], timestamp: Date\.now\(\), outcome: run\.outcome\.state \}/);
});

test("the framing rule only applies to the side panel, never to tabs", () => {
  const bg = read("extension/background.js");
  assert.match(bg, /tabIds: \[chrome\.tabs\.TAB_ID_NONE\]/);
  assert.match(bg, /resourceTypes: \['sub_frame'\]/);
  const manifest = read("extension/manifest.json");
  assert.ok(!manifest.includes("rule_resources"), "no static header rule that applies to every site");
});

test("security doc states the full header-removal scope of the side-panel rule", () => {
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
