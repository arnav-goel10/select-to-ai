/**
 * Select to AI - the driver: runs live here, in the service worker.
 *
 * core/run.js decides what a run does next; this file does it. It looks at
 * the page, calls the model, carries out actions, and saves the run after
 * every step, so a run does not depend on the side panel being open or on
 * the worker staying awake. The panel is a view: it connects over a port,
 * is sent the run so far, and then each new entry as it happens.
 *
 * One conversation per browser window. Chrome may stop this worker at any
 * moment; on waking, a run that was in the middle of a step looks at the
 * page again and goes on, and one that was waiting for the user is still
 * waiting.
 */
(function initEngine(root) {
  "use strict";

  const RUN = root.SELECT_TO_AI_RUN;
  const LLM = root.SELECT_TO_AI_LLM;
  const TOOLS = root.SELECT_TO_AI_TOOLS;
  const PAGE = root.SELECT_TO_AI_PAGE;
  const STEP = root.SELECT_TO_AI_STEP;
  const POLICY = root.SELECT_TO_AI_POLICY;
  // How long a site's own check of the browser is given to pass by itself.
  const CHECK_WAITS = 4;
  const CHECK_WAIT_MS = 3000;
  const CONTEXT = root.SELECT_TO_AI_CONTEXT;
  const KNOWN = root.SELECT_TO_AI_KNOWN;
  const LEARN = root.SELECT_TO_AI_LEARN;
  const VIEW = root.SELECT_TO_AI_VIEW;
  const INJECT = root.SELECT_TO_AI_INJECT;
  const PDF = root.SELECT_TO_AI_PDF;
  // Recipes (recipes/service.js): a run's page actions are recorded so a
  // successful run can be saved and repeated. Recording only watches.
  const RECIPES = root.SELECT_TO_AI_RECIPES || null;
  // Desktop notifications are optional (core/grants.js): without the grant
  // chrome.notifications does not exist, and every notice is skipped.
  const GRANTS = root.SELECT_TO_AI_GRANTS || null;
  const notice = (id, options) => {
    if (GRANTS) return GRANTS.notify(id, options);
    const n = typeof chrome !== "undefined" && chrome.notifications;
    try { return n ? (typeof id === "string" ? n.create(id, options) : n.create(id)) : Promise.resolve(null); } catch (_e) { return Promise.resolve(null); }
  };
  const unnotice = (id) => {
    if (GRANTS) return GRANTS.clearNotice(id);
    const n = typeof chrome !== "undefined" && chrome.notifications;
    try { return n ? n.clear(id) : Promise.resolve(false); } catch (_e) { return Promise.resolve(false); }
  };

  /**
   * What the user sees of a run (core/view.js): home, the agent page's tab
   * that drives it (null from the side panel); tabs, every tab the run
   * started from or worked in; touched, whether the user clicked, typed or
   * scrolled on a page the agent brought them to; watched, the tabs the
   * agent's bar script is on; kept, the tab where the bar stays after the
   * run, saying how it ended.
   */
  const newView = (home) => ({ home: home === undefined ? null : home, tabs: [], touched: false, watched: [], kept: null });

  const KEY = (windowId) => `agentSession:${windowId}`;
  const sessions = new Map(); // windowId -> session
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const quiet = (p) => Promise.resolve(p).catch(() => undefined);

  // ---------------------------------------------------------------- sessions

  function sessionFor(windowId) {
    if (!sessions.has(windowId)) {
      sessions.set(windowId, { windowId, turns: [], run: null, page: null, extras: {}, settings: {}, ports: new Set(), chain: Promise.resolve(), token: 0, abort: null, sent: 0, runners: new Map(), attending: new Map(), view: newView(null) });
    }
    return sessions.get(windowId);
  }

  // ---------------------------------------------------------------- sub-tasks
  // A sub-task (core/run.js, delegate) is driven by the same code as the run
  // that handed it out: a runner stands in for the session, with the
  // sub-task's run, its own tab, page, model call and stop token, and the
  // session's settings and connection. What it reports goes back through
  // the session's queue as a "child" event, so the run sees every event of
  // every sub-task in order.

  /** The session itself, for a runner or a session. */
  const rootOf = (s) => s.parent || s;

  function runnerFor(session, id) {
    let r = session.runners.get(id);
    if (r) return r;
    r = {
      parent: session, child: id, windowId: session.windowId, background: true,
      page: null, extras: {}, frames: [], token: 0, abort: null, calling: false,
      get run() { const c = session.run && (session.run.children || []).find((x) => x.id === id); return c ? c.run : null; },
      get items() { return session.items; },
      get cfg() { return session.cfg; },
      get settings() { return session.settings; },
      get ports() { return session.ports; },
    };
    session.runners.set(id, r);
    return r;
  }

  /** An event from the work of a session or of one of its runners. */
  function deliver(target, event) {
    if (!target.parent) return enqueue(target, event);
    const { token, ...inner } = event;
    return enqueue(target.parent, { type: "child", child: target.child, event: inner, ctoken: token });
  }

  /** Every wait of a run that is open now: its own and its sub-tasks'. */
  function waitsOf(run) {
    if (!run) return [];
    const out = run.status === "waiting" && run.wait ? [run.wait] : [];
    for (const c of run.children || []) if (c.state === "running" && c.run.status === "waiting" && c.run.wait) out.push(c.run.wait);
    return out;
  }

  /** The window a run's sub-task tabs open in: the one its own tab is in. */
  async function windowOf(session) {
    const tab = session.run && session.run.tabId !== null && session.run.tabId !== undefined ? await quiet(chrome.tabs.get(session.run.tabId)) : null;
    return tab ? { windowId: tab.windowId, index: tab.index } : { windowId: session.windowId > 0 ? session.windowId : undefined, index: undefined };
  }

  /**
   * Opens a sub-task's tab: in the background, beside the run's own tab, so
   * the user's tab keeps the focus. It starts empty; the sub-task opens its
   * address as its first action, under the usual rules.
   */
  async function spawn(session, id) {
    const r = runnerFor(session, id);
    // A tab opened for this sub-task before the worker was stopped, whose
    // opening the run never heard of, is used rather than left open.
    const earlier = session.spawned && session.spawned[id];
    let tab = earlier !== undefined ? await quiet(chrome.tabs.get(earlier)) : null;
    let why = "";
    if (!tab) {
      const at = await windowOf(session);
      const ahead = [...session.runners.values()].filter((x) => x.tabId).length;
      tab = await chrome.tabs.create({ url: "about:blank", active: false, ...(at.windowId !== undefined ? { windowId: at.windowId } : {}), ...(at.index !== undefined ? { index: at.index + 1 + ahead } : {}) }).catch((e) => { why = String((e && e.message) || e); return null; });
    }
    if (tab) {
      r.tabId = tab.id;
      session.spawned = { ...(session.spawned || {}), [id]: tab.id };
      await save(session);
    }
    deliver(r, { type: "spawned", tabId: tab ? tab.id : null, ...(why ? { error: why } : {}), token: r.token });
  }

  /**
   * A sub-task ended: its page is let go, and its tab is closed unless the
   * user is looking at it. A tab that opened after its sub-task was
   * stopped is closed too.
   */
  async function childFinished(r, fx) {
    r.token += 1;
    if (r.abort) r.abort.abort();
    const session = r.parent;
    session.runners.delete(r.child);
    if (session.spawned) delete session.spawned[r.child];
    const run = r.run;
    const tabs = new Set([fx && fx.tabId, r.tabId, ...(run ? [run.tabId, ...(run.openedTabs || [])] : [])].filter((t) => t !== null && t !== undefined));
    for (const id of tabs) touch(r, id);
    release(r);
    const front = await quiet(chrome.windows.getLastFocused());
    for (const id of tabs) {
      const tab = await quiet(chrome.tabs.get(id));
      if (!tab) continue;
      const watched = tab.active && front && front.focused && tab.windowId === front.id;
      if (!watched) quiet(chrome.tabs.remove(id));
    }
  }

  async function save(session) {
    const run = session.run;
    // The tabs this run and its sub-tasks used, so a worker that wakes up again can let them go when the run ends.
    const touched = [...new Set([...touchedBy(session), ...[...session.runners.values()].flatMap((r) => [...touchedBy(r)])])];
    await quiet(chrome.storage.session.set({ [KEY(session.windowId)]: { turns: session.turns.slice(-12), run: run ? RUN.toStored(run) : null, touched, spawned: session.spawned || {}, view: session.view || newView(null), extras: { selection: session.extras.selection || "", selectionPlace: session.extras.selectionPlace || null, selectionCaptured: !!session.extras.selectionCaptured, openTabPages: session.extras.openTabPages || [] } } }));
  }

  // Waits whose blocker the page was seen to show (agentContentScript.js
  // waitForUser). Kept in session storage, so a worker that wakes up again
  // still knows a sign-in page it watched was there.
  const SEEN_KEY = "agentSeenWaits";
  let seenWaits = new Set();
  function markSeen(waitId) {
    if (!waitId || seenWaits.has(waitId)) return;
    seenWaits.add(waitId);
    while (seenWaits.size > 50) seenWaits.delete(seenWaits.values().next().value);
    quiet(chrome.storage.session.set({ [SEEN_KEY]: [...seenWaits] }));
  }

  /** Brings back what was saved before the worker was stopped. */
  let restored = null;
  function restore() {
    if (restored) return restored;
    restored = (async () => {
      const all = (await quiet(chrome.storage.session.get(null))) || {};
      if (Array.isArray(all[SEEN_KEY])) seenWaits = new Set([...all[SEEN_KEY], ...seenWaits]);
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith("agentSession:") || !v) continue;
        const windowId = Number(k.slice("agentSession:".length));
        if (sessions.has(windowId)) continue;
        const session = sessionFor(windowId);
        session.turns = v.turns || [];
        session.run = v.run || null;
        session.extras = v.extras || {};
        for (const id of v.touched || []) touch(session, id);
        session.spawned = v.spawned || {};
        session.view = { ...newView(null), ...(v.view || {}) };
        session.sent = session.run ? session.run.journal.length : 0;
        if (session.run && (session.run.status === "running" || session.run.status === "waiting")) {
          await loadSettings(session);
          enqueue(session, { type: "resume" });
        }
      }
      keepAwake();
    })();
    return restored;
  }

  // ------------------------------------------------------------------ memory
  // What the assistant knows about its user (core/memory.js) is kept in
  // local storage, encrypted with a key that never leaves this browser and
  // cannot be exported. Only this worker reads or writes it; the panel asks
  // for it over its port.

  const MEMORY_KEY = "agentKnown";
  let memory = null;

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
    const read = () => new Promise((resolve, reject) => { const r = db.transaction("keys").objectStore("keys").get("memory"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    let key = await read();
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await new Promise((resolve, reject) => { const t = db.transaction("keys", "readwrite"); t.objectStore("keys").put(key, "memory"); t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    }
    return key;
  }
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  // Where versions before 4 kept facts about the user and site how-tos.
  const EARLIER_KEYS = Object.freeze({ user: "agentUserMemory", skills: "agentSkills" });

  async function loadMemory() {
    if (memory) return memory;
    const items = (await quiet(chrome.storage.local.get([MEMORY_KEY, EARLIER_KEYS.user, EARLIER_KEYS.skills]))) || {};
    const saved = items[MEMORY_KEY];
    if (saved && saved.data) {
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(saved.iv) }, await cryptoKey(), unb64(saved.data));
        memory = { ...KNOWN.empty(), ...JSON.parse(new TextDecoder().decode(plain)) };
        return memory;
      } catch (e) {
        // The key is gone (the browser's site data was cleared): what was
        // saved cannot be read again, and a fresh store takes its place.
        console.warn("Select to AI: saved memory could not be read", e);
      }
    }
    // First run of this version: carry over what earlier versions kept.
    memory = KNOWN.migrate({ user: items[EARLIER_KEYS.user] || [], skills: items[EARLIER_KEYS.skills] || [] }, Date.now());
    if (memory.entries.length) await saveMemory();
    return memory;
  }

  async function saveMemory() {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(JSON.stringify(memory)));
    await quiet(chrome.storage.local.set({ [MEMORY_KEY]: { iv: b64(iv), data: b64(data) } }));
    for (const s of sessions.values()) post(s, { type: "memory", store: memory });
  }

  let memoryChain = Promise.resolve();

  /** One change to the store, from the run or from the panel, serialized so concurrent writes never clobber each other. */
  function changeMemory(change) {
    const step = memoryChain.then(async () => {
      await loadMemory();
      const now = Date.now();
      let result = null;
      if (change.op === "add") { result = KNOWN.addEntry(memory, change.entry, now); memory = result.store; }
      else if (change.op === "field") { result = KNOWN.setField(memory, change.key, change.value, change.source || "you_said", now); memory = result.store; }
      else if (change.op === "remove") memory = KNOWN.removeEntry(memory, change.id);
      else if (change.op === "update") memory = KNOWN.updateEntry(memory, change.id, change.text, now);
      else if (change.op === "consent") memory = { ...memory, consents: { ...memory.consents, fill: { ...memory.consents.fill, [change.site]: change.value !== false } } };
      else if (change.op === "pause") memory = { ...memory, paused: !!change.value };
      else if (change.op === "wipe") memory = KNOWN.empty();
      else if (change.op === "replace" && change.store && change.store.v === 2) memory = KNOWN.sanitizeStore ? KNOWN.sanitizeStore(change.store, now) : { ...KNOWN.empty(), ...change.store };
      else if (change.op === "mark") memory = KNOWN.mark(memory, change.ids, change.how, now);
      else if (change.op === "learn_routine" && change.routine && change.scope) {
        result = KNOWN.learnRoutine(memory, change.routine, change.scope, now);
        memory = result.store;
      }
      else if (change.op === "forget_run") { result = KNOWN.forgetRun(memory, change.runId); memory = result.store; }
      else if (change.op === "learn_apply" && change.run && change.flags) {
        result = LEARN.applyLearned(memory, change.run, change.reply, change.site, change.flags, now);
        memory = result.store;
      }
      else if (change.op === "learn_context" && change.ops && change.gate) {
        result = LEARN.applyContext(memory, change.ops, change.gate, now);
        memory = result.store;
      }
      await saveMemory();
      return result;
    });
    memoryChain = step.catch((e) => console.error("Select to AI memory:", e));
    return step;
  }

  // ---------------------------------------------------------------- settings

  async function storedItems() {
    const sync = (await quiet(chrome.storage.sync.get(null))) || {};
    const local = (await quiet(chrome.storage.local.get(null))) || {};
    return { ...sync, ...local };
  }

  let debuggerDisabled = false;
  async function loadSettings(session) {
    const items = await storedItems();
    debuggerDisabled = items.agentDebuggerMode === "off";
    session.items = items;
    session.cfg = LLM.settingsFrom(items, Date.now());
    // What this model is shown and asked for in one step (defaults.js).
    session.profile = root.SELECT_TO_AI_DEFAULTS.modelProfile(session.cfg.model);
    // The helper's steps are built for the helper, from its own profile.
    session.helperProfile = session.cfg.helperModel ? root.SELECT_TO_AI_DEFAULTS.modelProfile(session.cfg.helperModel) : null;
    session.settings = {
      riskConfirmation: items.agentRiskConfirmation !== false,
      allowlist: items.agentDomainAllowlist || "",
      // ChatGPT's models take images; a model that does not is caught by its refusal (no_vision).
      vision: session.cfg.provider === "chatgpt" || root.SELECT_TO_AI_DEFAULTS.isVisionModel(session.cfg.model),
      costBudget: session.cfg.costBudget,
    };
    session.extras = session.extras || {};
    session.extras.settings = { extraInstructions: String(items.agentExtraInstructions || "").slice(0, 2000) };
    await loadMemory();
    return items;
  }

  // -------------------------------------------------------------------- view

  function post(session, message) {
    for (const port of session.ports) {
      try { port.postMessage(message); } catch (_e) { session.ports.delete(port); }
    }
  }

  /** Sends the view every journal entry it has not had yet. */
  function publish(session) {
    const run = session.run;
    if (!run) return;
    const fresh = run.journal.slice(session.sent);
    session.sent = run.journal.length;
    if (fresh.length) post(session, { type: "entries", runId: run.id, entries: fresh, trace: RUN.trace(run), status: run.status });
    if (fresh.length) syncBar(session);
  }

  /** The conversation before the run in hand, and that run. */
  const snapshot = (session) => ({ type: "snapshot", turns: session.run ? session.turns.slice(0, session.run.outcome && session.run.outcome.text ? -2 : -1) : session.turns, run: session.run ? { id: session.run.id, task: session.run.task, selection: session.extras && session.extras.selectionCaptured ? session.extras.selectionPlace : null, status: session.run.status, journal: session.run.journal, wait: session.run.wait, trace: RUN.trace(session.run) } : null });

  // ------------------------------------------------------------------- loop

  /** Events for a session are handled one at a time, in order. */
  function enqueue(session, event) {
    session.chain = session.chain.then(() => handle(session, event)).catch((e) => console.error("Select to AI engine:", e));
    return session.chain;
  }

  async function handle(session, event) {
    const run = session.run;
    if (!run) return;
    if (event.token !== undefined && event.token !== session.token) return; // from a step that was stopped
    // From a sub-task's step that was stopped, or from a sub-task now gone.
    if (event.type === "child" && event.ctoken !== undefined) {
      const r = session.runners.get(event.child);
      if (event.event && event.event.type === "spawned") { if (r && r.token !== event.ctoken) return; }
      else if (!r || r.token !== event.ctoken) return;
    }
    const env = {
      now: Date.now(), page: session.page, settings: session.settings, extras: session.extras, memory,
      childEnv: (id) => { const r = session.runners.get(id); return r ? { page: r.page, extras: r.extras } : { page: null, extras: {} }; },
    };
    const waiting = waitsOf(run);
    const effects = RUN.advance(run, event, env);
    workedIn(session, run.tabId);
    const open = new Set(waitsOf(run).map((w) => w.id));
    for (const w of waiting) if (!open.has(w.id)) endAttention(session, w, event.type === "child" && event.event ? event.event.type : event.type);
    publish(session);
    await save(session);
    for (const fx of effects) perform(session, fx);
  }

  function perform(session, fx) {
    // A sub-task's work is done by its runner, the same way.
    if (fx.type === "spawn") { spawn(session, fx.child).catch((e) => console.error("Select to AI sub-task:", e)); return; }
    if (fx.type === "child_fx") {
      const r = runnerFor(session, fx.child);
      if (fx.fx.type === "end") { childFinished(r, fx.fx).catch((e) => console.error("Select to AI sub-task:", e)); return; }
      perform(r, fx.fx);
      return;
    }
    const token = session.token;
    // How long each kind of work takes is kept with the run, so a slow task
    // can be read: the model, the page, or the actions.
    const started = Date.now();
    const timing = () => { const run = session.run; if (!run) return null; if (!run.timing) run.timing = { observe: 0, model: 0, act: 0, settle: 0 }; if (run.timing.settle === undefined) run.timing.settle = 0; return run.timing; };
    const timed = (kind) => { const t = timing(); if (t) t[kind] += Date.now() - started; };
    // Of the time acting, how much was waiting for the page to finish what the action started.
    const settledFor = (result) => { const t = timing(); if (t && result && result.settleMs) t.settle += result.settleMs; return result; };
    // How many pointer actions used the real pointer, and how many events made by script.
    const pointed = (result) => { const t = timing(); if (t && result && (result.pointer === "real" || result.pointer === "synthetic")) { t.pointer = t.pointer || { real: 0, synthetic: 0 }; t.pointer[result.pointer] += 1; } return result; };
    const back = (event) => deliver(session, { ...event, token });
    if (fx.type === "observe") observe(session, fx, back).catch((e) => back({ type: "model_failed", kind: "page", message: `The page could not be read: ${e && e.message ? e.message : e}` })).finally(() => timed("observe"));
    else if (fx.type === "model") model(session, fx, back).finally(() => timed("model"));
    else if (fx.type === "act") toFront(session, fx.action).then(() => (RECIPES ? RECIPES.around(session, fx.action, () => act(session, fx.action, fx.keys === true)) : act(session, fx.action, fx.keys === true))).then(settledFor).then(pointed).then((result) => lookAgain(session, result, back)).then((result) => back({ type: "acted", result }), (e) => back({ type: "acted", result: { ok: false, message: String((e && e.message) || e) } })).finally(() => timed("act"));
    else if (fx.type === "attention") attention(rootOf(session), fx.wait, !!fx.again).catch((e) => console.error("Select to AI attention:", e));
    else if (fx.type === "memory") changeMemory(fx).catch((e) => console.error("Select to AI memory:", e));
    else if (fx.type === "end") finished(session);
  }

  // ---------------------------------------------------------------- the page

  const isWeb = (url) => /^https?:/.test(url || "");

  /**
   * Runs the extension's script in a page or its frames, waiting for the
   * document's end for at most two seconds (core/inject.js says why).
   * Throws {late: true} when the page does not take it at all.
   */
  const inject = (target, what) => INJECT.inject(chrome, target, what);
  // To the page itself (frame 0), or to one of its frames by number.
  const send = (tabId, message, frameId) => chrome.tabs.sendMessage(tabId, frameId ? { ...message, inFrame: true } : message, { frameId: frameId || 0 }).catch(() => null);

  // Controls inside a frame are numbered after the page's own: frame 1's
  // control 12 is [100012].
  const FRAME_BASE = 100000;
  const MAX_FRAMES = 3;
  const hellos = new Map(); // "tabId:token" -> frameId
  const inFrame = (session, id) => {
    const k = Math.floor(Number(id) / FRAME_BASE);
    const frame = k > 0 && session.frames ? session.frames[k] : null;
    return frame ? { k, frameId: frame.frameId, id: Number(id) % FRAME_BASE } : { k: 0, frameId: 0, id };
  };

  /** Runs inside each frame of a page: answers a token from the page with "this is me". */
  function announceFrame() {
    if (window === window.top || window.selectToAiFrameListens) return;
    window.selectToAiFrameListens = true;
    window.addEventListener("message", (e) => {
      const token = e && e.data && e.data.selectToAiFrame;
      if (typeof token === "string" && token.length < 80) {
        try { chrome.runtime.sendMessage({ action: "agentFrameHello", token }); } catch (_e) { /* the extension was reloaded */ }
      }
    });
  }

  /**
   * Reads the frames that are part of what the user sees: a notice another
   * site draws on top of the page, or a frame that fills much of the
   * window. Their controls join the page's listing under the frame's name,
   * and can be acted on like any other. A frame the extension has no access
   * to, or that does not answer, is left as it was: said to be there, and
   * not readable.
   */
  async function readFrames(session, tab, page) {
    // Every frame gets a few lines that say which frame it is when the page
    // hands it a token; nothing else goes into a frame that is not read.
    await quiet(inject({ tabId: tab.id, allFrames: true }, { func: announceFrame }));
    const offered = (await send(tab.id, { action: "frameTokens" })) || {};
    const list = (offered.frames || []).slice(0, MAX_FRAMES);
    const key = (f) => `${tab.id}:${f.token}`;
    for (let waited = 0; waited < 600 && list.some((f) => !hellos.has(key(f))); waited += 50) await sleep(50);
    let k = 0;
    for (const f of list) {
      const frameId = hellos.get(key(f));
      hellos.delete(key(f));
      if (frameId === undefined || !frameId) continue;
      await quiet(inject({ tabId: tab.id, frameIds: [frameId] }, { files: ["agentTools.js", "agentContentScript.js"] }));
      const got = await send(tab.id, { action: "scan", limit: 120, task: session.run.task, whole: true }, frameId);
      if (!got || !Array.isArray(got.elements) || !got.elements.length) continue;
      k += 1;
      session.frames[k] = { frameId, label: f.label, token: f.token };
      const name = `frame${f.label ? ` "${f.label}"` : ""}`;
      // Where the frame is drawn, so its controls' places are given in the
      // page's own pixels, as the page's own controls' are.
      const box = await send(tab.id, { action: "frameBox", token: f.token });
      const placed = framePlaces(box, got);
      if (box && box.found) for (const area of page.frameAreas || []) if (area.x === box.area.x && area.y === box.area.y && area.w === box.area.w && area.h === box.area.h) area.read = true;
      joinFrame(page, got, k, f, name, placed);
      const text = String(got.innerText || "").trim();
      if (text) page.innerText = `${page.innerText || ""}\n\n[In the ${name} on this page]\n${text.slice(0, 3000)}`;
      if ((got.unseen || []).length) page.unseen = [...(page.unseen || []), ...got.unseen].slice(0, 8);
      for (const b of got.blockers || []) (page.blockers = page.blockers || []).push({ ...b, whole: false });
      if (f.onTop) for (const o of page.overlays || []) if (o.framed && !o.controls) { o.framed = false; o.controls = got.elements.length; break; }
    }
  }

  /**
   * Adds frame k's controls and forms to the page's listing. Both are
   * numbered after the page's own: frame 1's control 12 is [100012], and
   * its form 0 is form 100000, since form numbers are counted per document
   * and a frame's form 0 is not the page's. A control is judged against
   * the form it is in (agentTools.js contentRisk, policy.js).
   */
  function joinFrame(page, got, k, f, name, placed) {
    const at = placed || (() => ({}));
    for (const el of got.elements || []) {
      page.elements.push({
        ...el, ...at(el), id: k * FRAME_BASE + el.id, frame: k, position: f.position || el.position,
        formId: el.formId !== undefined && el.formId !== null ? k * FRAME_BASE + el.formId : undefined,
        ...(f.onTop ? { onTop: true } : {}),
        groupKey: `f${k}:${el.groupKey || 0}`, groupKind: el.groupKind || "frame", group: el.group ? `${name} > ${el.group}` : name,
      });
    }
    if (Array.isArray(got.forms) && got.forms.length) {
      page.forms = [...(page.forms || []), ...got.forms.map((form) => ({ ...form, id: k * FRAME_BASE + form.id, frame: k }))];
    }
    return page;
  }

  /**
   * A frame control's box (in the frame's window) and middle (in the
   * frame's page), placed in the main page: its box in the main window, its
   * middle in the main page's pixels.
   */
  function framePlaces(box, got) {
    if (!box || !box.found) return () => ({});
    const scale = got.viewportWidth > 0 && box.width > 0 ? box.width / got.viewportWidth : 1;
    const round = (v) => Math.round(v);
    return (el) => ({
      ...(el.rect ? { rect: { x: round(box.left + el.rect.x * scale), y: round(box.top + el.rect.y * scale), w: round(el.rect.w * scale), h: round(el.rect.h * scale) } } : {}),
      ...(el.at ? { at: { x: round(box.left + (el.at.x - (got.scrollX || 0)) * scale + box.scrollX), y: round(box.top + (el.at.y - (got.scrollY || 0)) * scale + box.scrollY) } } : {}),
    });
  }

  /** Starts the count of a page's own requests, in the page's world. It runs at once: there is nothing in the page it waits for. */
  const countRequests = (tabId, name) => (INJECT.NET_EVENT.test(String(name || "")) ? INJECT.injectNow(chrome, { tabId }, { world: "MAIN", func: INJECT.netShim, args: [name] }) : Promise.resolve(null));

  /** A page that cannot be read still has an address and a title, and can be left. */
  const unreadable = (tab, why) => ({ url: tab.url || "", title: tab.title || "", elements: [], innerText: `[${why}]`, visibleText: "", protectedPage: true });

  async function scan(session, tab, back) {
    const run = session.run;
    touch(session, tab.id);
    if (!isWeb(tab.url) && run.fromNothing && !run.fromNothing.left) return unreadable(tab, "No site is open in this tab yet.");
    if (!isWeb(tab.url)) return unreadable(tab, "This tab is a browser page that extensions cannot read.");
    // "Only use these sites" holds for every page the run lands on, however
    // it got there (a link, a tab, the start tab): nothing off the list is read.
    const allowlist = (session.settings && session.settings.allowlist) || "";
    if (allowlist && !root.SELECT_TO_AI_SECURITY.isUrlAllowedByDomains(tab.url, allowlist)) return unreadable(tab, "This page is outside the sites you allow the agent to use.");
    // Every control on the page, wherever it is; core/observe.js fits the
    // listing to the model's budget.
    // (agentObserve: "near" keeps the older listing of what is near the
    // screen, for measuring one against the other.)
    const near = session.items && session.items.agentObserve === "near";
    const request = near ? { action: "scan", limit: 60, task: run.task } : { action: "scan", limit: 500, task: run.task, whole: true };
    let res = await send(tab.id, request);
    if (!res) {
      try {
        await inject({ tabId: tab.id }, { files: ["agentTools.js", "agentContentScript.js"] });
      } catch (e) {
        if (/error page/i.test(String(e && e.message))) return unreadable(tab, "This page failed to load: the browser is showing an error page.");
        if (e && e.late) return unreadable(tab, "This page could not be read yet: it is still loading.");
        let origin = "";
        try { origin = new URL(tab.url).origin; } catch (_e) { /* no address */ }
        const granted = origin ? await quiet(chrome.permissions.contains({ origins: [`${origin}/*`] })) : false;
        if (granted) return unreadable(tab, "This page failed to load, or does not let extensions in.");
        // The user already said no to this site in this run: the run goes on without it.
        if (origin && (run.declinedSites || []).includes(origin)) return unreadable(tab, "The user did not let the agent onto this site.");
        // The user has not let the agent onto this site yet: theirs to decide.
        back({ type: "blocked", kind: "site_access", question: `Let the agent use ${new URL(tab.url).hostname}?`, detail: [tab.url] });
        return null;
      }
      await send(tab.id, { action: "waitForElement", selector: "body", timeout: 3000 });
      res = await send(tab.id, request);
      if (!res) return unreadable(tab, "This page could not be read yet: it may still be loading.");
    }
    // Things to press that only a script listener marks join the listing.
    // (agentPressables: "off" leaves them out, for measuring with and without.)
    if (!near && !(session.items && session.items.agentPressables === "off") && await pressables(tab.id)) res = (await send(tab.id, request)) || res;
    if (!Array.isArray(res.elements)) res.elements = [];
    // With no debugger connection to show the tab's requests, the page's own
    // world is asked to count them (core/inject.js), so the wait after an
    // action can tell a page still waiting for an answer from a finished one.
    if (!res.netView && !nets.has(tab.id)) countRequests(tab.id, res.netEvent);
    session.frames = [];
    if (!near && res.frames) { try { await readFrames(session, tab, res); } catch (_e) { session.frames = []; } }
    if (PDF && PDF.isPdfPage(res)) return PDF.withPdfText(res, await pdfTextOf(tab, res.url || tab.url));
    return res;
  }

  // The text of the PDFs read lately, by tab and address: a run looks at its
  // page every step, and the file is read once.
  const pdfTexts = new Map();
  const PDF_MS = 25000;

  /**
   * The text of the PDF a tab shows. The browser's viewer gives an extension
   * no text, so the file is fetched again from inside the tab and read there
   * (pdfText.js): the same address, from the browser's cache, with the tab's
   * own cookies, and no permission beyond the site access the scan used.
   */
  async function pdfTextOf(tab, url) {
    const key = `${tab.id} ${url}`;
    if (pdfTexts.has(key)) return pdfTexts.get(key);
    await INJECT.injectNow(chrome, { tabId: tab.id }, { files: ["pdfText.js"] });
    const ran = await INJECT.injectNow(chrome, { tabId: tab.id }, { func: () => (self.SELECT_TO_AI_PDF ? self.SELECT_TO_AI_PDF.readHere() : null) }, { injectMs: PDF_MS });
    const got = (ran && ran[0] && ran[0].result) || null;
    // A file that was read, or that cannot be (a password), is not fetched again; a failed fetch is tried at the next look.
    if (got && (!got.error || got.locked)) {
      pdfTexts.set(key, got);
      while (pdfTexts.size > 4) pdfTexts.delete(pdfTexts.keys().next().value);
    }
    return got;
  }

  /** What the user had selected and the other tabs their words point at. */
  async function gatherContext(task, tab, allowlist) {
    const out = { selection: "", openTabPages: [] };
    const work = (async () => {
      if (isWeb(tab.url)) {
        const sel = await quiet(inject({ tabId: tab.id }, { func: () => String(window.getSelection ? window.getSelection() : "").slice(0, 2000) }));
        out.selection = (sel && sel[0] && sel[0].result) || "";
      }
      const all = (await quiet(chrome.tabs.query({ windowId: tab.windowId }))) || [];
      // Chosen from titles and addresses alone: a tab the request is not
      // about is never opened, read or sent anywhere.
      // A tab outside "Only use these sites" is not read for context either.
      const usable = all.filter((t) => t.id !== tab.id && isWeb(t.url) && (!allowlist || root.SELECT_TO_AI_SECURITY.isUrlAllowedByDomains(t.url, allowlist)));
      const others = TOOLS.pickContextTabs(task, tab, usable, 4);
      out.openTabPages = await Promise.all(others.map(async (t) => {
        await quiet(inject({ tabId: t.id }, { files: ["agentTools.js", "agentContentScript.js"] }));
        const res = await send(t.id, { action: "readText" });
        return { tabId: t.id, url: t.url, title: t.title, digest: res && res.success && res.text ? TOOLS.digestPage(res.text, 900) : "(not readable: the agent has no access to this site yet)" };
      }));
    })();
    await Promise.race([work, sleep(1500)]);
    return out;
  }

  /** The tabs the run is shown; a sub-task is shown only the tabs it opened. */
  async function tabList(windowId, currentId, only) {
    const own = chrome.runtime.getURL("");
    const tabs = (await quiet(chrome.tabs.query({ windowId }))) || [];
    return tabs.filter((t) => t.id && t.url && !t.url.startsWith(own) && (!only || only.includes(t.id))).map((t) => ({ id: t.id, active: !!t.active, current: t.id === currentId, title: t.title || "(Untitled)", url: t.url }));
  }

  async function observe(session, fx, back) {
    const run = session.run;
    let tab = await quiet(chrome.tabs.get(run.tabId));
    if (!tab) { back({ type: "tab_closed" }); return; }
    let moved = null;
    // A sub-task's tab is its own: the user's selection and other tabs are the run's.
    if (fx.first && !session.parent) {
      const ctx = await gatherContext(run.task, tab, (session.settings && session.settings.allowlist) || "");
      if (!session.extras.selectionCaptured) { session.extras.selection = ctx.selection; session.extras.selectionPlace = null; }
      session.extras.openTabPages = ctx.openTabPages;
      for (const t of ctx.openTabPages) { const site = TOOLS.siteOf(t.url); if (site && !run.trust.sites.includes(site)) run.trust.sites.push(site); }
    }
    let page = await scan(session, tab, back);
    if (!page) return;
    // A web page that turns out to be the browser's error page, on the
    // first look: the user's tab is left showing it, and the run starts
    // from nothing in a new tab.
    if (fx.first && !run.fromNothing && page.protectedPage && /failed to load/i.test(String(page.innerText || ""))) {
      const fresh = await openFreshTab(tab);
      if (fresh) {
        moved = { tabId: fresh.id, openedTab: fresh.id, fromNothing: { from: "error", url: tab.url || "", title: tab.title || "", reused: false } };
        run.fromNothing = moved.fromNothing;
        tab = fresh;
        page = await scan(session, tab, back);
        if (!page) return;
      }
    }
    // A page that checks the browser before letting it in ("checking your
    // browser…") usually lets a person's own browser through by itself in
    // a few seconds. It is given that time before anyone is asked to do
    // anything: nothing on it is touched, the page is only looked at again.
    const checking = (p) => POLICY.blockersOf(p).some((b) => b.kind === "human_check" && b.whole);
    if (checking(page)) {
      const token = session.token;
      run.journal.push({ k: "status", role: "idle", text: "Waiting for the site's own check to pass…" });
      publish(rootOf(session));
      for (let i = 0; i < CHECK_WAITS && checking(page); i++) {
        await sleep(CHECK_WAIT_MS);
        if (session.token !== token || !session.run || session.run.status !== "running") return;
        const now = await quiet(chrome.tabs.get(run.tabId));
        if (!now) { back({ type: "tab_closed" }); return; }
        const again = await scan(session, now, back);
        if (!again) return;
        page = again;
      }
    }
    await loadMemory();
    KNOWN.annotate(page.elements, memory);
    const startSite = TOOLS.siteOf(LEARN.startUrl(run) || "");
    const known = KNOWN.knownBlock(memory, TOOLS.siteOf(page.url || ""), run.task, { page, startSite, begun: LEARN.begun(run) });
    session.extras.known = known.text;
    session.extras.siteNotes = known.site;
    session.extras.knownIds = known.ids;
    session.extras.knownShown = known.shown;
    // A page behind another is not drawn. Whether an action brings it to
    // front is a fact the model is told (core/context.js).
    if (page.inBackground) page.behind = session.parent ? "subtask" : (await followed(session, tab)) ? "follow" : "user";
    session.page = page;
    // Whether the pointer and keys are made by script here: said to the model once (core/context.js).
    // With a debugger that a tab refused, the last pointer action says how it was made.
    session.extras.scripted = !chrome.debugger || debuggerDisabled || !!(session.pointerWas && session.pointerWas.run === run.id && session.pointerWas.how === "synthetic");
    // A picture the browser refused on this tab, in this run (act, look).
    session.extras.noPictures = session.noPictures && session.noPictures.run === run.id && session.noPictures.tabId === tab.id ? session.noPictures.why : "";
    session.extras.tabs = await tabList(tab.windowId, tab.id, session.parent ? run.openedTabs : null);
    back(moved ? { type: "observed", page, moved } : { type: "observed", page });
  }

  /**
   * After an action that changed the page where it stands, with more of the
   * step still to run, the page is read again so the run can tell whether
   * the next control is still what the model saw.
   */
  /**
   * An action the user approved runs only on the control they approved: the
   * page is read again, and when that control is gone or now says something
   * else, nothing is done and the run decides again on the page as it is.
   */
  async function approvedChanged(session, a) {
    if (a.approved === undefined || a.ref === undefined) return null;
    const tab = await quiet(chrome.tabs.get(session.run.tabId));
    const page = tab && isWeb(tab.url) ? await scan(session, tab, () => {}) : null;
    if (!page || !Array.isArray(page.elements)) return null;
    const el = page.elements.find((e) => e.id === a.ref);
    const now = el ? TOOLS.elementLabel(el) : null;
    if (now === a.approved) return null;
    await loadMemory();
    KNOWN.annotate(page.elements, memory);
    session.page = page;
    return { ok: false, changed: true, message: `[${a.ref}] ${el ? `now says "${String(now).slice(0, 80)}", not "${String(a.approved).slice(0, 80)}"` : "is no longer on the page"}, so the approved step was not run.` };
  }

  async function lookAgain(session, result, back) {
    const run = session.run;
    if (!result || !result.ok || !result.soft || !run || run.queue.length < 2) return result;
    const tab = await quiet(chrome.tabs.get(run.tabId));
    // Anything the look itself would raise is left to the next full look.
    const page = tab ? await scan(session, tab, () => {}) : null;
    if (!page || POLICY.blockersOf(page).length) return result;
    await loadMemory();
    KNOWN.annotate(page.elements, memory);
    session.page = page;
    return { ...result, rescanned: true };
  }

  // --------------------------------------------------------------- the model

  /** Whether the session, or one of its sub-tasks, is waiting on the model. */
  const calling = (s) => !!s.calling || [...(s.runners || new Map()).values()].some((r) => r.calling);

  // A wait inside a model call this long is one the user notices: the
  // run's live line says it is waiting. Shorter retries pass unremarked.
  const NOTICEABLE_WAIT_MS = 8000;
  let client = null;
  function clientFor() {
    if (client) return client;
    client = LLM.createClient({
      fetch: (...a) => fetch(...a),
      // The access token for Sign in with ChatGPT, which the 4.0 package does not include.
      chatgptToken: root.SELECT_TO_AI_CHATGPT_CONNECT ? (force) => root.SELECT_TO_AI_CHATGPT_CONNECT.accessToken(force) : undefined,
      sleep,
      now: () => Date.now(),
      // What the client did for itself (a re-ask, a retry that recovered)
      // comes marked quiet: kept in the saved log, not drawn as a step. A
      // wait the user would notice is said on the run's live line too.
      log: (title, text, o) => {
        const quiet = !!(o && o.quiet);
        for (const s of sessions.values()) {
          if (!calling(s) || !s.run) continue;
          s.run.journal.push({ k: "log", role: "system", title, text, fold: false, at: Date.now(), ...(quiet ? { quiet: true } : {}) });
          if (o && o.waitMs >= NOTICEABLE_WAIT_MS) s.run.journal.push({ k: "status", role: "executor", text: `Waiting ${Math.round(o.waitMs / 1000)} s for the provider…`, at: Date.now() });
          publish(s);
        }
      },
      onSwitch: async (from, to, until, limit) => {
        // The main provider is out of requests and the user chose a backup.
        await quiet(chrome.storage.local.set({ agentProviderPause: { provider: from, until } }));
        for (const s of sessions.values()) {
          if (!calling(s)) continue;
          await loadSettings(s);
          if (s.run) { s.run.journal.push({ k: "note", text: `${LLM.providerName(from)} ${limit && limit.kind === "no-credit" ? "is out of credit" : "has used up its requests for now"}, so ${LLM.providerName(to)} (your backup) is answering.` }); publish(s); }
          return s.cfg;
        }
        return null;
      },
    });
    return client;
  }

  // What the provider last said is left of the key's requests, kept where
  // the agent's page reads it for the model pill. Written only when it changes.
  let allowance = null;
  function noteAllowance(provider, left) {
    if (!provider || !left) return;
    if (allowance && allowance.provider === provider && allowance.remaining === left.remaining && allowance.limit === left.limit && allowance.resetAt === left.resetAt) return;
    allowance = { provider, remaining: left.remaining, limit: left.limit, resetAt: left.resetAt };
    quiet(chrome.storage.local.set({ agentAllowance: { ...allowance, at: Date.now() } }));
  }

  async function model(session, fx, back) {
    const run = session.run;
    const startedAt = Date.now();
    session.abort = new AbortController();
    session.calling = true;
    let last = 0;
    try {
      const out = await clientFor().call({
        system: fx.system, user: fx.user, tool: fx.tool, tier: fx.tier, effort: fx.effort, image: fx.image, reasks: fx.reasks, signal: session.abort.signal,
        // A sub-task's reply as it is written is not shown: its steps are.
        onText: (text) => { const t = Date.now(); if (!session.parent && t - last > 150) { last = t; post(session, { type: "stream", runId: run.id, text: String(text).slice(-6000) }); } },
      }, session.cfg);
      if (!session.parent) post(session, { type: "stream", runId: run.id, text: "" });
      if (out.left) noteAllowance(out.provider, out.left);
      back({ type: "model_replied", purpose: fx.purpose, reply: out.reply, usage: out.usage, ms: Date.now() - startedAt });
    } catch (e) {
      if (!session.parent) post(session, { type: "stream", runId: run.id, text: "" });
      if (e && e.kind === "aborted") return;
      // A spent allowance: when it comes back, for the run to be held until then.
      const limit = e && e.kind === "limit" && e.limit ? { kind: e.limit.kind || "", resetAt: e.limit.resetAt || 0, short: e.limit.short || "" } : null;
      if (limit && limit.resetAt && e.provider) noteAllowance(e.provider, { remaining: 0, limit: e.limit.limit || 0, resetAt: limit.resetAt });
      back({ type: "model_failed", purpose: fx.purpose, kind: (e && e.kind) || "model", message: (e && e.message) || "The model request failed.", usage: (e && e.usage) || null, waitMs: (e && e.waitMs) || 0, ...(limit ? { limit } : {}), ms: Date.now() - startedAt });
    } finally {
      session.calling = false;
    }
  }

  // ----------------------------------------------------------------- actions

  /** Resolves once the tab has finished loading, or straight away if it never started; true when it loaded. */
  function settled(tabId, startWindowMs, maxMs) {
    return new Promise((resolve) => {
      let loading = false;
      let finished = false;
      const done = () => { if (finished) return; finished = true; chrome.tabs.onUpdated.removeListener(listen); clearTimeout(startTimer); clearTimeout(maxTimer); setTimeout(() => resolve(loading), loading ? 250 : 0); };
      const listen = (id, info) => {
        if (id !== tabId) return;
        if (info.status === "loading") loading = true;
        if (info.status === "complete" && loading) done();
      };
      chrome.tabs.onUpdated.addListener(listen);
      const startTimer = setTimeout(() => { if (!loading) done(); }, startWindowMs);
      const maxTimer = setTimeout(done, maxMs);
      chrome.tabs.get(tabId).then((t) => { if (t && t.status === "loading") loading = true; }, done);
    });
  }

  /**
   * After a new page has loaded, waits until the requests begun since
   * `since` are done (its data, after the page itself), up to `deadline`.
   * Without the network view there is nothing more to wait for here: the
   * load was the whole wait, as before. Returns { loading, signs }.
   */
  async function netSettled(tabId, since, deadline) {
    const net = nets.get(tabId);
    if (!net) return { loading: false };
    const S = TOOLS.SETTLE;
    for (;;) {
      const st = net.state(since, Date.now());
      const v = TOOLS.settleVerdict({ elapsed: S.QUIET_MS, domQuietFor: S.QUIET_MS, busy: [], net: st });
      if (v.done) return { loading: false };
      if (Date.now() >= deadline || !nets.has(tabId)) return { loading: true, signs: v.signs };
      await sleep(100);
    }
  }

  /** Waits for a page the action loaded, then for what that page asks for, within the ceiling. */
  async function loadSettled(tabId, since, startWindowMs, maxMs) {
    const loaded = await settled(tabId, startWindowMs, maxMs);
    if (!loaded) return { loading: false };
    return netSettled(tabId, since, Math.max(since + TOOLS.SETTLE.CEILING_MS, Date.now() + 2 * TOOLS.SETTLE.QUIET_MS));
  }

  /** The model is told when the page was still loading as the wait ended. */
  const loadingNote = (waited, ms) => (waited && waited.loading ? ` ${TOOLS.stillLoadingNote(ms, waited.signs)}` : "");

  /** What the page did, in words, from what was measured before and after (core/context.js). */
  const effectOf = (o, settle) => CONTEXT.effectNote(o, settle);

  /**
   * One action on the page, and the wait for the page to finish what it
   * started. The network view of the tab is held over the action, so what
   * the action asks for can be told from what the page asks for by itself.
   * `settleMs` is how long was spent waiting.
   */
  async function interact(session, a, data, navigates) {
    const tabId = session.run.tabId;
    const started = Date.now();
    const tab = await quiet(chrome.tabs.get(tabId));
    if (tab && isWeb(tab.url)) await connected(tabId);
    const net = nets.get(tabId);
    if (net) net.begin();
    const waits = { ms: 0 };
    try {
      const r = await interactOnce(session, data, navigates, started, waits);
      return { ...r, settleMs: waits.ms };
    } finally {
      if (net) net.end();
    }
  }

  async function interactOnce(session, data, navigates, started, waits) {
    const run = session.run;
    const tabId = run.tabId;
    const timed = async (p) => { const t0 = Date.now(); try { return await p; } finally { waits.ms += Date.now() - t0; } };
    const before = (await quiet(chrome.tabs.get(tabId))) || {};
    // What is in front before the action: a tab the page opens is left in
    // front only if the user is following the run.
    const frontBefore = before.windowId !== undefined ? await frontOf(before.windowId) : null;
    // A tab the page opens while the action runs is where a person would be looking next.
    let opened = null;
    const created = [];
    const onNew = (t) => { created.push(t); if (t.openerTabId === tabId) opened = t; };
    chrome.tabs.onCreated.addListener(onNew);
    let res;
    // A control inside a frame is acted on in that frame, under its own number there.
    const at = inFrame(session, data.id !== undefined ? data.id : data.intoView !== undefined ? data.intoView : 0);
    const local = at.k ? { ...data, ...(data.id !== undefined ? { id: at.id } : {}), ...(data.intoView !== undefined ? { intoView: at.id } : {}), ...(data.to !== undefined ? { to: Number(data.to) % FRAME_BASE } : {}) } : data;
    try { res = await send(tabId, { action: "interact", data: local }, at.frameId); } finally { chrome.tabs.onCreated.removeListener(onNew); }
    // What it says about controls is said in the page's numbering.
    if (res && at.k) for (const f of ["message", "error"]) if (typeof res[f] === "string") res[f] = res[f].replace(/\[(\d+)\]/g, (_m, n) => `[${at.k * FRAME_BASE + Number(n)}]`);
    // A real click on a link that opens in a new tab may have opened it, as
    // for a person; the tab is found by its address when the browser named
    // no opener, and opened here only when no tab came.
    if (res && res.success && res.opensTab && !opened) opened = created.find((t) => (t.pendingUrl || t.url) === res.opensTab) || null;
    // Whether the pointer was the real one, said with every result.
    const pointer = res && (res.pointer === "real" || res.pointer === "synthetic") ? { pointer: res.pointer } : {};
    if (pointer.pointer) session.pointerWas = { run: run.id, how: pointer.pointer };
    // A link made to open in a new tab: open it, as the click would have for a person.
    if (res && res.success && res.opensTab && !opened) {
      let why = "";
      // Behind: it is read where it is, and brought to front only when the run acts on it.
      opened = await chrome.tabs.create({ url: res.opensTab, active: false, openerTabId: tabId, windowId: before.windowId }).catch((e) => { why = String((e && e.message) || e); return null; });
      if (!opened) return { ok: false, message: `${String(res.message || "").trim()} It is a link that opens in a new tab, and the tab could not be opened${why ? `: ${why}` : ""}. navigate to ${res.opensTab} opens it in this tab.` };
    }
    if (opened && opened.id) {
      // The browser puts a tab a page opens in front; the user is left where they were unless they follow the run.
      const frontNow = frontBefore ? await frontOf(before.windowId) : null;
      const view = rootOf(session).view || newView(null);
      const back = VIEW.restoreAfterOpen({ before: frontBefore && frontBefore.id, after: frontNow && frontNow.id, home: view.home, tabs: session.parent ? [] : [...view.tabs, tabId] });
      if (back !== null) await quiet(chrome.tabs.update(back, { active: true }));
      await timed(settled(opened.id, 800, 15000));
      const now = (await quiet(chrome.tabs.get(opened.id))) || opened;
      return { ok: true, pageChanged: true, tabId: opened.id, openedTab: opened.id, ...pointer, message: `${String((res && res.message) || "Done.").replace(/\s*Outcome:.*$/s, "")} It opened in a new tab, and you are on that tab now: ${now.url || now.pendingUrl || res.opensTab || ""}` };
    }
    // A frame that goes away under an action on it is what closing a notice
    // looks like from here: its own button took it off the page.
    if (!res && at.k) return { ok: true, pageChanged: true, message: `Done. The frame that control was in is no longer on the page.` };
    if (!res) {
      // The page went away under the action: that is what a click that
      // loads a new page looks like from here.
      if (navigates) {
        const waited = await timed(loadSettled(tabId, started, 400, 8000));
        const after = (await quiet(chrome.tabs.get(tabId))) || {};
        if (after.url && after.url !== before.url) return { ok: true, pageChanged: true, message: `Done. The page changed: now at ${after.url}${loadingNote(waited, Date.now() - started)}` };
      }
      return { ok: false, message: "The page did not respond to that." };
    }
    if (!res.success) return { ok: false, ...pointer, message: res.error || "That did not work." };
    if (res.settle) waits.ms += Number(res.settle.ms) || 0;
    const loaded = navigates ? await timed(loadSettled(tabId, started, 60, 8000)) : null;
    const after = (await quiet(chrome.tabs.get(tabId))) || {};
    const o = res.outcome || {};
    const moved = !!(after.url && before.url && after.url !== before.url);
    // What appeared is named by its numbers; otherwise how much changed is counted.
    const shown = !moved && Array.isArray(res.appeared) && res.appeared.length
      ? `That brought up: ${res.appeared.join("; ")}${res.appearedMore ? `; and ${res.appearedMore} more, in the listing` : ""}.`
      : "";
    const numbers = (text) => (at.k ? text.replace(/\[(\d+)\]/g, (_m, n) => `[${at.k * FRAME_BASE + Number(n)}]`) : text);
    // The wait ended at the ceiling: said plainly, so the model can choose to wait or act.
    const still = loaded && loaded.loading ? loadingNote(loaded, Date.now() - started).trim() : res.settle && res.settle.loading ? TOOLS.stillLoadingNote(res.settle.ms, res.settle.signs) : "";
    // Which way of pressing the page answered, when the first was not it (core/context.js).
    const ways = moved ? "" : CONTEXT.waysNote(res.ways, data.id, res.taken);
    // A field given a new value is a change, though no element changed: it is not then said that nothing did.
    const valued = !moved && Array.isArray(res.taken) && res.taken.includes("value");
    const message = [String(res.message || "Done.").replace(/\s*Outcome:.*$/s, ""), ways, moved ? `The page changed: now at ${after.url}` : numbers(shown) || (valued && o.noEffect ? "" : effectOf(o, res.settle)), still].filter(Boolean).join(" ");
    const pageChanged = moved || !!o.urlChanged || !!o.titleChanged || (o.newElementCount || 0) !== 0 || (navigates && (o.domMutationCount || 0) > 0) || !!(res.choices && res.choices.length);
    // Changed where it stands: same address, same title, nothing left to choose.
    const soft = pageChanged && !moved && !o.urlChanged && !o.titleChanged && !(res.choices && res.choices.length);
    return { ok: true, message, pageChanged, soft, noEffect: !!o.noEffect && !moved && !valued, ...pointer };
  }

  /**
   * A picture of a tab. The tab in front is pictured as it is on screen; a
   * tab behind another is pictured where it is, through the debugger
   * connection, which draws it for the picture without bringing it to
   * front, so looking never takes the user's tab. Returns {image}, or
   * {why, lasting} when none could be taken: why is said to the model, and
   * lasting means the browser would refuse this tab again (core/context.js).
   */
  async function capture(tabId) {
    const tab = await quiet(chrome.tabs.get(tabId));
    if (!tab) return { why: "The tab is gone." };
    let refused = "";
    if (tab.active) {
      const image = await Promise.resolve().then(() => chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 })).catch((e) => { refused = String((e && e.message) || e); return null; });
      if (image) return { image };
    }
    if (!(await connected(tabId))) {
      // With a debugger to ask, a tab behind another was refused by that tab; without one, no tab behind another can be pictured.
      if (!tab.active && chrome.debugger && !debuggerDisabled) return { why: "It is behind another tab, and it can be pictured there only through the debugger connection, which this tab refused." };
      return CONTEXT.noPicture(refused, !tab.active);
    }
    const got = await quiet(chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "jpeg", quality: 60 }));
    return got && got.data ? { image: `data:image/jpeg;base64,${got.data}` } : { why: "" };
  }

  async function act(session, a, keys) {
    const run = session.run;
    const tabId = run.tabId;
    touch(session, tabId);
    const moved = await approvedChanged(session, a);
    if (moved) return moved;
    switch (a.do) {
      // A press the user approved is made once: the page is not pressed another way when it shows no answer.
      // Any other is made with Enter or Space too only where those keys were allowed on it (keys).
      case "click": return interact(session, a, { action: "click", id: a.ref, ...(a.approved !== undefined ? { once: true } : keys ? { keys: true } : {}) }, true);
      case "hover": return interact(session, a, { action: "hover", id: a.ref }, false);
      case "click_at": {
        // What is at the point, as the decision on it saw it: the page
        // checks it is still that before it presses.
        const page = session.page || {};
        const hit = POLICY.pointTarget(page, a.x, a.y);
        const onFrame = (page.frameAreas || []).some((f) => a.x >= f.x && a.x <= f.x + f.w && a.y >= f.y && a.y <= f.y + f.h);
        const expect = hit.el ? (hit.el.frame ? { frame: true } : { ref: hit.el.id }) : { ref: null, frame: onFrame };
        return interact(session, a, { action: "click_at", x: a.x, y: a.y, expect }, true);
      }
      case "drag": {
        const page = session.page || {};
        const from = inFrame(session, a.ref);
        const apart = `[${a.ref}] is in ${from.k ? "a frame" : "the page itself"} and where it would be let go is not, and a drag cannot go from one to the other.`;
        let expect;
        if (a.to_ref !== undefined) {
          const to = inFrame(session, a.to_ref);
          if (to.k !== from.k) return { ok: false, message: apart };
          expect = { ref: to.id };
        } else {
          const p = POLICY.dropPoint(a, page);
          const hit = p ? POLICY.pointTarget(page, p.x, p.y) : { el: null };
          if (hit.el && (hit.el.frame || 0) !== from.k) return { ok: false, message: apart };
          expect = { ref: hit.el ? inFrame(session, hit.el.id).id : null, frame: false };
        }
        return interact(session, a, { action: "drag", id: a.ref, ...(a.to_ref !== undefined ? { to: a.to_ref } : { direction: a.direction, distance: a.distance }), expect }, true);
      }
      case "fill": {
        if (!a.from) return interact(session, a, { action: "fill", id: a.ref, value: a.value }, false);
        // One of the user's details: the value goes from the store to the
        // page, and what comes back to the model names the detail only.
        const r = await interact(session, a, { action: "fill", id: a.ref, value: KNOWN.fieldValue(memory, a.from) }, false);
        const label = (KNOWN.FIELD_LABEL[a.from] || a.from).toLowerCase();
        return r.ok ? { ...r, used: [a.from], message: `Filled [${a.ref}] with the user's ${label}.` } : { ...r, message: `[${a.ref}] did not take the user's ${label}.` };
      }
      case "fill_details": {
        const done = [];
        const failed = [];
        let changed = false;
        let settleMs = 0;
        for (const f of a.plan || []) {
          const r = await interact(session, a, { action: "fill", id: f.ref, value: KNOWN.fieldValue(memory, f.key) }, false);
          (r.ok ? done : failed).push(f);
          changed = changed || !!r.pageChanged;
          settleMs += r.settleMs || 0;
        }
        const names = (list) => list.map((f) => `[${f.ref}] ${f.label}`).join(", ");
        const message = [
          done.length ? `Filled from the user's details: ${names(done)}.` : "",
          failed.length ? `Did not take: ${names(failed)}.` : "",
          a.left || "",
        ].filter(Boolean).join(" ");
        return { ok: done.length > 0 || !failed.length, message, pageChanged: changed, used: done.map((f) => f.key), settleMs };
      }
      case "recall": {
        if (a.query && KNOWN.searchMemory) {
          const hits = KNOWN.searchMemory(memory, a.query, 5).map((e) => `[${e.kind}${e.scope && e.scope !== "global" ? ` on ${e.scope}` : ""}] ${e.text}`);
          const msg = hits.length ? hits.join("; ") : `memory search "${a.query}": (nothing matched)`;
          return { ok: true, message: msg, used: [] };
        }
        const keys = String(a.from || "").split(/,\s*/).filter(Boolean);
        const lines = keys.map((k) => {
          const val = KNOWN.fieldValue(memory, k);
          if (val) return `profile.${k}: ${val}`;
          const hits = KNOWN.searchMemory ? KNOWN.searchMemory(memory, k, 3).map((e) => `[${e.kind}${e.scope && e.scope !== "global" ? ` on ${e.scope}` : ""}] ${e.text}`) : [];
          return hits.length ? hits.join("; ") : `profile.${k}: (nothing on file)`;
        });
        return { ok: true, message: lines.join("; "), used: keys.filter((k) => KNOWN.fieldValue(memory, k)) };
      }
      case "press": return interact(session, a, { action: "keypress", id: a.ref, text: a.key, ...(a.times ? { times: a.times } : {}), ...(a.ref === undefined && Array.isArray(a.landsOn) ? { landsOn: a.landsOn } : {}) }, true);
      case "scroll": {
        if (a.ref === undefined) return interact(session, a, { action: "scroll", scrollDirection: a.direction || "down" }, false);
        if (a.direction) return interact(session, a, { action: "scroll", id: a.ref, scrollTarget: inFrame(session, a.ref).id, scrollDirection: a.direction }, false);
        const r = await interact(session, a, { action: "scroll", intoView: a.ref }, false);
        // Said plainly, so it is not done again in hope of seeing more.
        return r.ok ? { ...r, message: `[${a.ref}] is on screen now. That changes nothing in the listing: a control is listed, and can be acted on, wherever it is on the page.` } : r;
      }
      case "back": {
        const before = (await quiet(chrome.tabs.get(tabId))) || {};
        if (isWeb(before.url)) await connected(tabId);
        const started = Date.now();
        await quiet(chrome.tabs.goBack(tabId));
        const waited = await loadSettled(tabId, started, 500, 8000);
        const settleMs = Date.now() - started;
        const after = (await quiet(chrome.tabs.get(tabId))) || {};
        return after.url !== before.url ? { ok: true, pageChanged: true, message: `Went back. Now at ${after.url}${loadingNote(waited, settleMs)}`, settleMs } : { ok: false, message: "There is no earlier page to go back to in this tab.", settleMs };
      }
      case "wait":
        await sleep(Math.round((a.seconds || 2) * 1000));
        return { ok: true, pageChanged: true, message: `Waited ${a.seconds || 2} seconds.` };
      case "navigate": {
        const current = await quiet(chrome.tabs.get(tabId));
        if (current && isWeb(current.url)) await connected(tabId);
        const started = Date.now();
        const tab = await quiet(chrome.tabs.update(tabId, { url: a.url }));
        if (!tab) return { ok: false, message: "The tab could not be sent to that address." };
        const waited = await loadSettled(tabId, started, 800, 15000);
        const settleMs = Date.now() - started;
        const after = (await quiet(chrome.tabs.get(tabId))) || {};
        // Whether it arrived where it asked: the status the site answered
        // the page with and any load error, as the debugger saw them.
        const doc = documentOf(tabId, started, after.url || a.url, a.url);
        // The same facts as data, so the run can count an address that keeps failing.
        const arrival = { asked: a.url, url: after.url || a.url, ...doc };
        const note = CONTEXT.arrivalNote(arrival);
        return { ok: true, pageChanged: true, arrival, message: `Opened ${after.url || a.url}${note ? ` ${note}` : ""}${loadingNote(waited, settleMs)}`, settleMs };
      }
      case "tabs": {
        if (a.op === "open") {
          // Opened behind: a tab is read where it is, and brought to front
          // only when the run acts on its page (toFront).
          const here = await quiet(chrome.tabs.get(tabId));
          const tab = await quiet(chrome.tabs.create({ url: a.url, active: false, windowId: here ? here.windowId : session.windowId > 0 ? session.windowId : undefined, ...(here && !session.background ? { index: here.index + 1 } : {}) }));
          if (!tab) return { ok: false, message: "A new tab could not be opened." };
          await settled(tab.id, 800, 15000);
          return { ok: true, pageChanged: true, tabId: tab.id, openedTab: tab.id, message: `Opened ${a.url} in a new tab. You are now on that tab.` };
        }
        // A sub-task works in the tabs it opened, behind the user's.
        if (session.background && !run.openedTabs.includes(a.tab)) return { ok: false, message: `Tab ${a.tab} is not one this sub-task opened. It works only in its own tabs.` };
        if (session.background && a.op === "close" && a.tab === tabId) return { ok: false, message: "This is the tab the sub-task works in. It is closed when the sub-task ends." };
        if (a.op === "switch") {
          const tab = await quiet(chrome.tabs.get(a.tab));
          if (!tab) return { ok: false, message: `There is no tab ${a.tab}. Use a number from the tab list.` };
          // The run works in that tab now; it is brought to front when the run acts on its page (toFront).
          return { ok: true, pageChanged: true, tabId: a.tab, message: `Now on tab ${a.tab}: ${tab.title || tab.url}` };
        }
        await quiet(chrome.tabs.remove(a.tab));
        if (a.tab !== tabId) return { ok: true, pageChanged: true, closedTab: a.tab, message: `Closed tab ${a.tab}.` };
        // The tab the run was on is gone: carry on in the window's active tab.
        const [now] = (await quiet(chrome.tabs.query({ active: true, windowId: session.windowId > 0 ? session.windowId : undefined }))) || [];
        return now ? { ok: true, pageChanged: true, closedTab: a.tab, tabId: now.id, message: `Closed tab ${a.tab}. Now on tab ${now.id}: ${now.title || now.url}` } : { ok: false, message: "Closed the tab, and no other tab is open to work in." };
      }
      case "look": {
        const shot = await capture(tabId);
        if (shot.image) {
          // A picture was taken after all (the user opened the extension on this tab): the refusal is no longer a fact here.
          if (session.noPictures && session.noPictures.tabId === tabId) session.noPictures = { run: session.noPictures.run, tabId: -1, why: "" };
          return { ok: true, pageChanged: true, image: shot.image, message: "A picture of the page is attached to your next step." };
        }
        // A refusal that will come again is a fact of this run from here on
        // (core/context.js), and the user is told once that the agent works
        // without pictures: a run that cannot see is not left to look as if it can.
        const told = session.noPictures && session.noPictures.run === run.id && session.noPictures.tabId === tabId;
        // The user is told once in a run, whatever tab it is then on.
        const noted = !!(session.noPictures && session.noPictures.run === run.id);
        if (shot.lasting && !told) {
          session.noPictures = { run: run.id, tabId, why: shot.why };
          if (!noted) run.journal.push({ k: "note", text: "Chrome did not let the agent take a picture of this page, so it is working from the page's text and controls only. Maps, charts and images may be read less well." });
        }
        return { ok: false, message: `A picture of this tab could not be taken.${shot.why ? ` ${shot.why}` : ""}` };
      }
      case "read": {
        const page = session.page || {};
        const size = String(page.innerText || "").length;
        // Say plainly when there is nothing more: the whole text is already
        // in front of the model.
        if (!run.textCut) return { ok: false, message: `The whole text of this page is already shown (${size} characters). There is nothing more to read on it.` };
        // Part 1 is the text shown with the page; reading goes on from where it stops.
        const n = a.part || (run.reads.filter((r) => r.url === page.url && /^part /.test(r.label)).length + 2);
        if (n < 2) return { ok: false, message: "Part 1 is the text already shown with the page. read gets the next part." };
        const got = CONTEXT.partOf(page.innerText, n, run.textShown, run.pageBudget);
        if (!got.text) return { ok: false, message: `There is no part ${n}: this page's text has ${got.total} parts.` };
        const label = `part ${n} of ${got.total}`;
        const has = run.reads.some((r) => r.url === page.url && r.label === label);
        return { ok: !has, pageChanged: true, read: { url: page.url, label, text: got.text }, message: has ? `You already have ${label}: it is shown with the page.` : `Read ${label} (${got.text.length} characters). It is shown with the page.` };
      }
      case "find": {
        // One search of the whole page: the words in its text, and the
        // controls that carry them. Controls found join the listing.
        const page = session.page || {};
        const res = await send(tabId, { action: "find", query: a.query });
        let refs = ((res && res.refs) || []).slice(0, 12);
        let someControls = refs.length > 0 && res.allWords === false;
        // Controls inside the page's frames are part of the page too.
        const want = CONTEXT.wordsOf(a.query);
        const inFrames = (page.elements || []).filter((el) => el.frame && want.length && want.every((w) => CONTEXT.wordsOf(TOOLS.elementLabel(el)).includes(w)))
          .slice(0, 8).map((el) => ({ id: el.id, label: String(TOOLS.elementLabel(el)).slice(0, 60) }));
        if (inFrames.length) { refs = someControls ? inFrames : [...refs, ...inFrames].slice(0, 12); someControls = false; }
        const near = PAGE.findInText(page.innerText, a.query, { maxHits: 4, budget: 2400 }).filter((t) => !/^\[related\]/.test(t));
        // The search is by words, and gives its nearest passages. Only a
        // passage that has every word is the thing that was looked for.
        const words = CONTEXT.wordsOf(a.query);
        const hasAll = (t) => { const w = new Set(CONTEXT.wordsOf(t)); return words.every((x) => w.has(x)); };
        const passages = near.filter(hasAll);
        const name = (r) => `[${r.id}] "${r.label}"`;
        if (!refs.length && !near.length) {
          // A find that matched nothing says what the page does not have,
          // and, when the page writes something close, how it writes it.
          const labels = (page.elements || []).map((el) => TOOLS.elementLabel(el)).join("\n");
          const close = CONTEXT.nearestWords(a.query, `${page.innerText || ""}\n${labels}`, 8);
          const around = close.length ? CONTEXT.quoteAround(String(page.innerText || ""), [close[0]], 200) : "";
          const shown = close.length ? ` The page's own words nearest to it: ${close.map((w) => `"${w}"`).join(", ")}${around && CONTEXT.wordsOf(around).includes(close[0]) ? `. The text around the first reads: "${around}"` : ""}.` : "";
          return { ok: true, miss: true, pageChanged: true, message: `Nothing on this page has "${a.query}", not in its text and not on any control. find matches words as the page writes them.${shown}` };
        }
        const label = `find "${a.query}"`;
        const text = [
          passages.length ? passages.join("\n---\n") : near.length ? `These words are not together anywhere in the page's text. The nearest passages, which have some of them:\n${near.join("\n---\n")}` : "(these words are not in the page's text)",
          refs.length ? `${someControls ? "No control has all of these words. Controls with some of them" : "Controls with these words"}:\n${refs.map(name).join("\n")}` : "(no control has these words)",
        ].join("\n");
        const read = { url: page.url, label, text };
        const has = run.reads.some((r) => r.url === page.url && r.label === label && r.text === text);
        if (has) return { ok: false, pageChanged: true, read, message: `You already have ${label}: it is shown with the page, and the page has not changed since.` };
        const exactControls = refs.length > 0 && !someControls;
        if (!passages.length && !exactControls) {
          // Near misses only, and said to be.
          const some = [
            someControls ? `on the controls ${refs.slice(0, 6).map(name).join(", ")}` : "",
            near.length ? `in ${near.length} passage${near.length === 1 ? "" : "s"} of the text, shown with the page` : "",
          ].filter(Boolean).join(", and ");
          return { ok: true, miss: true, pageChanged: true, read, message: `Nothing on this page has all of "${a.query}" together. Some of the words are ${some}. find matches words as the page writes them.` };
        }
        const said = [
          passages.length ? `${passages.length} place${passages.length === 1 ? "" : "s"} in the text` : "",
          exactControls ? `${refs.length} control${refs.length === 1 ? "" : "s"} (${refs.slice(0, 6).map(name).join(", ")})` : "",
        ].filter(Boolean).join(" and ");
        // The part of the first passage where the words are, and the section it is in.
        const first = passages.length ? /^(?:\[in "([^"]*)"\] )?([\s\S]*)$/.exec(String(passages[0])) : null;
        const section = first && first[1] ? (first[1].length > 60 ? `${first[1].slice(0, 59).trim()}…` : first[1]) : "";
        const quote = first ? ` The text there${section ? ` (in "${section}")` : ""} reads: "${CONTEXT.quoteAround(first[2], words, 360)}"${passages.length > 1 ? " The other passages are shown with the page." : ""}` : "";
        return { ok: true, pageChanged: true, read, message: `"${a.query}" is in ${said}.${quote}${exactControls ? " The controls are in the listing." : ""}` };
      }
      default:
        return { ok: false, message: `${STEP.describe(a)} cannot be run.` };
    }
  }

  // --------------------------------------------------------------- attention
  // The run needs the user. They are told in the panel (the run's card), on
  // the page itself (a banner), and on the toolbar icon; more only if they
  // are somewhere else. While they sign in, pass a check, enter a code or
  // pay, the page is not read: it is only watched for the thing in the way
  // to go, and then the same run carries on.

  const WATCHED = VIEW.ON_PAGE_WAITS;
  const BANNER = Object.freeze({
    sign_in: "Select to AI is waiting for you to sign in here.",
    human_check: "Select to AI is waiting for you to complete the check on this page.",
    code: "Select to AI is waiting for you to enter the code.",
    payment: "Select to AI is waiting for you to enter the payment details.",
    press: "Select to AI is waiting for you to check this and press the highlighted button.",
    // A control inside a frame cannot be marked from the page around it.
    pressFramed: "Select to AI is waiting for you to press the button it asked you about, in the framed part of this page. Choose I'm done here once you have.",
  });

  /** Puts the banner on the page and starts the watch for the blocker to go. */
  async function watchPage(wait) {
    const tabId = wait.tabId;
    await quiet(inject({ tabId }, { files: ["agentTools.js", "agentContentScript.js"] }));
    await send(tabId, { action: "needsYou", kind: wait.kind, text: wait.press >= FRAME_BASE ? BANNER.pressFramed : wait.press ? BANNER.press : BANNER[wait.kind], press: wait.press });
  }

  // A run paused for its provider is woken by an alarm, which outlives the
  // worker. Each wait has its own: a sub-task's pause is its own.
  const RESUME = (windowId, waitId) => `agentResume:${windowId}:${waitId}`;
  // A held run nobody came back to is not kept waiting for ever: after
  // this long it ends as the user's own stop would end it, with what it found.
  const HOLD_LONGEST_MS = 24 * 3600000;
  const HOLD_OVER = (windowId, waitId) => `agentHoldOver:${windowId}:${waitId}`;
  function wakeAt(session, wait) {
    if (wait.hold && chrome.alarms) quiet(chrome.alarms.create(HOLD_OVER(session.windowId, wait.id), { when: Math.max(wait.until || 0, wait.since || Date.now()) + HOLD_LONGEST_MS }));
    // A hold with no time named is ended by the user or by a backup being connected.
    if (!wait.until) return;
    if (wait.until <= Date.now() + 1000 || !chrome.alarms) {
      if (wait.hold) resumeHeld(session, wait.id).catch((e) => console.error("Select to AI engine:", e));
      else enqueue(session, { type: "pause_over", id: wait.id });
      return;
    }
    quiet(chrome.alarms.create(RESUME(session.windowId, wait.id), { when: wait.until }));
  }

  /**
   * The run waits: the page, the badge and, where the user is not looking,
   * a notice tell them. `again` is the same wait brought back after the
   * worker restarted: the user was told already, and its one reminder alarm
   * outlives the worker, so only the watch and the badge are put back.
   */
  async function attention(session, wait, again) {
    keepAwake();
    // Nothing for the user to do: the run carries on by itself when the time is up.
    if (wait.kind === "pause") {
      session.attending.set(wait.id, wait);
      wakeAt(session, wait);
      // A held run has a choice for the user: with no page of the agent's open, a notice says so.
      if (wait.hold && !again && !session.ports.size) {
        quiet(notice(`agent-wait:${session.windowId}`, { type: "basic", iconUrl: "icon128.png", title: wait.hold === "limit" ? "Task on hold: usage limit reached" : "Task on hold: the model is busy", message: String(wait.question || "").slice(0, 240) }));
      }
      return;
    }
    const tabId = wait.tabId;
    const watched = WATCHED.has(wait.kind) && tabId !== null && tabId !== undefined;
    session.attending.set(wait.id, wait);
    if (watched) await watchPage(wait);
    // What is asked on the agent's page takes the user back there (core/view.js).
    if (!again) await settleView(session, wait.kind).catch((e) => console.error("Select to AI view:", e));
    const badge = watched ? { tabId } : {};
    quiet(chrome.action.setBadgeText({ ...badge, text: "!" }));
    quiet(chrome.action.setBadgeBackgroundColor({ ...badge, color: "#c2410c" }));
    quiet(chrome.action.setTitle({ ...badge, title: `Select to AI needs you: ${String(wait.question || "").slice(0, 80)}` }));
    if (again) return;

    // Where the user is decides how loudly they are told.
    const tab = tabId !== null && tabId !== undefined ? await quiet(chrome.tabs.get(tabId)) : null;
    const front = await quiet(chrome.windows.getLastFocused());
    const chromeInFront = !!(front && front.focused);
    const onTheTab = !!(tab && tab.active && front && tab.windowId === front.id && chromeInFront);
    const idle = chrome.idle ? await quiet(chrome.idle.queryState(60)) : "active";
    if (tab && !onTheTab) quiet(chrome.windows.update(tab.windowId, { drawAttention: true }));
    const panelOpen = session.ports.size > 0;
    if (!chromeInFront || idle !== "active" || (!panelOpen && !onTheTab)) {
      quiet(notice(`agent-wait:${session.windowId}`, {
        type: "basic", iconUrl: "icon128.png", title: "Select to AI needs you",
        message: String(wait.question || "Open the side panel to continue.").slice(0, 240),
        buttons: tab ? [{ title: "Go to tab" }] : undefined,
      }));
    }
    // One reminder, for things that run out (a code): then it stays quiet.
    if (chrome.alarms) quiet(chrome.alarms.create(`agentRemind:${session.windowId}`, { delayInMinutes: 2 }));
  }

  /** The wait is over, however it ended: take the banner, badge and notices away. */
  function endAttention(session, wait, how) {
    session.attending.delete(wait.id);
    const tabId = wait.tabId;
    if (WATCHED.has(wait.kind) && tabId !== null && tabId !== undefined) {
      send(tabId, { action: "needsYouDone", text: how === "cleared" || how === "user_done" ? "Thanks, continuing…" : "" });
      quiet(chrome.action.setBadgeText({ tabId, text: "" }));
      quiet(chrome.action.setTitle({ tabId, title: "Select to AI" }));
    }
    // The notice and its reminder stay while another wait of this session is open.
    if (![...session.attending.values()].some((w) => w.kind !== "pause")) {
      quiet(unnotice(`agent-wait:${session.windowId}`));
      if (chrome.alarms) quiet(chrome.alarms.clear(`agentRemind:${session.windowId}`));
    }
    if (chrome.alarms && wait.kind === "pause") quiet(chrome.alarms.clear(RESUME(session.windowId, wait.id)));
    calm();
    keepAwake();
  }

  function calm() {
    if ([...sessions.values()].some((s) => waitsOf(s.run).some((w) => w.kind !== "pause"))) return;
    quiet(chrome.action.setBadgeText({ text: "" }));
    quiet(chrome.action.setTitle({ title: "Select to AI" }));
  }

  /** The session, and its wait, for something only the user can do on this tab: the run's or a sub-task's. */
  function waitingOn(tabId) {
    for (const s of sessions.values()) {
      const wait = waitsOf(s.run).find((w) => w.tabId === tabId && WATCHED.has(w.kind));
      if (wait) return { session: s, wait };
    }
    return null;
  }

  /** The session or sub-task runner at work on this tab. */
  function workingOn(tabId) {
    for (const s of sessions.values()) {
      if (s.run && s.run.status === "running" && s.run.tabId === tabId) return s;
      for (const r of s.runners.values()) if (r.run && r.run.status === "running" && r.run.tabId === tabId) return r;
    }
    return null;
  }

  // The page says the thing in the way is gone, or the user pressed "I'm done" on the banner.
  // ------------------------------------------------------------- real keys
  //
  // A key event made by a script is only an event: the browser does not
  // scroll on PageDown, move focus on Tab or type into a box for it. Keys
  // the agent presses are sent through the debugger connection instead,
  // where they are real ones. Chrome shows its "is debugging this browser"
  // bar while that is open; it is closed when the run ends. Where the
  // connection cannot be had, the page falls back to scripted events.
  const keyboards = new Map(); // tabId -> "on" | "off"

  /**
   * The tabs a session or a sub-task's runner has read, acted on or drawn
   * on in its current run. They are let go when that run ends, whichever
   * way it ends; a tab another run still works in is left to that run.
   */
  const touchedBy = (owner) => owner.touched || (owner.touched = new Set());
  function touch(owner, tabId) {
    if (owner && tabId !== null && tabId !== undefined) touchedBy(owner).add(tabId);
  }
  const liveRun = (run) => !!run && (run.status === "running" || run.status === "waiting");
  function heldElsewhere(tabId, owner) {
    for (const s of sessions.values()) {
      if (s !== owner && liveRun(s.run) && touchedBy(s).has(tabId)) return true;
      for (const r of s.runners.values()) if (r !== owner && liveRun(r.run) && touchedBy(r).has(tabId)) return true;
    }
    return false;
  }
  /**
   * Lets go of every tab an owner touched: the agent's marks come off the
   * page and the debugger detaches, unless another live run still works
   * there. A tab where real keys could not be had is tried again by the
   * next run.
   */
  function release(owner) {
    for (const id of touchedBy(owner)) {
      if (heldElsewhere(id, owner)) continue;
      send(id, { action: "clear" });
      releaseKeys(id);
    }
    touchedBy(owner).clear();
  }
  async function connected(tabId) {
    if (!chrome.debugger || debuggerDisabled || keyboards.get(tabId) === "off") return false;
    if (keyboards.get(tabId) === "on") return true;
    const target = { tabId };
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (e) {
      // Left open by this extension before its worker restarted.
      if (!/already attached/i.test(String((e && e.message) || e))) { keyboards.set(tabId, "off"); return false; }
    }
    keyboards.set(tabId, "on");
    // The page's window often does not hold the keyboard (the panel does).
    await quiet(chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true }));
    // The tab's requests, to tell when the page has finished what an action
    // started. Bodies are not kept: only that a request began and ended.
    const net = TOOLS.createNetworkTracker();
    nets.set(tabId, net);
    const on = await chrome.debugger.sendCommand(target, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).then(() => true, () => false)
      || await chrome.debugger.sendCommand(target, "Network.enable", {}).then(() => true, () => false);
    if (!on && nets.get(tabId) === net) nets.delete(tabId);
    return true;
  }

  // ------------------------------------------------------------ the network
  //
  // Per tab, what the page has asked for and not yet got, seen through the
  // same debugger connection. The wait after each action reads it
  // (settleAfterAction in the content script asks for it; netSettled here).
  const nets = new Map(); // tabId -> network tracker
  if (chrome.debugger && chrome.debugger.onEvent) chrome.debugger.onEvent.addListener((source, method, params) => {
    // A drag and drop the real pointer started, caught to be carried to its drop.
    if (method === "Input.dragIntercepted" && source && params && params.data) { drags.set(source.tabId, params.data); return; }
    const net = source && nets.get(source.tabId);
    if (!net || !params) return;
    const now = Date.now();
    if (params.type === "Document") documentEvent(source.tabId, method, params, now);
    if (method === "Network.requestWillBeSent") net.started(params.requestId, params.request && params.request.url, params.type, now);
    else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") net.ended(params.requestId, now);
  });

  // Per tab, the last pages (documents) the tab asked for, with the status
  // the site answered or the error loading met: {id, url, status,
  // statusText, error, at}. Frames' pages are among them, and are told
  // apart by their address.
  const documents = new Map();
  const DOCUMENTS_KEPT = 20;
  function documentEvent(tabId, method, params, now) {
    const list = documents.get(tabId) || [];
    const entry = () => { let e = list.find((x) => x.id === params.requestId); if (!e) { e = { id: params.requestId, url: "", at: now }; list.push(e); } return e; };
    if (method === "Network.requestWillBeSent" && params.request) Object.assign(entry(), { url: params.request.url, at: now, status: 0, error: "" });
    else if (method === "Network.responseReceived" && params.response) Object.assign(entry(), { url: params.response.url || entry().url, status: params.response.status || 0, statusText: params.response.statusText || "" });
    else if (method === "Network.loadingFailed" && !params.canceled) Object.assign(entry(), { error: params.errorText || "it failed" });
    else return;
    documents.set(tabId, list.slice(-DOCUMENTS_KEPT));
  }

  /** The status or error of the page a navigate ended on: {status, statusText, error}, empty when not seen. */
  function documentOf(tabId, since, url, asked) {
    const plain = (u) => String(u || "").split("#")[0];
    const mine = (documents.get(tabId) || []).filter((d) => d.at >= since);
    const at = [...mine].reverse().find((d) => plain(d.url) === plain(url) && (d.status || d.error));
    const failed = at || [...mine].reverse().find((d) => d.error && (plain(d.url) === plain(asked) || plain(d.url) === plain(url)));
    if (!failed) return {};
    return failed.error ? { error: failed.error } : { status: failed.status, statusText: failed.statusText || "" };
  }

  /**
   * Things a page listens for a press on, with nothing else marking them
   * as controls (a coloured box, a shape in a drawing, a bare "+"). The
   * page names the candidates it has not asked about yet; the browser is
   * asked which of them have a listener; the page is told. Nothing in the
   * page's own scripts is touched. True when some were found.
   */
  const PRESS_EVENTS = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]);
  async function pressables(tabId) {
    const asked = await send(tabId, { action: "listenerCandidates" });
    if (!asked || !asked.count) return false;
    let hits = [];
    try {
      if (await connected(tabId)) {
        const target = { tabId };
        const got = await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: "Array.from(document.querySelectorAll('[data-select-to-ai-q]'))", objectGroup: "select-to-ai" });
        const props = got && got.result && got.result.objectId ? await chrome.debugger.sendCommand(target, "Runtime.getProperties", { objectId: got.result.objectId, ownProperties: true }) : null;
        const nodes = ((props && props.result) || []).filter((p) => /^\d+$/.test(p.name) && p.value && p.value.objectId);
        const found = await Promise.all(nodes.map(async (p) => {
          const r = await quiet(chrome.debugger.sendCommand(target, "DOMDebugger.getEventListeners", { objectId: p.value.objectId, depth: 1 }));
          return r && (r.listeners || []).some((l) => PRESS_EVENTS.has(l.type)) ? Number(p.name) : -1;
        }));
        hits = found.filter((i) => i >= 0);
        await quiet(chrome.debugger.sendCommand(target, "Runtime.releaseObjectGroup", { objectGroup: "select-to-ai" }));
      }
    } catch (_) { hits = []; }
    const told = await send(tabId, { action: "listenerHits", hits });
    return !!(told && told.added);
  }

  async function pressReal(tabId, m) {
    if (!(await connected(tabId))) return { ok: false };
    const target = { tabId };
    const base = { key: String(m.key || ""), code: String(m.code || ""), windowsVirtualKeyCode: Number(m.keyCode) || 0, nativeVirtualKeyCode: Number(m.keyCode) || 0, modifiers: Number(m.modifiers) || 0 };
    const times = Math.max(1, Math.min(50, Number(m.times) || 1));
    try {
      for (let i = 0; i < times; i++) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: m.text ? "keyDown" : "rawKeyDown", ...base, ...(m.text ? { text: String(m.text) } : {}) });
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
      }
    } catch (_) {
      keyboards.set(tabId, "off");
      return { ok: false };
    }
    return { ok: true };
  }
  // ----------------------------------------------------------- real pointer
  //
  // The pointer is the browser's own, moved through the same connection as
  // the keys. A page asks with "agentPointer" and points in its own frame's
  // CSS pixels; a frame's points are placed by where the main page draws the
  // frame. A gesture that cannot start by the time the page stops waiting
  // for it is not started, so it can never follow the scripted events the
  // page uses instead.
  const drags = new Map(); // tabId -> what a drag the page started carries (Input.dragIntercepted)
  async function pointerReal(session, tabId, frameId, m) {
    const none = { ok: false, sent: 0 };
    if (!(await connected(tabId))) return none;
    if (Number(m.startBy) && Date.now() > Number(m.startBy)) return none;
    const steps = (Array.isArray(m.steps) ? m.steps : []).slice(0, 200).filter((x) => x && typeof x.t === "string");
    let box = null;
    if (frameId) {
      const frame = (session.frames || []).find((f) => f && f.frameId === frameId);
      if (!frame || !frame.token) return none;
      const got = await send(tabId, { action: "frameBox", token: frame.token, inner: m.inner, points: steps.filter((x) => x.aim).map((x) => ({ x: Number(x.x), y: Number(x.y) })) });
      if (!got || !got.found) return none;
      if (got.covered) return { ...none, covered: got.covered };
      box = { left: got.left, top: got.top, width: got.width, inner: Number(m.inner) || 0 };
    }
    const placed = steps.map((x) => (x.t === "wait" ? { t: "wait", ms: Math.max(0, Math.min(2000, Number(x.ms) || 0)) } : { t: x.t, ...TOOLS.toViewport({ x: Number(x.x), y: Number(x.y) }, box), ...(x.t === "wheel" ? { dx: Number(x.dx) || 0, dy: Number(x.dy) || 0 } : {}) }));
    const target = { tabId };
    drags.delete(tabId);
    // The agent's bar on the page (agentBar.js) moves off the points the
    // pointer goes to, so the press lands on the page, in a frame or not.
    const v = rootOf(session).view;
    const bar = v && (v.watched || []).includes(tabId);
    if (bar) await send(tabId, { action: "agentBarClear", points: placed.filter((x) => x.t !== "wait").map((x) => ({ x: x.x, y: x.y })) });
    const r = await TOOLS.runGesture(placed, { drag: !!m.drag, sleep, send: (method, params) => chrome.debugger.sendCommand(target, method, params), dragData: () => drags.get(tabId) || null });
    drags.delete(tabId);
    if (bar) send(tabId, { action: "agentBarClear", release: true });
    return { ok: !r.error, sent: r.sent, dropped: r.dropped, ...(r.error ? { error: r.error } : {}) };
  }

  function releaseKeys(tabId) {
    if (keyboards.get(tabId) === "on" && chrome.debugger) quiet(chrome.debugger.detach({ tabId }));
    keyboards.delete(tabId);
    nets.delete(tabId);
    documents.delete(tabId);
    drags.delete(tabId);
  }
  // The user closed the bar, or the tab went: scripted keys for the rest of
  // the run, and the wait after an action goes by what the page shows.
  if (chrome.debugger && chrome.debugger.onDetach) chrome.debugger.onDetach.addListener((source) => {
    if (!source || source.tabId === undefined) return;
    nets.delete(source.tabId);
    if (keyboards.has(source.tabId)) keyboards.set(source.tabId, "off");
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !sender || !sender.tab) return false;
    // A key the agent is pressing on the page of a run in progress.
    if (message.action === "agentRealKey") {
      const session = sender.frameId === 0 ? workingOn(sender.tab.id) : null;
      if (!session) { sendResponse({ ok: false }); return false; }
      pressReal(sender.tab.id, message).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    // The pointer the agent is moving on the page of a run in progress, from the page or one of its frames.
    if (message.action === "agentPointer") {
      const session = workingOn(sender.tab.id);
      if (!session) { sendResponse({ ok: false, sent: 0 }); return false; }
      pointerReal(session, sender.tab.id, sender.frameId || 0, message).then(sendResponse, () => sendResponse({ ok: false, sent: 0 }));
      return true;
    }
    // The page asking whether what its action started is still loading.
    if (message.action === "agentNetState") {
      const net = nets.get(sender.tab.id);
      const since = Number(message.since) || Date.now();
      const now = Date.now();
      const st = net ? net.state(since, now) : null;
      // `asked`: whether the action started any request at all, open or over.
      sendResponse(st ? { net: true, ...st, asked: st.open > 0 || st.quietFor < now - since } : { net: false });
      return false;
    }
    // A frame saying which frame it is (readFrames).
    if (message.action === "agentFrameHello" && typeof message.token === "string") {
      hellos.set(`${sender.tab.id}:${message.token}`, sender.frameId);
      if (hellos.size > 200) hellos.delete(hellos.keys().next().value);
      return false;
    }
    // The page waited on showed its blocker: from now on it going away means the user got past it.
    if (message.action === "agentBlockerSeen") {
      if (sender.frameId) return false;
      restore().then(() => { const on = waitingOn(sender.tab.id); if (on && on.wait.kind === message.kind) markSeen(on.wait.id); });
      return false;
    }
    if (message.action !== "agentBlockerCleared" && message.action !== "agentWaitDone") return false;
    restore().then(() => {
      const on = waitingOn(sender.tab.id);
      if (on) enqueue(on.session, { type: message.action === "agentWaitDone" ? "user_done" : "cleared", id: on.wait.id });
    });
    return false;
  });

  // The waited-on tab loaded a new page: the watch went with the old one.
  // Look only at whether the blocker is still there, and watch again if so.
  // A blocker that was never seen (an email-first sign-in, a hand-off the
  // structure does not show) is not said to be gone by a page without it:
  // the page is watched again, and the user's "I'm done" ends the wait.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "complete") return;
    restore().then(async () => {
      const on = waitingOn(tabId);
      if (!on) return;
      const { session, wait } = on;
      await quiet(inject({ tabId }, { files: ["agentTools.js", "agentContentScript.js"] }));
      const res = await send(tabId, { action: "probe" });
      if (!waitsOf(session.run).some((w) => w.id === wait.id)) return;
      // A button the user was to press is gone with the page it was on.
      const there = !!res && (res.blockers || []).some((b) => b.kind === wait.kind);
      if (there) markSeen(wait.id);
      const gone = wait.press ? true : !!res && !there && seenWaits.has(wait.id);
      if (gone) enqueue(session, { type: "cleared", id: wait.id });
      else if (res) watchPage(wait);
    });
  });

  const goToWait = async (windowId) => {
    await restore();
    const session = sessions.get(windowId);
    const wait = session && waitsOf(session.run).find((w) => w.kind !== "pause");
    if (wait && wait.tabId !== null && wait.tabId !== undefined) {
      const tab = await quiet(chrome.tabs.update(wait.tabId, { active: true }));
      if (tab) quiet(chrome.windows.update(tab.windowId, { focused: true }));
    }
    quiet(unnotice(`agent-wait:${windowId}`));
  };
  // notifications is optional: without the grant chrome.notifications is
  // undefined, and touching it here would stop the whole worker from loading.
  // grants.js attaches the click listeners now when granted, or as soon as
  // the user grants notifications.
  const onWaitNotice = (id) => { if (typeof id === "string" && id.startsWith("agent-wait:")) goToWait(Number(id.slice(11))); };
  if (GRANTS) GRANTS.onNoticeClicked(onWaitNotice);
  else if (chrome.notifications) {
    chrome.notifications.onClicked.addListener(onWaitNotice);
    chrome.notifications.onButtonClicked.addListener(onWaitNotice);
  }

  // -------------------------------------------------------------- the view
  // Which tab the user sees while a run works (core/view.js). Reading never
  // brings a tab to front. An action on a page brings it to front when the
  // user is following the run; then, for a run driven from the agent's page
  // in a tab of its own, a small bar on that page says what the agent is
  // doing, with Stop, Back to agent and Open side panel. When the run ends
  // or asks for something on the agent's page, the user is taken back
  // there, unless they used the page themselves meanwhile.

  /** The tab in front in a window, or null. */
  async function frontOf(windowId) {
    const [front] = (await quiet(chrome.tabs.query({ active: true, windowId }))) || [];
    return front || null;
  }

  /** Counts a tab as one the run works in. */
  function workedIn(session, tabId) {
    const v = session && !session.parent ? session.view : null;
    if (v && tabId !== null && tabId !== undefined && !v.tabs.includes(tabId)) v.tabs.push(tabId);
  }

  /** Whether the user is following the run in the window of this tab. */
  async function followed(session, tab) {
    const v = rootOf(session).view || newView(null);
    const front = await frontOf(tab.windowId);
    return VIEW.following({ front: front && front.id, home: v.home, tabs: [...v.tabs, tab.id] });
  }

  /**
   * Waits until a tab just brought to front is drawn: visible, with two
   * animation frames run, so what an action opens there can open. At most
   * 800 ms; a page that cannot be scripted is not waited for.
   */
  async function drawn(tabId) {
    const look = quiet(inject({ tabId }, {
      func: () => new Promise((resolve) => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.visibilityState)));
        if (document.visibilityState === "visible") { done(); return; }
        const t = setTimeout(() => resolve(document.visibilityState), 700);
        document.addEventListener("visibilitychange", () => { clearTimeout(t); done(); }, { once: true });
      }),
    }));
    await Promise.race([look, sleep(800)]);
  }

  /** Before an action on a page: its tab is brought to front if the user follows the run. */
  async function toFront(session, a) {
    if (session.parent || session.background || !session.run) return;
    const tab = await quiet(chrome.tabs.get(session.run.tabId));
    if (!tab || tab.active) return;
    const front = await frontOf(tab.windowId);
    const v = session.view || newView(null);
    if (!VIEW.bringToFront({ action: a, background: false, tabId: tab.id, front: front && front.id, home: v.home, tabs: [...v.tabs, tab.id] })) return;
    const t0 = Date.now();
    await quiet(chrome.tabs.update(tab.id, { active: true }));
    await drawn(tab.id);
    // How often and how long bringing a tab to front took, with the run's timing.
    const run = session.run;
    if (run) { run.timing = run.timing || { observe: 0, model: 0, act: 0, settle: 0 }; run.timing.front = { n: ((run.timing.front && run.timing.front.n) || 0) + 1, ms: ((run.timing.front && run.timing.front.ms) || 0) + Date.now() - t0 }; }
    syncBar(session);
  }

  /**
   * The run ended (wait ""), or waits for the user: takes them back to the
   * agent's page or leaves them where they are, and keeps or takes off the bar.
   */
  async function settleView(session, wait) {
    const v = session.view;
    const run = session.run;
    if (!v || v.home === null || !run) return;
    const tab = run.tabId !== null && run.tabId !== undefined ? await quiet(chrome.tabs.get(run.tabId)) : null;
    const front = await frontOf(tab ? tab.windowId : session.windowId);
    const home = await quiet(chrome.tabs.get(v.home));
    if (!home) { v.home = null; barOff(session); return; }
    const out = VIEW.onSettle({ home: v.home, front: front && front.id, tabs: v.tabs, touched: v.touched, wait: wait || "" });
    if (session.view !== v) return;
    if (out.focus === "home") await quiet(chrome.tabs.update(v.home, { active: true }));
    if (out.bar === "remove") barOff(session);
    else if (out.bar === "outcome") v.kept = front ? front.id : null;
    await save(session);
    syncBar(session);
  }

  // The app's colours, read once from tokens.css, for the bar's shadow root.
  let tokensCss = null;
  async function tokens() {
    if (tokensCss !== null) return tokensCss;
    try {
      const text = await (await fetch(chrome.runtime.getURL("tokens.css"))).text();
      const block = /:root\s*\{([\s\S]*?)\n\}/.exec(text);
      tokensCss = block ? block[1].replace(/color-scheme:[^;]*;/, "") : "";
    } catch (_e) { tokensCss = ""; }
    return tokensCss;
  }

  /** Sends the bar's state to a tab, putting the bar's script there first if it is not. */
  async function barSend(tabId, message) {
    const got = await send(tabId, message);
    if (got && got.bar) return true;
    await quiet(inject({ tabId }, { files: ["agentBar.js"] }));
    const again = await send(tabId, message);
    return !!(again && again.bar);
  }

  /** Takes the bar and its watch off every page of the session. */
  function barOff(session) {
    const v = session && session.view;
    if (!v) return;
    for (const id of v.watched || []) send(id, { action: "agentBar", off: true });
    v.watched = [];
    v.kept = null;
  }

  /**
   * Puts the bar where it belongs now: shown on the run's tab when it is in
   * front, and watching (hidden) on any other tab of the run in front, so a
   * click, key or scroll by the user there is known. Calls made while one is
   * under way are folded into one more after it.
   */
  function syncBar(session) {
    session = rootOf(session);
    const v = session.view;
    if (!v || v.home === null) return;
    if (session.barBusy) { session.barAgain = true; return; }
    session.barBusy = true;
    (async () => {
      do {
        session.barAgain = false;
        await syncBarOnce(session);
      } while (session.barAgain);
    })().catch((e) => console.error("Select to AI bar:", e)).finally(() => { session.barBusy = false; });
  }

  async function syncBarOnce(session) {
    const v = session.view;
    const run = session.run;
    if (!v || v.home === null || !run) return;
    const live = run.status === "running" || run.status === "waiting";
    const ended = !live;
    const tabId = ended ? v.kept : run.tabId;
    const tab = tabId !== null && tabId !== undefined ? await quiet(chrome.tabs.get(tabId)) : null;
    const front = tab ? await frontOf(tab.windowId) : null;
    const frontId = front ? front.id : null;
    const show = !!tab && VIEW.showBar({ home: v.home, tabId: tab.id, front: frontId, live, kept: ended && v.kept === tab.id });
    const line = VIEW.barLine(run);
    const state = { action: "agentBar", show, state: line.state, text: line.text, ended, touched: v.touched, tokens: await tokens(), logo: chrome.runtime.getURL("icon128.png") };
    // The watch goes on the tab in front when it is one of the run's.
    const watchHere = frontId !== null && frontId !== v.home && v.tabs.includes(frontId) && (live || v.kept === frontId);
    for (const id of [...v.watched]) {
      if (id === frontId && watchHere) continue;
      // Hidden, still watching, on the run's other tabs while it is live.
      if (live && v.tabs.includes(id)) send(id, { ...state, show: false });
      else { send(id, { action: "agentBar", off: true }); v.watched = v.watched.filter((x) => x !== id); }
    }
    if (!watchHere) return;
    const ok = await barSend(frontId, { ...state, show: show && frontId === tab.id });
    if (ok && !v.watched.includes(frontId)) { v.watched.push(frontId); await save(session); }
  }

  /** The session whose run's bar or watch is on this tab. */
  function viewOn(tabId) {
    for (const s of sessions.values()) if (s.view && s.view.home !== null && ((s.view.watched || []).includes(tabId) || (s.run && s.run.tabId === tabId))) return s;
    return null;
  }

  /** Takes the user to the agent's page, opening it again if it was closed. */
  async function goHome(session, windowId) {
    const v = session.view;
    const home = v && v.home !== null ? await quiet(chrome.tabs.get(v.home)) : null;
    if (home) {
      await quiet(chrome.tabs.update(home.id, { active: true }));
      quiet(chrome.windows.update(home.windowId, { focused: true }));
      return;
    }
    const made = await quiet(chrome.tabs.create({ url: chrome.runtime.getURL("agent.html"), active: true, ...(windowId !== undefined ? { windowId } : {}) }));
    if (made && v) v.home = made.id;
  }

  // What the bar on a page asks for. Each is answered only for the tab
  // the session's bar or watch is on.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !sender || !sender.tab || !/^agentBar/.test(String(message.action || "")) || (sender.frameId !== 0 && message.action !== "agentBarTouched")) return false;
    const tabId = sender.tab.id;
    // The side panel needs the click's user gesture: it is asked for at once, before anything is awaited.
    if (message.action === "agentBarPanel") {
      let opening = null;
      try { opening = Promise.resolve(chrome.sidePanel.open({ windowId: sender.tab.windowId })); } catch (e) { opening = Promise.reject(e); }
      opening.then(async () => {
        await restore();
        const session = viewOn(tabId);
        await quiet(chrome.storage.local.set({ sidePanelState: { url: chrome.runtime.getURL("agent.html"), selectedText: "", autoSend: false, timestamp: Date.now() } }));
        // The run is followed from the side panel now: no bar, and no going back to the agent's tab.
        if (session) { barOff(session); session.view.home = null; await save(session); }
        sendResponse({ ok: true });
      }, () => sendResponse({ ok: false }));
      return true;
    }
    restore().then(async () => {
      const session = viewOn(tabId);
      if (!session) { sendResponse({ ok: false }); return; }
      const v = session.view;
      if (message.action === "agentBarTouched") { v.touched = true; await save(session); }
      else if (message.action === "agentBarStop") { if (session.run && (session.run.status === "running" || session.run.status === "waiting")) stop(session); }
      else if (message.action === "agentBarHome") await goHome(session, sender.tab.windowId);
      else if (message.action === "agentBarClose") { send(tabId, { action: "agentBar", off: true }); v.watched = v.watched.filter((x) => x !== tabId); if (v.kept === tabId) v.kept = null; await save(session); }
      sendResponse({ ok: true });
    });
    return true;
  });

  // The user's own move to another tab: the agent's page means they are
  // back with the agent; any tab of the run gets its bar or watch.
  chrome.tabs.onActivated.addListener((info) => restore().then(() => {
    for (const s of sessions.values()) {
      const v = s.view;
      if (!v || v.home === null) continue;
      if (info.tabId === v.home && v.touched) { v.touched = false; save(s); }
      if (s.run) syncBar(s);
    }
  }));
  // A page loaded in a tab the bar was on: the bar went with the old page.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "complete") return;
    restore().then(() => {
      for (const s of sessions.values()) {
        const v = s.view;
        if (!v || !(v.watched || []).includes(tabId)) continue;
        v.watched = v.watched.filter((x) => x !== tabId);
        syncBar(s);
      }
    });
  });

  function finished(session) {
    const run = session.run;
    if (RECIPES) RECIPES.end(run);
    session.token += 1;
    if (session.abort) session.abort.abort();
    // An answer the check could not confirm is carried into the conversation with that said.
    if (run.outcome && run.outcome.text) session.turns.push({ role: "assistant", text: `${String(run.outcome.text).slice(0, 4000)}${run.outcome.state === "unconfirmed" && run.outcome.note ? `\n\n(${run.outcome.note})` : ""}` });
    session.turns = session.turns.slice(-12);
    for (const w of [...session.attending.values()]) endAttention(session, w, "ended");
    // Every tab this run or its sub-tasks used is let go: the agent's marks
    // are taken off, and the debugger connection is closed where no other
    // run still works in that tab.
    touch(session, run.tabId);
    for (const id of run.openedTabs || []) touch(session, id);
    for (const r of session.runners.values()) release(r);
    release(session);
    if (!session.ports.size && run.outcome && ["success", "unconfirmed", "error", "limit"].includes(run.outcome.state)) {
      quiet(notice({ type: "basic", iconUrl: "icon128.png", title: run.outcome.state === "success" ? "Task done" : run.outcome.state === "unconfirmed" ? "Task done, not confirmed" : run.outcome.state === "limit" ? "Usage limit reached" : "Task stopped", message: String(run.outcome.text || "").replace(/[*_`#>]/g, "").slice(0, 240) }));
    }
    calm();
    save(session);
    keepAwake();
    if (run.outcome && run.task && ["success", "unconfirmed", "error", "limit", "idle"].includes(run.outcome.state)) {
      // The sidebar's list of recent tasks, each with how it ended.
      quiet(chrome.storage.local.get("agentCrossSessionMemory")).then((res) => {
        const list = [{ task: run.task, subtasks: [], timestamp: Date.now(), outcome: run.outcome.state }, ...(((res && res.agentCrossSessionMemory) || []).filter((x) => x.task !== run.task))].slice(0, 20);
        quiet(chrome.storage.local.set({ agentCrossSessionMemory: list }));
      });
    }
    learn(session, run, null).catch((e) => console.error("Select to AI learning:", e));
    // The user is taken back to the agent's page, or left where they are (core/view.js).
    const viewed = settleView(session, "").catch((e) => console.error("Select to AI view:", e));
    // A task from the address bar the user chose to start after this one.
    const next = (session.queued || []).shift();
    if (next) viewed.then(() => start(session, next.text, next.tabId, next.selection, next.home)).catch((e) => console.error("Select to AI queued task:", e));
  }

  // ---------------------------------------------------------------- learning

  /**
   * After a run, and again if the user says the answer was not right: what
   * it is worth remembering (core/learn.js). One small call, in the
   * background; a failure here costs the user nothing.
   */
  // A run's learning goes one call after another: the user's thumbs can
  // come while the learning from the run's end is still out, and what a
  // thumbs-down takes back must already be written (core/learn.js inTurn).
  const learnInTurn = LEARN.inTurn();
  async function learn(session, run, feedback) {
    learning += 1;
    try { await learnInTurn(run.id, () => learnFrom(session, run, feedback)); } finally { learning -= 1; }
  }

  async function learnFrom(session, run, feedback) {
    await loadMemory();
    const site = TOOLS.siteOf(LEARN.startUrl(run) || (run.history.length && run.history[run.history.length - 1].url) || (session.page && session.page.url) || "");
    // Every note shown to the run, at any step; an older saved run only knows the last step's.
    const used = (run.used && run.used.ids) || session.extras.knownIds || [];
    // What the run's end says about the notes it was shown (core/learn.js):
    // what was shown to a run that was checked and passed helped it; a note
    // a run learned that was shown to one that did not finish may be out of
    // date, and two such ends with no help between them drop it.
    if (!feedback && used.length) {
      const how = LEARN.markOf(run);
      const ids = used.filter((id) => {
        const e = memory.entries.find((x) => x.id === id);
        if (!e) return false;
        if (how === "hurt" && e.source !== "run") return false;
        if (e.kind === "routine" && LEARN.routineFollowed && !LEARN.routineFollowed(run, e)) return false;
        return true;
      });
      if (how && ids.length) await changeMemory({ op: "mark", ids, how });
    }
    // The user's thumbs and the run's end are one decision about the notes
    // the run was shown (core/learn.js feedbackMarks). A thumbs-down also
    // takes back what this same run taught by itself: its route, its notes.
    if (feedback) {
      for (const m of LEARN.feedbackMarks(run, feedback, used.map((id) => memory.entries.find((e) => e.id === id)))) await changeMemory({ op: "mark", ...m });
      if (feedback.up === false) await changeMemory({ op: "forget_run", runId: run.id });
    }
    const learningOn = !session.items || session.items.agentLearning !== false;
    // How it was done, kept for the next request like it. No model call: the
    // run's own steps, by the words on the controls. Kept with the site the
    // steps ran on. At the run's end for a checked answer; on a thumbs-up
    // for one the check gave no verdict on (core/learn.js confirmedBy).
    const routine = learningOn && !memory.paused && site ? LEARN.routineOf(run, feedback) : null;
    if (routine) {
      const scope = LEARN.routineSite(run) || TOOLS.siteOf(LEARN.startUrl(run)) || site;
      const added = await changeMemory({ op: "learn_routine", routine, scope });
      if (added && added.added) post(session, { type: "learned", runId: run.id, changes: [`${added.replaced ? "new steps" : "the steps"} for this request on ${scope}`] });
    }
    const flags = LEARN.worth(run, memory, { learning: learningOn }, feedback);
    if (flags) {
      const m = LEARN.learnMessages(run, memory, site, flags);
      let out = null;
      // What a run was about stays on the connection the run was on: the
      // lite fallback can be another provider's free endpoint.
      try { out = await clientFor().call({ system: m.system, user: m.user, tool: LEARN.LEARNED_TOOL, tier: session.cfg.helperModel ? "helper" : "pro" }, session.cfg); } catch (_e) { out = null; }
      const res = out ? await changeMemory({ op: "learn_apply", run, reply: out.reply, site, flags }) : null;
      if (res && res.changes.length) {
        post(session, { type: "learned", runId: run.id, changes: res.changes });
      }
    }
    await learnContext(session, run, feedback, learningOn);
  }

  /**
   * Lasting facts about the user's life, from what they typed (core/learn.js
   * contextWorth, contextOps): a call only when the run offers something,
   * shown the user's words and never a page; then each fact that their
   * words bear out is put to the same meaning check page text gets (does
   * it speak to an AI?), and kept only when the answer is a clear no.
   */
  async function learnContext(session, run, feedback, learningOn) {
    const gate = LEARN.contextWorth(run, memory, { learning: learningOn }, feedback);
    if (!gate) return;
    const tier = session.cfg.helperModel ? "helper" : "pro";
    const m = LEARN.contextMessages(run, memory, gate);
    let out;
    try { out = await clientFor().call({ system: m.system, user: m.user, tool: LEARN.CONTEXT_TOOL, tier }, session.cfg); } catch (_e) { return; }
    let { ops } = LEARN.contextOps(memory, run, out.reply, gate);
    const texts = ops.filter((o) => o.text).map((o) => o.text);
    if (texts.length) {
      const q = TOOLS.addressedMessages(texts, 300);
      let said = null;
      try { said = TOOLS.readAddressed((await clientFor().call({ system: q.system, user: q.user, tool: q.tool, tier }, session.cfg)).reply); } catch (_e) { said = null; }
      // Kept only on a clear no: an unusable answer, or text that speaks to
      // an AI, keeps nothing new from this run.
      if (!said || said.addressed) ops = ops.filter((o) => !o.text);
    }
    const res = await changeMemory({ op: "learn_context", ops, gate });
    if (res && res.changes.length) post(session, { type: "learned", runId: run.id, changes: res.changes });
  }

  // Learning calls still under way, and what is known: read by the test
  // harness that measures learning, to wait for a run's learning to finish
  // and to see what it left. Nothing in the extension reads it.
  let learning = 0;
  root.__selectToAiMemoryState = async () => ({ learning, store: await loadMemory() });

  // ------------------------------------------------------------ staying awake

  // While a run is working, the worker must not be put to sleep between a
  // request and its reply: a cheap call every 20 seconds keeps it up. A
  // waiting run needs nothing and lets the worker rest.
  /**
   * A held run (a spent allowance, a model that stayed crowded) is tried
   * again: the user said so, or the settings it calls with changed (a
   * backup connected, another model or provider chosen). The settings are
   * read again first, so the call goes to what is connected now.
   */
  async function resumeHeld(session, waitId, by) {
    const held = waitsOf(session.run).filter((w) => w.kind === "pause" && w.hold && (!waitId || w.id === waitId));
    if (!held.length) return false;
    await loadSettings(session);
    // The settings may name a provider the run did not start with. Nothing
    // goes to one the user has not agreed to, or that Chrome does not let
    // the extension reach: the run stays held, and the agent's page asks.
    const need = await notReady(session);
    session.holdNeeds = !!need;
    if (need) {
      post(session, { type: "hold_needs", id: held[0].id, consent: need.consent, hosts: need.hosts });
      return false;
    }
    for (const w of held) enqueue(session, { type: "pause_over", id: w.id, ...(by ? { by } : {}) });
    return true;
  }

  /**
   * What stands between the loaded settings and a request: the providers
   * a call may go to (the one in use, the one it stands in for, a backup
   * it may switch to) that the user has not agreed to send to (setup.js
   * keeps the answer per provider), and those whose host Chrome has not
   * let the extension reach. Null when nothing does.
   */
  async function notReady(session) {
    const cfg = session.cfg || {};
    const names = [...new Set([cfg.provider, cfg.standIn && cfg.standIn.from, cfg.backup].filter(Boolean))];
    const SETUP = root.SELECT_TO_AI_SETUP;
    // Without the record of what was agreed, nothing was.
    if (!SETUP) return { consent: names, hosts: [] };
    const items = session.items || {};
    const store = items[SETUP.CONSENT_KEY] || {};
    const consent = [];
    const hosts = [];
    for (const provider of names) {
      const customUrl = provider === "custom" ? items.agentCustomUrl || root.SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.customUrl : "";
      const id = SETUP.consentId(provider, customUrl);
      if (!id || !SETUP.hasConsent(store, id)) consent.push(provider);
      const origin = SETUP.providerOrigin(provider, customUrl);
      if (origin && GRANTS && !(await GRANTS.hasHost(origin))) hosts.push(provider);
    }
    return consent.length || hosts.length ? { consent, hosts } : null;
  }

  // The settings a model call is made with: the providers, their keys, the model.
  const CALL_SETTING = /^agent(?:ActiveProvider|BackupProvider|Model|HelperModel|CustomUrl|[A-Za-z]+Key)$/;
  // What the next call would be made with. Two settings that give the same are the same to a held run.
  const callWith = (cfg) => JSON.stringify([cfg.provider, cfg.apiKey, cfg.baseUrl, cfg.model, cfg.liteModel, cfg.helperModel, cfg.backup, cfg.keyProblem]);
  if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes) => {
    // The user agreed somewhere (Settings, the agent's page): a run kept held for want of that is tried.
    if (changes && changes.agentDataConsent) {
      for (const s of sessions.values()) if (s.holdNeeds) resumeHeld(s, null, "user").catch((e) => console.error("Select to AI engine:", e));
      return;
    }
    if (!Object.keys(changes || {}).some((k) => CALL_SETTING.test(k))) return;
    // The worker may have been woken by this change: its runs are read back first.
    restore().then(async () => {
      if (![...sessions.values()].some((s) => waitsOf(s.run).some((w) => w.kind === "pause" && w.hold))) return;
      // A held run is tried again only when the change is one its next call
      // would be made with: a backup chosen before it has a key, or another
      // provider's key, costs no request and leaves the wait as it was.
      const items = await storedItems();
      const was = { ...items };
      for (const [k, c] of Object.entries(changes)) { if (c && c.oldValue !== undefined) was[k] = c.oldValue; else delete was[k]; }
      const now = Date.now();
      if (callWith(LLM.settingsFrom(was, now)) === callWith(LLM.settingsFrom(items, now))) return;
      for (const s of sessions.values()) await resumeHeld(s, null, "user");
    }).catch((e) => console.error("Select to AI engine:", e));
  });

  let awake = null;
  function keepAwake() {
    const busy = [...sessions.values()].some((s) => s.run && s.run.status === "running");
    if (busy && !awake) awake = setInterval(() => { quiet(chrome.runtime.getPlatformInfo()); keepAwake(); }, 20000);
    if (!busy && awake) { clearInterval(awake); awake = null; }
    if (chrome.alarms) {
      if (busy) quiet(chrome.alarms.create("agentHeartbeat", { periodInMinutes: 0.5 }));
      else quiet(chrome.alarms.clear("agentHeartbeat"));
    }
  }
  if (chrome.alarms) chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "agentHeartbeat") { restore(); return; }
    if (alarm.name.startsWith("agentResume:")) {
      const [, windowId, waitId] = alarm.name.split(":");
      restore().then(() => {
        const session = sessions.get(Number(windowId));
        const wait = session && waitsOf(session.run).find((w) => w.kind === "pause" && (!waitId || w.id === waitId));
        if (!wait) return;
        // A held run may have had its settings changed while it waited:
        // they are read again, and checked, before it goes on.
        if (wait.hold) resumeHeld(session, wait.id).catch((e) => console.error("Select to AI engine:", e));
        else enqueue(session, { type: "pause_over", id: wait.id });
      });
      return;
    }
    if (alarm.name.startsWith("agentHoldOver:")) {
      const [, windowId, waitId] = alarm.name.split(":");
      restore().then(() => {
        const session = sessions.get(Number(windowId));
        const wait = session && session.run && session.run.status === "waiting" && session.run.wait;
        if (wait && wait.kind === "pause" && wait.hold && wait.id === waitId) enqueue(session, { type: "wrap_up", id: wait.id });
      });
      return;
    }
    if (!alarm.name.startsWith("agentRemind:")) return;
    const windowId = Number(alarm.name.slice(12));
    restore().then(() => {
      const session = sessions.get(windowId);
      const wait = session && waitsOf(session.run).find((w) => w.kind !== "pause");
      if (!wait) return;
      quiet(notice(`agent-wait:${windowId}`, { type: "basic", iconUrl: "icon128.png", title: "Select to AI is still waiting for you", message: String(wait.question || "").slice(0, 240), buttons: wait.tabId !== null && wait.tabId !== undefined ? [{ title: "Go to tab" }] : undefined }));
    });
  });

  // ------------------------------------------------------------------- start

  async function targetTab(session, tabId) {
    const own = chrome.runtime.getURL("");
    if (tabId) { const t = await quiet(chrome.tabs.get(tabId)); if (t) return t; }
    const query = session.windowId > 0 ? { windowId: session.windowId } : { currentWindow: true };
    const [active] = (await quiet(chrome.tabs.query({ ...query, active: true }))) || [];
    if (active && active.url && !active.url.startsWith(own)) return active;
    const all = (await quiet(chrome.tabs.query(query))) || [];
    return all.find((t) => t.url && !t.url.startsWith(own)) || null;
  }

  /**
   * How long a run works before it asks whether to go on: the user's
   * choice of minutes, 0 for never; five minutes when they have made none.
   */
  function checkInMs(items) {
    const v = items.agentCheckInMinutes;
    if (v === undefined || v === null || v === "") return root.SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.checkInMinutes * 60000;
    const minutes = parseFloat(v);
    return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : 0;
  }

  /** A new tab next to the given one, at the browser's new-tab page, for a run to start from. */
  async function openFreshTab(beside) {
    // Behind the user's tab: the run's first action on a page there brings it to front if they follow the run.
    const where = beside ? { windowId: beside.windowId, index: beside.index + 1, active: false } : { active: false };
    return quiet(chrome.tabs.create(where));
  }

  /**
   * Where a run starts when the tab it was given is one the agent cannot
   * work in: the new-tab page or an empty tab is used as it is; any other
   * (a browser page, the Web Store) is left as the user had it, and
   * the run opens a new tab beside it. No tab at all also gets a new one.
   * Returns {tab, openedTab, fromNothing}, with fromNothing null for a web page.
   */
  async function startingPlace(session, tab) {
    if (!tab) {
      const fresh = await quiet(chrome.tabs.create(session.windowId > 0 ? { windowId: session.windowId, active: false } : { active: false }));
      return { tab: fresh || null, openedTab: fresh ? fresh.id : null, fromNothing: fresh ? { from: "blank", url: "", title: "", reused: false } : null };
    }
    const kind = TOOLS.startPageKind(tab.url || tab.pendingUrl || "");
    if (!kind) return { tab, openedTab: null, fromNothing: null };
    if (kind === "newtab" || kind === "blank") return { tab, openedTab: null, fromNothing: { from: kind, url: "", title: "", reused: true } };
    const fresh = await openFreshTab(tab);
    if (!fresh) return { tab, openedTab: null, fromNothing: { from: kind, url: tab.url || "", title: tab.title || "", reused: true } };
    return { tab: fresh, openedTab: fresh.id, fromNothing: { from: kind, url: tab.url || "", title: tab.title || "", reused: false } };
  }

  /** A selection the panel captured with its place, kept to what the run needs. */
  function selectionFrom(sel) {
    if (!sel || typeof sel !== "object" || !String(sel.text || "").trim()) return null;
    const s = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
    return { text: s(sel.text, 2000), title: s(sel.title, 200), url: /^https?:/i.test(String(sel.url || "")) ? String(sel.url).slice(0, 2000) : "", heading: s(sel.heading, 160), passage: s(sel.passage, 1200), row: s(sel.row, 120), column: s(sel.column, 120) };
  }

  async function start(session, text, tabId, selection, home) {
    const items = await loadSettings(session);
    const given = await targetTab(session, tabId);
    const place = await startingPlace(session, given);
    const tab = place.tab;
    // A bar left on a page by the last run goes; this run's view starts.
    barOff(session);
    session.view = newView(home);
    workedIn(session, given && given.id);
    workedIn(session, tab && tab.id);
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const marker = `PAGE-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    // Sites the user named by a well-known name are part of the request.
    const named = [];
    for (const word of String(text).toLowerCase().split(/[^a-z0-9]+/)) { const url = word && TOOLS.knownSiteUrl(word); if (url) named.push(TOOLS.siteOf(url)); }
    session.token += 1;
    session.page = null;
    session.sent = 0;
    session.spawned = {};
    session.run = RUN.newRun({
      id, task: text, tabId: tab ? tab.id : null, startUrl: tab && !place.fromNothing ? tab.url : "", marker, earlierTurns: session.turns.slice(-6), now: Date.now(), trustedSites: named,
      openedTab: place.openedTab, fromNothing: place.fromNothing,
      settings: {
        checkInMs: checkInMs(items), maxActions: session.profile.maxActions, elementLimit: session.profile.lines, pageBudget: session.profile.pageBudget,
        helper: session.helperProfile ? { model: session.cfg.helperModel, maxActions: session.helperProfile.maxActions, elementLimit: session.helperProfile.lines, pageBudget: session.helperProfile.pageBudget } : null,
      },
    });
    if (RECIPES) RECIPES.begin(session.run, chrome);
    // The selection the request is about, as captured when the user chose
    // it; without one, the page's live selection is read at the first look.
    const captured = selectionFrom(selection);
    session.extras = { ...(session.extras || {}), selection: captured ? captured.text : "", selectionPlace: captured, selectionCaptured: !!captured };
    session.turns.push({ role: "user", text });
    post(session, { type: "started", runId: id, task: text, ...(captured ? { selection: captured } : {}) });
    if (session.cfg.keyProblem) { enqueue(session, { type: "model_failed", kind: "config", message: `${session.cfg.keyProblem} Press "Connect" below, then run the task again.` }); return; }
    if (!tab) { enqueue(session, { type: "model_failed", kind: "page", message: "I can't find a web page tab to work in. Open one and try again." }); return; }
    keepAwake();
    enqueue(session, { type: "start" });
    keepAwake();
  }

  function stop(session, text) {
    if (!session.run) return;
    session.token += 1;
    if (session.abort) session.abort.abort();
    // Sub-tasks stop with the run: what they had in hand is dropped.
    for (const r of session.runners.values()) { r.token += 1; if (r.abort) r.abort.abort(); }
    enqueue(session, { type: "stop", text: text || "Stopped." });
  }

  // -------------------------------------------------------------------- port

  function onView(port) {
    let session = null;
    // The agent's page open as a tab of its own: a run it starts is followed
    // from that tab. In the side panel the view has no tab.
    const home = port.sender && port.sender.tab && Number.isInteger(port.sender.tab.id) ? port.sender.tab.id : null;
    // One message at a time, in the order sent: a task queued right after
    // hello is handled once restoring is over, not dropped while it runs.
    let queue = Promise.resolve();
    port.onMessage.addListener((m) => {
      queue = queue.then(() => fromView(m)).catch((e) => console.error("Select to AI port:", e));
      return queue;
    });
    async function fromView(m) {
      if (!m || typeof m !== "object") return;
      if (m.type === "hello") {
        await restore();
        session = sessionFor(Number.isInteger(m.windowId) ? m.windowId : -1);
        session.ports.add(port);
        port.postMessage(snapshot(session));
        session.sent = session.run ? session.run.journal.length : 0;
        port.postMessage({ type: "memory", store: await loadMemory() });
        return;
      }
      if (!session) return;
      const run = session.run;
      const live = run && (run.status === "running" || run.status === "waiting");
      // Held with no time to carry on at: only the user moves it.
      const heldOpen = live && run.status === "waiting" && run.wait && run.wait.kind === "pause" && run.wait.hold && !run.wait.until ? run.wait : null;
      if (m.type === "send") {
        const text = String(m.text || "").trim().slice(0, 4000);
        if (!text) return;
        // A word to a run that will not move by itself would sit unseen:
        // the user is asked what the new request is to do, as for one
        // typed in the address bar.
        if (heldOpen) port.postMessage({ type: "handoff_live", text, tabId: m.tabId, ...(m.selection ? { selection: m.selection } : {}) });
        else if (live) enqueue(session, { type: "steer", text, keep: !!m.keep });
        else await start(session, text, m.tabId, m.selection, home);
      } else if (m.type === "handoff") {
        // A request typed in the address bar is a new task. It never steers
        // or answers a run in progress: with one live here, the user chooses
        // to stop that run for it, or to start it when that run ends.
        const text = String(m.text || "").trim().slice(0, 4000);
        if (!text) return;
        if (!live) await start(session, text, m.tabId, m.selection, home);
        else if (m.choice === "replace") {
          // A held run ends with what it found, as its own stop button ends it.
          if (heldOpen) enqueue(session, { type: "wrap_up", id: heldOpen.id });
          else stop(session, "Stopped for a new task from the address bar.");
          await session.chain;
          await start(session, text, m.tabId, m.selection, home);
        } else if (m.choice === "queue") {
          session.queued = [...(session.queued || []), { text, tabId: m.tabId, home, ...(m.selection ? { selection: m.selection } : {}) }];
          port.postMessage({ type: "handoff_queued", text });
        } else port.postMessage({ type: "handoff_live", text, tabId: m.tabId, ...(m.selection ? { selection: m.selection } : {}) });
      } else if (m.type === "approve" && live) enqueue(session, { type: "approved", id: m.id, always: !!m.always });
      else if (m.type === "decline" && live) enqueue(session, { type: "declined", id: m.id });
      else if (m.type === "done" && live) enqueue(session, { type: "user_done", id: m.id });
      else if (m.type === "skip" && live) enqueue(session, { type: "skipped", id: m.id });
      else if ((m.type === "keep_going" || m.type === "wrap_up") && live) enqueue(session, { type: m.type, id: m.id });
      else if (m.type === "try_again" && live) await resumeHeld(session, m.id, "user");
      else if (m.type === "stop") stop(session, m.text);
      else if (m.type === "feedback" && run && run.id === m.runId && !live && !run.feedback) {
        run.feedback = { up: !!m.up, reason: String(m.reason || "").slice(0, 400) };
        await save(session);
        learn(session, run, run.feedback).catch(() => {});
      }
      else if (m.type === "memory_get") port.postMessage({ type: "memory", store: await loadMemory() });
      else if (m.type === "memory_change") await changeMemory(m.change || {});
      else if (m.type === "memory_apply") {
        // The user ticked what to keep from a run's offer.
        for (const item of m.items || []) {
          if (item.type === "field") await changeMemory({ op: "field", key: item.key, value: item.value, source: "you_filled" });
          else if (item.type === "entry") await changeMemory({ op: "add", entry: { kind: item.kind || "preference", text: item.text, scope: item.scope || "global", source: "you_confirmed" } });
        }
      }
      else if (m.type === "reset") {
        stop(session, "Stopped.");
        session.queued = [];
        await session.chain;
        barOff(session);
        session.view = newView(null);
        session.turns = [];
        session.run = null;
        session.page = null;
        await save(session);
        port.postMessage(snapshot(session));
      }
    }
    port.onDisconnect.addListener(() => { if (session) session.ports.delete(port); });
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "agentView") return;
    if (!root.SELECT_TO_AI_SECURITY.isTrustedExtensionSender(port.sender, chrome.runtime.id)) { port.disconnect(); return; }
    onView(port);
  });

  chrome.tabs.onRemoved.addListener((tabId) => restore().then(() => {
    // A closed tab has nothing left to let go of, and its "real keys off" mark goes with it.
    keyboards.delete(tabId);
    nets.delete(tabId);
    documents.delete(tabId);
    drags.delete(tabId);
    for (const session of sessions.values()) {
      touchedBy(session).delete(tabId);
      for (const r of session.runners.values()) touchedBy(r).delete(tabId);
    }
    for (const session of sessions.values()) {
      const run = session.run;
      if (run && run.tabId === tabId && (run.status === "running" || run.status === "waiting")) { session.token += 1; if (session.abort) session.abort.abort(); enqueue(session, { type: "tab_closed" }); }
      // A sub-task's tab closed by the user ends that sub-task, not the run.
      for (const r of session.runners.values()) {
        const sub = r.run;
        if (sub && sub.tabId === tabId && (sub.status === "running" || sub.status === "waiting")) { r.token += 1; if (r.abort) r.abort.abort(); deliver(r, { type: "tab_closed", token: r.token }); }
      }
    }
  }));

  // A worker that wakes up for any reason picks its runs back up.
  restore();

  /**
   * Drops what is in memory and reads back what was saved: what a worker
   * does when Chrome starts it again. The scripted tests use it to play a
   * worker that was stopped in the middle of a run.
   */
  function wake() {
    for (const s of sessions.values()) {
      s.token += 1;
      if (s.abort) s.abort.abort();
      for (const r of s.runners.values()) { r.token += 1; if (r.abort) r.abort.abort(); }
    }
    sessions.clear();
    restored = null;
    return restore();
  }

  // release and attention are exported for the scripted tests, as wake is.
  root.SELECT_TO_AI_ENGINE = Object.freeze({ sessions, effectOf, wake, loadMemory, changeMemory, release, joinFrame, scan, attention });
})(typeof globalThis !== "undefined" ? globalThis : this);
