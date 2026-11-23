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

test("privacy policy lists the earlier conversation turns each step sends", () => {
  const policy = read("PRIVACY_POLICY.md");
  const context = read("extension/core/context.js");
  const turns = context.match(/run\.earlierTurns \|\| \[\]\)\.slice\(-(\d+)\)/);
  const clipAt = context.match(/Earlier in this conversation:[\s\S]{0,200}?clip\(t\.text, (\d+)\)/);
  assert.ok(turns && clipAt, "stepMessages no longer sends earlier turns; update this test and the policy");
  const words = { 6: "six" };
  const count = words[turns[1]] || turns[1];
  assert.match(policy, new RegExp(`messages in the same conversation and the agent's replies to them \\(up to ${count}, about ${clipAt[1]} characters each\\), at every step`));
  const disclosure = read("docs/privacy-disclosure.md");
  assert.match(disclosure, new RegExp(`the last ${turns[1]} conversation turns \\(${clipAt[1]} chars each`));
});

test("privacy policy lists the side-panel text kept in local storage", () => {
  const writesText = ["background.js", "sidepanel.js", "popup.js"].some((file) =>
    /sidePanelState:\s*\{[\s\S]{0,160}?selectedText:\s*(?!'')(?!"")\w/.test(read(`extension/${file}`)));
  assert.ok(writesText, "nothing keeps the sent text in sidePanelState any more; update this test and the policy");
  const policy = read("PRIVACY_POLICY.md");
  assert.match(policy, /\| The last text you sent to a chat site in the side panel[^|]*\| `chrome\.storage\.local` \| Until your next side-panel send or switch, or Reset \|/);
});

test("right-click texts name only the chat sites a fresh install shows", () => {
  // The menu a fresh install shows comes from the worker's defaults. Claude
  // also needs claude.ai, which a fresh install does not hold.
  const background = read("extension/background.js");
  const defaults = background.match(/const DEFAULT_SETTINGS = Object\.freeze\(\{([\s\S]*?)\}\);/)[1];
  const services = { ChatGPT: "showChatGPT", Gemini: "showGemini", Perplexity: "showPerplexity", Claude: "showClaude" };
  const onAtInstall = Object.keys(services).filter((name) =>
    name !== "Claude" && new RegExp(`${services[name]}:\\s*true`).test(defaults));
  const named = (text) => Object.keys(services).filter((name) => text.includes(name));

  const welcome = read("extension/welcome.html");
  const promise = welcome.match(/<span>Send it to ([^<]*?) without copying and pasting\./);
  assert.ok(promise, "the welcome page's right-click line changed; update this test");
  for (const name of named(promise[1])) assert.ok(onAtInstall.includes(name), `welcome.html promises ${name} on right-click, which a fresh install does not show`);

  const listing = read("docs/store-listing.md");
  const step = listing.match(/choose Select to AI > (Send to [^.]*)\./);
  assert.ok(step, "the reviewer's right-click step changed; update this test");
  for (const name of named(step[1])) assert.ok(onAtInstall.includes(name), `the reviewer step names ${name}, which a fresh install does not show`);
  const intro = listing.match(/right-click, and send it to ([^.]*)\./);
  for (const name of named(intro[1])) assert.ok(onAtInstall.includes(name), `the long description says right-click sends to ${name} on a fresh install`);
});
