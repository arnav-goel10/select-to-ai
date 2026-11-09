// One HTTP server for every fixture app. No framework.
//
// Harness-only endpoints need the per-launch secret in `x-bench-secret`, which
// the browser never sees:
//   POST /__session  {seed, mutation}  -> {sid}   (mutation is the full object)
//   GET  /__truth?sid=                 -> {log, initial, current}
// Pages identify their session by the opaque `bsid` cookie the harness sets.
import http from "node:http";
import crypto from "node:crypto";
import { render } from "./lib/h.js";
import { applyOps } from "./lib/mutate.js";
import { UI_JS, mulberry32 } from "./lib/ui.js";
import { APPS } from "./apps/index.js";

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const NEUTRAL = new Set(["view", "auth", "ui", "fail"]);
export const isNeutral = (ev) => NEUTRAL.has(ev.kind);

export async function startServer({ port = 0, quiet = true } = {}) {
  const secret = crypto.randomBytes(24).toString("hex");
  const sessions = new Map();

  function sessionState(s, app) {
    if (!s.state[app.name]) {
      s.state[app.name] = app.seed(mulberry32(s.seed * 7919 + app.name.length));
      s.initial[app.name] = structuredClone(s.state[app.name]);
    }
    return s.state[app.name];
  }

  function log(s, ev) {
    s.log.push({ i: s.log.length, t: Date.now(), ...ev });
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (!quiet) console.error(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error");
    }
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const harness = req.headers["x-bench-secret"] === secret;

    if (url.pathname === "/__session" && req.method === "POST") {
      if (!harness) return void res.writeHead(404).end();
      const body = JSON.parse((await readBody(req)) || "{}");
      const sid = crypto.randomBytes(12).toString("hex");
      sessions.set(sid, { sid, seed: body.seed ?? 1, mutation: body.mutation || null, state: {}, initial: {}, log: [], auth: {} });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ sid }));
    }
    if (url.pathname === "/__truth") {
      if (!harness) return void res.writeHead(404).end();
      const s = sessions.get(url.searchParams.get("sid"));
      if (!s) return void res.writeHead(404).end();
      // Seed every app so `initial` is complete even for apps never visited.
      for (const app of Object.values(APPS)) sessionState(s, app);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ log: s.log, initial: s.initial, current: s.state }));
    }
    if (url.pathname === "/__drop" && req.method === "POST") {
      if (!harness) return void res.writeHead(404).end();
      sessions.delete(url.searchParams.get("sid"));
      return void res.writeHead(204).end();
    }
    if (url.pathname === "/assets/ui.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      return void res.end(UI_JS);
    }
    if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();

    const cookies = parseCookies(req.headers.cookie);
    const s = sessions.get(cookies.bsid);
    if (!s) {
      res.writeHead(403, { "content-type": "text/html" });
      return void res.end("<h1>Session expired</h1>");
    }

    const seg = url.pathname.split("/")[1];
    const app = APPS[seg];
    if (!app) {
      res.writeHead(404, { "content-type": "text/html" });
      return void res.end("<h1>Not found</h1>");
    }
    const mutation = s.mutation && s.mutation.app === app.name ? s.mutation : null;
    const flags = mutation?.flags || {};

    // URL moves: the new path is served, the old one redirects (301).
    let path = url.pathname;
    const moves = flags.pathMove || [];
    for (const m of moves) {
      if (path === m.from || path.startsWith(`${m.from}/`)) {
        res.writeHead(301, { location: m.to + path.slice(m.from.length) + url.search });
        return void res.end();
      }
    }
    for (const m of moves) {
      if (path === m.to || path.startsWith(`${m.to}/`)) path = m.from + path.slice(m.to.length);
    }
    const rewriteUrl = (u) => {
      for (const m of moves) if (u === m.from || u.startsWith(`${m.from}/`) || u.startsWith(`${m.from}?`)) return m.to + u.slice(m.from.length);
      return u;
    };

    const form = req.method === "POST" ? Object.fromEntries(new URLSearchParams(await readBody(req))) : {};
    const setCookies = [];
    const ctx = {
      app: app.name,
      base: `/${app.name}`,
      path: path.slice(app.name.length + 1) || "/",
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      form,
      flags,
      cookies,
      fragment: url.searchParams.get("fragment") === "1",
      state: sessionState(s, app),
      auth: s.auth,
      setCookie: (name, value) => setCookies.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly`),
      log: (kind, data) => log(s, { app: app.name, kind, ...data }),
      change: (entity, id, field, from, to, extra = {}) => log(s, { app: app.name, kind: "change", entity, id, field, from, to, ...extra }),
    };

    const out = (await app.handle(ctx)) || { status: 404, text: "Not found" };
    const headers = {};
    if (setCookies.length) headers["set-cookie"] = setCookies;

    if (out.redirect) {
      headers.location = rewriteUrl(out.redirect);
      res.writeHead(303, headers);
      return void res.end();
    }
    if (out.file) {
      const body = Buffer.from(out.file.body);
      const sha = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
      log(s, { app: app.name, kind: "file", name: out.file.name, entity: out.file.entity, id: out.file.id, meta: out.file.meta || null, bytes: body.length, sha });
      headers["content-type"] = out.file.type;
      headers["content-disposition"] = `attachment; filename="${out.file.name}"`;
      res.writeHead(200, headers);
      return void res.end(body);
    }
    if (out.tree) {
      if (req.method === "GET") log(s, { app: app.name, kind: "view", path: ctx.path, shows: out.shows || null });
      const tree = applyOps(out.tree, mutation && { ...mutation, seed: mutation.seed ?? s.seed });
      let html = render(tree, rewriteUrl);
      if (!out.fragment) html = `<!doctype html>${html}`;
      headers["content-type"] = "text/html; charset=utf-8";
      if (out.spaUrl) headers["x-spa-url"] = rewriteUrl(out.spaUrl);
      res.writeHead(out.status || 200, headers);
      return void res.end(html);
    }
    headers["content-type"] = "text/plain";
    res.writeHead(out.status || 200, headers);
    res.end(out.text || "");
  }

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, init = {}) => {
    const r = await fetch(url + path, { ...init, headers: { "x-bench-secret": secret, "content-type": "application/json", ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.status === 204 ? null : r.json();
  };

  return {
    url,
    newSession: async ({ seed, mutation }) => (await call("/__session", { method: "POST", body: JSON.stringify({ seed, mutation }) })).sid,
    truth: (sid) => call(`/__truth?sid=${sid}`),
    drop: (sid) => call(`/__drop?sid=${sid}`, { method: "POST" }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srv = await startServer({ port: Number(process.env.PORT || 0), quiet: false });
  const sid = await srv.newSession({ seed: 1, mutation: null });
  console.log(`Fixture apps at ${srv.url}  (set cookie bsid=${sid} to browse)`);
}
