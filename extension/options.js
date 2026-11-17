/**
 * Select to AI - settings page.
 *
 * Every control saves its own key the moment it changes, and only that key.
 * Nothing is written for settings the user never touched, so a default that
 * improves in a later version reaches everyone who has not chosen otherwise.
 */
(function () {
  "use strict";

  const { STORAGE } = CONFIG;
  const D = SELECT_TO_AI_DEFAULTS;
  const AGENT = D.AGENT_DEFAULTS;
  const S = SELECT_TO_AI_SETUP;
  const G = SELECT_TO_AI_GRANTS;
  const $ = (id) => document.getElementById(id);

  // Sign in with ChatGPT is offered only when the feature is on
  // (defaults.js FEATURES). Someone already using it still sees it selected.
  const chatgptOption = document.querySelector('#provider option[value="chatgpt"]');
  const showChatGPTOption = (p) => { if (chatgptOption) chatgptOption.hidden = chatgptOption.disabled = !D.FEATURES.chatgptSignIn && p !== "chatgpt"; };

  const PROVIDERS = {
    chatgpt: { name: "ChatGPT", keyUrl: "", placeholder: "" },
    openrouter: { name: "OpenRouter", keyUrl: "https://openrouter.ai/keys", placeholder: "sk-or-v1-…", prefix: "sk-or-" },
    openai: { name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys", placeholder: "sk-…", prefix: "sk-" },
    anthropic: { name: "Anthropic", keyUrl: "https://platform.claude.com/settings/keys", placeholder: "sk-ant-…", prefix: "sk-ant-" },
    gemini: { name: "Google Gemini", keyUrl: "https://aistudio.google.com/app/apikey", placeholder: "AIza… or AQ.…", prefix: ["AIza", "AQ."] },
    groq: { name: "Groq", keyUrl: "https://console.groq.com/keys", placeholder: "gsk_…", prefix: "gsk_" },
    deepseek: { name: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys", placeholder: "sk-…", prefix: "sk-" },
    mistral: { name: "Mistral", keyUrl: "https://console.mistral.ai/api-keys/", placeholder: "Mistral API key" },
    xai: { name: "xAI", keyUrl: "https://console.x.ai/", placeholder: "xai-…", prefix: "xai-" },
    together: { name: "Together AI", keyUrl: "https://api.together.ai/settings/api-keys", placeholder: "Together API key" },
    opencode: { name: "OpenCode Zen", keyUrl: "https://opencode.ai/console", placeholder: "oc_sk_…" },
    cerebras: { name: "Cerebras", keyUrl: "https://cloud.cerebras.ai/", placeholder: "csk-…", prefix: "csk-" },
    custom: { name: "your own server", keyUrl: "", placeholder: "Optional" },
  };

  const CG = globalThis.SELECT_TO_AI_CHATGPT || null;
  const CG_UI = globalThis.SELECT_TO_AI_CHATGPT_UI || null;
  // ChatGPT has no key: it is signed in to instead (chatgptConnect.js).
  const keyNameFor = (provider) =>
    provider === "chatgpt" ? null : provider === "custom" ? "agentCustomKey" : D.PROVIDER_ENDPOINTS[provider].keyName;
  const defaultModelFor = (provider) =>
    provider === "chatgpt" ? (CG && CG.bestModel(chatgpt && chatgpt.models)) || D.PROVIDER_FALLBACK_MODELS.chatgpt.pro
      : provider === AGENT.activeProvider ? AGENT.model : D.PROVIDER_FALLBACK_MODELS[provider].lite;
  const baseUrlFor = (provider, customUrl) =>
    provider === "chatgpt" ? (CG ? CG.API_BASE : "") : provider === "custom" ? customUrl || AGENT.customUrl : D.PROVIDER_ENDPOINTS[provider].baseUrl;

  let settings = {};
  let keys = {};
  // The public part of a ChatGPT sign-in: email, whether plan use is on, the model list.
  let chatgpt = null;
  const chatgptReady = () => !!(chatgpt && chatgpt.signedIn && chatgpt.planEnabled);
  const hasCredentials = (p) => (p === "chatgpt" ? chatgptReady() : p === "custom" ? !!settings.agentCustomUrl : !!keys[keyNameFor(p)]);
  const modelLabel = (id) => { const m = provider() === "chatgpt" && chatgpt && (chatgpt.models || []).find((x) => x.slug === id); return m ? m.name : id; };

  // ---------- saving ----------
  let toastTimer;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1400);
  }
  function save(values, quiet) {
    Object.assign(settings, values);
    chrome.storage.sync.set(values, () => {
      if (!quiet) toast("Saved");
    });
  }
  function saveKey(name, value) {
    keys[name] = value;
    chrome.storage.local.set({ [name]: value }, () => toast(value ? "Key saved" : "Key removed"));
  }

  // ---------- data consent and host access ----------
  // Nothing goes to a provider until the user has read what is sent and
  // agreed (setup.js), once per provider. The provider's host is asked for
  // inside the same click.
  let consent = {};
  S.readConsent(chrome.storage.local).then((c) => { consent = c; });
  function withConsent(slot, note, provider, customUrl, go) {
    const id = S.consentId(provider, customUrl);
    const denied = `Chrome did not allow access to ${S.providerName(provider)}, so nothing was sent.`;
    slot.textContent = "";
    if (S.hasConsent(consent, id)) {
      S.requestProviderHost(provider, customUrl).then((ok) => {
        if (ok) { go(); return; }
        note.textContent = denied;
        note.className = "note err";
      });
      return;
    }
    note.textContent = "";
    note.className = "note";
    slot.appendChild(S.consentCard(document, {
      provider,
      customUrl,
      onAgree: () => {
        const reached = S.requestProviderHost(provider, customUrl);
        return S.recordConsent(chrome.storage.local, [id]).then((c) => {
          consent = c;
          return reached;
        }).then((ok) => {
          if (!ok) return denied;
          slot.textContent = "";
          go();
          return "";
        });
      },
      onCancel: () => { note.textContent = "Nothing was sent."; note.className = "note"; },
    }));
  }

  // ---------- theme ----------
  function applyTheme(choice) {
    const dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }

  // ---------- agent status ----------
  const provider = () => settings.agentActiveProvider || AGENT.activeProvider;
  const model = () => settings.agentModel || defaultModelFor(provider());

  function renderStatus() {
    const p = provider();
    const hasKey = hasCredentials(p);
    const on = settings.showAgent === true;
    const dot = $("agentDot");
    const panelOpen = !$("providerPanel").hidden;
    if (hasKey && on) {
      dot.className = "dot ok";
      $("agentStatus").textContent = p === "chatgpt" ? `Signed in to ChatGPT${chatgpt.email ? ` as ${chatgpt.email}` : ""}` : `Connected to ${PROVIDERS[p].name}`;
      const detail = $("agentStatusDetail");
      detail.textContent = model() === "openrouter/free" ? "Using free models. Ready on any tab." : `Using ${modelLabel(model())}.`;
      if (p === "chatgpt" && CG_UI) { detail.append(" "); detail.appendChild(CG_UI.usageLine()); }
      $("connectBtn").hidden = true;
      $("changeBtn").textContent = panelOpen ? "Done" : "Change";
    } else if (hasKey && !on) {
      dot.className = "dot";
      $("agentStatus").textContent = "Turned off";
      $("agentStatusDetail").textContent = `Connected to ${PROVIDERS[p].name}, but hidden everywhere.`;
      $("connectBtn").hidden = false;
      $("connectBtn").textContent = "Turn on";
      $("changeBtn").textContent = panelOpen ? "Done" : "Change";
    } else {
      dot.className = "dot warn";
      $("agentStatus").textContent = "Not connected";
      $("agentStatusDetail").textContent = "Connect a model so the agent can click, type and read pages for you. OpenRouter is free.";
      $("connectBtn").hidden = false;
      $("connectBtn").textContent = "Connect";
      $("changeBtn").textContent = panelOpen ? "Done" : "Use my own key";
    }
    $("changeBtn").hidden = false;
    $("changeBtn").setAttribute("aria-expanded", String(panelOpen));
    $("agentOff").checked = !on;
  }

  $("connectBtn").onclick = () => {
    const p = provider();
    const hasKey = hasCredentials(p);
    if (hasKey) {
      save({ showAgent: true });
      renderStatus();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?step=connect") });
    }
  };
  $("changeBtn").onclick = () => {
    $("providerPanel").hidden = !$("providerPanel").hidden;
    renderStatus();
    if (!$("providerPanel").hidden) $("apiKey").focus();
  };
  $("agentOff").onchange = (e) => {
    if (e.target.checked && assistantsOn() === 0) {
      e.target.checked = false;
      toast("Turn on one assistant first, or right-click has nothing to send to.");
      return;
    }
    save({ showAgent: !e.target.checked });
    renderStatus();
  };

  // ---------- backup provider ----------
  // Used only when the main provider's limit runs out. Free tiers first, then
  // any other provider the user already has a key for.
  const FREE_NOTES = Object.fromEntries((D.FREE_BACKUPS || []).map((b) => [b.provider, b.note]));
  function renderBackup() {
    const main = provider();
    const current = settings.agentBackupProvider || "";
    const select = $("backupProvider");
    select.textContent = "";
    const add = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; select.appendChild(o); };
    add("", "None");
    for (const b of D.FREE_BACKUPS || []) if (b.provider !== main) add(b.provider, `${PROVIDERS[b.provider].name} (free)`);
    for (const p of Object.keys(PROVIDERS)) {
      if (p === main || p === "custom" || FREE_NOTES[p] || !keys[keyNameFor(p)]) continue;
      add(p, `${PROVIDERS[p].name} (your key)`);
    }
    select.value = current && current !== main ? current : "";
    const p = select.value;
    $("backupPanel").hidden = !p;
    if (!p) return;
    const info = PROVIDERS[p];
    $("backupKeyLabel").textContent = `${info.name} API key`;
    $("backupKeyLink").href = info.keyUrl || "#";
    $("backupKeyLink").textContent = FREE_NOTES[p] ? "Get a free key" : "Get a key";
    $("backupKey").placeholder = info.placeholder;
    if (document.activeElement !== $("backupKey")) $("backupKey").value = keys[keyNameFor(p)] || "";
    $("backupHint").textContent = `${FREE_NOTES[p] ? `${FREE_NOTES[p]} ` : ""}While it is in use, your requests and page text go to ${info.name}.`;
  }
  $("backupProvider").onchange = (e) => {
    save({ agentBackupProvider: e.target.value });
    $("backupNote").textContent = "";
    $("backupConsentSlot").textContent = "";
    renderBackup();
    if (e.target.value && !keys[keyNameFor(e.target.value)]) $("backupKey").focus();
  };
  function commitBackupKey() {
    const p = $("backupProvider").value;
    if (!p) return;
    const value = $("backupKey").value.trim();
    if (value === (keys[keyNameFor(p)] || "")) return;
    saveKey(keyNameFor(p), value);
    const warn = keyWarning(p, value);
    $("backupNote").textContent = warn;
    $("backupNote").className = warn ? "note err" : "note";
  }
  $("backupKey").addEventListener("change", commitBackupKey);
  $("backupKey").addEventListener("paste", () => setTimeout(() => { commitBackupKey(); askTestBackup(); }, 0));
  function askTestBackup() {
    const p = $("backupProvider").value;
    if (!p) return;
    if (!$("backupKey").value.trim()) { $("backupNote").textContent = "Paste a key first."; $("backupNote").className = "note err"; return; }
    withConsent($("backupConsentSlot"), $("backupNote"), p, "", testBackup);
  }
  async function testBackup() {
    const p = $("backupProvider").value;
    const key = $("backupKey").value.trim();
    const note = $("backupNote");
    if (!p) return;
    if (!key) { note.textContent = "Paste a key first."; note.className = "note err"; return; }
    note.innerHTML = '<span class="spin"></span>';
    note.className = "note inline";
    note.append(" Checking…");
    $("backupTest").disabled = true;
    try {
      const m = D.PROVIDER_FALLBACK_MODELS[p].lite;
      const req = requestFor(p, key, "", m);
      const res = await proxy(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
      const limit = !res.ok && globalThis.SELECT_TO_AI_LIMITS
        ? SELECT_TO_AI_LIMITS.describeLimit({ provider: p, model: m, status: res.status, body: res.json || res.text, headers: res.headers })
        : null;
      if (res.ok || (res.status === 429 && !limit)) {
        note.textContent = `Works. ${PROVIDERS[p].name} will take over if your requests run out.`;
        note.className = "note ok";
      } else if (limit) {
        note.textContent = `The key works, but ${limit.short.charAt(0).toLowerCase()}${limit.short.slice(1)}`;
        note.className = "note warn";
      } else {
        const msg = res.json && res.json.error ? res.json.error.message || res.json.error : "";
        note.textContent = `${res.status === 401 || res.status === 403 ? "The key was not accepted." : `Error ${res.status}.`} ${String(msg).slice(0, 140)}`;
        note.className = "note err";
      }
    } catch (e) {
      note.textContent = e.message;
      note.className = "note err";
    } finally {
      $("backupTest").disabled = false;
    }
  }
  $("backupTest").onclick = askTestBackup;

  // ---------- provider panel ----------
  function renderProvider() {
    const p = provider();
    const info = PROVIDERS[p];
    showChatGPTOption(p);
    $("provider").value = p;
    $("urlField").hidden = p !== "custom";
    $("keyField").hidden = p === "chatgpt";
    renderChatGPT();
    $("customUrl").value = settings.agentCustomUrl || "";
    $("keyLabel").textContent = p === "custom" ? "API key (optional)" : `${info.name} API key`;
    $("keyLink").hidden = !info.keyUrl;
    $("keyLink").href = info.keyUrl || "#";
    $("apiKey").placeholder = info.placeholder;
    $("apiKey").value = keys[keyNameFor(p)] || "";
    $("model").value = model();
    $("testNote").textContent = "";
    $("testNote").className = "note";
    if (p === "chatgpt") fillModelList(((chatgpt && chatgpt.models) || []).map((m) => m.slug), (chatgpt && chatgpt.models) || []);
    else fillModelList(D.MODEL_PRESETS[p] || []);
  }

  function fillModelList(ids, named) {
    const list = $("modelList");
    list.textContent = "";
    for (const id of [...new Set(ids)].slice(0, 300)) {
      const o = document.createElement("option");
      o.value = id;
      const m = (named || []).find((x) => x.slug === id);
      if (m && m.name !== id) o.label = m.name;
      list.appendChild(o);
    }
  }

  // Sign in with ChatGPT is not in the 4.0 package (no sign-in controls).
  function renderChatGPT() {}
  function chatgptNote() {}

  $("provider").onchange = (e) => {
    const p = e.target.value;
    chatgptNote("");
    // A new provider starts on its own default model, not the old one's id.
    // The helper is on the same provider, so it goes with the old one.
    save({ agentActiveProvider: p, agentModel: defaultModelFor(p), agentHelperModel: "" });
    $("consentSlot").textContent = "";
    $("helperModel").value = "";
    renderProvider();
    renderStatus();
    renderBackup();
    liveModels = null;
  };

  function keyWarning(p, key) {
    const prefix = PROVIDERS[p].prefix;
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    if (!key || !prefix || prefixes.some((x) => key.startsWith(x))) return "";
    return `${PROVIDERS[p].name} keys usually start with ${prefixes.map((x) => `"${x}"`).join(" or ")}. Check you pasted the right one.`;
  }
  function commitKey() {
    const p = provider();
    const value = $("apiKey").value.trim();
    if (value === (keys[keyNameFor(p)] || "")) return;
    saveKey(keyNameFor(p), value);
    // The agent can only reach the provider with Chrome's leave to.
    if (value) S.requestProviderHost(p);
    if (value && settings.showAgent !== true) save({ showAgent: true }, true);
    const warn = keyWarning(p, value);
    $("testNote").textContent = warn;
    $("testNote").className = warn ? "note err" : "note";
    renderStatus();
  }
  $("apiKey").addEventListener("change", commitKey);
  $("apiKey").addEventListener("paste", () => setTimeout(() => { commitKey(); askTest(); }, 0));
  $("revealKey").onclick = () => {
    const input = $("apiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("revealKey").textContent = input.type === "password" ? "Show" : "Hide";
  };

  $("customUrl").addEventListener("change", () => {
    const url = $("customUrl").value.trim();
    const origin = SELECT_TO_AI_SECURITY.customOrigin(url);
    if (!origin) {
      $("testNote").textContent = "Use an https:// address, or one on this computer (localhost or 127.0.0.1).";
      $("testNote").className = "note err";
      return;
    }
    // Chrome only lets the extension reach a server the user has approved.
    chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
      if (chrome.runtime.lastError || !granted) {
        $("testNote").textContent = `Chrome did not allow access to ${origin}.`;
        $("testNote").className = "note err";
        return;
      }
      save({ agentCustomUrl: url, showAgent: true });
      renderStatus();
    });
  });

  $("model").addEventListener("change", () => {
    const value = $("model").value.trim() || defaultModelFor(provider());
    $("model").value = value;
    save({ agentModel: value });
    renderStatus();
  });
  $("helperModel").addEventListener("change", () => {
    const value = $("helperModel").value.trim();
    $("helperModel").value = value;
    save({ agentHelperModel: value });
  });

  // ---------- network, through the background worker (it owns host access) ----------
  function proxy(url, options, candidateCustomUrl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "fetchProxy", url, options, ...(candidateCustomUrl ? { candidateCustomUrl } : {}) }, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || !r.success) return reject(new Error((r && r.error) || "Request failed"));
        let json = null;
        try { json = JSON.parse(r.text); } catch (e) { /* not JSON */ }
        resolve({ ok: r.ok, status: r.status, json, headers: r.headers || {}, text: r.text });
      });
    });
  }

  function requestFor(p, key, customUrl, m) {
    const base = baseUrlFor(p, customUrl);
    const headers = { "Content-Type": "application/json" };
    if (p === "anthropic") {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      return { url: base, headers, body: { model: m, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] } };
    }
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = /\/chat\/completions$/.test(base) ? base : `${base.replace(/\/$/, "")}/chat/completions`;
    return { url, headers, body: { model: m, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] } };
  }

  function askTest() {
    const p = provider();
    if (p === "chatgpt") return;
    if (p !== "custom" && !$("apiKey").value.trim()) { $("testNote").textContent = "Paste a key first."; $("testNote").className = "note err"; return; }
    withConsent($("consentSlot"), $("testNote"), p, p === "custom" ? $("customUrl").value.trim() || settings.agentCustomUrl || AGENT.customUrl : "", test);
  }
  async function test() {
    const p = provider();
    if (p === "chatgpt") return;
    const key = $("apiKey").value.trim();
    const note = $("testNote");
    if (p !== "custom" && !key) {
      note.textContent = "Paste a key first.";
      note.className = "note err";
      return;
    }
    note.innerHTML = '<span class="spin"></span>';
    note.className = "note inline";
    note.append(" Checking…");
    $("testBtn").disabled = true;
    try {
      const customUrl = $("customUrl").value.trim();
      const req = requestFor(p, key, customUrl, model());
      const res = await proxy(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) }, p === "custom" ? customUrl : null);
      const limit = !res.ok && globalThis.SELECT_TO_AI_LIMITS
        ? SELECT_TO_AI_LIMITS.describeLimit({ provider: p, model: model(), status: res.status, body: res.json || res.text, headers: res.headers })
        : null;
      if (limit) {
        // The key is fine; the account's allowance or credit is not.
        note.textContent = limit.kind === "no-credit" ? limit.short : `The key works. ${limit.short}`;
        note.className = "note warn";
      } else if (res.ok || res.status === 429) {
        note.textContent = `Works. ${PROVIDERS[p].name} answered with ${model()}.`;
        note.className = "note ok";
      } else {
        const msg = res.json && res.json.error ? res.json.error.message || res.json.error : "";
        const why = res.status === 401 || res.status === 403 ? "The key was not accepted." : res.status === 404 ? `The model "${model()}" was not found.` : `Error ${res.status}.`;
        note.textContent = `${why} ${String(msg).slice(0, 140)}`;
        note.className = "note err";
      }
    } catch (e) {
      note.textContent = e.message;
      note.className = "note err";
    } finally {
      $("testBtn").disabled = false;
    }
  }
  $("testBtn").onclick = askTest;

  // Live model list, loaded the first time the model box is used.
  let liveModels = null;
  $("model").addEventListener("focus", async () => {
    if (liveModels) return;
    const p = provider();
    // The list comes from the provider, so it waits for the user's yes.
    if (!S.hasConsent(consent, S.consentId(p, settings.agentCustomUrl || AGENT.customUrl))) return;
    liveModels = [];
    if (p === "chatgpt") {
      if (!chatgptReady() || !CG_UI) return;
      const r = await CG_UI.refreshModels();
      if (r.ok) liveModels = r.models.map((m) => m.slug);
      return;
    }
    const key = keys[keyNameFor(p)] || "";
    let url = `${baseUrlFor(p, settings.agentCustomUrl).replace(/\/$/, "")}/models`;
    const headers = {};
    if (p === "anthropic") { url = "https://api.anthropic.com/v1/models"; headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
    else if (p === "gemini") { url = "https://generativelanguage.googleapis.com/v1beta/models"; headers["x-goog-api-key"] = key; }
    else if (key) headers.Authorization = `Bearer ${key}`;
    if (!key && p !== "openrouter" && p !== "custom") return;
    try {
      const res = await proxy(url, { method: "GET", headers });
      const data = res.json || {};
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      liveModels = rows.map((m) => (typeof m === "string" ? m : String(m.id || m.name || "").replace(/^models\//, ""))).filter(Boolean);
      fillModelList([...(D.MODEL_PRESETS[p] || []), ...liveModels]);
    } catch (e) { /* presets stay */ }
  });

  // ---------- Claude, when its host is missing ----------
  // claude.ai is optional in 4.0. The chip shows as on only once the host is
  // held, and a user who had Claude on (showClaude true) without the host is
  // told so, with one button to add it back and one to leave it off.
  function showClaudeState() {
    return G.hasHost(G.ASSISTANT_HOSTS.claude).then((held) => {
      $("showClaude").checked = held && settings.showClaude !== false;
      $("claudeBack").hidden = held || settings.showClaude !== true;
    });
  }
  $("claudeBackAdd").addEventListener("click", () => {
    // Asked for here, inside the click.
    G.requestHost(G.ASSISTANT_HOSTS.claude).then((ok) => {
      if (!ok) { toast("Chrome did not allow claude.ai, so Claude stays off."); return; }
      save({ showClaude: true });
      G.registerAssistantScripts();
      showClaudeState();
    });
  });
  $("claudeBackOff").addEventListener("click", () => {
    save({ showClaude: false });
    showClaudeState();
  });
  // The host can be granted or taken away elsewhere (the popup, Chrome's own page).
  for (const changed of [chrome.permissions.onAdded, chrome.permissions.onRemoved]) {
    if (changed && typeof changed.addListener === "function") changed.addListener(() => { showClaudeState(); });
  }

  // ---------- task notices ----------
  // Notifications are optional and asked for here, by the switch that needs
  // them, not during setup. The switch shows what Chrome holds, since the
  // grant itself is the setting.
  const showNoticeState = () => G.hasNotifications().then((held) => { $("taskNotices").checked = held; });
  $("taskNotices").addEventListener("change", (e) => {
    if (e.target.checked) {
      // Inside the click, so Chrome shows its prompt.
      G.requestNotifications().then((ok) => {
        e.target.checked = ok;
        toast(ok ? "Saved" : "Chrome did not allow notifications, so this stays off.");
      });
      return;
    }
    chrome.permissions.remove({ permissions: ["notifications"] }, () => {
      void chrome.runtime.lastError;
      showNoticeState();
      toast("Saved");
    });
  });

  // ---------- simple controls ----------
  const TOGGLES = {
    agentRiskConfirmation: (s) => s.agentRiskConfirmation !== false,
    showChatGPT: (s) => s.showChatGPT !== false,
    showClaude: (s) => s.showClaude !== false,
    showGemini: (s) => s.showGemini !== false,
    showPerplexity: (s) => s.showPerplexity === true,
    autoSend: (s) => s.autoSend === true,
    // Off unless chosen, as in 2.0: the page address is only sent when asked.
    autoContext: (s) => s.autoContext === true,
    agentLearning: (s) => s.agentLearning !== false,
  };
  const ASSISTANTS = ["showChatGPT", "showClaude", "showGemini", "showPerplexity"];
  const agentOn = () => settings.showAgent === true;
  const assistantsOn = () => ASSISTANTS.filter((id) => $(id).checked).length;
  const NEEDS_ONE = "Keep one assistant on while the agent is off, or right-click has nothing to send to.";
  for (const id of Object.keys(TOGGLES)) {
    if (ASSISTANTS.includes(id) || id === "agentOff") continue;
    $(id).addEventListener("change", (e) => save({ [id]: e.target.checked }));
  }
  for (const id of ASSISTANTS) {
    $(id).addEventListener("change", (e) => {
      const on = e.target.checked;
      if (!on && !agentOn() && assistantsOn() === 0) {
        e.target.checked = true;
        toast(NEEDS_ONE);
        return;
      }
      if (on && id === "showClaude") {
        // claude.ai is optional in 4.0: asked for here, inside the click.
        G.requestHost(G.ASSISTANT_HOSTS.claude).then((ok) => {
          if (!ok) { e.target.checked = false; toast("Chrome did not allow claude.ai, so Claude stays off."); return; }
          save({ showClaude: true });
          G.registerAssistantScripts();
          showClaudeState();
        });
        return;
      }
      if (on && id === "showPerplexity") {
        // www.perplexity.ai is always allowed. perplexity.ai without www is
        // asked for too, for links that land there, and a no changes nothing.
        G.requestHost(G.ASSISTANT_HOSTS.perplexityApex).then((ok) => { if (ok) G.registerAssistantScripts(); });
      }
      save({ [id]: on });
    });
  }

  document.querySelectorAll('input[name="openingMode"]').forEach((r) =>
    r.addEventListener("change", () => save({ openingMode: r.value })),
  );
  document.querySelectorAll('input[name="theme"]').forEach((r) =>
    r.addEventListener("change", () => {
      applyTheme(r.value);
      if (r.value === "system") {
        delete settings.theme;
        chrome.storage.sync.remove("theme", () => toast("Saved"));
      } else save({ theme: r.value });
    }),
  );

  $("agentCostBudget").addEventListener("change", (e) => {
    const v = Math.max(0, parseFloat(e.target.value) || 0);
    e.target.value = v;
    save({ agentCostBudget: v });
  });
  $("agentCheckInMinutes").addEventListener("change", (e) => save({ agentCheckInMinutes: Math.max(0, parseInt(e.target.value, 10) || 0) }));
  $("agentDomainAllowlist").addEventListener("change", (e) => save({ agentDomainAllowlist: e.target.value.trim() }));
  $("agentExtraInstructions").addEventListener("change", (e) => save({ agentExtraInstructions: e.target.value.trim().slice(0, 2000) }));

  // chrome.commands bindings belong to the browser: an extension can read
  // them but not rewrite them, so Change opens chrome://extensions/shortcuts.
  function renderShortcut() {
    if (!chrome.commands || !chrome.commands.getAll) return;
    chrome.commands.getAll((cmds) => {
      const cmd = (cmds || []).find((c) => c.name === "open-palette");
      const key = cmd && cmd.shortcut;
      $("paletteShortcut").textContent = key || "Not set";
      $("paletteShortcutDesc").textContent = key
        ? "Start the agent from any page."
        : "No key is assigned, usually because another extension took it.";
    });
  }
  $("changeShortcutBtn").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderShortcut();
  });

  // ---------- backup ----------
  $("exportBtn").onclick = () => {
    chrome.storage.sync.get(STORAGE.SETTINGS, (sync) => {
      const blob = new Blob([JSON.stringify({ version: chrome.runtime.getManifest().version, includesSecrets: false, sync }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "select-to-ai-settings.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const backup = JSON.parse(text);
        if (!backup.sync || typeof backup.sync !== "object") throw new Error("not a settings file");
        const safe = Object.fromEntries(Object.entries(backup.sync).filter(([k]) => STORAGE.SETTINGS.includes(k)));
        chrome.storage.sync.set(safe, () => location.reload());
      } catch (err) {
        toast(`Could not import: ${err.message}`);
      }
    });
  };

  // ---------- memory ----------
  // What Reset removes from local storage besides the API keys.
  const RESET_LOCAL_KEYS = ["agentDataConsent", "agentUserMemory", "agentSkills", "agentCrossSessionMemory", "agentKnown", "recipesStore", "chatgptAccount", "chatgptCredentials", "chatgptHostId", "agentProviderPause", "sidePanelState"];
  $("manageMemoryBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("agent.html#memory") });

  $("resetBtn").onclick = async () => {
    if (!confirm("Reset every setting and remove your saved API keys, memory, task history and recipes?")) return;
    if (chatgpt && chatgpt.signedIn && CG_UI) await CG_UI.signOut();
    chrome.storage.sync.remove(STORAGE.SETTINGS, () =>
      chrome.storage.local.get(null, (all) => {
        // Everything the extension keeps about the user, as the privacy policy lists it.
        const chats = Object.keys(all || {}).filter((k) => k.startsWith("sessionUrl_"));
        chrome.storage.local.remove([...STORAGE.API_KEYS, ...RESET_LOCAL_KEYS, ...chats], () => location.reload());
      }),
    );
  };

  // ---------- load ----------
  $("extension-version").textContent = `${chrome.runtime.getManifest().version}`;
  chrome.storage.sync.get(STORAGE.SETTINGS, (s) => {
    chrome.storage.local.get([...STORAGE.API_KEYS, "chatgptAccount"], (k) => {
      settings = s || {};
      chatgpt = (k && k.chatgptAccount) || null;
      keys = k || {};
      delete keys.chatgptAccount;
      applyTheme(settings.theme);
      const themeRadio = document.querySelector(`input[name="theme"][value="${settings.theme || "system"}"]`);
      if (themeRadio) themeRadio.checked = true;
      const mode = settings.openingMode === "tab" ? "tab" : "sidePanel";
      document.querySelector(`input[name="openingMode"][value="${mode}"]`).checked = true;
      for (const [id, read] of Object.entries(TOGGLES)) $(id).checked = read(settings);
      // Claude shows as on only once claude.ai is allowed.
      showClaudeState();
      showNoticeState();
      $("agentCostBudget").value = settings.agentCostBudget !== undefined ? settings.agentCostBudget : AGENT.costBudget;
      // A choice saved that the list does not offer shows as the nearest one it does.
      const checkIn = settings.agentCheckInMinutes === undefined ? AGENT.checkInMinutes : Number(settings.agentCheckInMinutes) || 0;
      $("agentCheckInMinutes").value = String(checkIn ? [2, 5, 10, 20].reduce((a, b) => (Math.abs(b - checkIn) < Math.abs(a - checkIn) ? b : a)) : 0);
      $("agentDomainAllowlist").value = settings.agentDomainAllowlist || "";
      $("agentExtraInstructions").value = settings.agentExtraInstructions || "";
      $("helperModel").value = settings.agentHelperModel || "";
      renderProvider();
      renderStatus();
      renderBackup();
      renderShortcut();
      // Arriving from "Set up a free backup" in the agent.
      if (location.hash === "#backup") {
        if (!settings.agentBackupProvider) {
          const first = (D.FREE_BACKUPS || []).find((b) => b.provider !== provider());
          if (first) { save({ agentBackupProvider: first.provider }, true); renderBackup(); }
        }
        $("backup").scrollIntoView({ block: "center" });
        setTimeout(() => $("backupKey").focus(), 300);
      }
    });
  });

  // Keys can change elsewhere (the welcome page, another settings tab).
  chrome.storage.onChanged.addListener((changes, area) => {
    let touched = false;
    for (const [name, { newValue }] of Object.entries(changes)) {
      if (area === "local" && STORAGE.API_KEYS.includes(name)) { keys[name] = newValue; touched = true; }
      if (area === "local" && name === "chatgptAccount") { chatgpt = newValue || null; touched = true; }
      if (area === "sync" && /^(showAgent|agentActiveProvider|agentModel|agentCustomUrl)$/.test(name)) { settings[name] = newValue; touched = true; }
    }
    if (touched) { renderStatus(); renderBackup(); if (provider() === "chatgpt") renderProvider(); }
  });
})();
