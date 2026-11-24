/**
 * Select to AI - first-run welcome.
 *
 * One screen and no settings vocabulary: what already works with no account,
 * and right below it the provider picker that turns the browser agent on.
 * Step 1 lists every provider the extension supports (defaults.js
 * PROVIDER_INFO), with a paste box above it that reads the provider off the
 * key. Step 2 connects the one picked (OpenRouter sign-in by OAuth PKCE, a
 * key, or your own server's address), then offers its models.
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

  // The free path's daily cap, said beside the choice that picks it.
  $("freeCapNote").textContent = D.freeCapNote("openrouter");

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
    if (text) el.appendChild(document.createTextNode(text));
    if (warning) {
      const w = document.createElement("span");
      w.className = "warn-line";
      w.textContent = warning;
      el.appendChild(w);
    }
  }

  // ---- which provider does this key belong to? (setup.js) ----
  // The key's shape names one provider and the key goes only there. A second
  // provider is offered only after a plain 401, and only if the user picks it.
  const S = globalThis.SELECT_TO_AI_SETUP;
  const name = (p) => S.providerName(p);
  const INFO = D.PROVIDER_INFO;

  /** The model a key is tested on, and that a provider starts on: OpenRouter's free one, else its main model. */
  function modelFor(provider) {
    return provider === D.AGENT_DEFAULTS.activeProvider
      ? D.AGENT_DEFAULTS.model
      : D.startModelFor(provider);
  }

  // ---- prices and names, for the model choice ----
  const dollars = (x) => `$${x.toFixed(2)}`;
  /** "$0.10 in, $0.50 out per million tokens", "free", or "" when no price is on file. */
  function priceLine(model) {
    const p = D.pricePerMillion(model);
    if (!p) return "";
    if (!p.input && !p.output) return "free";
    return `${dollars(p.input)} in, ${dollars(p.output)} out per million tokens`;
  }
  /** A model id's last part as words: "claude-haiku-5.5" reads "Claude Haiku 5.5". */
  function modelName(id) {
    const last = String(id || "").split("/").pop().replace(/:free$/, "");
    return last.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  /** One tiny real call, so a key is only saved once it provably works. */
  async function testKey(provider, key) {
    const model = modelFor(provider);
    const req = S.testRequest(provider, key, model);
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30000) });
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

  /** Keeps a key that passed its check. The provider and model are saved by "Save and continue". */
  function saveKey(provider, key) {
    const keyName = provider === "custom" ? "agentCustomKey" : D.PROVIDER_ENDPOINTS[provider].keyName;
    return new Promise((resolve) => chrome.storage.local.set({ [keyName]: key, onboardingComplete: true }, resolve));
  }

  // ---- the data consent, before the first request to a provider ----
  let consent = {};
  S.readConsent(chrome.storage.local).then((c) => { consent = c; });

  function clearConsentCard() { $("consentSlot").textContent = ""; }

  /**
   * Runs `go` once the user has agreed to send data to `provider` and Chrome
   * lets the extension reach it. With consent already given, the host is
   * asked for at once, inside the gesture that called this. Resolves to a
   * problem to show, or to "".
   */
  function withConsent(provider, go, customUrl) {
    const id = S.consentId(provider, customUrl);
    if (S.hasConsent(consent, id)) {
      clearConsentCard();
      return S.requestProviderHost(provider, customUrl).then((ok) => {
        if (!ok) return `Chrome did not allow access to ${name(provider)}, so nothing was sent.`;
        go();
        return "";
      });
    }
    status("", "");
    clearConsentCard();
    $("consentSlot").appendChild(S.consentCard(document, {
      provider,
      customUrl,
      onAgree: () => {
        // The host request goes first, while the click still counts.
        const reached = S.requestProviderHost(provider, customUrl);
        return S.recordConsent(chrome.storage.local, [id]).then((c) => {
          consent = c;
          return reached;
        }).then((ok) => {
          if (!ok) return `Chrome did not allow access to ${name(provider)}. Try again and press Allow.`;
          clearConsentCard();
          go();
          return "";
        });
      },
      onCancel: () => status("", "Nothing was sent."),
    }));
    return Promise.resolve("");
  }

  // ---- step 1: the providers, from one table (defaults.js PROVIDER_INFO) ----
  let chosen = "";
  let lastCard = null;
  let credit = null;
  let serverModels = [];
  let serverUrl = "";
  const cards = {};

  function tag(text, free) {
    const t = document.createElement("span");
    t.className = free ? "tag free" : "tag";
    t.textContent = text;
    return t;
  }
  function card(provider) {
    const info = INFO[provider];
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prov";
    b.id = `prov-${provider}`;
    const title = document.createElement("b");
    title.textContent = info.name;
    // A badge says why to pick it; a free tier is said on every card that has one.
    if (info.badge) title.appendChild(tag(info.badge, info.free && provider !== "openrouter"));
    else if (info.free) title.appendChild(tag("Free tier", true));
    const line = document.createElement("span");
    line.className = "line";
    line.textContent = info.line;
    b.append(title, line);
    b.onclick = () => pick(provider, { from: b });
    cards[provider] = b;
    item.appendChild(b);
    return item;
  }
  for (const provider of Object.keys(INFO)) {
    $(INFO[provider].top ? "providerGrid" : "moreGrid").appendChild(card(provider));
  }

  function lede(provider) {
    if (provider === "openrouter") return "Sign in to make a key in one step, or paste one you already have. It stays in this browser.";
    if (provider === "custom") return "The address of any OpenAI-compatible server, such as Ollama or LM Studio. A key is needed only if your server asks for one.";
    return `Make a key on ${name(provider)}'s site, then paste it here. It stays in this browser and goes only to ${name(provider)}.`;
  }

  // ---- step 2: connect the provider picked ----
  function pick(provider, opts) {
    const info = INFO[provider];
    if (!info) return;
    chosen = provider;
    credit = null;
    lastCard = (opts && opts.from) || cards[provider] || null;
    $("pickStep").hidden = true;
    $("keyStep").hidden = false;
    $("keyTitle").textContent = provider === "custom" ? "Connect your own server" : `Connect ${info.name}`;
    $("keyLede").textContent = lede(provider);
    $("orSignIn").hidden = provider !== "openrouter";
    $("urlField").hidden = provider !== "custom";
    $("keyLabel").textContent = provider === "custom" ? "API key (optional)" : `${info.name} API key`;
    $("getKey").hidden = !info.keyUrl;
    $("getKey").href = info.keyUrl || "#";
    $("getKey").textContent = info.free ? "Get a free key" : "Get a key";
    $("getKey").setAttribute("aria-label", `Get a key from ${info.name}, in a new tab`);
    $("providerKey").placeholder = info.placeholder || "";
    $("providerKey").value = (opts && opts.key) || "";
    $("modelStep").hidden = true;
    status("", "");
    clearConsentCard();
    $("keyTitle").focus();
  }
  $("backToPick").onclick = () => {
    chosen = "";
    $("keyStep").hidden = true;
    $("pickStep").hidden = false;
    status("", "");
    clearConsentCard();
    if (lastCard) lastCard.focus();
  };

  let checking = false;
  /** The paste box above the providers: the key's shape picks the provider. */
  function connectWithKey(key, source) {
    if (checking) return;
    key = key.trim();
    if (!key) { status("err", "Paste a key first."); return; }
    const route = S.routeKey(key);
    if (!route) {
      status("err", "That does not look like a key from a provider this page knows. Pick your provider below and paste it there.");
      return;
    }
    pick(route.provider, { key });
    withConsent(route.provider, () => runCheck(key, source)).then((problem) => { if (problem) status("err", problem); });
  }

  async function runCheck(key, source) {
    if (checking) return;
    checking = true;
    let r;
    try {
      status("busy", `Checking your ${name(S.routeKey(key).provider)} key…`);
      r = await S.checkKey(key, (p) => testKey(p, key));
    } finally { checking = false; }
    if (r.state === "ok") { await connected(r.provider, key, r.note, source); return; }
    if (r.state === "unknown") { status("err", "That does not look like a key from a provider this page knows."); return; }
    status("err", S.failureText(r.provider, r.error));
    if (r.alt) offerOther(key, r.alt, r.provider, r.error, source);
  }

  /** The Connect button of step 2: the provider the user picked. */
  function connectChosen() {
    if (checking || !chosen) return;
    const provider = chosen;
    if (provider === "custom") { connectServer(); return; }
    const key = $("providerKey").value.trim();
    if (!key) { status("err", "Paste a key first."); return; }
    const route = S.routeKey(key);
    // A key another provider issues is named before anything is sent.
    if (route && route.provider !== provider && route.alt !== provider) { offerSwitch(route.provider, provider, key); return; }
    if (route && route.provider === provider) {
      withConsent(provider, () => runCheck(key, "paste")).then((problem) => { if (problem) status("err", problem); });
      return;
    }
    // The shape names no provider, or this one as its second: the user picked it, so it goes here alone.
    withConsent(provider, () => runDirect(provider, key)).then((problem) => { if (problem) status("err", problem); });
  }

  async function runDirect(provider, key) {
    if (checking) return;
    checking = true;
    let result;
    try {
      status("busy", `Checking your ${name(provider)} key…`);
      result = await testKey(provider, key);
    } catch (e) {
      result = { ok: false, message: e && e.name === "TimeoutError" ? "the provider did not answer in time" : String((e && e.message) || e) };
    } finally { checking = false; }
    if (result.ok) { await connected(provider, key, result.note, "paste"); return; }
    status("err", S.failureText(provider, result));
  }

  function offerSwitch(other, picked, key) {
    status("err", `That looks like a key from ${name(other)}, not from ${name(picked)}. Nothing was sent.`);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-ghost try-other";
    b.textContent = `Use ${name(other)} instead`;
    b.onclick = () => { pick(other, { key }); connectChosen(); };
    $("status").appendChild(b);
  }

  async function connected(provider, key, note) {
    // Step 2 shows the provider that answered, whichever way the key came.
    if (chosen !== provider) pick(provider, { key });
    await saveKey(provider, key);
    status("ok", `Connected to ${name(provider)}.`, note);
    if (provider === "openrouter") credit = await readCredit(key);
    showModelChoice(provider);
  }

  // The same key shape is issued by one other provider. The user decides
  // whether it goes there. It is never sent there on its own.
  function offerOther(key, alt, first, firstError, source) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-ghost try-other";
    b.textContent = `It is a ${name(alt)} key`;
    b.onclick = () => {
      b.remove();
      withConsent(alt, async () => {
        status("busy", `Checking your ${name(alt)} key…`);
        let result;
        try { result = await testKey(alt, key); } catch (e) { result = { ok: false, message: e.name === "TimeoutError" ? "the provider did not answer in time" : e.message }; }
        if (result.ok) { await connected(alt, key, result.note, source); return; }
        // The first provider's answer is the one reported, with this one after it.
        status("err", S.failureText(first, firstError), `${name(alt)} did not accept it either.`);
      }).then((problem) => { if (problem) status("err", problem); });
    };
    $("status").appendChild(b);
  }

  $("useKey").onclick = () => connectWithKey($("keyInput").value, "paste");
  $("keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) connectWithKey($("keyInput").value, "paste"); });
  // Pasting is the whole gesture: no button press needed.
  $("keyInput").addEventListener("paste", () => setTimeout(() => connectWithKey($("keyInput").value, "paste"), 0));
  $("connectKey").onclick = connectChosen;
  $("providerKey").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) connectChosen(); });
  $("providerKey").addEventListener("paste", () => setTimeout(() => { if (chosen !== "custom") connectChosen(); }, 0));
  $("serverUrl").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) connectChosen(); });

  // ---- OpenRouter: has this account bought credit? ----
  // GET /api/v1/key says is_free_tier: true until the account has paid for
  // credit once (openrouter.ai/docs/api-reference/limits). Unknown is null.
  async function readCredit(key) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
      const data = ((await res.json()) || {}).data || {};
      return data.is_free_tier === false ? true : data.is_free_tier === true ? false : null;
    } catch (_e) {
      return null;
    }
  }

  // ---- your own server: its address, and the models it lists ----
  function connectServer() {
    const url = ($("serverUrl").value.trim() || D.AGENT_DEFAULTS.customUrl).replace(/\/$/, "");
    // The same rule as Settings and the worker: HTTPS, or this computer.
    if (!globalThis.SELECT_TO_AI_SECURITY.customOrigin(url)) {
      status("err", "Use an https:// address, or one on this computer (localhost or 127.0.0.1).");
      return;
    }
    const key = $("providerKey").value.trim();
    withConsent("custom", () => listServerModels(url, key), url).then((problem) => { if (problem) status("err", problem); });
  }
  async function listServerModels(url, key) {
    if (checking) return;
    checking = true;
    status("busy", "Asking your server for its models…");
    try {
      const res = await fetch(`${url}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { status("err", `Your server answered ${res.status}. Check the address and key, then try again.`); return; }
      const data = (await res.json().catch(() => ({}))) || {};
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      serverModels = [...new Set(rows.map((m) => (typeof m === "string" ? m : String(m.id || m.name || ""))).filter(Boolean))];
      if (!serverModels.length) { status("err", "Your server listed no models. Load one on it, then try again."); return; }
      serverUrl = url;
      if (key) await saveKey("custom", key);
      status("ok", `Connected to your own server. It lists ${serverModels.length === 1 ? "one model" : `${serverModels.length} models`}.`);
      showModelChoice("custom");
    } catch (e) {
      status("err", e && e.name === "TimeoutError" ? "Your server did not answer in time." : "Your server could not be reached. Check that it is running.");
    } finally {
      checking = false;
    }
  }

  // ---- the model choice, once the connection works ----
  function option(id, label) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    return o;
  }
  function showModelChoice(provider) {
    const pair = D.PROVIDER_FALLBACK_MODELS[provider] || {};
    const isOR = provider === "openrouter";
    $("modelStep").hidden = false;
    $("planField").hidden = !isOR;
    $("modelField").hidden = isOR;
    if (isOR) {
      const paid = priceLine(pair.lite);
      $("planPaidLine").textContent = `${modelName(pair.lite)}${paid ? `, about ${paid.replace(", ", " and ")}` : ""}. Needs credit on OpenRouter.`;
      $("planFree").checked = credit !== true;
      $("planPaid").checked = credit === true;
      $("planWhy").textContent = credit === true
        ? "Paid is picked because this account has bought credit."
        : credit === false
          ? "Free is picked because this account has no credit yet."
          : "Free is picked, since OpenRouter did not say whether this account has credit.";
    } else {
      const ids = provider === "custom" ? serverModels : [...new Set([pair.lite, ...(D.MODEL_PRESETS[provider] || [])].filter(Boolean))];
      const list = $("modelPick");
      list.textContent = "";
      for (const id of ids) {
        const price = provider === "custom" ? "" : priceLine(id);
        list.appendChild(option(id, price ? `${id}, ${price}` : id));
      }
      list.value = provider === "custom" ? ids[0] : pair.lite;
    }
    const stronger = !isOR && provider !== "custom" && pair.pro && pair.pro !== pair.lite;
    $("strongerRow").hidden = !stronger;
    $("useStronger").checked = false;
    if (stronger) {
      const price = priceLine(pair.pro);
      $("strongerDetail").textContent = `${pair.pro}${price ? `, ${price}` : ""}. It takes over when the agent is stuck, and checks its answers.`;
    }
    (isOR ? $(credit === true ? "planPaid" : "planFree") : $("modelPick")).focus();
  }

  $("saveSetup").onclick = () => {
    const provider = chosen;
    if (!provider) return;
    const pair = D.PROVIDER_FALLBACK_MODELS[provider] || {};
    const model = provider === "openrouter"
      ? ($("planPaid").checked ? pair.lite : pair.free)
      : $("modelPick").value || modelFor(provider);
    const helper = $("useStronger").checked && !$("strongerRow").hidden && pair.pro !== model ? pair.pro : "";
    const values = { agentActiveProvider: provider, agentModel: model, agentHelperModel: helper, showAgent: true };
    if (provider === "custom") values.agentCustomUrl = serverUrl;
    chrome.storage.local.set({ onboardingComplete: true }, () =>
      chrome.storage.sync.set(values, () => showDone(provider, model)));
  };

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
      status("busy", "Creating your key…");
      const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.key) throw new Error((data.error && data.error.message) || `OpenRouter answered ${res.status}.`);
      await connected("openrouter", data.key, "");
    } catch (e) {
      const cancelled = /did not approve|cancel|closed/i.test(e.message || "");
      status("err", cancelled ? "Sign-in was closed before it finished. Try again, or paste a key below." : e.message);
    } finally {
      btn.disabled = false;
    }
  }
  $("connectOR").onclick = () => {
    withConsent("openrouter", connectOpenRouter).then((problem) => { if (problem) status("err", problem); });
  };

  // ---- done: a first task, one click away ----
  const FIRST_TASKS = [
    ["What's the top story on Hacker News right now?", "news.ycombinator.com"],
    ["Open Wikipedia and tell me today's featured article in two sentences", "wikipedia.org"],
    ["Go to GitHub Trending and tell me today's top repository and what it does", "github.com"],
  ];
  // A task typed in the quick box while the agent was off is not offered
  // here: the worker offers it whenever the agent is turned on, from this
  // page or anywhere else (background.js offerKeptTask).
  function tryButton(task, note, onclick) {
    const b = document.createElement("button");
    b.className = "try";
    b.innerHTML = `<span></span><em></em>`;
    b.firstChild.textContent = task;
    b.lastChild.textContent = note;
    b.onclick = onclick;
    return b;
  }

  function showDone(provider, model) {
    const free = provider === "openrouter" && D.findModelRates(model)[0] === 0;
    $("doneLede").textContent = (free
      ? `You're on OpenRouter's free models. ${D.freeCapNote("openrouter")}`
      : provider === "chatgpt" ? "You're using your ChatGPT plan." : `You're on ${name(provider)}, using ${model}.`) +
      " Try a first task. Chrome will ask to let the agent use that one site, and you can stop it at any time.";
    const list = $("tries");
    list.textContent = "";
    for (const [task, site] of FIRST_TASKS) list.appendChild(tryButton(task, site, () => openAgent(task, site)));
    show("done");
  }
  function openAgent(task, site) {
    const url = chrome.runtime.getURL("agent.html") + (task ? `?task=${encodeURIComponent(task)}&autostart=1` : "");
    const open = () => chrome.tabs.create({ url });
    // The click asks Chrome for what it needs and no more: the one site this
    // task works on. Any other site is asked for when the agent first gets
    // there, and notifications in Settings. A no still opens the agent, which
    // then asks on its own card. Opening the agent with no task asks nothing.
    const origins = site ? S.siteAccess(site) : null;
    if (!origins) { open(); return; }
    chrome.permissions.request({ origins }, () => {
      void chrome.runtime.lastError;
      open();
    });
  }
  $("openAgent").onclick = () => openAgent("");

  // Arriving from Settings or the popup: the connect card is what they came
  // for. Settings' Change names the provider in use, which opens on step 2.
  const params = new URLSearchParams(location.search);
  if (params.get("step") === "connect") {
    // The card itself is looked up, so only a provider on the list opens.
    const named = cards[params.get("provider")];
    $("connect").scrollIntoView({ block: "center" });
    if (named) named.click();
    else setTimeout(() => Object.values(cards)[0].focus(), 50);
  }
})();
