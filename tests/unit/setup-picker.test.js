"use strict";
// The welcome page's provider picker, run for real against the page's own
// ids: step 1 lists every provider, step 2 connects the one picked and then
// offers its models, and Save writes only what the user chose.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../helpers/page-harness.js");

const D = require("../../extension/defaults.js");
globalThis.SELECT_TO_AI_DEFAULTS = D;
const S = require("../../extension/setup.js");

const consented = (...providers) => ({ [S.CONSENT_KEY]: Object.fromEntries(providers.map((p) => [S.consentId(p), 1])) });

/** A fetch that answers every key check with 200 and OpenRouter's key endpoint with `credit`. */
function network(seen, { credit = null, models = null, status = 200 } = {}) {
  return async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {} });
    if (/openrouter\.ai\/api\/v1\/key$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ data: credit === null ? {} : { is_free_tier: !credit } }) };
    }
    if (/\/models$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: (models || []).map((id) => ({ id })) }) };
    return { ok: status === 200, status, headers: new Map(), json: async () => (status === 200 ? { choices: [] } : { error: { message: "nope" } }) };
  };
}

function cardsOf(page) {
  return page.made.filter((e) => e.className === "prov");
}
function cardFor(page, provider) {
  return cardsOf(page).find((b) => b.id === `prov-${provider}`);
}
async function until(page, id, ms = 2000) {
  for (const end = Date.now() + ms; !page.visible(id) && Date.now() < end;) await settle(10);
  return page.visible(id);
}

test("step 1 lists every provider the extension supports, the top four first", async () => {
  const page = loadPage({ html: "welcome.html" });
  await settle(6);
  assert.deepEqual(page.errors, []);
  const ids = cardsOf(page).map((b) => b.id.replace(/^prov-/, ""));
  assert.deepEqual(ids.sort(), Object.keys(D.PROVIDER_INFO).sort(), "one card per provider, custom included");
  assert.equal(page.$("providerGrid").children.length, 4);
  assert.equal(page.$("moreGrid").children.length, Object.keys(D.PROVIDER_INFO).length - 4);
  for (const b of cardsOf(page)) assert.equal(b.type, "button", `${b.id} is a real button, so the keyboard reaches it`);
  // The recommended card says what it is and why, in its own text.
  const or = cardFor(page, "openrouter");
  assert.equal(or.children[0].textContent, "OpenRouter");
  assert.equal(or.children[0].children[0].textContent, "Recommended");
  assert.equal(or.children[1].textContent, "Free to start. One sign-in, no key to paste.");
  // Groq and Cerebras carry a free-tier tag.
  for (const p of ["groq", "cerebras"]) assert.equal(cardFor(page, p).children[0].children[0].textContent, "Free tier", p);
  assert.equal(page.visible("pickStep"), true);
  assert.equal(page.visible("keyStep"), false);
});

test("picking a provider opens step 2 with its key page, its key shape and no OpenRouter sign-in", async () => {
  const page = loadPage({ html: "welcome.html" });
  await settle(6);
  cardFor(page, "anthropic").click();
  assert.equal(page.visible("keyStep"), true);
  assert.equal(page.visible("pickStep"), false);
  assert.equal(page.$("keyTitle").textContent, "Connect Anthropic");
  assert.equal(page.$("getKey").href, D.PROVIDER_INFO.anthropic.keyUrl);
  assert.equal(page.$("providerKey").placeholder, D.PROVIDER_INFO.anthropic.placeholder);
  assert.equal(page.visible("orSignIn"), false);
  assert.equal(page.visible("urlField"), false);
  page.$("backToPick").click();
  assert.equal(page.visible("pickStep"), true);
  cardFor(page, "openrouter").click();
  assert.equal(page.visible("orSignIn"), true, "OpenRouter offers its sign-in");
});

test("a key from another provider is named before anything is sent, with a one-click switch", async () => {
  const seen = [];
  const page = loadPage({ html: "welcome.html", local: consented("anthropic", "openai"), globals: { fetch: network(seen) } });
  await settle(6);
  cardFor(page, "anthropic").click();
  page.$("providerKey").value = "sk-proj-ExampleKeyForTests0000";
  page.$("connectKey").click();
  await settle(10);
  assert.equal(seen.length, 0, "nothing was sent");
  assert.match(page.$("status").children.map((c) => c.textContent).join(" "), /That looks like a key from OpenAI, not from Anthropic\. Nothing was sent\./);
  const switchBtn = page.made.find((e) => e.className.includes("try-other") && /Use OpenAI instead/.test(e.textContent));
  assert.ok(switchBtn, "a switch to OpenAI is offered");
  switchBtn.click();
  assert.ok(await until(page, "modelStep"), "the key went to OpenAI and passed");
  assert.equal(page.$("keyTitle").textContent, "Connect OpenAI");
  assert.ok(seen.every((r) => r.url.startsWith("https://api.openai.com/")), seen.map((r) => r.url).join(" "));
});

test("after a key passes, the main model is preselected with its price, and the stronger one is off until ticked", async () => {
  const seen = [];
  const page = loadPage({ html: "welcome.html", local: consented("anthropic"), globals: { fetch: network(seen) } });
  await settle(6);
  cardFor(page, "anthropic").click();
  page.$("providerKey").value = "sk-ant-api03-example";
  page.$("connectKey").click();
  assert.ok(await until(page, "modelStep"));
  assert.equal(page.$("modelPick").value, "claude-haiku-5-5");
  const first = page.$("modelPick").children[0];
  assert.equal(first.textContent, "claude-haiku-5-5, $0.10 in, $0.50 out per million tokens");
  assert.equal(page.visible("planField"), false);
  assert.equal(page.visible("strongerRow"), true);
  assert.equal(page.$("useStronger").checked, false);
  assert.match(page.$("strongerDetail").textContent, /^claude-sonnet-5-5, \$2\.00 in, \$10\.00 out per million tokens\./);
  assert.equal(page.chrome.storage.local.data.agentAnthropicKey, "sk-ant-api03-example", "the key that passed is kept");
  assert.equal(page.chrome.storage.sync.data.agentActiveProvider, undefined, "nothing else is saved before Save");

  page.$("saveSetup").click();
  assert.ok(await until(page, "done"));
  const sync = page.chrome.storage.sync.data;
  assert.equal(sync.agentActiveProvider, "anthropic");
  assert.equal(sync.agentModel, "claude-haiku-5-5");
  assert.equal(sync.agentHelperModel, "", "no stronger model unless ticked");
  assert.equal(sync.showAgent, true);
});

test("ticking the stronger model saves it as the helper", async () => {
  const page = loadPage({ html: "welcome.html", local: consented("openai"), globals: { fetch: network([]) } });
  await settle(6);
  cardFor(page, "openai").click();
  page.$("providerKey").value = "sk-proj-ExampleKeyForTests0000";
  page.$("connectKey").click();
  assert.ok(await until(page, "modelStep"));
  assert.equal(page.$("modelPick").value, "gpt-6-luna");
  page.$("useStronger").checked = true;
  page.$("saveSetup").click();
  assert.ok(await until(page, "done"));
  assert.equal(page.chrome.storage.sync.data.agentModel, "gpt-6-luna");
  assert.equal(page.chrome.storage.sync.data.agentHelperModel, "gpt-6.2-sol");
});

for (const [credit, picked, model, why] of [
  [true, "planPaid", "anthropic/claude-haiku-5.5", /bought credit/],
  [false, "planFree", "openrouter/free", /no credit yet/],
  [null, "planFree", "openrouter/free", /did not say/],
]) {
  test(`OpenRouter preselects ${picked === "planPaid" ? "Paid" : "Free"} when the account's credit is ${credit}, and says why`, async () => {
    const seen = [];
    const page = loadPage({ html: "welcome.html", local: consented("openrouter"), globals: { fetch: network(seen, { credit }) } });
    await settle(6);
    cardFor(page, "openrouter").click();
    page.$("providerKey").value = "sk-or-v1-example";
    page.$("connectKey").click();
    assert.ok(await until(page, "modelStep"));
    assert.equal(page.visible("planField"), true);
    assert.equal(page.visible("modelField"), false);
    assert.equal(page.visible("strongerRow"), false);
    assert.equal(page.$(picked).checked, true);
    assert.match(page.$("planWhy").textContent, why);
    assert.equal(page.$("planPaidLine").textContent, "Claude Haiku 5.5, about $0.10 in and $0.50 out per million tokens. Needs credit on OpenRouter.");
    assert.match(page.$("freeCapNote").textContent, /50 requests a day/);
    assert.ok(seen.some((r) => r.url === "https://openrouter.ai/api/v1/key" && r.method === "GET"), "the key's credit was read");
    page.$("saveSetup").click();
    assert.ok(await until(page, "done"));
    assert.equal(page.chrome.storage.sync.data.agentModel, model);
    if (credit !== true) assert.match(page.$("doneLede").textContent, /^You're on OpenRouter's free models\./);
  });
}

test("Settings' Change opens the picker on the provider in use", async () => {
  const page = loadPage({ html: "welcome.html", search: "?step=connect&provider=gemini" });
  await settle(6);
  assert.equal(page.visible("keyStep"), true);
  assert.equal(page.$("keyTitle").textContent, "Connect Google Gemini");
  assert.equal(page.$("getKey").textContent, "Get a free key");
  const unknown = loadPage({ html: "welcome.html", search: "?step=connect&provider=nonsense" });
  await settle(6);
  assert.equal(unknown.visible("pickStep"), true, "an unknown provider leaves the list on show");
});

test("your own server lists its models to pick from, and the address is saved with the choice", async () => {
  const seen = [];
  const url = "http://localhost:11434/v1";
  const local = { [S.CONSENT_KEY]: { [S.consentId("custom", url)]: 1 } };
  const page = loadPage({ html: "welcome.html", local, globals: { fetch: network(seen, { models: ["qwen3:8b", "llama3.3"] }) } });
  await settle(6);
  cardFor(page, "custom").click();
  assert.equal(page.visible("urlField"), true);
  page.$("serverUrl").value = "ftp://example.com";
  page.$("connectKey").click();
  await settle(4);
  assert.equal(seen.length, 0, "a bad address sends nothing");
  page.$("serverUrl").value = url;
  page.$("connectKey").click();
  assert.ok(await until(page, "modelStep"));
  assert.equal(seen[0].url, `${url}/models`);
  assert.deepEqual(page.$("modelPick").children.map((o) => o.value), ["qwen3:8b", "llama3.3"]);
  assert.equal(page.$("modelPick").value, "qwen3:8b", "the first listed model, not a guessed llama3");
  assert.equal(page.visible("strongerRow"), false);
  page.$("saveSetup").click();
  assert.ok(await until(page, "done"));
  assert.equal(page.chrome.storage.sync.data.agentActiveProvider, "custom");
  assert.equal(page.chrome.storage.sync.data.agentCustomUrl, url);
  assert.equal(page.chrome.storage.sync.data.agentModel, "qwen3:8b");
});
