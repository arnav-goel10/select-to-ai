// Welcome key routing and the data consent (extension/setup.js).
//
// A pasted key goes to the one provider its shape names. A second provider
// is only offered after a plain 401, and never tried on its own. Errors name
// the provider that answered first. Nothing in these helpers sends anything.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const D = require("../../extension/defaults.js");
globalThis.SELECT_TO_AI_DEFAULTS = D;
const S = require("../../extension/setup.js");

const EXT = path.join(__dirname, "../../extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

const EXAMPLES = {
  // Made-up keys in each provider's shape. None is real.
  openrouter: "sk-or-v1-0000example0000example0000example0000example",
  anthropic: "sk-ant-api03-ExampleKeyForTests0000",
  openaiProject: "sk-proj-ExampleKeyForTests0000ExampleKeyForTests0000",
  openaiService: "sk-svcacct-ExampleKeyForTests0000",
  openaiLegacy: "sk-ExampleKeyForTests0000ExampleKeyForTests0000AbCd",
  deepseek: "sk-0123456789abcdef0123456789abcdef",
  gemini: "AIzaSyExampleKeyForTests000000000000",
  geminiNew: "AQ.Ab8RN6ExampleKeyForTests",
  groq: "gsk_ExampleKeyForTests0000",
  cerebras: "csk-0000example0000test0000",
  xai: "xai-ExampleKeyForTests0000",
  opencode: "oc_sk_ExampleKeyForTests",
  together: "tgp_v1_ExampleKeyForTests0000",
  mistral: "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  mistralPrefixed: "mstrl_ExampleKeyForTests0000",
};

test("each key shape names exactly one provider", () => {
  const want = {
    openrouter: "openrouter", anthropic: "anthropic", openaiProject: "openai", openaiService: "openai",
    openaiLegacy: "openai", deepseek: "deepseek", gemini: "gemini", geminiNew: "gemini", groq: "groq",
    cerebras: "cerebras", xai: "xai", opencode: "opencode", together: "together", mistral: "mistral",
    mistralPrefixed: "mistral",
  };
  for (const [shape, provider] of Object.entries(want)) {
    const r = S.routeKey(EXAMPLES[shape]);
    assert.ok(r, `${shape} is recognised`);
    assert.equal(r.provider, provider, shape);
  }
  assert.equal(S.routeKey(""), null);
  assert.equal(S.routeKey("hello there"), null);
});

test("an sk-proj key is OpenAI's alone: no DeepSeek alternative", () => {
  assert.deepEqual(S.routeKey(EXAMPLES.openaiProject), { provider: "openai", alt: null });
  assert.deepEqual(S.routeKey(EXAMPLES.openaiService), { provider: "openai", alt: null });
});

test("an sk-proj key never produces a request to api.deepseek.com, even after a 401", async () => {
  const asked = [];
  const urls = [];
  for (const status of [401, 403, 500]) {
    const r = await S.checkKey(EXAMPLES.openaiProject, async (provider) => {
      asked.push(provider);
      urls.push(S.testRequest(provider, EXAMPLES.openaiProject, "m").url);
      return { ok: false, status, message: "Incorrect API key provided" };
    });
    assert.equal(r.state, "failed");
    assert.equal(r.provider, "openai");
    assert.equal(r.alt, null, "nothing else is offered for a project key");
  }
  assert.deepEqual([...new Set(asked)], ["openai"]);
  assert.ok(urls.every((u) => new URL(u).host === "api.openai.com"), urls.join(" "));
  assert.ok(!urls.some((u) => /deepseek/.test(u)));
});

test("a plain sk- key goes to OpenAI first, and DeepSeek is only offered after a clean 401", async () => {
  const asked = [];
  const r401 = await S.checkKey(EXAMPLES.openaiLegacy, async (p) => { asked.push(p); return { ok: false, status: 401 }; });
  assert.deepEqual(asked, ["openai"], "the second provider is never tried on its own");
  assert.equal(r401.alt, "deepseek");
  const r500 = await S.checkKey(EXAMPLES.openaiLegacy, async () => ({ ok: false, status: 500, message: "server error" }));
  assert.equal(r500.alt, null, "a server error is not a reason to send the key elsewhere");
  const r403 = await S.checkKey(EXAMPLES.openaiLegacy, async () => ({ ok: false, status: 403 }));
  assert.equal(r403.alt, null, "only a plain 401 offers the other provider");
});

test("a DeepSeek-shaped key goes to DeepSeek first", async () => {
  const asked = [];
  const r = await S.checkKey(EXAMPLES.deepseek, async (p) => { asked.push(p); return { ok: true }; });
  assert.equal(r.state, "ok");
  assert.equal(r.provider, "deepseek");
  assert.deepEqual(asked, ["deepseek"]);
});

test("the reported error names the first provider tried", async () => {
  const r = await S.checkKey(EXAMPLES.openaiLegacy, async () => ({ ok: false, status: 401 }));
  const text = S.failureText(r.provider, r.error);
  assert.match(text, /^OpenAI said the key was not accepted\./);
  assert.ok(!/DeepSeek/.test(text));
  const thrown = await S.checkKey(EXAMPLES.groq, async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; });
  assert.match(S.failureText(thrown.provider, thrown.error), /^Groq said the provider did not answer in time/);
});

test("a Mistral key shows the name Mistral, and no provider name is ever undefined", async () => {
  const r = await S.checkKey(EXAMPLES.mistral, async () => ({ ok: false, status: 401 }));
  assert.equal(r.provider, "mistral");
  assert.match(S.failureText(r.provider, r.error), /^Mistral said/);
  for (const p of [...Object.keys(D.PROVIDER_ENDPOINTS), "custom", "chatgpt", "nonsense", undefined]) {
    const name = S.providerName(p);
    assert.ok(name && !/undefined/.test(name), `${p}: ${name}`);
    assert.ok(!/undefined/.test(S.failureText(p, { status: 401 })));
  }
});

test("every provider the welcome page can route to has an endpoint and a model", () => {
  for (const shape of S.KEY_SHAPES) {
    assert.ok(D.PROVIDER_ENDPOINTS[shape.provider], `${shape.provider} has an endpoint`);
    assert.ok(D.PROVIDER_FALLBACK_MODELS[shape.provider], `${shape.provider} has a fallback model`);
    const req = S.testRequest(shape.provider, "k", "m");
    assert.equal(new URL(req.url).origin, S.providerOrigin(shape.provider), `${shape.provider} test request stays on its own origin`);
  }
});

test("the welcome page sends a key only through checkKey and the routed provider", () => {
  const welcome = read("welcome.js");
  assert.ok(!/\["openai", "deepseek"\]/.test(welcome), "no list of providers to fall through");
  assert.match(welcome, /S\.checkKey\(key, \(p\) => testKey\(p, key\)\)/);
  assert.ok(!/for \(const provider of providers\)/.test(welcome), "no loop over providers");
  const html = read("welcome.html");
  assert.ok(html.indexOf('<script src="setup.js">') > 0 && html.indexOf('<script src="setup.js">') < html.indexOf('<script src="welcome.js">'));
  assert.ok(html.indexOf('<script src="core/grants.js">') < html.indexOf('<script src="setup.js">'));
});

// ---------- consent ----------

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(key, cb) { cb({ [key]: data[key] }); },
    set(items, cb) { Object.assign(data, items); if (cb) cb(); },
  };
}

test("consent is kept per provider, and a different provider is asked again", async () => {
  const store = fakeStorage();
  assert.deepEqual(S.missingConsent(await S.readConsent(store), ["openrouter"]), ["openrouter"]);
  await S.recordConsent(store, ["openrouter"]);
  const c = await S.readConsent(store);
  assert.deepEqual(S.missingConsent(c, ["openrouter"]), []);
  assert.deepEqual(S.missingConsent(c, ["openai"]), ["openai"], "a new provider is asked again");
  assert.deepEqual(S.missingConsent(c, ["openrouter", "groq"]), ["groq"], "the backup is asked for too");
  assert.ok(store.data[S.CONSENT_KEY].openrouter > 0);
});

test("a custom server's consent is tied to its address", () => {
  const a = S.consentId("custom", "http://127.0.0.1:11434/v1");
  const b = S.consentId("custom", "http://localhost:11434/v1");
  assert.equal(a, "custom http://127.0.0.1:11434");
  assert.notEqual(a, b);
  assert.equal(S.consentId("custom", "not a url"), null);
  assert.equal(S.consentId("openrouter"), "openrouter");
});

test("the consent card says what leaves and to whom, in three sentences, with no em dash", () => {
  const t = S.consentText("openrouter");
  assert.equal(t.sentences.length, 3);
  const all = t.sentences.join(" ");
  assert.match(all, /OpenRouter \(openrouter\.ai\)/);
  for (const what of ["your request", "pages", "open tabs", "remembers", "screenshots", "API key"]) assert.ok(all.includes(what), what);
  assert.ok(!/\u2014/.test(all));
  const withBackup = S.consentText("openai", "", { provider: "groq" }).sentences[0];
  assert.match(withBackup, /OpenAI \(api\.openai\.com\), and to Groq \(api\.groq\.com\) when your limits run out/);
  assert.match(S.consentText("custom", "http://localhost:11434/v1").sentences[0], /your own server at localhost:11434/);
});

test("the pages that reach a provider load setup.js and check consent before sending", () => {
  for (const page of ["welcome.html", "options.html", "agent.html"]) {
    const html = read(page);
    assert.match(html, /<script src="setup\.js"><\/script>/, `${page} loads setup.js`);
  }
  const agent = read("agent.js");
  assert.match(agent, /if \(!steering && !readyToSend\(/, "a new task waits for consent");
  const options = read("options.js");
  assert.match(options, /\$\("testBtn"\)\.onclick = askTest;/);
  assert.match(options, /\$\("backupTest"\)\.onclick = askTestBackup;/);
  assert.match(options, /"agentDataConsent"/, "Reset forgets the consent too");
});

test("Enter that confirms an IME word does not send", () => {
  const agent = read("agent.js");
  assert.match(agent, /e\.key === "Enter" && !e\.shiftKey && !e\.isComposing/);
  assert.match(read("popup.js"), /e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing/);
  assert.match(read("welcome.js"), /e\.key === "Enter" && !e\.isComposing/);
});

test("a task handed in the address goes through the handoff choice", () => {
  const agent = read("agent.js");
  const handed = agent.slice(agent.indexOf("function consumeHandedTask"));
  assert.match(handed, /params\.get\("autostart"\) === "1"\) \{[\s\S]{0,200}startAgent\(true\)/);
});
