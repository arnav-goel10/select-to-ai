/**
 * Select to AI - recipes in the service worker.
 *
 * Recording: while the agent runs, each page action it carries out (click,
 * fill, press, hover, navigate, back) is captured as a recipe step by the
 * recipes recorder (packages/recipes, bundled in vendor/recipes-core.js),
 * with a snapshot before and after, through the extension driver
 * (driver.js). The action itself is the agent's own: the recorder is handed
 * it to run, so the agent's run does not change. A run that did something a
 * recipe cannot repeat (another tab, a frame, a drag, the user's saved
 * details) is marked as not saveable, with why. Where the requests a press
 * sent cannot be seen (no debugger), a press that may have saved, sent or
 * deleted something is recorded as a commit step (mayHaveWritten).
 *
 * When a run ends, what can be saved of it (the compiled recipe, or why
 * there is none) is kept in session storage, so "Save as recipe" still
 * works, or still says why not, after the service worker restarted.
 *
 * Replay: a saved recipe runs in a tab of its own with no model call; a
 * changed page is repaired under the step's contract with the user's
 * configured provider, on its cheap ("lite") model, or on the run's own
 * model where the cheap one is a free router or a gateway's guess
 * (tierFor). A commit step (one that submits, sends, pays or deletes)
 * whose meaning changed stops the run and is never pressed: no approver is given, so the core stops for a person.
 *
 * The panel talks to this over a port named "recipesView".
 */
(function initRecipes(root) {
  "use strict";

  const CORE = root.SELECT_TO_AI_RECIPES_CORE;
  const DRIVER = root.SELECT_TO_AI_RECIPES_DRIVER;
  const need = (name) => root[name] || null;

  const STORE = "recipesStore";
  const MAX_RECIPES = 50;
  const RECEIPTS_KEPT = 5;
  const RECORDINGS_KEPT = 4;
  const FRAME_BASE = 100000;
  // Actions that only look: nothing to repeat.
  const LOOKS = new Set(["scroll", "wait", "look", "read", "find", "recall", "remember"]);
  const REPEATS = new Set(["click", "fill", "press", "hover", "navigate", "back"]);
  const COMMIT_KINDS = new Set(["pay", "send", "delete"]);
  const CHECKS = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  // What can be saved of the last few ended runs, in session storage.
  const DRAFTS = "recipeDrafts";
  const GONE = "its recording is no longer kept (the browser or the extension restarted before the run ended, or newer runs took its place)";
  const SAVED = "it is already saved as a recipe";

  const recordings = new Map(); // runId -> recording
  let host = null; // the chrome object, for a run that ends with no recording
  const running = new Map(); // tabId -> {recipeId, stop}
  const isWeb = (url) => /^https?:/.test(url || "");
  const clip = (t, n) => { const v = String(t == null ? "" : t).replace(/\s+/g, " ").trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
  const firstLine = (e) => clip(String((e && e.message) || e).split("\n")[0], 240);

  /* ------------------------------------------------------------- recording */

  /** A recording for a run that is starting in a tab. */
  function begin(run, chrome) {
    if (!CORE || !DRIVER || !run || !run.id) return;
    host = chrome;
    const r = {
      runId: run.id, task: run.task || "", tabId: run.tabId, chrome,
      broken: "", steps: 0, started: false, pending: null, ended: null, at: Date.now(),
      network: run.tabId !== null && run.tabId !== undefined ? DRIVER.createNetworkView(chrome, run.tabId) : null,
    };
    if (r.tabId === null || r.tabId === undefined) r.broken = "the run had no tab to work in";
    const base = r.network ? DRIVER.createDriver({ chrome, tabId: r.tabId, network: r.network }) : null;
    // The recorder's driver: everything as the extension driver does it, but
    // the action is the one the agent is carrying out.
    r.sees = !!(r.network && r.network.sees);
    r.driver = base && {
      ...base,
      act: async () => {
        const p = r.pending;
        r.pending = null;
        return p ? p() : { ok: false, error: "no action of the agent's is waiting" };
      },
    };
    r.vars = {};
    r.secrets = {};
    r.rec = base ? new CORE.Recorder(r.driver, { vars: r.vars, secrets: r.secrets, title: clip(run.task, 120), request: clip(run.task, 500) }) : null;
    recordings.set(run.id, r);
    // Only the last few runs can be saved.
    const ids = [...recordings.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - RECORDINGS_KEPT))) drop(id);
  }

  function drop(runId) {
    const r = recordings.get(runId);
    if (r && r.network) r.network.close();
    recordings.delete(runId);
  }

  /** The agent's commit-like judgment of an action, as its own risk checks see it. */
  function judgedCommit(a, page) {
    const POLICY = need("SELECT_TO_AI_POLICY");
    const TOOLS = need("SELECT_TO_AI_TOOLS");
    if (!POLICY || !TOOLS || !page) return false;
    const el = (page.elements || []).find((e) => e.id === a.ref) || null;
    const risky = POLICY.asRiskAction(a, el);
    if (!risky) return false;
    try {
      const risk = TOOLS.actionRisk(risky, page, null);
      if (risk && COMMIT_KINDS.has(risk.kind)) return true;
      // A button whose effect its words do not make plain is held as a commit.
      return !!TOOLS.pressCheckOf(risky, page);
    } catch (_) { return false; }
  }

  const flat = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

  /**
   * Whether the page reads differently after a recorded step than before
   * it: another address, other words on the page, another announcement, or
   * the box the step was in emptied or gone. A new line typed into a box
   * changes none of these.
   */
  function changedAfter(entry) {
    const b = (entry && entry.before) || {};
    const a = (entry && entry.after) || {};
    if (String(a.url || "") !== String(b.url || "")) return true;
    if (flat(a.text) !== flat(b.text)) return true;
    if (flat((a.notices || []).join(" ")) !== flat((b.notices || []).join(" "))) return true;
    const el = entry && entry.el;
    if (!el || entry.ref === undefined || entry.ref === null) return false;
    const now = (a.elements || []).find((e) => e.ref === entry.ref);
    if (!now) return true;
    const holds = (e) => flat(e.value !== undefined ? e.value : e.text);
    return holds(now) !== holds(el);
  }

  /**
   * Whether a recorded press may have saved, sent or deleted something, for
   * a recording that cannot see requests. The shipped build has no
   * debugger, so "it sent no write" is not something it ever observed; a
   * press is then taken to have written unless the recording itself shows
   * otherwise:
   *   - it is inside a search form;
   *   - it is on a field (a click there only focuses or opens it; a tick
   *     inside a form is committed by that form's own submit);
   *   - it is a link the browser followed, to another address or to a
   *     place on the same page.
   * Anything else, a script-driven Save, Apply or Remove button above all,
   * is recorded as a commit step: replayed as recorded, and stopped for the
   * user when the page around it has changed.
   *
   * Enter is the other way a script sends: in a message box or an editor
   * that no form holds, or with nothing in focus that the recording knows.
   * There Enter may also be only a new line, so it is a commit step when
   * the page read differently afterwards (changedAfter), unless the box is
   * one the page itself calls a search box.
   */
  function mayHaveWritten(entry) {
    const a = (entry && entry.action) || {};
    const el = entry && entry.el;
    const key = a.do === "press" ? String(a.key || "") : "";
    const enter = /^enter$/i.test(key);
    if (!el) return enter && changedAfter(entry);
    if (!(a.do === "click" || enter || /^( |space|spacebar)$/i.test(key))) return false;
    if (el.form && el.form.search) return false;
    const field = !!el.editable || el.tag === "textarea" || el.tag === "select" || (el.tag === "input" && !/^(button|submit|reset|image)$/.test(el.inputType || ""));
    if (field) {
      if (CHECKS.has(el.kind)) return !el.form;
      const typedIn = el.tag !== "select" && el.kind !== "searchbox" && el.inputType !== "search";
      return enter && typedIn && !el.form && changedAfter(entry);
    }
    if (el.kind === "link" && /^https?:/i.test(el.href || "")) {
      const page = (u) => String(u || "").split("#")[0];
      const before = String((entry.before && entry.before.url) || "");
      const after = String((entry.after && entry.after.url) || "");
      if (page(after) !== page(before)) return false;
      // The same page at the place the link names: the browser followed it there.
      if (after !== before && after === el.href && /#./.test(el.href)) return false;
    }
    return true;
  }

  function labelOf(a, page) {
    const TOOLS = need("SELECT_TO_AI_TOOLS");
    const el = page && (page.elements || []).find((e) => e.id === a.ref);
    return el && TOOLS ? String(TOOLS.elementLabel(el) || "") : "";
  }

  /** The recorder call for one agent action. */
  function recorderCall(r, a, page) {
    const commit = judgedCommit(a, page) ? { class: "commit" } : {};
    switch (a.do) {
      case "navigate": return r.rec.goto(a.url);
      case "back": return r.rec.back();
      case "click": return r.rec.click({ agentId: a.ref }, commit);
      case "hover": return r.rec.hover({ agentId: a.ref });
      case "press": return a.ref === undefined || a.ref === null ? r.rec.press(null, a.key, commit) : r.rec.press({ agentId: a.ref }, a.key, commit);
      case "fill": {
        const value = String(a.value == null ? "" : a.value);
        if (!value) return r.rec.fill({ agentId: a.ref }, value, commit);
        // A typed value becomes a variable, with what was typed as its example.
        const known = Object.entries(r.vars).find(([, v]) => v === value);
        let name = known ? known[0] : "";
        if (!name) {
          name = CORE.snakeName(labelOf(a, page) || "value", new Set(Object.keys(r.vars)));
          r.vars[name] = value;
          r.rec.vars[name] = value;
        }
        return r.rec.fill({ agentId: a.ref }, `{${name}}`, commit);
      }
      default: return Promise.reject(new Error(`${a.do} cannot be recorded`));
    }
  }

  /**
   * Runs one of the agent's actions (`perform`), recording it when the run
   * is being recorded. Returns what `perform` returns, always: recording
   * never changes or stops the agent's run.
   */
  async function around(session, a, perform) {
    const run = session && session.run;
    const r = run && !session.parent ? recordings.get(run.id) : null;
    if (!r || r.broken || !r.rec || !a) return perform();
    if (LOOKS.has(a.do)) return perform();
    const details = "it filled in your saved details, which a recipe does not keep";
    const tabs = "it worked in more than one tab, and a recipe works in one";
    const why = a.do === "fill_details" ? details
      : a.do === "tabs" ? tabs
        : a.do === "click_at" ? "it pressed a spot on the page by where it was, not a control with a name, which a recipe cannot repeat"
          : a.do === "delegate" ? "it handed part of the work to a helper run, which a recipe does not record"
            : !REPEATS.has(a.do) ? `it used ${String(a.do).replace(/_/g, " ")}, which a recipe cannot repeat`
          : run.tabId !== r.tabId ? tabs
            : Number(a.ref) >= FRAME_BASE ? "it worked inside a frame of the page (a page within the page), where a recipe cannot reach"
              : a.from ? details : "";
    if (why) { r.broken = why; return perform(); }
    let result;
    let acted = false;
    const doIt = async () => {
      acted = true;
      const mark = r.network ? r.network.mark() : 0;
      result = await perform();
      const requests = r.network ? r.network.since(mark).filter((x) => /^(xhr|fetch|document)$/i.test(x.type)).map((x) => ({ method: x.method, url: x.url })) : [];
      return { ok: !!(result && result.ok), error: result && !result.ok ? clip(result.message, 200) : undefined, settleMs: (result && result.settleMs) || 0, requests, downloads: [] };
    };
    try {
      // The page the run started on is the recipe's first step.
      if (!r.started) {
        r.started = true;
        if (a.do !== "navigate") {
          const tab = await r.chrome.tabs.get(r.tabId);
          if (!tab || !isWeb(tab.url)) throw new Error("the run did not start on a web page");
          r.pending = async () => ({ ok: true, settleMs: 0, requests: [], downloads: [] });
          await r.rec.goto(tab.url);
        }
      }
      r.pending = doIt;
      await recorderCall(r, a, session.page);
      r.steps++;
      // No view of what the press sent: when the recording cannot tell, it is a commit.
      const taped = r.rec.tape[r.rec.tape.length - 1];
      if (!r.sees && taped && mayHaveWritten(taped)) taped.declaredClass = "commit";
    } catch (e) {
      r.pending = null;
      // The recorder stops on an action that failed; a failed action changed nothing to repeat.
      if (acted && result && !result.ok) return result;
      r.broken = `a step could not be recorded (${firstLine(e).replace(/^record: /, "")})`;
    }
    return acted ? result : perform();
  }

  /**
   * The run ended: a successful one can be saved. What can be saved of it
   * is also kept past a restart of the worker (keep).
   */
  function end(run) {
    const r = run && recordings.get(run.id);
    if (!r) {
      // The worker restarted while the run was going, and took the steps
      // recorded so far with it. (A draft already kept for the run stands.)
      const lost = { runId: run && run.id, at: Date.now(), why: "the extension restarted while the run was going, so its steps were not all recorded" };
      if (run && run.id && !run.sub && host) drafts(host, (list) => (list.some((d) => d.runId === run.id) ? list : [lost, ...list])).catch(() => {});
      return;
    }
    const state = run.outcome && run.outcome.state;
    r.ended = state || "ended";
    if (r.network) { r.network.close(); r.network = null; }
    if (state !== "success" && !r.broken) r.broken = state === "unconfirmed" ? "the run's answer was not confirmed" : "the run did not finish";
    r.keeping = keepRecording(r).catch(() => {});
  }

  /** Whether a recorded run can be saved; when not, why, in words the user is shown. */
  function saveable(runId) {
    const r = recordings.get(runId);
    if (!r) return { ok: false, why: GONE };
    if (r.saved) return { ok: false, why: SAVED, saved: r.saved };
    if (!r.ended) return { ok: false, why: "the run is still going", pending: true };
    if (r.broken) return { ok: false, why: r.broken };
    // Nothing to repeat is not something lost: the view says nothing of it.
    if (!r.steps) return { ok: false, why: "the run did nothing on a page to repeat", nothing: true };
    return { ok: true, steps: r.steps };
  }

  /* ------------------------------------------------- kept past a restart */

  // The worker's memory goes when Chrome stops it, which it does soon after
  // a run ends. What "Save as recipe" needs is therefore also kept in
  // session storage (in memory only, gone when the browser closes): for a
  // run that can be saved, its compiled recipe; for one that cannot, why.
  // A secret typed in the run is not in a compiled recipe (it is a variable
  // the user supplies), so none is kept here either.
  let draftChain = Promise.resolve();

  /** Reads the kept drafts, newest first; with `change`, writes what it returns. One at a time. */
  function drafts(chrome, change) {
    const area = chrome && chrome.storage && chrome.storage.session;
    if (!area) return Promise.resolve([]);
    const step = draftChain.then(async () => {
      const got = await area.get(DRAFTS);
      const list = got && Array.isArray(got[DRAFTS]) ? got[DRAFTS] : [];
      if (!change) return list;
      const next = change(list).slice(0, RECORDINGS_KEPT);
      await area.set({ [DRAFTS]: next });
      return next;
    });
    draftChain = step.catch(() => {});
    return step;
  }

  const keep = (chrome, draft) => drafts(chrome, (list) => [draft, ...list.filter((d) => d.runId !== draft.runId)]);

  async function keepRecording(r) {
    if (!(r.chrome && r.chrome.storage && r.chrome.storage.session)) return;
    const can = saveable(r.runId);
    const draft = { runId: r.runId, at: Date.now() };
    if (can.ok) {
      try { draft.recipe = r.rec.compile(); draft.steps = can.steps; } catch (e) { draft.why = firstLine(e); }
    } else {
      draft.why = can.why;
      if (can.nothing) draft.nothing = true;
    }
    try { await keep(r.chrome, draft); } catch (_) {
      // Too large for session storage: after a restart, at least the reason is known.
      if (draft.recipe) await keep(r.chrome, { runId: r.runId, at: draft.at, why: "its recording was too large to keep after the extension restarted" }).catch(() => {});
    }
  }

  /** saveable(), for a run whose recording the worker no longer holds. */
  function fromDraft(d) {
    if (!d) return { ok: false, why: GONE };
    if (d.saved) return { ok: false, why: SAVED, saved: d.saved };
    if (d.why || !d.recipe) return { ok: false, why: d.why || GONE, ...(d.nothing ? { nothing: true } : {}) };
    return { ok: true, steps: d.steps || d.recipe.steps.length };
  }

  /** Whether a run can be saved, from the worker's memory or from what was kept of it. */
  async function canSave(chrome, runId) {
    const r = recordings.get(runId);
    if (r) { if (r.keeping) await r.keeping; return saveable(runId); }
    return fromDraft((await drafts(chrome).catch(() => [])).find((d) => d.runId === runId));
  }

  /* --------------------------------------------------------------- storage */

  async function load(chrome) {
    const got = await chrome.storage.local.get(STORE);
    const s = got && got[STORE];
    return s && Array.isArray(s.recipes) ? s : { recipes: [] };
  }
  async function store(chrome, s) {
    await chrome.storage.local.set({ [STORE]: s });
  }

  /** A receipt as kept: without the recipe it carries (the recipe is kept once). */
  const keptReceipt = (receipt) => { const { recipe: _r, ...rest } = receipt; return rest; };

  async function saveRun(chrome, runId, title) {
    const r = recordings.get(runId);
    const kept = r ? null : (await drafts(chrome).catch(() => [])).find((d) => d.runId === runId);
    const can = r ? saveable(runId) : fromDraft(kept);
    if (!can.ok) return can;
    let recipe;
    if (r) { try { recipe = r.rec.compile(); } catch (e) { return { ok: false, why: firstLine(e) }; } } else recipe = kept.recipe;
    if (title) recipe.title = clip(title, 120);
    recipe.provenance = { ...recipe.provenance, source: "agent_run", author: "you" };
    const s = await load(chrome);
    s.recipes = [{ recipe, savedAt: Date.now(), runId, receipts: [] }, ...s.recipes].slice(0, MAX_RECIPES);
    await store(chrome, s);
    // Saved once: the recording is let go, and that it was saved is remembered.
    if (r) { r.saved = recipe.id; r.rec = null; r.driver = null; }
    await keep(chrome, { runId, at: Date.now(), saved: recipe.id }).catch(() => {});
    return { ok: true, id: recipe.id };
  }

  /** What the list shows of a recipe. */
  function summary(entry) {
    const rc = entry.recipe;
    const last = entry.receipts && entry.receipts[0];
    return {
      id: rc.id, title: rc.title, sites: rc.sites, state: rc.state, savedAt: entry.savedAt,
      steps: rc.steps.length,
      variables: rc.variables.map((v) => ({ name: v.name, type: v.type, example: v.type === "secret" ? "" : v.example || "", enum: v.enum || null })),
      commits: rc.steps.filter((x) => x.class === "commit").map((x) => x.intent),
      origins: [...new Set(rc.steps.filter((x) => x.action.do === "navigate" && !/[{}]/.test(x.action.url)).map((x) => { try { return new URL(x.action.url).origin; } catch (_) { return ""; } }).filter((o) => /^https?:/.test(o)))],
      last: last ? { state: last.end.state, why: last.end.why, at: last.endedAt } : null,
      receipts: entry.receipts || [],
    };
  }

  /* ---------------------------------------------------------------- replay */

  /**
   * The tier a repair or meaning check asks. Most providers have a cheap
   * model of their own. On OpenRouter that cheap model is the free router,
   * and on a custom gateway it is whatever the gateway serves, so a user
   * who chose a paid model there gets the run's own model instead.
   */
  function tierFor(cfg) {
    if (cfg.provider === "custom") return "pro";
    const free = (m) => !m || m === "openrouter/free" || /:free$/.test(m);
    return cfg.provider === "openrouter" && !free(cfg.model) ? "pro" : "lite";
  }

  /** The user's configured provider, on the model tierFor picks, as a recipes model client. */
  function modelFrom(cfg, deps) {
    const LLM = need("SELECT_TO_AI_LLM");
    if (!cfg || cfg.keyProblem || (!LLM && !deps.client)) return null;
    const client = deps.client || LLM.createClient({
      fetch: (...x) => fetch(...x),
      chatgptToken: (force) => root.SELECT_TO_AI_CHATGPT_CONNECT.accessToken(force),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      now: () => Date.now(),
      log: () => {},
    });
    const tier = tierFor(cfg);
    const asked = tier === "pro" ? cfg.model : cfg.liteModel;
    return {
      name: cfg.provider,
      model: asked,
      async complete(req) {
        const out = await client.call({ system: req.system, user: req.user, tool: { name: "answer", description: "Your answer, as the fields of this tool.", parameters: req.schema }, tier }, cfg);
        const u = out.usage || {};
        const usage = { provider: cfg.provider, model: u.model || out.model || asked, inTok: u.prompt || 0, outTok: u.completion || 0, usd: u.cost || 0 };
        if (!out.reply || typeof out.reply !== "object") throw Object.assign(new Error("the model gave no answer"), { usage });
        return { json: out.reply, usage };
      },
    };
  }

  async function settings(chrome) {
    const sync = (await chrome.storage.sync.get(null)) || {};
    const local = (await chrome.storage.local.get(null)) || {};
    return { ...sync, ...local };
  }

  /**
   * Runs a saved recipe in a new tab beside `besideTabId`. Returns
   * {ok, receipt} with the receipt as kept, or {ok:false, why}.
   */
  async function runRecipe(chrome, id, vars, o = {}) {
    const s = await load(chrome);
    const entry = s.recipes.find((e) => e.recipe.id === id);
    if (!entry) return { ok: false, why: "That recipe is not saved any more." };
    const items = await settings(chrome);
    const SECURITY = need("SELECT_TO_AI_SECURITY");
    const LLM = need("SELECT_TO_AI_LLM");
    const allow = items.agentDomainAllowlist || "";
    // The sites the user allows the agent to use hold for recipes too.
    const outside = allow && SECURITY ? entry.recipe.steps.filter((x) => x.action.do === "navigate" && !SECURITY.isUrlAllowedByDomains(CORE.fill(x.action.url, vars || {}), allow)) : [];
    if (outside.length) return { ok: false, why: `This recipe opens a site outside the ones you allow the agent to use (${clip(allow, 80)}).` };
    let tab;
    try {
      const here = o.besideTabId !== undefined ? await chrome.tabs.get(o.besideTabId).catch(() => null) : null;
      tab = await chrome.tabs.create({ url: "about:blank", active: o.active !== false, ...(here ? { windowId: here.windowId, index: here.index + 1 } : {}) });
    } catch (e) { return { ok: false, why: `A tab could not be opened: ${firstLine(e)}` }; }
    const cfg = LLM ? LLM.settingsFrom(items, Date.now()) : null;
    const model = o.model || modelFrom(cfg, o);
    const driver = o.driver || DRIVER.createDriver({ chrome, tabId: tab.id });
    running.set(tab.id, { recipeId: id });
    let out;
    try {
      out = await CORE.runReplay(driver, entry.recipe, {
        vars: vars || {},
        repair: model ? { model } : false,
        onEvent: (e) => { if (o.onEvent) o.onEvent(e); },
      });
    } catch (e) {
      running.delete(tab.id);
      return { ok: false, why: `The recipe could not run: ${firstLine(e)}`, tabId: tab.id };
    }
    running.delete(tab.id);
    const receipt = keptReceipt(out.receipt);
    const after = await load(chrome);
    const at = after.recipes.findIndex((e) => e.recipe.id === id);
    if (at >= 0) {
      after.recipes[at] = { ...after.recipes[at], recipe: out.recipe, receipts: [receipt, ...(after.recipes[at].receipts || [])].slice(0, RECEIPTS_KEPT) };
      await store(chrome, after);
    }
    return { ok: true, receipt, tabId: tab.id, model: model ? model.model : "" };
  }

  /* ------------------------------------------------------------------ port */

  function onPort(chrome, port) {
    port.onMessage.addListener(async (m) => {
      if (!m || typeof m !== "object") return;
      const reply = (x) => { try { port.postMessage({ ...x, re: m.type, rid: m.rid }); } catch (_) { /* the view closed */ } };
      try {
        if (m.type === "can_save") {
          // The answer is shown a moment before the run is wound up.
          const id = String(m.runId || "");
          for (let i = 0; i < 40 && recordings.has(id) && !recordings.get(id).ended; i++) await new Promise((res) => setTimeout(res, 100));
          reply(await canSave(chrome, id));
        }
        else if (m.type === "save") reply(await saveRun(chrome, String(m.runId || ""), m.title));
        else if (m.type === "list") reply({ recipes: (await load(chrome)).recipes.map(summary) });
        else if (m.type === "delete") {
          const s = await load(chrome);
          s.recipes = s.recipes.filter((e) => e.recipe.id !== m.id);
          await store(chrome, s);
          reply({ ok: true });
        } else if (m.type === "run") {
          const vars = m.vars && typeof m.vars === "object" ? m.vars : {};
          const res = await runRecipe(chrome, String(m.id || ""), vars, {
            besideTabId: Number.isInteger(m.tabId) ? m.tabId : undefined,
            onEvent: (e) => {
              const fx = e.effect;
              if (fx && (fx.type === "act" || fx.type === "model")) {
                try { port.postMessage({ type: "progress", rid: m.rid, what: fx.type === "model" ? `Checking with ${fx.purpose === "meaning" ? "a meaning check" : "a repair"}` : `Step ${fx.step || ""}`.trim() }); } catch (_) { /* closed */ }
              }
            },
          });
          reply(res);
        }
      } catch (e) {
        reply({ ok: false, why: firstLine(e) });
      }
    });
  }

  function install(chrome) {
    host = chrome;
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "recipesView") return;
      const SECURITY = need("SELECT_TO_AI_SECURITY");
      if (!SECURITY || !SECURITY.isTrustedExtensionSender(port.sender, chrome.runtime.id)) { port.disconnect(); return; }
      onPort(chrome, port);
    });
  }

  const api = Object.freeze({ begin, around, end, saveable, canSave, saveRun, mayHaveWritten, changedAfter, runRecipe, summary, modelFrom, tierFor, install, load, _recordings: recordings });
  root.SELECT_TO_AI_RECIPES = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
