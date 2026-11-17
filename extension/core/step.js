/**
 * Select to AI - what the model sends back each step, and whether it can be used.
 *
 * One tool, `step`: what the model adds to its notes, its goal for the
 * step, and the actions to run in order. An action is one thing a person would do (press
 * this, put this value there, go here, read that), or one of the two ways a
 * run pauses or ends (ask_user, done).
 *
 * Everything here is a pure function. A reply that cannot be used gets an
 * error that says how to fix it, which goes back to the model as the result
 * of its step; nothing here rewrites what the model chose.
 */
(function initStep(root) {
  "use strict";

  const clip = (t, n) => {
    const v = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  };

  /** What each action needs. `page` marks the ones that act on the page. */
  const ACTIONS = Object.freeze({
    click: { needs: ["ref"], page: true },
    hover: { needs: ["ref"], page: true },
    // Its result is needed before anything else is done: never in `then`.
    drag: { needs: ["ref"], page: true, alone: true },
    click_at: { needs: ["x", "y"], page: true, alone: true },
    fill: { needs: ["ref", "value"], page: true },
    fill_details: { needs: [], page: true },
    recall: { needs: ["from"], page: false },
    remember: { needs: ["value"], page: false },
    press: { needs: ["key"], page: true },
    scroll: { needs: [], page: true },
    navigate: { needs: ["url"], page: true },
    back: { needs: [], page: true },
    tabs: { needs: ["op"], page: true },
    wait: { needs: [], page: false },
    look: { needs: [], page: false },
    read: { needs: [], page: false },
    find: { needs: ["query"], page: false },
    // Its result is every sub-task's answer, so nothing follows it in a step.
    delegate: { needs: ["tasks"], page: false, alone: true },
    ask_user: { needs: ["question"], ends: true },
    done: { needs: ["success", "answer"], ends: true },
  });
  const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));
  // The last step of a run can only end it.
  const ENDING_ACTIONS = Object.freeze(["done", "ask_user"]);

  // Room for the model's notes, which it is shown in full every step. Under
  // the smallest page budget (defaults.js: 8,000 characters for a small
  // model), so the notes never outweigh the page they are read beside, and
  // enough for a dozen compared items at about 400 characters each with the
  // plan around them (the earlier 2,400 held about five). The model is
  // told the room, how much it uses, and when something was cut (context.js).
  const NOTES_ROOM = 6000;
  // The notes are added to a line or two at a time, so they can pass their
  // room between two steps. Past it they are kept, and the model is asked
  // to rewrite them shorter; a note that would take them past the smallest
  // page budget is not added, and the model is told so.
  const NOTES_LIMIT = 8000;

  // press: one control the user is to press themselves, named by its ref
  // (a control that takes only a real press, which a scripted one is not).
  const ASK_KINDS = Object.freeze(["question", "sign_in", "human_check", "code", "payment", "press"]);

  // Sub-tasks one delegate action hands out. Each is a run of its own in a
  // tab of its own (core/run.js says how many run at once and why); past
  // four, a request is better split again once the first answers are in.
  const DELEGATE_MAX = 4;

  /**
   * The `step` tool. The action is the tool's own fields, one level deep:
   * small models fill a flat form far more reliably than a list of nested
   * objects (measured on tests/decisions: a nested list of actions was left
   * empty whenever the step was simply to answer). More actions for the
   * same step go in `then`.
   *
   * What is offered follows what is possible on this step: `read` only
   * when the page has text that was not shown, the actions that use the
   * user's details only when some are on file, and on the last step only
   * the two that end it.
   *
   * click_at is offered only when the run has something to aim with: a
   * position the listing gives, or a picture of the screen.
   *
   * delegate is offered only to a run the user started: a sub-task does its
   * part itself.
   *
   * @param o {maxActions, finalStep, canRead, hasDetails, canLook, canAim, canDelegate}
   */
  function stepTool(o) {
    const opts = { maxActions: 3, finalStep: false, canRead: true, hasDetails: true, canLook: false, canAim: false, canDelegate: false, ...(o || {}) };
    const on = (name) => {
      if (opts.finalStep) return ENDING_ACTIONS.includes(name);
      if (name === "read") return opts.canRead;
      if (name === "look") return opts.canLook;
      if (name === "click_at") return opts.canAim;
      if (name === "delegate") return opts.canDelegate;
      if (name === "fill_details" || name === "recall") return opts.hasDetails;
      return true;
    };
    const names = ACTION_NAMES.filter(on);
    const about = {
      click: "click: press a control or follow a link (ref).",
      hover: "hover: move the pointer over a control without pressing it (ref), for a menu or tooltip that opens when the pointer is over it. Its result says what that brought up, or that nothing came up.",
      drag: "drag: press on a control, move it while holding, and let go (ref; to_ref, or direction and distance): an item to move in a list, a thing to drop on a box, a knob that fill cannot set. To set a slider to a number, use fill. Nothing else runs in the same step: its result says what changed, and a drag that changed nothing was not followed by the page.",
      click_at: "click_at: press a point on the page that has no number in the listing, such as a spot on a map or a drawing (x, y: page pixels from its top left corner, as the listing gives them after \"at\").",
      fill: `fill: give a control a value (ref, value). It works on text boxes, dropdowns, checkboxes (value "on" or "off"), radio buttons, date fields and sliders, and replaces what was there.${opts.hasDetails ? " With from in place of value it puts in one of the user's details on file." : ""}`,
      fill_details: "fill_details: fill every field of a form that the user's details on file cover, in one go (ref: any control in that form). It says what it filled and what is left.",
      recall: "recall: read details on file when you have to write with them yourself (from). The user is shown what you read.",
      remember: "remember: keep something the user told you about themselves or how they want things done, for later tasks (value, scope).",
      press: "press: a key such as Enter, Escape or ArrowDown (key; ref of the field to press it in).",
      scroll: "scroll: move down or up the page (direction), for a list that loads more as it is scrolled, or to bring later items of a long list into the listing. With a ref as well, it scrolls inside the box that control is in (a long text box, a panel with its own scroll bar). It is not needed to reach a control: every control can be acted on by its ref wherever it is.",
      navigate: "navigate: open an address (url).",
      back: "back: go back one page.",
      tabs: 'tabs: op "open" (url), "switch" (tab) or "close" (tab).',
      wait: "wait: pause while a page loads (seconds).",
      look: "look: get a picture of the page as it is on screen, for what the text does not show: an image, a chart, a map, a layout.",
      read: "read: the next part of a long page's text (part).",
      find: "find: search the whole page for words (query), in its text and on its controls, on screen or not. It matches words as the page writes them, so give words the page would use (a name, a label, a number written the page's way), not a description of what you want. It returns the passages and the controls that have them, or says nothing matched. Use it to look for something instead of scrolling.",
      delegate: `delegate: hand out up to ${DELEGATE_MAX} independent sub-tasks that run at the same time, each in a background tab of its own (tasks: for each, a short instruction that stands by itself, and the address to start at when you know it). You get every sub-task's answer back as this action's result. Nothing else runs in the same step.`,
      ask_user: "ask_user: hand something only the user can do or decide to them, then carry on (kind, question). With kind \"press\" and a ref, the user presses that one control themselves and you carry on once they have.",
      done: "done: finish. Use it as soon as you can answer, with the full answer (success, answer, evidence). Answering a question about the page in front of you is done, with nothing before it.",
    };
    const action = {
      do: { type: "string", enum: names, description: names.map((n) => about[n]).join(" ") },
      ref: { type: "integer", description: "The number in [brackets] before a control in the page listing." },
      value: { type: "string", description: "fill: the text to put in, the option to choose, \"on\"/\"off\" for a checkbox, or a date as the field shows it. remember: what to keep, in one short sentence." },
      ...(opts.hasDetails ? { from: { type: "string", description: "fill, recall: a detail on file, such as \"profile.email\". recall takes several, separated by commas." } } : {}),
      to_ref: { type: "integer", description: "drag: the number of the control to drop it on." },
      distance: { type: "integer", description: "drag: how far to move it, in page pixels, in direction." },
      ...(on("click_at") ? {
        x: { type: "integer", description: "click_at: pixels from the left edge of the page." },
        y: { type: "integer", description: "click_at: pixels from the top edge of the page." },
      } : {}),
      key: { type: "string", description: "press: the key name." },
      times: { type: "integer", description: "press: how many times in a row, when more than once." },
      url: { type: "string", description: "navigate, tabs open: a full https address." },
    };
    return {
      name: "step",
      description:
        "Say where you are and what to do next in the user's browser. The action is these fields: do, and what that action needs. " +
        "If the request can be answered now, do is \"done\" and answer holds the full answer.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description:
              "What you learned or decided this step that you will need later, in one or two short lines, with the page a fact came from; leave it empty if nothing. It is added to your notes, which you are shown every step: write only what is new, not the notes again. The answer itself does not go here: it goes in answer, with do \"done\".",
          },
          rewrite_notes: {
            type: "string",
            description:
              `Rarely needed: your whole notes, rewritten, to replace them. Only when something in them is wrong or they are full; leave it out otherwise. There is room for ${NOTES_ROOM} characters.`,
          },
          goal: { type: "string", description: "What this step is for, in a few words." },
          ...action,
          direction: { type: "string", enum: ["down", "up", "left", "right", "bottom", "top"], description: "scroll: one screen down, up, left or right, or all the way to the bottom or top. drag: which way to move it (down, up, left or right)." },
          ...(on("find") ? { query: { type: "string", description: "find: the words to look for, as the page would write them." } } : {}),
          ...(on("delegate") ? {
            tasks: {
              type: "array",
              maxItems: DELEGATE_MAX,
              description: "delegate: the sub-tasks, each one site or one item.",
              items: {
                type: "object",
                properties: {
                  task: { type: "string", description: "What this sub-task is to find out or do, in one or two sentences that make sense without the rest of the request." },
                  url: { type: "string", description: "The full https address to start at, when known." },
                },
                required: ["task"],
              },
            },
          } : {}),
          ...(on("read") ? { part: { type: "integer", description: "read: which part of a long page, counting from 1." } } : {}),
          op: { type: "string", enum: ["open", "switch", "close"], description: "tabs: what to do." },
          tab: { type: "integer", description: "tabs switch, close: the tab number from the tab list." },
          seconds: { type: "number", description: "wait: how long, up to 10." },
          scope: { type: "string", enum: ["everywhere", "this_site"], description: "remember: whether it holds everywhere or only on this site." },
          kind: { type: "string", enum: ASK_KINDS, description: "ask_user: sign_in, human_check, code or payment when the page needs that from the user; press, with ref, for one control that only the user's own press works on; question for anything else." },
          question: { type: "string", description: "ask_user: what you need from the user, in one or two plain sentences." },
          success: { type: "boolean", description: "done: true only if every part of the request was carried out or answered." },
          answer: { type: "string", description: "done: the full reply to the user, in Markdown. When success is false, what you did, what is missing and why." },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "done: for each fact in the answer that came from a page, a short quote copied exactly from the page text you were shown.",
          },
          ...(opts.finalStep || opts.maxActions < 2 ? {} : {
            then: {
              type: "array",
              maxItems: Math.max(1, opts.maxActions - 1),
              description: `Up to ${Math.max(1, opts.maxActions - 1)} more actions to run straight after this one, in order, when they do not depend on seeing its result: the other fields of a form, several boxes to tick, or Enter after typing a search. Leave it out otherwise. Example: [{"do":"press","key":"Enter","ref":4}]`,
              items: { type: "object", properties: { ...strip(action, ["to_ref", "distance", "x", "y"]), do: { type: "string", enum: names.filter((n) => ["click", "fill", "press", "scroll"].includes(n)), description: "click, fill or press, as above." } }, required: ["do"] },
            },
          }),
        },
        required: ["note", "goal", "do"],
      },
    };
  }

  /** The object without the named fields. */
  function strip(obj, names) {
    const out = { ...obj };
    for (const n of names) delete out[n];
    return out;
  }

  // Names other schemas and older prompts use for the same things. A reply
  // that is clear in what it means is used, not sent back.
  const ALIASES = Object.freeze({
    mouseover: "hover", hover_over: "hover",
    type: "fill", input: "fill", select: "fill", select_option: "fill", set: "fill", check: "fill", checkbox_toggle: "fill",
    keypress: "press", key: "press", goto: "navigate", go_to: "navigate", open: "navigate", go_back: "back",
    finish: "done", answer: "done", complete: "done", ask: "ask_user", search_page: "find", search: "find", scroll_to: "scroll",
    drag_and_drop: "drag", drag_to: "drag", click_point: "click_at", click_xy: "click_at",
  });

  // The one piece of text each action takes, and the fields text can turn up in.
  const TEXT_OF = Object.freeze({ fill: "value", remember: "value", press: "key", find: "query", ask_user: "question", done: "answer" });
  const TEXT_FIELDS = Object.freeze(["value", "text", "answer", "question", "query", "key"]);

  const asInt = (v) => {
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^\s*\[?\d+\]?\s*$/.test(v)) return parseInt(v.replace(/[^\d]/g, ""), 10);
    return null;
  };

  function normaliseUrl(url) {
    const t = String(url || "").trim();
    if (!t) return { error: "navigate needs a url." };
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
    let parsed;
    try { parsed = new URL(withScheme); } catch (_e) { return { error: `"${clip(t, 80)}" is not a web address. Give a full https address.` }; }
    if (!["http:", "https:"].includes(parsed.protocol)) return { error: `Only http and https addresses can be opened, not ${parsed.protocol}` };
    return { url: parsed.href };
  }

  // Every field the step tool has, at the top level or in an action.
  const FIELDS = Object.freeze(["note", "rewrite_notes", "memory", "goal", "do", "ref", "to_ref", "distance", "x", "y", "value", "from", "key", "times", "url", "direction", "query", "part", "op", "tab", "seconds", "scope", "kind", "question", "success", "answer", "evidence", "tasks", "then"]);
  const PARAM_TAG = /<parameter=\s*["']?([A-Za-z_]+)["']?\s*>/g;

  /**
   * Fields a model wrote in its own tool syntax inside another field:
   * do = "navigate\n<parameter=url>\nhttps://example.org/". Each
   * <parameter=NAME> segment is the field it names, and what comes before
   * the first is the field's own value. Only when every name is a field of
   * the tool; a field already given keeps its value.
   */
  function unfoldParameters(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    let out = obj;
    for (const field of Object.keys(obj)) {
      const v = obj[field];
      if (typeof v !== "string" || !v.includes("<parameter=")) continue;
      const names = [...v.matchAll(PARAM_TAG)].map((m) => m[1].toLowerCase());
      if (!names.length || !names.every((n) => FIELDS.includes(n))) continue;
      const pieces = v.split(PARAM_TAG);
      const clean = (t) => String(t).replace(/<\/parameter\s*>/g, "").trim();
      if (out === obj) out = { ...obj };
      const head = clean(pieces[0]);
      if (head) out[field] = head; else delete out[field];
      for (let i = 1; i + 1 < pieces.length; i += 2) {
        const name = pieces[i].toLowerCase();
        const blank = out[name] === undefined || out[name] === null || String(out[name]).trim() === "";
        if (blank && name !== field) out[name] = clean(pieces[i + 1]);
      }
    }
    return out;
  }

  /** One action, checked. Returns {action} or {error}. */
  function checkAction(raw0, ctx) {
    const raw = unfoldParameters(raw0);
    if (!raw || typeof raw !== "object") return { error: "Each action is an object with a \"do\" field." };
    const a = { ...raw };
    let name = String(a.do || a.action || a.name || "").trim().toLowerCase();
    name = ALIASES[name] || name;
    if (!ACTIONS[name]) return { error: `"${clip(a.do || a.action, 30)}" is not an action. Use one of: ${(ctx.finalStep ? ENDING_ACTIONS : ACTION_NAMES).join(", ")}.` };
    if (ctx.finalStep && !ENDING_ACTIONS.includes(name)) return { error: "This step can only end the run: only done or ask_user can be used." };
    if (name === "delegate" && ctx.canDelegate === false) return { error: "delegate is not available here: a sub-task does its own part, in its own tab, without handing out more." };
    // Other spellings of the same fields.
    if (a.ref === undefined && a.id !== undefined) a.ref = a.id;
    if (a.value === undefined && a.optionText !== undefined) a.value = a.optionText;
    // The tool is one flat form, and each action takes one piece of text.
    // When that field is empty and the text sits in exactly one other of
    // the form's text fields, there is no doubt what was meant.
    const main = TEXT_OF[name];
    const blank = (v) => v === undefined || v === null || String(v).trim() === "";
    if (main && blank(a[main]) && !(name === "fill" && !blank(a.from))) {
      const elsewhere = TEXT_FIELDS.filter((f) => f !== main && typeof a[f] === "string" && a[f].trim());
      if (elsewhere.length === 1) a[main] = a[elsewhere[0]];
    }

    const out = { do: name };
    const els = (ctx.page && ctx.page.elements) || [];
    const needsRef = name === "click" || name === "fill" || name === "hover" || name === "drag";
    if (name === "fill_details" && (a.ref === undefined || a.ref === null || a.ref === "")) delete a.ref;
    // A ref of 0, or one given to an action that takes none, means "no control".
    // Asking the user to press a control names it by its ref; no other ask takes one.
    const asksPress = name === "ask_user" && String(a.kind || "").trim().toLowerCase() === "press";
    if (!needsRef && !asksPress && (asInt(a.ref) === 0 || ["navigate", "back", "wait", "look", "read", "find", "done", "ask_user", "tabs", "remember", "recall", "click_at", "delegate"].includes(name))) delete a.ref;
    if (a.ref !== undefined && a.ref !== null && a.ref !== "") {
      const ref = asInt(a.ref);
      if (ref === null) return { error: `ref must be the number in [brackets] before a control, not "${clip(a.ref, 30)}".` };
      const el = els.find((e) => e.id === ref);
      if (!el && asksPress) return { error: `There is no control [${ref}] on this page for the user to press. Use a number from the current page listing.` };
      if (!el && (needsRef || name === "press" || name === "scroll")) {
        // The same control under a new number, when the page was redrawn.
        const was = ctx.labels && ctx.labels[ref];
        const again = was ? els.filter((e) => ctx.labelOf(e) === was) : [];
        const hint = again.length === 1 ? ` "${was}" is now [${again[0].id}].` : was ? ` "${was}" is not listed any more; use find to look for it.` : " Use a number from the current page listing, or find to look for the control.";
        // The reply is a step like any other: it names an action, on a
        // control that is not there. That is an action that fails, and it
        // is recorded as one.
        return { action: { do: name, ref, gone: `There is no control [${ref}] on this page.${hint}` } };
      }
      out.ref = ref;
    } else if (needsRef) {
      return { error: `${name} needs ref: the number in [brackets] before the control.` };
    }

    if (name === "drag") {
      const to = a.to_ref !== undefined && a.to_ref !== null && a.to_ref !== "" ? asInt(a.to_ref) : null;
      if (to !== null) {
        if (!els.some((e) => e.id === to)) return { action: { do: name, ref: out.ref, to_ref: to, gone: `There is no control [${to}] on this page to drop it on. Use a number from the current page listing.` } };
        if (to === out.ref) return { error: "drag needs to_ref to be a different control from ref." };
        out.to_ref = to;
      } else if (a.to_ref !== undefined && a.to_ref !== null && a.to_ref !== "") {
        return { error: `to_ref must be the number in [brackets] before a control, not "${clip(a.to_ref, 30)}".` };
      } else {
        const way = String(a.direction || "").toLowerCase();
        const distance = Math.round(Number(a.distance));
        if (!["left", "right", "up", "down"].includes(way) || !(distance > 0)) return { error: "drag needs to_ref (the control to drop it on), or direction (left, right, up or down) and distance (page pixels)." };
        out.direction = way;
        out.distance = Math.min(4000, distance);
      }
    }
    if (name === "click_at") {
      const x = Math.round(Number(a.x));
      const y = Math.round(Number(a.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { error: "click_at needs x and y: a point on the page in pixels from its top left corner, as the listing gives them after \"at\"." };
      out.x = x;
      out.y = y;
    }

    const fromKeys = (text) => String(text || "").split(/[,\s]+/).map((k) => k.trim().replace(/^profile\./i, "").toLowerCase()).filter(Boolean);
    if (name === "fill") {
      const keys = fromKeys(a.from);
      if (keys.length && (a.value === undefined || a.value === null || a.value === "")) out.from = keys[0];
      else if (a.value === undefined || a.value === null) return { error: "fill needs value: the text, the option to choose, or \"on\"/\"off\"; or from: a detail on file such as \"profile.email\"." };
      else out.value = typeof a.value === "boolean" ? (a.value ? "on" : "off") : String(a.value);
    }
    if (name === "recall") {
      const q = String(a.query || "").trim();
      const keys = fromKeys(a.from || a.value || q);
      if (!keys.length && !q) return { error: "recall needs from: the details to read, such as \"profile.name, profile.email\"." };
      if (keys.length) out.from = keys.slice(0, 8).join(", ");
      if (q && !a.from) out.query = clip(q, 120);
    }
    if (name === "remember") {
      const text = String(a.value || a.note || "").trim();
      if (!text) return { error: "remember needs value: what to keep, in one short sentence." };
      out.value = clip(text, 240);
      out.scope = a.scope === "this_site" ? "this_site" : "everywhere";
      if (a.kind === "context" || a.kind === "fact") out.kind = "context";
    }
    if (name === "press") {
      const key = String(a.key || "").trim();
      if (!key) return { error: "press needs key, such as Enter or Escape." };
      out.key = key;
      const times = Math.floor(Number(a.times));
      if (times > 1) out.times = Math.min(50, times);
    }
    if (name === "scroll") {
      // A direction with a ref scrolls inside the box that control is in.
      if (out.ref === undefined || a.direction) {
        const way = String(a.direction || a.scrollDirection || "down").toLowerCase();
        out.direction = ["up", "left", "right", "top", "bottom"].includes(way) ? way : "down";
      }
    }
    if (name === "navigate") {
      const u = normaliseUrl(a.url);
      if (u.error) return u;
      out.url = u.url;
    }
    if (name === "tabs") {
      const op = String(a.op || "").toLowerCase();
      if (!["open", "switch", "close"].includes(op)) return { error: "tabs needs op: open, switch or close." };
      out.op = op;
      if (op === "open") {
        const u = normaliseUrl(a.url);
        if (u.error) return u;
        out.url = u.url;
      } else {
        const tab = asInt(a.tab !== undefined ? a.tab : a.tabId);
        if (tab === null) return { error: `tabs ${op} needs tab: a number from the tab list.` };
        out.tab = tab;
      }
    }
    if (name === "wait") out.seconds = Math.min(10, Math.max(0.5, Number(a.seconds) || 2));
    // Looking for words is find, whichever of the two it was asked of.
    if (name === "read" && a.query !== undefined && String(a.query).trim()) { name = "find"; out.do = "find"; }
    if (name === "read" && asInt(a.part) !== null) out.part = Math.max(1, asInt(a.part));
    if (name === "find") {
      const q = String(a.query || "").trim();
      if (!q) return { error: "find needs query: words from the control's label." };
      out.query = clip(q, 120);
    }
    if (name === "delegate") {
      const raw = Array.isArray(a.tasks) ? a.tasks : [];
      if (!raw.length) return { error: "delegate needs tasks: a list of sub-tasks, each with task (what to do) and, when known, url (where to start)." };
      if (raw.length > DELEGATE_MAX) return { error: `delegate takes at most ${DELEGATE_MAX} sub-tasks at a time; it was given ${raw.length}. Hand out ${DELEGATE_MAX} now and the rest once their answers are in.` };
      const tasks = [];
      for (const t of raw) {
        const task = String(typeof t === "string" ? t : (t && (t.task || t.instruction || t.goal)) || "").trim();
        if (!task) return { error: "Each sub-task in delegate needs task: what it is to do." };
        const item = { task: clip(task, 600) };
        const where = t && typeof t === "object" ? String(t.url || t.start || "").trim() : "";
        if (where) {
          const u = normaliseUrl(where);
          if (u.error) return { error: `Sub-task "${clip(task, 60)}": ${u.error}` };
          item.url = u.url;
        }
        if (!tasks.some((x) => x.task === item.task && x.url === item.url)) tasks.push(item);
      }
      out.tasks = tasks;
    }
    if (name === "ask_user") {
      const q = String(a.question || "").trim();
      if (!q) return { error: "ask_user needs question: what you need from the user." };
      out.question = q.slice(0, 600);
      const kind = String(a.kind || "").trim().toLowerCase();
      out.kind = ASK_KINDS.includes(kind) ? kind : "question";
      if (out.kind === "press" && out.ref === undefined) return { error: "ask_user with kind \"press\" needs ref: the number of the control the user is to press." };
    }
    if (name === "done") {
      // Finishing without success, with the account of what happened written
      // in the notes and no answer given: the notes are that account, the
      // run's own when the reply wrote none.
      const answer = String(a.answer || "").trim() || (a.success === false || a.success === "false" ? String(a.rewrite_notes || a.note || a.memory || a.notes || ctx.notes || "").trim() : "");
      if (!answer) return { error: "done needs answer: the full reply to the user." };
      out.answer = answer;
      // Left out is not the same as false: an answer given is a claim of success.
      out.success = a.success === undefined ? true : a.success === true || a.success === "true";
      const ev = Array.isArray(a.evidence) ? a.evidence : typeof a.evidence === "string" && a.evidence.trim() ? [a.evidence] : [];
      out.evidence = ev.map((q) => String(q || "").trim()).filter((q) => q.length >= 3).slice(0, 12);
    }
    return { action: out };
  }

  /**
   * A model reply, checked against the page it was written for.
   *
   * @param reply  the tool call's arguments (or the JSON a model wrote instead)
   * @param ctx    {page, labels, labelOf, maxActions, finalStep, notes}
   * @returns {ok: true, step: {note, rewrite, goal, actions}} or {ok: false, error}
   */
  function checkStep(reply0, ctx) {
    const c = { maxActions: 3, labelOf: (e) => e.accName || e.label || e.text || "", ...ctx };
    const reply = unfoldParameters(reply0);
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) return { ok: false, error: "The reply was not a step. Call the step tool with memory, goal and actions." };
    // The action is the reply's own fields, with more in `then`. A list of
    // actions, or one under another name, is read the same way.
    let list = null;
    if (reply.do || typeof reply.action === "string") list = [reply, ...(Array.isArray(reply.then) ? reply.then : [])];
    else if (Array.isArray(reply.actions) && reply.actions.length) list = reply.actions;
    else if (reply.action && typeof reply.action === "object") list = [reply.action];
    // The action's name used as a field, with what it takes as the value: {"find": "Closed"}.
    else if (namedByKey(reply)) list = [namedByKey(reply)];
    // An answer given with no action named is the answer: the step is done.
    else if (typeof reply.answer === "string" && reply.answer.trim()) list = [{ do: "done", success: reply.success, answer: reply.answer, evidence: reply.evidence }];
    if (!list || !list.length) return { ok: false, error: "The step names no action. Set do to what you want done next; if you can answer the request now, set do to \"done\" and put the answer in answer." };
    const actions = [];
    for (let i = 0; i < list.length && actions.length < c.maxActions; i++) {
      const checked = checkAction(list[i], c);
      // A drag or a press at a point comes first, or not at all: what it
      // changed is seen before anything else is done.
      if (!checked.error && i > 0 && ACTIONS[checked.action.do].alone) {
        return { ok: true, step: stepOf(reply, actions), dropped: `Action ${i + 1} was not run: ${checked.action.do} cannot follow other actions in a step. Its result has to be seen first, so it goes in a step of its own.` };
      }
      if (checked.error) {
        // Earlier actions in the step are still good; the model is told
        // which one was dropped and why.
        if (actions.length) return { ok: true, step: stepOf(reply, actions), dropped: `Action ${i + 1} was not run: ${checked.error}` };
        return { ok: false, error: checked.error };
      }
      actions.push(checked.action);
      // Nothing runs after the run pauses or ends.
      if (ACTIONS[checked.action.do].ends) break;
      if (ACTIONS[checked.action.do].alone && i + 1 < list.length) {
        return { ok: true, step: stepOf(reply, actions), dropped: `The actions after ${checked.action.do} were not run: its result has to be seen first.` };
      }
    }
    return { ok: true, step: stepOf(reply, actions) };
  }

  /**
   * A reply with no `do` whose one unknown field is the name of an action:
   * {"find": "Closed"}, {"click": 12}, {"navigate": "https://..."}. The
   * value is what that action takes. Null when it is not that plain.
   */
  function namedByKey(reply) {
    const keys = Object.keys(reply).filter((k) => ACTIONS[ALIASES[k.toLowerCase()] || k.toLowerCase()] && !["key", "answer"].includes(k.toLowerCase()));
    if (keys.length !== 1) return null;
    const name = ALIASES[keys[0].toLowerCase()] || keys[0].toLowerCase();
    const v = reply[keys[0]];
    const rest = { ...reply };
    delete rest[keys[0]];
    if (v && typeof v === "object" && !Array.isArray(v)) return { ...rest, ...v, do: name };
    if (v === true || v === null || v === "") return { ...rest, do: name };
    if (name === "click" || name === "hover" || name === "scroll" || name === "drag") return asInt(v) !== null ? { ...rest, do: name, ref: v } : name === "scroll" ? { ...rest, do: name, direction: v } : null;
    const field = name === "navigate" ? "url" : TEXT_OF[name];
    return field && (typeof v === "string" || typeof v === "number") ? { ...rest, do: name, [field]: String(v) } : null;
  }

  function stepOf(reply, actions) {
    return {
      ...notesOf(reply),
      goal: clip(reply.goal || reply.next_goal || reply.thought || "", 200),
      actions,
    };
  }

  /**
   * What a reply says about the notes: a note to add, and a rewrite to put
   * in their place. A field under an older name (memory, notes, progress)
   * is a note; mergeNotes tells when it is the notes written out again.
   */
  function notesOf(reply) {
    const text = (v) => (typeof v === "string" ? v.trim() : "");
    const r = reply && typeof reply === "object" ? reply : {};
    return { note: text(r.note) || text(r.memory) || text(r.notes) || text(r.progress), rewrite: text(r.rewrite_notes) };
  }

  const squeeze = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  // Each step's note starts a line of its own: "Step 3: ...".
  const ENTRY = /^Step \d+: /;
  const entriesOf = (notes) => String(notes || "").split(/\n(?=Step \d+: )/).map((e) => squeeze(e.replace(ENTRY, ""))).filter(Boolean);

  /**
   * The notes after a step: its note added, with the step number, or its
   * rewrite in their place. A note that holds the notes already kept
   * (a model writing all its notes again, as the tool once asked) is taken
   * as a rewrite, and a note already kept word for word is not added again.
   *
   * @returns {notes, cut, refused, rewrote}: cut is how much of a rewrite
   *          past the room was cut off; refused is the length of a note not
   *          added because the notes are at their limit.
   */
  function mergeNotes(notes0, got, step) {
    const notes = String(notes0 || "");
    const rewrite = String((got && got.rewrite) || "").trim();
    const note = String((got && got.note) || "").trim();
    const asRewrite = (text) => ({ notes: text.slice(0, NOTES_ROOM), cut: Math.max(0, text.length - NOTES_ROOM), refused: 0, rewrote: true });
    if (rewrite) return asRewrite(rewrite);
    if (!note) return { notes, cut: 0, refused: 0, rewrote: false };
    const was = entriesOf(notes);
    const said = squeeze(note.replace(ENTRY, ""));
    if (was.includes(said)) return { notes, cut: 0, refused: 0, rewrote: false };
    if (was.length && (said.includes(squeeze(notes)) || was.every((e) => said.includes(e)))) return asRewrite(note);
    const added = `${notes ? `${notes}\n` : ""}Step ${step}: ${note}`;
    if (added.length > NOTES_LIMIT) return { notes, cut: 0, refused: note.length, rewrote: false };
    return { notes: added, cut: 0, refused: 0, rewrote: false };
  }

  /** A short readable form of an action: `fill [4] "blue widget"`. */
  function describe(a, label) {
    if (!a || !a.do) return "?";
    let s = a.do;
    if (a.op) s += ` ${a.op}`;
    if (a.ref !== undefined) s += ` [${a.ref}]`;
    if (a.do === "click_at") s += ` ${a.x},${a.y}`;
    // The control's own words, when known: `fill [4] "Search": "blue widget"`.
    if (label) s += ` "${clip(label, 60)}"${a.value !== undefined || a.from !== undefined ? ":" : ""}`;
    if (a.tab !== undefined) s += ` tab ${a.tab}`;
    if (a.from !== undefined && a.do !== "fill_details") s += ` from ${String(a.from).split(", ").map((k) => `profile.${k}`).join(", ")}`;
    if (a.value !== undefined) s += ` "${clip(a.value, 40)}"`;
    if (a.key) s += ` ${a.key}${a.times ? ` x${a.times}` : ""}`;
    if (a.url) s += ` ${clip(a.url, 70)}`;
    if (a.to_ref !== undefined) s += ` onto [${a.to_ref}]`;
    if (a.direction) s += ` ${a.direction}${a.distance ? ` ${a.distance}px` : ""}`;
    if (a.query) s += ` "${clip(a.query, 40)}"`;
    if (a.part) s += ` part ${a.part}`;
    if (a.do === "ask_user") s += ` (${a.kind})`;
    if (a.do === "delegate") s += ` ${(a.tasks || []).length} sub-task${(a.tasks || []).length === 1 ? "" : "s"}`;
    return s;
  }

  /** What makes two actions the same action: everything but the wording around it. */
  const signature = (a) => JSON.stringify([a.do, a.op, a.ref, a.tab, a.value, a.from, a.key, a.url, a.direction, a.query, a.part, a.to_ref, a.distance, a.x, a.y, a.tasks]);

  const api = Object.freeze({ ACTIONS, ACTION_NAMES, ENDING_ACTIONS, ASK_KINDS, DELEGATE_MAX, NOTES_ROOM, NOTES_LIMIT, stepTool, notesOf, mergeNotes, checkStep, checkAction, unfoldParameters, describe, signature, normaliseUrl });
  root.SELECT_TO_AI_STEP = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
