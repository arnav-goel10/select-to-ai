/**
 * Select to AI - the extension's side of Sign in with ChatGPT.
 *
 * Runs in the service worker. An extension cannot listen on a port, but the
 * sign-in happens in the user's own browser: the authorization page opens in
 * a tab, and when OpenAI sends that tab to the loopback redirect
 * (http://127.0.0.1:<port>/auth/callback?code=...&state=...), the tab's new
 * address is read here, the tab is closed, and the code is exchanged. Nothing
 * answers on that port. The attempt is kept in session storage, so a worker
 * that Chrome stops while the user signs in picks it up again on waking.
 *
 * Tokens are kept in local storage encrypted with an AES-GCM key that never
 * leaves this browser and cannot be exported (the same scheme as the
 * assistant's memory in engine.js). Pages see only the public part of the
 * account: email, whether plan usage is on, and the model list.
 */
(function initChatGPTConnect(root) {
  "use strict";

  const AUTH = root.SELECT_TO_AI_CHATGPT;
  const PENDING = "chatgptPending"; // session: the attempt in progress
  const RESULT = "chatgptSignIn"; // session: how the last attempt went, for the page that started it
  const ACCOUNT = "chatgptAccount"; // local: the public part of the account
  const CREDENTIALS = "chatgptCredentials"; // local: the encrypted token record
  const HOST = "chatgptHostId"; // local: this installation's ext_agent_host_id
  const ATTEMPT_MS = 15 * 60 * 1000;

  // Swappable in tests, so the capture can be checked without OpenAI.
  const deps = {
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    subtle: crypto.subtle,
  };
  const quiet = (p) => Promise.resolve(p).catch(() => undefined);

  // ------------------------------------------------------------ encryption

  function keyDb() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("select-to-ai", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("keys");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  async function cryptoKey() {
    const db = await keyDb();
    const read = () => new Promise((resolve, reject) => { const r = db.transaction("keys").objectStore("keys").get("chatgpt"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    let key = await read();
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await new Promise((resolve, reject) => { const t = db.transaction("keys", "readwrite"); t.objectStore("keys").put(key, "chatgpt"); t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    }
    return key;
  }
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  async function loadCredentials() {
    const saved = (await quiet(chrome.storage.local.get(CREDENTIALS)) || {})[CREDENTIALS];
    if (!saved || !saved.data) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(saved.iv) }, await cryptoKey(), unb64(saved.data));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch (_e) {
      // The key is gone (the browser's site data was cleared): the record cannot be read again.
      return null;
    }
  }
  async function saveCredentials(cred) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(JSON.stringify(cred)));
    await chrome.storage.local.set({ [CREDENTIALS]: { iv: b64(iv), data: b64(data) } });
  }

  // --------------------------------------------------------------- account

  const getAccount = async () => (await quiet(chrome.storage.local.get(ACCOUNT)) || {})[ACCOUNT] || null;
  const setAccount = (account) => chrome.storage.local.set({ [ACCOUNT]: account });

  async function hostId() {
    const saved = (await quiet(chrome.storage.local.get(HOST)) || {})[HOST];
    if (saved) return saved;
    const id = AUTH.newHostId(deps.random);
    await chrome.storage.local.set({ [HOST]: id });
    return id;
  }

  const tokens = AUTH.createTokenSource({
    fetch: (...a) => deps.fetch(...a),
    now: () => deps.now(),
    load: loadCredentials,
    save: saveCredentials,
    // The refresh token is unusable: the tokens go, the registration and the ID token stay for the next sign-in.
    ended: async (cred) => {
      await saveCredentials({ ...cred, access_token: "", refresh_token: "", expires_at: 0 });
      const account = await getAccount();
      if (account) await setAccount({ ...account, signedIn: false });
    },
  });

  // --------------------------------------------------------------- sign-in

  async function report(id, state, message, extra) {
    await quiet(chrome.storage.session.set({ [RESULT]: { id, state, message: message || "", at: deps.now(), ...(extra || {}) } }));
  }

  /**
   * Opens ChatGPT's sign-in in a new tab.
   * @param o.fresh    true to register a new account instead of signing in to the saved one
   * @param o.consent  true to ask again for plan usage after it was declined
   */
  async function begin(o) {
    const opts = o || {};
    const account = await getAccount();
    const cred = await loadCredentials();
    const registration = !opts.fresh && account && account.clientId
      // After a sign-out the ID token is gone, so no id_token_hint is sent.
      ? { clientId: account.clientId, sub: account.sub, email: account.email, idToken: (cred && cred.id_token) || "" }
      : null;
    const { url, pending } = await AUTH.startAttempt({ hostId: await hostId(), registration, consent: !!opts.consent, random: deps.random, subtle: deps.subtle, now: deps.now() });
    const id = AUTH.b64url(deps.random(8));
    const tab = await chrome.tabs.create({ url, active: true, ...(opts.windowId ? { windowId: opts.windowId } : {}) });
    await chrome.storage.session.set({ [PENDING]: { ...pending, id, tabId: tab.id, use: opts.use !== false } });
    await report(id, "pending", "Waiting for you to sign in to ChatGPT in the tab that opened.");
    return { id };
  }

  async function takePending() {
    const p = (await quiet(chrome.storage.session.get(PENDING)) || {})[PENDING];
    if (!p) return null;
    await chrome.storage.session.remove(PENDING);
    return p;
  }

  /** Every tab address change while an attempt is open: the redirect ends it. */
  async function onTabUrl(tabId, url) {
    const p = (await quiet(chrome.storage.session.get(PENDING)) || {})[PENDING];
    if (!p || !AUTH.isCallback(url, p)) return false;
    // Taken once: a second report of the same address finds nothing pending.
    if (!(await takePending())) return false;
    await quiet(chrome.tabs.remove(tabId));
    await complete(p, url);
    return true;
  }

  async function complete(p, url) {
    try {
      if (deps.now() - (p.startedAt || 0) > ATTEMPT_MS) throw new AUTH.AuthError("state", "That sign-in took too long and has expired. Try again.");
      const cb = AUTH.readCallback(url, p);
      await report(p.id, "pending", "Finishing sign-in…");
      const got = await AUTH.exchangeCode(deps, p, cb);
      const claims = await AUTH.verifyIdToken(deps, got.id_token, { clientId: cb.clientId, nonce: p.nonce });
      if (p.sub && claims.sub !== p.sub) throw new AUTH.AuthError("account", "That is a different ChatGPT account from the saved one. Choose \"Use a different account\" to switch.");
      const cred = AUTH.credentialFrom(got, claims, cb.clientId, await hostId(), deps.now());
      // A granted scope list, not the redirect's, decides whether plan usage is on.
      const plan = AUTH.planEnabled(cred.scopes);
      await saveCredentials(cred);
      const before = await getAccount();
      let models = [];
      if (plan) models = await quiet(AUTH.listModels(deps, cred.access_token)) || [];
      const account = {
        email: cred.email, sub: cred.subject, clientId: cb.clientId, planEnabled: plan, signedIn: true, models,
        welcomed: !!(before && before.welcomed && before.sub === cred.subject),
      };
      await setAccount(account);
      if (plan && p.use) {
        const sync = await quiet(chrome.storage.sync.get(["agentModel", "agentActiveProvider"])) || {};
        const slugs = models.map((m) => m.slug);
        const keep = sync.agentActiveProvider === "chatgpt" && slugs.includes(sync.agentModel);
        await chrome.storage.sync.set({ agentActiveProvider: "chatgpt", agentModel: keep ? sync.agentModel : AUTH.bestModel(models) || root.SELECT_TO_AI_DEFAULTS.PROVIDER_FALLBACK_MODELS.chatgpt.pro, showAgent: true, ...(keep ? {} : { agentHelperModel: "" }) });
        await chrome.storage.local.set({ onboardingComplete: true, agentProviderPause: null });
      }
      await report(p.id, plan ? "ok" : "no_plan", plan ? `Signed in as ${cred.email || "your ChatGPT account"}.` : "Signed in, but ChatGPT plan use was not allowed. Turn it on to let the agent use your plan, or connect another provider.");
    } catch (e) {
      await report(p.id, e && e.kind === "declined" ? "declined" : "error", (e && e.message) || "ChatGPT sign-in failed.");
    }
  }

  async function onTabClosed(tabId) {
    const p = (await quiet(chrome.storage.session.get(PENDING)) || {})[PENDING];
    if (!p || p.tabId !== tabId) return;
    await takePending();
    await report(p.id, "closed", "The sign-in tab was closed before it finished.");
  }

  // One address at a time: Chrome reports the same address more than once, and the attempt is taken only once.
  let queue = Promise.resolve();
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    const url = info.url || (tab && tab.url) || "";
    if (url.startsWith(`http://${AUTH.CALLBACK_HOST}:`)) queue = queue.then(() => quiet(onTabUrl(tabId, url)));
  });
  chrome.tabs.onRemoved.addListener((tabId) => { quiet(onTabClosed(tabId)); });

  // -------------------------------------------------------------- sign-out

  async function signOut() {
    const cred = await loadCredentials();
    const revoked = cred ? await AUTH.revoke(deps, cred) : true;
    await chrome.storage.local.remove(CREDENTIALS);
    const account = await getAccount();
    // The registration (client ID and account) and the host ID stay for a later sign-in.
    if (account) await setAccount({ ...account, signedIn: false });
    return { revoked };
  }

  async function refreshModels() {
    const models = await AUTH.listModels(deps, await tokens.accessToken(false));
    const account = await getAccount();
    if (account) await setAccount({ ...account, models });
    return models;
  }

  // -------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== "string" || !message.action.startsWith("chatgpt")) return false;
    if (!root.SELECT_TO_AI_SECURITY.isTrustedExtensionSender(sender, chrome.runtime.id)) return false;
    const answer = (p) => p.then((r) => sendResponse({ ok: true, ...(r || {}) }), (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    if (message.action === "chatgptSignIn" && !(root.SELECT_TO_AI_DEFAULTS && root.SELECT_TO_AI_DEFAULTS.FEATURES.chatgptSignIn)) {
      sendResponse({ ok: false, error: "Sign in with ChatGPT is not available in this version." });
      return false;
    }
    if (message.action === "chatgptSignIn") { answer(begin({ fresh: !!message.fresh, consent: !!message.consent, use: message.use !== false, windowId: sender.tab && sender.tab.windowId })); return true; }
    if (message.action === "chatgptSignOut") { answer(signOut()); return true; }
    if (message.action === "chatgptModels") { answer(refreshModels().then((models) => ({ models }))); return true; }
    return false;
  });

  root.SELECT_TO_AI_CHATGPT_CONNECT = Object.freeze({
    deps, begin, onTabUrl, signOut, refreshModels,
    accessToken: (force) => tokens.accessToken(force),
    KEYS: Object.freeze({ PENDING, RESULT, ACCOUNT, CREDENTIALS, HOST }),
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
