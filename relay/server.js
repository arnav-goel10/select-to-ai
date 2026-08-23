#!/usr/bin/env node
/**
 * Select to AI - Hosted mode relay server.
 *
 * A deliberately tiny, zero-dependency OpenAI-compatible relay. The
 * extension talks to it exactly like any custom OpenAI-compatible gateway;
 * the relay forwards chat traffic to a real upstream provider using the
 * UPSTREAM credential that lives only on the server. This is what lets a
 * new user run the full agent without ever seeing an API key.
 *
 * Design rules:
 * - Zero npm dependencies: `node relay/server.js` is the whole deployment.
 * - The extension's request shape passes through untouched (streaming SSE
 *   included); the relay never parses or rewrites model payloads beyond
 *   light header/model policy.
 * - Nothing about a request body is logged or stored.
 *
 * Configuration (environment variables):
 *   PORT                 listen port                    (default 8787)
 *   UPSTREAM_URL         OpenAI-compatible base URL     (required)
 *                        e.g. https://openrouter.ai/api/v1
 *   UPSTREAM_KEY         API key injected into requests (required)
 *   UPSTREAM_MODEL       model used when the client omits one
 *   ALLOWED_MODELS       comma-separated allowlist; empty = allow all
 *   RATE_LIMIT_PER_MIN   requests per IP per minute     (default 30)
 *   MAX_BODY_BYTES       request body cap               (default 2097152)
 *
 * Quick start:
 *   UPSTREAM_URL=https://openrouter.ai/api/v1 \
 *   UPSTREAM_KEY=sk-or-... node relay/server.js
 */

"use strict";

const http = require("node:http");
const https = require("node:https");

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM_URL = process.env.UPSTREAM_URL || "";
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || "";
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || "deepseek-v4-flash-free";
const ALLOWED_MODELS = String(process.env.ALLOWED_MODELS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 2 * 1024 * 1024);

if (!UPSTREAM_URL) {
  console.error("[relay] UPSTREAM_URL is required (OpenAI-compatible base URL).");
  process.exit(1);
}
if (!UPSTREAM_KEY) {
  console.error("[relay] UPSTREAM_KEY is required (the credential stays server-side).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting: fixed-window counters, swept periodically. Good
// enough for personal/small-group deployments; swap for a token bucket or a
// shared store when running multi-instance.
// ---------------------------------------------------------------------------
const rateBuckets = new Map(); // ip -> { windowStart, count }
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 1000;
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.windowStart < cutoff) rateBuckets.delete(ip);
  }
}, 60 * 1000).unref();

function rateLimitExceeded(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60 * 1000) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MIN;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function corsHeaders(origin) {
  // The caller is either an extension page (chrome-extension://...) or a
  // plain fetch from tests/curl. With no credentials involved, echoing the
  // origin (or "*" when absent) is safe and keeps extension pages working.
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Forwards an already-read request body to the upstream provider.
 * Streaming responses are piped straight through; the relay inspects
 * nothing inside the SSE stream.
 */
function forwardToUpstream(upstreamPath, method, headers, body, res) {
  const upstream = new URL(UPSTREAM_URL);
  const target = `${upstream.origin}${upstream.pathname.replace(/\/$/, "")}${upstreamPath}`;

  const isHttps = target.startsWith("https:");
  const transport = isHttps ? https : http;
  const parsedTarget = new URL(target);

  const outboundHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${UPSTREAM_KEY}`,
  };
  if (parsedTarget.hostname.endsWith("openrouter.ai")) {
    outboundHeaders["HTTP-Referer"] = "https://selecttoai.github.io";
    outboundHeaders["X-Title"] = "Select to AI Hosted Relay";
  }

  const req = transport.request(
    {
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (isHttps ? 443 : 80),
      path: parsedTarget.pathname + parsedTarget.search,
      method,
      headers: outboundHeaders,
    },
    (upstreamRes) => {
      const outHeaders = { ...corsHeaders(headers.origin) };
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (key.toLowerCase().startsWith("access-control-")) continue;
        outHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  req.setTimeout(120000, () => {
    req.destroy(new Error("upstream timeout"));
  });
  req.on("error", (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `Upstream error: ${err.message}` } }, corsHeaders(headers.origin));
    } else {
      res.end();
    }
  });

  if (body && body.length) req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const ip =
    (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "") ||
    "unknown";

  // Liveness / capability probe used by the extension's connection test.
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    sendJson(res, 200, {
      ok: true,
      service: "select-to-ai-relay",
      models: ALLOWED_MODELS.length ? ALLOWED_MODELS : ["*"],
    }, corsHeaders(origin));
    return;
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    const models = (ALLOWED_MODELS.length ? ALLOWED_MODELS : [UPSTREAM_MODEL]).map(
      (id) => ({ id, object: "model" }),
    );
    sendJson(res, 200, { object: "list", data: models }, corsHeaders(origin));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    if (rateLimitExceeded(ip)) {
      sendJson(res, 429, { error: { message: "Rate limit exceeded. Try again shortly." } }, corsHeaders(origin));
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, err.message === "payload too large" ? 413 : 400, { error: { message: err.message } }, corsHeaders(origin));
      return;
    }

    // Light policy check on the model id only. The rest of the payload is
    // forwarded byte-for-byte so provider features keep working unchanged.
    try {
      const parsed = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const requested = typeof parsed.model === "string" && parsed.model ? parsed.model : UPSTREAM_MODEL;
      if (ALLOWED_MODELS.length && !ALLOWED_MODELS.includes(requested)) {
        sendJson(res, 403, { error: { message: `Model "${requested}" is not allowed on this relay.` } }, corsHeaders(origin));
        return;
      }
      if (!parsed.model || typeof parsed.model !== "string") {
        parsed.model = UPSTREAM_MODEL;
        raw = Buffer.from(JSON.stringify(parsed), "utf8");
      }
    } catch (_err) {
      sendJson(res, 400, { error: { message: "Request body must be valid JSON." } }, corsHeaders(origin));
      return;
    }

    forwardToUpstream("/chat/completions", "POST", req.headers, raw, res);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found." } }, corsHeaders(origin));
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://localhost:${PORT}`);
  console.log(`[relay] upstream: ${UPSTREAM_URL} (model: ${UPSTREAM_MODEL})`);
  console.log(`[relay] rate limit: ${RATE_LIMIT_PER_MIN}/min per IP; body cap ${Math.round(MAX_BODY_BYTES / 1024)} KiB`);
});
