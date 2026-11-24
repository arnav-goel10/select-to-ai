/**
 * Select to AI - asking a model for a tool call.
 *
 * One function, `call`, for every provider the extension supports
 * (OpenAI-compatible chat completions, Anthropic messages, and OpenAI's
 * Responses API for a user signed in with ChatGPT). It streams
 * the reply, reads the tool call out of it, and deals with what providers
 * do in practice: a model that is busy, a key that is out of requests, a
 * gateway that rejects tools or extra fields, a reply cut off before the
 * tool call, a reply in prose.
 *
 * It resolves with {reply, text, usage, model} or rejects with a ModelError
 * whose `kind` says what the user can do about it: "auth", "limit",
 * "rate_limited" (with waitMs: how long the provider asked to wait, or 0
 * when it did not say), "unreachable", "invalid", "config" or "aborted".
 *
 * No chrome.* calls: fetch, the clock and the settings come in, so the same
 * code runs in the service worker and in tests.
 */
(function initLlm(root) {
  "use strict";

  const need = (name, file) => root[name] || (typeof require === "function" ? require(file) : null);
  const TOOLS = need("SELECT_TO_AI_TOOLS", "../agentTools.js");
  const DEFAULTS = need("SELECT_TO_AI_DEFAULTS", "../defaults.js");
  const LIMITS = need("SELECT_TO_AI_LIMITS", "../usageLimits.js");
  const SECURITY = need("SELECT_TO_AI_SECURITY", "../security.js");
  // Sign in with ChatGPT is not in the 4.0 package. Its module, when present
  // in a development build, is picked up here; otherwise the provider is refused.
  const CHATGPT = (() => { try { return need("SELECT_TO_AI_CHATGPT", "../chatgptAuth.js"); } catch (e) { return null; } })();

  const clip = (t, n) => { const v = String(t == null ? "" : t).replace(/\s+/g, " ").trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

  class ModelError extends Error {
    constructor(kind, message, extra) {
      super(message);
      this.name = "ModelError";
      this.kind = kind;
      Object.assign(this, extra || {});
    }
  }

  const NAMES = Object.freeze({
    openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini", groq: "Groq", deepseek: "DeepSeek",
    mistral: "Mistral", xai: "xAI", together: "Together AI", opencode: "OpenCode", cerebras: "Cerebras", chatgpt: "ChatGPT", custom: "Your server",
  });
  const providerName = (p) => NAMES[p] || "The AI provider";

  // ---------------------------------------------------------------- settings

  function modelFits(provider, model) {
    if (!model) return false;
    // ChatGPT's models are checked against the signed-in account's own list (settingsFrom).
    if (["custom", "openrouter", "opencode", "chatgpt"].includes(provider)) return true;
    if (provider === "anthropic") return model.startsWith("claude-");
    if (provider === "openai") return /^(gpt-|o\d|chatgpt-)/.test(model);
    if (provider === "deepseek") return model.startsWith("deepseek-");
    if (provider === "gemini") return model.startsWith("gemini-");
    if (provider === "mistral") return /mistral|ministral|codestral|magistral|devstral/.test(model);
    if (provider === "groq") return /^(llama|mixtral|gemma|qwen|deepseek|moonshot|gpt-oss)/.test(model) || model.includes("/");
    if (provider === "together") return model.includes("/");
    if (provider === "cerebras") return /^(gpt-oss|qwen|llama|zai|glm)/.test(model);
    if (provider === "xai") return model.startsWith("grok-");
    return true;
  }

  /** Why a saved key cannot be right, or "" when it could be. */
  function keyProblem(provider, apiKey) {
    const key = String(apiKey || "").trim();
    if (provider === "custom") return "";
    if (!key) return "The agent needs an AI model connected first.";
    if (/^(sk-or-v1-\.\.\.|sk-proj-\.\.\.|sk-ant-\.\.\.|AIzaSy\.\.\.|gsk_\.\.\.|api key)$/i.test(key)) return `The saved ${providerName(provider)} key is a placeholder, not a real key.`;
    const shapes = { openrouter: /^sk-or-/, anthropic: /^sk-ant-/, openai: /^sk-/, gemini: /^(AIza|AQ\.)/, groq: /^gsk_/, cerebras: /^csk-/, xai: /^xai-/, opencode: /^(oc_sk_|sk-)/ };
    if (shapes[provider] && !shapes[provider].test(key)) return `That does not look like a ${providerName(provider)} key. Check that the provider in Settings matches the key you saved.`;
    return "";
  }

  /**
   * The name the reply's length limit goes under on an OpenAI-style
   * endpoint. OpenAI's own current models take only max_completion_tokens;
   * other providers that speak the same format still expect max_tokens.
   * `mode.tokenLimit` is what a refusal taught this connection.
   */
  function tokenLimitName(cfg, mode) {
    if (mode && mode.tokenLimit) return mode.tokenLimit;
    return cfg && cfg.provider === "openai" ? "max_completion_tokens" : "max_tokens";
  }

  /**
   * The provider settings in use, from what is in storage.
   * @param items every stored setting and key (sync and local merged)
   * @param now   the clock, to tell whether a backup is standing in
   */
  function settingsFrom(items, now) {
    const it = items || {};
    const A = DEFAULTS.AGENT_DEFAULTS;
    // Signed in with ChatGPT there is no key: the token comes from the
    // sign-in (deps.chatgptToken) at the time of each call.
    const account = it.chatgptAccount || null;
    const slugs = account && Array.isArray(account.models) ? account.models.map((m) => m.slug) : [];
    const problemOf = (provider) => {
      if (provider !== "chatgpt") return keyProblem(provider, detailsOf(provider).apiKey);
      if (!CHATGPT) return "Sign in with ChatGPT is not in this version. Pick another provider in Settings.";
      if (!account || !account.signedIn) return "The agent needs you to sign in with ChatGPT first.";
      if (!account.planEnabled) return "ChatGPT plan use is not turned on for this sign-in. Turn it on in Settings with Continue with ChatGPT.";
      return "";
    };
    const detailsOf = (provider) => {
      if (provider === "chatgpt") return { apiKey: "", baseUrl: CHATGPT ? CHATGPT.API_BASE : "" };
      if (provider === "custom") return { apiKey: it.agentCustomKey || "", baseUrl: it.agentCustomUrl || A.customUrl };
      const entry = (DEFAULTS.PROVIDER_ENDPOINTS || {})[provider];
      return entry ? { apiKey: it[entry.keyName] || "", baseUrl: entry.baseUrl } : { apiKey: "", baseUrl: "" };
    };
    let provider = it.agentActiveProvider || A.activeProvider;
    let model = it.agentModel || A.model;
    let standIn = null;
    // While the main provider's allowance is spent, the user's chosen backup answers.
    const pause = it.agentProviderPause;
    const backup = it.agentBackupProvider || "";
    if (pause && pause.provider === provider && pause.until > (now || 0) && backup && backup !== provider && !problemOf(backup)) {
      standIn = { from: provider, until: pause.until };
      provider = backup;
      model = DEFAULTS.backupModelFor(backup) || (DEFAULTS.PROVIDER_FALLBACK_MODELS[backup] || {}).lite;
    }
    const fallbacks = DEFAULTS.PROVIDER_FALLBACK_MODELS[provider] || DEFAULTS.PROVIDER_FALLBACK_MODELS.openrouter;
    // On ChatGPT a model has to be one the account lists.
    const listed = (m) => provider !== "chatgpt" || !slugs.length || slugs.includes(m);
    const pro = modelFits(provider, model) && listed(model) ? model : provider === "chatgpt" && CHATGPT ? CHATGPT.bestModel(account && account.models) || fallbacks.pro : fallbacks.pro;
    const lite = provider === "custom" ? pro : provider === "chatgpt" ? (CHATGPT && CHATGPT.liteModel(account && account.models)) || pro : fallbacks.lite || pro;
    const d = detailsOf(provider);
    // A stronger model on the same provider and key. A backup standing in has none.
    const helper = String(it.agentHelperModel || "").trim();
    return {
      provider,
      apiKey: d.apiKey,
      baseUrl: d.baseUrl,
      customUrl: it.agentCustomUrl || "",
      model: pro,
      liteModel: lite,
      helperModel: !standIn && helper && helper !== pro && modelFits(provider, helper) && listed(helper) ? helper : "",
      backup: !standIn && backup && backup !== provider && !problemOf(backup) ? backup : "",
      standIn,
      keyProblem: problemOf(provider),
      costBudget: parseFloat(it.agentCostBudget) || 0,
      promptCaching: it.agentPromptCaching !== false,
    };
  }

  // ----------------------------------------------------------------- request

  /** The model a tier asks: the main one, the lite one, or the helper (the main one when there is none). */
  const modelFor = (tier, cfg) => (tier === "lite" ? cfg.liteModel : tier === "helper" ? cfg.helperModel || cfg.model : cfg.model);

  const explicitCaching = (cfg, model) => cfg.promptCaching !== false
    && (cfg.provider === "anthropic" || (cfg.provider === "openrouter" && /anthropic\/|claude|qwen/i.test(model)));

  /**
   * The request fields that ask a model to think less, for a step that
   * asks for low effort (run.js effortOf). Only for models that think
   * (defaults.js), in each provider's own words: Anthropic's
   * output_config.effort; OpenRouter's reasoning.effort, except for Claude
   * models there, where it would turn thinking on; reasoning_effort on
   * every other OpenAI-compatible endpoint, which is also how Gemini's
   * takes its thinking level. "default" sends nothing: the model's own.
   */
  function effortFields(cfg, model, effort) {
    if (effort !== "low" || !DEFAULTS.modelProfile(model).thinks) return {};
    if (cfg.provider === "anthropic") return { output_config: { effort: "low" } };
    if (cfg.provider === "chatgpt") return { reasoning: { effort: "low" } };
    if (cfg.provider === "openrouter") return /anthropic\/|claude/i.test(model) ? {} : { reasoning: { effort: "low" } };
    return { reasoning_effort: "low" };
  }

  /**
   * A Responses API request for a user signed in with ChatGPT, within what
   * plan usage accepts (siwc/token-sharing-open-source/preview-limitations):
   * store false and stream true; the input as an array; the system text as
   * `instructions`, since system-role items are refused; no temperature,
   * max_output_tokens or other refused field; function tools grouped in a
   * namespace. Images are input_image parts, which plan usage takes when the
   * model does.
   */
  function buildResponsesRequest(req, cfg, model, mode) {
    const tool = mode.noTools ? null : req.tool;
    const user = tool || !req.tool ? req.user : `${req.user}\n\nTools are not available on this connection. Reply with one JSON object holding the fields of the ${req.tool.name} tool, and nothing else.`;
    const system = req.tool && !tool ? `${req.system}\n\nThe ${req.tool.name} tool takes these fields:\n${JSON.stringify(req.tool.parameters)}` : req.system;
    const content = [{ type: "input_text", text: user }];
    if (req.image) content.push({ type: "input_image", image_url: req.image });
    const body = {
      model,
      instructions: system,
      input: [{ type: "message", role: "user", content }],
      store: false,
      stream: true,
    };
    if (tool) {
      const fn = { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
      body.tools = mode.flatTools ? [fn] : [{ type: "namespace", name: "browser", description: "Operating the user's browser.", tools: [fn] }];
      body.tool_choice = mode.autoChoice ? "auto" : "required";
      body.parallel_tool_calls = false;
    }
    if (!mode.noEffort) Object.assign(body, effortFields(cfg, model, req.effort));
    return {
      endpoint: `${cfg.baseUrl.replace(/\/$/, "")}/responses`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body,
    };
  }

  function buildRequest(req, cfg, model, mode) {
    if (cfg.provider === "chatgpt") return buildResponsesRequest(req, cfg, model, mode);
    let endpoint = cfg.baseUrl;
    if (!endpoint.endsWith("/chat/completions") && !endpoint.includes("/messages")) endpoint = `${endpoint.replace(/\/$/, "")}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    const tool = mode.noTools ? null : req.tool;
    // Without tools the model writes the same fields as a JSON object.
    const user = tool || !req.tool ? req.user : `${req.user}\n\nTools are not available on this connection. Reply with one JSON object holding the fields of the ${req.tool.name} tool, and nothing else.`;
    const system = req.tool && !tool ? `${req.system}\n\nThe ${req.tool.name} tool takes these fields:\n${JSON.stringify(req.tool.parameters)}` : req.system;
    // The sampling of the model the request really carries (defaults.js);
    // null means it takes none.
    const profile = DEFAULTS.modelProfile(DEFAULTS.outgoingModel(cfg.provider, model, !!mode.bareFree));
    const temperature = req.temperature !== undefined ? req.temperature : profile.temperature;
    let body;
    if (cfg.provider === "anthropic") {
      headers["x-api-key"] = cfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      const content = [{ type: "text", text: user }];
      const img = req.image && String(req.image).match(/^data:([^;]+);base64,(.+)$/);
      if (img) content.push({ type: "image", source: { type: "base64", media_type: img[1], data: img[2] } });
      body = {
        model,
        max_tokens: mode.maxTokens,
        // The tool comes before the system text in what is cached, so one
        // mark on the system text caches both: they are the same every step.
        system: explicitCaching(cfg, model) ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
        messages: [{ role: "user", content }],
        stream: true,
      };
      // Current Claude models think adaptively and take no thinking budget.
      if (profile.adaptive) body.thinking = { type: "adaptive" };
      if (temperature !== null && !mode.noTemperature) body.temperature = temperature;
      if (!mode.noEffort) Object.assign(body, effortFields(cfg, model, req.effort));
      if (tool) {
        body.tools = [TOOLS.buildAnthropicTool(tool.name, tool.description, tool.parameters)];
        // A model that is thinking refuses a forced tool (or skips its
        // thinking for it); "auto" with one tool on offer does the same job.
        body.tool_choice = mode.autoChoice || profile.adaptive ? { type: "auto" } : { type: "tool", name: tool.name };
      }
    } else {
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      if (cfg.provider === "openrouter") Object.assign(headers, DEFAULTS.OPENROUTER_ATTRIBUTION);
      const sys = explicitCaching(cfg, model) ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system;
      body = {
        model,
        messages: [{ role: "system", content: sys }, { role: "user", content: req.image ? [{ type: "text", text: user }, { type: "image_url", image_url: { url: req.image } }] : user }],
        [tokenLimitName(cfg, mode)]: mode.maxTokens,
        stream: true,
      };
      if (temperature !== null && !mode.noTemperature) body.temperature = temperature;
      if (tool) {
        body.tools = [TOOLS.buildOpenAITool(tool.name, tool.description, tool.parameters)];
        body.tool_choice = mode.autoChoice ? "auto" : { type: "function", function: { name: tool.name } };
      }
      if (!mode.noCompat) {
        if (!tool) body.response_format = { type: "json_object" };
        body.stream_options = { include_usage: true };
      }
      if (cfg.provider === "openrouter") Object.assign(body, DEFAULTS.openRouterOptions(model, !!tool, !!mode.bareFree));
      if (!mode.noEffort) Object.assign(body, effortFields(cfg, model, req.effort));
    }
    return { endpoint, headers, body };
  }

  /** True when an error message is about the model id itself: unknown, retired, or with nothing serving it. */
  function namesModel(message) {
    const m = String(message || "");
    if (/not a valid model|invalid model|unknown model|no endpoints|no allowed providers|model[^.]{0,80}(not found|does not exist|not exist|not available|unavailable|deprecated|retired|no longer)/i.test(m)) return true;
    return (DEFAULTS.OPENROUTER_FREE_CHAIN || []).some((id) => id !== "openrouter/free" && m.includes(id));
  }

  /** The provider's own words from an error reply, without the JSON around them. */
  function errorText(raw, status) {
    if (!raw) return `HTTP ${status || "error"}`;
    let t = String(raw).trim();
    try {
      let obj = JSON.parse(t);
      if (Array.isArray(obj)) obj = obj[0];
      if (obj && obj.error) return typeof obj.error === "object" ? String(obj.error.message || JSON.stringify(obj.error)) : String(obj.error);
      if (obj && obj.message) return String(obj.message);
    } catch (_e) { /* plain text */ }
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  }

  /**
   * Cached prompt tokens in a reply's usage, in each provider's own shape,
   * as their API docs gave them on 24 Nov 2026:
   * - Anthropic: cache_read_input_tokens and cache_creation_input_tokens,
   *   counted apart from input_tokens (apart: true).
   * - OpenAI, OpenRouter, Groq, Cerebras, xAI and Mistral chat completions:
   *   prompt_tokens_details.cached_tokens, plus cache_write_tokens on
   *   OpenAI and OpenRouter, all inside prompt_tokens.
   * - The Responses API (ChatGPT sign-in): input_tokens_details, the same
   *   two fields, inside input_tokens.
   * - DeepSeek: prompt_cache_hit_tokens, inside prompt_tokens.
   * - Together: prompt_tokens_details.cached_tokens, or on some models
   *   cached_tokens at the top level of usage, both inside prompt_tokens
   *   (its prompt-caching page reads the one, then the other).
   * - Gemini's OpenAI-compatible endpoint documents no cached count, so
   *   its count stays 0.
   * @returns {{cached: number, cacheWrite: number, apart: boolean}}
   */
  function cacheOf(u) {
    const n = (v) => Number(v) || 0;
    const details = u.prompt_tokens_details || u.input_tokens_details || null;
    const apart = u.input_tokens !== undefined && u.prompt_tokens === undefined && !u.input_tokens_details;
    if (apart) return { cached: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), apart };
    const cached = n(details && details.cached_tokens) || n(u.prompt_cache_hit_tokens) || n(u.cached_tokens);
    return { cached, cacheWrite: n(details && details.cache_write_tokens), apart };
  }

  /**
   * A Responses stream's outcome in the shape every other provider's has.
   * Only response.completed (or response.incomplete, which says why) is a
   * reply; response.failed carries a plan-usage error that can arrive after
   * streaming has begun, and is given the HTTP status it would have had, so
   * it is handled like the same error before the stream.
   */
  function endOfResponses(out, rs, tool) {
    Object.assign(out, readCalls(TOOLS.finalizeToolCalls({ calls: rs.calls }), tool));
    if (rs.usage) out.usage = rs.usage;
    if (rs.model) out.served = rs.model;
    if (rs.status === "failed") {
      out.ok = false;
      out.status = CHATGPT.statusForCode((rs.error && rs.error.code) || "");
      out.raw = JSON.stringify({ error: rs.error || { message: "ChatGPT could not finish the reply." } });
    } else if (rs.status === "completed") {
      out.finish = out.calls.length ? "tool_calls" : "stop";
    } else if (rs.status === "incomplete") {
      out.finish = rs.incomplete === "max_output_tokens" ? "length" : rs.incomplete || "incomplete";
    } else {
      out.ok = false;
      out.status = 0;
      out.raw = "The reply stopped before ChatGPT finished it.";
    }
    return out;
  }

  // ------------------------------------------------------- reading the call

  /**
   * Reads JSON the way a small model sometimes writes it: single quotes,
   * bare keys, trailing or missing commas, True/False/None, a line break
   * inside a string, words before or after it. A reply that stops in the
   * middle is read as far as it is sure: an array keeps its complete
   * elements, the outermost object keeps its complete members, and anything
   * that was still being written (a string, a number, an inner object) is
   * left out, never guessed at. Returns {value, cut, dropped}: `cut` when
   * the text ended before its last bracket, and `dropped` when it ended in
   * the middle of something (a key, a value, after a comma), so that what
   * was read is less than what was being written. Cut and not dropped
   * means only closing brackets were missing. Throws when the text is not
   * JSON even read this way.
   */
  function readLoose(text) {
    let s = String(text == null ? "" : text).trim().replace(/^```[a-z]*\s*/i, "");
    if (!/^[{["']/.test(s)) {
      const at = s.indexOf("{");
      if (at < 0) throw new SyntaxError("no JSON object in it");
      s = s.slice(at);
    }
    let i = 0;
    let cut = false;
    let dropped = false;
    class Cut { constructor(partial) { this.partial = partial; } }
    // The text ended in the middle of something: what is read from here on is not all of it.
    const midway = (partial) => { dropped = true; return new Cut(partial); };
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
    // `between` is a place the text may end with nothing lost: before a
    // first member or after a complete one, where only brackets are owed.
    const more = (between) => { ws(); if (i >= s.length) throw between ? new Cut() : midway(); return s[i]; };
    const LITERALS = { true: true, false: false, null: null, True: true, False: false, None: null };
    function string(q) {
      i += 1;
      let out = "";
      for (;;) {
        if (i >= s.length) throw midway();
        const c = s[i++];
        if (c === q) return out;
        if (c !== "\\") { out += c; continue; }
        if (i >= s.length) throw midway();
        const e = s[i++];
        if (e === "u") {
          const hex = s.slice(i, i + 4);
          if (hex.length < 4) throw midway();
          if (!/^[0-9a-f]{4}$/i.test(hex)) throw new SyntaxError("a bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[e] || e;
      }
    }
    function value(depth) {
      const c = more();
      if (c === "{") return object(depth);
      if (c === "[") return array(depth);
      if (c === '"' || c === "'") return string(c);
      const rest = s.slice(i, i + 48);
      const word = (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(rest) || /^[A-Za-z]+/.exec(rest) || /^-/.exec(rest) || [""])[0];
      // A number or a word that runs to the end may have had more to come.
      if (word && i + word.length >= s.length) throw midway();
      if (/^-?\d/.test(word)) { i += word.length; return Number(word); }
      if (Object.prototype.hasOwnProperty.call(LITERALS, word)) { i += word.length; return LITERALS[word]; }
      throw new SyntaxError(`an unexpected ${JSON.stringify(c)} at character ${i + 1}`);
    }
    function object(depth) {
      i += 1;
      const out = {};
      let afterComma = false;
      for (;;) {
        let key = null;
        let open = false;
        try {
          let c = more(!afterComma);
          if (c === "}") { i += 1; return out; }
          if (c === ",") { i += 1; afterComma = true; continue; }
          afterComma = false;
          if (c === '"' || c === "'") key = string(c);
          else {
            const bare = (/^[A-Za-z_$][\w$-]*/.exec(s.slice(i, i + 80)) || [""])[0];
            if (!bare) throw new SyntaxError(`an unexpected ${JSON.stringify(c)} at character ${i + 1}`);
            if (i + bare.length >= s.length) throw midway();
            key = bare;
            i += bare.length;
          }
          if (more() !== ":") throw new SyntaxError(`no ":" after ${JSON.stringify(key)}`);
          i += 1;
          open = true;
          out[key] = value(depth + 1);
          open = false;
          c = more(true);
          if (c === ",") { i += 1; afterComma = true; }
          else if (c !== "}" && !/["'A-Za-z_$]/.test(c)) throw new SyntaxError(`an unexpected ${JSON.stringify(c)} at character ${i + 1}`);
        } catch (e) {
          if (!(e instanceof Cut)) throw e;
          cut = true;
          // Only its closing bracket was missing: it is whole.
          if (!dropped) return out;
          if (open && Array.isArray(e.partial)) out[key] = e.partial;
          // Only the outermost object is kept when it was cut in the middle.
          if (depth > 0) throw new Cut();
          return out;
        }
      }
    }
    function array(depth) {
      i += 1;
      const out = [];
      let afterComma = false;
      for (;;) {
        try {
          let c = more(!afterComma);
          if (c === "]") { i += 1; return out; }
          if (c === ",") { i += 1; afterComma = true; continue; }
          afterComma = false;
          out.push(value(depth + 1));
          c = more(true);
          if (c === ",") { i += 1; afterComma = true; }
          else if (c !== "]") throw new SyntaxError(`an unexpected ${JSON.stringify(c)} at character ${i + 1}`);
        } catch (e) {
          if (!(e instanceof Cut)) throw e;
          cut = true;
          if (!dropped) return out;
          if (Array.isArray(e.partial)) out.push(e.partial);
          if (depth > 0) throw new Cut(out);
          return out;
        }
      }
    }
    try {
      const read = value(0);
      return { value: read, cut, dropped };
    } catch (e) {
      if (e instanceof Cut) throw new SyntaxError("it stopped before anything in it was complete");
      throw e;
    }
  }

  /**
   * The arguments of a tool call, mended here where they can be instead of
   * spending a request on asking again: JSON that is cut short or slightly
   * off (readLoose), the arguments written as a string of JSON, and the
   * fields wrapped in something else ({"name": .., "arguments": {..}}, a
   * one-item list, an object under the tool's name). What counts as the
   * fields is the tool's own schema: its required fields, all present.
   *
   * Two things are never mended. A reply that stopped in the middle of a
   * member is not used with that member left out: the missing field
   * changes what the call does (an answer lost, a press with no target),
   * so the model is asked again. And the call is looked for inside other
   * things only when the outside is a wrapper, with none of the tool's
   * own fields: text in a field of a real call (which may be a page's
   * text) is never read as the call.
   *
   * @param given the arguments as the model wrote them (text), or as parsed
   * @returns {args, how} with `how` saying what was mended ("" for nothing),
   *   or {args: null, error} when the model has to be asked again
   */
  function repairArguments(given, tool) {
    const params = (tool && tool.parameters) || {};
    const props = Object.keys(params.properties || {});
    const required = Array.isArray(params.required) ? params.required : [];
    const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    const fits = (v) => plain(v) && required.every((k) => k in v) && (required.length > 0 || !props.length || Object.keys(v).some((k) => props.includes(k)));
    let cut = false;
    let dropped = false;
    let loose = false;
    let why = "";
    const read = (text) => {
      try { return JSON.parse(text); } catch (e) { why = why || e.message; }
      const got = readLoose(text);
      loose = true;
      cut = cut || got.cut;
      dropped = dropped || got.dropped;
      return got.value;
    };
    const ownField = (v) => plain(v) && Object.keys(v).some((k) => props.includes(k));
    // The object that has the tool's fields: the value itself, or the first one inside a wrapper.
    const find = (v, depth) => {
      if (depth > 3) return null;
      if (typeof v === "string") {
        if (!/[{[]/.test(v)) return null;
        try { return find(read(v), depth + 1); } catch (_e) { return null; }
      }
      if (fits(v)) return v;
      if (!v || typeof v !== "object") return null;
      // An object with the tool's own fields is the call, whole or not: nothing in it is taken for the call.
      if (ownField(v)) return null;
      for (const inner of Object.values(v)) {
        const got = find(inner, depth + 1);
        if (got) return got;
      }
      return null;
    };
    let top;
    try {
      top = typeof given === "string" ? read(given) : given;
    } catch (e) {
      return { args: null, error: `its arguments were not valid JSON (${clip(why || e.message, 120)})` };
    }
    if (!loose && fits(top)) return { args: top, how: "" };
    const got = dropped ? null : find(top, 0);
    if (got) return { args: got, how: cut ? "cut short" : loose ? "not valid JSON" : "wrapped in something else" };
    // Valid JSON without every required field is for the caller to judge, as before.
    if (!loose && plain(top)) return { args: top, how: "" };
    const missing = plain(top) ? required.filter((k) => !(k in top)) : [];
    if (cut) return { args: null, cut: true, error: `its arguments were cut off${missing.length ? ` before ${missing.join(", ")}` : dropped ? " in the middle of a field" : ""}` };
    if (missing.length) return { args: null, error: `its arguments were not valid JSON and had no ${missing.join(", ")}` };
    return { args: null, error: `its arguments were not one JSON object with the tool's fields${why ? ` (${clip(why, 120)})` : ""}` };
  }

  /** The calls of a reply that can be used, what was mended in them, and the first that could not be. */
  function readCalls(list, tool) {
    const out = { calls: [], bad: null, mended: "" };
    for (const c of list || []) {
      // Arguments that parsed to a string are a string of JSON: read as written.
      const r = repairArguments(c.raw !== undefined ? c.raw : typeof c.args === "string" ? JSON.stringify(c.args) : c.args, tool);
      if (r.args) { out.calls.push({ name: c.name, args: r.args }); out.mended = out.mended || r.how; }
      else if (!out.bad) out.bad = r.error;
    }
    return out;
  }

  // ------------------------------------------------------------------ client

  /**
   * @param deps {fetch, sleep(ms), now(), log(title, text, {quiet, waitMs}), onSwitch(from, to, until)}
   *   `quiet` marks what the call did for itself and recovered from (a
   *   re-ask, a retry, a setting left out): it belongs in the saved log, not
   *   among the steps the user is shown. `waitMs` is how long a retry waits.
   */
  function createClient(deps) {
    const fetchFn = deps.fetch;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = deps.now || (() => Date.now());
    const log = deps.log || (() => {});
    // The room a model turned out to need for its reply, for as long as
    // the worker lives: a model that ran out once is given that much from
    // the start, instead of running out again on every call.
    const roomNeeded = new Map();
    // What each connection turned out not to accept, for as long as the
    // worker lives: asked once, remembered after.
    const learned = new Map();
    const modeOf = (cfg, model) => { const k = `${cfg.provider}|${model}`; if (!learned.has(k)) learned.set(k, {}); return learned.get(k); };

    /** One request, streamed to its end. Never throws for an HTTP error: returns it. */
    async function once(req, cfg, model, mode, signal, onText) {
      const { endpoint, headers, body } = buildRequest(req, cfg, model, mode);
      const dest = SECURITY.validateProviderUrl(endpoint, cfg.customUrl);
      if (!dest.ok) throw new ModelError("config", dest.error);
      const ctl = new AbortController();
      const abort = () => ctl.abort();
      if (signal) { if (signal.aborted) throw new ModelError("aborted", "Stopped."); signal.addEventListener("abort", abort, { once: true }); }
      // A provider that says nothing for this long is not going to answer.
      let timedOut = false;
      let timer = null;
      const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms); };
      const startedAt = now();
      arm(req.firstByteMs || 75000);
      const out = { status: 0, ok: false, headers: {}, raw: "", text: "", reasoning: "", calls: [], usage: null, served: "", finish: "", ms: 0, firstByteMs: null };
      try {
        // Page text cut in the middle of a character pair leaves half of it,
        // which some providers refuse as malformed JSON: such halves become U+FFFD.
        const res = await fetchFn(dest.url, { method: "POST", headers, body: JSON.stringify(body, (_k, v) => (typeof v === "string" && v.toWellFormed ? v.toWellFormed() : v)), signal: ctl.signal });
        out.status = res.status;
        out.ok = res.ok;
        res.headers.forEach((v, k) => { out.headers[k] = v; });
        if (!res.ok) { out.raw = await res.text(); return out; }
        const state = TOOLS.createToolCallAccumulator();
        // The Responses API's events, for a user signed in with ChatGPT.
        const rs = cfg.provider === "chatgpt" ? TOOLS.createResponsesAccumulator() : null;
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let args = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (out.firstByteMs === null) out.firstByteMs = now() - startedAt;
          arm(req.idleMs || 45000);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const data = t.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let p;
            try { p = JSON.parse(data); } catch (_e) { continue; }
            if (rs) {
              const d = TOOLS.accumulateResponsesEvent(rs, p);
              out.text += d.text;
              out.reasoning += d.reasoning;
              args += d.args;
              if (onText && (d.text || d.reasoning || d.args)) onText(out.text || args || out.reasoning);
              continue;
            }
            const choice = p.choices && p.choices[0];
            const delta = (choice && choice.delta) || {};
            const content = delta.content || (p.type === "content_block_delta" && p.delta && p.delta.text) || "";
            // Thinking arrives under a different name on each provider.
            const thinking = delta.reasoning || delta.reasoning_content || (p.type === "content_block_delta" && p.delta && p.delta.thinking) || "";
            if (content) out.text += content;
            if (thinking) out.reasoning += thinking;
            if (delta.tool_calls) {
              TOOLS.accumulateOpenAIToolCallDelta(state, delta.tool_calls);
              for (const f of delta.tool_calls) if (f && f.function && f.function.arguments) args += f.function.arguments;
            }
            TOOLS.accumulateAnthropicEvent(state, p);
            if (p.type === "content_block_delta" && p.delta && p.delta.type === "input_json_delta" && p.delta.partial_json) args += p.delta.partial_json;
            if (choice && choice.finish_reason) out.finish = choice.finish_reason;
            if (p.type === "message_delta" && p.delta && p.delta.stop_reason) out.finish = p.delta.stop_reason === "max_tokens" ? "length" : p.delta.stop_reason;
            if (p.model && !out.served) out.served = p.model;
            const usage = p.usage || (p.message && p.message.usage);
            if (usage) out.usage = { ...(out.usage || {}), ...usage };
            if (onText && (content || thinking || args)) onText(out.text || args || out.reasoning);
          }
        }
        out.argChars = args.length;
        if (rs) return endOfResponses(out, rs, req.tool);
        Object.assign(out, readCalls(TOOLS.finalizeToolCalls(state), req.tool));
        return out;
      } catch (e) {
        if (signal && signal.aborted) throw new ModelError("aborted", "Stopped.");
        out.status = timedOut ? 408 : 0;
        out.raw = timedOut ? "The model did not answer in time." : String((e && e.message) || e);
        return out;
      } finally {
        clearTimeout(timer);
        out.ms = now() - startedAt;
        if (signal) signal.removeEventListener("abort", abort);
      }
    }

    function usageOf(res, req, model, provider) {
      const u = res.usage || {};
      let prompt = u.prompt_tokens ?? u.input_tokens;
      let completion = u.completion_tokens ?? u.output_tokens;
      const estimated = prompt === undefined || completion === undefined;
      if (prompt === undefined) prompt = Math.ceil((String(req.system).length + String(req.user).length) / 4);
      if (completion === undefined) completion = Math.ceil((res.text.length + res.reasoning.length + (res.argChars || 0)) / 4);
      // On ChatGPT the user's plan pays: nothing is charged per token.
      const rates = provider === "chatgpt" ? [0, 0] : DEFAULTS.findModelRates(model);
      const { cached, cacheWrite, apart } = cacheOf(u);
      const uncached = prompt;
      if (apart) prompt = uncached + cached + cacheWrite;
      // Anthropic: a cache read costs a tenth of the input rate, a cache
      // write 1.25 times. Elsewhere the discount differs by provider and
      // model and is not in the rate table, so the prompt is still charged
      // at the full input rate there, which can only overstate the cost.
      const promptCost = apart ? uncached + cached * 0.1 + cacheWrite * 1.25 : prompt;
      return { prompt, completion, cached, cacheWrite, cost: (promptCost / 1000) * rates[0] + (completion / 1000) * rates[1], estimated, model: res.served || model };
    }

    /**
     * @param req {system, user, tool, tier: "pro" | "lite" | "helper", effort: "low" | "default", image, signal, onText, maxTokens, reasks}
     *   `reasks` is how many times a reply without a usable call may be asked
     *   for again inside this call (2 when not given). A caller that asks
     *   again itself passes 0 the next time, so the asks of one step are
     *   counted once, not once in each layer.
     * @param cfg settingsFrom(...)
     */
    async function call(req, cfg0) {
      let cfg = cfg0;
      if (cfg.keyProblem) throw new ModelError("config", `${cfg.keyProblem} Press "Connect" below, then run the task again.`);
      let model = modelFor(req.tier, cfg);
      const tried = [];
      const spent = { prompt: 0, completion: 0, cached: 0, cacheWrite: 0, cost: 0, estimated: false, model: "" };
      const add = (u) => { spent.prompt += u.prompt; spent.completion += u.completion; spent.cached += u.cached || 0; spent.cacheWrite += u.cacheWrite || 0; spent.cost += u.cost; spent.estimated = spent.estimated || u.estimated; spent.model = u.model; };
      let retries = 0;
      // The providers this call has been on: a switch to a backup goes only
      // to one not tried yet, so two spent providers never hand the call
      // back and forth.
      const providersTried = [cfg.provider];
      let reasks = 0;
      const reaskBudget = Number.isInteger(req.reasks) ? Math.max(0, req.reasks) : 2;
      let asText = false;
      let maxTokens = Math.max(req.maxTokens || DEFAULTS.modelProfile(model).maxTokens, (req.tool && roomNeeded.get(model)) || 0);
      let user = req.user;
      // Signed in with ChatGPT: the access token in use, renewed once after a 401.
      let renewToken = false;
      let renewed = false;
      const tokenFor = async (force) => {
        if (!deps.chatgptToken) throw new ModelError("config", "ChatGPT sign-in is not available here.", { usage: spent });
        try {
          return await deps.chatgptToken(force);
        } catch (e) {
          const kind = e && e.kind === "unreachable" ? "unreachable" : e && e.kind === "config" ? "config" : "auth";
          throw new ModelError(kind, (e && e.message) || "Sign in with ChatGPT again in Settings.", { usage: spent });
        }
      };

      for (;;) {
        const mode = modeOf(cfg, model);
        // The tool is offered on the first ask and on the first re-ask, and
        // forced only on the second. A forced call is written under a fixed
        // grammar, and some providers' grammar ends a text field at its
        // first line break: an answer with a list in it arrived as its
        // opening line. Offered, the model writes the call itself, line
        // breaks and all.
        let sendCfg = cfg;
        if (cfg.provider === "chatgpt") { sendCfg = { ...cfg, apiKey: await tokenFor(renewToken) }; renewToken = false; }
        const res = await once({ ...req, user }, sendCfg, model, { ...mode, autoChoice: mode.autoChoice || reasks < 2, noTools: mode.noTools || asText, maxTokens }, req.signal, req.onText);
        const provider = cfg.provider;

        if (res.ok) {
          add(usageOf(res, { ...req, user }, model, cfg.provider));
          let reply = (res.calls[0] && res.calls[0].args) || (req.tool ? TOOLS.parseTextAction(res.text) || TOOLS.parseTextAction(res.reasoning) : null);
          let mended = res.calls[0] ? res.mended : "";
          let bad = res.bad;
          // The call written out as text, and not quite JSON: read the same way.
          if (!reply && req.tool && !bad && String(res.text).includes("{")) {
            const r = repairArguments(res.text, req.tool);
            if (r.args && r.how) { reply = r.args; mended = r.how; }
          }
          // The reply ran out of room and its call has no ending: fields
          // may have been still to come, so it is not used as it stands.
          // It is asked for again with more room, below.
          if (reply && mended === "cut short" && res.finish === "length") {
            reply = null;
            bad = "its arguments were cut off when the reply ran out of room";
          }
          if (reply && mended) log("Call Mended", `The model's ${req.tool.name} call was ${mended}. It was read as it stood, without asking again.`, { quiet: true });
          // What the provider says is left of the key's requests, when it says.
          const left = LIMITS && LIMITS.readAllowance ? LIMITS.readAllowance(res.headers, now()) : null;
          if (reply || !req.tool) return { reply: reply || null, text: res.text, usage: spent, model: res.served || model, ms: res.ms, firstByteMs: res.firstByteMs, provider, ...(left ? { left } : {}) };
          // No tool call. Cut off while thinking: give it room. Otherwise say
          // plainly what is wanted and ask again.
          if (res.finish === "length" && maxTokens < 12000) {
            maxTokens *= 2;
            roomNeeded.set(model, maxTokens);
            log("Reply Cut Short", `The reply ran out of room before its action. Asking again with more room (${maxTokens} tokens).`, { quiet: true });
            continue;
          }
          const got = clip(res.text || res.reasoning, 200);
          if (reasks < reaskBudget) {
            reasks += 1;
            // The model is told what was wrong with what it sent, not that it sent nothing.
            if (bad) {
              log("Call Not Readable", `The model called ${req.tool.name}, but ${bad}. Asking again (${reasks}/${reaskBudget}).`, { quiet: true });
              user = `${req.user}\n\nYour last reply called the ${req.tool.name} tool, but ${bad}. Call it again with its arguments as one complete JSON object: double quotes, no trailing commas, every required field.`;
              continue;
            }
            log("Reply Without Action", `The model answered without calling ${req.tool.name}${res.finish ? ` (${res.finish})` : ""}${got ? `: ${got}` : ", with nothing"}. Asking again (${reasks}/${reaskBudget}).`, { quiet: true });
            user = `${req.user}\n\nYour last reply did not call the ${req.tool.name} tool. Reply only by calling it${mode.noTools || asText ? " (one JSON object with its fields)" : ""}.`;
            continue;
          }
          // Asked twice and still no tool call: this once, take the same fields as written JSON.
          if (reaskBudget > 0 && !mode.noTools && !asText) {
            asText = true;
            user = req.user;
            log("Reply Without Action", `Asking for the fields of ${req.tool.name} as JSON instead.`, { quiet: true });
            continue;
          }
          throw new ModelError("no_action", "The model kept replying without an action. Try again, or pick a different model in Settings.", { usage: spent });
        }

        const status = res.status;
        const message = errorText(res.raw, status);
        // "openrouter/free" goes out as a list of named free models
        // (defaults.js OPENROUTER_FREE_CHAIN). A free model is retired or
        // renamed without notice, and a refusal that names a model means the
        // list itself is the problem: the bare router is asked once instead,
        // and this connection keeps asking it from then on.
        if (provider === "openrouter" && model === "openrouter/free" && !mode.bareFree && (status === 400 || status === 404) && namesModel(message)) {
          mode.bareFree = true;
          log("Compatibility", `OpenRouter refused a free model by name (${clip(message, 120)}). Asking its free router directly on this connection.`, { quiet: true });
          continue;
        }
        // A provider that does not take a say in the model's effort, or not
        // together with tools (an earlier project found one that rejected
        // reasoning_effort whenever tools were sent): it is left out on this
        // connection from then on. Checked before the tool rejection below,
        // so a refusal that names both does not cost the connection its tools.
        // The limit on the reply's length has two names on OpenAI-style
        // endpoints. A model that refuses the one sent gets the other, on
        // this connection from then on.
        if (status === 400 && !mode.tokenLimitSwapped && provider !== "anthropic" && provider !== "gemini" && provider !== "chatgpt" && /max_tokens|max_completion_tokens/i.test(message)) {
          mode.tokenLimitSwapped = true;
          mode.tokenLimit = tokenLimitName(cfg, mode) === "max_tokens" ? "max_completion_tokens" : "max_tokens";
          log("Compatibility", "The model takes the reply limit under another name. Retrying with it on this connection.", { quiet: true });
          continue;
        }
        const effortSent = !mode.noEffort && Object.keys(effortFields(cfg, model, req.effort)).length > 0;
        const namesOther = /response_format|json_object|json_mode|stream_options|tool_choice/i.test(message);
        if (status === 400 && effortSent && (/effort|reasoning|thinking|output_config/i.test(message) || (!namesOther && !/tool|function/i.test(message) && /unsupported|unrecognized|not supported|extra inputs|unknown (?:field|parameter|argument)/i.test(message)))) {
          mode.noEffort = true;
          log("Compatibility", "The provider rejected the effort setting. Retrying without it on this connection.", { quiet: true });
          continue;
        }
        // A model that takes no say in its sampling: left out on this connection from then on.
        if (status === 400 && !mode.noTemperature && /temperature|top_p|sampling/i.test(message)) {
          mode.noTemperature = true;
          log("Compatibility", "The model does not take a temperature. Retrying without it on this connection.", { quiet: true });
          continue;
        }
        if (provider === "chatgpt") {
          const err = CHATGPT.errorOf(res.raw);
          const about = `${err.param} ${message}`;
          // An access token that was not accepted is renewed once and the call made again.
          if (status === 401 && !renewed) {
            renewed = true;
            renewToken = true;
            log("Sign-In Renewed", "ChatGPT did not accept the sign-in token. Renewing it and asking again.", { quiet: true });
            continue;
          }
          if (status === 401) {
            log("Sign-In Not Accepted", `ChatGPT (${model}): ${message}`);
            throw new ModelError("auth", "ChatGPT did not accept your sign-in. Sign in with ChatGPT again in Settings, then try again.", { usage: spent });
          }
          if (err.code === "subscription_sharing_usage_limit_exceeded") {
            // No reset time is read from this code: the limit may be the plan's or this app's.
            const limit = {
              kind: "chatgpt-plan",
              title: "ChatGPT Usage Limit",
              short: "Usage limit reached on your ChatGPT plan, or on this app's share of it.",
              message: "Usage limit reached. Your ChatGPT plan, or this app's limit on it, has no more room for now. Review it in ChatGPT settings (Manage usage), then run the task again.",
              resetAt: 0,
              manageUrl: CHATGPT.USAGE_URL,
            };
            log(limit.title, message);
            if (cfg.backup && deps.onSwitch) {
              const next = !providersTried.includes(cfg.backup) ? await deps.onSwitch(provider, cfg.backup, now() + 5 * 3600 * 1000, limit) : null;
              if (next && !providersTried.includes(next.provider)) { providersTried.push(next.provider); cfg = next; model = modelFor(req.tier, cfg); retries = 0; continue; }
            }
            throw new ModelError("limit", limit.message, { limit, usage: spent });
          }
          if (err.code === "subscription_sharing_user_not_eligible") {
            log("ChatGPT Plan Not Available", message);
            throw new ModelError("config", "ChatGPT plan use is not available for this account, workspace or plan: it needs ChatGPT Plus or Pro. Connect another provider in Settings.", { usage: spent });
          }
          if (err.code === "subscription_sharing_route_not_supported" || /^chatpass_v2_/.test(err.code)) {
            log("ChatGPT Refused The Request", `${err.code}: ${message}`);
            throw new ModelError("config", `ChatGPT does not allow this request with your sign-in (${err.code}). Sign in with ChatGPT again in Settings.`, { usage: spent });
          }
          if (status === 400 && req.image && /image/i.test(about)) {
            throw new ModelError("no_vision", "This model cannot look at images.", { usage: spent });
          }
          // Tools in a namespace not taken: offered as a plain function tool instead.
          if (status === 400 && req.tool && !mode.noTools && !mode.flatTools && /namespace/i.test(about)) {
            mode.flatTools = true;
            log("Compatibility", "ChatGPT did not take the tool namespace. Offering the tool on its own.", { quiet: true });
            continue;
          }
          if (err.code === "subscription_sharing_unsupported_capability") {
            log("Not Supported On ChatGPT", `${err.param || "request"}: ${message}`);
            throw new ModelError("invalid", `ChatGPT plan usage does not take part of this request${err.param ? ` (${err.param})` : ""}: ${message}`, { usage: spent });
          }
          // Any other refusal says what ChatGPT said, and what is most often behind it.
          if (status === 400 && !err.code) {
            log("ChatGPT Refused The Request", message);
            throw new ModelError("invalid", `ChatGPT refused the request${message ? `: ${message}` : ""}. Using a ChatGPT plan here needs Plus or Pro; on another plan, connect a different provider in Settings.`, { usage: spent });
          }
          if (status === 403) {
            log("ChatGPT Refused The Request", message);
            throw new ModelError("config", `ChatGPT turned the request away: ${message}`, { usage: spent });
          }
        }
        if (status === 401 || status === 403) {
          log("Key Not Accepted", `${providerName(provider)} (${model}): ${message}`);
          throw new ModelError("auth", `${providerName(provider)} did not accept your API key (it may have been revoked or mistyped). Reconnect it in Settings, then try again.`, { usage: spent });
        }
        // Out of credit or out of the day's requests: waiting will not help.
        const limit = LIMITS && LIMITS.describeLimit({ provider, model, status, body: res.raw, headers: res.headers, now: now() });
        if (limit) {
          log(limit.title, message);
          if (cfg.backup && deps.onSwitch && !providersTried.includes(cfg.backup)) {
            const until = limit.resetAt || now() + 6 * 3600 * 1000;
            const next = await deps.onSwitch(provider, cfg.backup, until, limit);
            if (next && !providersTried.includes(next.provider)) { providersTried.push(next.provider); cfg = next; model = modelFor(req.tier, cfg); retries = 0; continue; }
          }
          throw new ModelError("limit", limit.message, { limit, usage: spent, provider });
        }
        if (status === 400 && req.tool && !mode.noTools) {
          // A forced tool is refused by some models: offer it instead. Tools
          // refused outright: write the fields as JSON.
          if (!mode.autoChoice && /tool_choice|forced|required/i.test(message)) { mode.autoChoice = true; log("Tool Choice", "This model does not take a forced tool; offering it instead.", { quiet: true }); continue; }
          if (/tool|function/i.test(message)) { mode.noTools = true; log("Tools Unsupported", "The provider rejected tools. Using plain JSON replies on this connection.", { quiet: true }); continue; }
        }
        if (status === 400 && provider !== "anthropic" && !mode.noCompat && /response_format|json_object|json_mode|stream_options|unsupported|unrecognized|unknown (?:field|parameter|argument)/i.test(message)) {
          mode.noCompat = true;
          log("Compatibility", "The provider rejected optional request fields. Retrying without them.", { quiet: true });
          continue;
        }
        if ((status === 400 || status === 404) && req.image && /image|vision/i.test(message)) {
          throw new ModelError("no_vision", "This model cannot look at images.", { usage: spent });
        }
        if (retries < 3 && (status === 429 || status >= 500 || status === 408 || status === 0)) {
          // Busy: the same provider's sibling model usually answers at once,
          // and has its own allowance where requests are counted per model.
          const sibling = [503, 529, 429].includes(status) ? DEFAULTS.siblingModel(provider, model, tried) : "";
          if (sibling) {
            log("Model Busy", `${model} is busy; trying ${sibling} instead.`, { quiet: true });
            tried.push(model);
            model = sibling;
            continue;
          }
          let wait = 2000 * 2 ** retries + Math.random() * 1000;
          // How long the provider says to wait: in a header, or in its own words
          // ("retryDelay": "34s", "try again in 20s"). A per-minute allowance is
          // back within the minute, and that is worth waiting for.
          const said = String(res.raw || "").match(/retry(?:Delay|[- ]after)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s|(?:try again|retry(?: again)?) in\s+(\d+(?:\.\d+)?)\s*s/i);
          const after = res.headers["retry-after"] || (said ? String(Math.ceil(parseFloat(said[1] || said[2]))) : "");
          if (status === 429 && after) {
            const secs = parseInt(after, 10);
            // A wait of more than about a minute is not waited out inside the
            // call: the run pauses for it instead, and carries on after.
            if (!Number.isNaN(secs) && secs > 65) {
              log("Rate Limited", `HTTP 429. ${providerName(provider)} asked to wait ${secs} seconds.`, { quiet: true });
              throw new ModelError("rate_limited", `${providerName(provider)} asked to wait ${secs >= 120 ? `about ${Math.round(secs / 60)} minutes` : `${secs} seconds`} before it takes more requests.`, { waitMs: secs * 1000, usage: spent });
            }
            if (!Number.isNaN(secs)) wait = secs * 1000 + Math.random() * 500;
          } else if (status === 429) {
            // No hint given: 5, 15 and 40 seconds cover a per-minute allowance.
            wait = [5000, 15000, 40000][retries] + Math.random() * 1000;
          }
          retries += 1;
          log(status === 429 ? "Rate Limited" : status === 408 ? "No Answer In Time" : "Provider Error", `${status ? `HTTP ${status}` : "Network error"}. Trying again in ${Math.round(wait / 1000)}s (${retries}/3).`, { quiet: true, waitMs: wait });
          await sleep(wait);
          if (req.signal && req.signal.aborted) throw new ModelError("aborted", "Stopped.");
          continue;
        }
        log("Model Call Failed", `${message} (HTTP ${status})`);
        if (status === 429) throw new ModelError("rate_limited", `${providerName(provider)} kept turning requests away as too many${provider === "openrouter" && /free/.test(model) ? " (free models get crowded at peak times)" : ""}.`, { waitMs: 0, usage: spent });
        // Plan usage could not be checked: the credentials stand, and the run waits and tries again.
        if (provider === "chatgpt" && status === 503) throw new ModelError("rate_limited", "ChatGPT could not check your plan's usage just now.", { waitMs: 0, usage: spent });
        if (status >= 500 || status === 0 || status === 408) throw new ModelError("unreachable", `Couldn't reach ${providerName(provider)} after several tries. Check your connection, or try again in a minute.`, { usage: spent });
        throw new ModelError("invalid", message || "The model request failed.", { usage: spent });
      }
    }

    return { call };
  }

  const api = Object.freeze({ createClient, repairArguments, readLoose, settingsFrom, keyProblem, modelFits, providerName, buildRequest, effortFields, errorText, cacheOf, ModelError });
  root.SELECT_TO_AI_LLM = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
