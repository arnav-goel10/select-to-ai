# Hosted mode relay

Hosted mode lets someone use the full browser agent without creating API
accounts. The extension talks to this tiny relay exactly like any custom
OpenAI-compatible gateway; the relay injects the real provider credential,
which lives only on the server.

The bundled server has **zero npm dependencies**: `node relay/server.js` is
the entire deployment.

## Run it locally (testing / personal use)

```bash
UPSTREAM_URL=https://openrouter.ai/api/v1 \
UPSTREAM_KEY=sk-or-... \
UPSTREAM_MODEL=deepseek-v4-flash-free \
node relay/server.js
```

Then in the extension: Options → Provider → **Hosted (free)**, set the relay
URL if it is not the default `http://localhost:8787/v1`, and Test Connection.
No key entry required, ever.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `UPSTREAM_URL` | *(required)* | OpenAI-compatible base URL (e.g. `https://openrouter.ai/api/v1`) |
| `UPSTREAM_KEY` | *(required)* | Credential injected server-side; never sent to clients |
| `UPSTREAM_MODEL` | `deepseek-v4-flash-free` | Model used when a request omits one |
| `ALLOWED_MODELS` | *(all allowed)* | Comma-separated allowlist, e.g. `deepseek-v4-flash-free,deepseek-v4-pro` |
| `RATE_LIMIT_PER_MIN` | `30` | Requests per IP per minute |
| `MAX_BODY_BYTES` | `2097152` | Request body cap (matches the extension's own limit) |

## What the relay does and does not do

Does:

- Forwards `/v1/chat/completions` (including SSE streaming) to the upstream
  provider with its own credential.
- Serves `/v1/models`, `/health` for the extension's connection test.
- Enforces per-IP rate limits and a body-size cap; optionally an allowlist
  of model ids.

Does not:

- Log, store, or inspect prompt content. Bodies pass through untouched.
- Accept anything except chat completions traffic.
- Hold any state beyond in-memory rate counters.

## Deploying for real users later

The relay is deliberately portable. Any platform that runs a Node HTTP
server works (Fly.io, Render, Railway, a $5 VPS). Set the same environment
variables, put HTTPS in front of it (Caddy works well), and point the
extension's hosted URL at it. When usage grows, swap the fixed-window rate
limiter for a shared-store limiter; nothing else changes.
