"use strict";
// Sign in with ChatGPT (extension/chatgptAuth.js) and the Responses API
// adapter in extension/core/llm.js, with OpenAI played by functions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const AUTH = require("../../extension/chatgptAuth.js");
const LLM = require("../../extension/core/llm.js");
const SECURITY = require("../../extension/security.js");

const subtle = webcrypto.subtle;
let seed = 0;
const random = (n) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0xff));
const res = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  headers: { forEach: () => {} },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)) })) }; } },
});
const formOf = (init) => Object.fromEntries(new URLSearchParams(init.body));

// ------------------------------------------------------------ authorize

test("a first sign-in registers with dynamic_agent_client, the app's name and the host ID, with PKCE, state and nonce", async () => {
  const { url, pending } = await AUTH.startAttempt({ hostId: "urn:uuid:11111111-2222-4333-8444-555555555555", registration: null, port: 1455, random, subtle });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/api/accounts/authorize");
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.client_id, "dynamic_agent_client");
  assert.equal(q.agent_name_hint, "Select to AI");
  assert.equal(q.ext_agent_host_id, "urn:uuid:11111111-2222-4333-8444-555555555555");
  assert.equal(q.response_type, "code");
  assert.equal(q.redirect_uri, "http://127.0.0.1:1455/auth/callback");
  assert.equal(q.scope, "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(q.resource, "https://api.openai.com/v1");
  assert.equal(q.code_challenge_method, "S256");
  assert.equal(q.state, pending.state);
  assert.equal(q.nonce, pending.nonce);
  assert.ok(q.state.length >= 40 && q.nonce.length >= 40 && q.state !== q.nonce);
  const expected = AUTH.b64url(await subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)));
  assert.equal(q.code_challenge, expected);
  assert.ok(!/=/.test(q.code_challenge), "unpadded");
  assert.ok(!("id_token_hint" in q) && !("login_hint" in q) && !("prompt" in q));
  assert.equal(pending.registering, true);
});

test("a returning sign-in uses the issued client ID and the account hints, and no name hint", async () => {
  const { url, pending } = await AUTH.startAttempt({ hostId: "urn:uuid:h", registration: { clientId: "oaiapp_abc", sub: "user-1", email: "a@example.com", idToken: "old.id.token" }, random, subtle });
  const q = Object.fromEntries(new URL(url).searchParams);
  assert.equal(q.client_id, "oaiapp_abc");
  assert.ok(!("agent_name_hint" in q));
  assert.equal(q.ext_agent_host_id, "urn:uuid:h");
  assert.equal(q.id_token_hint, "old.id.token");
  assert.equal(q.login_hint, "a@example.com");
  assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(pending.registering, false);
  const consent = await AUTH.startAttempt({ hostId: "urn:uuid:h", registration: { clientId: "oaiapp_abc" }, consent: true, random, subtle });
  assert.equal(new URL(consent.url).searchParams.get("prompt"), "consent");
});

test("a host ID is a urn:uuid made once from random bytes", () => {
  assert.match(AUTH.newHostId(random), /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ------------------------------------------------------------- callback

test("the redirect is used only with this attempt's state, address and client ID", async () => {
  const { pending } = await AUTH.startAttempt({ hostId: "urn:uuid:h", registration: null, port: 50123, random, subtle });
  const base = "http://127.0.0.1:50123/auth/callback";
  const ok = AUTH.readCallback(`${base}?code=c1&state=${pending.state}&client_id=oaiapp_new&scope=openid`, pending);
  assert.deepEqual(ok, { code: "c1", clientId: "oaiapp_new", scope: "openid" });
  assert.throws(() => AUTH.readCallback(`${base}?code=c1&state=wrong&client_id=oaiapp_new`, pending), (e) => e.kind === "state");
  assert.throws(() => AUTH.readCallback(`${base}?code=c1&client_id=oaiapp_new`, pending), (e) => e.kind === "state");
  assert.throws(() => AUTH.readCallback(`http://127.0.0.1:50124/auth/callback?code=c1&state=${pending.state}`, pending), (e) => e.kind === "state");
  assert.throws(() => AUTH.readCallback(`http://127.0.0.1:50123/callback?code=c1&state=${pending.state}`, pending), (e) => e.kind === "state");
  assert.throws(() => AUTH.readCallback(`${base}?error=access_denied&state=${pending.state}`, pending), (e) => e.kind === "declined");
  // A new registration with no issued client ID did not finish.
  assert.throws(() => AUTH.readCallback(`${base}?code=c1&state=${pending.state}`, pending), (e) => e.kind === "invalid");
  assert.throws(() => AUTH.readCallback(`${base}?code=c1&state=${pending.state}&client_id=dynamic_agent_client`, pending), (e) => e.kind === "invalid");
  const re = { ...pending, registering: false, clientId: "oaiapp_saved" };
  assert.equal(AUTH.readCallback(`${base}?code=c2&state=${pending.state}`, re).clientId, "oaiapp_saved");
  assert.throws(() => AUTH.readCallback(`${base}?code=c2&state=${pending.state}&client_id=oaiapp_other`, re), (e) => e.kind === "account");
});

test("the code is exchanged at the token endpoint with the issued client ID, the verifier and the same redirect", async () => {
  const seen = [];
  const deps = { fetch: async (url, init) => { seen.push({ url, init }); return res(200, { access_token: "at", refresh_token: "rt", id_token: "it", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" }); } };
  const pending = { verifier: "v123", redirectUri: "http://127.0.0.1:1455/auth/callback" };
  const got = await AUTH.exchangeCode(deps, pending, { code: "c1", clientId: "oaiapp_new" });
  assert.equal(got.access_token, "at");
  assert.equal(seen[0].url, "https://auth.openai.com/api/accounts/oauth/token");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.credentials, "omit");
  assert.equal(seen[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(formOf(seen[0].init), { grant_type: "authorization_code", client_id: "oaiapp_new", code: "c1", code_verifier: "v123", redirect_uri: "http://127.0.0.1:1455/auth/callback", resource: "https://api.openai.com/v1" });
});

test("a ChatGPT token is never sent anywhere but auth.openai.com and api.openai.com", async () => {
  await assert.rejects(AUTH.send({ fetch: async () => res(200, {}) }, "https://example.com/token", {}), (e) => e.kind === "config");
  assert.ok(SECURITY.validateProviderUrl("https://auth.openai.com/api/accounts/oauth/token").ok);
  assert.ok(SECURITY.validateProviderUrl("https://api.openai.com/v1/responses").ok);
});

// ------------------------------------------------------------- ID token

async function signer() {
  const keys = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const enc = (o) => AUTH.b64url(new TextEncoder().encode(JSON.stringify(o)));
  const sign = async (claims, kid) => {
    const head = `${enc({ alg: "RS256", kid: kid || "k1", typ: "JWT" })}.${enc(claims)}`;
    return `${head}.${AUTH.b64url(await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keys.privateKey, new TextEncoder().encode(head)))}`;
  };
  return { jwk, sign };
}

test("the ID token's signature, issuer, audience, expiry and nonce are all checked", async () => {
  const { jwk, sign } = await signer();
  AUTH.jwksCache.keys = null;
  const now = 1_790_000_000_000;
  const deps = { subtle, now: () => now, fetch: async (url) => { assert.equal(url, "https://auth.openai.com/.well-known/jwks.json"); return res(200, { keys: [jwk] }); } };
  const good = { iss: "https://auth.openai.com", aud: "oaiapp_new", sub: "user-1", email: "a@example.com", nonce: "n1", exp: now / 1000 + 600, iat: now / 1000 };
  const claims = await AUTH.verifyIdToken(deps, await sign(good), { clientId: "oaiapp_new", nonce: "n1" });
  assert.equal(claims.email, "a@example.com");
  await assert.rejects(AUTH.verifyIdToken(deps, await sign(good), { clientId: "oaiapp_new", nonce: "n2" }), /attempt/);
  await assert.rejects(AUTH.verifyIdToken(deps, await sign({ ...good, aud: "oaiapp_other" }), { clientId: "oaiapp_new", nonce: "n1" }), /different app/);
  await assert.rejects(AUTH.verifyIdToken(deps, await sign({ ...good, iss: "https://evil.example" }), { clientId: "oaiapp_new", nonce: "n1" }), /not issued/);
  await assert.rejects(AUTH.verifyIdToken(deps, await sign({ ...good, exp: now / 1000 - 600 }), { clientId: "oaiapp_new", nonce: "n1" }), /expired/);
  const forged = (await sign(good)).split(".");
  forged[1] = AUTH.b64url(new TextEncoder().encode(JSON.stringify({ ...good, sub: "someone-else" })));
  await assert.rejects(AUTH.verifyIdToken(deps, forged.join("."), { clientId: "oaiapp_new", nonce: "n1" }), /signature/);
});

test("the saved record keeps the granted scopes, and plan usage needs chatgpt.tokens.use.direct", () => {
  const cred = AUTH.credentialFrom({ access_token: "at", refresh_token: "rt", id_token: "it", expires_in: 3600, scope: "openid email chatgpt.tokens.use.direct" }, { sub: "u1", email: "a@example.com" }, "oaiapp_new", "urn:uuid:h", 1000);
  assert.equal(cred.expires_at, 1000 + 3600 * 1000);
  assert.equal(cred.client_id, "oaiapp_new");
  assert.ok(AUTH.planEnabled(cred.scopes));
  assert.ok(!AUTH.planEnabled(["openid", "email"]));
});

// -------------------------------------------------------------- refresh

function source(cred, replies, now) {
  const seen = [];
  const store = { cred, ended: 0 };
  const src = AUTH.createTokenSource({
    now: () => now,
    fetch: async (url, init) => { seen.push({ url, form: formOf(init) }); const r = replies.shift(); if (r instanceof Error) throw r; return r; },
    load: async () => store.cred,
    save: async (c) => { store.cred = c; },
    ended: async () => { store.ended += 1; store.cred = { ...store.cred, access_token: "", refresh_token: "" }; },
  });
  return { src, seen, store };
}
const cred = (more) => ({ client_id: "oaiapp_new", access_token: "at1", refresh_token: "rt1", id_token: "it", expires_at: 10_000_000, scopes: ["chatgpt.tokens.use.direct"], ...more });

test("a token far from expiry is used as it is; one near expiry is refreshed with the issued client ID and the rotated refresh token is kept", async () => {
  const fresh = source(cred(), [], 1000);
  assert.equal(await fresh.src.accessToken(false), "at1");
  assert.equal(fresh.seen.length, 0);
  const near = source(cred({ expires_at: 1000 + 60_000 }), [res(200, { access_token: "at2", refresh_token: "rt2", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" })], 1000);
  assert.equal(await near.src.accessToken(false), "at2");
  assert.deepEqual(near.seen[0].form, { grant_type: "refresh_token", client_id: "oaiapp_new", refresh_token: "rt1", resource: "https://api.openai.com/v1" });
  assert.equal(near.seen[0].url, "https://auth.openai.com/api/accounts/oauth/token");
  assert.equal(near.store.cred.refresh_token, "rt2");
  assert.equal(near.store.cred.expires_at, 1000 + 3600 * 1000);
});

test("a forced refresh (after a 401) renews even a fresh token, and refreshes at the same time share one request", async () => {
  const s = source(cred(), [res(200, { access_token: "at2", refresh_token: "rt2", expires_in: 3600 })], 1000);
  const [a, b] = await Promise.all([s.src.accessToken(true), s.src.accessToken(true)]);
  assert.equal(a, "at2");
  assert.equal(b, "at2");
  assert.equal(s.seen.length, 1);
});

test("an unusable refresh token ends the sign-in; a network failure does not", async () => {
  const ended = source(cred({ expires_at: 1000 }), [res(400, { error: "invalid_grant" })], 1000);
  await assert.rejects(ended.src.accessToken(false), (e) => e.kind === "signed_out" && /Sign in with ChatGPT again/.test(e.message));
  assert.equal(ended.store.ended, 1);
  const offline = source(cred({ expires_at: 1000 + 60_000 }), [new Error("network down")], 1000);
  assert.equal(await offline.src.accessToken(false), "at1");
  assert.equal(offline.store.ended, 0);
  const signedOut = source(null, [], 1000);
  await assert.rejects(signedOut.src.accessToken(false), (e) => e.kind === "signed_out");
});

// --------------------------------------------------------------- models

test("models are the account's listed ones, and the default is the newest full-size general model", async () => {
  const deps = { fetch: async (url, init) => { assert.equal(url, "https://api.openai.com/v1/models"); assert.equal(init.headers.Authorization, "Bearer at1"); return res(200, { models: [
    { slug: "gpt-5.5-mini", display_name: "GPT-5.5 Mini", visibility: "list" },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
    { slug: "gpt-6.1-codex", display_name: "GPT-6.1 Codex", visibility: "list" },
    { slug: "internal-x", display_name: "Hidden", visibility: "hide" },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
  ] }); } };
  const models = await AUTH.listModels(deps, "at1");
  assert.deepEqual(models.map((m) => m.slug), ["gpt-5.5-mini", "gpt-6.1-sol", "gpt-6.1-codex", "gpt-5.5"]);
  assert.equal(models[1].name, "GPT-6.1 Sol");
  assert.equal(AUTH.bestModel(models), "gpt-6.1-sol");
  assert.equal(AUTH.liteModel(models), "gpt-5.5-mini");
});

test("settings for ChatGPT: no key, a listed model, and a plain reason when not signed in", () => {
  const account = { signedIn: true, planEnabled: true, email: "a@example.com", models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-5.5" }, { slug: "gpt-5.5-mini" }] };
  const on = LLM.settingsFrom({ agentActiveProvider: "chatgpt", agentModel: "gpt-5.5", agentHelperModel: "gpt-6.1-sol", chatgptAccount: account }, 0);
  assert.equal(on.keyProblem, "");
  assert.equal(on.model, "gpt-5.5");
  assert.equal(on.helperModel, "gpt-6.1-sol");
  assert.equal(on.liteModel, "gpt-5.5-mini");
  assert.equal(on.baseUrl, "https://api.openai.com/v1");
  const unlisted = LLM.settingsFrom({ agentActiveProvider: "chatgpt", agentModel: "openrouter/free", agentHelperModel: "claude-x", chatgptAccount: account }, 0);
  assert.equal(unlisted.model, "gpt-6.1-sol");
  assert.equal(unlisted.helperModel, "");
  assert.match(LLM.settingsFrom({ agentActiveProvider: "chatgpt" }, 0).keyProblem, /sign in with ChatGPT/);
  assert.match(LLM.settingsFrom({ agentActiveProvider: "chatgpt", chatgptAccount: { ...account, planEnabled: false } }, 0).keyProblem, /not turned on/);
});

// ------------------------------------------------------- Responses API

const tool = { name: "browser_action", description: "One step.", parameters: { type: "object", properties: { action: { type: "string" } } } };
const ev = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const callStream = (args, extra) => ev([
  { type: "response.created", response: { model: "gpt-6.1-sol-2026" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "browser_action", arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: JSON.stringify(args).slice(0, 8) },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: JSON.stringify(args).slice(8) },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "browser_action", namespace: "browser", arguments: JSON.stringify(args) } },
  ...(extra || [{ type: "response.completed", response: { model: "gpt-6.1-sol-2026", status: "completed", usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } } }]),
]);
const cfg = (more) => ({ provider: "chatgpt", apiKey: "", baseUrl: "https://api.openai.com/v1", customUrl: "", model: "gpt-6.1-sol", liteModel: "gpt-6.1-sol", backup: "", keyProblem: "", promptCaching: true, ...more });
function client(replies, seen, tokens) {
  const handed = tokens || ["tok-1", "tok-2", "tok-3"];
  return LLM.createClient({
    fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); const r = replies.shift(); if (!r) throw new Error("no more replies"); return r; },
    chatgptToken: async (force) => { seen.push({ token: force ? "renew" : "get" }); return force ? handed.splice(1, 1)[0] || handed[0] : handed[0]; },
    sleep: async () => {}, now: () => 1000, log: (title) => seen.push({ log: title }),
  });
}
const FORBIDDEN = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id", "max_tokens", "messages"];

test("a Responses request: bearer token, store false, stream true, instructions, an input array, the tool in a namespace, and no refused field", async () => {
  const seen = [];
  const out = await client([res(200, callStream({ action: "click" }))], seen).call({ system: "You are the agent.", user: "Do the task.", tool, tier: "pro", effort: "low" }, cfg());
  assert.deepEqual(out.reply, { action: "click" });
  const sent = seen.find((x) => x.body);
  assert.equal(sent.url, "https://api.openai.com/v1/responses");
  assert.equal(sent.headers.Authorization, "Bearer tok-1");
  const b = sent.body;
  assert.equal(b.store, false);
  assert.equal(b.stream, true);
  assert.equal(b.model, "gpt-6.1-sol");
  assert.equal(b.instructions, "You are the agent.");
  assert.ok(Array.isArray(b.input));
  assert.deepEqual(b.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "Do the task." }] }]);
  assert.ok(!b.input.some((i) => i.role === "system"));
  for (const f of FORBIDDEN) assert.ok(!(f in b), `sent ${f}`);
  assert.equal(b.tools.length, 1);
  assert.equal(b.tools[0].type, "namespace");
  assert.deepEqual(b.tools[0].tools, [{ type: "function", name: "browser_action", description: "One step.", parameters: tool.parameters, strict: false }]);
  assert.equal(b.tool_choice, "auto");
  assert.equal(b.parallel_tool_calls, false);
  assert.deepEqual(b.reasoning, { effort: "low" });
});

test("a screenshot goes as an input_image part after the text", async () => {
  const seen = [];
  const image = "data:image/jpeg;base64,/9j/AAAA";
  await client([res(200, callStream({ action: "look" }))], seen).call({ system: "s", user: "u", tool, tier: "pro", image }, cfg());
  const b = seen.find((x) => x.body).body;
  assert.deepEqual(b.input[0].content, [{ type: "input_text", text: "u" }, { type: "input_image", image_url: image }]);
  for (const f of FORBIDDEN) assert.ok(!(f in b), `sent ${f}`);
});

test("the stream's text, function call, usage and served model come back in the engine's shape, at no cost", async () => {
  const seen = [];
  const texts = [];
  const stream = ev([
    { type: "response.created", response: { model: "gpt-6.1-sol-2026" } },
    { type: "response.reasoning_summary_text.delta", delta: "Thinking. " },
    { type: "response.output_text.delta", delta: "Hello, " },
    { type: "response.output_text.delta", delta: "world." },
    { type: "response.completed", response: { model: "gpt-6.1-sol-2026", usage: { input_tokens: 12, output_tokens: 3 } } },
  ]);
  const plain = await client([res(200, stream)], seen).call({ system: "s", user: "u", tier: "pro", onText: (t) => texts.push(t) }, cfg());
  assert.equal(plain.text, "Hello, world.");
  assert.equal(plain.model, "gpt-6.1-sol-2026");
  assert.equal(plain.usage.prompt, 12);
  assert.equal(plain.usage.completion, 3);
  assert.equal(plain.usage.cost, 0);
  assert.equal(plain.usage.estimated, false);
  assert.ok(texts.length >= 2);
  const withCall = await client([res(200, callStream({ action: "type", text: "a b" }))], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(withCall.reply, { action: "type", text: "a b" });
  assert.equal(withCall.usage.prompt, 900);
});

test("a stream that ends without response.completed is not a reply: it is asked again", async () => {
  const seen = [];
  const cut = ev([{ type: "response.output_text.delta", delta: "Hel" }]);
  const out = await client([res(200, cut), res(200, callStream({ action: "click" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(out.reply, { action: "click" });
  assert.equal(seen.filter((x) => x.body).length, 2);
});

test("a 401 renews the sign-in once and asks again with the new token; a second 401 asks the user to sign in again", async () => {
  const seen = [];
  const out = await client([res(401, { error: { message: "bad token", code: "subscription_sharing_invalid_user" } }), res(200, callStream({ action: "click" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg());
  assert.deepEqual(out.reply, { action: "click" });
  const bodies = seen.filter((x) => x.body);
  assert.equal(bodies[0].headers.Authorization, "Bearer tok-1");
  assert.equal(bodies[1].headers.Authorization, "Bearer tok-2");
  assert.ok(seen.some((x) => x.token === "renew"));
  await assert.rejects(client([res(401, { detail: "no" }), res(401, { detail: "no" })], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "auth" && /Sign in with ChatGPT again/.test(e.message));
});

test("a sign-in that cannot be renewed stops the call with the reason", async () => {
  const c = LLM.createClient({ fetch: async () => { throw new Error("not reached"); }, chatgptToken: async () => { const e = new Error("Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings."); e.kind = "signed_out"; throw e; }, sleep: async () => {}, now: () => 0 });
  await assert.rejects(c.call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "auth" && /has ended/.test(e.message));
});

test("the plan's usage limit, before or inside the stream, ends the call as a limit that points to ChatGPT's usage settings", async () => {
  const limitBody = { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached." } };
  await assert.rejects(client([res(429, limitBody)], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "limit" && /ChatGPT plan/.test(e.message) && e.limit.manageUrl === "https://chatgpt.com/settings/usage");
  const midStream = ev([
    { type: "response.output_text.delta", delta: "Sta" },
    { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached." } } },
  ]);
  const seen = [];
  await assert.rejects(client([res(200, midStream)], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "limit");
  assert.equal(seen.filter((x) => x.body).length, 1, "not asked again");
});

test("usage that cannot be checked is retried with backoff, then the run is paused rather than ended", async () => {
  const unavailable = () => res(503, { error: { code: "subscription_sharing_usage_unavailable", message: "Try later." } });
  const seen = [];
  await assert.rejects(client([unavailable(), unavailable(), unavailable(), unavailable()], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "rate_limited" && e.waitMs === 0);
  assert.equal(seen.filter((x) => x.body).length, 4);
});

test("a user the plan does not cover, and a model that refuses the screenshot, get their own plain outcomes", async () => {
  await assert.rejects(client([res(403, { error: { code: "subscription_sharing_user_not_eligible", message: "Not eligible." } })], []).call({ system: "s", user: "u", tool, tier: "pro" }, cfg()), (e) => e.kind === "config" && /not available/.test(e.message));
  await assert.rejects(client([res(400, { error: { code: "subscription_sharing_unsupported_capability", param: "input[0].content[1]", message: "Image input is not supported for this model." } })], []).call({ system: "s", user: "u", tool, tier: "pro", image: "data:image/png;base64,AAAA" }, cfg()), (e) => e.kind === "no_vision");
});

test("a refused tool namespace is retried once with the tool on its own", async () => {
  const seen = [];
  const out = await client([res(400, { error: { message: "Unknown tool type: namespace", param: "tools[0].type" } }), res(200, callStream({ action: "click" }))], seen).call({ system: "s", user: "u", tool, tier: "pro" }, cfg({ model: "gpt-ns-test" }));
  assert.deepEqual(out.reply, { action: "click" });
  const bodies = seen.filter((x) => x.body);
  assert.equal(bodies[1].body.tools[0].type, "function");
  assert.equal(bodies[1].body.tools[0].name, "browser_action");
});

// ------------------------------------------------------------ feature flag

test("Sign in with ChatGPT ships turned off: no button on the welcome or settings page, and the worker refuses it", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const EXT = path.resolve(__dirname, "../../extension");
  const D = require("../../extension/defaults.js");
  assert.equal(D.FEATURES.chatgptSignIn, false);

  // The pages: the ChatGPT block is removed, and the provider is hidden unless already in use.
  const welcome = fs.readFileSync(path.join(EXT, "welcome.js"), "utf8");
  assert.match(welcome, /if \(!D\.FEATURES\.chatgptSignIn\) \{\s*\$\("chatgptWay"\)\.remove\(\);\s*\$\("chatgptMention"\)\.remove\(\);/);
  const html = fs.readFileSync(path.join(EXT, "welcome.html"), "utf8");
  const way = html.slice(html.indexOf('<div id="chatgptWay">'), html.indexOf("or paste a key you already have"));
  assert.match(way, /id="chatgptSlot"/, "the sign-in button sits inside the removable block");
  assert.match(way, /or use your ChatGPT plan/, "and so does its heading");
  assert.match(html, /<span id="chatgptMention">you can use your ChatGPT plan, <\/span>/);
  const options = fs.readFileSync(path.join(EXT, "options.js"), "utf8");
  assert.match(options, /chatgptOption\.hidden = chatgptOption\.disabled = !D\.FEATURES\.chatgptSignIn && p !== "chatgpt"/);

  // The worker: a sign-in request from the extension's own page is refused before anything opens.
  let listener = null;
  const opened = [];
  const noop = { addListener: () => {} };
  const chrome = {
    runtime: { id: "ext", onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: { onUpdated: noop, onRemoved: noop, create: async (o) => { opened.push(o); return { id: 1 }; } },
    storage: { local: {}, session: {}, sync: {}, onChanged: noop },
  };
  const sandbox = { chrome, crypto: webcrypto, SELECT_TO_AI_CHATGPT: AUTH, SELECT_TO_AI_SECURITY: SECURITY, SELECT_TO_AI_DEFAULTS: D, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(EXT, "chatgptConnect.js"), "utf8"), sandbox);
  const reply = await new Promise((resolve) => {
    listener({ action: "chatgptSignIn" }, { id: "ext", url: "chrome-extension://ext/welcome.html" }, resolve);
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not available/);
  assert.deepEqual(opened, []);
});
