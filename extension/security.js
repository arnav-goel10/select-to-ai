/**
 * Security policy shared by the extension service worker and Node.js tests.
 * Keep this module dependency-free so the same validation runs in production.
 */
(function initSecurityPolicy(root) {
  "use strict";

  const PROVIDER_ORIGINS = new Set([
    "https://opencode.ai",
    "https://openrouter.ai",
    "https://api.anthropic.com",
    "https://api.openai.com",
    "https://api.deepseek.com",
    "https://generativelanguage.googleapis.com",
    "https://api.mistral.ai",
    "https://api.groq.com",
    "https://api.together.xyz",
    "https://api.x.ai",
  ]);

  const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;

  function parseHttpUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      if (url.username || url.password) return null;
      return url;
    } catch (_error) {
      return null;
    }
  }

  function isLoopback(url) {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }

  function customOrigin(customBaseUrl) {
    const parsed = parseHttpUrl(customBaseUrl);
    if (!parsed) return null;
    if (parsed.protocol !== "https:" && !isLoopback(parsed)) return null;
    return parsed.origin;
  }

  function validateProviderUrl(rawUrl, customBaseUrl) {
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed) {
      return { ok: false, error: "Invalid or unsupported provider URL." };
    }

    if (PROVIDER_ORIGINS.has(parsed.origin)) {
      return { ok: true, url: parsed.toString() };
    }

    const allowedCustomOrigin = customOrigin(customBaseUrl);
    if (allowedCustomOrigin && parsed.origin === allowedCustomOrigin) {
      return { ok: true, url: parsed.toString() };
    }

    return {
      ok: false,
      error: "Destination is not an approved AI provider or configured custom gateway.",
    };
  }

  function validateProxyOptions(options) {
    const normalized = options && typeof options === "object" ? options : {};
    const method = String(normalized.method || "GET").toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
      return { ok: false, error: "Only GET and POST provider requests are allowed." };
    }

    if (normalized.body != null) {
      if (typeof normalized.body !== "string") {
        return { ok: false, error: "Provider request bodies must be strings." };
      }
      if (new TextEncoder().encode(normalized.body).byteLength > MAX_PROXY_BODY_BYTES) {
        return { ok: false, error: "Provider request exceeds the 2 MiB safety limit." };
      }
    }

    return {
      ok: true,
      options: {
        method,
        headers:
          normalized.headers && typeof normalized.headers === "object"
            ? normalized.headers
            : {},
        ...(normalized.body == null ? {} : { body: normalized.body }),
        credentials: "omit",
        cache: "no-store",
      },
    };
  }

  function isTrustedExtensionSender(sender, runtimeId) {
    if (!sender || sender.id !== runtimeId || typeof sender.url !== "string") {
      return false;
    }
    return sender.url.startsWith(`chrome-extension://${runtimeId}/`);
  }

  function parseDomainAllowlist(value) {
    return [...new Set(
      String(value || "")
        .split(/[\s,]+/)
        .map((domain) => domain.trim().toLowerCase().replace(/^\*\./, ""))
        .filter(Boolean),
    )];
  }

  function isUrlAllowedByDomains(rawUrl, allowlistValue) {
    const domains = parseDomainAllowlist(allowlistValue);
    if (domains.length === 0) return true;
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed) return false;
    const hostname = parsed.hostname.toLowerCase();
    return domains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  }

  const api = Object.freeze({
    MAX_PROXY_BODY_BYTES,
    PROVIDER_ORIGINS,
    customOrigin,
    isTrustedExtensionSender,
    isUrlAllowedByDomains,
    parseDomainAllowlist,
    validateProviderUrl,
    validateProxyOptions,
  });

  root.SELECT_TO_AI_SECURITY = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
