/**
 * Select to AI - Sign in with ChatGPT: the loopback redirect is read from
 * the tab, with nothing listening on its port.
 *
 *   node tests/e2e/chatgpt-capture.js
 *
 * Chromium runs with the real extension. An attempt is put in session
 * storage as begin() would leave it, and a local page redirects a tab to
 * http://127.0.0.1:<closed port>/auth/callback?code=x&state=y, as OpenAI's
 * authorization page does. The service worker (chatgptConnect.js) must see
 * the address, close the tab, check the state, and exchange the code at the
 * token endpoint with the attempt's verifier and the exact redirect URI.
 * OpenAI is played by a stub fetch in the worker, so nothing leaves the
 * machine.
 */
"use strict";

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const assert = require("node:assert/strict");

const EXT = path.resolve(__dirname, "../../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port nothing listens on. */
function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function main() {
  const puppeteer = require("puppeteer");
  // The stand-in for OpenAI's authorization page: it only redirects.
  const fixture = http.createServer((req, res) => {
    const to = new URL(req.url, "http://127.0.0.1").searchParams.get("to") || "";
    res.writeHead(302, { Location: to });
    res.end();
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const fixturePort = fixture.address().port;
  const browser = await puppeteer.launch({ headless: !process.env.E2E_HEADFUL, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"] });
  let failures = 0;
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 20000 });
    const worker = await target.worker();
    await worker.evaluate(() => {
      self.__tokenCalls = [];
      SELECT_TO_AI_CHATGPT_CONNECT.deps.fetch = async (url, init) => {
        self.__tokenCalls.push({ url, body: String(init && init.body) });
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "stub: no real exchange" }), { status: 400, headers: { "Content-Type": "application/json" } });
      };
    });

    async function attempt(name, pendingState, sentState) {
      const port = await closedPort();
      const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
      const id = `e2e-${name}`;
      await worker.evaluate((p) => { self.__tokenCalls = []; return chrome.storage.session.set({ chatgptPending: p }); }, {
        id, state: pendingState, nonce: "n", verifier: "verifier-123", redirectUri, clientId: "", sub: "", registering: true, startedAt: Date.now(), tabId: -1, use: false,
      });
      const callback = `${redirectUri}?code=x&state=${sentState}&client_id=oaiapp_e2e&scope=openid`;
      const page = await browser.newPage();
      page.goto(`http://127.0.0.1:${fixturePort}/start?to=${encodeURIComponent(callback)}`).catch(() => {});
      let result = null;
      for (let i = 0; i < 100 && !result; i += 1) {
        await sleep(100);
        const r = await worker.evaluate(() => chrome.storage.session.get("chatgptSignIn").then((v) => v.chatgptSignIn || null));
        if (r && r.id === id && r.state !== "pending") result = r;
      }
      await sleep(300);
      const open = (await browser.pages()).map((p) => p.url());
      const calls = await worker.evaluate(() => self.__tokenCalls);
      const pending = await worker.evaluate(() => chrome.storage.session.get("chatgptPending").then((v) => v.chatgptPending || null));
      return { result, open, calls, callback, redirectUri, pending };
    }

    const check = (name, fn) => {
      try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures += 1; console.log(`FAIL  ${name}: ${e.message}`); }
    };

    const good = await attempt("good", "y", "y");
    check("the redirect is captured, its tab closed, and the code exchanged with the verifier and exact redirect", () => {
      assert.ok(good.result, "no result recorded");
      assert.ok(!good.open.some((u) => u.startsWith(good.redirectUri)), `callback tab still open: ${good.open.join(", ")}`);
      assert.equal(good.pending, null, "attempt not cleared");
      assert.equal(good.calls.length, 1, "token endpoint not called once");
      assert.equal(good.calls[0].url, "https://auth.openai.com/api/accounts/oauth/token");
      const form = Object.fromEntries(new URLSearchParams(good.calls[0].body));
      assert.deepEqual(form, { grant_type: "authorization_code", client_id: "oaiapp_e2e", code: "x", code_verifier: "verifier-123", redirect_uri: good.redirectUri, resource: "https://api.openai.com/v1" });
      // The stub refused the code, and that is what the page is told.
      assert.equal(good.result.state, "error");
      assert.match(good.result.message, /stub/);
    });

    const forged = await attempt("forged", "expected-state", "y");
    check("a redirect with another attempt's state is closed and not exchanged", () => {
      assert.ok(forged.result, "no result recorded");
      assert.equal(forged.calls.length, 0, "a code with the wrong state was exchanged");
      assert.equal(forged.result.state, "error");
      assert.match(forged.result.message, /did not match/);
      assert.ok(!forged.open.some((u) => u.startsWith(forged.redirectUri)), "callback tab still open");
    });
  } finally {
    await browser.close();
    fixture.close();
  }
  if (failures) {
    console.log(`${failures} ChatGPT capture check(s) failed.`);
    process.exit(1);
  }
  console.log("ChatGPT sign-in capture: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
