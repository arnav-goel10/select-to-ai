const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const defaults = require("../../extension/defaults.js");

const extensionRoot = path.resolve(__dirname, "../../extension");

function readExtensionSources(extensions) {
  return fs
    .readdirSync(extensionRoot)
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(extensionRoot, name), "utf8"),
    }));
}

test("shared agent defaults are the coherent runtime values", () => {
  const d = defaults.AGENT_DEFAULTS;
  assert.equal(d.maxSteps, 25);
  assert.equal(d.elementLimit, 60);
  assert.equal(d.historyLimit, 12);
  assert.equal(d.timeoutMs, 60000);
  assert.equal(d.maxTokensPerCall, 2000);
  assert.equal(d.failureThreshold, 3);
  assert.equal(d.activeProvider, "opencode");
  assert.equal(d.model, "deepseek-v4-flash-free");
  assert.equal(d.riskConfirmation, true);
});

test("every provider has a lite and pro fallback model", () => {
  const providers = [
    "openrouter",
    "anthropic",
    "openai",
    "deepseek",
    "gemini",
    "mistral",
    "groq",
    "together",
    "xai",
    "opencode",
    "custom",
  ];
  for (const provider of providers) {
    const pair = defaults.PROVIDER_FALLBACK_MODELS[provider];
    assert.ok(pair, `missing fallback pair for ${provider}`);
    assert.ok(pair.lite && typeof pair.lite === "string");
    assert.ok(pair.pro && typeof pair.pro === "string");
  }
});

test("no retired model ids remain anywhere in the extension sources", () => {
  const retired = [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-3.5-sonnet",
    "claude-3.5-haiku",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-flash-1.5",
    "grok-beta",
    "grok-2-1212",
    "llama3-8b-8192",
    "llama3-70b-8192",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "open-mistral-7b",
    "llama-3-8b-chat-hf",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "o1-mini",
    "o1-preview",
  ];
  const sources = readExtensionSources([".js", ".html"]);
  for (const { name, text } of sources) {
    const lower = text.toLowerCase();
    for (const id of retired) {
      assert.ok(
        !lower.includes(id.toLowerCase()),
        `retired model id "${id}" still referenced in extension/${name}`,
      );
    }
  }
});

test("price lookup matches exact key first, then longest substring", () => {
  const prices = defaults.MODEL_PRICES;
  // Exact ID keys win.
  assert.equal(defaults.findModelRates("gpt-5.4-mini"), prices["gpt-5.4-mini"]);
  assert.equal(defaults.findModelRates("gpt-5.4"), prices["gpt-5.4"]);
  // Longest-substring: family prefixes must not shadow specific models.
  assert.notEqual(defaults.findModelRates("gpt-5.4-mini"), prices["gpt-5"]);
  assert.equal(defaults.findModelRates("gpt-5.4-nano"), prices["gpt-5.4-nano"]);
  // Vendor-prefixed slugs resolve through substring matching.
  assert.equal(
    defaults.findModelRates("anthropic/claude-sonnet-4.6"),
    prices["claude-sonnet"],
  );
  assert.equal(
    defaults.findModelRates("openai/gpt-oss-120b"),
    prices["gpt-oss-120b"],
  );
  assert.equal(
    defaults.findModelRates("meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"),
    prices["llama-3.1-8b"],
  );
  // Unknown models fall back to the default rate.
  assert.equal(defaults.findModelRates("totally-unknown-model"), prices.default);
  assert.equal(defaults.findModelRates(""), prices.default);
  assert.equal(defaults.findModelRates(null), prices.default);
});

test("every fallback model resolves to a sane price entry", () => {
  for (const [provider, pair] of Object.entries(
    defaults.PROVIDER_FALLBACK_MODELS,
  )) {
    for (const tier of ["lite", "pro"]) {
      const rates = defaults.findModelRates(pair[tier]);
      assert.ok(Array.isArray(rates) && rates.length === 2, `${provider}.${tier}`);
      assert.ok(
        rates.every((rate) => typeof rate === "number" && rate >= 0),
        `${provider}.${tier} has invalid rates`,
      );
    }
  }
});

test("agent, options, and background all read the shared defaults module", () => {
  for (const file of ["agent.js", "options.js", "background.js"]) {
    const text = fs.readFileSync(path.join(extensionRoot, file), "utf8");
    assert.ok(
      text.includes("SELECT_TO_AI_DEFAULTS"),
      `extension/${file} does not use SELECT_TO_AI_DEFAULTS`,
    );
  }
  // The pages that run agent.js / options.js must load defaults.js first.
  for (const file of ["agent.html", "options.html"]) {
    const text = fs.readFileSync(path.join(extensionRoot, file), "utf8");
    assert.match(text, /<script src="defaults\.js"><\/script>/);
  }
  const background = fs.readFileSync(
    path.join(extensionRoot, "background.js"),
    "utf8",
  );
  assert.match(background, /importScripts\([^)]*['"]defaults\.js['"]/);
});
