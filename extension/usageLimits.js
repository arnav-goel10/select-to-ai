/**
 * Turns a provider's "you have hit a limit" reply into a message a person can
 * act on: what ran out, when it comes back, and what to do meanwhile. Pure,
 * so the agent page, the key tests in onboarding and Settings, and the unit
 * tests share one reading of it.
 *
 * OpenRouter reports the free-model daily limit as HTTP 429 with the limit and
 * reset time both in X-RateLimit-* headers and in error.metadata.headers.
 * Other providers use 402 (no credit) or 429 with "quota" / "billing" wording.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SELECT_TO_AI_LIMITS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NAMES = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini", gemini: "Google Gemini", groq: "Groq", mistral: "Mistral", deepseek: "DeepSeek", xai: "xAI", opencode: "OpenCode", cerebras: "Cerebras" };

  function parseBody(bodyText) {
    if (!bodyText) return {};
    if (typeof bodyText === "object") return bodyText;
    try { return JSON.parse(String(bodyText)); } catch (_e) { return { error: { message: String(bodyText) } }; }
  }

  function header(headers, name) {
    if (!headers) return undefined;
    const want = name.toLowerCase();
    for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
    return undefined;
  }

  /** Reset time as epoch ms, from ms or seconds epochs, or seconds-from-now. */
  function parseReset(value, now) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n > 1e12) return n;          // epoch ms
    if (n > 1e9) return n * 1000;    // epoch seconds
    return now + n * 1000;           // seconds from now
  }

  function formatWhen(resetAt, now) {
    const mins = Math.max(1, Math.round((resetAt - now) / 60000));
    const rel = mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}`
      : mins < 90 ? "about an hour"
      : mins < 60 * 36 ? `about ${Math.round(mins / 60)} hours`
      : `about ${Math.round(mins / 1440)} days`;
    let clock = "";
    try {
      clock = new Date(resetAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      if (mins >= 60 * 20) clock = `${new Date(resetAt).toLocaleDateString(undefined, { weekday: "long" })} ${clock}`;
    } catch (_e) { /* no Intl */ }
    return { clock, rel };
  }

  /**
   * Returns null when the error is not a usage limit (so the caller keeps its
   * ordinary retry and error handling), else
   * { kind, title, message, resetAt, limit, retry: false }.
   * message is Markdown.
   */
  function describeLimit({ provider = "", model = "", status = 0, body = "", headers = {}, now = Date.now() } = {}) {
    const data = parseBody(body);
    const err = (data && data.error) || {};
    const msg = String(err.message || err.status || (typeof data.message === "string" ? data.message : "") || "");
    const meta = err.metadata || {};
    const metaHeaders = meta.headers || {};
    const limit = Number(header(headers, "x-ratelimit-limit") || header(metaHeaders, "x-ratelimit-limit")) || null;
    const remaining = header(headers, "x-ratelimit-remaining") ?? header(metaHeaders, "x-ratelimit-remaining");
    const resetAt = parseReset(header(headers, "x-ratelimit-reset") || header(metaHeaders, "x-ratelimit-reset"), now);
    const name = NAMES[String(provider).toLowerCase()] || provider || "The provider";
    const isFree = /free/i.test(`${model} ${msg} ${meta.limit_source || ""}`);

    const noCredit = status === 402 || /insufficient[_ ](quota|credit|balance)|out of credits?|billing|credit balance|payment required/i.test(msg);
    // An allowance counted by the minute is back within the minute: that is a
    // pause, not a spent day. The reply says which it is, in its quota name
    // ("...PerMinute...") or in how soon it asks to be tried again.
    const raw = typeof body === "string" ? body : JSON.stringify(body || "");
    const soon = raw.match(/retry(?:Delay|[- ]after)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s|(?:try again|retry(?: again)?) in\s+(\d+(?:\.\d+)?)\s*s/i);
    const byTheMinute = /per[- ]?minute|PerMinute/.test(raw) && !/per[- ]?day|PerDay/i.test(raw) || (soon && parseFloat(soon[1] || soon[2]) <= 65);
    const daily = status === 429 && !byTheMinute && (/per[- ]?day|daily|quota|free[- ]tier/i.test(`${msg} ${meta.limit_source || ""}`) ||
      (String(remaining) === "0" && resetAt && resetAt - now > 10 * 60000));
    if (!noCredit && !daily) return null;

    if (noCredit && !daily) {
      return {
        kind: "no-credit",
        title: `${name} account is out of credit`,
        message: `**Your ${name} account is out of credit.**\n\nAdd credit or check your plan on ${name}'s site, then try again. Free models keep working on OpenRouter without credit.`,
        short: `Your ${name} account is out of credit.`,
        resetAt: null, limit: null, retry: false,
      };
    }

    const when = resetAt ? formatWhen(resetAt, now) : null;
    const back = when ? `They come back at **${when.clock}** (in ${when.rel}).` : "They come back tomorrow.";
    if (String(provider).toLowerCase() === "openrouter" && isFree) {
      const lines = [
        "**Today's free OpenRouter requests are used up.**",
        "",
        `${limit ? `Your key gets ${limit.toLocaleString("en-US")} free requests a day, and they have all been used.` : "Your key has used all of today's free requests."} ${back}`,
        "",
        limit && limit <= 200
          ? "To get 1,000 free requests a day, add $10 of credit once on [OpenRouter](https://openrouter.ai/settings/credits); free models stay free. To keep going now, choose a paid model in Settings."
          : "To keep going now, choose a paid model in Settings (it uses your OpenRouter credit), or connect another provider.",
      ];
      return {
        kind: "free-daily", title: "Today's free OpenRouter requests are used up", message: lines.join("\n"),
        short: `Today's free OpenRouter requests are used up; they come back ${when ? `at ${when.clock} (in ${when.rel})` : "tomorrow"}.`,
        resetAt, limit, retry: false,
      };
    }
    return {
      kind: "daily",
      title: `${name} usage limit reached`,
      message: `**${name} says this key has reached its usage limit.**\n\n${when ? `It resets at **${when.clock}** (in ${when.rel}).` : "Check your plan's limits on their site."} Meanwhile you can choose another model or provider in Settings.`,
      short: `${name} says this key has reached its usage limit${when ? `; it resets at ${when.clock}` : ""}.`,
      resetAt, limit, retry: false,
    };
  }

  /** A reset as epoch ms, from an epoch, seconds from now, or a span such as "1h2m3.5s". */
  function parseSpan(value, now) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) return parseReset(text, now);
    let ms = 0;
    let read = "";
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) { ms += parseFloat(m[1]) * { h: 3600000, m: 60000, s: 1000, ms: 1 }[m[2]]; read += m[0]; }
    return read && read === text ? now + ms : null;
  }

  // Where providers say how many requests are left: a count, its limit and
  // when it starts again. The day's count is read before a general one.
  const ALLOWANCE_HEADERS = [
    ["x-ratelimit-remaining-requests-day", "x-ratelimit-limit-requests-day", "x-ratelimit-reset-requests-day"],
    ["x-ratelimit-remaining", "x-ratelimit-limit", "x-ratelimit-reset"],
    ["x-ratelimit-remaining-requests", "x-ratelimit-limit-requests", "x-ratelimit-reset-requests"],
  ];
  // A count that starts again within this long is a pace (requests a
  // minute), not an allowance anyone needs to watch.
  const PACE_MS = 10 * 60000;

  /**
   * What is left of the requests a key may make, when a reply's headers say
   * so: {remaining, limit, resetAt}. Null when they do not, when they do
   * not say when the count starts again, or when that is minutes away.
   */
  function readAllowance(headers, now = Date.now()) {
    for (const [left, of, reset] of ALLOWANCE_HEADERS) {
      const remaining = header(headers, left);
      const limit = Number(header(headers, of));
      if (remaining === undefined || remaining === "" || !Number.isFinite(Number(remaining)) || !(limit > 0)) continue;
      const resetAt = parseSpan(header(headers, reset), now);
      if (!resetAt || resetAt - now <= PACE_MS) continue;
      return { remaining: Math.max(0, Math.floor(Number(remaining))), limit, resetAt };
    }
    return null;
  }

  return { describeLimit, readAllowance };
});
