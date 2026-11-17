/**
 * Select to AI - what the setup pages share.
 *
 * Two things the welcome page, Settings, the popup and the agent page must
 * agree on:
 *
 * 1. Which provider a pasted key belongs to. The key's shape decides, and a
 *    key is only ever sent to that one provider. A second provider is tried
 *    only when the first answered a plain 401 and the user chose to try it.
 * 2. The data consent. Before the first request to a provider, the user is
 *    told in a short card what leaves the browser and to whom, and agrees.
 *    The answer is kept per provider in chrome.storage.local, so switching to
 *    a provider the user has not agreed to asks again.
 *
 * Loaded by extension pages (script tag, after defaults.js) and by Node
 * tests (require). It never sends anything itself.
 */
(function initSetup(root) {
  "use strict";

  const defaults = () => root.SELECT_TO_AI_DEFAULTS || {};

  const NAMES = Object.freeze({
    openrouter: "OpenRouter",
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Google Gemini",
    groq: "Groq",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    xai: "xAI",
    together: "Together AI",
    opencode: "OpenCode Zen",
    cerebras: "Cerebras",
    chatgpt: "ChatGPT",
    custom: "your own server",
  });

  /** A provider's name for people. Never "undefined". */
  function providerName(provider) {
    return NAMES[provider] || "your AI provider";
  }

  // ---------- keys ----------
  // Ordered: the first match wins, so specific shapes come before "sk-".
  // `alt` is the one other provider that issues the same shape. It is only
  // offered after a plain 401, never tried on its own.
  const KEY_SHAPES = Object.freeze([
    { re: /^sk-or-/, provider: "openrouter" },
    { re: /^sk-ant-/, provider: "anthropic" },
    // OpenAI project, service account and admin keys. DeepSeek issues none of these.
    { re: /^sk-(proj|svcacct|admin)-/, provider: "openai" },
    { re: /^oc_sk_/, provider: "opencode" },
    { re: /^(AIza|AQ\.)/, provider: "gemini" },
    { re: /^mstrl_/, provider: "mistral" },
    { re: /^gsk_/, provider: "groq" },
    { re: /^csk-/, provider: "cerebras" },
    { re: /^xai-/, provider: "xai" },
    { re: /^tgp_/, provider: "together" },
    // DeepSeek keys are "sk-" and 32 lowercase hex characters.
    { re: /^sk-[0-9a-f]{32}$/, provider: "deepseek", alt: "openai" },
    { re: /^sk-/, provider: "openai", alt: "deepseek" },
    // Mistral keys are 32 letters and digits with no prefix.
    { re: /^[A-Za-z0-9]{32}$/, provider: "mistral" },
  ]);

  /**
   * The provider a key belongs to: { provider, alt } where alt is the other
   * provider that issues the same shape (or null), or null if no provider
   * this page knows issues keys like it.
   */
  function routeKey(key) {
    const k = String(key || "").trim();
    if (!k) return null;
    for (const shape of KEY_SHAPES) {
      if (shape.re.test(k)) return { provider: shape.provider, alt: shape.alt || null };
    }
    return null;
  }

  /** The address a provider's API lives at, as an origin, or null. */
  function providerOrigin(provider, customUrl) {
    let base = "";
    if (provider === "custom") base = customUrl || "";
    else {
      const entry = (defaults().PROVIDER_ENDPOINTS || {})[provider];
      base = entry ? entry.baseUrl : "";
    }
    try {
      const u = new URL(base);
      return /^https?:$/.test(u.protocol) ? u.origin : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * The one small request that proves a key works: a tiny reply limit and "Hi".
   * It only ever names the provider it is given.
   */
  function testRequest(provider, key, model, customUrl) {
    const D = defaults();
    const base = provider === "custom" ? customUrl : ((D.PROVIDER_ENDPOINTS || {})[provider] || {}).baseUrl;
    if (!base) return null;
    // OpenAI's current models refuse max_tokens and want room to answer at all.
    const body = provider === "openai"
      ? { model, max_completion_tokens: 16, messages: [{ role: "user", content: "Hi" }] }
      : { model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
    if (provider === "anthropic") {
      const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
      if (key) headers["x-api-key"] = key;
      return { url: base, headers, body };
    }
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/arnav-goel10/select-to-ai";
      headers["X-Title"] = "Select to AI";
    }
    const url = /\/chat\/completions$/.test(base) ? base : `${base.replace(/\/$/, "")}/chat/completions`;
    return { url, headers, body };
  }

  /**
   * Checks a pasted key with the provider its shape names, and only that
   * one. `test(provider)` makes the request and resolves to
   * { ok, status, message, note }. Resolves to one of:
   *   { state: "unknown" }                      no provider issues keys like it
   *   { state: "ok", provider, note }
   *   { state: "failed", provider, error, alt } alt is set only after a plain
   *                                             401, for the user to choose
   */
  async function checkKey(key, test) {
    const route = routeKey(key);
    if (!route) return { state: "unknown" };
    let result;
    try {
      result = await test(route.provider);
    } catch (e) {
      result = { ok: false, message: e && e.name === "TimeoutError" ? "the provider did not answer in time" : String((e && e.message) || e) };
    }
    if (result && result.ok) return { state: "ok", provider: route.provider, note: result.note || "" };
    const error = result || { ok: false };
    return { state: "failed", provider: route.provider, error, alt: error.status === 401 ? route.alt : null };
  }

  /** What went wrong, naming the provider that said so. */
  function failureText(provider, error) {
    const e = error || {};
    const why = e.status === 401 || e.status === 403
      ? "the key was not accepted"
      : e.message ? String(e.message).slice(0, 160) : e.status ? `error ${e.status}` : "it could not be reached";
    return `${providerName(provider)} said ${why}. Check the key and try again.`;
  }

  // ---------- consent ----------
  const CONSENT_KEY = "agentDataConsent";

  /** The id a consent is kept under: the provider, or the server's address. */
  function consentId(provider, customUrl) {
    if (!provider) return null;
    if (provider !== "custom") return provider;
    const origin = providerOrigin("custom", customUrl);
    return origin ? `custom ${origin}` : null;
  }

  function hasConsent(store, id) {
    return !!(id && store && typeof store === "object" && store[id]);
  }

  /** The ids in `ids` the user has not agreed to yet. */
  function missingConsent(store, ids) {
    return [...new Set((ids || []).filter(Boolean))].filter((id) => !hasConsent(store, id));
  }

  function readConsent(storageLocal) {
    return new Promise((resolve) => {
      try {
        storageLocal.get(CONSENT_KEY, (r) => resolve((r && r[CONSENT_KEY]) || {}));
      } catch (_e) {
        resolve({});
      }
    });
  }

  /** Keeps the user's yes for each id and resolves to the whole record. */
  function recordConsent(storageLocal, ids) {
    return readConsent(storageLocal).then((store) => {
      const next = { ...store };
      for (const id of ids || []) if (id) next[id] = Date.now();
      return new Promise((resolve) => {
        try {
          storageLocal.set({ [CONSENT_KEY]: next }, () => resolve(next));
        } catch (_e) {
          resolve(next);
        }
      });
    });
  }

  function hostOf(origin) {
    try { return new URL(origin).host; } catch (_e) { return ""; }
  }

  function who(provider, customUrl) {
    const origin = providerOrigin(provider, customUrl);
    const host = hostOf(origin);
    if (provider === "custom") return host ? `your own server at ${host}` : "your own server";
    return host ? `${providerName(provider)} (${host})` : providerName(provider);
  }

  /**
   * The card's words: what leaves the browser and to whom, in three
   * sentences. `backup` is { provider, customUrl } when a backup provider
   * takes over once limits run out.
   */
  function consentText(provider, customUrl, backup) {
    const to = who(provider, customUrl) + (backup && backup.provider && backup.provider !== provider
      ? `, and to ${who(backup.provider, backup.customUrl)} when your limits run out`
      : "");
    const keeps = provider === "custom"
      ? "What your server keeps is up to you"
      : `What ${providerName(provider)} keeps is up to its own privacy terms`;
    return {
      title: "What the agent sends",
      sentences: [
        `To do a task, the agent sends your request, the text and addresses of the pages it works on, your open tabs' titles and addresses, what it remembers about you and, if your model reads images, screenshots to ${to}.`,
        "They go straight from this browser with your API key, and Select to AI has no server that sees them.",
        `${keeps}, and the privacy policy lists every detail.`,
      ],
    };
  }

  const PRIVACY_URL = "https://github.com/arnav-goel10/select-to-ai/blob/main/PRIVACY_POLICY.md";

  const CARD_STYLE = `
.consent-card { border: 1px solid var(--border-strong, #c9ccd1); border-radius: var(--radius-lg, 10px); background: var(--surface, #fff); color: var(--text, #111); padding: 14px 16px; margin: 10px 0; box-shadow: var(--shadow-xs, none); text-align: left; }
.consent-card h3 { margin: 0 0 6px; font-size: var(--text-base, 14px); font-weight: var(--weight-semibold, 600); }
.consent-card p { margin: 0 0 12px; color: var(--text-muted, #555); font-size: var(--text-sm, 13px); line-height: var(--leading-snug, 1.45); }
.consent-card p a { color: inherit; }
.consent-card .consent-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.consent-card .consent-note { margin: 10px 0 0; color: var(--danger, #b42318); font-size: var(--text-sm, 13px); }
.consent-card .consent-note:empty { display: none; }`;

  /**
   * The consent card as an element. onAgree runs inside the click, so a
   * permission request made in it still counts as the user's gesture. It
   * may return a promise that resolves to an error message (a string) to
   * show on the card, or to nothing when done.
   */
  function consentCard(doc, { provider, customUrl, backup, onAgree, onCancel, agreeLabel }) {
    if (!doc.getElementById("select-to-ai-consent-style")) {
      const style = doc.createElement("style");
      style.id = "select-to-ai-consent-style";
      style.textContent = CARD_STYLE;
      (doc.head || doc.documentElement).appendChild(style);
    }
    const t = consentText(provider, customUrl, backup);
    const card = doc.createElement("div");
    card.className = "consent-card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", t.title);
    const h = doc.createElement("h3");
    h.textContent = t.title;
    const p = doc.createElement("p");
    p.textContent = `${t.sentences[0]} ${t.sentences[1]} `;
    const last = t.sentences[2];
    const cut = last.lastIndexOf("privacy policy");
    p.append(last.slice(0, cut));
    const a = doc.createElement("a");
    a.href = PRIVACY_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "privacy policy";
    p.append(a, last.slice(cut + "privacy policy".length));
    const actions = doc.createElement("div");
    actions.className = "consent-actions";
    const yes = doc.createElement("button");
    yes.type = "button";
    yes.className = "btn btn-primary consent-agree";
    yes.textContent = agreeLabel || "Agree and continue";
    const no = doc.createElement("button");
    no.type = "button";
    no.className = "btn btn-ghost consent-cancel";
    no.textContent = "Not now";
    const note = doc.createElement("p");
    note.className = "consent-note";
    note.setAttribute("role", "status");
    yes.addEventListener("click", () => {
      yes.disabled = true;
      note.textContent = "";
      Promise.resolve(onAgree && onAgree()).then((problem) => {
        if (typeof problem === "string" && problem) { note.textContent = problem; yes.disabled = false; }
      }, (e) => { note.textContent = String((e && e.message) || e); yes.disabled = false; });
    });
    no.addEventListener("click", () => { if (onCancel) onCancel(); card.remove(); });
    actions.append(yes, no);
    card.append(h, p, actions, note);
    return card;
  }

  // ---------- grants ----------
  /**
   * Asks Chrome for the provider's API host, from the click that needs it.
   * Resolves true when the extension may reach it. Nothing is awaited before
   * the request, so it stays inside the user's gesture.
   */
  function requestProviderHost(provider, customUrl) {
    const origin = providerOrigin(provider, customUrl);
    const grants = root.SELECT_TO_AI_GRANTS;
    if (!origin || !grants) return Promise.resolve(!origin);
    return grants.requestHost(origin);
  }

  function hasProviderHost(provider, customUrl) {
    const origin = providerOrigin(provider, customUrl);
    const grants = root.SELECT_TO_AI_GRANTS;
    if (!origin || !grants) return Promise.resolve(!origin);
    return grants.hasHost(origin);
  }

  /**
   * What Chrome is asked for when a first task is clicked: the one site that
   * task works on, with its own subdomains, and nothing else.
   * "wikipedia.org" -> ["https://*.wikipedia.org/*"]. Every other site is
   * asked for when the agent first reaches it (the site-access card), and
   * notifications when the user turns task notices on in Settings.
   * Null for anything that is not a plain host name.
   */
  function siteAccess(site) {
    const host = String(site || "").trim().toLowerCase();
    if (host.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return null;
    return [`https://*.${host}/*`];
  }

  const api = Object.freeze({
    NAMES, KEY_SHAPES, CONSENT_KEY, PRIVACY_URL, siteAccess,
    providerName, routeKey, providerOrigin, testRequest, checkKey, failureText,
    consentId, hasConsent, missingConsent, readConsent, recordConsent, consentText, consentCard,
    requestProviderHost, hasProviderHost,
  });
  root.SELECT_TO_AI_SETUP = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
