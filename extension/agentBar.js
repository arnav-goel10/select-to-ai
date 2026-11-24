/**
 * Select to AI - the agent's bar on a page it brought to front.
 *
 * When a run is driven from the agent's page in a tab of its own and the
 * agent brings another tab to front to act there, this small bar sits on
 * that page so the user can follow: what the agent is doing now, a status
 * dot, Stop, Back to agent, and Open side panel. The engine (engine.js,
 * syncBar) puts it here and tells it what to show; it lives in a closed
 * shadow root, takes the app's colours from tokens.css, follows the theme
 * setting, and moves off any point the agent's pointer is about to use.
 *
 * It also watches, without reading anything, for the user's own clicks,
 * keys and scrolls on the page: the agent's own pointer and keys are
 * trusted events too, and are told apart by the mark the content script
 * keeps while it acts (window.__selectToAiActingUntil). A user who used the
 * page is left there when the run ends; one who only watched is taken back
 * to the agent's page.
 */
(function () {
  "use strict";
  if (window.__selectToAiBar) return;
  window.__selectToAiBar = true;

  const HOST_ID = "select-to-ai-agent-bar";
  let host = null;
  let shadow = null;
  let parts = null;
  let state = null;
  let edge = "bottom";
  let armed = false;
  let theme = "";
  let notice = 0;
  let aside = false;
  let putBack = null;

  // Icons drawn with DOM calls: a page's rules on markup from strings do not apply.
  const SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    stop: [["rect", { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: "currentColor" }]],
    back: [["path", { d: "M9.5 3.5 5 8l4.5 4.5", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }]],
    panel: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 2, fill: "none", stroke: "currentColor", "stroke-width": 1.4 }], ["path", { d: "M10 3.5v9", stroke: "currentColor", "stroke-width": 1.4 }]],
    close: [["path", { d: "M4.5 4.5l7 7m0-7-7 7", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" }]],
  };
  function icon(shapes) {
    const svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" })) svg.setAttribute(k, String(v));
    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    }
    return svg;
  }

  const STYLE = `
    .bar {
      pointer-events: auto;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      max-width: min(640px, calc(100vw - 32px));
      min-height: 44px;
      padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-xl);
      background: var(--surface);
      color: var(--text);
      box-shadow: var(--shadow-lg);
      font: var(--weight-normal) var(--text-sm)/var(--leading-snug) var(--font-sans);
      -webkit-font-smoothing: antialiased;
      animation: bar-in var(--dur-base) var(--ease-out, cubic-bezier(.2,.8,.2,1)) both;
    }
    :host([data-edge="top"]) .bar { animation-name: bar-in-top; }
    @keyframes bar-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes bar-in-top { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    .logo { width: 18px; height: 18px; border-radius: 5px; flex: none; }
    .dot { position: relative; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--working); }
    .dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: ring 1.6s var(--ease-out, ease-out) infinite; }
    @keyframes ring { from { transform: scale(1); opacity: .55; } to { transform: scale(2.6); opacity: 0; } }
    .bar[data-state="needs"] .dot { background: var(--needs); }
    .bar[data-state="done"] .dot { background: var(--done); }
    .bar[data-state="failed"] .dot { background: var(--failed); }
    .bar[data-state="stopped"] .dot { background: var(--text-subtle); }
    .bar:not([data-state="working"]) .dot::after { animation: none; opacity: 0; }
    .line {
      flex: 1 1 auto; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-weight: var(--weight-medium);
    }
    .bar[data-state="needs"] .line { color: var(--needs); }
    .who { color: var(--text-muted); font-weight: var(--weight-normal); }
    .btn {
      all: unset;
      box-sizing: border-box;
      flex: none;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 32px; padding: 0 var(--space-3);
      border-radius: var(--radius-md);
      font: var(--weight-medium) var(--text-sm)/1 var(--font-sans);
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
      transition: background var(--dur-fast) ease, color var(--dur-fast) ease;
    }
    .btn:hover { background: var(--hover-overlay); }
    .btn:active { background: var(--press-overlay); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .btn svg { flex: none; }
    .stop svg { color: var(--failed); }
    .home { border: 1px solid var(--border-strong); }
    .home:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .icon { width: 32px; padding: 0; color: var(--text-muted); }
    .icon:hover { color: var(--text); }
    .sep { flex: none; width: 1px; height: 20px; background: var(--border); }
    [hidden] { display: none !important; }
    @media (max-width: 560px) {
      .stop .label, .who { display: none; }
      .stop { width: 32px; padding: 0; }
      .sep { display: none; }
    }
    @media (max-width: 380px) {
      .home .label { display: none; }
      .home { width: 32px; padding: 0; }
      .logo { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .bar, .dot::after { animation: none !important; }
      .btn { transition: none; }
    }
  `;

  function scheme() {
    return theme === "light" ? "light" : theme === "dark" ? "dark" : "light dark";
  }

  /**
   * How far the page's own bar pinned to this edge of the window reaches in
   * (a cookie notice, a chat button row), so the agent's bar sits clear of
   * it. Something pinned that covers much of the window is a dialog, not a
   * bar, and is not stepped around.
   */
  function pinned(side) {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (!vw || !vh || !document.elementsFromPoint) return 0;
    let reach = 0;
    for (const fx of [0.08, 0.3, 0.5, 0.7, 0.92]) {
      const hit = document.elementsFromPoint(vw * fx, side === "top" ? 3 : vh - 3).find((n) => n !== host && !(host && host.contains(n)));
      for (let n = hit; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos !== "fixed" && pos !== "sticky") continue;
        const r = n.getBoundingClientRect();
        const r2 = side === "top" ? r.bottom : vh - r.top;
        if (r.height < vh * 0.4 && r2 > reach && r2 < vh * 0.4) reach = r2;
        break;
      }
    }
    return Math.ceil(reach);
  }

  // How far the page's bar reaches is read at most once a second and when
  // the edge changes, not on every step update: each read makes the page
  // work out its style and layout.
  let pinnedAt = 0;
  let pinnedEdge = "";
  let pinnedReach = 0;
  function pinnedNow(fresh) {
    const now = Date.now();
    if (fresh || edge !== pinnedEdge || now - pinnedAt > 1000) {
      pinnedReach = pinned(edge);
      pinnedEdge = edge;
      pinnedAt = now;
    }
    return pinnedReach;
  }

  function hostStyle(fresh) {
    // The page's own styles never reach in (each rule is marked important,
    // which no page rule outranks), and the bar never pushes the page's layout.
    const gap = 16 + pinnedNow(fresh);
    const rules = { all: "initial", "color-scheme": scheme(), position: "fixed", left: "0", right: "0", top: edge === "top" ? `${gap}px` : "auto", bottom: edge === "top" ? "auto" : `${gap}px`, "z-index": "2147483647", display: "flex", "justify-content": "center", padding: "0 16px", "pointer-events": "none", visibility: aside ? "hidden" : "visible", opacity: "1", transform: "none" };
    return Object.entries(rules).map(([k, v]) => `${k}: ${v} !important;`).join(" ");
  }

  function button(cls, shape, label, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn ${cls}`;
    b.appendChild(icon(shape));
    if (label) { const s = document.createElement("span"); s.className = "label"; s.textContent = label; b.appendChild(s); }
    b.title = title || label;
    b.setAttribute("aria-label", title || label);
    return b;
  }

  const tell = (action) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ action }, (r) => { void chrome.runtime.lastError; resolve(r || null); }); } catch (_e) { resolve(null); }
  });

  function build() {
    // A tag of its own: a page's rules for div and the like do not match it.
    host = document.createElement("select-to-ai-agent-bar");
    host.id = HOST_ID;
    host.style.cssText = hostStyle();
    host.dataset.edge = edge;
    shadow = host.attachShadow({ mode: "closed" });
    // Constructed sheets: a page's rules on inline styles do not apply to them.
    const style = new CSSStyleSheet();
    const tokens = new CSSStyleSheet();
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Select to AI agent");
    const logo = document.createElement("img");
    logo.className = "logo";
    logo.alt = "";
    const dot = document.createElement("span");
    dot.className = "dot";
    const line = document.createElement("span");
    line.className = "line";
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = "Agent: ";
    const words = document.createElement("span");
    line.append(who, words);
    const stop = button("stop", ICONS.stop, "Stop", "Stop the agent");
    const sep = document.createElement("span");
    sep.className = "sep";
    const home = button("home", ICONS.back, "Back to agent", "Back to the agent page");
    const panel = button("icon panel", ICONS.panel, "", "Open the side panel");
    const close = button("icon close", ICONS.close, "", "Close");
    stop.addEventListener("click", (e) => { if (e.isTrusted) tell("agentBarStop"); });
    home.addEventListener("click", (e) => { if (e.isTrusted) tell("agentBarHome"); });
    // The side panel opens from this click: the user's gesture goes with the message.
    panel.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      tell("agentBarPanel").then((r) => { if (!r || !r.ok) say("The side panel did not open here. Use the toolbar button."); });
    });
    close.addEventListener("click", (e) => { if (e.isTrusted) tell("agentBarClose"); });
    bar.append(logo, dot, line, stop, sep, home, panel, close);
    style.replaceSync(STYLE);
    shadow.adoptedStyleSheets = [tokens, style];
    shadow.append(bar);
    parts = { tokens, bar, logo, words, stop, sep, home, panel, close, line };
    (document.documentElement || document.body).appendChild(host);
  }

  /** A short message in place of the step text, for a few seconds. */
  function say(text) {
    if (!parts) return;
    notice = Date.now() + 4000;
    parts.words.textContent = text;
    setTimeout(() => { if (Date.now() >= notice) render(); }, 4100);
  }

  function render() {
    if (!state || !state.show) { if (host) host.remove(); host = null; parts = null; return; }
    if (!host || !host.isConnected) build();
    host.style.cssText = hostStyle();
    host.dataset.edge = edge;
    const vars = `:host { ${state.tokens || ""} color-scheme: ${scheme()}; }`;
    if (parts.vars !== vars) { parts.tokens.replaceSync(vars); parts.vars = vars; }
    if (state.logo && parts.logo.src !== state.logo) parts.logo.src = state.logo;
    parts.bar.dataset.state = state.state || "working";
    if (Date.now() >= notice) parts.words.textContent = state.text || "";
    parts.line.title = state.text || "";
    parts.stop.hidden = !!state.ended;
    parts.sep.hidden = !!state.ended;
    parts.panel.hidden = !!state.ended;
    parts.close.hidden = !state.ended;
  }

  function off() {
    state = null;
    armed = false;
    if (host) host.remove();
    host = null;
    parts = null;
  }

  /**
   * Keeps the bar off the points the agent's pointer is about to use: it
   * moves to the other edge of the window, or, if a point is under it there
   * too, steps aside until the gesture is over. Returns what puts it back.
   */
  function keepClear(points) {
    if (!host || !host.isConnected || !parts) return null;
    const under = () => {
      const r = parts.bar.getBoundingClientRect();
      return (points || []).some((p) => p.x >= r.left - 8 && p.x <= r.right + 8 && p.y >= r.top - 8 && p.y <= r.bottom + 8);
    };
    if (!under()) return null;
    edge = edge === "bottom" ? "top" : "bottom";
    host.style.cssText = hostStyle();
    host.dataset.edge = edge;
    if (!under()) return null;
    aside = true;
    host.style.cssText = hostStyle();
    return () => { aside = false; if (host) host.style.cssText = hostStyle(); };
  }

  // The user's own hand on the page. Nothing about what they did is read or sent.
  const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);
  function watch(e) {
    if (!armed || !e.isTrusted) return;
    if ((window.__selectToAiActingUntil || 0) > Date.now()) return;
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    // A shortcut (moving to another tab, copying) is not using the page.
    if (e.type === "keydown" && (MODIFIERS.has(e.key) || e.metaKey || e.ctrlKey)) return;
    armed = false;
    tell("agentBarTouched");
  }
  // A resize is answered once a frame at most, however many events it fires.
  let resizeQueued = false;
  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; if (host && host.isConnected) host.style.cssText = hostStyle(true); });
  }, { passive: true });
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(type, watch, { capture: true, passive: true });
  // Clicking into a frame on the page moves focus to that frame element.
  window.addEventListener("blur", () => {
    if (!armed || (window.__selectToAiActingUntil || 0) > Date.now()) return;
    const active = document.activeElement;
    if (active && active.tagName === "IFRAME") { armed = false; tell("agentBarTouched"); }
  }, { passive: true });

  try {
    chrome.storage.sync.get(["theme"], (items) => { void chrome.runtime.lastError; theme = (items && items.theme) || ""; render(); });
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "sync" && changes.theme) { theme = changes.theme.newValue || ""; render(); } });
  } catch (_e) { /* the extension was reloaded */ }

  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || (m.action !== "agentBar" && m.action !== "agentBarClear") || window !== window.top) return false;
    if (m.off) { off(); sendResponse({ bar: true }); return false; }
    // The agent's pointer is about to press at these points of the window (engine.js, pointerReal).
    if (m.action === "agentBarClear") { if (putBack) putBack(); putBack = m.release ? null : keepClear(m.points); sendResponse({ bar: true }); return false; }
    state = m;
    // Watching starts again each time the engine says the user has not used the page.
    armed = !m.touched;
    render();
    sendResponse({ bar: true });
    return false;
  });
})();
