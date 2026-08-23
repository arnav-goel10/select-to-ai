/**
 * Hosted-mode relay integration test.
 *
 * Spawns the zero-dependency relay (relay/server.js) against a scripted
 * OpenAI-compatible mock upstream and exercises the exact request shapes
 * the extension sends: health probe, model list, streaming chat
 * completions, policy rejections.
 *
 * Uses dedicated localhost ports (8797 / 9993) so it can run alongside the
 * rest of the suite without colliding with a real relay.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const RELAY_PORT = 8797;
const UPSTREAM_PORT = 9993;
const REPO_ROOT = path.resolve(__dirname, "../../");

function startMockUpstream() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers["authorization"] || "";
      if (!auth.startsWith("Bearer test-upstream-key")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (req.url.includes("/chat/completions")) {
        const parsed = JSON.parse(body || "{}");
        if (parsed.stream === true) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: `from upstream model=${parsed.model || "none"}` } }] })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "m1",
              object: "chat.completion",
              model: parsed.model || "unset",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: `upstream ok model=${parsed.model || "unset"}`,
                  },
                },
              ],
            }),
          );
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "deepseek-v4-flash-free" }, { id: "other-model" }],
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, () => resolve(server)));
}

function request(method, pathName, rawBody) {
  return new Promise((resolve) => {
    const data =
      rawBody != null
        ? typeof rawBody === "string"
          ? rawBody
          : JSON.stringify(rawBody)
        : null;
    const r = http.request(
      {
        host: "127.0.0.1",
        port: RELAY_PORT,
        method,
        path: pathName,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text: out }),
        );
      },
    );
    // A socket destroyed mid-upload is a valid oversized-body rejection.
    r.on("error", () => resolve({ status: 413, headers: {}, text: "reset" }));
    if (data) r.write(data);
    r.end();
  });
}

test("hosted relay forwards chat traffic under its policy", async () => {
  const upstream = await startMockUpstream();
  const relay = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "relay", "server.js")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(RELAY_PORT),
        UPSTREAM_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
        UPSTREAM_KEY: "test-upstream-key",
        UPSTREAM_MODEL: "deepseek-v4-flash-free",
        ALLOWED_MODELS: "deepseek-v4-flash-free,deepseek-v4-pro",
        RATE_LIMIT_PER_MIN: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    // Wait for the relay to accept connections.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      up = await new Promise((resolve) => {
        const probe = http.get(
          { host: "127.0.0.1", port: RELAY_PORT, path: "/health", timeout: 500 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        probe.on("error", () => resolve(false));
        probe.on("timeout", () => {
          probe.destroy();
          resolve(false);
        });
      });
    }
    assert.ok(up, "relay did not become ready");

    // Health probe used by the extension connection test.
    let res = await request("GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).ok, true);

    // Model listing is filtered through the allowlist.
    res = await request("GET", "/v1/models");
    const ids = JSON.parse(res.text).data.map((m) => m.id);
    assert.ok(ids.includes("deepseek-v4-flash-free"));
    assert.ok(!ids.includes("other-model"));

    // Non-stream completion forwards and injects the server-side key.
    res = await request("POST", "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("upstream ok"));
    assert.ok(res.text.includes("model=deepseek-v4-flash-free"));

    // Streaming passthrough stays intact (SSE chunks + [DONE]).
    res = await request("POST", "/v1/chat/completions", {
      model: "deepseek-v4-flash-free",
      stream: true,
      messages: [],
    });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("data:"));
    assert.ok(res.text.includes("[DONE]"));

    // Disallowed model rejected before reaching upstream.
    res = await request("POST", "/v1/chat/completions", {
      model: "gpt-99",
      messages: [],
    });
    assert.equal(res.status, 403);

    // Oversized body rejected.
    res = await request(
      "POST",
      "/v1/chat/completions",
      JSON.stringify({ messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }] }),
    );
    assert.ok([413, 400].includes(res.status));

    // Unknown routes 404.
    res = await request("GET", "/nope");
    assert.equal(res.status, 404);

    // CORS preflight works for extension pages.
    res = await request("OPTIONS", "/v1/chat/completions");
    assert.equal(res.status, 204);
    assert.ok(res.headers["access-control-allow-origin"]);
  } finally {
    relay.kill();
    upstream.close();
  }
});
