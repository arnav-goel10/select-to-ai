/**
 * Select to AI - the Sign in with ChatGPT controls shared by the settings
 * page and the welcome page.
 *
 * Follows OpenAI's UI guidelines for ChatGPT plan usage
 * (developers.openai.com/siwc/ui-ux-guidelines): the approved "Continue with
 * ChatGPT" button with the ChatGPT logo, a one-time "You're using your
 * ChatGPT plan" confirmation after the first sign-in, "Using ChatGPT plan"
 * with a "Manage usage" link where the plan is in use, and "Manage usage" as
 * the first action when a usage limit is reached. The sign-in itself runs in
 * the service worker (chatgptConnect.js); this file only asks for it and
 * shows how it went.
 */
(function initChatGPTUi(root) {
  "use strict";

  const AUTH = root.SELECT_TO_AI_CHATGPT;
  const USAGE_URL = AUTH.USAGE_URL;
  const FINAL = new Set(["ok", "no_plan", "declined", "error", "closed"]);

  const STYLE = `
    .chatgpt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 18px; border-radius: 999px; border: 1px solid #000; background: #000; color: #fff; font: 500 14px/18px var(--font-sans, system-ui, sans-serif); letter-spacing: 0; cursor: pointer; }
    .chatgpt-btn img { width: 18px; height: 18px; display: block; flex: none; }
    .chatgpt-btn .on-dark { display: none; }
    .chatgpt-btn:hover { background: #1f1f1f; }
    .chatgpt-btn:disabled { opacity: .6; cursor: default; }
    .chatgpt-btn.block { width: 100%; }
    [data-theme="dark"] .chatgpt-btn { background: #fff; color: #000; border-color: #fff; }
    [data-theme="dark"] .chatgpt-btn:hover { background: #f2f2f2; }
    [data-theme="dark"] .chatgpt-btn .on-light { display: none; }
    [data-theme="dark"] .chatgpt-btn .on-dark { display: block; }
    .chatgpt-plan { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-sm, 13px); color: var(--text-muted, #666); }
    .chatgpt-plan a { color: inherit; text-decoration: underline; }
    .chatgpt-modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: grid; place-items: center; z-index: 1000; padding: 16px; }
    .chatgpt-modal[hidden] { display: none; }
    .chatgpt-modal .sheet { background: var(--bg, #fff); color: var(--text, #0d0d0d); border-radius: 20px; max-width: 400px; width: 100%; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
    .chatgpt-modal h2 { display: flex; align-items: center; gap: 10px; font-size: 18px; margin: 0 0 8px; font-weight: 600; }
    .chatgpt-modal h2 img { width: 22px; height: 22px; }
    .chatgpt-modal p { margin: 0 0 18px; color: var(--text-muted, #5d5d5d); font-size: 14px; line-height: 1.5; }
    .chatgpt-modal .row { display: flex; justify-content: flex-end; gap: 8px; }
  `;
  function ensureStyle() {
    if (document.getElementById("chatgpt-ui-style")) return;
    const s = document.createElement("style");
    s.id = "chatgpt-ui-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function logo(dark) {
    const img = document.createElement("img");
    img.src = dark ? "chatgpt-logo-black.svg" : "chatgpt-logo-white.svg";
    img.alt = "";
    img.className = dark ? "on-dark" : "on-light";
    return img;
  }

  /** The approved sign-in button: the ChatGPT logo and "Continue with ChatGPT". */
  function button(opts) {
    ensureStyle();
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chatgpt-btn${opts && opts.block ? " block" : ""}`;
    const label = document.createElement("span");
    label.textContent = "Continue with ChatGPT";
    b.append(logo(false), logo(true), label);
    return b;
  }

  /** "Using ChatGPT plan" with a "Manage usage" link, for wherever the plan is in use. */
  function usageLine() {
    ensureStyle();
    const span = document.createElement("span");
    span.className = "chatgpt-plan";
    span.append("Using ChatGPT plan · ");
    const a = document.createElement("a");
    a.href = USAGE_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Manage usage";
    span.appendChild(a);
    return span;
  }

  const account = () => new Promise((resolve) => chrome.storage.local.get("chatgptAccount", (r) => resolve((r && r.chatgptAccount) || null)));

  /**
   * Starts a sign-in and resolves when it ends: {state, message}, where state
   * is "ok", "no_plan", "declined", "error" or "closed". Call it straight
   * from a click: Chrome asks for access to auth.openai.com (for OpenAI's
   * signing keys) only on a user's gesture.
   * @param o {fresh, consent, use} see chatgptConnect.js begin()
   * @param onStatus called with each progress message
   */
  function signIn(o, onStatus) {
    const opts = o || {};
    const say = onStatus || (() => {});
    return new Promise((resolve) => {
      chrome.permissions.request({ origins: ["https://auth.openai.com/*"] }, (granted) => {
        if (chrome.runtime.lastError || !granted) {
          resolve({ state: "error", message: "Chrome did not allow access to auth.openai.com, which the sign-in needs to check your account." });
          return;
        }
        let id = "";
        let early = null;
        const listen = (changes, area) => {
          if (area !== "session" || !changes.chatgptSignIn) return;
          const r = changes.chatgptSignIn.newValue;
          if (!r) return;
          if (!id) { early = r; return; }
          if (r.id !== id) return;
          if (FINAL.has(r.state)) { chrome.storage.onChanged.removeListener(listen); resolve(r); } else say(r.message);
        };
        chrome.storage.onChanged.addListener(listen);
        say("Opening ChatGPT sign-in…");
        chrome.runtime.sendMessage({ action: "chatgptSignIn", fresh: !!opts.fresh, consent: !!opts.consent, use: opts.use !== false }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) {
            chrome.storage.onChanged.removeListener(listen);
            resolve({ state: "error", message: (r && r.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "The sign-in could not start." });
            return;
          }
          id = r.id;
          say("Sign in to ChatGPT in the tab that opened, then come back here.");
          if (early && early.id === id && FINAL.has(early.state)) { chrome.storage.onChanged.removeListener(listen); resolve(early); }
        });
      });
    });
  }

  function signOut() {
    return new Promise((resolve) => chrome.runtime.sendMessage({ action: "chatgptSignOut" }, (r) => resolve(r || { ok: false })));
  }

  function refreshModels() {
    return new Promise((resolve) => chrome.runtime.sendMessage({ action: "chatgptModels" }, (r) => resolve(r || { ok: false })));
  }

  /** The one-time confirmation after the first sign-in with plan usage on. */
  async function welcomeOnce() {
    const a = await account();
    if (!a || !a.signedIn || !a.planEnabled || a.welcomed) return;
    ensureStyle();
    const wrap = document.createElement("div");
    wrap.className = "chatgpt-modal";
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "chatgptWelcomeTitle");
    const h = document.createElement("h2");
    h.id = "chatgptWelcomeTitle";
    const mark = document.createElement("img");
    mark.src = document.documentElement.getAttribute("data-theme") === "dark" ? "chatgpt-logo-white.svg" : "chatgpt-logo-black.svg";
    mark.alt = "";
    h.append(mark, "You're using your ChatGPT plan");
    const p = document.createElement("p");
    p.append("Eligible usage in this app uses your ChatGPT plan. Manage usage in your ");
    const link = document.createElement("a");
    link.href = USAGE_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "ChatGPT settings";
    p.append(link, ".");
    const row = document.createElement("div");
    row.className = "row";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn btn-primary";
    ok.textContent = "Got it";
    row.appendChild(ok);
    sheet.append(h, p, row);
    wrap.appendChild(sheet);
    document.body.appendChild(wrap);
    ok.focus();
    ok.onclick = () => {
      wrap.remove();
      chrome.storage.local.set({ chatgptAccount: { ...a, welcomed: true } });
    };
  }

  root.SELECT_TO_AI_CHATGPT_UI = Object.freeze({ USAGE_URL, button, usageLine, account, signIn, signOut, refreshModels, welcomeOnce });
})(typeof globalThis !== "undefined" ? globalThis : this);
