/**
 * Select to AI - Sign in with ChatGPT, for using the user's own ChatGPT plan.
 *
 * Follows OpenAI's flow for open-source and locally run apps
 * (developers.openai.com/siwc/token-sharing-open-source): an authorization
 * code with PKCE, a loopback redirect on 127.0.0.1, the code exchanged for
 * tokens, the ID token checked against OpenAI's published keys, and the
 * access token refreshed before it runs out.
 *
 * No chrome.* calls: fetch, the clock, random bytes and storage come in, so
 * the same code runs in the service worker and in tests. The extension's
 * own part (opening the sign-in tab, reading the redirect, keeping the
 * tokens encrypted) is chatgptConnect.js.
 */
(function initChatGPTAuth(root) {
  "use strict";

  const ISSUER = "https://auth.openai.com";
  const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
  const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
  // From https://auth.openai.com/.well-known/openid-configuration.
  const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
  const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
  const API_BASE = "https://api.openai.com/v1";
  const RESOURCE = API_BASE;
  const MODELS_URL = `${API_BASE}/models`;
  const RESPONSES_URL = `${API_BASE}/responses`;
  const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const PLAN_SCOPE = "chatgpt.tokens.use.direct";
  // The first-time registration entry point. It is never saved or used for a token exchange.
  const REGISTRATION_CLIENT = "dynamic_agent_client";
  const APP_NAME = "Select to AI";
  // Only the port may change between attempts; the scheme, host and path stay fixed.
  const CALLBACK_HOST = "127.0.0.1";
  const CALLBACK_PATH = "/auth/callback";
  const USAGE_URL = "https://chatgpt.com/settings/usage";
  // The only two places a ChatGPT token is ever sent.
  const ORIGINS = Object.freeze(["https://auth.openai.com", "https://api.openai.com"]);
  // A token this close to its expiry is renewed before it is used.
  const REFRESH_MARGIN_MS = 2 * 60 * 1000;
  const CLOCK_SKEW_S = 5;
  // Refresh-token errors that mean the sign-in is over (errors-and-recovery page).
  const ENDED = /^(invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused)$/;

  class AuthError extends Error {
    constructor(kind, message, code) {
      super(message);
      this.name = "AuthError";
      // "declined", "state", "signed_out", "unreachable", "config", "account", "invalid"
      this.kind = kind;
      this.code = code || "";
    }
  }

  // ------------------------------------------------------------- encoding

  function b64url(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (const b of arr) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(text) {
    const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  const randomToken = (random) => b64url(random(32));

  /** A UUIDv4 from random bytes, as the host identifier's `urn:uuid:` form. */
  function newHostId(random) {
    const b = random(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const redirectUriFor = (port) => `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;

  /** A port in the dynamic range, chosen afresh for each attempt. */
  function pickPort(random) {
    const b = random(2);
    return 49152 + (((b[0] << 8) | b[1]) % 16384);
  }

  // ---------------------------------------------------------- authorizing

  /**
   * The authorization URL for one attempt, and what must be kept until its
   * redirect comes back.
   * @param o.hostId        this installation's ext_agent_host_id
   * @param o.registration  the saved registration {clientId, sub, email, idToken}, or null for a first sign-in
   * @param o.consent       true to ask for consent again (turning plan usage on after a decline)
   */
  async function startAttempt(o) {
    const random = o.random;
    const subtle = o.subtle;
    if (!o.hostId) throw new AuthError("config", "This installation has no host identifier yet.");
    const reg = o.registration && o.registration.clientId ? o.registration : null;
    const state = randomToken(random);
    const nonce = randomToken(random);
    const verifier = randomToken(random);
    const challenge = b64url(await subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const redirectUri = redirectUriFor(o.port || pickPort(random));
    const params = new URLSearchParams();
    params.set("client_id", reg ? reg.clientId : REGISTRATION_CLIENT);
    if (!reg) params.set("agent_name_hint", APP_NAME);
    params.set("ext_agent_host_id", o.hostId);
    if (reg && reg.idToken) params.set("id_token_hint", reg.idToken);
    if (reg && reg.email) params.set("login_hint", reg.email);
    params.set("response_type", "code");
    params.set("redirect_uri", redirectUri);
    params.set("scope", SCOPE);
    params.set("resource", RESOURCE);
    params.set("state", state);
    params.set("nonce", nonce);
    params.set("code_challenge_method", "S256");
    params.set("code_challenge", challenge);
    if (o.consent) params.set("prompt", "consent");
    return {
      url: `${AUTHORIZE_URL}?${params.toString()}`,
      pending: { state, nonce, verifier, redirectUri, clientId: reg ? reg.clientId : "", sub: reg ? reg.sub || "" : "", registering: !reg, startedAt: o.now || 0 },
    };
  }

  /** True when a tab's address is this attempt's redirect, whatever it carries. */
  function isCallback(rawUrl, pending) {
    if (!pending || !pending.redirectUri) return false;
    try {
      const u = new URL(rawUrl);
      const r = new URL(pending.redirectUri);
      return u.protocol === r.protocol && u.host === r.host && u.pathname === r.pathname;
    } catch (_e) {
      return false;
    }
  }

  /**
   * What the redirect carried: {code, clientId, scope}. Throws an AuthError
   * for a redirect that is not this attempt's, a declined consent, or a
   * registration that did not finish.
   */
  function readCallback(rawUrl, pending) {
    if (!isCallback(rawUrl, pending)) throw new AuthError("state", "The sign-in came back to an address it was not sent to.");
    const q = new URL(rawUrl).searchParams;
    if (!q.get("state") || q.get("state") !== pending.state) throw new AuthError("state", "The sign-in reply did not match this sign-in attempt, so it was not used. Try again.");
    const error = q.get("error");
    if (error === "access_denied") throw new AuthError("declined", "ChatGPT plan use was not allowed, so nothing was connected.", error);
    if (error) throw new AuthError("invalid", `ChatGPT sign-in stopped: ${q.get("error_description") || error}.`, error);
    const code = q.get("code");
    if (!code) throw new AuthError("invalid", "ChatGPT sent back no sign-in code.");
    const returned = q.get("client_id") || "";
    let clientId = pending.clientId;
    if (pending.registering) {
      if (!returned || returned === REGISTRATION_CLIENT) throw new AuthError("invalid", "ChatGPT did not finish registering Select to AI. Try again.");
      clientId = returned;
    } else if (returned && returned !== pending.clientId) {
      throw new AuthError("account", "ChatGPT answered for a different registration than the saved one, so it was not used.");
    }
    return { code, clientId, scope: q.get("scope") || "" };
  }

  // ------------------------------------------------------------ requests

  /** fetch, but only to OpenAI's sign-in and API origins, and never with cookies. */
  async function send(deps, url, init) {
    let origin = "";
    try { origin = new URL(url).origin; } catch (_e) { /* not a URL */ }
    if (!ORIGINS.includes(origin)) throw new AuthError("config", "A ChatGPT token may only go to auth.openai.com or api.openai.com.");
    return deps.fetch(url, { ...(init || {}), credentials: "omit", cache: "no-store" });
  }

  async function formPost(deps, url, fields) {
    let res;
    try {
      res = await send(deps, url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("unreachable", "Couldn't reach ChatGPT's sign-in service. Check your connection and try again.");
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : {}; } catch (_e) { body = { error_description: text.slice(0, 200) }; }
    if (!res.ok) {
      const err = body && body.error;
      const code = typeof err === "string" ? err : (err && err.code) || "";
      const said = (body && (body.error_description || (err && err.message))) || `HTTP ${res.status}`;
      const e = new AuthError(res.status >= 500 ? "unreachable" : "invalid", said, code);
      e.status = res.status;
      throw e;
    }
    return body || {};
  }

  function exchangeCode(deps, pending, callback) {
    return formPost(deps, TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: RESOURCE,
    });
  }

  function refreshTokens(deps, cred) {
    return formPost(deps, TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: cred.client_id,
      refresh_token: cred.refresh_token,
      resource: RESOURCE,
    });
  }

  /** Ends the renewable session. True when OpenAI confirmed it. */
  async function revoke(deps, cred) {
    if (!cred || !cred.refresh_token || !cred.client_id) return false;
    try {
      const res = await send(deps, REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: cred.refresh_token, token_type_hint: "refresh_token", client_id: cred.client_id }).toString(),
      });
      return res.status === 200;
    } catch (_e) {
      return false;
    }
  }

  // ------------------------------------------------------------ ID token

  const jwksCache = { keys: null, at: 0 };

  async function signingKey(deps, kid) {
    const find = () => (jwksCache.keys || []).find((k) => k.kid === kid);
    // Keys are cached for an hour, and fetched again for a key id not seen before.
    if (!find() || (deps.now ? deps.now() : Date.now()) - jwksCache.at > 3600 * 1000) {
      let res;
      try { res = await send(deps, JWKS_URL, { method: "GET" }); } catch (_e) { throw new AuthError("unreachable", "Couldn't reach ChatGPT's sign-in service to check the sign-in."); }
      if (!res.ok) throw new AuthError("unreachable", "Couldn't load ChatGPT's signing keys to check the sign-in.");
      const data = JSON.parse(await res.text());
      jwksCache.keys = Array.isArray(data.keys) ? data.keys : [];
      jwksCache.at = deps.now ? deps.now() : Date.now();
    }
    const jwk = find();
    if (!jwk) throw new AuthError("invalid", "The sign-in was signed with a key ChatGPT does not publish.");
    return deps.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }

  /** The claims of a JWT, unchecked. */
  function decodeJwt(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw new AuthError("invalid", "The sign-in token is malformed.");
    const json = (s) => JSON.parse(new TextDecoder().decode(unb64url(s)));
    return { header: json(parts[0]), payload: json(parts[1]), signed: `${parts[0]}.${parts[1]}`, signature: unb64url(parts[2]) };
  }

  /**
   * Checks the ID token's signature against OpenAI's keys, its issuer, its
   * audience (the issued client ID), its expiry and the attempt's nonce.
   * Returns its claims.
   */
  async function verifyIdToken(deps, idToken, expect) {
    const jwt = decodeJwt(idToken);
    if (jwt.header.alg !== "RS256") throw new AuthError("invalid", "The sign-in token uses an unexpected signature.");
    const key = await signingKey(deps, jwt.header.kid);
    const ok = await deps.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, jwt.signature, new TextEncoder().encode(jwt.signed));
    if (!ok) throw new AuthError("invalid", "The sign-in token's signature did not check out.");
    const c = jwt.payload;
    const nowS = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== ISSUER) throw new AuthError("invalid", "The sign-in token was not issued by ChatGPT.");
    if (!aud.includes(expect.clientId)) throw new AuthError("invalid", "The sign-in token was issued to a different app.");
    if (typeof c.exp !== "number" || c.exp + CLOCK_SKEW_S < nowS) throw new AuthError("invalid", "The sign-in token has expired. Try again.");
    if (c.nonce !== expect.nonce) throw new AuthError("invalid", "The sign-in token does not belong to this attempt.");
    if (typeof c.sub !== "string" || !c.sub) throw new AuthError("invalid", "The sign-in token names no account.");
    return c;
  }

  // ---------------------------------------------------------- credentials

  const scopesOf = (text) => String(text || "").split(/\s+/).filter(Boolean).sort();
  const planEnabled = (scopes) => (scopes || []).includes(PLAN_SCOPE);

  /** The record kept for a signed-in account, from a token response and its checked ID token. */
  function credentialFrom(tokens, claims, clientId, hostId, now) {
    const expiresIn = Number(tokens.expires_in) || 3600;
    return {
      email: claims.email || "",
      issuer: ISSUER,
      subject: claims.sub,
      client_id: clientId,
      ext_agent_host_id: hostId,
      id_token: tokens.id_token || "",
      access_token: tokens.access_token || "",
      refresh_token: tokens.refresh_token || "",
      token_type: tokens.token_type || "Bearer",
      expires_in: expiresIn,
      expires_at: now + expiresIn * 1000,
      scopes: scopesOf(tokens.scope),
      saved_at: new Date(now).toISOString(),
    };
  }

  /** The record after a refresh: access token, expiry, scopes and the rotating refresh token replaced together. */
  function refreshedCredential(cred, tokens, now) {
    const expiresIn = Number(tokens.expires_in) || 3600;
    return {
      ...cred,
      access_token: tokens.access_token || "",
      refresh_token: tokens.refresh_token || cred.refresh_token,
      id_token: tokens.id_token || cred.id_token,
      expires_in: expiresIn,
      expires_at: now + expiresIn * 1000,
      scopes: tokens.scope ? scopesOf(tokens.scope) : cred.scopes,
      saved_at: new Date(now).toISOString(),
    };
  }

  /**
   * Hands out a current access token, refreshing it near its expiry or when
   * asked to (after a 401). Refreshes are one at a time, so a rotating
   * refresh token is never spent twice.
   * @param o {fetch, now, load(): cred|null, save(cred), ended(cred)}
   */
  function createTokenSource(o) {
    let inflight = null;
    async function run(force) {
      const cred = await o.load();
      if (!cred || !cred.access_token) throw new AuthError("signed_out", "Sign in with ChatGPT in Settings first.");
      if (!force && cred.expires_at - o.now() > REFRESH_MARGIN_MS) return cred.access_token;
      if (!cred.refresh_token) throw new AuthError("signed_out", "Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings.");
      try {
        const next = refreshedCredential(cred, await refreshTokens(o, cred), o.now());
        if (!next.access_token) throw new AuthError("invalid", "ChatGPT renewed the sign-in without an access token.");
        await o.save(next);
        return next.access_token;
      } catch (e) {
        if (e.code === "invalid_client") throw new AuthError("config", "ChatGPT no longer recognizes this app's registration. Sign in with ChatGPT again in Settings.", e.code);
        if (ENDED.test(e.code || "")) {
          await o.ended(cred);
          throw new AuthError("signed_out", "Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings.", e.code);
        }
        // A network or server failure is not a sign-out: the old token serves while it lasts.
        if (!force && cred.expires_at > o.now()) return cred.access_token;
        throw new AuthError(e.kind === "unreachable" ? "unreachable" : "signed_out", e.kind === "unreachable" ? "Couldn't reach ChatGPT to renew the sign-in. Check your connection, or try again in a minute." : `ChatGPT did not renew the sign-in: ${e.message}`, e.code);
      }
    }
    return {
      accessToken(force) {
        if (!inflight) inflight = run(!!force).finally(() => { inflight = null; });
        return inflight;
      },
    };
  }

  // -------------------------------------------------------------- models

  /** The account's models for display, in the server's order: [{slug, name}]. */
  async function listModels(deps, accessToken) {
    let res;
    try {
      res = await send(deps, MODELS_URL, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("unreachable", "Couldn't reach ChatGPT to list your models.");
    }
    const text = await res.text();
    if (!res.ok) {
      const e = new AuthError(res.status === 401 ? "signed_out" : "invalid", `ChatGPT did not list your models (HTTP ${res.status}).`);
      e.status = res.status;
      throw e;
    }
    let data = {};
    try { data = JSON.parse(text); } catch (_e) { /* not JSON */ }
    const rows = Array.isArray(data.models) ? data.models : [];
    return rows
      .filter((m) => m && m.visibility === "list" && typeof m.slug === "string" && m.slug)
      .map((m) => ({ slug: m.slug, name: String(m.display_name || m.slug) }));
  }

  const SMALL = /(?:^|[-_.])(mini|nano|lite|instant|spark|fast|small)(?:$|[-_.])/i;
  const versionOf = (slug) => { const m = String(slug).match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };

  /**
   * The listed model the agent runs on by default: a full-size general
   * model of the newest version. Coding-tuned models come after general
   * ones, since the agent's work is reading and operating web pages. On a
   * tie, the server's order decides.
   */
  function bestModel(models) {
    const list = (models || []).map((m, i) => ({ slug: m.slug, i }));
    if (!list.length) return "";
    const rank = (m) => [SMALL.test(m.slug) ? 1 : 0, /codex/i.test(m.slug) ? 1 : 0, -versionOf(m.slug), m.i];
    list.sort((a, b) => { const x = rank(a); const y = rank(b); for (let k = 0; k < x.length; k += 1) if (x[k] !== y[k]) return x[k] - y[k]; return 0; });
    return list[0].slug;
  }

  /** A listed small model of the newest version for the lighter calls, or "". */
  function liteModel(models) {
    const small = (models || []).map((m, i) => ({ slug: m.slug, i })).filter((m) => SMALL.test(m.slug) && !/codex/i.test(m.slug));
    small.sort((a, b) => versionOf(b.slug) - versionOf(a.slug) || a.i - b.i);
    return small.length ? small[0].slug : "";
  }

  // -------------------------------------------------------------- errors

  /** The Responses error code and its usual HTTP status, from an error reply's body. */
  function errorOf(raw) {
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      const err = obj && (obj.error || (obj.response && obj.response.error));
      if (err && typeof err === "object") return { code: String(err.code || ""), param: String(err.param || ""), message: String(err.message || "") };
      if (obj && obj.detail) return { code: "", param: "", message: String(obj.detail) };
    } catch (_e) { /* not JSON */ }
    return { code: "", param: "", message: "" };
  }

  // The HTTP status each documented code arrives with, for one that arrives inside the stream.
  const CODE_STATUS = Object.freeze({
    subscription_sharing_user_not_eligible: 403,
    subscription_sharing_usage_limit_exceeded: 429,
    subscription_sharing_usage_unavailable: 503,
    subscription_sharing_unsupported_capability: 400,
    subscription_sharing_route_not_supported: 403,
    subscription_sharing_invalid_user: 401,
    chatpass_v2_scope_not_authorized: 403,
    chatpass_v2_invalid_authorization_context: 403,
    subscription_sharing_user_unavailable: 503,
  });
  const statusForCode = (code) => CODE_STATUS[code] || 500;

  const api = Object.freeze({
    ISSUER, AUTHORIZE_URL, TOKEN_URL, REVOKE_URL, JWKS_URL, API_BASE, RESOURCE, MODELS_URL, RESPONSES_URL,
    SCOPE, PLAN_SCOPE, REGISTRATION_CLIENT, APP_NAME, CALLBACK_HOST, CALLBACK_PATH, USAGE_URL, ORIGINS,
    AuthError, b64url, newHostId, redirectUriFor, pickPort, startAttempt, isCallback, readCallback,
    send, exchangeCode, refreshTokens, revoke, decodeJwt, verifyIdToken, credentialFrom, refreshedCredential,
    planEnabled, createTokenSource, listModels, bestModel, liteModel, errorOf, statusForCode, jwksCache,
  });
  root.SELECT_TO_AI_CHATGPT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
