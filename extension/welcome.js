/**
 * Select to AI - first-run welcome.
 *
 * One screen and no settings vocabulary: what already works with no account,
 * and right below it one click (OpenRouter sign-in, OAuth PKCE) or one paste
 * to turn the browser agent on. The provider is read off the key itself, so nobody has
 * to know what a "gateway" is.
 */
(function () {
  "use strict";

  const D = globalThis.SELECT_TO_AI_DEFAULTS;
  const $ = (id) => document.getElementById(id);

  // ---- theme: stored preference, else the system's ----
  chrome.storage.sync.get("theme", ({ theme }) => {
    const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  });
  // The quick box's real binding, which differs on macOS and may have been changed.
  const isMac = /Mac/i.test(navigator.platform);
  const pretty = (k) => (isMac ? k.replace(/Command/g, "⌘").replace(/Alt|Option/g, "⌥").replace(/Shift/g, "⇧").replace(/MacCtrl|Ctrl/g, "⌃").replace(/\+/g, "") : k.replace(/\+/g, " "));
  if (chrome.commands && chrome.commands.getAll) {
    chrome.commands.getAll((cmds) => {
      const key = ((cmds || []).find((c) => c.name === "open-palette") || {}).shortcut;
      $("kbdPalette").textContent = key ? pretty(key) : "the quick box shortcut";
    });
  }

  // ---- one screen, plus the "done" state ----
  function show(id) {
    for (const s of ["intro", "done"]) $(s).hidden = s !== id;
  }
  function finish() {
    chrome.storage.local.set({ onboardingComplete: true }, () => window.close());
  }
  $("skip").onclick = finish;
  $("closeWelcome").onclick = finish;

  // ---- status line ----
  function status(kind, text, warning) {
    const el = $("status");
    el.className = "status " + kind;
    el.innerHTML = kind === "busy" ? '<span class="spin"></span>' : "";
    el.appendChild(document.createTextNode(text));
    if (warning) {
      const w = document.createElement("span");
      w.className = "warn-line";
      w.textContent = warning;
      el.appendChild(w);
    }
  }

  // ---- which provider does this key belong to? ----
  // Ordered: specific prefixes before the generic "sk-".
  const KEY_SHAPES = [
    [/^sk-or-/, ["openrouter"]],
    [/^sk-ant-/, ["anthropic"]],
    [/^oc_sk_/, ["opencode"]],
    [/^(AIza|AQ\.)/, ["gemini"]],
    [/^mstrl_/, ["mistral"]],
    [/^gsk_/, ["groq"]],
    [/^csk-/, ["cerebras"]],
    [/^xai-/, ["xai"]],
    [/^sk-/, ["openai", "deepseek"]], // both issue "sk-" keys: try each
  ];
  const NAMES = { chatgpt: "ChatGPT", openrouter: "OpenRouter", anthropic: "Anthropic", opencode: "OpenCode", gemini: "Google Gemini", groq: "Groq", xai: "xAI", openai: "OpenAI", deepseek: "DeepSeek", cerebras: "Cerebras" };

  function candidatesFor(key) {
    for (const [re, providers] of KEY_SHAPES) if (re.test(key)) return providers;
    return [];
  }

  function modelFor(provider) {
    return provider === D.AGENT_DEFAULTS.activeProvider
      ? D.AGENT_DEFAULTS.model
      : D.PROVIDER_FALLBACK_MODELS[provider].lite;
  }

  /** One tiny real call, so a key is only saved once it provably works. */
  async function testKey(provider, key) {
    const model = modelFor(provider);
    const base = D.PROVIDER_ENDPOINTS[provider].baseUrl;
    let url, headers, body;
    if (provider === "anthropic") {
      url = base;
      headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
      body = { model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
    } else {
      url = base.replace(/\/$/, "") + "/chat/completions";
      headers = { "content-type": "application/json", authorization: "Bearer " + key };
      if (provider === "openrouter") { headers["HTTP-Referer"] = "https://github.com/arnav-goel10/select-to-ai"; headers["X-Title"] = "Select to AI"; }
      body = { model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
    }
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (res.ok) return { ok: true };
    let message = "";
    let data = null;
    try { data = await res.json(); message = (data.error && (data.error.message || data.error)) || data.message || ""; } catch (e) { /* not JSON */ }
    // A rate-limited free model still proves the key itself is valid; say so
    // if today's allowance is already spent, so the first task is no surprise.
    if (res.status === 429) {
      const headersObj = {};
      res.headers.forEach((v, k) => { headersObj[k] = v; });
      const limit = globalThis.SELECT_TO_AI_LIMITS && SELECT_TO_AI_LIMITS.describeLimit({ provider, model, status: 429, body: data || message, headers: headersObj });
      return { ok: true, note: limit ? limit.short : "" };
    }
    return { ok: false, status: res.status, message: String(message).slice(0, 160) };
  }

  function save(provider, key) {
    const keyName = D.PROVIDER_ENDPOINTS[provider].keyName;
    return new Promise((resolve) =>
      chrome.storage.local.set({ [keyName]: key, onboardingComplete: true }, () =>
        chrome.storage.sync.set({ agentActiveProvider: provider, agentModel: modelFor(provider), showAgent: true }, resolve),
      ),
    );
  }

  let checking = false;
  async function connectWithKey(key, source) {
    if (checking) return;
    key = key.trim();
    if (!key) { status("err", "Paste a key first."); return; }
    const providers = candidatesFor(key);
    if (!providers.length) {
      status("err", "That doesn't look like a key from a provider this page knows. You can add Mistral, Together or your own server in Settings.");
      return;
    }
    let lastError = null;
    checking = true;
    try {
    for (const provider of providers) {
      status("busy", `Checking your ${NAMES[provider]} key…`);
      try {
        const result = await testKey(provider, key);
        if (result.ok) {
          await save(provider, key);
          status("ok", `Connected to ${NAMES[provider]}.`, result.note);
          setTimeout(() => showDone(provider, source), result.note ? 4000 : 500);
          return;
        }
        lastError = { provider, ...result };
      } catch (e) {
        lastError = { provider, message: e.name === "TimeoutError" ? "the provider did not answer in time" : e.message };
      }
    }
    } finally { checking = false; }
    const why = lastError.status === 401 || lastError.status === 403
      ? "the key was not accepted"
      : lastError.message || `error ${lastError.status}`;
    status("err", `${NAMES[lastError.provider]} said ${why}. Check the key and try again.`);
  }

  $("useKey").onclick = () => connectWithKey($("keyInput").value, "paste");
  $("keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") connectWithKey($("keyInput").value, "paste"); });
  // Pasting is the whole gesture: no button press needed.
  $("keyInput").addEventListener("paste", () => setTimeout(() => connectWithKey($("keyInput").value, "paste"), 0));

  // ---- one click: OpenRouter sign-in (OAuth PKCE) ----
  function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function connectOpenRouter() {
    const btn = $("connectOR");
    btn.disabled = true;
    status("busy", "Waiting for you to sign in to OpenRouter…");
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      const callback = chrome.identity.getRedirectURL("openrouter");
      const authUrl = "https://openrouter.ai/auth?" + new URLSearchParams({
        callback_url: callback,
        code_challenge: challenge,
        code_challenge_method: "S256",
        key_label: "Select to AI",
      });
      const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
      const code = new URL(redirected).searchParams.get("code");
      if (!code) throw new Error("OpenRouter did not send back a sign-in code.");
      status("busy", "Creating your free key…");
      const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.key) throw new Error((data.error && data.error.message) || `OpenRouter answered ${res.status}.`);
      await save("openrouter", data.key);
      status("ok", "Connected to OpenRouter.");
      setTimeout(() => showDone("openrouter", "oauth"), 500);
    } catch (e) {
      const cancelled = /did not approve|cancel|closed/i.test(e.message || "");
      status("err", cancelled ? "Sign-in was closed before it finished. Try again, or paste a key below." : e.message);
    } finally {
      btn.disabled = false;
    }
  }
  $("connectOR").onclick = connectOpenRouter;

  // ---- or: the user's own ChatGPT plan (Sign in with ChatGPT) ----
  // Shown only when the feature is on (defaults.js FEATURES).
  const UI = globalThis.SELECT_TO_AI_CHATGPT_UI;
  if (!D.FEATURES.chatgptSignIn) {
    $("chatgptWay").remove();
    $("chatgptMention").remove();
  }
  const chatgptBtn = UI.button({ block: true });
  if (D.FEATURES.chatgptSignIn) $("chatgptSlot").appendChild(chatgptBtn);
  chatgptBtn.onclick = async () => {
    chatgptBtn.disabled = true;
    status("busy", "Opening ChatGPT sign-in…");
    try {
      const r = await UI.signIn({ use: true }, (text) => status("busy", text));
      if (r.state === "ok") {
        status("ok", r.message);
        await UI.welcomeOnce();
        setTimeout(() => showDone("chatgpt"), 500);
      } else {
        status("err", r.message);
      }
    } finally {
      chatgptBtn.disabled = false;
    }
  };

  // ---- done: a first task, one click away ----
  const FIRST_TASKS = [
    ["What's the top story on Hacker News right now?", "news.ycombinator.com"],
    ["Open Wikipedia and tell me today's featured article in two sentences", "wikipedia.org"],
    ["Go to GitHub Trending and tell me today's top repository and what it does", "github.com"],
  ];
  function showDone(provider) {
    const free = provider === "openrouter";
    $("doneLede").textContent = (free
      ? "You're on OpenRouter's free models."
      : provider === "chatgpt" ? "You're using your ChatGPT plan." : `You're on ${NAMES[provider]}.`) +
      " Try a first task. Chrome will ask once to let the agent use websites, and you can stop it at any time.";
    const list = $("tries");
    list.textContent = "";
    for (const [task, site] of FIRST_TASKS) {
      const b = document.createElement("button");
      b.className = "try";
      b.innerHTML = `<span></span><em></em>`;
      b.firstChild.textContent = task;
      b.lastChild.textContent = site;
      b.onclick = () => openAgent(task);
      list.appendChild(b);
    }
    show("done");
  }
  function openAgent(task) {
    const url = chrome.runtime.getURL("agent.html") + (task ? `?task=${encodeURIComponent(task)}&autostart=1` : "");
    // The first run needs to read real websites. Asking here, on the click,
    // means one Chrome prompt now instead of a pause on every new site.
    chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] }, () => {
      void chrome.runtime.lastError;
      chrome.tabs.create({ url });
    });
  }
  $("openAgent").onclick = () => openAgent("");

  // Arriving from Settings or the popup: the connect card is what they came for.
  if (new URLSearchParams(location.search).get("step") === "connect") {
    $("connect").scrollIntoView({ block: "center" });
    setTimeout(() => $("connectOR").focus(), 50);
  }
})();
