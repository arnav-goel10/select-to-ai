/**
 * Select to AI command palette (the quick box).
 *
 * An in-page overlay opened by a keyboard shortcut, so the agent is one
 * keystroke away on any tab without touching the address bar or opening a
 * new one. What is typed starts the agent, as it does in the address bar.
 * Chrome does not let an extension read the omnibox without a
 * keyword, and it refuses to point a search provider at an extension page,
 * so this is the only genuinely prefix-free entry point available.
 *
 * Injected on demand by the service worker (scripting + activeTab), never as
 * a persistent content script, so it costs nothing on pages where it is not
 * used and needs no broad host permissions.
 *
 * Everything lives in a closed shadow root: page CSS cannot reach in and
 * break it, and the palette cannot leak styles onto the page.
 */
(function initCommandPalette() {
  "use strict";

  const HOST_ID = "select-to-ai-command-palette";

  // Toggle: a second press of the shortcut closes it.
  //
  // This has to run the instance's own teardown, not just detach the node.
  // Removing the host left its document-level keydown handler attached, so a
  // dead palette kept intercepting keys (including Tab, which it would
  // swallow from the page) and every open/close cycle leaked another
  // runtime.onMessage listener holding detached DOM alive.
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    if (typeof existing.__teardown === "function") existing.__teardown();
    else existing.remove();
    return;
  }

  // Read the selection before anything is inserted: this extension exists to
  // act on selected text, so a highlight plus the shortcut should carry that
  // text through instead of making the user paste it again.
  let selectedText = "";
  try {
    selectedText = String(window.getSelection() || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  } catch (_error) { selectedText = ""; }

  // Design tokens, copied from extension/tokens.css (light value, dark value).
  //
  // They are inlined rather than loaded from tokens.css at run time:
  // - tokens.css is not a web accessible resource, and exposing it would let
  //   any page probe for the extension;
  // - a fetch or <link> is asynchronous, so the box would first paint
  //   unstyled, and a page's CSP can block the request outright;
  // - tokens.css writes colours with light-dark(), which follows
  //   color-scheme, while the box must follow the stored theme setting.
  // Keep these values in step with tokens.css when the palette changes.
  const TOKENS = {
    "--surface": ["#ffffff", "#1b1c1e"],
    "--surface-2": ["#f3f2f0", "#242528"],
    "--surface-sunken": ["#f4f3f1", "#141517"],
    "--border": ["#e4e3df", "#2a2b2f"],
    "--border-strong": ["#d2d1cc", "#3a3b40"],
    "--scrim": ["rgb(20 20 24 / 0.32)", "rgb(0 0 0 / 0.55)"],
    "--text": ["#17181b", "#eaebee"],
    "--text-muted": ["#595a61", "#acaeb4"],
    "--text-subtle": ["#6d6e75", "#90929a"],
    "--accent": ["#5051cf", "#8f9bfb"],
    "--accent-soft": ["rgb(80 81 207 / 0.08)", "rgb(143 155 251 / 0.12)"],
    "--accent-ring": ["rgb(80 81 207 / 0.28)", "rgb(143 155 251 / 0.38)"],
    "--press-overlay": ["rgb(23 24 27 / 0.08)", "rgb(255 255 255 / 0.08)"],
    "--shadow-color": ["rgb(20 20 30 / 0.06)", "rgb(0 0 0 / 0.4)"],
    "--shadow-color-2": ["rgb(20 20 30 / 0.08)", "rgb(0 0 0 / 0.5)"],
    "--logo-edge": ["rgb(0 0 0 / 0.10)", "rgb(255 255 255 / 0.14)"],
  };
  const tokenBlock = (index) =>
    Object.entries(TOKENS).map(([name, values]) => `${name}: ${values[index]};`).join(" ");
  const LIGHT = tokenBlock(0);
  const DARK = tokenBlock(1);

  const HOST_RULES = [
    "all: initial !important",
    "display: block !important",
    "position: fixed !important",
    "inset: 0 !important",
    "z-index: 2147483647 !important",
    "visibility: visible !important",
    "opacity: 1 !important",
    "pointer-events: auto !important",
  ].join("; ");

  const CSS = `
    :host { ${HOST_RULES}; }

    /* The root resets every inherited property, so nothing the page sets on
       the host (colour, font, spacing, text transforms) reaches the box. */
    .root {
      all: initial;
      display: block;
      ${LIGHT}
      color-scheme: light;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --shadow-lg: 0 2px 4px var(--shadow-color), 0 12px 32px var(--shadow-color-2), 0 24px 64px var(--shadow-color);
      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.55;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    @media (prefers-color-scheme: dark) {
      .root:not([data-theme="light"]) { ${DARK} color-scheme: dark; }
    }
    .root[data-theme="dark"] { ${DARK} color-scheme: dark; }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }

    .scrim {
      position: fixed; inset: 0;
      background: var(--scrim);
      display: flex; align-items: flex-start; justify-content: center;
      padding: 14vh 16px 16px;
      opacity: 0;
    }
    .card {
      width: min(640px, 100%);
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: var(--shadow-lg);
      overflow: hidden;
      opacity: 0;
    }

    /* Appear: fade and a 6 px rise, 200 ms, ease-out. Leave: fade, 120 ms. */
    .root[data-state="open"] .scrim { animation: fade-in 200ms var(--ease-out) both; }
    .root[data-state="open"] .card { animation: rise-in 200ms var(--ease-out) both; }
    .root[data-state="leaving"] .scrim,
    .root[data-state="leaving"] .card { opacity: 1; animation: fade-out 120ms ease-in both; }
    .root[data-state="leaving"] { pointer-events: none; }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes fade-out { from { opacity: 1; } to { opacity: 0; } }

    .row { display: flex; align-items: center; gap: 12px; padding: 16px; }

    /* The extension icon is already a finished rounded-square mark, so it
       replaces the plate rather than sitting on one. Pages with a strict
       img-src CSP can block the load, so the lettermark stays underneath
       as a fallback and only hides once the image actually decodes. */
    .mark {
      width: 24px; height: 24px; flex: none; border-radius: 6px;
      background: #17181b;
      display: grid; place-items: center;
      color: #ffffff; font-size: 12px; font-weight: 650; line-height: 1;
      box-shadow: inset 0 0 0 1px var(--logo-edge);
      overflow: hidden;
    }
    .mark img {
      width: 100%; height: 100%; display: none;
      object-fit: cover; border-radius: inherit;
    }
    .mark.has-logo { background: none; }
    .mark.has-logo img { display: block; }
    .mark.has-logo .mark-letter { display: none; }

    input {
      flex: 1; min-width: 0; height: 24px;
      border: 0; outline: 0; background: transparent;
      font-family: var(--font-sans); font-size: 16px; line-height: 24px;
      letter-spacing: -0.01em; color: var(--text);
      /* Follows the text colour, so the cursor is visible in light and dark. */
      caret-color: currentColor;
    }
    input::placeholder { color: var(--text-subtle); opacity: 1; }
    ::selection { background: var(--accent-ring); color: var(--text); }

    .context {
      display: flex; align-items: center; gap: 8px;
      padding: 0 16px 12px 52px;
      font-size: 13px; line-height: 20px; color: var(--text-muted);
    }
    .ctx-tag {
      flex: none; height: 20px; padding: 0 8px;
      display: inline-flex; align-items: center;
      font-size: 12px; font-weight: 500; line-height: 1;
      color: var(--text-muted); background: var(--surface-2);
      border: 1px solid var(--border); border-radius: 999px;
    }
    .ctx-text {
      flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; color: var(--text-muted);
    }
    .ctx-drop {
      flex: none; height: 24px; padding: 0 8px;
      /* The label lines up with the footer text; only the hover plate overhangs. */
      margin-right: -8px;
      font-family: var(--font-sans); font-size: 12px; font-weight: 500; line-height: 1;
      color: var(--accent); background: transparent;
      border: 0; border-radius: 8px; cursor: pointer;
      transition: background-color 140ms var(--ease-out);
    }
    .ctx-drop:hover { background: var(--accent-soft); }
    .ctx-drop:active { background: var(--press-overlay); }
    .ctx-drop:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .foot {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: 8px 16px;
      border-top: 1px solid var(--border);
      background: var(--surface-sunken);
      font-size: 12px; line-height: 20px; color: var(--text-muted);
    }
    .hint { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .hint[data-ready="false"] { color: var(--text-subtle); }
    kbd {
      font-family: var(--font-sans); font-size: 11px; font-weight: 500; line-height: 1;
      min-width: 20px; height: 20px; padding: 0 6px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--text-muted); background: var(--surface);
      border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 5px;
      transition: color 140ms var(--ease-out), border-color 140ms var(--ease-out);
    }
    /* The accent marks the one thing that can be acted on: Enter, once there
       is something to send. */
    .hint[data-ready="true"] { color: var(--text); }
    .hint[data-ready="true"] kbd { color: var(--accent); border-color: var(--accent); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-delay: 0s !important;
        transition-duration: 0.01ms !important;
      }
    }
  `;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // The host rules are written twice: inline, and as :host in the shadow
  // stylesheet. An important :host rule outranks every page rule, including
  // "* { ... !important }", "div { display: none !important }" and an inline
  // style the page might write, because important declarations from inside a
  // shadow tree win over those from outside it. The inline copy holds until
  // the stylesheet applies. Fixing the host to the viewport with the maximum
  // z-index keeps the palette above any stacking context the page sets up.
  host.style.cssText = HOST_RULES;
  const shadow = host.attachShadow({ mode: "closed" });

  // A constructed stylesheet is not subject to a page's style-src CSP the way
  // an inline <style> element can be. The <style> fallback covers browsers
  // without adoptedStyleSheets.
  let styled = false;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    styled = true;
  } catch (_error) { styled = false; }

  shadow.innerHTML = `
    ${styled ? "" : `<style>${CSS}</style>`}
    <div class="root" data-theme="system">
      <div class="scrim" part="scrim">
        <div class="card" role="dialog" aria-modal="true" aria-label="Select to AI quick box">
          <div class="row">
            <div class="mark" aria-hidden="true"><span class="mark-letter">S</span><img alt="" /></div>
            <input type="text" autocomplete="off" spellcheck="false"
                   aria-label="Request for the agent"
                   placeholder="Ask a question, or tell the agent what to do" />
          </div>
          <div class="context" hidden>
            <span class="ctx-tag">Selection</span>
            <span class="ctx-text"></span>
            <button class="ctx-drop" type="button">Remove</button>
          </div>
          <div class="foot">
            <span class="hint" data-ready="false"><kbd>Enter</kbd><span>ask the agent</span></span>
            <span class="hint"><kbd>Esc</kbd><span>close</span></span>
          </div>
        </div>
      </div>
    </div>
  `;

  const root = shadow.querySelector(".root");
  const scrim = shadow.querySelector(".scrim");
  const context = shadow.querySelector(".context");
  const contextText = shadow.querySelector(".ctx-text");
  const input = shadow.querySelector("input");
  const enterHint = shadow.querySelector(".hint[data-ready]");

  const mark = shadow.querySelector(".mark");
  const markImg = shadow.querySelector(".mark img");
  try {
    const logoUrl = chrome.runtime.getURL("icon128.png");
    if (logoUrl) {
      markImg.addEventListener("load", () => mark.classList.add("has-logo"));
      markImg.src = logoUrl;
    }
  } catch (_error) {
    // No extension context (or the load is blocked): the lettermark stands.
  }

  // The box stays invisible until the theme is known, so it never flashes in
  // the wrong theme. The setting is chrome.storage.sync "theme": "light",
  // "dark", or absent for System, which follows prefers-color-scheme.
  let shown = false;
  let closed = false;
  function show(theme) {
    if (shown || closed) return;
    shown = true;
    root.dataset.theme = theme === "light" || theme === "dark" ? theme : "system";
    root.dataset.state = "open";
  }
  try {
    chrome.storage.sync.get("theme", (items) => show(items && items.theme));
  } catch (_error) { show("system"); }
  // Storage that never answers must not leave the box invisible.
  setTimeout(() => show("system"), 300);

  const reducedMotion = () => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_e) { return false; }
  };

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("focusin", keepFocus, true);
    // The id goes at once, so the page and a second shortcut press both see
    // the box as closed while it fades out.
    host.removeAttribute("id");
    if (!shown || reducedMotion()) { host.remove(); return; }
    root.dataset.state = "leaving";
    setTimeout(() => host.remove(), 120);
  }

  function refreshHint() {
    enterHint.dataset.ready = input.value.trim() ? "true" : "false";
  }

  // What is typed goes to the agent, with any selected text, in its own
  // page; the agent decides whether to answer, open a site or act.
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    try {
      chrome.runtime.sendMessage({
        type: "SELECT_TO_AI_PALETTE_SUBMIT",
        text,
        selection: selectedText || "",
      });
    } catch (_error) { /* worker asleep; closing is still correct */ }
    close();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  // The toggle path needs a way to run this instance's teardown.
  host.__teardown = close;

  input.addEventListener("input", refreshHint);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  // Clicking the backdrop dismisses; clicking inside the card must not.
  scrim.addEventListener("mousedown", (event) => {
    if (event.target === scrim) close();
  });
  document.addEventListener("keydown", onKeydown, true);

  // A modal keeps focus: pages that autofocus their own search box (on load,
  // on a timer, on keydown) would otherwise take the cursor away mid-typing.
  function keepFocus(event) {
    if (event.target !== host && host.isConnected) input.focus({ preventScroll: true });
  }
  document.addEventListener("focusin", keepFocus, true);

  if (selectedText) {
    contextText.textContent = selectedText;
    context.hidden = false;
    input.placeholder = "What should I do with this?";
    shadow.querySelector(".ctx-drop").addEventListener("click", () => {
      selectedText = "";
      context.hidden = true;
      input.placeholder = "Ask a question, or tell the agent what to do";
      input.focus();
    });
  }

  document.documentElement.appendChild(host);
  // Focus after paint so the entrance animation does not swallow the caret.
  requestAnimationFrame(() => {
    try { window.focus(); } catch (_e) {}
    input.focus({ preventScroll: true });
  });
})();
