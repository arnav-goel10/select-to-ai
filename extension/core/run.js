/**
 * Select to AI - a run, as a state machine.
 *
 * A run is one request from the user, carried through to an answer. It is
 * plain data: it can be saved after every step, read back after the browser
 * has put the extension to sleep, and continued from where it was. Nothing
 * here touches the browser. `advance(run, event, env)` takes what just
 * happened, updates the run, and returns the things to do next (effects);
 * the driver (engine.js) does them and reports back with the next event.
 *
 *   start -> observe -> [observed] -> model -> [model_replied] -> act ...
 *        -> [acted] -> ... -> observe -> ... -> done -> (verify) -> end
 *
 * A run that needs the user (a question, an approval, a sign-in) waits in
 * place: status "waiting", with what it is waiting for in run.wait. The
 * user's reply is one more event, and the same run goes on.
 *
 * The functions are deterministic: the clock and ids come in through env.
 */
(function initRun(root) {
  "use strict";

  const need = (name, file) => root[name] || (typeof require === "function" ? require(file) : null);
  const TOOLS = need("SELECT_TO_AI_TOOLS", "../agentTools.js");
  const STEP = need("SELECT_TO_AI_STEP", "./step.js");
  const CONTEXT = need("SELECT_TO_AI_CONTEXT", "./context.js");
  const POLICY = need("SELECT_TO_AI_POLICY", "./policy.js");
  const KNOWN = need("SELECT_TO_AI_KNOWN", "./memory.js");

  const clip = (t, n) => {
    const v = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  };

  // The text of the pages the run read, kept for checking the quotes in its
  // answer, by total size: the oldest page's text goes first. A page as the
  // page reader gives it is at most about 80,000 characters
  // (agentContentScript.js), and most are far less, so this holds ten pages
  // at that size and a dozen-product comparison with room to spare. The run
  // is saved to the browser's session storage after every step (10 MB for
  // the whole extension); at up to three bytes a character this stays under
  // a quarter of it.
  const SEEN_BUDGET = 800000;
  const DROPPED_KEPT = 50; // pages whose text was let go, named in the feedback on a quote
  const SEEN_URLS = 1500; // addresses seen on pages, for "did the agent make this address up"
  const INVALID_LIMIT = 3; // unusable replies in a row before the run gives up on the model
  const EVIDENCE_ROUNDS = 2;
  const VERIFY_ROUNDS = 2;
  const TRAIL = 24; // recent actions kept, for finding a round of actions the run keeps going
  const OPINION_MISSES = 2; // second opinions without a usable answer before the run stops asking
  // Pages that hide a sentence from people are asked about at most this
  // many times a run (each ask covers every new hidden sentence on the
  // page). Hidden text is left out of what the model reads, so the answer
  // only tells the model what kind of page it is on and keeps the run from
  // teaching anything: past the limit, nothing is lost but that fact.
  const ADDRESSED_ASKS = 3;
  // A run goes on while it gets somewhere. It stops by itself only when it
  // has gone this many steps in a row in difficulty that shows nothing came
  // of them (difficulty below), with the helper taking at least one of them
  // when there is one. Difficulty is measured once a round of up to three
  // actions has been gone twice; six more steps is that longest round gone
  // twice again, with the facts saying so each time. A long run that keeps
  // reaching new pages, or keeps changing the page, never counts.
  const STUCK_STEPS = 6;
  // Wandering: a run that keeps moving between pages without getting
  // nearer an answer, which the counts above miss because each step goes
  // through. Read on 122 runs of 65 unseen tasks on live sites (October 2026;
  // gpt-oss-20b with a helper, 28 failures, and nemotron-ultra alone, 19):
  // 14 runs drifted for up to 63 steps and the stuck stop fired once. A run
  // is wandering when at least REVISITS of its last REVISIT_WINDOW steps
  // arrived at a page it had already been on (asking for the address it is
  // on again counts), or when at least SEARCHES of its last SEARCH_WINDOW
  // steps were searches and none of those steps made progress. Progress is
  // a new page that is not search results, the next page of the same
  // search's results, a first read of more of a page's text, or a note
  // added. Measured per action on those runs, the two together caught 8 of
  // the 9 small-model wanderers and all 5 strong-model ones, and fired on
  // two runs that passed, one of which had itself gone round before
  // passing. tests/bench/progress-replay.js replays the rule as it is
  // counted here, per step.
  //
  // Wandering is stated once when it begins, and gives the helper one spell
  // of steps (below); when the helper hands back the window starts empty,
  // so it is stated again only if the run wanders again. It does not count
  // toward the stuck stop: a paired run of 60 unseen tasks (October 2026)
  // had it end a run that was paging through results to the answer, and a
  // helper chosen again at every step while the window stayed bad took up
  // to 7 steps with nothing to show for them.
  const REVISIT_WINDOW = 8;
  const REVISITS = 4;
  const SEARCH_WINDOW = 10;
  const SEARCHES = 4;
  // Once the helper takes a step, it keeps taking them until one of its
  // steps makes progress or it has taken this many. On those runs a helper
  // that took one step and handed back was undone by the main model at
  // least 7 times, and the run failed right after 17 times. Three is the
  // longest round of actions the run looks for (cycleOf), so the helper has
  // room to leave one. A spell brought by wandering ends at this many even
  // when its own steps fail.
  const HELPER_STEPS = 3;
  // How long a run works before it asks the user whether to go on, unless
  // the settings say otherwise (agentCheckInMinutes; 0 is never).
  const CHECK_IN_MS = 5 * 60000;
  // A longer gap between two events of a working run is the computer
  // asleep, not work: no model call, page read or action normally takes as
  // long (a model that says nothing for 75 seconds is given up on, llm.js).
  // Only this much of such a gap is counted as working.
  const GAP_MS = 2 * 60000;
  // A guard against runaway cost, not a setting: this many model calls in a
  // run pauses it with the same question as the check-in. The longest
  // errand the agent is built for, a dozen products compared, takes about
  // eighty (five or so steps a product, the search, the checks); this is
  // over twice that, and reaching it costs one press to go on.
  const MAX_CALLS = 200;
  // A provider that turns requests away and names no wait: the run pauses
  // this long, twice as long each time after, up to the longest.
  const PAUSE_FIRST_MS = 2 * 60000;
  const PAUSE_LONGEST_MS = 30 * 60000;
  // Pauses in a row, with no answer from the provider between them, end the
  // run past this many, or past this long in all: it ends with what it found.
  const PAUSES_IN_ROW = 4;
  const PAUSED_IN_ROW_MS = 60 * 60000;
  // Waits for what only the user can do on the page. Two of the same on a
  // page that did not change between them are the run going round.
  const HANDOFFS = new Set(["sign_in", "human_check", "code", "payment"]);
  // Sub-tasks (delegate) that run at the same time; more wait their turn.
  // Each makes about one model call per step, and a step's call takes 2.5
  // to 3.2 seconds on a small model (effortOf below) with as long again on
  // the page, so a sub-task makes roughly ten calls a minute. Free tiers
  // allow about 20 requests a minute (OpenRouter's free models), so three
  // at once sit at that limit and a fourth would only add refusals. A
  // refusal pauses the sub-task it reached and no other (pause below), so
  // the others go on. Each also holds a tab: a heavy shop page takes a few
  // hundred megabytes, which three keep within what a laptop spares.
  // These are estimates from the step times above, not a measurement of
  // three sub-tasks running together.
  const SUBS_AT_ONCE = 3;
  // A sub-task asks nothing about time or model calls: the run that handed
  // it out counts both, for all of its sub-tasks together.
  const SUB_CEILING = Number.MAX_SAFE_INTEGER;
  // How much of each sub-task's answer the run that handed it out is shown,
  // and how many sub-task results it keeps in view.
  const SUB_ANSWER = 2000;
  const SUBS_SHOWN = 8;

  /**
   * @param o {id, task, tabId, startUrl, marker, earlierTurns, now,
   *           trustedSites, openedTab, fromNothing: {from, url, title, reused},
   *           settings: {checkInMs, maxActions, elementLimit, pageBudget,
   *                      helper: {model, maxActions, elementLimit, pageBudget}}}
   */
  function newRun(o) {
    const s = o.settings || {};
    // A sub-task (o.sub: {parent, request}) runs on the user's request: the
    // sites it names, what it allows and forbids. Its own instruction was
    // written by the model that handed it out, and adds no trust.
    const sub = o.sub && o.sub.parent ? { parent: String(o.sub.parent), request: String(o.sub.request || "") } : null;
    const sites = [...TOOLS.sitesNamedIn(sub ? sub.request : o.task)];
    if (o.startUrl && /^https?:/.test(o.startUrl)) sites.push(TOOLS.siteOf(o.startUrl));
    for (const site of o.trustedSites || []) sites.push(site);
    const own = { maxActions: s.maxActions || 5, elementLimit: s.elementLimit || 160, pageBudget: s.pageBudget || 3600 };
    const h = s.helper && s.helper.model ? s.helper : null;
    return {
      id: o.id,
      task: String(o.task || ""),
      marker: o.marker || "PAGE-000000",
      earlierTurns: o.earlierTurns || [],
      status: "running",
      step: 0,
      // Time spent working (model calls, page reads, actions), not waiting
      // for the user; the clock is when the last event came.
      activeMs: 0,
      clock: o.now || 0,
      checkInMs: sub ? 0 : s.checkInMs === undefined ? CHECK_IN_MS : Math.max(0, s.checkInMs || 0),
      nextCheckIn: sub ? 0 : s.checkInMs === undefined ? CHECK_IN_MS : Math.max(0, s.checkInMs || 0),
      checkIns: 0,
      callCeiling: sub ? SUB_CEILING : MAX_CALLS,
      // For a sub-task: the run that handed it out, and the user's request.
      sub,
      request: sub ? sub.request : null,
      // An address a sub-task was given to start at: its first action,
      // decided by the same rules as any other.
      firstMove: o.firstMove || null,
      // Sub-tasks this run handed out, the delegate action they answer
      // while they run, and their results, shown with the page after.
      children: [],
      delegation: null,
      delegated: [],
      // Steps in a row taken in difficulty that shows nothing came of them, and how many the helper took.
      stuck: { steps: 0, helper: 0, at: 0 },
      // Why the next step is the last: the user asked for the answer now, or the run is going round.
      wrapUp: null,
      pauses: 0,
      // Pauses since the provider last answered, and how long they were in all.
      pausedInRow: { n: 0, ms: 0 },
      // Sites the user would not let the agent onto, by origin, for this run.
      declinedSites: [],
      // The last hand-off to the user: its kind, the page it was on, how many in a row.
      handoff: null,
      // What the step in hand is shown and may do: the main model's, or the helper's on its steps.
      maxActions: own.maxActions,
      elementLimit: own.elementLimit,
      pageBudget: own.pageBudget,
      mainLimits: own,
      // A stronger model on the same connection. It takes the steps where
      // the run is in difficulty, and checks the answer.
      helper: h ? { model: String(h.model), maxActions: h.maxActions || own.maxActions, elementLimit: h.elementLimit || own.elementLimit, pageBudget: h.pageBudget || own.pageBudget } : null,
      by: "main",
      lastStepOk: true,
      sentBack: false,
      steps: 0,
      helperSteps: 0,
      finalStep: false,
      // The model's notes: each step's note added with its step number, or
      // the whole replaced when it rewrites them (step.js mergeNotes).
      memory: "",
      notesCut: 0,
      // A note left out because the notes were at their limit, by its length.
      notesRefused: 0,
      // Whether the model has been asked to rewrite notes past their room:
      // "ask" on the step it is asked, "asked" after, "" while within it.
      notesFull: "",
      history: [],
      notice: "",
      steers: [],
      facts: { repeats: 0, unchanged: 0, failures: 0, invalid: 0, cycle: null },
      // What each step reached (progressOf below): pages arrived at, which
      // were pages already visited, searches, notes added; and whether the
      // run is wandering by the measure above.
      progress: newProgress(),
      // The helper's steps since it took over, and what it was told it did when it handed back.
      spell: null,
      handBack: "",
      handBacks: [],
      // A quote in the answer that was in nothing the run read: the run is in difficulty for the next step.
      quoteRejected: false,
      lastSignature: "",
      trail: [],
      lastPrint: "",
      visits: {},
      seen: [],
      dropped: [],
      reads: [],
      labels: {},
      previous: null,
      tabId: o.tabId === undefined ? null : o.tabId,
      openedTabs: o.openedTab !== undefined && o.openedTab !== null ? [o.openedTab] : [],
      // Set when the run began where the agent cannot work (the new-tab
      // page, a browser page, the Web Store, an error page): what it
      // began on, whether that tab was reused, and, once a web page has been
      // read, left: true.
      fromNothing: o.fromNothing || null,
      trust: { sites: [...new Set(sites.filter(Boolean))], urls: [] },
      current: null,
      queue: [],
      wait: null,
      waits: 0,
      // What the user typed in this run (their answers and additions), what
      // they may want kept, and which of their details were used.
      said: [],
      answers: [],
      // Each answer with the question it answered, for learning what lasts.
      asked: [],
      keep: [],
      injectionSeen: false,
      // Hidden sentences already asked about, and whether each speaks to an AI (null: no answer).
      addressed: {},
      addressedAsks: 0,
      pendingAddressed: null,
      offers: [],
      // `ids` and `kinds`: every note shown to the model in this run, and of
      // which kind; `first`: what its first step was shown.
      used: { details: [], notes: 0, ids: [], kinds: {}, first: null },
      waitSnapshot: null,
      evidenceRounds: 0,
      verifyRounds: 0,
      pendingDone: null,
      // The answer shown while it is being checked ({text, at}), and when
      // the first answer of any kind was shown, for measuring.
      provisional: null,
      firstAnswerAt: 0,
      // Each model call: what it was for, the model, its time and tokens.
      calls: [],
      usage: { prompt: 0, completion: 0, cached: 0, cacheWrite: 0, cost: 0, estimated: false, calls: 0, models: [] },
      outcome: null,
      journal: [],
      // Second opinions on presses and one-box forms, by site and control
      // or form, and the text the step in hand put in boxes, by ref.
      opinions: {},
      pendingOpinion: null,
      opinionMisses: 0,
      typed: {},
      startedAt: o.now || 0,
      endedAt: 0,
    };
  }

  // ---------------------------------------------------------------- journal
  // What the user can see of a run, in order. The panel draws itself from
  // these entries, so a panel opened halfway through shows the whole run.

  const log = (run, role, title, text, fold) => run.journal.push({ k: "log", role, title, text: String(text || ""), fold: !!fold });
  // A line kept in the saved log and the trace but not drawn as a step:
  // something the run did for itself that changed nothing for the user.
  const quietLog = (run, role, title, text) => run.journal.push({ k: "log", role, title, text: String(text || ""), fold: false, quiet: true });
  const status = (run, role, text) => run.journal.push({ k: "status", role, text });

  function fingerprint(page) {
    const visible = String(page.visibleText || "");
    let h = 0;
    for (let i = 0; i < visible.length; i++) h = (Math.imul(h, 31) + visible.charCodeAt(i)) | 0;
    return `${String(page.url || "").split("#")[0]}|${(page.elements || []).length}|${String(page.innerText || "").length}|${h}`;
  }

  // ------------------------------------------------------------------ steps

  /**
   * Everything a page put in front of the model: its text, its outline and
   * what was on screen, the words on its controls and the names of the
   * cards and groups they sit in. A menu's entries are often in no
   * paragraph of the page, a card's name is read from all of the card at
   * once, and the outline names headings past where a long page's text was
   * cut: a quote taken from any of these is as real as one from the text.
   */
  function shownText(page) {
    const p = page || {};
    const labels = [];
    const groups = new Set();
    let used = 0;
    for (const el of p.elements || []) {
      // The line as it was listed, so a quote copied from the listing is found whole.
      const label = TOOLS.elementLabel(el) ? TOOLS.formatElementLine(el) : "";
      if (label && used <= 30000) { labels.push(label); used += label.length + 1; }
      if (el.group && used <= 30000 && !groups.has(el.group)) { groups.add(el.group); used += String(el.group).length + 1; }
    }
    const outline = (p.outline || []).map((h) => String((h && h.text) || "")).filter(Boolean);
    return [String(p.innerText || ""), outline.join("\n"), String(p.visibleText || ""), labels.join("\n"), [...groups].join("\n")].filter(Boolean).join("\n");
  }

  /**
   * The first look found the start tab unusable (a page that failed to
   * load): the engine moved the run to a new tab, which the run opened.
   */
  function startedOver(run, moved) {
    if (moved.tabId !== undefined && moved.tabId !== null) run.tabId = moved.tabId;
    if (moved.openedTab !== undefined && moved.openedTab !== null && !run.openedTabs.includes(moved.openedTab)) run.openedTabs = [...run.openedTabs, moved.openedTab];
    run.fromNothing = moved.fromNothing || run.fromNothing;
  }

  function onObserved(run, page, env) {
    const fx = [];
    if (run.status !== "running") return fx;
    // The run has a web page in front of it: it no longer starts from nothing.
    if (run.fromNothing && !run.fromNothing.left && !page.protectedPage && /^https?:/i.test(String(page.url || ""))) run.fromNothing = { ...run.fromNothing, left: true };
    // The user is asked whether to go on after a stretch of work, and after
    // a great many model calls, before the next step is taken. The page is
    // looked at again once they have said, so this look counts for nothing.
    if (!run.wrapUp && run.checkInMs > 0 && run.activeMs >= run.nextCheckIn) return checkIn(run, fx, env, "time");
    if (!run.wrapUp && run.usage.calls >= run.callCeiling) return checkIn(run, fx, env, "calls");
    page.blockers = POLICY.blockersOf(page);
    // Sentences the page hides from people looking at it (agentContentScript.js
    // leaves them out of the reading) are put to a narrow question, by
    // meaning and in any language: does one speak to an AI? Pages with no
    // hidden sentence, most of them, cost nothing.
    const judged = run.addressed || (run.addressed = {});
    const unjudged = (page.unseen || []).filter((p) => !Object.prototype.hasOwnProperty.call(judged, p));
    if (unjudged.length && (run.addressedAsks || 0) < ADDRESSED_ASKS) return askAddressed(run, unjudged);
    page.injection = (page.unseen || []).some((p) => judged[p] === true);
    // A run that met text aimed at AI assistants teaches nothing afterwards.
    if (page.injection) run.injectionSeen = true;

    const print = fingerprint(page);
    run.facts.unchanged = run.lastPrint && print === run.lastPrint ? run.facts.unchanged + 1 : 0;
    run.lastPrint = print;
    const address = String(page.url || "").split("#")[0];
    // Asking for an address again counts as arriving there again, even when the tab was already on it.
    const asked = !!(run.progress && run.progress.askedAt && run.progress.askedAt === run.step);
    if (address && (asked || !run.previous || String(run.previous.url || "").split("#")[0] !== address)) run.visits[address] = (run.visits[address] || 0) + 1;

    // What the run has read, kept so a quote in the answer can be checked.
    if (page.url && page.innerText) keepSeen(run, page);
    // Every address a page showed, and the page itself, are addresses the
    // agent did not make up.
    // Where a search form on the page sends is the page's own address
    // too: its results, for any words, are what typing in the form gives.
    const searches = (page.forms || []).filter((f) => f.search && f.action).map((f) => f.action);
    if (run.trust.urls.length < SEEN_URLS) {
      const known = new Set(run.trust.urls);
      for (const u of [page.url, ...(page.elements || []).map((el) => el.url), ...searches]) {
        if (u && !known.has(u) && known.size < SEEN_URLS) { known.add(u); run.trust.urls.push(u); }
      }
    }
    // Kept apart too: only a search form's address takes other query values (agentTools.js addressOrigin).
    run.trust.searches = run.trust.searches || [];
    for (const u of searches) if (!run.trust.searches.includes(u) && run.trust.searches.length < SEEN_URLS) run.trust.searches.push(u);
    // Labels by ref, so a ref from before a redraw can be pointed to its new number.
    if (!run.previous || String(run.previous.url || "").split("#")[0] !== address) run.labels = {};
    for (const el of page.elements || []) run.labels[el.id] = TOOLS.elementLabel(el);
    // The user typed something into the page while the run waited for them:
    // a detail the profile lacks is offered to them to keep, once the run is over.
    if (run.waitSnapshot) {
      if (env.memory && run.waitSnapshot.url === page.url) {
        for (const f of KNOWN.userFilled(run.waitSnapshot, page, env.memory)) {
          if (!run.offers.some((o) => o.type === "field" && o.key === f.key)) run.offers.push({ type: "field", ...f });
        }
      }
      run.waitSnapshot = null;
    }
    // Text read with `read` belongs to the page it was read from.
    run.reads = run.reads.filter((r) => r.url === page.url);

    run.step += 1;
    progressOf(run, page, address);
    const d = difficulty(run);
    if (!d.circling) run.stuck = { steps: 0, helper: 0, at: run.step };
    else if (!run.wrapUp && run.stuck.steps >= STUCK_STEPS && (!run.helper || run.stuck.helper > 0)) {
      // Going round, with the helper's steps among them: it will not get out by itself.
      run.wrapUp = { by: "stuck", why: d.why, steps: run.stuck.steps };
      log(run, "system", "Not Getting Anywhere", `${run.stuck.steps} steps in a row without getting anywhere (${d.why}). The next step is the last.`);
    } else if (run.stuck.at !== run.step) {
      run.stuck = { steps: run.stuck.steps + 1, helper: run.stuck.helper + (takerOf(run).by === "helper" ? 1 : 0), at: run.step };
    }
    run.finalStep = !!run.wrapUp;
    if (run.firstMove && !run.finalStep) {
      // The address the sub-task was given is opened as its first action,
      // under the same rules as a navigate the model chose.
      const first = run.firstMove;
      run.firstMove = null;
      run.previous = { url: page.url || "", visibleText: page.visibleText || "" };
      run.current = { step: run.step, goal: "Open the address it was given", actions: [], url: page.url || "" };
      run.queue = [first];
      log(run, "executor", `Step ${run.step}`, run.current.goal);
      return next(run, page, env, fx);
    }
    return askModel(run, page, env, fx);
  }

  /**
   * Keeps the text of the page just read, newest last, within the budget:
   * the oldest page's text is let go first, and its address is kept, so a
   * quote from it can be said to be one that could not be checked.
   */
  function keepSeen(run, page) {
    keepText(run, { url: page.url, title: page.title || "", digest: TOOLS.digestPage(page.innerText, 600), text: shownText(page).slice(0, SEEN_BUDGET) });
  }

  /** One page's kept text ({url, title, digest, text}), within the budget. */
  function keepText(run, entry) {
    run.seen = run.seen.filter((p) => p.url !== entry.url);
    run.seen.push(entry);
    let total = run.seen.reduce((n, p) => n + p.text.length, 0);
    while (total > SEEN_BUDGET && run.seen.length > 1) {
      const gone = run.seen.shift();
      total -= gone.text.length;
      run.dropped = [...(run.dropped || []).filter((p) => p.url !== gone.url), { url: gone.url, title: gone.title }].slice(-DROPPED_KEPT);
    }
    run.dropped = (run.dropped || []).filter((p) => !run.seen.some((x) => x.url === p.url));
  }

  /** "5 minutes", "1 minute", "40 seconds". */
  function duration(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
    const m = Math.round(s / 60);
    // A hold for a day's allowance is hours long.
    if (m >= 120) return `about ${Math.round(m / 60)} hours`;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }

  /**
   * The run has worked for a stretch, or made a great many model calls:
   * it waits for the user to say whether to go on. Going on keeps
   * everything the run has (its history, notes and what it read); not
   * going on gives the model one last step to answer with what it has.
   */
  function checkIn(run, fx, env, why) {
    run.checkIns += 1;
    const question = why === "calls"
      ? `I have made ${run.usage.calls} model calls on this so far, which is a lot for one task.`
      : `I have been working on this for ${duration(run.activeMs)}.`;
    log(run, "system", "Checking In", question);
    return waitFor(run, fx, env, { kind: "check_in", reason: why, question, notes: run.memory || "", active: run.activeMs, calls: run.usage.calls, period: run.checkInMs });
  }

  /** The user's choice at a check-in: go on with the same run, or answer now. */
  function onCheckIn(run, event, env) {
    const w = run.wait;
    if (run.status !== "waiting" || !w || w.kind !== "check_in" || (event.id && event.id !== w.id)) return [];
    run.status = "running";
    run.wait = null;
    run.journal.push({ k: "ask_done", id: w.id, how: event.type });
    if (event.type === "keep_going") {
      if (run.checkInMs > 0 && run.activeMs >= run.nextCheckIn) run.nextCheckIn = run.activeMs + run.checkInMs;
      if (run.usage.calls >= run.callCeiling) run.callCeiling = run.usage.calls + MAX_CALLS;
      log(run, "system", "Keep Going", "You chose to keep going.");
      status(run, "executor", "Carrying on…");
      // Sub-tasks at work take the steps they were holding.
      if (run.delegation) {
        const fx = [];
        for (const c of run.children) { for (const f of c.held) fx.push({ type: "child_fx", child: c.id, fx: f }); c.held = []; }
        return fx;
      }
    } else {
      run.wrapUp = { by: "user" };
      log(run, "system", "Answer Now", "You asked for the answer now, with what has been found so far.");
      status(run, "executor", "Writing the answer…");
      // Sub-tasks stop and bring back what they had; the answer follows.
      if (run.delegation) return stopChildren(run, env, [], "you asked for the answer now.");
    }
    return [{ type: "observe" }];
  }

  /**
   * Why the run is in difficulty, from what it has measured, with whether
   * that difficulty shows nothing came of the steps (circling). The same
   * action on the same page whose page did change, as paging a list in
   * place does, is difficulty enough for the helper to look, and not
   * circling. The repeats and failures are the ones the model is told
   * about in its facts (context.js).
   */
  function difficulty(run) {
    const f = run.facts;
    if (f.repeats >= 2) return { why: "the same action was repeated with nothing to show for it", circling: true };
    if (f.cycle && f.cycle.rounds >= 2) return { why: `the same ${f.cycle.size} actions were gone round ${f.cycle.rounds} times with the page back as it was`, circling: true };
    if (f.failures >= 2) return { why: "the last two steps each ended with an action that failed", circling: true };
    if (f.invalid > 0) return { why: "the last reply could not be used", circling: true };
    if (run.handoff && run.handoff.n >= 2 && run.handoff.print === run.lastPrint) return { why: "the user was asked for the same thing twice on a page that did not change", circling: true };
    if (run.sentBack) return { why: "the check sent the answer back", circling: true };
    if (run.quoteRejected) return { why: "a quote in the answer was not in anything the run had read", circling: true };
    const failed = run.progress && run.progress.failedAsk;
    if (failed) return { why: `the same address was asked for ${failed.n} times and failed each time`, circling: failed.n >= 3 };
    // Two finds in a row that matched nothing: the model may not know how
    // the page words what it wants. The helper looks; it is not going round.
    if ((f.misses || 0) >= 2) return { why: `the last ${f.misses} finds in a row matched nothing on the page`, circling: false };
    if (f.same >= 3) return { why: `the same action was taken on the same page ${f.same} times in a row`, circling: false };
    return { why: "", circling: false };
  }

  // ---------------------------------------------------------------- progress

  const squash = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim().toLowerCase();

  /** The values of an address's query, decoded and in lower case. */
  function queryValues(address) {
    try {
      return [...new URL(address).searchParams.values()].map(squash).filter(Boolean);
    } catch (_e) {
      return [];
    }
  }

  /** The parts of an address's path, decoded and in lower case. */
  function pathParts(u) {
    return u.pathname.split("/").map((x) => { try { return squash(decodeURIComponent(x.replace(/\+/g, " "))); } catch (_e) { return squash(x); } }).filter(Boolean);
  }

  /**
   * Whether an address is a search's results, told by structure: it carries
   * a query and is where a search form seen in this run sends, or a value
   * of its query, or a part of its path, is text the run typed (into a box,
   * or into an address it wrote itself).
   */
  function isSearchAddress(p, address) {
    let u;
    try { u = new URL(address); } catch (_e) { return false; }
    if (u.search && (p.searchForms || []).includes(`${u.origin}${u.pathname}`)) return true;
    const typed = new Set(p.typed || []);
    return queryValues(address).some((v) => typed.has(v)) || pathParts(u).some((v) => typed.has(v));
  }

  /**
   * Text the run itself typed, kept so a results address can be told by
   * carrying it: what was put in a box, and the query values in an address
   * the model wrote that are several words, or words of the request. Any
   * other one-word value in a written address is as often a choice (a size,
   * a page number) as a query.
   */
  function typedText(p, a, request) {
    const add = (v) => { const t = squash(v); if (t.length >= 2 && !p.typed.includes(t)) p.typed = [...p.typed, t].slice(-40); };
    if (a.do === "fill" && !a.from && a.value !== undefined) add(a.value);
    if ((a.do === "navigate" || (a.do === "tabs" && a.op === "open")) && a.url) {
      const asked = new Set(CONTEXT.wordsOf(request));
      for (const v of queryValues(a.url)) {
        const words = CONTEXT.wordsOf(v);
        if (words.length >= 2 || (words.length === 1 && words[0].length >= 3 && asked.has(words[0]))) add(v);
      }
    }
  }

  /** A search box: a box marked as one, or a box in a form the page marks as a search. */
  function isSearchBox(page, ref) {
    const el = ((page && page.elements) || []).find((e) => e.id === ref);
    if (!el) return false;
    if (el.role === "searchbox" || el.inputType === "search") return true;
    const form = el.formId !== undefined ? ((page && page.forms) || []).find((f) => f.id === el.formId) : null;
    return !!(form && form.search);
  }

  /** A new run's record of what its steps reached (progressOf below). */
  function newProgress() {
    return {
      at: 0, last: "", steps: [], searchForms: [], typed: [],
      // The step that searched, added a note, asked for an address, read new text, or pressed another page of results.
      searchedAt: 0, notedAt: 0, askedAt: 0, readAt: 0, pagedAt: 0,
      // Text already read with `read`, by page and part; search results arrived at, newest last.
      readParts: [], results: [],
      // Steps after this one make up the window wandering is measured on (it starts empty when the helper hands back).
      from: 0,
      // Whether the run is wandering now; the wandering to state at the next step (once), and the helper spell it is owed.
      wander: null, news: null, due: null, fired: [],
      // Addresses asked for, with how each request failed; the one to state at the next step.
      asks: [], failedAsk: null,
    };
  }

  const isNumber = (v) => /^\d{1,6}$/.test(String(v == null ? "" : v));

  /**
   * Whether `next` is another page of the same results as `from`, told by
   * the address alone: the same site and path with one query value that is
   * a number changed or added, the same path with one part a number in
   * both, or the path with a number added at its end.
   */
  function nextPageOf(from, next) {
    let a;
    let b;
    try { a = new URL(from); b = new URL(next); } catch (_e) { return false; }
    if (a.origin !== b.origin || a.href.split("#")[0] === b.href.split("#")[0]) return false;
    if (a.pathname === b.pathname) {
      const keys = new Set([...a.searchParams.keys(), ...b.searchParams.keys()]);
      const changed = [...keys].filter((k) => a.searchParams.getAll(k).join("\n") !== b.searchParams.getAll(k).join("\n"));
      return changed.length === 1 && isNumber(b.searchParams.get(changed[0])) && (!a.searchParams.has(changed[0]) || isNumber(a.searchParams.get(changed[0])));
    }
    if (a.search !== b.search) return false;
    const pa = a.pathname.split("/").filter(Boolean);
    const pb = b.pathname.split("/").filter(Boolean);
    if (pa.length === pb.length) {
      const diff = pa.map((_x, i) => i).filter((i) => pa[i] !== pb[i]);
      return diff.length === 1 && isNumber(pa[diff[0]]) && isNumber(pb[diff[0]]);
    }
    // "/search/shoes" to "/search/shoes/2" or "/search/shoes/page/2".
    return pb.length > pa.length && pb.length - pa.length <= 2 && pa.every((x, i) => x === pb[i]) && isNumber(pb[pb.length - 1]);
  }

  /** A control that pages through results by its shape: a number, or arrows alone. */
  const pagerLabel = (label) => /^\s*(?:\d{1,4}|[›»→>⟩❯]+)\s*$/.test(String(label || ""));

  /** Whether a step's record shows progress: a new page, the next page of results, new text read, or a note. */
  const madeProgress = (x) => !!(x && (x.newPage || x.paged || x.read || x.note));

  /**
   * After an action: the text it typed, whether it put words in a search
   * box, asked for an address (and how that failed), read text not read
   * before, or pressed a control that pages through results it was on.
   */
  function searched(run, a, r, page) {
    const p = run.progress;
    if (!p) return;
    typedText(p, a, run.request || run.task);
    if (r.ok && a.do === "fill" && !a.from && isSearchBox(page, a.ref)) p.searchedAt = run.step;
    if (r.ok && (a.do === "navigate" || (a.do === "tabs" && a.op === "open")) && a.url) requested(run, p, a, r);
    if (r.ok && a.do === "read" && r.read && r.read.text) {
      const key = `${String(r.read.url || "").split("#")[0]} ${r.read.label || ""}`;
      if (!p.readParts.includes(key)) { p.readParts = [...p.readParts, key].slice(-200); p.readAt = run.step; }
    }
    const here = String((page && page.url) || "").split("#")[0];
    if (r.ok && a.do === "click" && p.results.includes(here) && pagerLabel(run.labels[a.ref])) p.pagedAt = run.step;
  }

  /**
   * An address asked for: counted, by the address without its fragment,
   * with how each request in a row failed (an error, an error status, or a
   * redirect), so asking again for one that keeps failing is stated.
   */
  function requested(run, p, a, r) {
    p.askedAt = run.step;
    const url = String(a.url).split("#")[0];
    const how = CONTEXT.arrivalFailure(r.arrival || {});
    const before = p.asks.find((x) => x.url === url);
    const now = how ? { url, n: ((before && before.n) || 0) + 1, hows: [...((before && before.hows) || []), how] } : { url, n: 0, hows: [] };
    p.asks = [...p.asks.filter((x) => x.url !== url), now].slice(-50);
    // A redirect is a failure only when it is the same one each time.
    const kinds = [...new Set(now.hows)];
    const redirects = kinds.every((k) => /^a redirect/.test(k));
    if (now.n >= 2 && (!redirects || kinds.length === 1)) p.failedAsk = { url, n: now.n, hows: kinds };
  }

  /**
   * The rule measured above, on the steps' records ({revisit, search,
   * newPage, paged, read, note}), newest last: {rule, count, of} or null.
   */
  function wanderingOf(steps) {
    const recent = (steps || []).slice(-REVISIT_WINDOW);
    const back = recent.filter((x) => x.revisit).length;
    if (back >= REVISITS) return { rule: "revisits", count: back, of: recent.length };
    const last = (steps || []).slice(-SEARCH_WINDOW);
    const searches = last.filter((x) => x.search).length;
    if (searches >= SEARCHES && !last.some(madeProgress)) return { rule: "searches", count: searches, of: last.length };
    return null;
  }

  /** Why wandering brings the helper in, in words. */
  const wanderWhy = (w) => (w.rule === "revisits"
    ? `${w.count} of the last ${w.of} steps arrived at pages already visited in this run`
    : `${w.count} of the last ${w.of} steps were searches, and none of them made progress`);

  /**
   * What the step that just ended reached, recorded once per step when the
   * page after it is looked at: whether it arrived at an address (asking
   * for the one it was on counts), and whether that was a page already
   * visited, a search's results, or the next page of results it was on;
   * whether it searched, read text it had not read, or added a note.
   */
  function progressOf(run, page, address) {
    const p = run.progress || (run.progress = newProgress());
    if (p.at === run.step) return;
    p.at = run.step;
    const ended = run.step - 1;
    if (ended >= 1) {
      const arrived = !!address && (address !== p.last || p.askedAt === ended);
      const revisit = arrived && (run.visits[address] || 0) > 1;
      const paged = arrived
        ? !revisit && (p.pagedAt === ended || (p.results || []).some((u) => nextPageOf(u, address)))
        : p.pagedAt === ended;
      const results = arrived && (paged || isSearchAddress(p, address));
      if (results) p.results = [...p.results.filter((u) => u !== address), address].slice(-20);
      const rec = {
        step: ended,
        ...(arrived ? { url: clip(address, 300) } : {}),
        revisit,
        search: (results && !paged) || p.searchedAt === ended,
        newPage: arrived && !revisit && !results,
        note: p.notedAt === ended,
        ...(paged ? { paged: true } : {}),
        ...(p.readAt === ended ? { read: true } : {}),
      };
      if (run.by === "helper" && run.helper) rec.by = "helper";
      p.steps.push(rec);
      // The helper's run of steps: one of them that makes progress ends it.
      if (run.by === "helper" && run.spell) {
        run.spell.steps += 1;
        if (madeProgress(rec)) run.spell.progressed = true;
      }
      // Measured on the steps since the helper last handed back. Stated
      // once when it begins, and owed one helper spell.
      const was = p.wander;
      p.wander = wanderingOf(p.steps.filter((x) => x.step > (p.from || 0)));
      if (p.wander && !was) {
        p.fired.push({ step: run.step, ...p.wander });
        p.news = p.wander;
        if (run.helper) p.due = p.wander;
      }
    }
    p.last = address || p.last;
    // Where this page's search forms send: an arrival there later is a search's results.
    for (const f of (page && page.forms) || []) if (f.search && f.action && !p.searchForms.includes(f.action)) p.searchForms = [...p.searchForms, f.action].slice(-50);
  }

  /**
   * The helper hands the run back: what it did in its steps, and what it
   * wrote down, said once to the main model as a fact. The wandering
   * window starts again from here.
   */
  function handBack(run) {
    const s = run.spell;
    run.spell = null;
    if (!s || !run.helper) return;
    const p = run.progress;
    if (p) {
      p.from = run.step - 1;
      p.wander = null;
      p.due = null;
    }
    const mine = (run.history || []).filter((h) => h.step >= s.from && h.by === run.helper.model);
    if (!mine.length) return;
    const first = mine[0].step;
    const last = mine[mine.length - 1].step;
    const did = mine.map((h) => `${h.step}. ${clip(h.goal, 100) || "(no goal given)"}: ${h.actions.map((x) => `${x.text}: ${x.ok ? "" : "FAILED. "}${clip(x.result, 160)}`).join("; ")}`).join("\n");
    const notes = mine.filter((h) => h.note).map((h) => `"${clip(h.note, 300)}"`);
    const reached = ((p && p.steps) || []).filter((x) => x.step >= first && x.step <= last && x.newPage).map((x) => x.url);
    run.handBack = [
      `The helper model took ${first === last ? `step ${first}` : `steps ${first} to ${last}`} and has handed back to you. What it did:\n${did}`,
      notes.length ? `It added to your notes: ${notes.join(" ")}` : "It added nothing to your notes.",
      reached.length ? `It reached ${reached.length === 1 ? "a new page" : "new pages"}: ${reached.map((u) => clip(u, 160)).join(", ")}.` : "It reached no new page.",
    ].join("\n");
    run.handBacks = [...(run.handBacks || []), { from: first, to: last, steps: mine.length, progressed: s.progressed, ...(s.wander ? { wander: true } : {}) }];
  }

  /** Why the run is in difficulty, or "" when it is not. */
  const inDifficulty = (run) => difficulty(run).why;

  /**
   * Who takes the step in hand: the main model, unless the run is in
   * difficulty. A helper whose own step did not go through keeps the next
   * one; a helper keeps the steps until one makes progress or it has taken
   * HELPER_STEPS. Wandering, when it begins, gives the helper one spell of
   * at most HELPER_STEPS steps.
   */
  function takerOf(run) {
    const main = { by: "main", why: "" };
    if (!run.helper) return main;
    const why = inDifficulty(run);
    if (why) return { by: "helper", why };
    const s = run.spell;
    const keep = (n) => `none of its ${n} step${n === 1 ? "" : "s"} so far has made progress (it takes up to ${HELPER_STEPS})`;
    if (run.by === "helper" && s && s.wander) return !s.progressed && s.steps < HELPER_STEPS ? { by: "helper", why: keep(s.steps) } : main;
    if (run.by === "helper" && !run.lastStepOk) return { by: "helper", why: "its own last step did not go through" };
    if (run.by === "helper" && s && !s.progressed && s.steps < HELPER_STEPS) return { by: "helper", why: keep(s.steps) };
    const due = run.progress && run.progress.due;
    if (due) return { by: "helper", why: wanderWhy(due), wander: true };
    return main;
  }

  /** Keeps which notes from memory the model is shown, for the user and for marking them afterwards. */
  function noteShown(run, extras) {
    const u = run.used;
    if (!u.ids) Object.assign(u, { ids: [], kinds: {}, first: null });
    const shown = extras.knownShown || (extras.knownIds || []).map((id) => ({ id, kind: "" }));
    if (!u.first) u.first = { ids: shown.map((e) => e.id), kinds: shown.map((e) => e.kind), siteNotes: clip(extras.siteNotes || "", 2000) };
    for (const e of shown) {
      if (u.ids.includes(e.id)) continue;
      u.ids.push(e.id);
      if (e.kind) u.kinds[e.kind] = (u.kinds[e.kind] || 0) + 1;
    }
  }

  function askModel(run, page, env, fx) {
    status(run, "executor", run.step === 1 ? "Looking at the page…" : `Step ${run.step}…`);
    const taker = takerOf(run);
    if (taker.by === "helper") log(run, "system", "Helper Model", `${run.helper.model} takes step ${run.step}: ${taker.why}.`);
    else if (run.by === "helper") log(run, "system", "Main Model", `Step ${run.step} goes back to the main model.`);
    // Wandering's spell is taken now, once; a helper already at work starts it from where it is.
    if (taker.wander) {
      run.spell = { from: run.by === "helper" && run.spell ? run.spell.from : run.step, steps: 0, progressed: false, wander: true };
      run.progress.due = null;
    } else if (taker.by === "helper" && (run.by !== "helper" || !run.spell)) run.spell = { from: run.step, steps: 0, progressed: false };
    else if (taker.by === "main" && run.by === "helper") handBack(run);
    run.by = taker.by;
    // How hard to think is settled while the difficulty that brought this step is still known.
    const effort = effortOf(run);
    run.sentBack = false;
    run.quoteRejected = false;
    // The step is built for the model that takes it.
    const limits = taker.by === "helper" ? run.helper : run.mainLimits;
    if (limits) {
      run.maxActions = limits.maxActions;
      run.elementLimit = limits.elementLimit;
      run.pageBudget = limits.pageBudget;
    }
    const messages = CONTEXT.stepMessages(run, page, { ...(env.extras || {}), now: env.now });
    // Asked once to rewrite notes past their room; the facts still say how long they are.
    if (run.notesFull === "ask") run.notesFull = "asked";
    run.used.notes = Math.max(run.used.notes, ((env.extras && env.extras.knownIds) || []).length);
    noteShown(run, env.extras || {});
    run.textCut = !!messages.textCut;
    run.textShown = messages.textShown || 0;
    // Shown once: the next step sees them in the history instead.
    run.notice = "";
    run.steers = [];
    run.handBack = "";
    if (run.progress) { run.progress.news = null; run.progress.failedAsk = null; }
    run.previous = { url: page.url || "", visibleText: page.visibleText || "" };
    const tool = toolFor(run, messages, env, page);
    run.offered = tool.parameters.properties.do.enum;
    // A picture the model asked for goes with this step only.
    const image = run.image || null;
    run.image = null;
    fx.push({ type: "model", system: messages.system, user: image ? `${messages.user}\nA picture of the page as it is on screen is attached.` : messages.user, tool, tier: taker.by === "helper" ? "helper" : "pro", purpose: "step", effort, ...(image ? { image } : {}), ...(run.askedOut ? { reasks: 0 } : {}) });
    return fx;
  }

  /**
   * How hard the model is asked to think on the step in hand, where its
   * provider takes a say in it (llm.js). Most of a step's time is the model
   * writing, and on a reasoning model most of that is its thinking: on the
   * decision cases (tests/decisions) gpt-oss-20b got 43 of 51 right at
   * about 2.5 seconds a step with low effort, 45 at 3.2 seconds with its
   * own, and 46 of 50 at 13 seconds with high. So the main model's routine
   * steps take low effort, and a step in difficulty, the helper's steps,
   * the second opinions and the check of the answer take the model's own.
   */
  function effortOf(run) {
    return run.by === "main" && !inDifficulty(run) ? "low" : "default";
  }

  /**
   * The step tool for this step: what it offers follows what is possible
   * now. There is nothing more to read when the whole text is shown, and no
   * detail to fill from when none is on file.
   */
  function toolFor(run, messages, env, page) {
    const store = env && env.memory;
    const hasDetails = !!store && !store.paused && KNOWN.FIELDS.some(([k]) => KNOWN.fieldValue(store, k));
    const canLook = !!(env && env.settings && env.settings.vision) && !run.noVision;
    // A point can be aimed at when the listing gives one (a control with no
    // words is listed with where its middle is) or a picture of the screen
    // goes with the step.
    const shown = page || (env && env.page);
    const canAim = !!run.image || !!(shown && (shown.elements || []).some((e) => e.at));
    return STEP.stepTool({ maxActions: run.maxActions, finalStep: run.finalStep, canRead: !!messages.textCut, hasDetails, canLook, canAim, canDelegate: !run.sub });
  }

  function addUsage(run, usage) {
    if (!usage) return;
    run.usage.prompt += usage.prompt || 0;
    run.usage.completion += usage.completion || 0;
    run.usage.cached = (run.usage.cached || 0) + (usage.cached || 0);
    run.usage.cacheWrite = (run.usage.cacheWrite || 0) + (usage.cacheWrite || 0);
    run.usage.cost += usage.cost || 0;
    run.usage.calls += 1;
    if (usage.estimated) run.usage.estimated = true;
    if (usage.model && !run.usage.models.includes(usage.model)) run.usage.models.push(usage.model);
  }

  function onModelReplied(run, event, page, env) {
    const fx = [];
    if (run.status !== "running") return fx;
    addUsage(run, event.usage);
    const budget = (env.settings && env.settings.costBudget) || 0;
    if (budget > 0 && run.usage.cost >= budget) {
      return end(run, fx, env, { state: "error", kind: "budget", text: `Cost budget reached: this task has used $${run.usage.cost.toFixed(4)} of the $${budget.toFixed(4)} limit set in Settings.` });
    }
    // The model called the tool this time: whatever is wrong with the step,
    // the single asks that follow a reply with no call are over.
    if (event.reply && typeof event.reply === "object") run.askedOut = false;
    const check = STEP.checkStep(event.reply, { page, labels: run.labels, labelOf: TOOLS.elementLabel, maxActions: run.maxActions, finalStep: run.finalStep, notes: run.memory, canDelegate: !run.sub });
    if (!check.ok) {
      // Notes written in a reply that could not be run are still the model's notes.
      keepNotes(run, STEP.notesOf(event.reply));
      return unusable(run, page, env, fx, check.error, event.reply);
    }
    run.facts.invalid = 0;
    // The provider answered: a later refusal that names no wait starts from the shortest pause again.
    run.pauses = 0;
    run.pausedInRow = { n: 0, ms: 0 };
    run.steps = (run.steps || 0) + 1;
    if (run.by === "helper") run.helperSteps = (run.helperSteps || 0) + 1;
    const step = check.step;
    const noted = keepNotes(run, step);
    run.current = { step: run.step, goal: step.goal, actions: [], url: page.url || "" };
    // The note this step added, for the trace.
    if (noted) run.current.note = clip(noted, 600);
    if (run.helper) run.current.by = run.by === "helper" ? run.helper.model : "main";
    run.queue = step.actions;
    if (check.dropped) run.notice = check.dropped;
    if (step.goal) log(run, "executor", `Step ${run.step}`, step.goal);
    return next(run, page, env, fx);
  }

  /**
   * The step's note added to the model's notes, or its rewrite in their
   * place. What was cut from a rewrite, a note left out at the limit, and
   * notes past their room are kept for the model's facts (context.js).
   */
  function keepNotes(run, got) {
    const before = run.memory;
    const m = STEP.mergeNotes(run.memory, got, run.step);
    run.memory = m.notes;
    // A note added (not a rewrite) is a step that wrote down something new.
    const added = !m.rewrote && m.notes !== before ? String((got && got.note) || "").trim() : "";
    if (added && run.progress) run.progress.notedAt = run.step;
    run.notesCut = m.cut;
    run.notesRefused = m.refused;
    if (run.memory.length <= STEP.NOTES_ROOM) run.notesFull = "";
    else if (!run.notesFull) run.notesFull = "ask";
    return added;
  }

  /** What the run had written down, for an answer it could not finish. */
  const found = (run) => (run.memory ? `\n\nWhat I had found:\n${run.memory}` : "");

  /**
   * A reply that names no action that can be run. The model is told why and
   * asked again; nothing on the page has changed, so no step is used. A few
   * in a row and the run ends with whatever it had found.
   */
  function unusable(run, page, env, fx, error, reply) {
    run.facts.invalid += 1;
    log(run, "system", "Step Not Usable", `${error}${reply ? ` The reply was: ${clip(JSON.stringify(reply), 500)}` : ""}`);
    if (run.facts.invalid >= INVALID_LIMIT) {
      const w = run.finalStep && run.wrapUp;
      return end(run, fx, env, w && w.by === "stuck"
        ? { state: "error", kind: "stuck", text: `I stopped at step ${run.step} because I was going round without getting anywhere (${w.why}), and the model's last replies could not be used.${found(run)}` }
        : w
          ? { state: "error", kind: "wrap_up", text: `You asked for the answer now, and the model's last replies could not be used.${found(run)}` }
          : { state: "error", kind: "model", text: `The model sent ${run.facts.invalid} replies in a row that named no step I could take, so I stopped at step ${run.step}. Try again, or pick a different model in Settings.${found(run)}` });
    }
    run.notice = `Your last reply could not be used: ${error}`;
    return askModel(run, page, env, fx);
  }

  /** Counts an action that left the page as it was, for the run facts. */
  function tally(run, a, ok, noEffect, url, miss) {
    const sig = `${String(url || "").split("#")[0]} ${STEP.signature(a)}`;
    run.facts.repeats = sig === run.lastSignature && (noEffect || !ok) ? run.facts.repeats + 1 : (noEffect || !ok ? 1 : 0);
    // The same action on the same page, whatever it did.
    run.facts.same = sig === run.lastSignature ? (run.facts.same || 1) + 1 : 1;
    run.lastSignature = sig;
    // A find that matched nothing is something learned about the page, not a failure, and leaves the count as it was.
    if (!miss) run.facts.failures = ok ? 0 : run.facts.failures + 1;
    // Finds in a row that matched nothing; any other action ends the row.
    run.facts.misses = miss ? (run.facts.misses || 0) + 1 : 0;
    // Each action by its control's words (refs are renumbered when a page is
    // redrawn) and by what it did, with where the page stood when it was
    // taken: its address, how many controls it had and how much text. A
    // clock or a rotating banner does not move that; a list that grew does.
    const on = a.ref !== undefined && run.labels[a.ref] ? run.labels[a.ref] : "";
    const as = on ? { ...a, ref: undefined } : a;
    const did = !ok ? "failed" : noEffect ? "no effect" : "done";
    const print = String(run.lastPrint || "");
    const place = print.includes("|") ? print.slice(0, print.lastIndexOf("|")) : String(url || "").split("#")[0];
    run.trail = [...(run.trail || []), { key: JSON.stringify([STEP.signature(as), on, did]), place, text: STEP.describe(as, on ? clip(on, 60) : "") }].slice(-TRAIL);
    run.facts.cycle = cycleOf(run.trail);
  }

  /**
   * The round of two or three different actions the run's last actions go
   * through, when it has been gone at least twice, or null. An action
   * matches the one a round before it when it is the same action, on the
   * same control, did the same, and the page stood where it stood then.
   */
  function cycleOf(trail) {
    const same = (x, y) => x.key === y.key && x.place === y.place;
    for (const size of [2, 3]) {
      const unit = trail.slice(-size);
      if (unit.length < size || new Set(unit.map((t) => t.key)).size < 2) continue;
      let matched = 0;
      for (let i = trail.length - 1; i - size >= 0 && same(trail[i], trail[i - size]); i--) matched += 1;
      const rounds = Math.floor((matched + size) / size);
      if (rounds >= 2) return { size, rounds, actions: unit.map((t) => t.text) };
    }
    return null;
  }

  /** Starts the next action of the step in hand, or closes the step. */
  function next(run, page, env, fx) {
    const a = run.queue[0];
    if (!a) return closeStep(run, fx);
    if (a.do === "done") return onDone(run, a, page, env, fx);
    if (a.do === "ask_user") {
      const question = a.kind !== "question" && POLICY.HANDOVER[a.kind] && !a.question ? POLICY.HANDOVER[a.kind] : a.question;
      // A control the user is asked to press themselves is marked on the page for them.
      return waitFor(run, fx, env, { kind: a.kind, question, action: a, ...(a.kind === "press" && a.ref !== undefined ? { press: a.ref } : {}) });
    }
    if (a.do === "remember") return onRemember(run, a, page, env, fx);
    if (a.do === "delegate") return onDelegate(run, a, page, env, fx);
    // An action on a control that is not on the page.
    if (a.gone) {
      tally(run, a, false, false, page && page.url);
      record(run, a, false, a.gone);
      return closeStep(run, fx, "failed");
    }
    // An action the step did not offer is still run: find and read say what
    // they found, or that there is nothing more, and that is worth more than
    // a refusal. Only a picture has no result to give a model that cannot
    // see one.
    if (a.do === "look" && run.offered && !run.offered.includes("look")) {
      tally(run, a, false, false, page && page.url);
      record(run, a, false, "This model cannot be shown pictures. Work from the page's text and controls.");
      return closeStep(run, fx, "failed");
    }
    const store = env.memory || KNOWN.empty();
    if (a.do === "fill" && a.from && !KNOWN.fieldValue(store, a.from)) {
      record(run, a, false, `Nothing is on file for profile.${a.from}. Ask the user for it, or leave the field.`);
      return closeStep(run, fx, "failed");
    }
    if (a.do === "fill_details") {
      const el = a.ref !== undefined ? (page.elements || []).find((e) => e.id === a.ref) : null;
      const plan = KNOWN.planFill(page.elements || [], store, el ? el.formId : undefined);
      const left = [
        plan.missing.length ? `Nothing on file for: ${plan.missing.map((m) => `[${m.ref}] ${m.label}`).join(", ")}.` : "",
        plan.skipped.length ? `The user's to enter: ${plan.skipped.map((x) => `[${x.ref}] ${x.label}`).join(", ")}.` : "",
      ].filter(Boolean).join(" ");
      if (!plan.fills.length) {
        record(run, a, true, `Nothing to fill from the user's details here. ${left}`.trim());
        return next(run, page, env, fx);
      }
      // What will be filled is settled now; the values stay in the store.
      run.queue = [{ ...a, plan: plan.fills.map((f) => ({ ref: f.ref, key: f.key, label: f.label })), left }, ...run.queue.slice(1)];
    }
    // A key with no ref is pressed only where it was judged to land.
    const lands = POLICY.pressLandsOn(run.queue[0], page, run);
    if (lands.length || (run.queue[0].do === "press" && run.queue[0].ref === undefined)) run.queue = [{ ...run.queue[0], landsOn: lands }, ...run.queue.slice(1)];
    const act = run.queue[0];
    let verdict = POLICY.decide(act, page, run, env.settings, store, env.extras && env.extras.tabs);
    // The rules could not settle this press: a second opinion first, then
    // the same decision again with its answer. Once the opinion has failed
    // too often to be worth asking, the press is decided as one it could
    // not give: held for the user.
    if (verdict.check) {
      if ((run.opinionMisses || 0) < OPINION_MISSES) return askOpinion(run, verdict.check, fx);
      run.opinions = { ...(run.opinions || {}), [verdict.check.key]: { unanswered: true } };
      verdict = POLICY.decide(act, page, run, env.settings, store, env.extras && env.extras.tabs);
    }
    if (verdict.note) log(run, "system", "Not Held", verdict.note);
    if (verdict.verdict === "refuse") {
      record(run, act, false, verdict.message);
      return closeStep(run, fx, "refused");
    }
    if (verdict.verdict === "handoff") {
      // The action is not run: the user does this part, in the page.
      return waitFor(run, fx, env, { kind: verdict.kind, question: verdict.question, action: act, byPolicy: true, press: verdict.press });
    }
    if (verdict.verdict === "confirm") {
      return waitFor(run, fx, env, { kind: "approval", risk: verdict.kind, question: verdict.why, detail: [...(verdict.detail || []), run.current && run.current.goal && verdict.kind !== "share" ? `Why: ${run.current.goal}` : ""].filter(Boolean), action: act, confirm: verdict });
    }
    log(run, "executor", "Action", STEP.describe(act));
    // A click the page shows no answer to may be made with Enter or Space there, where those are allowed as the click was.
    fx.push({ type: "act", action: act, ...(POLICY.keysToo(act, page, run, env.settings, store, env.extras && env.extras.tabs) ? { keys: true } : {}) });
    return fx;
  }

  /**
   * Asks whether any of the page's hidden sentences speaks to an AI. The
   * question is shown those sentences alone. The page is looked at again,
   * as it was, once the answer is in.
   */
  function askAddressed(run, passages) {
    run.addressedAsks = (run.addressedAsks || 0) + 1;
    run.pendingAddressed = passages;
    status(run, "executor", "Checking text this page hides…");
    const m = TOOLS.addressedMessages(passages, 400);
    return [{ type: "model", system: m.system, user: m.user, tool: m.tool, tier: run.helper ? "helper" : "pro", purpose: "addressed", effort: "default" }];
  }

  /**
   * The answer about hidden sentences came back, or could not be had. Each
   * sentence asked about is marked, and the page is taken up where it was
   * left. A missing answer is kept as none: the sentences stay out of what
   * the model reads either way, and are not asked about again.
   */
  function onAddressed(run, event, page, env) {
    if (run.status !== "running" || !run.pendingAddressed) return [];
    addUsage(run, event.usage);
    const asked = run.pendingAddressed;
    run.pendingAddressed = null;
    const said = TOOLS.readAddressed(event.reply);
    for (const p of asked) run.addressed[p] = said ? false : null;
    if (said && said.addressed) {
      const which = asked[said.passage] || asked[0];
      run.addressed[which] = true;
      log(run, "system", "Hidden Text", `This page hides text from people looking at it that speaks to AI assistants: "${clip(which, 200)}" It is not read, and nothing from this run will be learned.`);
    }
    if (!page) return [{ type: "observe" }];
    return onObserved(run, page, env);
  }

  /**
   * Asks a second opinion about the action in hand. The question is built
   * from the check alone (agentTools.js): the site, the names of the control
   * and its boxes, the text about to go, the request. No page text.
   */
  function askOpinion(run, check, fx) {
    run.pendingOpinion = { key: check.key, kind: check.kind, label: check.label || check.button || check.box || "" };
    status(run, "executor", check.kind === "form" ? "Checking what this form does…" : "Checking what this button does…");
    const m = TOOLS.opinionMessages(check);
    fx.push({ type: "model", system: m.system, user: m.user, tool: m.tool, tier: run.helper ? "helper" : "pro", purpose: "opinion", effort: "default" });
    return fx;
  }

  /**
   * The second opinion came back, or could not be had. What it said is kept
   * for the run, and the action in hand is decided again. A reply that
   * cannot be used is kept as no answer: a one-box form is then held as a
   * send, as it always was, and a press nothing could read is held for the
   * user. The check is the helper's when there is one, otherwise the main
   * model's: the same connection the run is on, and no other.
   */
  function onOpinion(run, event, page, env) {
    const fx = [];
    if (run.status !== "running" || !run.pendingOpinion) return fx;
    addUsage(run, event.usage);
    const asked = run.pendingOpinion;
    run.pendingOpinion = null;
    const said = TOOLS.readOpinion(asked, event.reply);
    if (!said) {
      run.opinionMisses = (run.opinionMisses || 0) + 1;
      log(run, "system", "Second Check", "The check gave no usable answer, so the user is asked.");
    } else if (asked.kind === "press" && said.does !== "none") {
      log(run, "system", "Second Check", `Pressing "${clip(asked.label, 60)}" looks like it would ${{ pay: "spend money", send: "send something", delete: "delete something" }[said.does]}${said.why ? `: ${said.why}` : "."}`);
    }
    run.opinions = { ...(run.opinions || {}), [asked.key]: said || { unanswered: true } };
    if (!page) return closeStep(run, fx);
    return next(run, page, env, fx);
  }

  /**
   * Something to keep for later tasks. What the user said in their own
   * words is kept at once (they see it, and can undo it). Anything else is
   * put to them when the run is over: a page cannot write the user's memory.
   */
  function onRemember(run, a, page, env, fx) {
    const scope = a.scope === "this_site" ? TOOLS.siteOf((page && page.url) || "") || "global" : "global";
    const kind = a.kind === "context" && scope === "global" ? "context" : "preference";
    const theirs = [run.request || run.task, ...run.said, ...(run.earlierTurns || []).filter((t) => t.role === "user").map((t) => t.text)];
    if (!KNOWN.isStorable(a.value)) {
      record(run, a, false, "That is not kept: passwords, codes, card and identity numbers are never stored.");
    } else if (KNOWN.saidByUser(a.value, theirs)) {
      const quote = kind === "context" ? clip(theirs.find((t) => KNOWN.saidByUser(a.value, [t])) || theirs[0] || a.value, 200) : undefined;
      fx.push({ type: "memory", op: "add", entry: { kind, text: a.value, scope, source: "you_said", ...(quote ? { quote, from: ["said"], origin: { runId: run.id } } : {}) } });
      run.journal.push({ k: "memory", text: a.value });
      record(run, a, true, "Remembered.");
    } else {
      if (!run.offers.some((o) => o.type === "entry" && o.text === a.value)) run.offers.push({ type: "entry", kind, text: a.value, scope });
      record(run, a, true, "Not kept by itself, because the user did not say this in so many words. They will be asked whether to keep it.");
    }
    return next(run, page, env, fx);
  }

  // -------------------------------------------------------------- sub-tasks
  // A run can hand independent parts of the request to sub-tasks (the
  // delegate action). Each is a run of its own, with this same state
  // machine, kept inside the run that handed it out: in its own tab, under
  // the same rules and approvals, with its model calls and cost counted on
  // the run that handed it out. The delegate action ends when every
  // sub-task has ended, and its result is what each brought back.

  const SUB_LIVE = new Set(["starting", "running"]);
  const isOver = (run) => run.status === "done" || run.status === "failed" || run.status === "stopped";

  function onDelegate(run, a, page, env, fx) {
    if (run.sub) {
      tally(run, a, false, false, page && page.url);
      record(run, a, false, "A sub-task cannot hand out sub-tasks of its own. Do this part yourself, here.");
      return closeStep(run, fx, "failed");
    }
    const limits = { checkInMs: 0, maxActions: run.mainLimits.maxActions, elementLimit: run.mainLimits.elementLimit, pageBudget: run.mainLimits.pageBudget, helper: run.helper };
    const ids = [];
    for (const t of a.tasks || []) {
      const id = `${run.id}-s${run.children.length + 1}`;
      const child = newRun({
        id, task: t.task, tabId: null, marker: run.marker, now: env.now, trustedSites: run.trust.sites, settings: limits,
        fromNothing: { from: "blank", url: "", title: "", reused: true },
        firstMove: t.url ? { do: "navigate", url: t.url } : null,
        sub: { parent: run.id, request: run.request || run.task },
      });
      // What this run has seen, and what the user allowed in it, holds for its sub-tasks.
      child.trust = { ...child.trust, urls: [...run.trust.urls], ...(run.trust.searches ? { searches: [...run.trust.searches] } : {}), ...(run.trust.shared ? { shared: [...run.trust.shared] } : {}) };
      run.children.push({ id, task: t.task, url: t.url || "", state: "queued", tabId: null, held: [], result: null, run: child });
      ids.push(id);
    }
    run.delegation = { ids, at: env.now || 0 };
    log(run, "executor", "Action", STEP.describe(a));
    run.journal.push({ k: "subtasks", ids, tasks: ids.map((id) => { const c = run.children.find((x) => x.id === id); return { id, task: c.task, url: c.url }; }) });
    status(run, "executor", `${ids.length} sub-task${ids.length === 1 ? "" : "s"} running…`);
    return startChildren(run, env, fx);
  }

  /** Starts sub-tasks that wait their turn, while fewer than SUBS_AT_ONCE run. */
  function startChildren(run, env, fx) {
    let running = run.children.filter((c) => SUB_LIVE.has(c.state)).length;
    for (const c of run.children) {
      if (running >= SUBS_AT_ONCE) break;
      if (c.state !== "queued") continue;
      c.state = "starting";
      running += 1;
      // The driver opens the sub-task's tab and says so with "spawned".
      fx.push({ type: "spawn", child: c.id });
    }
    return fx;
  }

  /** What a sub-task's driver reported: {child, event}. */
  function onChild(run, event, env) {
    const c = (run.children || []).find((x) => x.id === event.child);
    const inner = event.event || {};
    if (!c) return [];
    // A tab that came after its sub-task ended is closed again.
    if (inner.type === "spawned" && c.state === "ended") return inner.tabId !== undefined && inner.tabId !== null ? [{ type: "child_fx", child: c.id, fx: { type: "end", tabId: inner.tabId } }] : [];
    if (!SUB_LIVE.has(c.state) || isOver(run)) return [];
    if (inner.type === "spawned") {
      if (c.state !== "starting") return [];
      if (inner.tabId === undefined || inner.tabId === null) {
        return stepChild(run, c, { type: "model_failed", kind: "page", message: `No tab could be opened for this sub-task${inner.error ? `: ${inner.error}` : ""}.` }, env, []);
      }
      c.state = "running";
      c.tabId = inner.tabId;
      c.run.tabId = inner.tabId;
      c.run.openedTabs = [inner.tabId];
      run.journal.push({ k: "sub", id: c.id, state: "running", tabId: inner.tabId });
      return stepChild(run, c, { type: "start" }, env, []);
    }
    return stepChild(run, c, inner, env, []);
  }

  /**
   * One event for one sub-task. Its journal joins this run's, marked with
   * the sub-task; its model calls and cost are added to this run's; a step
   * it would take while this run waits for the user (a check-in) waits too.
   */
  function stepChild(run, c, inner, env, fx) {
    const own = env.childEnv ? env.childEnv(c.id) || {} : {};
    const childEnv = { ...env, page: own.page || null, extras: own.extras || {} };
    const before = { ...c.run.usage, models: [...c.run.usage.models] };
    const out = advance(c.run, inner, childEnv);
    counted(run, before, c.run.usage);
    mirror(run, c);
    for (const f of out) {
      if (f.type === "end") { childEnded(run, c, env, fx); continue; }
      if (f.type === "model" && f.purpose === "step" && !isOver(run) && (run.status === "waiting" || guarded(run))) { c.held.push(f); continue; }
      fx.push({ type: "child_fx", child: c.id, fx: f });
    }
    if (run.status !== "running") return fx;
    const budget = (env.settings && env.settings.costBudget) || 0;
    if (budget > 0 && run.usage.cost >= budget) {
      return end(run, fx, env, { state: "error", kind: "budget", text: `Cost budget reached: this task has used $${run.usage.cost.toFixed(4)} of the $${budget.toFixed(4)} limit set in Settings, counting its sub-tasks.${found(run)}` });
    }
    const why = guarded(run);
    if (why && run.children.some((x) => x.held.length)) return checkIn(run, fx, env, why);
    return fx;
  }

  /** Why this run would ask the user whether to go on now ("time", "calls"), or "". */
  function guarded(run) {
    if (run.wrapUp) return "";
    if (run.checkInMs > 0 && run.activeMs >= run.nextCheckIn) return "time";
    if (run.usage.calls >= run.callCeiling) return "calls";
    return "";
  }

  /** A sub-task's model use since `before`, added to this run's. */
  function counted(run, before, after) {
    const calls = (after.calls || 0) - (before.calls || 0);
    run.usage.prompt += (after.prompt || 0) - (before.prompt || 0);
    run.usage.completion += (after.completion || 0) - (before.completion || 0);
    run.usage.cached = (run.usage.cached || 0) + (after.cached || 0) - (before.cached || 0);
    run.usage.cacheWrite = (run.usage.cacheWrite || 0) + (after.cacheWrite || 0) - (before.cacheWrite || 0);
    run.usage.cost += (after.cost || 0) - (before.cost || 0);
    run.usage.calls += calls;
    if (after.estimated) run.usage.estimated = true;
    for (const m of after.models || []) if (!run.usage.models.includes(m)) run.usage.models.push(m);
  }

  /** The sub-task's new journal entries, moved into this run's journal under its id. */
  function mirror(run, c) {
    for (const e of c.run.journal) {
      // Its answer and its offers are this run's to give, at the end.
      if (e.k === "answer" || e.k === "offer" || e.k === "provisional" || e.k === "provisional_replaced") continue;
      if (e.k === "ask") run.journal.push({ k: "ask", sub: c.id, wait: { ...e.wait, sub: c.id, subTask: clip(c.task, 160) } });
      else run.journal.push({ ...e, sub: c.id });
    }
    c.run.journal = [];
  }

  /**
   * A sub-task ended. What it brought back is kept, with the text of the
   * pages it read (so quotes from them can be checked), the addresses it
   * saw and anything it offered to remember.
   */
  function childEnded(run, c, env, fx) {
    const o = c.run.outcome || { state: "error", text: "" };
    const own = env.childEnv ? env.childEnv(c.id) || {} : {};
    const last = [...c.run.history].reverse().find((h) => h.url);
    const at = (own.page && /^https?:/.test(String(own.page.url || "")) && own.page) || null;
    const result = {
      state: o.state || "error",
      success: !!o.success && (o.state === "success" || o.state === "unconfirmed"),
      answer: String(o.text || "").slice(0, SUB_ANSWER),
      evidence: (o.evidence || []).slice(0, 6),
      sources: (o.sources || []).slice(0, SOURCES_SHOWN),
      note: o.note || "",
      url: (at && at.url) || (last && last.url) || "",
      title: (at && at.title) || "",
      steps: c.run.step,
    };
    for (const p of c.run.seen || []) keepText(run, p);
    const known = new Set(run.trust.urls);
    for (const u of c.run.trust.urls || []) if (!known.has(u) && run.trust.urls.length < SEEN_URLS) { known.add(u); run.trust.urls.push(u); }
    for (const site of c.run.trust.sites || []) if (!run.trust.sites.includes(site)) run.trust.sites.push(site);
    for (const u of c.run.trust.searches || []) if (!(run.trust.searches = run.trust.searches || []).includes(u) && run.trust.searches.length < SEEN_URLS) run.trust.searches.push(u);
    if (c.run.injectionSeen) run.injectionSeen = true;
    for (const offer of c.run.offers || []) if (!run.offers.some((x) => x.type === offer.type && x.key === offer.key && x.text === offer.text)) run.offers.push(offer);
    for (const k of c.run.used.details || []) if (!run.used.details.includes(k)) run.used.details.push(k);
    learnFromChild(run, c.run);
    // The text it read is this run's now; the sub-task keeps its steps and counts.
    c.run.seen = [];
    c.run.reads = [];
    c.run.dropped = [];
    fx.push({ type: "child_fx", child: c.id, fx: { type: "end" } });
    return endChild(run, c, env, fx, result, { outcome: result.state, success: result.success, text: clip(o.text, 300) });
  }

  /**
   * What the user said and decided inside a sub-task is theirs for the
   * whole run: their words, the answers they gave, what they asked to keep,
   * and every action they declined. A declined action is a correction of
   * the run, as it is in the run itself (learn.js reads subDeclined).
   */
  function learnFromChild(run, child) {
    for (const t of child.said || []) if (!run.said.includes(t)) run.said.push(t);
    for (const t of child.answers || []) if (!run.answers.includes(t)) run.answers.push(t);
    for (const q of child.asked || []) if (!(run.asked = run.asked || []).some((x) => x.answer === q.answer)) run.asked.push(q);
    for (const k of child.keep || []) if (!run.keep.some((x) => x.question === k.question && x.answer === k.answer)) run.keep.push(k);
    const declined = [];
    for (const h of child.history || []) for (const a of h.actions || []) if (/The user declined this step/.test(a.result || "")) declined.push(a.text);
    if (declined.length) run.subDeclined = [...(run.subDeclined || []), ...declined];
  }

  /**
   * The one way a sub-task ends, however it ends: it is marked ended with
   * its result, the next one waiting its turn starts unless sub-tasks are
   * being stopped, and when the last of the delegate action's sub-tasks has
   * ended this run carries on.
   */
  function endChild(run, c, env, fx, result, said) {
    c.state = "ended";
    c.held = [];
    c.result = result;
    run.journal.push({ k: "sub", id: c.id, state: "ended", ...said });
    if (isOver(run)) return fx;
    if (!run.stoppingChildren) startChildren(run, env, fx);
    const d = run.delegation;
    if (d && d.ids.every((id) => { const x = run.children.find((k) => k.id === id); return !x || x.state === "ended"; })) delegationDone(run, env, fx);
    return fx;
  }

  /** Every sub-task of the delegate action has ended: its result, and the next step. */
  function delegationDone(run, env, fx) {
    const kids = run.delegation.ids.map((id) => run.children.find((x) => x.id === id)).filter(Boolean);
    run.delegation = null;
    const results = kids.map((c) => ({ id: c.id, task: c.task, start: c.url, ...c.result }));
    run.delegated = [...(run.delegated || []), ...results].slice(-SUBS_SHOWN);
    const answered = results.filter((r) => r.success).length;
    const left = results.length - answered;
    const message = `${results.length} sub-task${results.length === 1 ? "" : "s"} ended: ${answered} answered${left ? `, ${left} did not finish` : ""}. What each brought back is shown with the page, under "What your sub-tasks brought back".`;
    const a = run.queue[0];
    if (a && a.do === "delegate") {
      tally(run, a, answered > 0, false, run.previous && run.previous.url);
      record(run, a, answered > 0, message);
    }
    log(run, answered ? "executor" : "error", answered ? "Result" : "Action Failed", message);
    if (run.status === "running") status(run, "executor", "Carrying on…");
    return closeStep(run, fx);
  }

  /** Stops every sub-task still running or waiting its turn. */
  function stopChildren(run, env, fx, why) {
    run.stoppingChildren = true;
    try {
      for (const c of run.children || []) {
        if (c.state === "ended") continue;
        if (c.state === "queued" || (c.state === "starting" && !c.run.tabId)) {
          endChild(run, c, env, fx, { state: "idle", success: false, answer: `Not started: ${why}`, evidence: [], note: "", url: "", title: "", steps: 0 }, { outcome: "idle", success: false, text: "Not started." });
          continue;
        }
        c.held = [];
        stepChild(run, c, { type: "stop", text: `Stopped: ${why}` }, env, fx);
      }
    } finally {
      run.stoppingChildren = false;
    }
    return fx;
  }

  function record(run, a, ok, result) {
    if (!run.current) run.current = { step: run.step, goal: "", actions: [], url: "" };
    // The control's own words: a ref means nothing once the page has changed.
    const on = a.ref !== undefined && run.labels[a.ref] ? clip(run.labels[a.ref], 60) : "";
    const entry = { text: STEP.describe(a, on), do: a.do, ok: !!ok, result: String(result || "") };
    if (on) entry.on = on;
    // What a later run on this site could repeat: where it went, what it pressed, what it typed.
    if (ok && a.do === "navigate") entry.way = `open ${a.url}`;
    else if (ok && a.do === "click" && on) entry.way = `press "${on}"`;
    else if (ok && a.do === "fill" && on && !a.from && KNOWN.isStorable(a.value)) entry.way = `put "${clip(a.value, 40)}" in "${on}"`;
    else if (ok && a.do === "press" && /^enter$/i.test(a.key || "")) entry.way = "press Enter";
    run.current.actions.push(entry);
    run.queue = run.queue.slice(1);
  }

  /** The step is over: its actions join the history, and the page is looked at again. */
  function closeStep(run, fx, why) {
    const left = run.queue.length;
    if (left && why) {
      const reason = why === "changed" ? "the page changed" : why === "failed" ? "an action failed" : "an action was refused";
      run.notice = [run.notice, `${left} later action${left === 1 ? "" : "s"} in the step ${left === 1 ? "was" : "were"} not run because ${reason}.`].filter(Boolean).join(" ");
    }
    run.queue = [];
    run.typed = {};
    run.focusRef = null;
    if (run.current && run.current.actions.length) {
      run.history.push(run.current);
      run.lastStepOk = run.current.actions.every((x) => x.ok);
    }
    run.current = null;
    if (run.status === "running") fx.push({ type: "observe" });
    return fx;
  }

  function onActed(run, event, page, env) {
    const fx = [];
    if (run.status !== "running") return fx;
    const a = run.queue[0];
    if (!a) return fx;
    const r = event.result || {};
    // The control the user approved changed while they decided: nothing was
    // done, and the action is decided again on the page as it is now.
    if (r.changed && a.approved !== undefined) {
      log(run, "system", "Changed", clip(r.message, 300));
      const { approved: _was, ...again } = a;
      run.queue = [again, ...run.queue.slice(1)];
      if (page) for (const el of page.elements || []) run.labels[el.id] = TOOLS.elementLabel(el);
      return page ? next(run, page, env, fx) : closeStep(run, fx, "changed");
    }
    // The same action again, with nothing on the page to show for it.
    tally(run, a, r.ok, r.noEffect, page && page.url, !!r.miss);
    searched(run, a, r, page);
    if (r.tabId !== undefined && r.tabId !== null) run.tabId = r.tabId;
    if (r.openedTab !== undefined) run.openedTabs = [...run.openedTabs, r.openedTab];
    if (r.closedTab !== undefined) run.openedTabs = run.openedTabs.filter((t) => t !== r.closedTab);
    if (r.read) run.reads = [...run.reads.filter((x) => !(x.url === r.read.url && x.label === r.read.label)), r.read].slice(-4);
    for (const key of r.used || []) if (!run.used.details.includes(key)) run.used.details.push(key);
    if (r.image) run.image = r.image;
    // What the agent typed, for a second opinion on the form it goes with.
    if (r.ok && a.do === "fill" && !a.from && a.ref !== undefined) {
      run.typed = { ...(run.typed || {}), [a.ref]: String(a.value || "") };
      // Every text the agent typed in this run, to tell it from text a page put in a box.
      run.typedTexts = [...(run.typedTexts || []).filter((t) => t !== String(a.value || "")), String(a.value || "")].slice(-20);
    }
    // Where the focus was left, for a key the step presses next with no ref.
    if (r.ok && ["click", "fill", "press"].includes(a.do) && a.ref !== undefined) run.focusRef = a.ref;
    record(run, a, r.ok, r.message);
    // How long the page was waited on after this action, so the cost of waiting can be read per step.
    if (Number.isFinite(r.settleMs) && run.current && run.current.actions.length) run.current.actions[run.current.actions.length - 1].settle = r.settleMs;
    // Whether the pointer was a real one or events made by a script.
    if (r.pointer && run.current && run.current.actions.length) run.current.actions[run.current.actions.length - 1].pointer = r.pointer;
    log(run, r.ok ? "executor" : "error", r.ok ? "Result" : "Action Failed", clip(r.message, 300));
    if (!r.ok) return closeStep(run, fx, "failed");
    if (r.pageChanged) {
      // The page changed where it stands (a box ticked, a row added) and
      // was looked at again. The step goes on when the control its next
      // action is for is still there, under the same words, with nothing
      // new on top of the page; the action is judged against the page as
      // it is now.
      if (r.soft && r.rescanned && stillThere(run, run.queue[0], page)) return next(run, page, env, fx);
      return closeStep(run, fx, "changed");
    }
    return next(run, page, env, fx);
  }

  function stillThere(run, a, page) {
    if (!a || a.ref === undefined || !page || !["click", "fill", "press"].includes(a.do)) return false;
    const els = page.elements || [];
    const el = els.find((e) => e.id === a.ref);
    if (!el || run.labels[a.ref] === undefined || TOOLS.elementLabel(el) !== run.labels[a.ref]) return false;
    return el.onTop || !els.some((e) => e.onTop && run.labels[e.id] === undefined);
  }

  // ---------------------------------------------------------------- waiting

  function waitFor(run, fx, env, wait) {
    run.waits += 1;
    if (HANDOFFS.has(wait.kind)) {
      const print = run.lastPrint || "";
      const last = run.handoff;
      run.handoff = last && last.kind === wait.kind && last.print === print ? { ...last, n: last.n + 1 } : { kind: wait.kind, print, n: 1 };
    }
    run.status = "waiting";
    const page = env && env.page;
    // What was in the page's fields, for a wait the user may answer on the page.
    run.waitSnapshot = page && !["approval", "check_in", "pause"].includes(wait.kind) ? { url: page.url, elements: (page.elements || []).map((el) => ({ id: el.id, value: el.sensitive ? "" : el.value || "" })) } : null;
    run.wait = { id: `${run.id}-w${run.waits}`, since: env.now || 0, tabId: run.tabId, ...wait };
    run.journal.push({ k: "ask", wait: { id: run.wait.id, kind: wait.kind, risk: wait.risk || "", question: wait.question || "", detail: wait.detail || [], tabId: run.tabId, ...(wait.kind === "check_in" ? { notes: wait.notes, active: wait.active, period: wait.period, reason: wait.reason } : {}), ...(wait.until ? { until: wait.until } : {}), ...(wait.hold ? { hold: wait.hold } : {}) } });
    status(run, "idle", wait.kind === "approval" ? "Waiting for your go-ahead" : wait.kind === "pause" ? "Waiting for the provider" : "Waiting for you");
    fx.push({ type: "attention", wait: run.wait });
    return fx;
  }

  /** The user did, answered, approved, declined or skipped what the run was waiting for. */
  function onUser(run, event, page, env) {
    const fx = [];
    const w = run.wait;
    // A check-in and a pause are ended only by their own events.
    if (run.status !== "waiting" || !w || (event.id && event.id !== w.id) || w.kind === "check_in" || w.kind === "pause") return fx;
    run.status = "running";
    run.wait = null;
    run.journal.push({ k: "ask_done", id: w.id, how: event.type });
    // Whatever the user did is something new: the run is not going round any
    // more. A hand-off said to be over is the exception: whether it changed
    // anything is told by the next look at the page, which counts a page
    // that did not change toward the stuck stop.
    const handedOff = HANDOFFS.has(w.kind) && (event.type === "cleared" || event.type === "user_done");
    if (!handedOff) {
      run.stuck = { steps: 0, helper: 0, at: run.step };
      if (run.wrapUp && run.wrapUp.by === "stuck") run.wrapUp = null;
    }
    // "Skip" on letting the agent onto a site: it is not asked again in this run.
    if (w.kind === "site_access" && event.type === "skipped") {
      let origin = "";
      try { origin = new URL(String((w.detail || [])[0] || "")).origin; } catch (_e) { /* no address */ }
      if (origin && origin !== "null") run.declinedSites = [...new Set([...(run.declinedSites || []), origin])];
    }
    const a = w.action;
    if (w.kind === "approval") {
      if (event.type === "approved") {
        run.trust = POLICY.remember(run.trust, w.confirm || {});
        // "Always on this site" is the user's standing word for their details there.
        if (w.confirm && w.confirm.kind === "share" && event.always && w.confirm.site) fx.push({ type: "memory", op: "consent", site: w.confirm.site });
        if (w.confirm && w.confirm.kind === "share" && w.confirm.site && !run.trust.shared) run.trust.shared = [];
        if (w.confirm && w.confirm.kind === "share" && w.confirm.site && !run.trust.shared.includes(w.confirm.site)) run.trust.shared.push(w.confirm.site);
        log(run, "system", "Allowed", "You allowed this step.");
        log(run, "executor", "Action", STEP.describe(a));
        status(run, "executor", `Step ${run.step}…`);
        // What the user approved, by the control's words: the driver runs it
        // only while the control still says that.
        const approved = a.ref !== undefined && ["click", "fill", "press"].includes(a.do) && run.labels[a.ref] !== undefined ? { ...a, approved: run.labels[a.ref] } : a;
        if (approved !== a) run.queue = [approved, ...run.queue.slice(1)];
        fx.push({ type: "act", action: approved });
        return fx;
      }
      record(run, a, false, `The user declined this step${w.risk ? ` (it would ${{ pay: "spend money", send: "send or submit something", delete: "delete something", share: "put their details into this site", address: "open an address that was not on any page", site: "type on a site outside the request", secret: "type into a secret field" }[w.risk] || "need their go-ahead"})` : ""}. It was not done.`);
      log(run, "system", "Declined", "You declined this step.");
      return closeStep(run, fx, "refused");
    }
    const said = String(event.text || "").trim();
    const result = event.type === "answered" && said
      ? `The user answered: "${clip(said, 800)}"`
      : event.type === "cleared"
        ? "The user did it: the page no longer shows what was in the way."
        : event.type === "skipped"
          ? "The user chose to skip this. Carry on without it, or finish and say what could not be done."
          : "The user says it is done.";
    record(run, a || { do: "ask_user", kind: w.kind }, event.type !== "skipped", w.byPolicy ? `Not run: only the user can do this. ${result}` : result);
    if (event.type === "answered" && said) {
      run.journal.push({ k: "user", text: said });
      run.said.push(said);
      run.answers.push(said);
      (run.asked = run.asked || []).push({ question: w.question || "", answer: said });
      // "Remember this for next time" was ticked on the question.
      if (event.keep) run.keep.push({ question: w.question || "", answer: said });
    }
    status(run, "executor", "Carrying on…");
    return closeStep(run, fx);
  }

  // --------------------------------------------------------------- finishing

  /** Every piece of text the run was shown, for checking quotes. */
  function textsOf(run, page, env) {
    const texts = run.seen.map((p) => ({ url: p.url, title: p.title, text: p.text }));
    if (page && page.innerText) texts.push({ url: page.url, title: page.title, text: shownText(page) });
    for (const r of run.reads) texts.push({ url: r.url, title: r.label, text: r.text });
    const ex = (env && env.extras) || {};
    if (ex.selection) texts.push({ url: "", title: "the user's selection", text: ex.selection });
    // The passage around a captured selection was read from its page.
    const place = ex.selectionPlace;
    if (place && place.passage) texts.push({ url: place.url || "", title: place.title || "", text: place.passage });
    for (const t of ex.openTabPages || []) texts.push({ url: t.url, title: t.title, text: t.digest });
    // The user's own words are theirs to be quoted back.
    texts.push({ url: "", title: "the request", text: run.task });
    // So is what the browser stated as fact: the date, above all.
    const today = CONTEXT.todayLine(env && env.now);
    if (today) texts.push({ url: "", title: "what the browser stated", text: today });
    for (const el of (page && page.elements) || []) if (el.value && !el.sensitive) texts.push({ url: page.url, title: "a field's value", text: String(el.value) });
    return texts;
  }

  /**
   * The pages an answer drew on, for the chips under it: every web page
   * holding one of its evidence quotes, and every page the run read that
   * the answer refers to (it names the page's site or title, or repeats a
   * run of the page's words). The page the run started on counts only as
   * the others do: it is not read by being open when the run began. What
   * sub-tasks answered from comes with their answers.
   */
  const SOURCES_SHOWN = 6;
  const SHARED_RUN = 5; // words in a row an answer must share with a page to be said to refer to it
  function sourcesOf(run, a, located, texts) {
    const out = [];
    const add = (url, title) => {
      const u = String(url || "");
      if (!/^https?:/i.test(u)) return;
      const key = u.split("#")[0];
      if (out.some((x) => x.url.split("#")[0] === key)) return;
      out.push({ url: u, title: clip(title || "", 120) });
    };
    for (const e of located || []) if (e.found) add(e.url, e.title);
    // Where the run began: the first page a step was taken on.
    const steps = [...run.history, ...(run.current ? [run.current] : [])];
    const start = String((steps[0] && steps[0].url) || "").split("#")[0];
    const ending = new Set(["done", "ask_user"]);
    const worked = new Set(steps.filter((h) => (h.actions || []).some((x) => !ending.has(x.do))).map((h) => String(h.url || "").split("#")[0]));
    const answer = String((a && a.answer) || "");
    const lower = answer.toLowerCase();
    const words = CONTEXT.wordsOf(answer);
    const grams = [];
    for (let i = 0; i + SHARED_RUN <= words.length; i++) {
      const g = words.slice(i, i + SHARED_RUN);
      // A run of short common words says nothing about where it came from.
      if (g.filter((w) => w.length >= 4 || /\d/.test(w)).length >= 2) grams.push(` ${g.join(" ")} `);
    }
    for (const p of texts || []) {
      const url = String(p.url || "");
      if (!/^https?:/i.test(url)) continue;
      const key = url.split("#")[0];
      if (key === start && !worked.has(key)) continue;
      let host = "";
      try { host = new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (_e) { host = ""; }
      const title = String(p.title || "").trim();
      const named = (host && lower.includes(host)) || (title.length >= 8 && lower.includes(title.toLowerCase()));
      const joined = grams.length ? ` ${CONTEXT.wordsOf(p.text).join(" ")} ` : "";
      if (named || grams.some((g) => joined.includes(g))) add(url, title);
    }
    for (const c of run.children || []) for (const x of (c.result && c.result.sources) || []) add(x.url, x.title);
    return out.slice(0, SOURCES_SHOWN);
  }

  function onDone(run, a, page, env, fx) {
    const texts = textsOf(run, page, env);
    const located = CONTEXT.locateEvidence(a.evidence, texts);
    const missing = located.filter((e) => !e.found);
    // With some pages' text let go, a quote not in what is kept may be from one of them: it was not checked, not found wanting.
    const dropped = run.dropped || [];
    if (dropped.length) for (const e of missing) e.unchecked = true;
    if (missing.length && run.evidenceRounds < EVIDENCE_ROUNDS && !run.finalStep) {
      run.evidenceRounds += 1;
      const quotes = missing.map((e) => `"${clip(e.quote, 100)}"`).join(", ");
      const which = missing.length === 1 ? "A quote" : `${missing.length} quotes`;
      const are = missing.length === 1 ? "is" : "are";
      record(run, a, false, dropped.length
        ? `${which} in evidence could not be checked: ${quotes} ${are} not in the page text this run still keeps. To make room, the text of ${dropped.length === 1 ? "this earlier page was" : `these ${dropped.length} earlier pages was`} let go: ${dropped.slice(-8).map((p) => `${clip(p.title || p.url, 60)} (${clip(p.url, 100)})`).join("; ")}${dropped.length > 8 ? `; and ${dropped.length - 8} before them` : ""}. A quote from one of those is checked once that page is open again. Otherwise copy quotes exactly from the page text, or leave the claim out.`
        : `${which} in evidence ${are} not in anything you have been shown in this run: ${quotes}. Copy quotes exactly from the page text, read the page first, or leave the claim out.`);
      // What the shown text has nearest each quote, so the exact words can be copied.
      const near = missing.slice(0, 3).map((e) => {
        const n = CONTEXT.nearestPassage(e.quote, texts, 240);
        return n
          ? `For "${clip(e.quote, 100)}", the nearest text you were shown${n.title ? ` (${clip(n.title, 60)})` : ""} reads: "${n.text}"`
          : `Nothing like "${clip(e.quote, 100)}" is in what you have read.`;
      });
      run.notice = [run.notice, ...near].filter(Boolean).join("\n");
      log(run, "validator", "Quote Not Found", missing.map((e) => clip(e.quote, 100)).join(" | "));
      run.quoteRejected = true;
      return closeStep(run, fx);
    }
    const settings = env.settings || {};
    const sources = sourcesOf(run, a, located, texts);
    // Every answer is checked, whatever the model and whatever step it comes
    // on, unless checking is turned off: an answer on the first step can be
    // one from memory on a task that names a site. The helper checks when
    // there is one; otherwise the run's own model does, in a fresh context.
    // Nothing goes to a model or provider the user did not choose.
    const checked = a.success && settings.verify !== false && run.verifyRounds < VERIFY_ROUNDS;
    if (checked) {
      run.verifyRounds += 1;
      run.pendingDone = { ...a, missing: missing.map((e) => e.quote), sources };
      // The answer is shown while it is checked, marked as being checked.
      // The check decides exactly as it would with nothing shown: the run
      // ends only on its verdict, and an answer it sends back is marked as
      // replaced while the run works on.
      run.provisional = { text: a.answer, at: env.now || 0 };
      if (!run.firstAnswerAt) run.firstAnswerAt = env.now || 0;
      run.journal.push({ k: "provisional", text: a.answer, sources, round: run.verifyRounds });
      status(run, "validator", "Checking the answer…");
      quietLog(run, "validator", "Checking Answer", `Checking the answer against what was read${run.helper ? `, with ${run.helper.model}` : ""}.`);
      // Whether any quote was found on a web page of this run, as opposed to the request, the date, or nothing.
      const fromPage = located.some((e) => e.found && /^https?:/i.test(String(e.url || "")));
      const m = CONTEXT.verifierMessages(run, a, located, page, env.now, { fromPage });
      fx.push({ type: "model", system: m.system, user: m.user, tool: CONTEXT.VERDICT_TOOL, tier: run.helper ? "helper" : "pro", purpose: "verify", effort: "default" });
      return fx;
    }
    record(run, a, true, "Finished.");
    return finish(run, fx, env, { ...a, sources }, missing.length ? { verified: false, note: dropped.length ? "Not double-checked: part of this could not be matched to the page text still kept from this run." : "Not double-checked: part of this could not be matched to the pages that were read." } : { verified: null });
  }

  /** The answer shown while it was checked is no longer the answer: the run works on. */
  function provisionalReplaced(run, why) {
    if (!run.provisional) return;
    run.provisional = null;
    run.journal.push({ k: "provisional_replaced", why: String(why || "") });
  }

  function onVerified(run, event, page, env) {
    const fx = [];
    if (run.status !== "running" || !run.pendingDone) return fx;
    addUsage(run, event.usage);
    const a = run.pendingDone;
    run.pendingDone = null;
    const verdict = CONTEXT.readVerdict(event.reply);
    // Page text the check found speaking to an AI: the run teaches nothing,
    // whatever the verdict.
    if (verdict && verdict.speaksToAi && !run.injectionSeen) {
      run.injectionSeen = true;
      log(run, "validator", "Text Aimed at AI", "Page text read in this run speaks to AI assistants. Nothing from this run will be learned.");
    }
    if (!verdict) {
      log(run, "validator", "Check Inconclusive", "The check gave no usable verdict.");
      record(run, a, true, "Finished.");
      return finish(run, fx, env, a, { verified: null, note: "Not double-checked." });
    }
    if (verdict.pass && !a.missing.length) {
      quietLog(run, "validator", "Check Passed", verdict.reason || "The answer is supported by what was read.");
      record(run, a, true, "Finished.");
      return finish(run, fx, env, a, { verified: true });
    }
    const why = [verdict.reason, verdict.unmet.length ? `Not shown to be met: ${verdict.unmet.join("; ")}.` : ""].filter(Boolean).join(" ");
    log(run, "validator", "Check Failed", why);
    if (run.verifyRounds < VERIFY_ROUNDS && !run.finalStep) {
      run.sentBack = true;
      provisionalReplaced(run, why);
      run.notice = [run.notice, `A check of your answer against what you have read found: ${why}`].filter(Boolean).join("\n");
      record(run, a, false, `Not finished yet. A check of your answer against what you have read found: ${why}`);
      return closeStep(run, fx);
    }
    // The check still objects and the run does not go on: the answer stands
    // as the model gave it, with what the check could not confirm beside it.
    // A helper never gets here without having taken a step since the first
    // objection: the answer sent back puts the run in difficulty, which
    // gives the helper the very next step.
    const open = [...verdict.unmet, ...a.missing.map((q) => `"${clip(q, 100)}" is not in ${(run.dropped || []).length ? "the page text still kept" : "what was read"}`)];
    if (!open.length) open.push(verdict.reason || "the check did not say what");
    record(run, a, true, "Finished, not confirmed.");
    return finish(run, fx, env, a, { verified: false, unconfirmed: open, note: `Part of this could not be confirmed: ${clip(open.join("; "), 300).replace(/[.\s]+$/, "")}.` });
  }

  function finish(run, fx, env, a, check) {
    if (run.current && run.current.actions.length) run.history.push(run.current);
    run.current = null;
    run.queue = [];
    // The answer is the model's own. What the check thought of it is kept
    // beside it, not written into it: the check is a second opinion, and a
    // wrong one should not change what the user is told. An answer the check
    // still objected to ends "unconfirmed": answered, not shown to be right.
    const state = check.unconfirmed ? "unconfirmed" : "success";
    return end(run, fx, env, { state, text: a.answer, note: check.note || "", ...(check.unconfirmed ? { unconfirmed: check.unconfirmed } : {}), success: a.success, verified: check.verified, evidence: a.evidence || [], sources: a.sources || [], kind: a.success ? "done" : "partial" });
  }

  function end(run, fx, env, outcome) {
    run.status = outcome.state === "success" || outcome.state === "unconfirmed" ? "done" : outcome.state === "idle" ? "stopped" : "failed";
    run.outcome = outcome;
    // Sub-tasks end with the run that handed them out.
    if ((run.children || []).some((c) => c.state !== "ended")) stopChildren(run, env || {}, fx, outcome.kind === "budget" ? "the cost budget was reached." : "the task it was part of ended.");
    run.delegation = null;
    run.endedAt = (env && env.now) || 0;
    run.wait = null;
    run.queue = [];
    if (run.current && run.current.actions.length) { run.history.push(run.current); run.current = null; }
    // An answer still being checked when the run ended another way (stopped,
    // an error) was never confirmed: the view says so beside it.
    const unchecked = !!run.provisional && outcome.state !== "success" && outcome.state !== "unconfirmed";
    run.provisional = null;
    if (outcome.text && (outcome.state === "success" || outcome.state === "unconfirmed") && !run.firstAnswerAt) run.firstAnswerAt = run.endedAt;
    run.journal.push({ k: "answer", state: outcome.state, text: outcome.text, note: outcome.note || "", ...(outcome.unconfirmed ? { unconfirmed: outcome.unconfirmed } : {}), verified: outcome.verified === undefined ? null : outcome.verified, sources: outcome.sources || [], ...(unchecked ? { provisionalUnchecked: true } : {}), used: { details: run.used.details.map((k) => KNOWN.FIELD_LABEL[k] || k), notes: run.used.notes, kinds: run.used.kinds || {} } });
    if (run.offers.length && outcome.state !== "error") run.journal.push({ k: "offer", id: `${run.id}-offer`, items: run.offers });
    fx.push({ type: "end" });
    return fx;
  }

  /**
   * The provider turned requests away for longer than is worth waiting in
   * the call. The run waits, as it waits for the user, until the time the
   * provider named (or, when it named none, a while that doubles with each
   * such refusal before the provider answers again),
   * then carries on by itself. The driver wakes it then.
   */
  function pause(run, event, env) {
    addUsage(run, event.usage);
    const now = env.now || 0;
    const inRow = run.pausedInRow || { n: 0, ms: 0 };
    // The day's allowance or the account's credit is spent: the run is
    // held, not ended, and goes on from here when the allowance is back, a
    // backup is connected, or the user says to try again.
    if (event.kind === "limit") {
      const limit = event.limit || {};
      // It comes back by itself only at a time the provider named, and not
      // again and again when the provider's answer at that time is the same.
      const until = limit.resetAt > 0 && inRow.n < PAUSES_IN_ROW ? Math.max(limit.resetAt, now + PAUSE_FIRST_MS) : 0;
      const said = String(limit.short || event.message || "The provider's usage limit is reached.").trim();
      log(run, "system", "Out Of Requests", `${said} Holding the task here${until ? ` for ${duration(until - now)}` : ""}.`);
      return hold(run, env, { why: "limit", said, until, outcome: { state: "limit", kind: "limit", text: event.message || "The model request failed." } });
    }
    const named = event.waitMs > 0;
    const ms = named ? event.waitMs : Math.min(PAUSE_LONGEST_MS, PAUSE_FIRST_MS * 2 ** (run.pauses || 0));
    const said = String(event.message || "The provider asked to wait.").trim();
    // Waiting by itself has a limit: past it the run is held for the user,
    // who can try again, switch to a backup, or take what it found.
    if (inRow.n >= PAUSES_IN_ROW || inRow.ms + ms > PAUSED_IN_ROW_MS) {
      log(run, "system", "Provider Still Refusing", `${said} Holding the task here after ${inRow.n} wait${inRow.n === 1 ? "" : "s"} in a row.`);
      const text = `The provider kept turning requests away${inRow.n ? ` after ${inRow.n} wait${inRow.n === 1 ? "" : "s"} (${duration(inRow.ms)} in all)` : ""}, so I stopped here. ${said} Try again later or pick another model in Settings.`;
      // One long wait the provider named is waited out; a row of refusals is not started again unasked.
      return hold(run, env, { why: "crowded", said, until: named && inRow.n === 0 ? now + ms : 0, outcome: { state: "error", kind: "rate_limited", text } });
    }
    run.pausedInRow = { n: inRow.n + 1, ms: inRow.ms + ms };
    if (!named) run.pauses = (run.pauses || 0) + 1;
    run.step = Math.max(0, run.step - 1);
    run.queue = [];
    log(run, "system", "Provider Asked To Wait", `${said} Waiting ${duration(ms)}.`);
    return waitFor(run, [], env, { kind: "pause", until: (env.now || 0) + ms, question: `${said} I will carry on by myself in ${duration(ms)}.` });
  }

  /**
   * The provider will not answer for now (a spent allowance, a model that
   * stays crowded). The run keeps everything it has and waits on the same
   * card as a pause, with the choices on it: go on at `until` when there is
   * one, go on when the user says so or connects a backup (pause_over), or
   * stop with what was found (wrap_up), which is the ending the run used to
   * be given straight away.
   */
  function hold(run, env, h) {
    const now = env.now || 0;
    const inRow = run.pausedInRow || { n: 0, ms: 0 };
    if (h.until) run.pausedInRow = { n: inRow.n + 1, ms: inRow.ms + (h.until - now) };
    run.step = Math.max(0, run.step - 1);
    run.queue = [];
    const next = h.until ? `I will carry on from here by myself in ${duration(h.until - now)}, or sooner if you connect a backup or say to try again.` : "I will carry on from here when you connect a backup or say to try again.";
    return waitFor(run, [], env, { kind: "pause", hold: h.why, ...(h.until ? { until: h.until } : {}), outcome: h.outcome, question: `${h.said} Nothing is lost. ${next}` });
  }

  /** The user chose to stop at a hold: the run ends as it would have, with what it found. */
  function endHold(run, env) {
    const w = run.wait;
    run.journal.push({ k: "ask_done", id: w.id, how: "wrap_up" });
    return end(run, [], env, { ...w.outcome, text: `${w.outcome.text}${found(run)}` });
  }

  // ------------------------------------------------------------------ events

  /**
   * @param run   the run (changed in place)
   * @param event {type, ...}
   * @param env   {now, page, settings: {riskConfirmation, allowlist, verify},
   *               extras: {selection, openTabPages, tabs, known, settings}}
   * @returns effects: [{type: "observe" | "model" | "act" | "attention" | "end", ...}]
   */
  const CALLS_KEPT = 300;
  function advance(run, event, env) {
    const from = run.journal.length;
    if (event && (event.type === "model_replied" || event.type === "model_failed")) noteCall(run, event);
    const fx = advanceRun(run, event, env);
    // Each entry carries when it happened, for the saved log.
    const at = (env && env.now) || 0;
    if (at) for (let i = from; i < run.journal.length; i++) if (!run.journal[i].at) run.journal[i].at = at;
    return fx;
  }

  /** A model call, for the saved log: what it was for, the model, its time and tokens. */
  function noteCall(run, event) {
    if (!Array.isArray(run.calls)) run.calls = [];
    const u = event.usage || {};
    run.calls.push({
      purpose: event.purpose || "step", step: run.step, by: event.purpose === "verify" ? (run.helper ? "helper" : "main") : run.by || "main",
      model: u.model || "", ms: event.ms || 0, prompt: u.prompt || 0, completion: u.completion || 0, ...(u.cached ? { cached: u.cached } : {}),
      ok: event.type === "model_replied", ...(event.type === "model_failed" ? { failed: event.kind || "model" } : {}),
    });
    if (run.calls.length > CALLS_KEPT) run.calls = run.calls.slice(-CALLS_KEPT);
  }

  function advanceRun(run, event, env) {
    const e = env || {};
    const page = e.page || null;
    // Time counts while the run works, not while it waits; a worker that
    // was asleep was not working either.
    const now = e.now || 0;
    // While every sub-task at work waits for the user, nothing is being worked on.
    const allWait = !!run.delegation && run.children.filter((c) => SUB_LIVE.has(c.state)).every((c) => c.run.status === "waiting");
    if (run.status === "running" && !allWait && run.clock && now > run.clock && event.type !== "resume") run.activeMs = (run.activeMs || 0) + Math.min(GAP_MS, now - run.clock);
    if (now) run.clock = now;
    // The user's answer to something a sub-task waits for goes to that sub-task.
    if (event.id && event.type !== "child" && (run.children || []).length) {
      const c = run.children.find((x) => x.state === "running" && x.run.wait && x.run.wait.id === event.id);
      if (c) return isOver(run) ? [] : stepChild(run, c, event, e, []);
    }
    switch (event.type) {
      case "child":
        return onChild(run, event, e);
      case "start":
        log(run, "system", "Task Started", run.task);
        return [{ type: "observe", first: true }];
      case "observed":
        if (event.moved) startedOver(run, event.moved);
        return onObserved(run, event.page, e);
      case "model_replied":
        if (event.purpose === "opinion") return onOpinion(run, event, page, e);
        if (event.purpose === "addressed") return onAddressed(run, event, page, e);
        return event.purpose === "verify" ? onVerified(run, event, page, e) : onModelReplied(run, event, page, e);
      case "model_failed": {
        if (run.status !== "running") return [];
        // The check could not be run: the answer stands, and says so.
        if (event.purpose === "verify" && run.pendingDone) return onVerified(run, { reply: null, usage: event.usage }, page, e);
        // No second opinion: the action is decided by the rules alone.
        if (event.purpose === "opinion") return onOpinion(run, { reply: null, usage: event.usage }, page, e);
        // No answer about hidden text: the page is taken up without one.
        if (event.purpose === "addressed") return onAddressed(run, { reply: null, usage: event.usage }, page, e);
        // The model cannot be shown pictures after all: carry on without.
        if (event.kind === "no_vision" && !run.noVision) {
          addUsage(run, event.usage);
          run.noVision = true;
          run.notice = "This model cannot be shown pictures. Work from the page's text and controls.";
          run.step = Math.max(0, run.step - 1);
          return page ? onObserved(run, page, e) : [{ type: "observe" }];
        }
        // The model answered, but with nothing that names a step: the same as a step that cannot be used.
        if (event.kind === "no_action" && event.purpose !== "verify" && page) {
          addUsage(run, event.usage);
          // The call already asked again as often as one step may (llm.js):
          // the asks that follow here are single ones, so a model that names
          // no step costs six requests before the run stops, not twelve.
          run.askedOut = true;
          return unusable(run, page, e, [], "It did not call the step tool. Reply only by calling it.");
        }
        // The provider wants a while before it takes more: the run waits,
        // and carries on by itself when the time is up. The step was not
        // taken, so it is taken again then, on the page as it is then.
        // A spent allowance holds the run the same way, for the user or the
        // reset to carry it on: what it has done so far is not thrown away.
        if (event.kind === "rate_limited" || event.kind === "limit") return pause(run, event, e);
        // What the failed call used is still the run's cost.
        addUsage(run, event.usage);
        return end(run, [], e, { state: "error", text: `${event.message || "The model request failed."}${found(run)}`, kind: event.kind || "model" });
      }
      case "keep_going":
      case "wrap_up":
        if (event.type === "wrap_up" && run.status === "waiting" && run.wait && run.wait.kind === "pause" && run.wait.hold && (!event.id || event.id === run.wait.id)) return endHold(run, e);
        return onCheckIn(run, event, e);
      case "pause_over": {
        const w = run.wait;
        if (run.status !== "waiting" || !w || w.kind !== "pause" || (event.id && event.id !== w.id)) return [];
        run.status = "running";
        run.wait = null;
        run.journal.push({ k: "ask_done", id: w.id, how: "pause_over" });
        // Asked for by the user (try again, a backup connected): the waits start from the shortest again.
        if (event.by === "user") { run.pauses = 0; run.pausedInRow = { n: 0, ms: 0 }; }
        log(run, "system", "Carrying On", event.by === "user" ? "Trying the provider again." : "The wait the provider asked for is over.");
        status(run, "executor", "Carrying on…");
        return [{ type: "observe" }];
      }
      case "acted":
        return onActed(run, event, page, e);
      case "answered":
      case "approved":
      case "declined":
      case "user_done":
      case "cleared":
      case "skipped":
        return onUser(run, event, page, e);
      case "blocked":
        // The driver could not go on without the user (no access to the site yet).
        if (run.status !== "running") return [];
        return waitFor(run, [], e, { kind: event.kind, question: event.question, detail: event.detail || [] });
      case "steer": {
        const text = String(event.text || "").trim();
        if (!text || run.status === "done" || run.status === "failed" || run.status === "stopped") return [];
        const waitKind = run.status === "waiting" && run.wait ? run.wait.kind : "";
        if (run.delegation) {
          // A sub-task waiting on a question takes it as the answer; otherwise
          // it is said to this run and to every sub-task at work.
          const asking = run.children.find((c) => c.state === "running" && c.run.status === "waiting" && c.run.wait && !["approval", "check_in", "pause"].includes(c.run.wait.kind));
          if (asking && !waitKind) return stepChild(run, asking, { type: "answered", text, keep: !!event.keep }, e, []);
          run.steers.push(text);
          run.said.push(text);
          log(run, "system", "You Added", text);
          const fx = [];
          for (const c of run.children) if (c.state === "running" && c.run.status === "running") stepChild(run, c, { type: "steer", text }, e, fx);
          if (waitKind === "check_in") return [...fx, ...onCheckIn(run, { type: "keep_going", id: run.wait.id }, e)];
          return fx;
        }
        // A message while the run waits on a question is its answer.
        if (waitKind && !["approval", "check_in", "pause"].includes(waitKind)) return onUser(run, { type: "answered", text, keep: !!event.keep }, page, e);
        run.steers.push(text);
        run.said.push(text);
        log(run, "system", "You Added", text);
        run.stuck = { steps: 0, helper: 0, at: run.step };
        if (run.wrapUp && run.wrapUp.by === "stuck") run.wrapUp = null;
        // Something said at a check-in is said to go on with it in mind.
        if (waitKind === "check_in") return onCheckIn(run, { type: "keep_going", id: run.wait.id }, e);
        return [];
      }
      case "resume":
        // Sub-tasks at work go on where they were; this run waits for them.
        if (run.delegation && !isOver(run)) {
          const fx = run.status === "waiting" && run.wait ? [{ type: "attention", wait: run.wait, again: true }] : [];
          for (const c of run.children) {
            if (c.state === "starting") c.state = "queued";
            else if (c.state === "running") stepChild(run, c, { type: "resume" }, e, fx);
          }
          return startChildren(run, e, fx);
        }
        // The extension was put to sleep mid-run: look at the page again and go on.
        if (run.status !== "running") return run.status === "waiting" && run.wait ? [{ type: "attention", wait: run.wait, again: true }] : [];
        run.queue = [];
        if (run.current && run.current.actions.length) run.history.push(run.current);
        run.current = null;
        if (run.pendingDone) provisionalReplaced(run, "The check was cut off when the browser paused this run.");
        run.pendingDone = null;
        run.pendingOpinion = null;
        run.pendingAddressed = null;
        run.typed = {};
        run.focusRef = null;
        run.step = Math.max(0, run.step - 1);
        run.notice = "The browser paused this run for a moment. Check the page before going on.";
        return [{ type: "observe" }];
      case "tab_closed":
        if (run.status !== "running" && run.status !== "waiting") return [];
        return end(run, [], e, { state: "error", text: "The tab the agent was working on was closed. Task stopped.", kind: "tab_closed" });
      case "stop":
        if (run.status !== "running" && run.status !== "waiting") return [];
        return end(run, [], e, { state: "idle", text: `${event.text || "Stopped."}${found(run)}`, kind: "stopped" });
      default:
        return [];
    }
  }

  /** The run without its bulk, for saving after every step. */
  function toStored(run) {
    // A picture is for one step and is not kept; once a run or sub-task is
    // over, its seen page texts and last page snapshot are no longer needed.
    const trim = (r) => (!r ? r : isOver(r) ? { ...r, image: null, seen: [], previous: null } : { ...r, image: null });
    return { ...trim(run), journal: run.journal.slice(-400), children: (run.children || []).map((c) => ({ ...c, run: trim(c.run) })) };
  }

  /** What "Save log" and the test harnesses read: each action with what it did. */
  function trace(run) {
    const history = [];
    for (const h of [...run.history, ...(run.current ? [run.current] : [])]) {
      h.actions.forEach((a, i) => history.push({ step: h.step, ok: a.ok, action: a.text, on: a.on || "", goal: h.goal, url: h.url || "", outcome: clip(a.result, 300), ...(a.settle !== undefined ? { settle: a.settle } : {}), ...(a.pointer ? { pointer: a.pointer } : {}), ...(h.by ? { by: h.by } : {}), ...(i === 0 && h.note ? { note: h.note } : {}) }));
    }
    // Sub-tasks are part of the run: their actions are in its history,
    // marked with the sub-task, and their steps and time in its counts. Their
    // model calls, tokens and cost are in the run's usage already.
    const kids = (run.children || []).filter((c) => c.run).map((c) => ({ c, t: trace(c.run) }));
    for (const { c, t } of kids) for (const h of t.history) history.push({ ...h, sub: c.id });
    const sum = (f) => kids.reduce((n, k) => n + (f(k.t) || 0), 0);
    let timing = run.timing || null;
    if (kids.some((k) => k.t.timing)) {
      timing = { observe: 0, model: 0, act: 0, settle: 0, ...(run.timing || {}) };
      for (const { t } of kids) {
        if (!t.timing) continue;
        for (const k of ["observe", "model", "act", "settle"]) timing[k] = (timing[k] || 0) + (t.timing[k] || 0);
        if (t.timing.pointer) timing.pointer = { real: ((timing.pointer && timing.pointer.real) || 0) + (t.timing.pointer.real || 0), synthetic: ((timing.pointer && timing.pointer.synthetic) || 0) + (t.timing.pointer.synthetic || 0) };
      }
    }
    return {
      id: run.id,
      task: run.task,
      // The tab the run is working in, for the view to name the site.
      tabId: run.tabId === undefined ? null : run.tabId,
      steps: run.step + sum((t) => t.steps),
      ownSteps: run.step,
      running: run.status === "running",
      waitingForUser: run.status === "waiting",
      waitKind: run.wait ? run.wait.kind : "",
      waitHold: run.wait ? run.wait.hold || "" : "",
      stopState: run.outcome ? run.outcome.state : "",
      endKind: run.outcome ? run.outcome.kind || "" : "",
      validated: !!(run.outcome && run.outcome.verified === true),
      // The answer the run ended with, and nothing before it: an answer
      // shown while it was being checked is not this until the check passes.
      answer: run.outcome && run.outcome.text ? String(run.outcome.text) : "",
      checking: !!run.provisional,
      sources: (run.outcome && run.outcome.sources) || [],
      // Milliseconds from the request to the first answer shown (while
      // being checked, or final) and to the run's end.
      firstAnswerMs: run.firstAnswerAt && run.startedAt ? run.firstAnswerAt - run.startedAt : 0,
      endedMs: run.endedAt && run.startedAt ? run.endedAt - run.startedAt : 0,
      modelCalls: (run.calls || []).slice(),
      tokens: { prompt: run.usage.prompt, completion: run.usage.completion, cached: run.usage.cached || 0, cacheWrite: run.usage.cacheWrite || 0 },
      calls: run.usage.calls || 0,
      // Milliseconds spent reading the page, waiting for the model, and acting;
      // `settle` is the part of acting spent waiting for the page to finish what an action started;
      // `pointer` counts the pointer actions that were real and those made by a script.
      timing,
      costUSD: run.usage.cost,
      models: run.usage.models,
      // Steps the model took (a reply that could be used), and how many of them the helper took.
      stepsTaken: (run.steps || 0) + sum((t) => t.stepsTaken),
      helperSteps: (run.helperSteps || 0) + sum((t) => t.helperSteps),
      // Milliseconds the run spent working, not waiting; and how often it asked whether to go on.
      activeMs: run.activeMs || 0,
      checkIns: run.checkIns || 0,
      // What was shown from memory: at the first step, and over the whole run.
      known: { first: (run.used && run.used.first) || null, ids: (run.used && run.used.ids) || [], kinds: (run.used && run.used.kinds) || {} },
      history,
      // The model's notes as they ended, and what each step reached: pages
      // arrived at (revisits, search results, new pages), searches, notes
      // added; when the run was found wandering, and the helper's hand-backs.
      notes: run.memory || "",
      progress: run.progress ? { pages: Object.keys(run.visits || {}).length, steps: run.progress.steps, wandering: run.progress.fired, handBacks: run.handBacks || [] } : null,
      // Each sub-task by itself: what it was given, how it ended, and what it took.
      children: kids.map(({ c, t }) => ({ id: c.id, task: c.task, start: c.url, state: c.state, outcome: c.result ? c.result.state : "", success: !!(c.result && c.result.success), tabId: c.tabId, waitingForUser: t.waitingForUser, waitKind: t.waitKind, steps: t.steps, stepsTaken: t.stepsTaken, calls: t.calls, tokens: t.tokens, costUSD: t.costUSD, activeMs: t.activeMs, timing: t.timing, models: t.models })),
    };
  }

  const PROGRESS = Object.freeze({ REVISIT_WINDOW, REVISITS, SEARCH_WINDOW, SEARCHES, HELPER_STEPS, wanderingOf, isSearchAddress, typedText, queryValues, nextPageOf, madeProgress });
  const api = Object.freeze({ newRun, advance, toStored, trace, toolFor, inDifficulty, effortOf, PROGRESS });
  root.SELECT_TO_AI_RUN = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
