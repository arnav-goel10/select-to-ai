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
  assert.equal(d.checkInMinutes, 5);
  assert.equal(d.costBudget, 0);
  // OpenRouter's free router: no card needed, and it outlives any single
  // free model. OpenCode's free models refuse calls from outside OpenCode.
  assert.equal(d.activeProvider, "openrouter");
  assert.equal(d.model, "openrouter/free");
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
    "cerebras",
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
    // Taken out on 25 Nov 2026. Only ids that are not the start of a
    // current one go here (claude-sonnet-5 would match claude-sonnet-5-5);
    // the rest are held out of every list by the test below.
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-haiku-4.5",
    "gemma-4-26b-a4b-it",
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
    prices["openai/gpt-oss-120b"],
  );
  assert.deepEqual(prices["openai/gpt-oss-120b"], [0.00015, 0.0006]);
  assert.equal(defaults.findModelRates("gpt-oss-120b"), prices["gpt-oss-120b"]);
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

test("vision capability flag matches known model families", () => {
  // Vision-capable families → screenshots auto-attach.
  for (const model of [
    "claude-sonnet-4-6",
    "anthropic/claude-haiku-4.5",
    "gpt-5.5",
    "openai/gpt-5.4-mini",
    "gemini-flash-latest",
    "grok-4-6",
    "mistral-large-latest",
  ]) {
    assert.equal(defaults.isVisionModel(model), true, `${model} should be vision`);
  }
  // Text-only models → the agent must stay on the text path.
  for (const model of [
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-flash-free",
    "openai/gpt-oss-120b",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "mistral-small-latest",
    "",
    null,
  ]) {
    assert.equal(
      defaults.isVisionModel(model),
      false,
      `${model} should NOT be vision`,
    );
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

test("OpenRouter starts on a free model, and paid is a choice the user makes", () => {
  // Regression: both OpenRouter fallbacks used to be paid models and not one
  // of the presets was free, so switching provider silently started billing.
  // Since 25 Nov 2026 OpenRouter has a real paid main model (lite), so the
  // free one has its own field, and that is where every path starts.
  const or = defaults.PROVIDER_FALLBACK_MODELS.openrouter;
  assert.deepEqual(defaults.findModelRates(or.free), [0, 0], `OpenRouter free default "${or.free}" must be a free model`);
  assert.equal(defaults.startModelFor("openrouter"), or.free);
  assert.equal(defaults.AGENT_DEFAULTS.model, or.free);
  assert.ok(defaults.findModelRates(or.lite)[0] > 0, "lite is the paid main model, for an account with credit");
  // Settings and the welcome page both start a provider through startModelFor.
  for (const file of ["options.js", "welcome.js"]) {
    assert.match(fs.readFileSync(path.join(extensionRoot, file), "utf8"), /D\.startModelFor\(provider\)/, `${file} starts a provider on its start model`);
  }
});

test("OpenRouter presets offer free models before paid ones", () => {
  const presets = defaults.MODEL_PRESETS.openrouter;
  const free = presets.filter((m) => defaults.findModelRates(m)[0] === 0);
  assert.ok(free.length >= 3, "at least three free OpenRouter presets");
  assert.equal(
    defaults.findModelRates(presets[0])[0],
    0,
    "the first preset a user sees should be free",
  );
});

test("free tiers are priced at zero by suffix, not by table entry", () => {
  // ":free" is OpenRouter's convention; "-free" is used by other gateways.
  for (const id of [
    "openrouter/free",
    "google/gemma-4-31b-it:free",
    "z-ai/glm-5.2:free",
    "some-vendor/model-we-have-never-seen:free",
    "deepseek-v4-flash-free",
  ]) {
    assert.deepEqual(defaults.findModelRates(id), [0, 0], `${id} must estimate as free`);
  }
  // and paid models are untouched by the new rule
  assert.deepEqual(defaults.findModelRates("anthropic/claude-sonnet-4.6"), [0.003, 0.015]);
  assert.deepEqual(defaults.findModelRates("google/gemini-3.5-flash"), [0.0015, 0.009]);
});

test("vision detection recognises the free models we ship as presets", () => {
  // Regression: every free vision-capable model missed the pattern list, so
  // the agent silently ran text-only instead of attaching marked screenshots.
  assert.equal(defaults.isVisionModel("google/gemma-4-31b-it:free"), true);
  // The free router can land on a text-only model, so it must not claim
  // vision: a screenshot every step would slow runs and risk rejected calls.
  assert.equal(defaults.isVisionModel("openrouter/free"), false);
  // text-only free models must stay text-only: claiming vision would make the
  // provider reject every screenshot payload.
  assert.equal(defaults.isVisionModel("openai/gpt-oss-20b:free"), false);
  assert.equal(defaults.isVisionModel("z-ai/glm-5.2:free"), false);
});

test("the post-action settle waits on page change, not on mutation quiet", () => {
  // Regression: the old waitForDomStable debounced a MutationObserver over
  // childList + attributes + characterData, so any animation or ticking clock
  // re-armed it forever and every action paid the full hard timeout.
  const src = fs.readFileSync(path.join(extensionRoot, "agentContentScript.js"), "utf8");
  const fn = src.slice(src.indexOf("function waitForDomStable"));
  const body = fn.slice(0, fn.indexOf("\n    }\n") + 1);

  assert.ok(
    !/new MutationObserver/.test(body),
    "settle must not depend on a MutationObserver: cosmetic churn never goes quiet",
  );
  assert.ok(/pageSignature/.test(body), "settle samples a structural page signature");
  assert.ok(
    /elapsed >= quietPeriod/.test(body),
    "the quiet period must remain a floor so late-arriving content is not missed",
  );
  assert.ok(/elapsed >= timeout/.test(body), "a hard timeout must still bound the wait");
});

test("no history permission: the extension never reads the browsing history", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  assert.ok(!manifest.permissions.includes("history"));
  assert.ok(!(manifest.optional_permissions || []).includes("history"));
  for (const { name, text } of readExtensionSources([".js"])) {
    assert.doesNotMatch(text, /chrome\.history\b/, `${name} reads the history`);
  }
});

test("no default shortcut takes a key a site or a keyboard already uses, and the palette stays user-remappable", () => {
  // Extension commands are handled before the page, so a default shadows
  // whatever a site or the system binds to the same keys:
  // - Cmd+K is the command palette in GitHub, Slack, Notion and Linear.
  // - Option+letter on macOS types a character (Option+N is the accent for
  //   n, Option+A is a ring, Option+K is a ring above), and Option+Shift+letter
  //   types another; Alt+letter shortcuts there stop people typing.
  // - On Windows and Linux Ctrl+K is the browser's own search shortcut.
  // So macOS uses Control+Shift (MacCtrl), which types nothing, on letters
  // macOS text fields do not bind to Control (A, B, D, E, F, H, K, L, N, O,
  // P, T, V and Y move the caret or edit text). Elsewhere it is Alt+letter.
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  const commands = Object.entries(manifest.commands || {});
  const suggested = commands.filter(([, c]) => c.suggested_key);
  assert.ok(suggested.length <= 4, "Chrome allows at most four suggested shortcuts");
  const EMACS = new Set("ABDEFHKLNOPTVY".split(""));
  const seen = { mac: new Set(), default: new Set() };
  for (const [name, c] of suggested) {
    const mac = c.suggested_key.mac;
    const other = c.suggested_key.default;
    assert.ok(mac, `${name} has its own macOS key`);
    const macParts = mac.split("+");
    assert.ok(!macParts.includes("Command") || !macParts.includes("K"), `${name}: Cmd+K belongs to the page's palette`);
    assert.ok(!macParts.includes("Alt") && !macParts.includes("Option"), `${name}: Option+key types a character on macOS (${mac})`);
    assert.ok(macParts.includes("MacCtrl") || macParts.includes("Command"), `${name}: Chrome needs Command or Control on macOS`);
    if (macParts.includes("MacCtrl")) assert.ok(!EMACS.has(macParts[macParts.length - 1]), `${name}: Control+${macParts[macParts.length - 1]} edits text in macOS fields`);
    const otherParts = other.split("+");
    assert.ok(otherParts.includes("Alt") || otherParts.includes("Ctrl"), `${name}: Chrome needs Ctrl or Alt`);
    assert.ok(!(otherParts.includes("Ctrl") && otherParts.includes("Alt")), `${name}: Ctrl+Alt is AltGr on many keyboards`);
    assert.notEqual(other, "Ctrl+K", `${name}: Ctrl+K is the browser's search`);
    assert.ok(!seen.mac.has(mac) && !seen.default.has(other), `${name} repeats another command's key`);
    seen.mac.add(mac);
    seen.default.add(other);
  }
  assert.equal(manifest.commands["open-palette"].suggested_key.default, "Alt+K");

  const optionsHtml = fs.readFileSync(path.join(extensionRoot, "options.html"), "utf8");
  assert.ok(optionsHtml.includes('id="paletteShortcut"'), "Settings must show the live binding");
  assert.ok(optionsHtml.includes('id="changeShortcutBtn"'), "Settings must offer a remap button");

  const optionsJs = fs.readFileSync(path.join(extensionRoot, "options.js"), "utf8");
  assert.match(optionsJs, /chrome\.commands\.getAll/, "the chip must read the real binding");
  assert.match(
    optionsJs,
    /chrome:\/\/extensions\/shortcuts/,
    "the remap button must open Chrome's shortcuts page",
  );
});

test("the palette logo is reachable from injected UI without leaking the id", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  const war = manifest.web_accessible_resources || [];
  const entry = war.find((w) => (w.resources || []).includes("icon128.png"));
  assert.ok(entry, "icon128.png must be web accessible for the palette mark");
  assert.equal(entry.use_dynamic_url, true, "rotate the URL so pages cannot fingerprint the id");

  // A strict page CSP can block the image, so the lettermark must remain.
  const palette = fs.readFileSync(path.join(extensionRoot, "commandPalette.js"), "utf8");
  assert.ok(palette.includes("mark-letter"), "lettermark fallback must survive");
  assert.match(palette, /addEventListener\("load"/, "only swap in the logo once it decodes");
});

test("tabs opened for a prompt clean up their own listeners", () => {
  // Regression: a tab that never reached "complete" (closed, blocked, offline)
  // left its onUpdated listener attached for the life of the service worker.
  const bg = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
  const fn = bg.slice(bg.indexOf("function createTabAndSend"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert.match(body, /onUpdated\.removeListener/, "must detach the load listener");
  assert.match(body, /onRemoved/, "must give up if the tab is closed");
  assert.match(body, /setTimeout\(cleanup/, "must give up if the tab never loads");
  assert.match(body, /!newTab \|\| !newTab\.id/, "must survive a failed tab create");
});

test("no retired provider hosts remain in any user-facing link", () => {
  // Checked live 20 Aug 2026: zen.opencode.co refuses connections outright,
  // and Anthropic/Together both moved their dashboards. Keep them from
  // creeping back in via copy-paste.
  const RETIRED = {
    "zen.opencode.co": "dead host; keys are issued at opencode.ai/console",
    "console.anthropic.com": "moved to platform.claude.com",
    "api.together.xyz/settings": "dashboard moved to api.together.ai",
  };
  const files = ["options.html", "options.js", "popup.html", "agent.html", "agent.js", "defaults.js", "config.js"];
  for (const file of files) {
    const full = path.join(extensionRoot, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const [host, why] of Object.entries(RETIRED)) {
      assert.ok(!text.includes(host), `${file} still points at ${host} (${why})`);
    }
  }
});

test("the OpenCode key link and API base agree on one host", () => {
  // The link said zen.opencode.co while the base URL said opencode.ai; that
  // split is what let the dead host survive unnoticed.
  const defaultsJs = fs.readFileSync(path.join(extensionRoot, "defaults.js"), "utf8");
  assert.ok(
    defaultsJs.includes("https://opencode.ai/zen/v1"),
    "OpenCode base URL must stay on opencode.ai (confirmed against the Zen docs)",
  );
  // The key links live in one table that Settings and the welcome page share.
  assert.equal(defaults.PROVIDER_INFO.opencode.keyUrl, "https://opencode.ai/console", "key link must be the OpenCode console");
  const optionsJs = fs.readFileSync(path.join(extensionRoot, "options.js"), "utf8");
  assert.match(optionsJs, /\.\.\.D\.PROVIDER_INFO/, "Settings reads the shared table");
});

test("no preset or fallback uses OpenCode's app-only free tier", () => {
  // Checked live 28 Sep 2026: every OpenCode "-free" model answers
  // "OpenCode's free tier can only be used from within OpenCode".
  const oc = defaults.PROVIDER_FALLBACK_MODELS.opencode;
  for (const id of [oc.lite, oc.pro, ...defaults.MODEL_PRESETS.opencode]) {
    assert.ok(!/-free$/.test(id), `${id} is app-only on OpenCode`);
  }
});

test("a free backup runs its free model; a paid backup runs its full model", () => {
  assert.equal(defaults.backupModelFor("gemini"), "gemini-3.8-flash");
  assert.equal(defaults.backupModelFor("groq"), "openai/gpt-oss-120b");
  assert.equal(defaults.backupModelFor("cerebras"), "gpt-oss-120b");
  assert.equal(defaults.backupModelFor("anthropic"), defaults.PROVIDER_FALLBACK_MODELS.anthropic.pro);
  assert.equal(defaults.backupModelFor("openai"), defaults.PROVIDER_FALLBACK_MODELS.openai.pro);
  for (const b of defaults.FREE_BACKUPS) assert.ok(b.model, `${b.provider} names its free model`);
});

test("the free router is sent as an ordered list of free models, the router last", () => {
  const o = defaults.openRouterOptions("openrouter/free", true);
  assert.equal(o.model, defaults.OPENROUTER_FREE_CHAIN[0]);
  assert.deepEqual(o.models, defaults.OPENROUTER_FREE_CHAIN.slice(1));
  assert.equal(o.models[o.models.length - 1], "openrouter/free");
  assert.ok(defaults.OPENROUTER_FREE_CHAIN.every((m) => m === "openrouter/free" || m.endsWith(":free")), "every model in the chain is free");
  assert.equal(o.parallel_tool_calls, false);
  // A model the user picked is sent as it is.
  assert.deepEqual(defaults.openRouterOptions("anthropic/claude-sonnet-5", true), { parallel_tool_calls: false });
  assert.deepEqual(defaults.openRouterOptions("anthropic/claude-sonnet-5", false), {});
});

test("an overloaded model hands over to a sibling from the same provider, each once", () => {
  assert.equal(defaults.siblingModel("gemini", "gemini-3.8-flash", []), "gemini-3.5-flash-lite");
  assert.equal(defaults.siblingModel("gemini", "gemini-3.5-flash-lite", ["gemini-3.8-flash"]), "", "the chain runs out");
  assert.equal(defaults.siblingModel("gemini", "gemini-4-hydrogen", []), "", "a model the user picked outside the chain is never swapped");
  assert.equal(defaults.siblingModel("mistral", "mistral-small-latest", []), "mistral-large-latest");
  assert.equal(defaults.siblingModel("openai", "gpt-6.2-sol", []), "");
});

test("every model the extension lists has a tier set for it, and no tier is guessed from a name", () => {
  const listed = new Set();
  for (const pair of Object.values(defaults.PROVIDER_FALLBACK_MODELS)) for (const id of Object.values(pair)) listed.add(id);
  for (const ids of Object.values(defaults.MODEL_PRESETS)) for (const id of ids) listed.add(id);
  for (const b of defaults.FREE_BACKUPS) listed.add(b.model);
  for (const id of defaults.OPENROUTER_FREE_CHAIN) listed.add(id);
  for (const ids of Object.values(defaults.MODEL_SIBLINGS)) for (const id of ids) listed.add(id);
  const tiers = defaults.MODEL_TIERS;
  assert.deepEqual(Object.keys(tiers).sort(), ["frontier", "small", "standard"]);
  const placed = Object.values(tiers).flat();
  assert.equal(placed.length, new Set(placed).size, "no model is in two tiers");
  for (const id of listed) assert.ok(placed.includes(id), `${id} has no tier set`);
  for (const [tier, ids] of Object.entries(tiers)) for (const id of ids) assert.equal(defaults.modelProfile(id).tier, tier, id);
  // The tier comes from the table: the function that picks it has no pattern to test a name with.
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../extension/defaults.js"), "utf8");
  const pick = src.slice(src.indexOf("function limitsFor("), src.indexOf("\n  }\n", src.indexOf("function limitsFor(")));
  assert.ok(pick.length > 20);
  assert.doesNotMatch(pick, /\/[^/\n]+\/[gimsuy]*\.test\(|\.match\(|\.includes\(/, "limitsFor tests no pattern against the name");
});

// ---------- the defaults chosen on 25 Nov 2026 ----------

test("each provider's main and stronger model are the ids picked from its own pages on 25 Nov 2026", () => {
  const want = {
    openrouter: ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"],
    anthropic: ["claude-haiku-5-5", "claude-sonnet-5-5"],
    openai: ["gpt-6-luna", "gpt-6.2-sol"],
    gemini: ["gemini-3.8-flash", "gemini-4-hydrogen"],
    deepseek: ["deepseek-flash", "deepseek-v4-pro"],
    mistral: ["mistral-small-latest", "mistral-large-latest"],
    groq: ["openai/gpt-oss-120b", "openai/gpt-oss-120b"],
    together: ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V4-Pro-0813"],
    xai: ["grok-4.3", "grok-4.7"],
    cerebras: ["gpt-oss-120b", "gpt-oss-120b"],
    opencode: ["deepseek-v4.1-flash", "claude-sonnet-5-5"],
  };
  for (const [provider, [lite, pro]] of Object.entries(want)) {
    const pair = defaults.PROVIDER_FALLBACK_MODELS[provider];
    assert.equal(pair.lite, lite, `${provider} main model`);
    assert.equal(pair.pro, pro, `${provider} stronger model`);
    assert.equal((defaults.MODEL_PRESETS[provider] || [])[provider === "openrouter" ? 4 : 0], lite, `${provider}: the main model leads its paid presets`);
  }
  assert.deepEqual(defaults.MODEL_PRESETS.openrouter, [
    "openrouter/free",
    "nvidia/nemotron-3.5-super-vl:free",
    "nvidia/nemotron-3.5-lightning:free",
    "google/gemma-4-31b-it:free",
    "anthropic/claude-haiku-5.5",
    "anthropic/claude-sonnet-5.5",
    "openai/gpt-6.2-sol",
    "google/gemini-4-hydrogen",
    "deepseek/deepseek-v4.1-flash-1017",
    "qwen/qwen3.8-flash",
  ]);
  assert.deepEqual(defaults.OPENROUTER_FREE_CHAIN, [
    "nvidia/nemotron-3.5-super-vl:free",
    "nvidia/nemotron-3.5-lightning:free",
    "google/gemma-4-31b-it:free",
    "openrouter/free",
  ]);
});

test("ids taken out on 25 Nov 2026 are offered nowhere: not as a default, preset, backup, sibling or chain member", () => {
  const stale = [
    "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5", "claude-sonnet-5",
    "gpt-5.4-mini", "openai/gpt-5.4-mini", "gpt-5.5", "gpt-5.4", "gpt-5.4-nano",
    "mistral-medium-latest", "gemini-flash-latest", "gemini-pro-latest", "gemini-flash-lite-latest", "gemini-3.1-pro-preview",
    "google/gemma-4-26b-a4b-it:free", "grok-4.6",
  ];
  const offered = new Set();
  for (const pair of Object.values(defaults.PROVIDER_FALLBACK_MODELS)) for (const id of Object.values(pair)) offered.add(id);
  for (const ids of Object.values(defaults.MODEL_PRESETS)) for (const id of ids) offered.add(id);
  for (const b of defaults.FREE_BACKUPS) offered.add(b.model);
  for (const id of defaults.OPENROUTER_FREE_CHAIN) offered.add(id);
  for (const ids of Object.values(defaults.MODEL_SIBLINGS)) for (const id of ids) offered.add(id);
  for (const id of stale) assert.ok(!offered.has(id), `${id} is still offered`);
  // A 20B model is not the main model anywhere: it would run every step.
  for (const [provider, pair] of Object.entries(defaults.PROVIDER_FALLBACK_MODELS)) assert.ok(!/(^|[^0-9])20b/i.test(pair.lite), `${provider} runs on ${pair.lite}`);
});

test("every default and preset has its price, and the ones that read images or think are marked so", () => {
  for (const [provider, pair] of Object.entries(defaults.PROVIDER_FALLBACK_MODELS)) {
    if (provider === "custom") continue;
    for (const id of Object.values(pair)) assert.ok(defaults.pricePerMillion(id), `${provider}: ${id} has a price on file, not the guess`);
  }
  // Cerebras's pricing page showed no table for Qwen3.8 27B (25 Nov 2026),
  // so setup shows that one without a price rather than a guessed one.
  const unpriced = new Set(["cerebras qwen-3.8-27b"]);
  for (const [provider, ids] of Object.entries(defaults.MODEL_PRESETS)) {
    if (provider === "custom") continue;
    for (const id of ids) if (!unpriced.has(`${provider} ${id}`)) assert.ok(defaults.pricePerMillion(id), `${provider} preset ${id} has a price on file`);
  }
  // Prices per million tokens, as the providers' pages list them on 25 Nov 2026.
  const per = (id) => defaults.pricePerMillion(id);
  assert.deepEqual(per("anthropic/claude-haiku-5.5"), { input: 0.1, output: 0.5 });
  assert.deepEqual(per("anthropic/claude-sonnet-5.5"), { input: 2, output: 10 });
  assert.deepEqual(per("gpt-6-luna"), { input: 0.1, output: 0.5 });
  assert.deepEqual(per("gpt-6.2-sol"), { input: 2, output: 10 });
  assert.deepEqual(per("gemini-4-hydrogen"), { input: 1.5, output: 7.5 });
  assert.deepEqual(per("gemini-3.5-flash-lite"), { input: 0.3, output: 2.5 });
  assert.deepEqual(per("grok-4.7"), { input: 2, output: 6 });
  assert.deepEqual(per("mistral-large-latest"), { input: 0.7, output: 2.1 });
  assert.deepEqual(per("gpt-oss-120b"), { input: 0.35, output: 0.75 }, "the bare id is Cerebras's");
  assert.deepEqual(per("openai/gpt-oss-120b"), { input: 0.15, output: 0.6 });
  assert.deepEqual(per("deepseek/deepseek-v4.1-flash-1017"), { input: 0.03, output: 0.2 });
  assert.deepEqual(per("openrouter/free"), { input: 0, output: 0 });
  assert.equal(per("some-model-nobody-lists"), null, "an unknown model has no price to show");
  for (const id of ["gpt-6-luna", "gpt-6.2-sol", "openai/gpt-6.2-sol", "gemini-4-hydrogen", "grok-4.7", "nvidia/nemotron-3.5-super-vl:free", "nvidia/NVIDIA-Nemotron-3.5-Super-VL", "anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5"]) {
    assert.equal(defaults.isVisionModel(id), true, `${id} reads images`);
  }
  for (const id of ["nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-120b", "gpt-oss-120b", "deepseek-v4.1-flash"]) {
    assert.equal(defaults.isVisionModel(id), false, `${id} is text only`);
  }
  for (const id of ["gpt-6-luna", "gpt-6.2-sol", "gemini-3.8-flash", "gemini-4-hydrogen", "grok-4.7", "openai/gpt-oss-120b", "gpt-oss-120b", "anthropic/claude-haiku-5.5", "nvidia/nemotron-3.5-super-vl:free", "qwen3.8-max"]) {
    assert.equal(defaults.modelProfile(id).thinks, true, `${id} thinks, so it gets the room for it`);
  }
});

test("setup's provider table names every provider the extension can reach, once, with its key page", () => {
  const info = defaults.PROVIDER_INFO;
  assert.deepEqual(Object.keys(info).sort(), [...Object.keys(defaults.PROVIDER_ENDPOINTS), "custom"].sort());
  for (const [provider, row] of Object.entries(info)) {
    assert.ok(row.name && row.line, `${provider} has a name and a line`);
    if (provider !== "custom") assert.match(row.keyUrl, /^https:\/\//, `${provider} links to its key page`);
    assert.ok(!/\u2014/.test(`${row.name} ${row.line} ${row.badge || ""}`), `${provider}: no em dash`);
  }
  // The first row: OpenRouter, Anthropic, OpenAI and Gemini, in that order.
  assert.deepEqual(Object.keys(info).filter((p) => info[p].top), ["openrouter", "anthropic", "openai", "gemini"]);
  assert.equal(info.openrouter.badge, "Recommended");
  assert.equal(info.anthropic.badge, "Most tested");
  // A free tier is marked on OpenRouter and on each free backup provider.
  const free = Object.keys(info).filter((p) => info[p].free).sort();
  assert.deepEqual(free, ["openrouter", ...defaults.FREE_BACKUPS.map((b) => b.provider)].sort());
});
