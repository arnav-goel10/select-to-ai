/**
 * Select to AI - the agent page.
 *
 * A view of the run the service worker carries out (engine.js): it sends
 * what the user types and draws the run from the entries the engine sends.
 *
 * The run reads as a story: the request, the steps as a quiet timeline, a
 * card for anything that needs the user, then the answer as a document and
 * what the run offers to keep. While the run works, the top bar holds a live
 * header with the current goal, the site, the time worked and Stop.
 */

(function () {
  "use strict";

  const DEFAULTS = SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS;

  // True while the engine's run is under way; set by engineControls().
  let isRunning = false;
  // What a run did, as facts: each action with what it acted on and what
  // happened. The benchmark harness (tests/bench) judges runs from this.
  globalThis.__selectToAiTrace = () => engineTrace;

  // Token and cost totals of the run on screen, from the engine's trace.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUSD = 0.0;
  const costIsEstimated = false;

  function updateCostDashboard() {
    const costBadge = document.getElementById("costDashboardBadge");
    if (!costBadge) return;
    // Free models cost nothing, and nothing is shown for them.
    costBadge.hidden = !(totalCostUSD > 0);
    costBadge.textContent = `${costIsEstimated ? "est. " : ""}${totalCostUSD < 0.005 ? "<$0.01" : `$${totalCostUSD.toFixed(2)}`}`;
    costBadge.title =
      `Exact: $${totalCostUSD.toFixed(6)} · tokens in: ${totalPromptTokens}, out: ${totalCompletionTokens}.` +
      (costIsEstimated
        ? " Includes estimated usage (the provider did not report token counts for every call)."
        : " Based on provider-reported token usage.");
  }

  // Configuration cache
  let config = {
    agentActiveProvider: DEFAULTS.activeProvider,
    agentOpenRouterKey: "",
    agentAnthropicKey: "",
    agentOpenAIKey: "",
    agentDeepSeekKey: "",
    agentGeminiKey: "",
    agentCustomKey: "",
    agentMistralKey: "",
    agentGroqKey: "",
    agentTogetherKey: "",
    agentXaiKey: "",
    agentOpencodeKey: "",
    agentCerebrasKey: "",
    agentCustomUrl: DEFAULTS.customUrl,
    agentModel: DEFAULTS.model,
  };

  // DOM Elements
  const taskInput = document.getElementById("taskInput");
  const actionBtn = document.getElementById("actionBtn");
  const chatViewport = document.getElementById("chatViewport");
  const chatContainer = document.getElementById("chatContainer");
  const welcomeScreen = document.getElementById("welcomeScreen");
  const composer = document.getElementById("composer");
  const composerHint = document.getElementById("composerHint");
  const steerPending = document.getElementById("steerPending");
  const liveHeader = document.getElementById("liveHeader");
  const liveGoal = document.getElementById("liveGoal");
  const liveSite = document.getElementById("liveSite");
  const liveHost = document.getElementById("liveHost");
  const liveFavicon = document.getElementById("liveFavicon");
  const liveTime = document.getElementById("liveTime");
  const liveStopBtn = document.getElementById("liveStopBtn");
  const topbarTitle = document.getElementById("topbarTitle");

  const credentialsWarning = document.getElementById("credentialsWarning");
  const openKeySettings = document.getElementById("openKeySettings");
  if (openKeySettings) {
    // Straight to the one-click setup, not a settings form.
    openKeySettings.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?step=connect") });
    });
  }
  const sidebar = document.getElementById("sidebar");
  const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  const sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");
  const newTaskBtn = document.getElementById("newTaskBtn");
  const recentSessionsList = document.getElementById("recentSessionsList");

  // ---------------------------------------------------------------- icons
  // Static drawings only; nothing from a page or a model is ever drawn here.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_PATHS = {
    pointer: '<path d="m9 9 5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/>',
    hover: '<path d="M12.6 12.6 19 19"/><path d="M3.7 3a.5.5 0 0 0-.7.7l6.5 16a.5.5 0 0 0 .9-.1l1.6-6.1a2 2 0 0 1 1.4-1.5l6.1-1.6a.5.5 0 0 0 .1-.9z"/>',
    move: '<path d="M12 2v20M2 12h20M5 9l-3 3 3 3M19 9l3 3-3 3M9 5l3-3 3 3M9 19l3 3 3-3"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    idcard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16a3 3 0 0 1 5 0M14 10h4M14 14h3"/>',
    bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
    scroll: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    tabs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    human: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="m16 11 2 2 4-4"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    flag: '<path d="M4 22V4a1 1 0 0 1 1-1h11l-2 4 2 4H5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    thumbUp: '<path d="M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.5 21H7V10l4-8a3 3 0 0 1 4 3.9z"/>',
    thumbDown: '<path d="M17 14V3M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.5 3H17v11l-4 8a3 3 0 0 1-4-3.9z"/>',
    sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
    external: '<path d="M14 3h7v7M21 3l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    split: '<path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6"/><path d="M6 21V12"/><path d="m15 18 3 3 3-3"/><path d="m3 18 3 3 3-3"/>',
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", name === "play" || name === "stop" ? "currentColor" : "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.info;
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function dotEl(cls) {
    return el("span", `dot${cls ? ` ${cls}` : ""}`);
  }

  // The icon for each kind of action the model can take.
  const ACTION_ICON = {
    click: "pointer", click_at: "pointer", hover: "hover", drag: "move", fill: "pencil", fill_details: "idcard",
    recall: "bookmark", remember: "bookmark", press: "keyboard", scroll: "scroll", navigate: "globe", back: "back",
    tabs: "tabs", wait: "clock", look: "eye", read: "doc", find: "search", ask_user: "message", done: "check", delegate: "split",
  };
  const ACTION_VERB = {
    click: "Click", click_at: "Click a point on the page", hover: "Point at", drag: "Drag", fill: "Fill in", fill_details: "Fill in your details",
    recall: "Look up your details", remember: "Remember", press: "Press", scroll: "Scroll", navigate: "Open", back: "Go back",
    tabs: "Switch tabs", wait: "Wait for the page", look: "Look at the screen", read: "Read further", find: "Search the page", ask_user: "Ask you", done: "Answer",
    delegate: "Hand out sub-tasks",
  };

  /** "click [4] "Search"" as plain words: Click "Search". */
  function plainAction(text) {
    const kind = String(text || "").split(" ")[0];
    const verb = ACTION_VERB[kind] || "Act on the page";
    if (kind === "navigate") { const host = hostOf((String(text).match(/https?:\/\/\S+/) || [])[0]); return host ? `Open ${host}` : verb; }
    if (kind === "press") { const key = String(text).split(" ").slice(-1)[0]; return key && key !== "press" ? `Press ${key}` : verb; }
    const quoted = (String(text).match(/"([^"]{1,60})"/) || [])[1];
    return quoted && /^(click|hover|drag|fill|find)$/.test(kind) ? `${verb} "${quoted}"` : verb;
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, "") : "";
    } catch (_e) { return ""; }
  }

  // 4.0 has no favicon permission, so _favicon URLs fail to load.
  function faviconFor(url) {
    const grants = self.SELECT_TO_AI_GRANTS;
    return grants ? grants.faviconFor(url) : "";
  }

  function clockOf(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  }

  function durationWords(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  }

  // Dynamic references into the run on screen.
  let activeLogsWrapper = null;
  let activeBubbleAnswer = null;
  let activeStreamPanel = null;
  let activeRunDetails = null;
  let activeRun = null;

  // Initialize Settings
  loadSettings();

  // Event Binds
  actionBtn.addEventListener("click", () => {
    if (engineBusy()) enginePost({ type: "stop", text: "Stopped." });
    else startAgent();
  });
  if (liveStopBtn) liveStopBtn.addEventListener("click", () => enginePost({ type: "stop", text: "Stopped." }));

  // Auto-grow textarea helper
  function adjustTextareaHeight() {
    taskInput.style.height = "auto";
    taskInput.style.height = taskInput.scrollHeight + "px";
  }

  // Suggestion prompt clicks
  document.querySelectorAll(".suggestion-card").forEach((card) => {
    card.addEventListener("click", () => {
      taskInput.value = card.getAttribute("data-prompt");
      taskInput.focus();
      adjustTextareaHeight();
    });
  });

  // Enter sends. While the run works, what is typed goes to it as guidance
  // for its next step, and never stops it.
  taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (engineStatus === "running") queueSteerMessage();
      else if (!engineBusy()) startAgent();
    }
  });

  taskInput.addEventListener("input", adjustTextareaHeight);
  adjustTextareaHeight();

  // Escape key to stop agent execution
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (assistantsMenu && !assistantsMenu.hidden) { closeAssistants(); return; }
    if (memoryModal && !memoryModal.hidden) return;
    if (recipesModal && !recipesModal.hidden) return;
    if (isNarrow() && sidebar && !sidebar.classList.contains("collapsed")) { setSidebar(false); return; }
    if (engineBusy()) enginePost({ type: "stop", text: "Stopped." });
  });

  // In a narrow window (the side panel) the drawer overlays the run, so it
  // always starts closed there; the remembered open or closed choice is for
  // the full-size page only.
  const isNarrow = () => window.innerWidth <= 768;
  let sidebarRestored = false;
  function setSidebar(open, remember) {
    if (!sidebar) return;
    sidebar.classList.toggle("collapsed", !open);
    if (sidebarToggleBtn) {
      sidebarToggleBtn.setAttribute("aria-expanded", String(open));
      sidebarToggleBtn.setAttribute("aria-label", open ? "Hide tasks" : "Show tasks");
    }
    if (sidebarBackdrop) sidebarBackdrop.classList.toggle("active", open && isNarrow());
    if (remember && !isNarrow()) chrome.storage.sync.set({ sidebarCollapsed: !open });
  }
  if (sidebar && isNarrow()) setSidebar(false);
  let wasNarrow = isNarrow();
  window.addEventListener("resize", () => {
    const narrow = isNarrow();
    if (narrow && !wasNarrow) setSidebar(false);
    wasNarrow = narrow;
  });

  if (sidebarToggleBtn && sidebar) {
    sidebarToggleBtn.addEventListener("click", () => setSidebar(sidebar.classList.contains("collapsed"), true));
  }
  if (sidebarCloseBtn) sidebarCloseBtn.addEventListener("click", () => setSidebar(false, true));

  // The drawer stays open until the user closes it. Only the backdrop
  // (which exists solely while the drawer overlays the run) dismisses it.
  if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", () => setSidebar(false, true));

  // --- Guidance while running ---
  // A message typed while the run works goes to the engine, which gives it
  // to the model before its next step. It never interrupts or stops the run.
  let steerTimer = null;
  function queueSteerMessage() {
    const text = (taskInput.value || "").trim();
    if (!text) return;
    enginePost({ type: "send", text });
    taskInput.value = "";
    adjustTextareaHeight();
    if (steerPending) {
      steerPending.textContent = "Sent. It reads this before its next step.";
      clearTimeout(steerTimer);
      steerTimer = setTimeout(() => { steerPending.textContent = ""; }, 4000);
    }
  }

  // --- History: recent tasks, with how each ended ---

  function formatSessionTime(timestamp) {
    if (!timestamp) return "";
    try {
      const d = new Date(timestamp);
      const mins = Math.round((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return "now";
      if (mins < 60) return `${mins}m`;
      const hours = Math.round(mins / 60);
      if (hours < 24 && d.getDate() === new Date().getDate()) return `${hours}h`;
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days < 2) return "Yesterday";
      if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  const OUTCOME_WORDS = { success: "Done", unconfirmed: "Answered, not confirmed", error: "Stopped with a problem", limit: "Usage limit reached", idle: "Stopped" };

  /** Renders recent runs from the run history the engine keeps. */
  function renderRecentSessions() {
    if (!recentSessionsList) return;
    chrome.storage.local.get("agentCrossSessionMemory", (res) => {
      const memory = res.agentCrossSessionMemory || [];
      recentSessionsList.textContent = "";
      if (memory.length === 0) {
        recentSessionsList.appendChild(el("div", "sidebar-empty-note", "Tasks you run show up here. Run one again in a click."));
        return;
      }
      memory.slice(0, 20).forEach((item) => {
        const row = el("div", "sidebar-chat-item");
        row.setAttribute("role", "listitem");
        row.tabIndex = 0;
        const outcome = item.outcome || "success";
        row.title = `${item.task || ""}\n${OUTCOME_WORDS[outcome] || ""}`.trim();

        const dot = el("span", "outcome-dot");
        dot.dataset.outcome = outcome;
        dot.setAttribute("aria-label", OUTCOME_WORDS[outcome] || "");
        const title = el("span", "session-title", item.task || "(untitled task)");
        const end = el("span", "session-end");
        const time = el("span", "session-time", formatSessionTime(item.timestamp));
        const again = el("button", "icon-btn sm session-run");
        again.type = "button";
        again.title = "Run again";
        again.setAttribute("aria-label", `Run again: ${item.task || ""}`);
        again.appendChild(icon("play"));
        end.append(time, again);
        row.append(dot, title, end);

        // Clicking the row puts the task in the composer; the play button runs it now.
        const reuse = () => {
          taskInput.value = item.task || "";
          adjustTextareaHeight();
          taskInput.focus();
          if (isNarrow()) setSidebar(false);
        };
        again.addEventListener("click", (e) => {
          e.stopPropagation();
          reuse();
          if (!engineBusy() && engineStatus !== "waiting") startAgent();
        });
        row.addEventListener("click", reuse);
        row.addEventListener("keydown", (e) => {
          if (e.target !== row) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            reuse();
          }
        });
        recentSessionsList.appendChild(row);
      });
    });
  }

  // ---------- Memory panel ----------
  const memoryModal = document.getElementById("memoryModal");
  let memoryOpener = null;
  function openMemoryModal() {
    if (!memoryModal) return;
    memoryOpener = document.activeElement;
    enginePost({ type: "memory_get" });
    renderKnown();
    memoryModal.hidden = false;
    const close = document.getElementById("memoryClose");
    if (close) close.focus();
  }
  function closeMemoryModal() {
    if (!memoryModal) return;
    memoryModal.hidden = true;
    if (memoryOpener && memoryOpener.isConnected) memoryOpener.focus();
  }
  function memoryRow(text, sub, onDelete, onEdit) {
    const li = document.createElement("li");
    const body = document.createElement("div");
    body.className = "memory-row-body";
    const t = document.createElement("div");
    t.className = "memory-row-text";
    t.textContent = text;
    body.appendChild(t);
    if (sub) {
      const d = document.createElement("div");
      d.className = "memory-row-sub";
      d.textContent = sub;
      body.appendChild(d);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "memory-del";
    del.setAttribute("aria-label", `Forget: ${text}`);
    del.textContent = "Forget";
    del.addEventListener("click", onDelete);
    // A row the user may reword: the text becomes a box, Enter or leaving it saves.
    if (onEdit) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "memory-del memory-edit";
      edit.setAttribute("aria-label", `Edit: ${text}`);
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        const box = document.createElement("input");
        box.className = "input memory-edit-input";
        box.value = text;
        box.maxLength = 240;
        box.setAttribute("aria-label", "Edit this");
        let done = false;
        const save = () => { if (done) return; done = true; const v = box.value.trim(); if (v && v !== text) onEdit(v); else box.replaceWith(t); };
        box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.stopPropagation(); done = true; box.replaceWith(t); } });
        box.addEventListener("blur", save);
        t.replaceWith(box);
        box.focus();
      });
      li.append(body, edit, del);
      return li;
    }
    li.append(body, del);
    return li;
  }
  const openMemoryBtn = document.getElementById("openMemoryBtn");
  if (openMemoryBtn) openMemoryBtn.addEventListener("click", openMemoryModal);
  if (memoryModal) {
    document.getElementById("memoryClose").addEventListener("click", closeMemoryModal);
    memoryModal.addEventListener("click", (e) => { if (e.target === memoryModal) closeMemoryModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !memoryModal.hidden) closeMemoryModal(); });
    if (location.hash === "#memory") setTimeout(openMemoryModal, 0);
  }

  // ---------- Recipes (recipes/service.js in the worker) ----------
  // A successful run can be saved as a recipe; saved recipes are listed,
  // run with no model call, and each run's receipt says what was proved.
  const recipesModal = document.getElementById("recipesModal");
  const recipesList = document.getElementById("recipesList");
  const recipeDetail = document.getElementById("recipeDetail");
  let recipesPort = null;
  let recipesRid = 0;
  const recipesWaiting = new Map();
  let recipesOpener = null;
  function recipesAsk(message, onProgress) {
    if (!recipesPort) {
      try { recipesPort = chrome.runtime.connect({ name: "recipesView" }); } catch (_e) { return Promise.resolve({ ok: false, why: "The extension is restarting. Try again." }); }
      recipesPort.onMessage.addListener((m) => {
        const w = m && recipesWaiting.get(m.rid);
        if (!w) return;
        if (m.type === "progress") { if (w.onProgress) w.onProgress(m.what); return; }
        recipesWaiting.delete(m.rid);
        w.resolve(m);
      });
      recipesPort.onDisconnect.addListener(() => {
        recipesPort = null;
        for (const w of recipesWaiting.values()) w.resolve({ ok: false, why: "The extension restarted." });
        recipesWaiting.clear();
      });
    }
    const rid = ++recipesRid;
    return new Promise((resolve) => {
      recipesWaiting.set(rid, { resolve, onProgress });
      try { recipesPort.postMessage({ ...message, rid }); } catch (_e) { recipesWaiting.delete(rid); resolve({ ok: false, why: "The extension is restarting. Try again." }); }
    });
  }

  /** "Save as recipe" under a run that succeeded, when the run can be repeated. */
  function drawSaveRecipe(runId) {
    const host = activeBubbleAnswer ? activeBubbleAnswer.parentElement : null;
    if (!host || !runId || host.querySelector(".recipe-save")) return;
    const note = el("div", "memory-note recipe-save");
    note.hidden = true;
    host.appendChild(note);
    recipesAsk({ type: "can_save", runId }).then((can) => {
      if (!can || !can.ok) return;
      const label = el("span", "", `Repeat this without the AI: ${can.steps} step${can.steps === 1 ? "" : "s"} on the page.`);
      const save = el("button", "recipe-save-btn", "Save as recipe");
      save.type = "button";
      save.addEventListener("click", async () => {
        save.disabled = true;
        const r = await recipesAsk({ type: "save", runId });
        note.textContent = "";
        if (!r.ok) { note.append(el("span", "", `Not saved: ${r.why || "it could not be saved"}.`)); return; }
        const view = el("button", "", "View");
        view.type = "button";
        view.addEventListener("click", openRecipesModal);
        note.append(el("span", "", "Saved as a recipe."), view);
      });
      note.append(label, save);
      note.hidden = false;
    });
  }

  const RECEIPT_STATES = {
    done_proven: ["Proved", "done"],
    done_unproven: ["Done, not proved", "needs"],
    needs_you: ["Stopped: needs you", "needs"],
    stopped: ["Stopped", "failed"],
    failed: ["Failed", "failed"],
  };

  function receiptView(receipt) {
    const box = el("div", "recipe-receipt");
    const [word, tone] = RECEIPT_STATES[receipt.end.state] || [receipt.end.state, "needs"];
    const head = el("div", `recipe-receipt-head tone-${tone}`);
    head.append(el("strong", "", word), el("span", "recipe-receipt-cost tabular", `${receipt.cost.modelCalls} model call${receipt.cost.modelCalls === 1 ? "" : "s"} · $${(receipt.cost.usd || 0).toFixed(4)}`));
    box.appendChild(head);
    if (receipt.end.why) box.appendChild(el("p", "recipe-receipt-why", receipt.end.why));
    const steps = el("ol", "recipe-receipt-steps");
    for (const s of receipt.steps || []) {
      const how = s.resolution && s.resolution.method && s.resolution.method !== "none" ? ` · found by ${s.resolution.method}` : "";
      const li = el("li", `step-${s.status}`);
      li.append(el("span", "recipe-step-status", s.status === "ok" ? "ok" : s.status), el("span", "", `${s.intent}${how}`));
      steps.appendChild(li);
    }
    box.appendChild(steps);
    const repairs = (receipt.repairs || []).filter((x) => x.diffText);
    if (repairs.length) {
      const r = el("div", "recipe-receipt-repairs");
      for (const x of repairs) r.appendChild(el("p", "", `Repair (${x.status.replace(/_/g, " ")}): ${x.diffText}${x.why ? `. ${x.why}` : ""}`));
      box.appendChild(r);
    }
    if (receipt.healed) box.appendChild(el("p", "memory-hint", "The repair was checked to the end of the run and saved as a new version of the recipe."));
    return box;
  }

  function recipeRunForm(r) {
    recipeDetail.textContent = "";
    recipeDetail.hidden = false;
    recipeDetail.appendChild(el("h3", "", r.title));
    const form = document.createElement("form");
    form.className = "recipe-run-form";
    form.autocomplete = "off";
    const inputs = [];
    for (const v of r.variables) {
      const label = el("label", "recipe-var");
      label.appendChild(el("span", "", v.name.replace(/_/g, " ")));
      let input;
      if (v.enum && v.enum.length) {
        input = document.createElement("select");
        for (const o of v.enum) { const opt = el("option", "", o); opt.value = o; input.appendChild(opt); }
        input.value = v.example;
      } else {
        input = document.createElement("input");
        input.className = "input";
        input.type = v.type === "secret" ? "password" : "text";
        input.value = v.example || "";
      }
      input.name = v.name;
      inputs.push(input);
      label.appendChild(input);
      form.appendChild(label);
    }
    if (r.commits.length) form.appendChild(el("p", "memory-hint recipe-commits", `Running it will do what you saved, including: ${r.commits.join("; ")}.`));
    const go = el("button", "btn btn-primary btn-sm", "Run");
    go.type = "submit";
    const status = el("span", "memory-hint recipe-status");
    status.setAttribute("role", "status");
    const row = el("div", "recipe-run-row");
    row.append(go, status);
    form.appendChild(row);
    const out = el("div", "recipe-run-out");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      go.disabled = true;
      out.textContent = "";
      const vars = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      // The sites it opens, allowed by the user first if the agent was never let onto them.
      const origins = (r.origins || []).map((o) => `${o}/*`);
      if (origins.length) await new Promise((res) => chrome.permissions.request({ origins }, () => { void chrome.runtime.lastError; res(); }));
      status.textContent = "Running…";
      const [tab] = await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => { void chrome.runtime.lastError; res(t || []); }));
      const res = await recipesAsk({ type: "run", id: r.id, vars, tabId: tab ? tab.id : undefined }, (what) => { status.textContent = what; });
      go.disabled = false;
      status.textContent = "";
      if (!res.ok) { out.appendChild(el("p", "recipe-receipt-why", res.why || "It could not run.")); return; }
      out.appendChild(receiptView(res.receipt));
      renderRecipes(false);
    });
    recipeDetail.append(form, out);
    if (r.receipts && r.receipts.length) {
      const past = document.createElement("details");
      past.className = "recipe-past";
      past.appendChild(el("summary", "", `Earlier runs (${r.receipts.length})`));
      for (const x of r.receipts) past.appendChild(receiptView(x));
      recipeDetail.appendChild(past);
    }
  }

  async function renderRecipes(clearDetail) {
    if (!recipesList) return;
    const res = await recipesAsk({ type: "list" });
    const list = (res && res.recipes) || [];
    recipesList.textContent = "";
    if (clearDetail !== false) { recipeDetail.hidden = true; recipeDetail.textContent = ""; }
    if (!list.length) { recipesList.appendChild(el("li", "memory-empty", "No recipes yet. After a task works, press \"Save as recipe\" under its answer.")); return; }
    for (const r of list) {
      const li = document.createElement("li");
      li.className = "recipe-row";
      const body = el("div", "memory-row-body");
      body.appendChild(el("div", "memory-row-text", r.title));
      const last = r.last ? `Last run: ${(RECEIPT_STATES[r.last.state] || [r.last.state])[0].toLowerCase()}` : "Not run yet";
      body.appendChild(el("div", "memory-row-sub", `${(r.sites || []).join(", ")} · ${r.steps} steps · ${last}`));
      const open = el("button", "memory-del memory-edit recipe-open", "Run");
      open.type = "button";
      open.setAttribute("aria-label", `Run: ${r.title}`);
      open.addEventListener("click", () => recipeRunForm(r));
      const del = el("button", "memory-del", "Delete");
      del.type = "button";
      del.setAttribute("aria-label", `Delete: ${r.title}`);
      del.addEventListener("click", async () => { await recipesAsk({ type: "delete", id: r.id }); renderRecipes(); });
      li.append(body, open, del);
      recipesList.appendChild(li);
    }
  }

  function openRecipesModal() {
    if (!recipesModal) return;
    recipesOpener = document.activeElement;
    recipesModal.hidden = false;
    renderRecipes();
    const close = document.getElementById("recipesClose");
    if (close) close.focus();
  }
  function closeRecipesModal() {
    if (!recipesModal) return;
    recipesModal.hidden = true;
    if (recipesOpener && recipesOpener.isConnected) recipesOpener.focus();
  }
  const openRecipesBtn = document.getElementById("openRecipesBtn");
  if (openRecipesBtn) openRecipesBtn.addEventListener("click", openRecipesModal);
  if (recipesModal) {
    document.getElementById("recipesClose").addEventListener("click", closeRecipesModal);
    recipesModal.addEventListener("click", (e) => { if (e.target === recipesModal) closeRecipesModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !recipesModal.hidden) closeRecipesModal(); });
    if (location.hash === "#recipes") setTimeout(openRecipesModal, 0);
  }

  renderRecentSessions();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.agentCrossSessionMemory) renderRecentSessions();
  });

  // New Task Button (Reset session)
  if (newTaskBtn) {
    newTaskBtn.addEventListener("click", () => {
      enginePost({ type: "reset" });
      // Clear the conversation
      chatContainer.querySelectorAll(".message-bubble, .chat-note").forEach((b) => b.remove());
      activeRun = null;
      welcomeScreen.style.display = "flex";
      taskInput.value = "";
      adjustTextareaHeight();
      if (isNarrow()) setSidebar(false);
      taskInput.focus();
    });
  }

  // ---------- Assistant sites, from the side panel ----------
  // In the side panel the agent is the home view; the assistants that
  // right-click sends to are one click away here.
  const assistantsWrap = document.getElementById("assistantsWrap");
  const assistantsBtn = document.getElementById("assistantsBtn");
  const assistantsMenu = document.getElementById("assistantsMenu");
  const inSidePanel = (() => {
    try { return window.top !== window && /\/sidepanel\.html$/.test(window.parent.location.pathname); } catch (_e) { return false; }
  })();
  function closeAssistants() {
    if (!assistantsMenu) return;
    assistantsMenu.hidden = true;
    assistantsBtn.setAttribute("aria-expanded", "false");
  }
  function openAssistant(baseUrl, host) {
    const key = `sessionUrl_${host}`;
    chrome.storage.local.get([key], (saved) => {
      const url = saved[key] && saved[key].includes(host) ? saved[key] : baseUrl;
      chrome.storage.local.set({ [CONFIG.STORAGE.SIDE_PANEL_STATE]: { url, selectedText: "", autoSend: false, timestamp: Date.now() } });
    });
  }
  if (inSidePanel && assistantsWrap) {
    assistantsWrap.hidden = false;
    assistantsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!assistantsMenu.hidden) { closeAssistants(); return; }
      chrome.storage.sync.get(["showChatGPT", "showGemini", "showClaude", "showPerplexity"], (s) => {
        assistantsMenu.textContent = "";
        assistantsMenu.appendChild(el("div", "menu-label", "Ask an assistant site"));
        const { URLS, HOSTS } = CONFIG;
        const sites = [
          [s.showChatGPT !== false, "ChatGPT", URLS.CHATGPT, HOSTS.CHATGPT],
          [s.showClaude !== false, "Claude", URLS.CLAUDE, HOSTS.CLAUDE],
          [s.showGemini !== false, "Gemini", URLS.GEMINI, HOSTS.GEMINI],
          [s.showPerplexity === true, "Perplexity", URLS.PERPLEXITY, HOSTS.PERPLEXITY_WWW],
        ].filter((x) => x[0]);
        for (const [, name, url, host] of sites) {
          const item = el("button", "menu-item");
          item.type = "button";
          item.setAttribute("role", "menuitem");
          const img = el("img");
          img.alt = "";
          img.width = 16;
          img.height = 16;
          img.src = faviconFor(url);
          item.append(img, el("span", "grow", name), icon("external"));
          item.addEventListener("click", () => { closeAssistants(); openAssistant(url, host); });
          assistantsMenu.appendChild(item);
        }
        if (!sites.length) assistantsMenu.appendChild(el("div", "menu-label", "Turn assistants on in Settings."));
        assistantsMenu.hidden = false;
        assistantsBtn.setAttribute("aria-expanded", "true");
        const first = assistantsMenu.querySelector(".menu-item");
        if (first) first.focus();
      });
    });
    document.addEventListener("click", (e) => { if (!assistantsWrap.contains(e.target)) closeAssistants(); });
  }

  // Helper to get key/url for the active provider (catalog shared with the
  // service worker via defaults.js).
  function getProviderDetails(provider) {
    if (provider === "custom") {
      return { apiKey: config.agentCustomKey, baseUrl: config.agentCustomUrl };
    }
    const entry = (SELECT_TO_AI_DEFAULTS.PROVIDER_ENDPOINTS || {})[provider];
    if (!entry) {
      return { apiKey: "", baseUrl: "" };
    }
    return { apiKey: config[entry.keyName] || "", baseUrl: entry.baseUrl };
  }

  function getProviderFallbackModels(provider) {
    const catalog = SELECT_TO_AI_DEFAULTS.PROVIDER_FALLBACK_MODELS;
    return catalog[provider] || catalog.openrouter;
  }

  // ---- backup provider -------------------------------------------------
  // When the main provider's usage limit runs out and the user has chosen a
  // backup, the engine's calls go to the backup until the limit resets. The
  // pause lives in storage; this page reads it to name the backup in the
  // composer while it stands in.
  let backupActive = null; // { from, to, until, mainModel }

  function clockTime(ms) {
    try { return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (_e) { return "later"; }
  }

  function usableBackup(from) {
    const to = config.agentBackupProvider;
    return to && to !== from && hasProviderCredentials(to) ? to : "";
  }

  function applyProviderPause(pause) {
    backupActive = null;
    if (!pause || !pause.provider || !(pause.until > Date.now())) return;
    if (pause.provider !== config.agentActiveProvider) return;
    const to = usableBackup(pause.provider);
    if (!to) return;
    backupActive = { from: pause.provider, to, until: pause.until, mainModel: config.agentModel };
    config.agentActiveProvider = to;
    config.agentModel = SELECT_TO_AI_DEFAULTS.backupModelFor(to) || getProviderFallbackModels(to).lite;
  }

  /** A one-line note in the conversation, above the reply it concerns. */
  function appendChatNote(text) {
    const note = document.createElement("div");
    note.className = "chat-note";
    note.setAttribute("role", "status");
    note.textContent = text;
    const bubbles = chatContainer.querySelectorAll(".message-bubble.assistant");
    const last = bubbles[bubbles.length - 1];
    if (last) chatContainer.insertBefore(note, last);
    else chatContainer.appendChild(note);
  }

  /** Under a limit notice with no backup chosen: offer to set one up. */
  function addBackupOffer(box) {
    if (!box || box.querySelector(".notice-actions")) return;
    const onChatGPT = config.agentActiveProvider === "chatgpt";
    const hasBackup = config.agentBackupProvider && hasProviderCredentials(config.agentBackupProvider);
    if (hasBackup && !onChatGPT) return;
    const row = document.createElement("div");
    row.className = "notice-actions";
    // On the user's ChatGPT plan, OpenAI's guidelines make Manage usage the first action.
    if (onChatGPT) {
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = "notice-btn btn btn-sm";
      manage.textContent = "Manage usage";
      manage.onclick = () => chrome.tabs.create({ url: SELECT_TO_AI_CHATGPT.USAGE_URL });
      row.appendChild(manage);
      if (hasBackup) { box.appendChild(row); return; }
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "notice-btn btn btn-sm";
    btn.textContent = "Set up a free backup";
    btn.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#backup") });
    const hint = document.createElement("span");
    hint.textContent = "Google Gemini is free, and takes over until your requests come back.";
    row.append(btn, hint);
    box.appendChild(row);
  }

  function isModelCompatibleWithProvider(provider, model) {
    if (!model) return false;
    if (
      provider === "custom" ||
      provider === "openrouter" ||
      provider === "opencode" ||
      provider === "chatgpt"
    )
      return true;

    if (provider === "anthropic") return model.startsWith("claude-");
    if (provider === "openai") return /^(gpt-|o\d|chatgpt-)/.test(model);
    if (provider === "deepseek") return model.startsWith("deepseek-");
    if (provider === "gemini") return model.startsWith("gemini-");
    if (provider === "mistral")
      return (
        model.includes("mistral") ||
        model.includes("ministral") ||
        model.includes("codestral") ||
        model.includes("magistral") ||
        model.includes("devstral")
      );
    if (provider === "groq")
      return (
        /^(llama|llama3|llama-3|mixtral|gemma|qwen|deepseek|moonshot|gpt-oss)/.test(
          model,
        ) || model.includes("/")
      );
    if (provider === "together") return model.includes("/");
    if (provider === "cerebras") return /^(gpt-oss|qwen|llama|zai|glm)/.test(model);
    if (provider === "xai") return model.startsWith("grok-");
    if (provider === "opencode") return true;
    return true;
  }

  function getProviderKeyValidationError(provider, apiKey) {
    const key = (apiKey || "").trim();
    if (provider === "custom") return "";
    // ChatGPT is signed in to, not keyed.
    if (provider === "chatgpt") {
      const a = config.chatgptAccount;
      if (!a || !a.signedIn) return "The agent needs you to sign in with ChatGPT first.";
      return a.planEnabled ? "" : "ChatGPT plan use is not turned on for this sign-in. Turn it on in Settings with Continue with ChatGPT.";
    }
    if (!key) return `Missing API key for active provider "${provider}".`;
    if (
      key === "sk-or-v1-..." ||
      key === "sk-proj-..." ||
      key === "sk-ant-..." ||
      key === "AIzaSy..." ||
      key === "gsk_..." ||
      key.toLowerCase() === "api key"
    ) {
      return `The saved ${provider} API key looks like a placeholder, not a real key.`;
    }
    if (provider === "openrouter" && !key.startsWith("sk-or-"))
      return 'OpenRouter keys usually start with "sk-or-". Check that the active provider matches the key you saved.';
    if (provider === "anthropic" && !key.startsWith("sk-ant-"))
      return 'Anthropic keys usually start with "sk-ant-". Check that the active provider matches the key you saved.';
    if (provider === "openai" && !key.startsWith("sk-"))
      return 'OpenAI keys usually start with "sk-". Check that the active provider matches the key you saved.';
    // Google AI Studio issues "AIza..." keys and, since 2026, "AQ." keys.
    if (provider === "gemini" && !/^(AIza|AQ\.)/.test(key))
      return 'Gemini API keys start with "AIza" or "AQ.". Check that the active provider matches the key you saved.';
    if (provider === "groq" && !key.startsWith("gsk_"))
      return 'Groq keys usually start with "gsk_". Check that the active provider matches the key you saved.';
    if (provider === "cerebras" && !key.startsWith("csk-"))
      return 'Cerebras keys usually start with "csk-". Copy the key from cloud.cerebras.ai.';
    if (provider === "xai" && !key.startsWith("xai-"))
      return 'xAI keys usually start with "xai-". Check that the active provider matches the key you saved.';
    // OpenCode console keys look like "oc_sk_..."; older ones used "sk-".
    if (provider === "opencode" && !/^(oc_sk_|sk-)/.test(key))
      return 'OpenCode keys start with "oc_sk_". Copy the key from opencode.ai/console.';
    return "";
  }

  function hasProviderCredentials(provider) {
    if (provider === "custom") return true;
    const details = getProviderDetails(provider);
    return !getProviderKeyValidationError(provider, details.apiKey);
  }

  function getMissingCredentialsMessage(provider) {
    const details = getProviderDetails(provider);
    const validationError = getProviderKeyValidationError(
      provider,
      details.apiKey,
    );
    return `${validationError || `The agent needs an AI model connected first.`} Press "Connect" below, then run the task again.`;
  }

  // Load non-sensitive settings from sync storage and credentials locally.
  // Keys that versions before 3.1 saved in sync storage are moved to local storage.
  function loadSettings(callback = null) {
    const syncedKeys = CONFIG.STORAGE.API_KEYS;
    chrome.storage.sync.get(
      [...CONFIG.STORAGE.SETTINGS, ...syncedKeys],
      (syncItems) => {
        chrome.storage.local.get([...syncedKeys, "agentProviderPause", "chatgptAccount"], (localItems) => {
          const migratedKeys = {};
          syncedKeys.forEach((key) => {
            if (!localItems[key] && syncItems[key]) migratedKeys[key] = syncItems[key];
          });
          const items = { ...syncItems, ...localItems, ...migratedKeys };
          if (Object.keys(migratedKeys).length > 0) {
            chrome.storage.local.set(migratedKeys);
          }
          chrome.storage.sync.remove(syncedKeys);

      config.agentActiveProvider =
        items.agentActiveProvider || DEFAULTS.activeProvider;
      config.agentOpenRouterKey = items.agentOpenRouterKey || "";
      config.agentAnthropicKey = items.agentAnthropicKey || "";
      config.agentOpenAIKey = items.agentOpenAIKey || "";
      config.agentDeepSeekKey = items.agentDeepSeekKey || "";
      config.agentGeminiKey = items.agentGeminiKey || "";
      config.agentMistralKey = items.agentMistralKey || "";
      config.agentGroqKey = items.agentGroqKey || "";
      config.agentTogetherKey = items.agentTogetherKey || "";
      config.agentXaiKey = items.agentXaiKey || "";
      config.agentOpencodeKey = items.agentOpencodeKey || "";
      config.agentCerebrasKey = items.agentCerebrasKey || "";
      config.agentCustomKey = items.agentCustomKey || "";
      config.chatgptAccount = items.chatgptAccount || null;
      config.agentCustomUrl = items.agentCustomUrl || DEFAULTS.customUrl;

      config.agentModel = items.agentModel || DEFAULTS.model;
      config.agentBackupProvider = items.agentBackupProvider || "";
      applyProviderPause(items.agentProviderPause);

      connectEngine();

      // Theme: the stored choice, or the system's.
      const theme =
        items.theme ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light");
      document.documentElement.setAttribute("data-theme", theme);

      // The composer's pill shows the ACTUAL provider and model in use
      // (silently resolved, same fallback logic as the runtime).
      const provider = config.agentActiveProvider;
      const PROVIDER_NAMES = { chatgpt: "ChatGPT", openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", deepseek: "DeepSeek", mistral: "Mistral", groq: "Groq", together: "Together", xai: "xAI", opencode: "OpenCode", cerebras: "Cerebras", custom: "Your server" };
      const providerCapitalized =
        PROVIDER_NAMES[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
      const chatgptModels = (config.chatgptAccount && config.chatgptAccount.models) || [];
      const resolvedModel = provider === "chatgpt"
        ? (chatgptModels.some((m) => m.slug === config.agentModel) ? config.agentModel : SELECT_TO_AI_CHATGPT.bestModel(chatgptModels) || getProviderFallbackModels(provider).pro)
        : isModelCompatibleWithProvider(
          provider,
          config.agentModel,
        )
          ? config.agentModel
          : getProviderFallbackModels(provider).pro;
      // OpenAI's guidelines: say near the composer when the user's ChatGPT plan is in use.
      const planNote = document.getElementById("chatgptPlanNote");
      if (planNote) planNote.hidden = !(provider === "chatgpt" && !backupActive && !getProviderKeyValidationError("chatgpt", ""));

      const selectedModelName = document.getElementById("selectedModelName");
      if (selectedModelName) {
        // While the backup stands in, say so rather than show a model id
        // the narrow side panel would cut off before the word "backup".
        selectedModelName.textContent = backupActive
          ? `${providerCapitalized} · backup`
          : resolvedModel === "openrouter/free"
            ? "OpenRouter · free models"
            : `${providerCapitalized} · ${resolvedModel}`;
      }
      const headerModel = document.getElementById("headerModel");
      if (headerModel) {
        headerModel.title = backupActive
          ? `Using your backup, ${providerCapitalized}, until ${clockTime(backupActive.until)}: ${friendlyProviderName(backupActive.from)}'s limit ran out.\nChange it in Settings.`
          : `Provider: ${providerCapitalized}\nModel: ${resolvedModel}\nChange both in Settings.`;
      }

      // Restore the drawer's open or closed state, once, when the page opens.
      if (sidebar && !sidebarRestored) { sidebarRestored = true; setSidebar(!(items.sidebarCollapsed === true || isNarrow())); }

      // Validate API Key Availability
      const missingCredentials = !hasProviderCredentials(
        config.agentActiveProvider,
      );

      if (missingCredentials) {
        credentialsWarning.style.display = "flex";
        actionBtn.disabled = true;
      } else {
        credentialsWarning.style.display = "none";
        actionBtn.disabled = false;
      }
      if (callback) callback();
        });
      },
    );
  }

  // Settings storage changed listener
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "sync" || namespace === "local") {
      if (namespace === "local" && Object.keys(changes).every((k) => k === "agentCrossSessionMemory" || k === CONFIG.STORAGE.SIDE_PANEL_STATE)) return;
      loadSettings();
    }
  });

  function appendSimpleUserBubble(text, selection) {
    welcomeScreen.style.display = "none";
    const userBubble = document.createElement("div");
    userBubble.className = "message-bubble user";
    const content = document.createElement("div");
    content.className = "bubble-content";
    // The selection a request is about, above the words of the request.
    if (selection && selection.text) content.appendChild(selectionQuote(selection, null));
    content.appendChild(document.createTextNode(text));
    userBubble.appendChild(content);
    chatContainer.appendChild(userBubble);
    scrollToBottom(true);
  }

  // ---------- the selection a request is about ----------
  // "Ask the agent about this" keeps what was selected, with its place on
  // the page, in session storage for this tab (background.js). It shows
  // above the composer until the request is sent or the user removes it,
  // and goes to the run as the selection.

  const SELECTION_KEY = (tabId) => `agentSelection:${tabId}`;
  // A selection kept longer than this was for an earlier visit to the panel.
  const SELECTION_FRESH_MS = 30 * 60000;
  let aboutSelection = null;
  const selectionSlot = el("div", "selection-slot");
  selectionSlot.hidden = true;
  composer.insertBefore(selectionSlot, composer.firstChild);

  /** The quoted selection with the page it came from; with `onRemove`, a way to take it off. */
  function selectionQuote(sel, onRemove) {
    const box = el("div", "selection-chip");
    const head = el("div", "selection-head");
    head.appendChild(el("span", "selection-label", "About this selection"));
    const host = hostOf(sel.url);
    if (host) {
      const from = el("span", "selection-from");
      from.title = sel.title ? `${sel.title}\n${sel.url}` : sel.url;
      const img = el("img");
      img.alt = "";
      img.src = faviconFor(sel.url);
      from.append(img, el("span", "", host));
      head.appendChild(from);
    }
    if (onRemove) {
      const x = el("button", "selection-remove");
      x.type = "button";
      x.title = "Remove the selection";
      x.setAttribute("aria-label", "Remove the selection");
      x.appendChild(icon("x"));
      x.addEventListener("click", onRemove);
      head.appendChild(x);
    }
    const text = String(sel.text || "");
    const quote = el("blockquote", "selection-text", text.length > 280 ? `${text.slice(0, 279)}…` : text);
    quote.title = text;
    box.append(head, quote);
    return box;
  }

  function showSelection(sel) {
    aboutSelection = sel && sel.text ? sel : null;
    selectionSlot.textContent = "";
    selectionSlot.hidden = !aboutSelection;
    if (aboutSelection) {
      selectionSlot.appendChild(selectionQuote(aboutSelection, () => { dropSelection(); taskInput.focus(); }));
      if (!taskInput.disabled) taskInput.focus();
    }
    updateComposerForSelection();
  }

  /** The selection is used or removed: it is not offered again. */
  function dropSelection() {
    const id = engineTabId();
    showSelection(null);
    if (id !== undefined && chrome.storage.session) chrome.storage.session.remove(SELECTION_KEY(id)).catch(() => {});
  }

  function updateComposerForSelection() {
    if (aboutSelection && !engineBusy() && engineStatus !== "waiting") taskInput.placeholder = "Ask about the selected text";
    else if (!aboutSelection && taskInput.placeholder === "Ask about the selected text") taskInput.placeholder = "Ask anything, or tell it what to do";
  }

  (function takeSelection() {
    const id = engineTabId();
    if (id === undefined || !chrome.storage || !chrome.storage.session) return;
    const key = SELECTION_KEY(id);
    const fresh = (v) => v && v.text && Date.now() - (v.at || 0) < SELECTION_FRESH_MS;
    chrome.storage.session.get(key).then((r) => { if (fresh(r && r[key])) showSelection(r[key]); }).catch(() => {});
    // The side panel may be open already when a new selection is chosen.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !changes[key]) return;
      const v = changes[key].newValue;
      if (fresh(v)) showSelection(v);
    });
  })();

  // Answers render with answerFormat.js: headings, lists, tables, code and
  // links, with everything escaped first, so model text cannot inject HTML.
  function renderAnswerHtml(text) {
    return SELECT_TO_AI_ANSWER.renderAnswerHtml(String(text ?? ""), [], { headingShift: 1 });
  }

  function appendSimpleAssistantBubble(text) {
    const assistantBubble = document.createElement("div");
    assistantBubble.className = "message-bubble assistant";
    const content = document.createElement("div");
    content.className = "bubble-content";
    const box = document.createElement("div");
    box.className = "final-answer-box";
    box.style.display = "block";
    box.innerHTML = renderAnswerHtml(text);
    content.appendChild(box);
    assistantBubble.appendChild(content);
    chatContainer.appendChild(assistantBubble);
    scrollToBottom(true);
    return assistantBubble;
  }

  // The view follows new work only while the user is at the bottom of it.
  function scrollToBottom(force) {
    const gap = chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight;
    if (force || gap < 160) chatViewport.scrollTop = chatViewport.scrollHeight;
  }

  // ==========================================
  // THE TIMELINE
  // ==========================================
  // Every log entry from the engine is one .log-item, so the harnesses can
  // read the whole log as text. Steps are grouped: the goal on one line with
  // an icon for the kind of action, what it found underneath, and the raw
  // actions and results behind a disclosure.

  function logItem(cls, title, text) {
    const item = el("div", `log-item ${cls}`);
    const t = el("span", "log-title visually-hidden", `${title}. `);
    item.appendChild(t);
    return item;
  }

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function clearPending() {
    if (activeRun && activeRun.pending) { activeRun.pending.remove(); activeRun.pending = null; }
  }

  /** The row that stands for work in progress before a step has a goal. */
  function showPending(text) {
    if (!activeRun || !activeLogsWrapper) return;
    // While sub-tasks work, their rows and the header say what is going on.
    if (!drawingSub) { const c = subCounts(); if (c.running || c.waiting) { clearPending(); updateLive(); return; } }
    if (!activeRun.pending) {
      const li = el("li", "tl-pending");
      const ic = el("span", "tl-icon");
      ic.appendChild(dotEl());
      const body = el("div", "tl-body");
      const words = el("div", "tl-pending-text");
      const thought = el("div", "tl-thought");
      body.append(words, thought);
      li.append(ic, body);
      activeRun.pending = li;
      activeRun.pendingText = words;
      activeRun.pendingThought = thought;
    }
    activeRun.pendingText.textContent = text;
    // The work in progress is the current step now, not the one before it.
    if (activeRun.step) activeRun.step.li.classList.remove("is-current");
    activeLogsWrapper.appendChild(activeRun.pending);
    updateLive();
  }

  function setCurrentStep(step) {
    if (!activeRun) return;
    if (activeRun.step && activeRun.step !== step) activeRun.step.li.classList.remove("is-current");
    activeRun.step = step;
    if (step) step.li.classList.toggle("is-current", engineStatus === "running" && !activeRun.pending);
  }

  function newStep(n, goalText) {
    clearPending();
    clearDraft();
    const li = el("li", "tl-step");
    li.dataset.step = String(n);
    const ic = el("span", "tl-icon");
    ic.appendChild(icon("sparkle"));
    const body = el("div", "tl-body");
    const line = el("div", "tl-line");
    const goal = logItem("tl-goal", `Step ${n}`);
    const goalWords = el("span", "tl-goal-text", goalText);
    goal.appendChild(goalWords);
    const host = el("span", "tl-host");
    host.hidden = true;
    line.append(goal, host);
    const summary = el("div", "tl-summary");
    const more = el("details", "tl-more");
    more.hidden = true;
    const moreSummary = el("summary");
    moreSummary.append(icon("chevron"), el("span", "", "Details"));
    moreSummary.firstChild.classList.add("chev");
    const moreBody = el("div", "tl-more-body");
    more.append(moreSummary, moreBody);
    body.append(line, summary, more);
    li.append(ic, body);
    activeLogsWrapper.appendChild(li);
    const step = { li, ic, goalWords, host, summary, more, moreBody, n, kind: "" };
    activeRun.steps.set(n, step);
    activeRun.count = Math.max(activeRun.count, n);
    setCurrentStep(step);
    syncStepHosts();
    updateRunSummary();
    updateLive();
    return step;
  }

  /** The step an action belongs to: the one under way, or a new one when the engine moved on. */
  function stepForAction(text) {
    const s = activeRun.step;
    if (s && (!activeRun.statusStep || activeRun.statusStep === s.n)) return s;
    return newStep(activeRun.statusStep || (s ? s.n + 1 : 1), plainAction(text));
  }

  function addAction(text) {
    clearPending();
    const s = stepForAction(text);
    const kind = String(text || "").split(" ")[0];
    if (!s.kind && ACTION_ICON[kind]) {
      s.kind = kind;
      s.ic.textContent = "";
      s.ic.appendChild(icon(ACTION_ICON[kind]));
    }
    const item = logItem("tl-act", "Action");
    item.append(el("span", "log-text", text), el("time", "log-time", stamp()));
    s.moreBody.appendChild(item);
    s.more.hidden = false;
  }

  function addResult(text, failed) {
    clearPending();
    const s = activeRun.step || newStep(activeRun.statusStep || 1, failed ? "Something did not work" : "Act on the page");
    const item = logItem(`tl-res${failed ? " is-failed" : ""}`, failed ? "Action Failed" : "Result");
    item.append(el("span", "log-text", text), el("time", "log-time", stamp()));
    s.moreBody.appendChild(item);
    s.more.hidden = false;
    const first = String(text || "").replace(/\s+/g, " ").trim();
    s.summary.textContent = first.length > 240 ? `${first.slice(0, 239)}…` : first;
    s.li.classList.toggle("is-failed", !!failed);
  }

  // How the events around the steps look: an icon and a tone.
  const EVENT_LOOK = {
    "Check Passed": ["shieldCheck", "good"], "Check Failed": ["shield", "bad"], "Quote Not Found": ["shield", "bad"],
    "Checking Answer": ["shield", ""], "Check Inconclusive": ["shield", "warn"], "Text Aimed at AI": ["alert", "warn"],
    "Hidden Text": ["alert", "warn"], "Allowed": ["check", "good"], "Declined": ["x", "bad"], "You Added": ["user", "you"],
    "Keep Going": ["user", "you"], "Answer Now": ["user", "you"], "Checking In": ["flag", ""], "Not Getting Anywhere": ["alert", "warn"],
    "Provider Asked To Wait": ["pause", "warn"], "Carrying On": ["play", ""], "Step Not Usable": ["alert", "warn"],
    "Second Check": ["shield", ""], "Not Held": ["info", ""], "Helper Model": ["sparkle", ""], "Main Model": ["sparkle", ""],
  };

  /** "Provider Asked To Wait" as "Provider asked to wait"; names such as AI stay as they are. */
  function sentenceCase(title) {
    return String(title || "").split(" ").map((w, i) => (i === 0 || /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ");
  }

  function addEvent(role, title, text, quiet) {
    if (!quiet) clearPending();
    const li = el("li", "tl-event");
    if (quiet) li.classList.add("tl-quiet");
    const look = EVENT_LOOK[title] || (role === "error" ? ["alert", "bad"] : role === "validator" ? ["shield", ""] : ["info", ""]);
    if (look[1]) li.dataset.tone = look[1];
    // The request is already shown above the run.
    if (title === "Task Started") li.classList.add("tl-quiet");
    const ic = el("span", "tl-icon");
    ic.appendChild(icon(look[0]));
    const item = el("div", "log-item tl-event-text");
    // The engine's title stays in the text the harnesses read; the screen
    // shows it in sentence case.
    const shown = el("span", "log-title-shown");
    shown.dataset.label = sentenceCase(title);
    shown.setAttribute("aria-hidden", "true");
    item.append(el("span", "log-title visually-hidden", `${title}. `), shown, el("span", "log-text", text));
    const body = el("div", "tl-body");
    body.appendChild(item);
    li.append(ic, body);
    activeLogsWrapper.appendChild(li);
  }

  // ---------- sub-tasks ----------
  // A run that hands out sub-tasks shows them as a group under the step
  // that did: one row each, with its live state, its site and a way to
  // watch its tab, and its own steps behind the row, closed by default.
  // A sub-task's entries are drawn by the same code as the run's, into the
  // sub-task's own list.

  const subs = new Map(); // sub-task id -> its view
  let drawingSub = false;
  const SUB_WORDS = { queued: "Waiting its turn", running: "Working", waiting: "Needs you", success: "Answered", unconfirmed: "Answered, not confirmed", error: "Did not finish", limit: "Did not finish", idle: "Stopped" };

  function drawSubtasks(entry) {
    if (!activeRun) return;
    const host = activeRun.step ? activeRun.step.li.querySelector(".tl-body") : null;
    const group = el("ol", "tl-subs");
    group.setAttribute("aria-label", "Sub-tasks");
    for (const t of entry.tasks || []) {
      const li = el("li", "tl-sub");
      li.dataset.state = "queued";
      const box = el("details", "tl-sub-box");
      const head = el("summary", "tl-sub-head");
      const mark = el("span", "tl-sub-mark");
      const task = el("span", "tl-sub-task", t.task);
      task.title = t.task;
      const site = el("span", "tl-host tl-sub-host");
      site.hidden = true;
      const state = el("span", "tl-sub-state", SUB_WORDS.queued);
      const chev = icon("chevron");
      chev.classList.add("chev");
      head.append(mark, task, site, state, chev);
      const list = el("ol", "logs-wrapper timeline tl-sub-steps");
      box.append(head, list);
      const watch = el("button", "tl-sub-watch");
      watch.type = "button";
      watch.title = "Show this sub-task's tab";
      watch.append(icon("eye"), el("span", "", "Watch"));
      watch.hidden = true;
      watch.addEventListener("click", () => {
        const v = subs.get(t.id);
        if (!v || v.tabId === null || v.tabId === undefined) return;
        chrome.tabs.update(v.tabId, { active: true }, (tab) => {
          void chrome.runtime.lastError;
          if (tab) chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
        });
      });
      const answer = el("div", "tl-summary tl-sub-answer");
      li.append(box, watch, answer);
      group.appendChild(li);
      const meta = el("span");
      subs.set(t.id, {
        id: t.id, task: t.task, li, list, mark, state, site, watch, answer, meta, tabId: null, phase: "queued",
        // What the timeline code reads and writes on a run it draws.
        steps: new Map(), step: null, count: 0, statusStep: 0, statusText: "", pending: null, draft: { hidden: true, textContent: "" }, ended: false, tookMs: 0,
      });
      setSubPhase(subs.get(t.id), "queued");
    }
    if (host) host.appendChild(group);
    else if (activeLogsWrapper) { const li = el("li", "tl-event tl-subs-row"); li.append(el("span", "tl-icon"), group); activeLogsWrapper.appendChild(li); }
    updateLive();
  }

  function setSubPhase(v, phase, outcome) {
    v.phase = phase;
    const shown = phase === "ended" ? outcome || "idle" : phase;
    v.li.dataset.state = shown;
    v.mark.textContent = "";
    if (phase === "running") v.mark.appendChild(dotEl("live"));
    else if (phase === "waiting") v.mark.appendChild(dotEl("warn"));
    else if (phase === "queued") v.mark.appendChild(dotEl());
    else v.mark.appendChild(icon({ success: "check", unconfirmed: "alert", error: "x", limit: "pause" }[shown] || "stop"));
    v.state.textContent = SUB_WORDS[shown] || shown;
    v.watch.hidden = !(phase === "running" || phase === "waiting") || v.tabId === null || v.tabId === undefined;
  }

  /** A sub-task started, or ended. */
  function updateSub(entry) {
    const v = subs.get(entry.id);
    if (!v) return;
    if (entry.state === "running") {
      if (entry.tabId !== undefined) v.tabId = entry.tabId;
      setSubPhase(v, "running");
      // The rows say what is going on now; the run's own work-in-progress line goes.
      if (!drawingSub) clearPending();
    } else if (entry.state === "ended") {
      withSub(entry.id, () => { clearPending(); setCurrentStep(null); });
      v.ended = true;
      setSubPhase(v, "ended", entry.outcome);
      const first = String(entry.text || "").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
      v.answer.textContent = first.length > 200 ? `${first.slice(0, 199)}…` : first;
    }
    updateLive();
  }

  /** Draws into a sub-task's own list with the run's timeline code. */
  function withSub(id, draw) {
    const v = subs.get(id);
    if (!v) return;
    const saved = [activeRun, activeLogsWrapper];
    activeRun = v;
    activeLogsWrapper = v.list;
    drawingSub = true;
    try { draw(); } finally {
      [activeRun, activeLogsWrapper] = saved;
      drawingSub = false;
    }
    if (v.phase === "running" && v.statusText) v.state.textContent = /^Step \d+/.test(v.statusText) ? `Step ${v.statusStep}` : v.statusText;
  }

  /** How many sub-tasks are at work, and how many need the user. */
  function subCounts() {
    let running = 0;
    let waiting = 0;
    for (const v of subs.values()) { if (v.phase === "running") running += 1; else if (v.phase === "waiting") waiting += 1; }
    return { running, waiting };
  }

  /** Each sub-task's row shows the site its tab is on, from the trace. */
  function syncSubHosts() {
    if (!engineTrace || !engineTrace.history) return;
    for (const v of subs.values()) {
      const mine = engineTrace.history.filter((h) => h.sub === v.id && hostOf(h.url));
      const url = mine.length ? mine[mine.length - 1].url : "";
      const host = hostOf(url);
      if (host && v.hostName !== host) {
        v.hostName = host;
        v.site.textContent = "";
        const img = el("img");
        img.alt = "";
        img.src = faviconFor(url);
        v.site.append(img, el("span", "", host));
        v.site.title = url;
        v.site.hidden = false;
      }
      for (const h of mine) {
        const s = v.steps.get(h.step);
        const sh = hostOf(h.url);
        if (!s || s.hostName === sh) continue;
        s.hostName = sh;
        s.host.textContent = "";
        const img = el("img");
        img.alt = "";
        img.src = faviconFor(h.url);
        s.host.append(img, el("span", "", sh));
        s.host.hidden = false;
      }
    }
  }

  // One log entry from the engine, placed in the timeline.
  function addLogEntry(role, title, description, { collapsible = false, quiet = false } = {}) {
    if (!activeLogsWrapper || !activeRun) return;
    void collapsible;
    // What the run did for itself is kept for the saved log, not drawn as a step.
    if (quiet) { addEvent(role, title, description, true); return; }
    const step = /^Step (\d+)$/.exec(title || "");
    if (role === "executor" && step) newStep(Number(step[1]), description);
    else if (role === "executor" && title === "Action") addAction(description);
    else if (role === "executor" && title === "Result") addResult(description, false);
    else if (role === "error" && title === "Action Failed") addResult(description, true);
    else addEvent(role, title, description);
    updateRunSummary();
    scrollToBottom();
  }

  // The engine's status line: what the run is doing between log entries.
  function setStatus(agentRole, message) {
    if (!activeRun) return;
    const text = String(message || "").replace(/…$/, "").trim();
    const n = /^Step (\d+)/.exec(text);
    if (n) activeRun.statusStep = Number(n[1]);
    else if (/^Looking at the page/.test(text)) activeRun.statusStep = 1;
    activeRun.statusText = text;
    if (agentRole === "idle" || engineStatus !== "running") clearPending();
    else showPending(n ? "Working out the next step" : text);
    updateLive();
    scrollToBottom();
  }

  // ==========================================
  // ENGINE VIEW (runs live in the service worker)
  // ==========================================
  // This page is a view. It sends what the user types,
  // and draws the run from the entries the engine sends: the same entries
  // whether they arrive live or all at once when the panel is reopened.

  // Start Loop
  function startAgent(handoff) {
    loadSettings(() => startAgentWithLoadedSettings(handoff));
  }

  /**
   * Starts the task in the box. `handoff` is true for a request typed in the
   * address bar: it is always a new task, never an answer to a run in
   * progress, and the engine asks here what to do when a run is live.
   */
  function startAgentWithLoadedSettings(handoff) {
    const task = taskInput.value.trim();
    if (!task) {
      taskInput.focus();
      taskInput.placeholder = "Type a task or question first";
      return;
    }

    if (!hasProviderCredentials(config.agentActiveProvider)) {
      const message = getMissingCredentialsMessage(config.agentActiveProvider);
      if (credentialsWarning) credentialsWarning.style.display = "flex";
      actionBtn.disabled = true;
      // A task handed over from the palette arrives pre-filled and looks ready
      // to go, so a thin strip above the composer reads as "it did nothing".
      // Say it where the answer would have appeared, and keep the task.
      try {
        appendSimpleUserBubble(task);
        appendSimpleAssistantBubble(
          "I can't run this yet: " + message +
            "\n\nPress \"Connect\" below (it takes about 20 seconds, free), " +
            "then press Enter here to run the task again.",
        );
        taskInput.value = task;
      } catch (_e) { /* the warning strip still stands */ }
      return;
    }

    if (handoff) {
      taskInput.value = "";
      taskInput.style.height = "auto";
      enginePost({ type: "handoff", text: task, tabId: engineTabId() });
      return;
    }
    routeUserTurn(task);
  }

  /**
   * An address-bar request reached this window while a run is live in it.
   * The user chooses: stop that run and start this one, or start this one
   * when that run ends. It never goes into the live run.
   */
  function askAboutHandoff(m) {
    const bubble = appendSimpleAssistantBubble(`A task is still running in this window. What should happen to your new request, "${String(m.text).slice(0, 200).replace(/[*_`#>[\]]/g, "")}"?`);
    bubble.classList.add("handoff-choice");
    const row = el("div", "confirm-actions handoff-actions");
    const choose = (choice) => {
      row.remove();
      enginePost({ type: "handoff", text: m.text, tabId: m.tabId, choice });
    };
    const stopBtn = el("button", "handoff-stop-btn btn btn-primary");
    stopBtn.type = "button";
    stopBtn.textContent = "Stop it and start this";
    stopBtn.addEventListener("click", () => choose("replace"));
    const queueBtn = el("button", "handoff-queue-btn btn btn-ghost");
    queueBtn.type = "button";
    queueBtn.textContent = "Start this after it";
    queueBtn.addEventListener("click", () => choose("queue"));
    row.append(stopBtn, queueBtn);
    bubble.querySelector(".bubble-content").appendChild(row);
    scrollToBottom(true);
  }

  function routeUserTurn(task) {
    // A new request is drawn when its run starts (the engine may first send
    // the conversation so far, which redraws the panel); a reply to a
    // waiting or running run is drawn now.
    if (engineStatus === "waiting" || engineStatus === "running") appendSimpleUserBubble(task);
    taskInput.value = "";
    taskInput.style.height = "auto";
    // One loop decides for itself whether this is a question about the page,
    // a task, or the answer to what it asked.
    const keep = document.querySelector(".confirmation-bubble.needs-you .keep-answer-box");
    // A new request carries the selection it is about; a word to a run in progress does not.
    const fresh = !(engineStatus === "waiting" || engineStatus === "running");
    const selection = fresh && aboutSelection ? aboutSelection : null;
    enginePost({ type: "send", text: task, tabId: engineTabId(), keep: !!(keep && keep.checked), ...(selection ? { selection } : {}) });
    if (selection) dropSelection();
  }

  let enginePort = null;
  let engineRunId = "";
  let engineStatus = "";
  let engineWait = null;
  let engineTrace = null;
  // Every journal entry of the run in view, for the saved log.
  let engineJournal = [];
  let engineCards = new Map();
  let engineAsked = "";
  // When the trace was last received, for the live clock between updates.
  let traceAt = 0;

  // A run waiting on its provider is still under way: the button stops it.
  const engineBusy = () => (engineStatus === "running" || (engineStatus === "waiting" && engineWait && (engineWait.kind === "approval" || engineWait.kind === "pause")));

  function engineTabId() {
    const id = parseInt(new URLSearchParams(window.location.search).get("tabId"), 10);
    return Number.isNaN(id) ? undefined : id;
  }

  function connectEngine() {
    if (enginePort) return;
    try {
      enginePort = chrome.runtime.connect({ name: "agentView" });
    } catch (_e) { enginePort = null; return; }
    enginePort.onMessage.addListener(onEngineMessage);
    // The worker was restarted: connect again and be sent the run afresh.
    enginePort.onDisconnect.addListener(() => { enginePort = null; setTimeout(connectEngine, 300); });
    engineReady = false;
    chrome.windows.getCurrent((w) => {
      void chrome.runtime.lastError;
      try { enginePort.postMessage({ type: "hello", windowId: w ? w.id : -1 }); } catch (_e) { return; }
      engineReady = true;
      // A page opened to start afresh (the benchmark) leaves no earlier conversation behind.
      if (new URLSearchParams(window.location.search).get("fresh") === "1" && !engineFreshDone) { engineFreshDone = true; enginePort.postMessage({ type: "reset" }); }
      for (const message of engineQueue.splice(0)) enginePort.postMessage(message);
    });
  }

  // Nothing is sent before the engine knows which window this view is for.
  let engineReady = false;
  let engineFreshDone = false;
  const engineQueue = [];
  function enginePost(message) {
    if (!enginePort) connectEngine();
    if (!engineReady) { engineQueue.push(message); return; }
    try { enginePort.postMessage(message); } catch (_e) { engineQueue.push(message); }
  }

  /** The run's bubble: its summary line and steps, the answer, and what follows. */
  function openRunBubble() {
    if (activeRun) { clearPending(); setCurrentStep(null); }
    const bubble = el("div", "message-bubble assistant run");
    const content = el("div", "bubble-content");
    const details = el("details", "run-details");
    details.open = true;
    const summary = el("summary", "run-details-summary agent-run-status");
    summary.dataset.state = "running";
    const stateIcon = el("span", "run-state-icon");
    const label = el("span", "run-state-label activeStatusText", "Working");
    const meta = el("span", "run-meta");
    const chev = icon("chevron");
    chev.classList.add("chev");
    summary.append(stateIcon, label, meta, chev);
    const panel = el("div", "logs-panel");
    const list = el("ol", "logs-wrapper timeline activeLogsWrapper");
    const actions = el("div", "logs-actions");
    const save = el("button", "export-logs-btn exportMdLogsBtn");
    save.type = "button";
    save.title = "Download this run's steps as Markdown";
    save.append(icon("download"), el("span", "", "Save log"));
    save.addEventListener("click", exportEngineLog);
    actions.appendChild(save);
    panel.append(list, actions);
    details.append(summary, panel);
    const stream = el("div", "stream-panel activeStreamPanel");
    const draft = el("div", "answer-draft");
    draft.hidden = true;
    // The answer while it is checked: shown at once, marked, and replaced
    // by the final answer (or marked as sent back) when the check is done.
    const provisional = el("div", "provisional-answer");
    provisional.hidden = true;
    const answer = el("div", "final-answer-box activeFinalAnswer");
    answer.style.display = "none";
    content.append(details, stream, draft, provisional, answer);
    bubble.appendChild(content);
    chatContainer.appendChild(bubble);

    activeLogsWrapper = list;
    activeBubbleAnswer = answer;
    activeStreamPanel = stream;
    activeRunDetails = details;
    activeRun = { bubble, summary, stateIcon, label, meta, draft, provisional, steps: new Map(), step: null, count: 0, statusStep: 0, statusText: "", pending: null, ended: false };
    setRunState("running", "Working");
    scrollToBottom(true);
  }

  /** The summary line: an icon for how the run stands, a word, and the count. */
  function setRunState(state, words) {
    if (!activeRun) return;
    activeRun.summary.dataset.state = state;
    activeRun.bubble.dataset.state = state;
    activeRun.label.textContent = words;
    const ic = activeRun.stateIcon;
    ic.textContent = "";
    if (state === "running") ic.appendChild(dotEl("live"));
    else if (state === "waiting") ic.appendChild(dotEl("warn"));
    else ic.appendChild(icon({ success: "check", unconfirmed: "alert", error: "x", limit: "pause", asked: "message" }[state] || "stop"));
    updateRunSummary();
  }

  function updateRunSummary() {
    if (!activeRun) return;
    const n = activeRun.count;
    const parts = [];
    if (n) parts.push(`${n} step${n === 1 ? "" : "s"}`);
    if (!drawingSub && subs.size) parts.push(`${subs.size} sub-task${subs.size === 1 ? "" : "s"}`);
    if (activeRun.ended && activeRun.tookMs >= 1000) parts.push(durationWords(activeRun.tookMs));
    activeRun.meta.textContent = parts.length ? `· ${parts.join(" · ")}` : "";
  }

  // ---------- the live header ----------

  const WAIT_WORDS = { approval: "Waiting for your go-ahead", sign_in: "Waiting for you to sign in", human_check: "Waiting for you to pass a check", code: "Waiting for a code from you", payment: "Waiting for you to pay", site_access: "Waiting for access to this site", question: "Waiting for your answer", check_in: "Waiting for you: keep going?", pause: "Paused by the provider" };
  let liveUrl = "";
  let liveTimer = null;
  let workedMs = 0;

  function updateLive() {
    // A sub-task being drawn does not speak for the run.
    if (drawingSub) return;
    const live = engineStatus === "running" || engineStatus === "waiting";
    liveHeader.hidden = !live;
    topbarTitle.hidden = live;
    liveStopBtn.hidden = !live;
    if (!live) { clearInterval(liveTimer); liveTimer = null; return; }
    const counts = subCounts();
    const waiting = engineStatus === "waiting" || (engineStatus === "running" && counts.waiting > 0 && !counts.running);
    liveHeader.dataset.state = waiting || counts.waiting ? "needs" : "working";
    let words;
    if (engineStatus === "waiting") words = WAIT_WORDS[engineWait && engineWait.kind] || "Waiting for you";
    else if (counts.running || counts.waiting) {
      // While sub-tasks work, the header counts them.
      const parts = [];
      if (counts.running) parts.push(`${counts.running} sub-task${counts.running === 1 ? "" : "s"} running`);
      if (counts.waiting) parts.push(`${counts.waiting} need${counts.waiting === 1 ? "s" : ""} you`);
      words = parts.join(", ");
    }
    else if (activeRun && !activeRun.draft.hidden) words = "Writing the answer";
    else if (activeRun && activeRun.pending) words = activeRun.pendingText.textContent;
    else if (activeRun && activeRun.step) words = activeRun.step.goalWords.textContent;
    else words = "Starting";
    liveGoal.textContent = words;
    tickLive();
    if (!liveTimer) liveTimer = setInterval(tickLive, 1000);
  }

  function tickLive() {
    const base = (engineTrace && engineTrace.activeMs) || 0;
    const now = base + (engineStatus === "running" && traceAt ? Date.now() - traceAt : 0);
    workedMs = Math.max(workedMs, now);
    liveTime.textContent = clockOf(workedMs);
  }

  /** The site the run is on: the tab's address, or the last page a step was on. */
  function updateLiveSite() {
    const history = (engineTrace && engineTrace.history) || [];
    const lastUrl = [...history].reverse().map((h) => h.url).find((u) => hostOf(u)) || "";
    const show = (url) => {
      const host = hostOf(url);
      liveSite.hidden = !host;
      if (!host || url === liveUrl) return;
      liveUrl = url;
      liveHost.textContent = host;
      liveSite.title = url;
      liveFavicon.src = faviconFor(url);
    };
    const tabId = engineTrace && engineTrace.tabId;
    if (tabId !== null && tabId !== undefined && chrome.tabs && chrome.tabs.get) {
      chrome.tabs.get(tabId, (tab) => {
        void chrome.runtime.lastError;
        show((tab && (tab.url || tab.pendingUrl)) || lastUrl);
      });
    } else show(lastUrl);
  }

  /** Each step shows the site it was on, once the trace says which. */
  function syncStepHosts() {
    if (drawingSub || !activeRun || !engineTrace || !engineTrace.history) return;
    syncSubHosts();
    for (const h of engineTrace.history) {
      if (h.sub) continue;
      const s = activeRun.steps.get(h.step);
      const host = hostOf(h.url);
      if (!s || !host || s.hostName === host) continue;
      s.hostName = host;
      s.host.textContent = "";
      const img = el("img");
      img.alt = "";
      img.src = faviconFor(h.url);
      s.host.append(img, el("span", "", host));
      s.host.title = h.url;
      s.host.hidden = false;
    }
  }

  // ---------- the answer as it is written ----------

  /** A string field of a JSON object that is still being written. */
  function partialField(text, key) {
    const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
    if (!m) return null;
    let out = "";
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text[i];
      if (c === '"') return out;
      if (c === "\\") {
        const n = text[i + 1];
        if (n === undefined) break;
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += n;
        i++;
        continue;
      }
      out += c;
    }
    return out;
  }

  /** A table still being written is held back until its header and rule are both in. */
  function tidyDraft(text) {
    const lines = String(text).split("\n");
    let start = lines.length;
    while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
    const rows = lines.slice(start);
    if (!rows.length) return text;
    // A row is shown once it is closed; the table once its rule is complete.
    if (!/\|\s*$/.test(rows[rows.length - 1])) rows.pop();
    const ruled = rows.length >= 2 && /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(rows[1]);
    return [...lines.slice(0, start), ...(ruled ? rows : [])].join("\n");
  }

  function clearDraft() {
    if (!activeRun || !activeRun.draft) return;
    activeRun.draft.hidden = true;
    activeRun.draft.textContent = "";
  }

  function onStream(text) {
    if (!activeRun) return;
    const raw = String(text || "");
    if (!raw) { if (activeRun.pendingThought) activeRun.pendingThought.textContent = ""; return; }
    const answer = /"do"\s*:\s*"done"/.test(raw) || /"answer"\s*:/.test(raw) ? partialField(raw, "answer") : null;
    if (answer && answer.trim()) {
      clearPending();
      const draft = activeRun.draft;
      draft.innerHTML = renderAnswerHtml(tidyDraft(answer));
      const blocks = draft.querySelectorAll("p, li, h2, h3, h4, h5, td");
      (blocks.length ? blocks[blocks.length - 1] : draft).appendChild(el("span", "caret"));
      draft.hidden = false;
      updateLive();
      scrollToBottom();
      return;
    }
    const goal = partialField(raw, "goal");
    if (goal && goal.trim() && engineStatus === "running") {
      showPending(goal.trim());
      return;
    }
    // Plain words from a model that thinks out loud: one quiet line.
    if (activeRun.pendingThought && !/^\s*[{[]/.test(raw)) {
      const line = raw.replace(/\s+/g, " ").trim();
      activeRun.pendingThought.textContent = line.length > 160 ? `…${line.slice(-159)}` : line;
    }
  }

  /** The composer and buttons, for where the run is. */
  function engineControls() {
    const working = engineBusy();
    isRunning = working;
    actionBtn.classList.toggle("stop-btn", working);
    actionBtn.title = working ? "Stop" : "Run";
    actionBtn.setAttribute("aria-label", working ? "Stop" : "Run");
    actionBtn.textContent = "";
    if (working) {
      const sq = icon("stop");
      sq.setAttribute("width", "14");
      sq.setAttribute("height", "14");
      actionBtn.appendChild(sq);
    } else {
      const up = icon("up");
      up.setAttribute("width", "16");
      up.setAttribute("height", "16");
      up.setAttribute("stroke-width", "2.5");
      actionBtn.appendChild(up);
    }
    // While the run works, the composer takes guidance for its next step.
    // A sub-task waiting on a question takes the next message as its answer.
    const subAsks = engineStatus === "running" && engineWait && engineWait.sub && !["approval", "pause"].includes(engineWait.kind);
    const steering = engineStatus === "running" && !subAsks;
    const asking = (engineStatus === "waiting" || subAsks) && engineWait && engineWait.kind !== "approval";
    taskInput.disabled = working && !steering && !subAsks;
    composer.dataset.mode = steering ? "steer" : "";
    const kind = (engineStatus === "waiting" || subAsks) && engineWait ? engineWait.kind : "";
    taskInput.placeholder = steering
      ? "Add guidance for its next step"
      : kind === "approval" ? "Decide on the step above, or stop the task"
        : kind === "pause" ? "It carries on by itself when the wait is over"
          : kind === "check_in" ? "Add something and keep going"
            : kind === "question" ? "Type your answer"
              : asking ? "Reply here, or do it on the page" : aboutSelection ? "Ask about the selected text" : "Ask anything, or tell it what to do";
    composerHint.textContent = "";
    composerHint.append(el("kbd", "", "Enter"), document.createTextNode(steering ? " to add" : " to send"));
    composerHint.hidden = taskInput.disabled;
    if (activeRun && activeRun.step) activeRun.step.li.classList.toggle("is-current", engineStatus === "running" && !activeRun.pending);
    if (engineStatus !== "running") clearPending();
    if (engineStatus === "waiting" && activeRun && !activeRun.ended) setRunState("waiting", "Waiting for you");
    else if (engineStatus === "running" && activeRun && !activeRun.ended) setRunState("running", "Working");
    updateLive();
  }

  // ---------- moments that need the user ----------

  const CARD_LOOK = {
    approval: ["shield", "needs"], share: ["idcard", "accent"], sign_in: ["lock", "needs"], human_check: ["human", "needs"],
    code: ["key", "needs"], payment: ["card", "needs"], site_access: ["globe", "needs"], question: ["help", "accent"],
    check_in: ["flag", "accent"], pause: ["pause", "needs"],
  };

  function cardHead(content, iconName, titleEl) {
    const head = document.createElement("div");
    head.className = "card-head";
    const ic = document.createElement("span");
    ic.className = "card-icon";
    ic.appendChild(icon(iconName));
    head.append(ic, titleEl);
    content.appendChild(head);
  }

  function cardButton(actions, label, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", onClick);
    actions.appendChild(b);
    return b;
  }

  /** A card for something the run is waiting on the user for. */
  function drawWait(wait) {
    const card = document.createElement("div");
    const approval = wait.kind === "approval";
    card.className = `message-bubble assistant confirmation-bubble ${approval && wait.risk !== "share" ? "risk" : approval ? "share" : "needs-you"}`;
    if (approval) card.dataset.riskKind = wait.risk || "unknown";
    card.dataset.waitKind = wait.kind;
    const look = CARD_LOOK[approval && wait.risk === "share" ? "share" : wait.kind] || ["help", "needs"];
    card.dataset.tone = look[1];
    card.setAttribute("role", "region");
    const titles = { approval: "Allow this step?", sign_in: "Sign in to carry on", human_check: "The site wants a human check", code: "The site needs a code from you", payment: "Payment is yours to make", site_access: "Let the agent use this site?", question: "A question for you", check_in: "Keep going?", pause: "The provider asked it to wait" };
    const content = document.createElement("div");
    content.className = "bubble-content";
    const title = document.createElement("p");
    title.className = "confirm-title";
    title.textContent = titles[wait.kind] || "Needs you";
    // A sub-task asks in its own name, so it is clear which part of the errand this is.
    if (wait.sub) {
      const from = el("p", "card-from");
      from.append(icon("split"), el("span", "", `Sub-task: ${wait.subTask || ""}`));
      content.appendChild(from);
      card.dataset.sub = wait.sub;
    }
    cardHead(content, look[0], title);
    card.setAttribute("aria-label", wait.sub ? `${title.textContent} (sub-task: ${wait.subTask || ""})` : title.textContent);
    const text = document.createElement("p");
    text.className = "confirm-text";
    text.textContent = wait.question || "";
    content.appendChild(text);
    if ((wait.detail || []).length) {
      const detail = document.createElement("div");
      detail.className = "confirm-detail";
      for (const line of wait.detail) { const row = document.createElement("div"); row.textContent = line; detail.appendChild(row); }
      content.appendChild(detail);
    }
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const button = (label, cls, onClick) => cardButton(actions, label, cls, onClick);
    if (approval && wait.risk === "share") {
      title.textContent = "Use your details here?";
      button("Fill them in", "confirm-risk-btn primary-btn btn btn-primary", () => enginePost({ type: "approve", id: wait.id }));
      button("Always on this site", "confirm-always-btn secondary-btn btn", () => enginePost({ type: "approve", id: wait.id, always: true }));
      button("Don't", "abort-risk-btn secondary-btn btn btn-ghost", () => enginePost({ type: "decline", id: wait.id }));
    } else if (approval) {
      button("Allow this step", "confirm-risk-btn primary-btn btn btn-primary", () => enginePost({ type: "approve", id: wait.id }));
      button("Don't do this", "abort-risk-btn secondary-btn btn", () => enginePost({ type: "decline", id: wait.id }));
      // A sub-task works in a tab behind the user's: they can look before they decide.
      if (wait.sub && wait.tabId !== null && wait.tabId !== undefined) {
        button("Show the tab", "wait-goto-btn secondary-btn btn btn-ghost", () => chrome.tabs.update(wait.tabId, { active: true }, (tab) => {
          void chrome.runtime.lastError;
          if (tab) chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
        }));
      }
    } else if (wait.kind === "site_access") {
      const url = (wait.detail || [])[0] || "";
      let host = "";
      try { host = new URL(url).host; } catch (_e) { /* no address */ }
      const grant = (origins) => chrome.permissions.request({ origins }, (granted) => {
        void chrome.runtime.lastError;
        if (granted) enginePost({ type: "done", id: wait.id });
        else text.textContent = "Access was not granted.";
      });
      if (host) button(`Only ${host}`, "primary-btn btn btn-primary", () => grant([`${new URL(url).protocol}//${host}/*`]));
      button("Allow on all sites", host ? "secondary-btn btn" : "primary-btn btn btn-primary", () => grant(["https://*/*", "http://*/*"]));
      button("Skip", "wait-skip-btn secondary-btn btn btn-ghost", () => enginePost({ type: "skip", id: wait.id }));
    } else if (wait.kind === "check_in") {
      // How long it has worked, what it has so far, and the two ways on.
      const notes = document.createElement("div");
      notes.className = "confirm-detail checkin-notes";
      notes.textContent = wait.notes ? `What I have found so far:\n${wait.notes}` : "I have not written anything down yet.";
      content.appendChild(notes);
      const minutes = Math.round((wait.period || 0) / 60000);
      button(minutes > 0 && wait.reason !== "calls" ? `Keep going (${minutes} more minute${minutes === 1 ? "" : "s"})` : "Keep going", "checkin-keep-btn primary-btn btn btn-primary", () => enginePost({ type: "keep_going", id: wait.id }));
      button("Stop and answer with what you have", "checkin-stop-btn secondary-btn btn", () => enginePost({ type: "wrap_up", id: wait.id }));
    } else if (wait.kind === "pause") {
      // A countdown to when the run carries on by itself.
      const left = document.createElement("p");
      left.className = "confirm-text hint pause-countdown";
      const tick = (first) => {
        const ms = Math.max(0, (wait.until || 0) - Date.now());
        const m = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        left.textContent = ms > 0 ? `Carrying on by itself in ${m}:${String(sec).padStart(2, "0")}` : "Carrying on";
        // The card is taken away when the wait ends.
        if (!first && (ms <= 0 || !card.isConnected)) clearInterval(timer);
      };
      const timer = setInterval(tick, 1000);
      tick(true);
      content.appendChild(left);
      button("Stop instead", "pause-stop-btn secondary-btn btn", () => enginePost({ type: "stop" }));
    } else if (wait.kind === "question") {
      const hint = document.createElement("p");
      hint.className = "confirm-text hint";
      hint.textContent = "Reply below and I'll carry on from here.";
      content.appendChild(hint);
      const keep = document.createElement("label");
      keep.className = "keep-answer";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "keep-answer-box";
      keep.append(box, document.createTextNode("Remember my answer for next time"));
      content.appendChild(keep);
    } else {
      const hint = document.createElement("p");
      hint.className = "confirm-text hint";
      hint.textContent = "I don't read the page while you do this, and I'll carry on by myself once it's done.";
      content.appendChild(hint);
      if (wait.tabId !== null && wait.tabId !== undefined) {
        button("Go to the tab", "wait-goto-btn primary-btn btn btn-primary", () => chrome.tabs.update(wait.tabId, { active: true }, (tab) => {
          void chrome.runtime.lastError;
          if (tab) chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
        }));
      }
      button("I'm done", `wait-done-btn secondary-btn btn${wait.tabId === null || wait.tabId === undefined ? " btn-primary" : ""}`, () => enginePost({ type: "done", id: wait.id }));
      button("Skip this", "wait-skip-btn secondary-btn btn btn-ghost", () => enginePost({ type: "skip", id: wait.id }));
    }
    if (actions.children.length) content.appendChild(actions);
    card.appendChild(content);
    chatContainer.appendChild(card);
    engineCards.set(wait.id, card);
    scrollToBottom(true);
  }

  /** An answered card leaves quickly; it stops counting as a card at once. */
  function removeCard(card) {
    if (!card) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !card.isConnected) { card.remove(); return; }
    card.className = "card-leaving";
    card.removeAttribute("data-wait-kind");
    card.removeAttribute("data-risk-kind");
    setTimeout(() => card.remove(), 130);
  }

  /**
   * The pages the answer drew on, as chips under it: the engine names them
   * (pages holding its evidence, and pages the run read that the answer
   * refers to). An answer that drew on no page has no chips.
   */
  function drawSources(host, sources) {
    const pages = (sources || []).filter((x) => x && hostOf(x.url));
    if (!pages.length) return;
    const row = el("div", "answer-meta answer-sources");
    row.appendChild(el("span", "meta-label", "Pages used"));
    for (const p of pages.slice(0, 6)) {
      const a = el("a", "pill");
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = p.title ? `${p.title}\n${p.url}` : p.url;
      const img = el("img");
      img.alt = "";
      img.src = faviconFor(p.url);
      a.append(img, el("span", "", hostOf(p.url)));
      row.appendChild(a);
    }
    host.appendChild(row);
  }

  // ---------- the answer while it is checked ----------

  /** The mark beside an answer shown while it is checked: a word and an icon or dot. */
  function setProvisionalMark(box, state, words) {
    box.dataset.state = state;
    let mark = box.querySelector(".provisional-mark");
    if (!mark) { mark = el("div", "provisional-mark"); mark.setAttribute("role", "status"); box.prepend(mark); }
    mark.textContent = "";
    mark.append(state === "checking" ? dotEl("live") : icon("alert"), el("span", "provisional-words", words));
  }

  /** The model answered: the answer is shown now, marked as being checked. */
  function drawProvisional(entry) {
    if (!activeRun || !activeRun.provisional) return;
    clearPending();
    clearDraft();
    const box = activeRun.provisional;
    box.textContent = "";
    const body = el("div", "provisional-body");
    body.innerHTML = renderAnswerHtml(entry.text);
    box.appendChild(body);
    setProvisionalMark(box, "checking", "Checking…");
    box.hidden = false;
    activeRun.provisionalText = entry.text;
    scrollToBottom();
  }

  /** The check sent the answer back: it stays in view, marked as replaced, while the run works on. */
  function provisionalSentBack(entry) {
    if (!activeRun || !activeRun.provisional || activeRun.provisional.hidden) return;
    const why = String(entry.why || "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
    const short = why.length > 200 ? `${why.slice(0, 199)}…` : why;
    setProvisionalMark(activeRun.provisional, "replaced", `Checking found a problem${short ? `: ${short}` : ""}; still working`);
    activeRun.provisionalText = "";
  }

  /**
   * The run ended. The answer shown while checked gives way to the final
   * one; one the run ended without confirming stays, marked as such.
   */
  function settleProvisional(entry) {
    const box = activeRun && activeRun.provisional;
    if (!box || box.hidden) return false;
    const answered = entry.state === "success" || entry.state === "unconfirmed";
    if (answered) {
      const same = box.dataset.state === "checking" && activeRun.provisionalText === entry.text;
      box.hidden = true;
      box.textContent = "";
      return same;
    }
    if (entry.provisionalUnchecked) setProvisionalMark(box, "unchecked", "Not checked: the run stopped before the check finished");
    return false;
  }

  /** The end of a run, drawn in its bubble. */
  function drawOutcome(entry) {
    if (!activeBubbleAnswer || !activeRun) return;
    clearPending();
    clearDraft();
    setCurrentStep(null);
    activeRun.ended = true;
    activeRun.tookMs = (engineTrace && engineTrace.activeMs) || 0;
    // The same text as the answer shown while checked appears in place, without fading in again.
    const inPlace = settleProvisional(entry);
    activeBubbleAnswer.classList.toggle("in-place", inPlace);
    activeBubbleAnswer.style.display = "block";
    if (activeRunDetails && (entry.state === "success" || entry.state === "unconfirmed" || entry.state === "limit")) activeRunDetails.removeAttribute("open");
    // A run that ended before its first step has no steps to show.
    if (activeRunDetails && !activeRun.count && !activeLogsWrapper.querySelector(".tl-event:not(.tl-quiet)")) activeRunDetails.hidden = true;
    const unconfirmed = entry.state === "unconfirmed";
    if (entry.state === "error") {
      activeBubbleAnswer.textContent = "";
      const box = el("div", "answer-error");
      box.append(icon("alert"), el("span", "", entry.text));
      activeBubbleAnswer.appendChild(box);
      setRunState("error", "Stopped with a problem");
    } else {
      activeBubbleAnswer.innerHTML = renderAnswerHtml(entry.text);
      // What the second look thought, under the answer and apart from it.
      // What it could not confirm is marked as such.
      if (entry.note && activeBubbleAnswer.parentElement) {
        const note = el("div", unconfirmed ? "answer-note unconfirmed" : "answer-note");
        note.append(icon(unconfirmed ? "alert" : "info"), el("span", "", entry.note));
        activeBubbleAnswer.insertAdjacentElement("afterend", note);
      }
      if (entry.state === "limit") { activeBubbleAnswer.classList.add("notice"); addBackupOffer(activeBubbleAnswer); }
      else if (entry.state === "success" || unconfirmed) drawSources(activeBubbleAnswer.parentElement, entry.sources);
      setRunState(entry.state === "success" ? "success" : unconfirmed ? "unconfirmed" : entry.state === "limit" ? "limit" : "idle",
        entry.state === "success" ? "Done" : unconfirmed ? "Answered, not confirmed" : entry.state === "limit" ? "Usage limit reached" : "Stopped");
    }
    updateRunSummary();
  }

  function drawEntry(entry, live) {
    if (entry.k === "subtasks") { drawSubtasks(entry); return; }
    if (entry.k === "sub") { updateSub(entry); return; }
    // A sub-task's own steps and status go in its row.
    if (entry.sub && (entry.k === "log" || entry.k === "status")) { withSub(entry.sub, () => drawEntry({ ...entry, sub: undefined }, live)); return; }
    if (entry.k === "ask" && entry.wait && entry.wait.sub && subs.get(entry.wait.sub)) setSubPhase(subs.get(entry.wait.sub), "waiting");
    if (entry.k === "ask_done" && entry.sub && subs.get(entry.sub) && subs.get(entry.sub).phase === "waiting") setSubPhase(subs.get(entry.sub), "running");
    if (entry.k === "log") addLogEntry(entry.role, entry.title, entry.text, { collapsible: entry.fold, quiet: !!entry.quiet });
    else if (entry.k === "provisional") drawProvisional(entry);
    else if (entry.k === "provisional_replaced") provisionalSentBack(entry);
    else if (entry.k === "status") setStatus(entry.role, entry.text);
    else if (entry.k === "ask") { engineWait = entry.wait; engineAsked = entry.wait.kind === "question" ? entry.wait.question : ""; drawWait(entry.wait); }
    else if (entry.k === "ask_done") { const card = engineCards.get(entry.id); if (live) removeCard(card); else if (card) card.remove(); engineCards.delete(entry.id); if (!engineWait || engineWait.id === entry.id) engineWait = null; }
    // What the user typed is already on screen when it arrives live. The
    // run carries on underneath it, so the conversation reads in order.
    else if (entry.k === "user") {
      if (!live) appendSimpleUserBubble(entry.text);
      // The question stays where it was asked, above the reply to it.
      if (engineAsked && activeBubbleAnswer) { activeBubbleAnswer.style.display = "block"; activeBubbleAnswer.innerHTML = renderAnswerHtml(engineAsked); }
      engineAsked = "";
      if (activeRun) { activeRun.ended = true; activeRun.tookMs = 0; setRunState("asked", "Asked you"); clearPending(); setCurrentStep(null); }
      if (activeRunDetails) activeRunDetails.removeAttribute("open");
      openRunBubble();
    }
    else if (entry.k === "note") appendChatNote(entry.text);
    else if (entry.k === "memory") drawRemembered(entry.text);
    else if (entry.k === "offer") drawOffer(entry);
    else if (entry.k === "answer") { drawOutcome(entry); drawUsed(entry.used); if (entry.state === "success" || entry.state === "unconfirmed") drawFeedback(engineRunId); if (entry.state === "success") drawSaveRecipe(engineRunId); }
  }

  // ---- what the assistant knows (core/memory.js), as the engine holds it
  const KNOWN = globalThis.SELECT_TO_AI_KNOWN;
  let engineMemory = null;

  /** "Remembered: ..." under the run, with a way to take it back. */
  function drawRemembered(text) {
    const host = activeBubbleAnswer ? activeBubbleAnswer.parentElement : null;
    if (!host) return;
    const note = document.createElement("div");
    note.className = "memory-note";
    const label = document.createElement("span");
    label.textContent = `Remembered: ${text.length > 70 ? `${text.slice(0, 69)}…` : text}`;
    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => {
      const entry = engineMemory && engineMemory.entries.find((e) => e.text === text);
      if (entry) enginePost({ type: "memory_change", change: { op: "remove", id: entry.id } });
      note.textContent = "Forgotten.";
    });
    const view = document.createElement("button");
    view.type = "button";
    view.textContent = "View";
    view.addEventListener("click", openMemoryModal);
    note.append(label, view, undo);
    host.appendChild(note);
  }

  /** Two small buttons under an answer: the user's word on whether it was right. */
  function drawFeedback(runId) {
    const host = activeBubbleAnswer ? activeBubbleAnswer.parentElement : null;
    if (!host || host.querySelector(".answer-feedback")) return;
    const row = document.createElement("div");
    row.className = "answer-feedback";
    const send = (up, reason) => {
      enginePost({ type: "feedback", runId, up, reason: reason || "" });
      row.textContent = up ? "Thanks." : "Thanks. I'll take that into account.";
    };
    const say = (up) => {
      if (up) { send(true); return; }
      // What was wrong, in the user's words, is what teaches something.
      row.textContent = "";
      const why = document.createElement("input");
      why.className = "feedback-why input";
      why.placeholder = "What was wrong? (optional)";
      why.maxLength = 300;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "feedback-send";
      go.textContent = "Send";
      go.addEventListener("click", () => send(false, why.value.trim()));
      why.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); send(false, why.value.trim()); } });
      row.append(why, go);
      why.focus();
    };
    const label = el("span", "feedback-label", "Was this right?");
    const good = document.createElement("button");
    good.type = "button";
    good.className = "feedback-up";
    good.append(icon("thumbUp"), el("span", "", "This was right"));
    good.addEventListener("click", () => say(true));
    const bad = document.createElement("button");
    bad.type = "button";
    bad.className = "feedback-down";
    bad.append(icon("thumbDown"), el("span", "", "Not right"));
    bad.addEventListener("click", () => say(false));
    row.append(label, good, bad);
    host.appendChild(row);
  }

  /** "Learned: ..." under the run that taught it. */
  function drawLearned(changes) {
    const host = activeBubbleAnswer ? activeBubbleAnswer.parentElement : null;
    if (!host || !changes || !changes.length) return;
    const note = document.createElement("div");
    note.className = "memory-note";
    const label = document.createElement("span");
    const text = changes.slice(0, 2).join("; ");
    label.textContent = `Learned ${text.length > 90 ? `${text.slice(0, 89)}…` : text}${changes.length > 2 ? ` and ${changes.length - 2} more` : ""}`;
    label.title = changes.join("\n");
    const view = document.createElement("button");
    view.type = "button";
    view.textContent = "View";
    view.addEventListener("click", openMemoryModal);
    note.append(label, view);
    host.appendChild(note);
  }

  /** Which of the user's details and notes this run used, under its answer. */
  function drawUsed(used) {
    const host = activeBubbleAnswer ? activeBubbleAnswer.parentElement : null;
    if (!host || !used || (!(used.details || []).length && !used.notes)) return;
    const row = document.createElement("div");
    row.className = "used-chips";
    const label = document.createElement("span");
    label.textContent = "Used";
    row.appendChild(label);
    const chip = (text) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.addEventListener("click", openMemoryModal); row.appendChild(b); };
    for (const d of used.details || []) chip(`your ${String(d).toLowerCase()}`);
    // By kind, so the user can see why this run went as it did: a way of
    // doing it learned before, notes about the site, their own preferences.
    const k = used.kinds || {};
    const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
    if (Object.keys(k).length) {
      if (k.routine) chip(k.routine === 1 ? "how it did a request like this before" : `how it did ${k.routine} requests like this before`);
      if (k.site_note) chip(n(k.site_note, "note about this site", "notes about this site"));
      if (k.lesson) chip(n(k.lesson, "correction you made here", "corrections you made here"));
      if (k.preference) chip(n(k.preference, "of your preferences", "of your preferences"));
      if (k.context) chip(n(k.context, "thing it knows about you", "things it knows about you"));
    } else if (used.notes) chip(`${used.notes} thing${used.notes === 1 ? "" : "s"} it knows about you`);
    host.appendChild(row);
  }

  /** After a run: what the user may want kept, each item theirs to tick. */
  function drawOffer(entry) {
    const items = (entry.items || []).filter((i) => i.type === "field" || i.type === "entry");
    if (!items.length) return;
    const card = document.createElement("div");
    card.className = "message-bubble assistant confirmation-bubble save-offer";
    card.dataset.tone = "accent";
    const content = document.createElement("div");
    content.className = "bubble-content";
    const title = document.createElement("p");
    title.className = "confirm-title";
    title.textContent = "Keep these for next time?";
    cardHead(content, "bookmark", title);
    const list = document.createElement("div");
    list.className = "offer-items";
    const boxes = items.map((item) => {
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.type === "field";
      const text = document.createElement("span");
      text.textContent = item.type === "field" ? `${item.label}: ${item.value}${item.had ? ` (replaces ${item.had})` : ""}` : item.text;
      row.append(box, text);
      list.appendChild(row);
      return box;
    });
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "offer-save-btn primary-btn btn btn-primary";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      const chosen = items.filter((_, i) => boxes[i].checked);
      if (chosen.length) enginePost({ type: "memory_apply", items: chosen });
      title.textContent = chosen.length ? "Saved. You can change it under Memory." : "Nothing saved.";
      list.remove();
      actions.remove();
    });
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "offer-skip-btn secondary-btn btn btn-ghost";
    skip.textContent = "Not now";
    skip.addEventListener("click", () => removeCard(card));
    actions.append(save, skip);
    content.append(list, actions);
    card.appendChild(content);
    chatContainer.appendChild(card);
    scrollToBottom();
  }

  /** The Memory panel, drawn from the engine's store. */
  function renderKnown() {
    const store = engineMemory;
    const fieldsBox = document.getElementById("knownFields");
    if (!store || !fieldsBox || !KNOWN) return;
    const change = (c) => enginePost({ type: "memory_change", change: c });
    document.getElementById("knownPaused").checked = !!store.paused;
    // Do not redraw a field the user is typing in.
    if (!fieldsBox.contains(document.activeElement)) {
      fieldsBox.textContent = "";
      const fields = KNOWN.profileOf(store).fields;
      for (const [key, label] of KNOWN.FIELDS) {
        const wrap = document.createElement("label");
        wrap.textContent = label;
        const input = document.createElement("input");
        input.value = (fields[key] && fields[key].value) || "";
        input.dataset.key = key;
        input.addEventListener("change", () => change({ op: "field", key, value: input.value, source: "you_said" }));
        wrap.appendChild(input);
        fieldsBox.appendChild(wrap);
      }
    }
    const sourceText = { you_said: "You told it", you_confirmed: "You confirmed it", you_filled: "You typed it into a page", you_mentioned: "You mentioned it in a task", run: "Learned from a task that worked", correction: "Learned from your correction" };
    const fill = (id, entries, emptyText, sub, editable) => {
      const list = document.getElementById(id);
      list.textContent = "";
      if (!entries.length) { const e = document.createElement("li"); e.className = "memory-empty"; e.textContent = emptyText; list.appendChild(e); }
      for (const entry of entries) list.appendChild(memoryRow(entry.text, sub(entry), () => change({ op: "remove", id: entry.id }), editable && entry.status !== "retired" ? (text) => change({ op: "update", id: entry.id, text }) : null));
    };
    fill("knownPrefs", store.entries.filter((e) => e.kind === "preference" && e.status !== "retired"), "None yet. Tell it once, in any task: “I'm vegetarian”, “always show prices in SGD”.", (e) => `${e.scope === "global" ? "" : `${e.scope} · `}${sourceText[e.source] || ""}`, true);
    // About you: lasting facts from what the user said, newest first; one a
    // later fact replaced is shown as no longer true until it is let go.
    const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");
    const facts = store.entries.filter((e) => e.kind === "context").sort((a, b) => (a.status === "retired") - (b.status === "retired") || (b.lastSeen || b.created) - (a.lastSeen || a.created));
    fill("knownContext", facts, "Nothing yet. When you tell it where things are (“my team chat is on Slack”), it keeps what lasts.", (e) => e.status === "retired"
      ? `No longer true since ${day(e.validTo)}`
      : `${sourceText[e.source] || ""}${e.times > 1 ? ` · said in ${e.times} tasks` : ""}${e.lastSeen ? ` · last ${day(e.lastSeen)}` : ""}${e.quote ? ` · you said “${e.quote.length > 60 ? `${e.quote.slice(0, 59)}…` : e.quote}”` : ""}`, true);
    fill("knownSites", store.entries.filter((e) => e.kind !== "preference" && e.kind !== "context"), "Nothing yet. It writes these after tasks that worked.", (e) => `${e.scope} · ${sourceText[e.source] || ""}${e.helped || e.hurt ? ` · helped ${e.helped || 0}, misled ${e.hurt || 0}` : ""}`, true);
    const consents = document.getElementById("knownConsents");
    consents.textContent = "";
    const sites = Object.keys((store.consents && store.consents.fill) || {}).filter((site) => store.consents.fill[site]);
    if (!sites.length) { const e = document.createElement("li"); e.className = "memory-empty"; e.textContent = "None. It asks the first time it would fill your details on a site."; consents.appendChild(e); }
    for (const site of sites) consents.appendChild(memoryRow(site, "Fills your details without asking", () => change({ op: "consent", site, value: false })));
  }

  (function wireKnown() {
    const paused = document.getElementById("knownPaused");
    if (!paused) return;
    const change = (c) => enginePost({ type: "memory_change", change: c });
    paused.addEventListener("change", () => change({ op: "pause", value: paused.checked }));
    document.getElementById("knownAddForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("knownAddInput");
      const text = input.value.trim();
      if (!text) return;
      if (KNOWN && !KNOWN.isStorable(text)) { input.value = ""; input.placeholder = "That can't be kept (passwords, codes, card numbers)"; return; }
      change({ op: "add", entry: { kind: "preference", text, scope: "global", source: "you_said" } });
      input.value = "";
    });
    const contextForm = document.getElementById("knownContextForm");
    if (contextForm) contextForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("knownContextInput");
      const text = input.value.trim();
      if (!text) return;
      if (KNOWN && !KNOWN.isStorable(text)) { input.value = ""; input.placeholder = "That can't be kept (passwords, codes, card numbers)"; return; }
      change({ op: "add", entry: { kind: "context", text, scope: "global", source: "you_said" } });
      input.value = "";
    });
    document.getElementById("knownWipe").addEventListener("click", () => { if (confirm("Forget everything the assistant knows about you and your sites?")) change({ op: "wipe" }); });
    document.getElementById("knownExport").addEventListener("click", () => {
      if (!engineMemory) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(engineMemory, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "select-to-ai-memory.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    const file = document.getElementById("knownImportFile");
    document.getElementById("knownImport").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      f.text().then((text) => { try { const store = JSON.parse(text); if (store && store.v === 2) change({ op: "replace", store }); } catch (_e) { /* not a memory file */ } file.value = ""; });
    });
  })();

  function engineUsage() {
    if (!engineTrace) return;
    totalPromptTokens = engineTrace.tokens.prompt;
    totalCompletionTokens = engineTrace.tokens.completion;
    totalCostUSD = engineTrace.costUSD;
    updateCostDashboard();
  }

  /** What follows every update from the engine: the trace's facts on screen. */
  function afterTrace() {
    traceAt = Date.now();
    engineUsage();
    syncStepHosts();
    updateLiveSite();
    engineControls();
  }

  function onEngineMessage(m) {
    if (!m) return;
    if (m.type === "memory") {
      engineMemory = m.store;
      if (memoryModal && !memoryModal.hidden) renderKnown();
      return;
    }
    if (m.type === "snapshot") {
      // The whole conversation, as the engine holds it.
      chatContainer.querySelectorAll(".message-bubble, .chat-note, .card-leaving").forEach((b) => b.remove());
      activeRun = null;
      engineCards = new Map();
      engineWait = null;
      subs.clear();
      workedMs = 0;
      const turns = m.turns || [];
      welcomeScreen.style.display = turns.length || m.run ? "none" : "flex";
      for (const t of turns) { if (t.role === "user") appendSimpleUserBubble(t.text); else appendSimpleAssistantBubble(t.text); }
      engineRunId = m.run ? m.run.id : "";
      engineStatus = m.run ? m.run.status : "";
      engineTrace = m.run ? m.run.trace : null;
      engineJournal = m.run ? m.run.journal.slice() : [];
      if (m.run) {
        appendSimpleUserBubble(m.run.task, m.run.selection);
        openRunBubble();
        for (const entry of m.run.journal) drawEntry(entry, false);
        if (m.run.status === "waiting") engineWait = m.run.wait;
        else if (!(engineWait && engineWait.sub)) engineWait = null;
      }
      afterTrace();
      return;
    }
    if (m.type === "handoff_live") { askAboutHandoff(m); return; }
    if (m.type === "handoff_queued") { appendSimpleAssistantBubble(`Queued: "${String(m.text).slice(0, 200).replace(/[*_`#>[\]]/g, "")}" starts when the task in progress ends.`); return; }
    if (m.type === "started") {
      engineRunId = m.runId;
      engineStatus = "running";
      engineTrace = null;
      engineJournal = [];
      engineWait = null;
      subs.clear();
      workedMs = 0;
      liveUrl = "";
      welcomeScreen.style.display = "none";
      appendSimpleUserBubble(m.task, m.selection);
      openRunBubble();
      afterTrace();
      return;
    }
    if (m.runId !== engineRunId) return;
    if (m.type === "learned") { drawLearned(m.changes); return; }
    if (m.type === "stream") { onStream(m.text); return; }
    if (m.type === "entries") {
      engineStatus = m.status;
      engineTrace = m.trace;
      engineJournal.push(...m.entries);
      for (const entry of m.entries) drawEntry(entry, true);
      if (engineStatus !== "waiting" && !(engineWait && engineWait.sub)) engineWait = null;
      afterTrace();
      if (engineStatus !== "running") taskInput.focus();
    }
  }

  function exportEngineLog() {
    if (!engineTrace) return;
    const md = globalThis.SELECT_TO_AI_RUNLOG.toMarkdown({ trace: engineTrace, journal: engineJournal });
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `task_log_${Date.now()}.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }


  /** The provider's name as the user knows it. */
  function friendlyProviderName(provider) {
    return {
      openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini",
      groq: "Groq", deepseek: "DeepSeek", mistral: "Mistral", xai: "xAI", together: "Together AI",
      opencode: "OpenCode", cerebras: "Cerebras", chatgpt: "ChatGPT", custom: "Your server",
    }[provider] || "The AI provider";
  }

  // agent.html?task=...&autostart=1 (the quick box, the benchmarks) pre-fills
  // the task and, when asked, starts it at once. Risky actions still stop at the
  // in-conversation authorization gate, so autostart never skips a decision.
  // Address bar handoff: agent.html?handoff=<id> names a request kept once
  // in session storage (omnibox.js). It is taken and removed, so the same
  // panel opened again later starts nothing.
  // A task handed in the address is taken once: the address loses it at
  // once, so reloading the page or reopening it from history starts nothing.
  function forgetHandedTask() {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      for (const k of ["task", "autostart", "handoff"]) if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
      if (changed) history.replaceState(history.state, "", url.pathname + (url.search || "") + url.hash);
    } catch (_) { /* the address stays as it was */ }
  }

  (function consumeHandoff() {
    const id = new URLSearchParams(window.location.search).get("handoff");
    const OMNI = window.SELECT_TO_AI_OMNIBOX;
    if (!id || !OMNI || !chrome.storage || !chrome.storage.session) return;
    forgetHandedTask();
    OMNI.takeHandoff(chrome.storage.session, id).then((task) => {
      if (!task) return;
      taskInput.value = task.slice(0, 2000);
      taskInput.style.height = "auto";
      taskInput.style.height = taskInput.scrollHeight + "px";
      // A new task, whatever the window is doing: the engine decides with the user.
      startAgent(true);
    }).catch((e) => console.warn("Address bar handoff failed:", e));
  })();

  (function consumeHandedTask() {
    try {
      const params = new URLSearchParams(window.location.search);
      const handedTask = (params.get("task") || "").trim();
      forgetHandedTask();
      if (!handedTask) return;
      taskInput.value = handedTask.slice(0, 2000);
      taskInput.style.height = "auto";
      taskInput.style.height = taskInput.scrollHeight + "px";
      if (params.get("autostart") === "1" && !isRunning) {
        startAgent();
      } else {
        taskInput.focus();
      }
    } catch (e) {
      console.warn("Handed task failed:", e);
    }
  })();
})();
