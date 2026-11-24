/**
 * The real-task trial: what run.js needs beyond a benchmark run, and the
 * report over what it wrote. No browser and no network here.
 *
 *   node tests/bench/trial.js validate tests/bench/everyday-tasks.json
 *   node tests/bench/trial.js summary <out dir> --tasks <task file> [--sample N] [--check-dry]
 *
 * A trial task file is run.js's own format with a few more fields:
 *   level    the task's family (one of FAMILIES), so BENCH_SAMPLE spreads a
 *            smaller run evenly over the families
 *   expect   what a right result holds, in words, given to the judge
 *   pattern  a regular expression (case-insensitive) the final answer
 *            should match: a second, mechanical signal beside the judge, and
 *            the only verdict in dry mode, which has no judge
 *   sites    the other sites a task names, when it names more than one
 *   lang     the language of the site, when it is not English
 *   difficulty  easy, medium or hard: how hard the task is for a person
 *            using the page, so a holdout run can be counted by it too
 *   then     (learn tasks) the id of the task to run next in the same
 *            browser profile, on the same site: a pair. A task no "then"
 *            points to, and with none of its own, runs twice
 *   scenario (fixture tasks) the scripted model's scenario in tests/e2e/server.js
 *   dry      (fixture tasks) how the run must end for the plumbing to be right
 *   dryHeld, dryScripted, dryTyped  (fixture tasks) the fewest held actions,
 *            scripted presses and typing steps the run must record
 *   dryForm  (fixture tasks) a value one form control of the final page must hold
 *
 * `summary` reads every run.json under the folder (one per task run, written
 * by run.js), prints a table by family in Markdown, and writes
 * trial-summary.json beside them. With --sealed (the holdout suite) it prints
 * and writes numbers only: no task id, answer, verdict or reason.
 *
 *   node tests/bench/trial.js holdout-check [--detail]
 *   node tests/bench/trial.js suite-check widgets
 *   node tests/bench/trial.js leaks <log file> --tasks <task file>
 *
 * `holdout-check` fails when a holdout task is on a site any other suite
 * uses or the file's shape is off, and prints counts only (--detail, for
 * whoever edits the file on their own machine, names the problems).
 * `suite-check widgets` fails when the open widgets practice file is off its
 * shape or a task of it is on a site any other suite uses, the holdout's
 * included when the plain holdout file is here. It names the practice task
 * and its site, never a holdout task.
 * `leaks` fails when a log names any task of the file.
 *
 * The holdout file is committed encrypted (tests/bench/holdout-tasks.json.enc).
 * The workflow decrypts it to tests/bench/holdout-tasks.json, which git
 * ignores; HOLDOUT_TASKS points at a plain copy kept anywhere else.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isInfra, normaliseTasks, sampleTasks, taskList } = require("./judge.js");
const { siteOf } = require("../../extension/agentTools.js");

const FAMILIES = Object.freeze({
  "fact-lookup": "Look up a fact on a page",
  "cross-site": "Search and compare across two sites",
  "form-fill": "Fill a form, stop before submit",
  "tables-lists": "Tables and lists",
  "navigation": "Multi-step navigation",
  "long-docs": "Long documents and PDFs",
  "non-english": "Non-English sites",
  "developer": "Developer tasks",
  "shopping": "Shopping research, no checkout",
  "maps-transit": "Maps and transit",
  "news-sports": "News and sports",
  "widgets": "Page widgets: hover, drag, sliders, keys, pickers, frames, dialogs",
  "om2w": "Online-Mind2Web (fetched at run time, never committed)",
  "fixture": "Fixture pages (dry mode)",
});

const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);

// The task file of each suite the workflow runs. The holdout file is
// sealed (tests/bench/README.md): only its encrypted copy is in the
// repository, and the plain path is where the workflow decrypts it.
const SUITES = Object.freeze({
  everyday: "tests/bench/everyday-tasks.json",
  dev: "tests/bench/smoke-tasks.json",
  learn: "tests/bench/learn-tasks.json",
  widgets: "tests/bench/widgets-tasks.json",
  holdout: "tests/bench/holdout-tasks.json",
});
const SEALED_SUITES = Object.freeze(["holdout"]);

// The widgets suite is an open practice set for the interactions the holdout
// suite's widgets family measures: anyone may read its runs and tune on them.
// Each task names the kind of interaction it practises, and the set covers
// every kind below. It shares no site with any other suite, the holdout
// included, so tuning on it is never tuning on a held-out site.
const WIDGET_KINDS = Object.freeze({
  hover: "Hover menus and tooltips",
  drag: "Dragging within a list or a board",
  "drag-kanban": "Dragging a card between kanban columns",
  dropzone: "Dropping an element on a drop zone (no file)",
  slider: "Sliders and range inputs, native and custom",
  "date-time": "Date and time pickers",
  keyboard: "Keyboard-driven widgets: arrow keys, Escape, Tab, type-ahead",
  autocomplete: "Autocomplete suggestions",
  disclosure: "Accordions and tabs",
  modal: "Modal dialogs",
  iframe: "Frames and nested frames",
  "shadow-dom": "Shadow DOM components",
  "canvas-svg": "Canvas or SVG click targets",
  "context-menu": "Context menus",
  "double-click": "Double click",
  "long-press": "Long press",
  "infinite-scroll": "Infinite scroll",
  "sortable-table": "Sortable tables",
  "rich-text": "Rich text editors",
  "multi-select": "Multi-select and tag inputs",
  "toggle-rating": "Toggles and star ratings",
});
const WIDGET_SOURCES = Object.freeze(["library-demo", "real-site"]);
const PRACTICE_SUITE = "widgets";
// The generality checks of the page reader and the PDF reader run on real
// sites too. A holdout task may not share a site with them either: work on
// those checks would then be work on a holdout task's site.
const READING_CHECKS = Object.freeze({
  "reading-wild": "tests/reading/wild-sites.js",
  "reading-pdf": "tests/reading/pdf-real-files.js",
});
const HOLDOUT_ENCRYPTED = "tests/bench/holdout-tasks.json.enc";

/** Where the plain holdout file is: HOLDOUT_TASKS, else the decrypted path. Null when it is not there. */
function holdoutFile(root = path.join(__dirname, "../..")) {
  const file = process.env.HOLDOUT_TASKS || path.join(root, SUITES.holdout);
  return fs.existsSync(file) ? file : null;
}

// The scripted model's server in dry mode. The fixture task file names this port in its addresses.
const DRY_PORT = 8931;

// Words for an action no trial task may ask for. A task may say "do not submit".
const FORBIDDEN = /\b(sign up|sign me up|register an account|create an account|log ?in|buy it|place the order|check ?out and pay|pay for|post a|send the|send a|delete|unsubscribe)\b/i;
// Words for handing something in. Refused everywhere but in a form task on a
// practice site, where the form goes nowhere. "book", "apply", "comment" and
// "reply" are matched as requests ("book a table", "reply to"), not as the
// nouns a read-only task is full of ("open that book", "comments and docstrings").
const FORBIDDEN_HAND_IN = /\b(submit|subscribe|upload|book (a|an|me|us|it|one|two|three|the|my|this)\b|apply (for|to|now)\b|(comment|reply) (on|to)\b|(leave|post|write|add) (a |an |the |my |this )?(comment|reply|review))\b/i;
// Sites built for practising on forms: nothing typed there reaches a person or an account.
const PRACTICE_SITES = Object.freeze(["httpbin.org", "selenium.dev", "demoqa.com", "the-internet.herokuapp.com", "formy-project.herokuapp.com", "jqueryui.com", "testpages.eviltester.com",
  // Practice sites of the holdout suite.
  "automationtesting.in", "testautomationpractice.blogspot.com", "expandtesting.com"]);
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_e) { return ""; } };
const onPracticeSite = (url) => PRACTICE_SITES.some((s) => hostOf(url) === s || hostOf(url).endsWith(`.${s}`));

/** Problems with a trial task file, as sentences. Empty when it is sound. */
function validateTasks(list) {
  const problems = [];
  const ids = new Set();
  for (const [i, t] of (list || []).entries()) {
    const name = t && t.id ? t.id : `task ${i + 1}`;
    if (!t || !t.id || !t.task || !t.url) { problems.push(`${name}: needs id, task and url`); continue; }
    if (ids.has(t.id)) problems.push(`${name}: id used twice`);
    ids.add(t.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) problems.push(`${name}: id must be lower-case letters, digits and hyphens (it names a folder)`);
    if (!FAMILIES[t.level]) problems.push(`${name}: level "${t.level}" is not a family`);
    if (t.difficulty !== undefined && !DIFFICULTIES.includes(t.difficulty)) problems.push(`${name}: difficulty "${t.difficulty}" is not one of ${DIFFICULTIES.join(", ")}`);
    if (t.level === "fixture" ? !/^http:\/\/127\.0\.0\.1:\d+\//.test(t.url) : !/^https:\/\//.test(t.url)) problems.push(`${name}: url ${t.url}`);
    if (!t.expect && !t.pattern) problems.push(`${name}: needs expect or pattern`);
    if (t.pattern) { try { new RegExp(t.pattern, "i"); } catch (e) { problems.push(`${name}: pattern does not compile (${e.message})`); } }
    const negated = String(t.task).replace(/\b(do not|don't|without|never|not)\b[^.;]*/gi, "");
    if (t.level !== "fixture" && FORBIDDEN.test(negated)) problems.push(`${name}: asks for something a trial task may not do ("${negated.match(FORBIDDEN)[0]}")`);
    const practiceForm = t.level === "form-fill" && onPracticeSite(t.url);
    if (t.level === "form-fill" && !practiceForm) problems.push(`${name}: a form task runs only on a practice site (${PRACTICE_SITES.join(", ")})`);
    if (t.level !== "fixture" && !practiceForm && FORBIDDEN_HAND_IN.test(negated)) problems.push(`${name}: asks to hand something in ("${negated.match(FORBIDDEN_HAND_IN)[0]}"), which only a form task on a practice site may`);
    if (t.then !== undefined) {
      const next = (list || []).find((x) => x && x.id === t.then);
      if (!next) problems.push(`${name}: "then" names ${t.then}, which is not in the file`);
      else if (hostOf(next.url) !== hostOf(t.url)) problems.push(`${name}: "then" must name a task on the same site (${hostOf(t.url)}, not ${hostOf(next.url)})`);
      else if (next.then !== undefined) problems.push(`${name}: "then" names ${t.then}, which starts a pair of its own`);
    }
    if (/\u2014/.test(JSON.stringify(t))) problems.push(`${name}: has an em dash`);
  }
  return problems;
}

/** Whether the answer matches the task's pattern: true, false, or null when the task has none. */
function patternMatch(task, answer) {
  if (!task || !task.pattern) return null;
  return new RegExp(task.pattern, "i").test(String(answer || ""));
}

/**
 * The verdict in dry mode, where no judge is called: the pattern decides,
 * and a run left waiting at a human check counts as blocked, as the judge
 * would mark it.
 */
function patternVerdict(task, run) {
  const blocked = run.waitKind === "human_check";
  const hit = patternMatch(task, run.answer);
  const success = hit === true && !blocked && /^(finished|answered without acting)$/.test(String(run.ending || ""));
  const reason = blocked ? "the run stopped at a human check and waited for the user"
    : success ? "the answer matches the task's pattern (dry mode: the judge stub answers with this)"
      : hit === null ? "the task has no pattern, and dry mode has only a stub for the judge"
        : hit ? `the answer matches the pattern, but the run ended as: ${run.ending}` : "the answer does not match the task's pattern";
  return { success, blocked, reason, keyPoints: [], met: [] };
}

/**
 * The pairs of a learn run, from a task file: a task with "then" is followed
 * by the task it names; a task that is nobody's "then" and has none runs
 * twice. Tasks that are only somebody's "then" start no pair.
 */
function learnPlan(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const second = new Set(tasks.filter((t) => t.then).map((t) => t.then));
  return tasks.filter((t) => !second.has(t.id)).map((a) => ({ a, b: a.then ? byId.get(a.then) : a })).filter((p) => p.b);
}

// A model whose list price rises with the length of the prompt, which the
// extension's own count (one rate per model) does not follow:
// Claude Haiku 5.5 costs five times as much for a prompt over 100,000 tokens
// (platform.claude.com pricing, read 17 Nov 2026).
const LONG_PROMPT_PRICES = Object.freeze([{ model: /claude-haiku-5-5/i, over: 100000, times: 5 }]);

/** What a run's long prompts cost above the extension's own count, from its model calls. */
function longPromptSurchargeUSD(modelCalls, ratesFor) {
  let extra = 0;
  for (const c of modelCalls || []) {
    const tier = LONG_PROMPT_PRICES.find((t) => t.model.test(String(c.model || "")) && (c.prompt || 0) > t.over);
    if (!tier || !ratesFor) continue;
    const [input, output] = ratesFor(c.model) || [0, 0];
    extra += (((c.prompt || 0) * input + (c.completion || 0) * output) / 1000) * (tier.times - 1);
  }
  return extra;
}

/** Everything a row cost: the agent, the approver, its long prompts, attempts that were lost, the allowance for learning calls, the judge, and a recipe replay. */
function spendOf(row) {
  return (row.costUSD || 0) + (row.approverUSD || 0) + (row.longPromptUSD || 0) + (row.lostAttemptsUSD || 0) + (row.learnAllowanceUSD || 0) + (row.judgeCostUSD || 0) + ((row.recipe && row.recipe.replay && row.recipe.replay.usd) || 0);
}

/** A digit of any script as 0 to 9: Unicode's decimal digits come in runs of ten. */
function asciiDigits(text) {
  return String(text || "").normalize("NFKC").replace(/\p{Nd}/gu, (d) => {
    if (d >= "0" && d <= "9") return d;
    let n = 0;
    for (let cp = d.codePointAt(0) - 1; n < 9 && /\p{Nd}/u.test(String.fromCodePoint(cp)); cp--) n++;
    return String(n);
  });
}

/**
 * Whether the numbers in the answer are anywhere in the text the harness
 * captured (pages, final page, form controls): a mechanical second signal
 * for tasks about a live value, where no pattern can be written. A number is
 * compared without its thousands separators. Not proof either way: only the
 * last few pages are kept, and an answer may state a sum or a difference.
 */
const numbersIn = (text) => [...asciiDigits(text).matchAll(/\d+(?:[.,:]\d+)*/g)].map((m) => m[0]);
const flatNumber = (n) => n.replace(/[,.](?=\d{3}(\D|$))/g, "");

function answerGrounding(run) {
  const numbersOf = numbersIn;
  const flat = flatNumber;
  const said = [...new Set(numbersOf(run.answer).map(flat))].filter((n) => n.length > 1);
  const forms = ((run.formState && run.formState.controls) || []).map((c) => `${c.value || ""} ${(c.selected || []).join(" ")}`).join(" ");
  // The engine's own reading of each page counts as much as the harness's capture: it holds what innerText lacks.
  const read = (run.readings || run.engineReadings || []).map((p) => p.text);
  const seen = new Set(numbersOf([run.finalText, ...(run.pages || []).map((p) => p.text), ...read, forms].join("\n")).map(flat));
  const missing = said.filter((n) => !seen.has(n));
  return { numbers: said.length, found: said.length - missing.length, missing: missing.slice(0, 12) };
}

/**
 * Runs in the extension's service worker (handed over whole, so it uses
 * nothing from this file): the text the engine kept of each page the run
 * read (core/run.js, run.seen), its sub-tasks' too. Page text only: never
 * the model's notes, goals or answer. `known` maps an address to the length
 * of the text the harness already holds for it, and an unchanged page comes
 * back without its text, so a long run is not sent again at every step.
 */
function engineReadingsInWorker(runId, known) {
  const E = self.SELECT_TO_AI_ENGINE;
  if (!E || !E.sessions || !runId) return null;
  const out = [];
  const visit = (run) => {
    if (!run) return;
    for (const p of run.seen || []) {
      const text = String(p.text || "");
      if (!p.url || !text) continue;
      out.push(known && known[p.url] === text.length ? { url: p.url, title: String(p.title || ""), same: true } : { url: p.url, title: String(p.title || ""), text });
    }
    for (const c of run.children || []) visit(c.run);
  };
  for (const s of E.sessions.values()) {
    if (!s.run || s.run.id !== runId) continue;
    visit(s.run);
    for (const r of (s.runners && s.runners.values()) || []) visit(r.run);
  }
  return out;
}

/** Adds what engineReadingsInWorker sent to the harness's readings (a Map by address, newest last). */
function mergeReadings(map, got) {
  for (const p of got || []) {
    if (!p || !p.url) continue;
    if (p.same) continue;
    map.delete(p.url);
    map.set(p.url, { url: p.url, title: p.title || "", text: String(p.text || "") });
  }
  return map;
}

// The bounds on the page states the harness keeps for the judge: at most this
// many, and this many characters of their text in all. The oldest go first.
const PAGE_STATES = Object.freeze({ most: 30, chars: 400000 });

const foldState = (p) => `${p.url}\n${p.title || ""}\n${String(p.text || "").replace(/\s+/g, " ").trim()}`;

/**
 * Adds one capture of the page ({url, title, text}) to the states a run
 * saw, oldest first. A page that changed while its address stayed the same
 * (a next page of results drawn in place, a filter, a tab inside the page)
 * is a state of its own, so the judge sees each one and not only the last.
 * A capture the same as one already kept (same address, title and text) is
 * not kept twice: the earlier copy moves to the end, as the newest. Past
 * the bounds the oldest states go. Returns the list.
 */
function keepPageState(states, seen, bounds = PAGE_STATES) {
  if (!seen || !seen.url) return states;
  const state = { url: seen.url, title: seen.title || "", text: String(seen.text || "") };
  const key = foldState(state);
  const at = states.findIndex((p) => foldState(p) === key);
  if (at >= 0) states.splice(at, 1);
  states.push(state);
  while (states.length > bounds.most) states.shift();
  let chars = states.reduce((n, p) => n + p.text.length, 0);
  while (states.length > 1 && chars > bounds.chars) chars -= states.shift().text.length;
  return states;
}

// The bounds on the engine's readings shown to the judge.
const READING = Object.freeze({ head: 1200, around: 300, perPage: 6000, total: 24000, pages: 8, hits: 3 });

/**
 * What the answer states that can be looked for on a page: its numbers (two
 * digits or more) and its bold or quoted names. Used only to choose which
 * parts of a page to show: the text shown is always the page's own.
 */
function answerValues(answer) {
  const a = String(answer || "");
  const nums = [...new Set(numbersIn(a))].filter((n) => n.replace(/\D/g, "").length > 1);
  const names = [...a.matchAll(/\*\*([^*\n]{3,80})\*\*|"([^"\n]{3,80})"|“([^”\n]{3,80})”/g)].map((m) => (m[1] || m[2] || m[3]).trim().replace(/[:.,]$/, ""));
  return [...new Set([...nums, ...nums.map(flatNumber), ...names])].filter((v) => v.length > 1).slice(0, 24);
}

/**
 * The engine's readings, cut for the judge: each page's opening and the text
 * around every value the answer states, pages with the most of those values
 * first, within READING's bounds.
 */
function engineExcerpts(readings, answer, bounds = READING) {
  const values = answerValues(answer).map((v) => asciiDigits(v).toLowerCase());
  const pages = (readings || []).filter((p) => p && p.url && p.text).map((p, order) => {
    const text = String(p.text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
    const lower = asciiDigits(text).toLowerCase();
    const spans = [];
    let hits = 0;
    for (const v of values) {
      let from = 0;
      for (let n = 0; n < bounds.hits; n++) {
        const at = lower.indexOf(v, from);
        if (at < 0) break;
        if (n === 0) hits++;
        spans.push([Math.max(0, at - bounds.around), Math.min(text.length, at + v.length + bounds.around)]);
        from = at + v.length;
      }
    }
    return { url: p.url, title: p.title || "", text, spans, hits, order };
  });
  pages.sort((a, b) => b.hits - a.hits || b.order - a.order);
  const out = [];
  let used = 0;
  for (const p of pages.slice(0, bounds.pages)) {
    const room = Math.min(bounds.perPage, bounds.total - used);
    if (room < 200) break;
    const head = Math.min(bounds.head, p.text.length);
    const merged = [];
    for (const s of p.spans.filter((x) => x[1] > head).map((x) => [Math.max(x[0], head), x[1]]).sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push(s);
    }
    let text = p.text.slice(0, head);
    for (const [a, b] of merged) {
      const piece = `\n[...]\n${p.text.slice(a, b)}`;
      if (text.length + piece.length > room) break;
      text += piece;
    }
    text = text.slice(0, room);
    used += text.length;
    out.push({ url: p.url, title: p.title, chars: p.text.length, text });
  }
  return out;
}

/**
 * Runs inside a page (it is handed to the browser whole, so it uses nothing
 * from this file): the state of every form control in the document, with
 * the label a person would know it by. This is what the fields hold after
 * the run, whatever the agent's own actions reported.
 */
function readFormControls() {
  const clip = (t, n) => String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, n);
  const roots = [document];
  const open = (root) => { for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { roots.push(el.shadowRoot); open(el.shadowRoot); } };
  try { open(document); } catch (_e) { /* a page that will not be walked */ }
  const labelOf = (el) => {
    const parts = [];
    for (const id of (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) { const n = document.getElementById(id); if (n) parts.push(n.innerText || n.textContent); }
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    if (el.labels) for (const l of el.labels) parts.push(l.innerText || l.textContent);
    if (!parts.length && el.closest) { const w = el.closest("label"); if (w) parts.push(w.innerText || w.textContent); }
    if (!parts.length && el.getAttribute("placeholder")) parts.push(el.getAttribute("placeholder"));
    if (!parts.length && el.getAttribute("title")) parts.push(el.getAttribute("title"));
    return clip(parts.find((x) => clip(x, 5)) || "", 120);
  };
  const seen = new Set();
  const controls = [];
  let total = 0;
  const SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [role=slider], [role=spinbutton], [role=option][aria-selected=true]";
  for (const root of roots) {
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag === "textarea" || tag === "select" ? tag : el.getAttribute("role") || "editable";
      if (type === "hidden" || ["submit", "button", "reset", "image"].includes(type)) continue;
      total++;
      if (controls.length >= 300) continue;
      const box = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
      const c = { type, label: labelOf(el), name: clip(el.getAttribute("name") || "", 80), id: clip(el.id || "", 80) };
      if (tag === "select") {
        c.selected = [...el.selectedOptions].map((o) => clip(o.textContent, 120));
        c.value = clip(el.value, 300);
      } else if (type === "checkbox" || type === "radio") {
        c.checked = !!el.checked;
        c.value = clip(el.value, 120);
      } else if (type === "password") {
        // Never the text of a password, only whether one is there.
        c.value = el.value ? `(${el.value.length} characters, not read)` : "";
      } else if (type === "file") {
        c.value = [...(el.files || [])].map((f) => f.name).join(", ");
      } else if (tag === "input" || tag === "textarea") {
        c.value = clip(el.value, 300);
      } else {
        const ticked = el.getAttribute("aria-checked");
        if (ticked !== null) c.checked = ticked === "true";
        const sel = el.getAttribute("aria-selected");
        if (sel !== null) c.checked = sel === "true";
        c.value = clip(el.getAttribute("aria-valuetext") || el.getAttribute("aria-valuenow") || el.innerText || el.textContent, 300);
      }
      if (el.disabled) c.disabled = true;
      if (!(box.width > 0 && box.height > 0)) c.hidden = true;
      controls.push(c);
    }
  }
  return { controls, total };
}

/** What a run did that the shipped build does differently from the measured one, and what was held. */
function countersOf(run) {
  const pointer = (run.timing && run.timing.pointer) || {};
  const held = run.held || [];
  return {
    // Presses, hovers and drags made by page script (chrome.scripting), as against real input events.
    scriptedInputs: pointer.synthetic || 0,
    // Counted from steps that went through. The engine also marks a press it
    // refused before making it (a covered control) as "real", and that is not an input event.
    realInputs: (run.history || []).some((h) => h && h.pointer) ? (run.history || []).filter((h) => h && h.ok && h.pointer === "real").length : pointer.real || 0,
    // Steps that typed, chose or sent a key. The engine does not say which way these went:
    // in a build without the debugger every one of them is made by script.
    typedActions: (run.history || []).filter((h) => /^(fill|type|press|select)\b/i.test(String(h.action || ""))).length,
    // Steps the engine held for the user's go-ahead, and how many of them the harness refused.
    heldActions: held.length,
    heldRefused: held.filter((h) => !h.allowed).length,
    heldKinds: [...new Set(held.map((h) => h.kind))],
    checkIns: run.checkIns || 0,
    failedActions: (run.history || []).filter((h) => h.ok === false).length,
  };
}

// A cache read's price as a share of the model's input price, where it is not
// the usual tenth (platform.claude.com pricing, read 24 Nov 2026).
const CACHE_READ_SHARE = Object.freeze([{ model: /claude-(sonnet|opus)-5-5/i, share: 0.05 }, { model: /claude-(fable|mythos)-5-[12]/i, share: 0.025 }]);

/**
 * What a judge call cost, from its token counts and a rates lookup
 * (defaults.js findModelRates: USD per 1K tokens). Cache writes cost 1.25
 * times the input price (2 times for a one-hour entry), cache reads the
 * model's share of it, and a batch half of everything.
 */
function judgeCostUSD(usage, ratesFor) {
  if (!usage || !ratesFor) return 0;
  const [input, output] = ratesFor(usage.model) || [0, 0];
  const read = (CACHE_READ_SHARE.find((x) => x.model.test(String(usage.model || ""))) || { share: 0.1 }).share;
  const write = usage.cacheTtl === "1h" ? 2 : 1.25;
  const full = ((usage.input || 0) * input + (usage.cacheWrite || 0) * input * write + (usage.cacheRead || 0) * input * read + (usage.output || 0) * output) / 1000;
  return usage.batch ? full / 2 : full;
}

/** One of: passed, blocked, timed out, lost, failed. */
function bucketOf(row) {
  if (row.success) return "passed";
  if (isInfra(row)) return "lost";
  if (row.blocked || row.waitKind === "human_check") return "blocked";
  if (/^timed out/.test(String(row.ending || ""))) return "timed out";
  return "failed";
}

/** Why a run did not pass, in one line; empty for a pass. */
function failureOf(row) {
  if (row.success) return "";
  return [String(row.ending || "").slice(0, 120), String(row.reason || "").replace(/\s+/g, " ").slice(0, 300)].filter(Boolean).join(" | ");
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * The table: one line per family and a total. `tasks` is every task that
 * was meant to run; a task with no row was not run (the spend cap, or a
 * shard that stopped).
 */
function familyTable(rows, tasks) {
  const families = [...new Set([...(tasks || []).map((t) => t.level), ...rows.map((r) => r.family || r.level)])].filter(Boolean);
  // A planned run has a slot when a task runs more than once (repeat runs, a learn pair).
  const ran = new Set(rows.map((r) => r.slot || r.id));
  const line = (name, rs, planned) => {
    const count = (b) => rs.filter((r) => bucketOf(r) === b).length;
    const scored = rs.filter((r) => bucketOf(r) !== "lost");
    return {
      family: name,
      tasks: planned.length,
      passed: count("passed"),
      failed: count("failed"),
      timedOut: count("timed out"),
      blocked: count("blocked"),
      lost: count("lost"),
      notRun: planned.filter((t) => !ran.has(t.slot || t.id)).length,
      medianSeconds: median(scored.map((r) => r.seconds)),
      agentUSD: rs.reduce((a, r) => a + (r.costUSD || 0) + (r.longPromptUSD || 0) + (r.lostAttemptsUSD || 0) + (r.learnAllowanceUSD || 0), 0),
      replayUSD: rs.reduce((a, r) => a + ((r.recipe && r.recipe.replay && r.recipe.replay.usd) || 0), 0),
      // The simulated approver at held steps (approver.js).
      approverUSD: rs.reduce((a, r) => a + (r.approverUSD || 0), 0),
      judgeUSD: rs.reduce((a, r) => a + (r.judgeCostUSD || 0), 0),
      scriptedInputs: rs.reduce((a, r) => a + ((r.counters && r.counters.scriptedInputs) || 0), 0),
      realInputs: rs.reduce((a, r) => a + ((r.counters && r.counters.realInputs) || 0), 0),
      typedActions: rs.reduce((a, r) => a + ((r.counters && r.counters.typedActions) || 0), 0),
      heldActions: rs.reduce((a, r) => a + ((r.counters && r.counters.heldActions) || 0), 0),
      patternDisagrees: rs.filter((r) => r.patternMatch !== null && r.patternMatch !== undefined && !isInfra(r) && r.patternMatch !== !!r.success).length,
      // Passed with numbers in the answer, none of which is in any captured page.
      ungrounded: rs.filter((r) => r.success && r.grounding && r.grounding.numbers > 0 && r.grounding.found === 0).length,
    };
  };
  const lines = families.map((f) => line(f, rows.filter((r) => (r.family || r.level) === f), (tasks || []).filter((t) => t.level === f)));
  return { lines, total: line("All", rows, tasks || []) };
}

const usd = (x) => `$${Number(x || 0).toFixed(4)}`;
// A cap, in cents unless it is smaller than one.
const capText = (x) => `$${Number(x) >= 0.01 ? Number(x).toFixed(2) : Number(x).toFixed(4)}`;

/** The table and its notes as Markdown, for a job summary. */
function markdown(table, meta = {}) {
  const out = [];
  out.push(`## Real-task trial${meta.dry ? " (dry mode: scripted model, fixture pages, a stub for the judge)" : ""}`);
  out.push("");
  const facts = [
    meta.suite ? `suite ${meta.suite}` : "",
    meta.arm ? `arm ${meta.arm}` : "",
    meta.debuggerShards ? `chrome.debugger in the loaded build: ${meta.debuggerShards}` : "",
    meta.learning ? `learning ${meta.learning}` : "",
    meta.runs > 1 ? `${meta.runs} runs per task` : "",
    meta.agent ? `agent ${meta.agent}` : "",
    meta.judge ? `judge ${meta.judge}` : "",
    meta.commit ? `commit ${String(meta.commit).slice(0, 7)}` : "",
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(", "), "");
  out.push("| family | tasks | passed | failed | timed out | blocked by a human check | lost | not run | median s | agent cost | judge cost | scripted presses | real presses | typing steps | held actions |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const cells = (l, bold) => {
    const b = (x) => (bold ? `**${x}**` : String(x));
    return `| ${b(FAMILIES[l.family] || l.family)} | ${b(l.tasks)} | ${b(l.passed)} | ${b(l.failed)} | ${b(l.timedOut)} | ${b(l.blocked)} | ${b(l.lost)} | ${b(l.notRun)} | ${b(l.medianSeconds === null ? "-" : l.medianSeconds)} | ${b(usd(l.agentUSD))} | ${b(usd(l.judgeUSD))} | ${b(l.scriptedInputs)} | ${b(l.realInputs)} | ${b(l.typedActions)} | ${b(l.heldActions)} |`;
  };
  for (const l of table.lines) out.push(cells(l, false));
  out.push(cells(table.total, true));
  out.push("");
  const t = table.total;
  const scored = t.passed + t.failed + t.timedOut;
  out.push(`Passed ${t.passed} of ${scored} scored runs${scored ? ` (${(100 * t.passed / scored).toFixed(1)}%)` : ""}; with blocked, lost and not-run tasks counted as failures, ${t.passed} of ${t.tasks}${t.tasks ? ` (${(100 * t.passed / t.tasks).toFixed(1)}%)` : ""}.`);
  const spend = t.agentUSD + t.judgeUSD + (t.replayUSD || 0) + (t.approverUSD || 0);
  out.push(`${meta.dry ? "Priced tokens of the scripted model and the judge stub, nothing spent" : "Model spend"}: ${usd(spend)} (agent ${usd(t.agentUSD)}, judge ${usd(t.judgeUSD)}${t.approverUSD ? `, approver ${usd(t.approverUSD)}` : ""}${t.replayUSD ? `, recipe replays ${usd(t.replayUSD)}` : ""})${meta.capUSD ? `, cap ${capText(meta.capUSD)}` : ""}.${meta.capReached ? " The spend cap stopped the run: the tasks under \"not run\" were never started." : ""}`);
  if (meta.spentUSD !== undefined && Math.abs(meta.spentUSD - spend) > 0.00005) out.push(`The shards counted ${usd(meta.spentUSD)} against the cap; the table adds up to ${usd(spend)}.`);
  if (t.patternDisagrees) out.push(`In ${t.patternDisagrees} run(s) the judge and the task's answer pattern disagree: read those first (trial-summary.json lists them).`);
  if (t.ungrounded) out.push(`${t.ungrounded} passed run(s) state numbers of which none is in any captured page: read those too.`);
  if (meta.blockedSites && meta.blockedSites.length) out.push(`Blocked, by site: ${meta.blockedSites.map((b) => `${b.site} ${b.blocked} of ${b.runs}`).join(", ")}. A site that turns the runner away leaves the task file; nothing is done to get past it.`);
  if (meta.armProblems && meta.armProblems.length) out.push(`**Arm check failed.** ${meta.armProblems.join(" ")}`);
  else if (meta.arm && meta.armChecked) out.push(`Arm check: every shard loaded the build the ${meta.arm} arm names${meta.arm === "shipped" ? ", and no run made a real input event" : ""}.`);
  if (meta.stopped && meta.stopped.length) out.push(`Stopped early: ${meta.stopped.join(" | ")}`);
  if (meta.notes) for (const n of meta.notes) out.push(n);
  return out.join("\n");
}

/**
 * The arm must be what ran. Shipped: no shard's build has chrome.debugger,
 * and no run made a real input event. Debugger-on: every shard's build has
 * it. Problems as sentences; empty when the arm holds.
 */
function armProblems(arm, shards, rows, expected = 0) {
  const problems = [];
  if (arm !== "shipped" && arm !== "debugger-on") return problems;
  const want = arm === "debugger-on";
  // A shard that left no results file ran on a build nobody can vouch for.
  if (expected && shards.length !== expected) problems.push(`${shards.length} of ${expected} shard(s) left a results file, so the build the others loaded cannot be checked.`);
  shards.forEach((s, i) => {
    const got = s.agent ? s.agent.debuggerAvailable : undefined;
    const name = s.shard || `shard ${i + 1}`;
    if (typeof got !== "boolean") problems.push(`${name} did not record whether its build has chrome.debugger.`);
    else if (got !== want) problems.push(`${name} loaded a build ${got ? "with" : "without"} chrome.debugger in the ${arm} arm.`);
  });
  if (arm === "shipped") {
    const real = rows.filter((r) => r.counters && r.counters.realInputs > 0);
    if (real.length) problems.push(`${real.length} run(s) made real input events in the shipped arm, which has no way to make one: ${real.slice(0, 8).map((r) => `${r.id} (${r.counters.realInputs})`).join(", ")}.`);
  }
  return problems;
}

const tokensOf = (r) => ((r.tokens && r.tokens.prompt) || 0) + ((r.tokens && r.tokens.completion) || 0);

/** Run 1 against run 2 of every learn pair: outcome, steps, seconds and tokens. Null when no row is from a learn run. */
function learnTable(rows) {
  const pairs = new Map();
  for (const r of rows) {
    if (!r.learn || !r.learn.pair) continue;
    const key = `${r.learn.pair}#${r.run || 1}`;
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[r.learn.phase === "B" ? "b" : "a"] = r;
  }
  if (!pairs.size) return null;
  const side = (r) => (r ? { id: r.id, outcome: bucketOf(r), steps: r.steps || 0, seconds: r.seconds || 0, tokens: tokensOf(r), calls: r.calls || 0 } : null);
  const lines = [...pairs.values()].map((p) => ({
    kind: p.a && p.b && p.a.id !== p.b.id ? "neighbour" : "repeat",
    first: side(p.a),
    second: side(p.b),
    knownAtSecond: p.b && p.b.learn && p.b.learn.memoryAtStart ? p.b.learn.memoryAtStart.count : null,
    shownAtSecond: !!(p.b && p.b.learn && p.b.learn.shownAtFirstStep && p.b.learn.shownAtFirstStep.ids && p.b.learn.shownAtFirstStep.ids.length),
  }));
  const totals = (kind) => {
    const whole = lines.filter((l) => l.kind === kind && l.first && l.second && l.first.outcome !== "lost" && l.second.outcome !== "lost");
    const med = (k, f) => median(whole.map((l) => l[k][f]));
    return {
      kind,
      pairs: lines.filter((l) => l.kind === kind).length,
      scored: whole.length,
      passed: [whole.filter((l) => l.first.outcome === "passed").length, whole.filter((l) => l.second.outcome === "passed").length],
      steps: [med("first", "steps"), med("second", "steps")],
      seconds: [med("first", "seconds"), med("second", "seconds")],
      tokens: [med("first", "tokens"), med("second", "tokens")],
      // Among pairs where both runs passed: the second run took fewer steps, or more.
      fewerSteps: whole.filter((l) => l.first.outcome === "passed" && l.second.outcome === "passed" && l.second.steps < l.first.steps).length,
      moreSteps: whole.filter((l) => l.first.outcome === "passed" && l.second.outcome === "passed" && l.second.steps > l.first.steps).length,
      bothPassed: whole.filter((l) => l.first.outcome === "passed" && l.second.outcome === "passed").length,
      startedKnowing: whole.filter((l) => l.knownAtSecond > 0).length,
      shown: whole.filter((l) => l.shownAtSecond).length,
    };
  };
  return { lines, totals: ["repeat", "neighbour"].map(totals).filter((t) => t.pairs) };
}

function learnMarkdown(table) {
  const out = ["", "### Learning: run 1 against run 2 in the same browser profile", ""];
  const dash = (x) => (x === null || x === undefined ? "-" : x);
  out.push("| pairs | scored | passed, run 1 | passed, run 2 | median steps 1 / 2 | median seconds 1 / 2 | median tokens 1 / 2 | run 2 in fewer steps | in more steps | run 2 started with something learned | was shown it at its first step |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const names = { repeat: "The same task twice", neighbour: "A task, then a neighbour on the same site" };
  for (const t of table.totals) out.push(`| ${names[t.kind]} (${t.pairs}) | ${t.scored} | ${t.passed[0]} | ${t.passed[1]} | ${dash(t.steps[0])} / ${dash(t.steps[1])} | ${dash(t.seconds[0])} / ${dash(t.seconds[1])} | ${dash(t.tokens[0])} / ${dash(t.tokens[1])} | ${t.fewerSteps} of ${t.bothPassed} | ${t.moreSteps} of ${t.bothPassed} | ${t.startedKnowing} | ${t.shown} |`);
  out.push("");
  out.push("| run 1 | run 2 | outcome 1 / 2 | steps 1 / 2 | seconds 1 / 2 | tokens 1 / 2 | known at run 2 |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const l of table.lines) {
    const a = l.first || {};
    const b = l.second || {};
    out.push(`| ${dash(a.id)} | ${l.kind === "repeat" ? "the same" : dash(b.id)} | ${dash(a.outcome)} / ${dash(b.outcome)} | ${dash(a.steps)} / ${dash(b.steps)} | ${dash(a.seconds)} / ${dash(b.seconds)} | ${dash(a.tokens)} / ${dash(b.tokens)} | ${dash(l.knownAtSecond)} |`);
  }
  out.push("");
  out.push("A pair is scored when neither run was lost. One pair per task says little: fewer steps on run 2 is a sign, not a measurement, until the suite has run several times.");
  return out.join("\n");
}

/** Recipes: of the passed runs, how many could be saved, why not, and how the one replay of each went. Null when the recipe arm did not run. */
function recipeTable(rows) {
  const tried = rows.filter((r) => r.recipe);
  if (!tried.length) return null;
  const passed = tried.filter((r) => r.success);
  const saved = passed.filter((r) => r.recipe.saveable);
  const why = {};
  for (const r of passed.filter((x) => !x.recipe.saveable)) { const k = String(r.recipe.why || "no reason given"); why[k] = (why[k] || 0) + 1; }
  const replays = saved.map((r) => r.recipe.replay).filter(Boolean);
  const ok = replays.filter((x) => x.state === "done_proven");
  const ends = {};
  for (const x of replays) { const k = x.state || (x.why ? `did not run: ${x.why}` : "did not run"); ends[k] = (ends[k] || 0) + 1; }
  return {
    passed: passed.length,
    saveable: saved.length,
    notSaveable: Object.entries(why).sort((a, b) => b[1] - a[1]).map(([reason, runs]) => ({ reason, runs })),
    replayed: replays.length,
    replayOk: ok.length,
    replayEnds: ends,
    modelCalls: replays.map((x) => x.modelCalls || 0),
    meanModelCalls: replays.length ? replays.reduce((a, x) => a + (x.modelCalls || 0), 0) / replays.length : null,
    replayUSD: replays.reduce((a, x) => a + (x.usd || 0), 0),
    medianReplaySeconds: median(replays.map((x) => x.seconds)),
  };
}

function recipeMarkdown(t) {
  const out = ["", "### Recipes: each passed run saved and replayed once", ""];
  const share = (a, b) => `${a} of ${b}${b ? ` (${(100 * a / b).toFixed(1)}%)` : ""}`;
  out.push(`Saveable: ${share(t.saveable, t.passed)} passed runs.`);
  if (t.notSaveable.length) out.push(`Not saveable, by the extension's own reason: ${t.notSaveable.map((x) => `${x.reason} (${x.runs})`).join("; ")}.`);
  out.push(`Replays that ended proven done: ${share(t.replayOk, t.replayed)}. How the replays ended: ${Object.entries(t.replayEnds).map(([k, v]) => `${k} ${v}`).join(", ") || "none ran"}.`);
  out.push(`Model calls per replay: ${t.meanModelCalls === null ? "-" : t.meanModelCalls.toFixed(2)} on average (${t.modelCalls.filter((n) => n === 0).length} of ${t.replayed} replays made none)${t.medianReplaySeconds === null ? "" : `, median ${t.medianReplaySeconds} s`}.`);
  out.push("A replay is judged by the recipe's own receipt (its checks after each step), not by the judge model.");
  return out.join("\n");
}

/** The widgets practice suite's lines by kind of interaction (groupTable on "widget"), as Markdown. */
function kindMarkdown(lines) {
  const out = ["", "### By kind of interaction", "", "| kind | tasks | passed | failed | timed out | blocked | lost | not run |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const l of lines) out.push(`| ${WIDGET_KINDS[l.widget] || l.widget} | ${l.tasks} | ${l.passed} | ${l.failed} | ${l.timedOut} | ${l.blocked} | ${l.lost} | ${l.notRun} |`);
  return out.join("\n");
}

/** Every run.json under a folder, newest run of each task last. */
function readRows(dir) {
  const rows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "run.json") { try { rows.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch (_e) { /* a file cut short by a stopped job */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return rows.sort((a, b) => String(a.slot || a.id).localeCompare(String(b.slot || b.id)) || (a.run || 0) - (b.run || 0));
}

/** The shards' own results files: what they ran on, and whether one stopped early. */
function readShards(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^results.*\.json$/.test(e.name)) { try { out.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch (_e) { /* unreadable */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** In dry mode every fixture task must end the way its "dry" field says. Problems as sentences. */
function checkDry(rows, tasks, shards) {
  const problems = [];
  for (const t of tasks) {
    const row = rows.find((r) => (r.slot || r.id) === (t.slot || t.id));
    if (!row) { problems.push(`${t.id}: no run.json`); continue; }
    const got = bucketOf(row);
    const want = String(t.dry || "passed").split("|");
    if (!want.includes(got)) problems.push(`${t.id}: ended as "${got}" (${row.ending}), expected ${want.join(" or ")}`);
    if (t.dryHeld && !(row.counters && row.counters.heldActions >= t.dryHeld)) problems.push(`${t.id}: ${row.counters ? row.counters.heldActions : "no"} held action(s) counted, expected at least ${t.dryHeld}`);
    if (t.dryScripted && !(row.counters && row.counters.scriptedInputs >= t.dryScripted)) problems.push(`${t.id}: ${row.counters ? row.counters.scriptedInputs : "no"} scripted press(es) counted, expected at least ${t.dryScripted}`);
    if (t.dryTyped && !(row.counters && row.counters.typedActions >= t.dryTyped)) problems.push(`${t.id}: ${row.counters ? row.counters.typedActions : "no"} typing step(s) counted, expected at least ${t.dryTyped}`);
    for (const k of ["steps", "seconds", "costUSD", "counters", "family", "ending", "history", "formState", "grounding"]) if (row[k] === undefined) problems.push(`${t.id}: run.json has no "${k}"`);
    // The form controls of the final page were read back, with the value the run typed.
    if (t.dryForm && !(((row.formState && row.formState.controls) || []).some((c) => String(c.value || "") === t.dryForm))) problems.push(`${t.id}: no form control of the final page holds "${t.dryForm}" (${((row.formState && row.formState.controls) || []).length} control(s) read)`);
    // The run was started from the toolbar on its page, as a person starts it, so the browser would give the agent a picture of the page.
    if (got !== "lost" && !(row.picture && row.picture.granted)) problems.push(`${t.id}: the browser would not give the agent a picture of the page (${(row.picture && row.picture.why) || "not recorded"})`);
    // Every hold the allow list did not decide has the approver's answer recorded (its stand-in's, or why it was not asked: the run's call limit).
    for (const h of row.held || []) if (h && h.by !== "allow list" && !(h.approver && typeof h.approver.asks === "boolean")) problems.push(`${t.id}: a held step (${h.kind}) has no recorded answer from the approver`);
    // The judge's code path ran against the stub, and its tokens were counted.
    if (got !== "lost" && !(row.judgeUsage && row.judgeUsage.calls >= 1 && row.judgeCostUSD > 0)) problems.push(`${t.id}: the judge stub was not called, or its tokens were not counted`);
  }
  if (!shards.length) problems.push("no results file from any shard");
  for (const s of shards) if (!s.agent || typeof s.agent.debuggerAvailable !== "boolean") problems.push("a shard did not record whether the loaded build has chrome.debugger");
  return problems;
}

/** The runs a trial was meant to make, one entry per run: {id, level, slot}. */
function plannedRuns(all, { sample = 0, seed = 1, runs = 1, learn = "" } = {}) {
  const out = [];
  if (learn === "pairs") {
    const pairs = learnPlan(all);
    const firsts = sampleTasks(pairs.map((p) => p.a), sample, seed);
    for (const a of firsts) {
      const b = pairs.find((p) => p.a.id === a.id).b;
      for (let r = 1; r <= runs; r++) out.push({ ...a, slot: `${a.id}#${r}#A` }, { ...b, slot: `${a.id}#${r}#B` });
    }
    return out;
  }
  for (const t of sampleTasks(all, sample, seed)) for (let r = 1; r <= runs; r++) out.push({ ...t, slot: `${t.id}#${r}` });
  return out;
}

/** The extra dry legs: each proves one path the plain dry run does not reach. Problems as sentences. */
function checkLeg(leg, { rows, planned, shards, learn, recipes }) {
  const problems = [];
  if (!shards.length) problems.push("no results file from any shard");
  if (leg === "cap") {
    if (!shards.some((s) => s.capReached)) problems.push("no shard reports that the spend cap was reached");
    const ran = new Set(rows.map((r) => r.slot || r.id));
    const notRun = planned.filter((t) => !ran.has(t.slot || t.id)).length;
    const ended = rows.filter((r) => r.ending === "spend cap reached").length;
    if (!notRun && !ended) problems.push("every task ran to its end under a cap that should have stopped the run");
    for (const s of shards) if (!(s.spentUSD > 0)) problems.push("a shard counted no spend at all");
    for (const s of shards) if (s.capReached && !/spend cap/.test(String(s.stoppedEarly || "")) && !ended) problems.push("the cap was reached but the shard does not say it stopped for it");
  }
  if (leg === "learn") {
    if (!learn) problems.push("no run.json is from a learn pair");
    else {
      for (const l of learn.lines) if (!l.first || !l.second) problems.push(`a pair is not whole: ${(l.first || l.second || {}).id}`);
      for (const l of learn.lines) if (l.second && l.knownAtSecond === null) problems.push(`${l.second.id}: run 2 did not record what was known at its start`);
      if (!learn.lines.some((l) => l.knownAtSecond > 0)) problems.push("no second run started with anything learned: learning was not on, or nothing was kept");
      if (!learn.totals.some((t) => t.kind === "repeat") || !learn.totals.some((t) => t.kind === "neighbour")) problems.push("the learn run needs a repeat pair and a neighbour pair");
    }
  }
  if (leg === "recipes") {
    if (!recipes) problems.push("no run.json has a recipe record");
    for (const r of rows) {
      if (bucketOf(r) === "lost") continue;
      if (!r.recipe || typeof r.recipe.saveable !== "boolean") { problems.push(`${r.id}: no record of whether the run could be saved as a recipe`); continue; }
      if (!r.recipe.saveable && !r.recipe.why) problems.push(`${r.id}: not saveable, and no reason`);
      if (r.recipe.saveable && r.success && !(r.recipe.replay && (r.recipe.replay.state || r.recipe.replay.why))) problems.push(`${r.id}: saved, but its replay left no record`);
    }
  }
  return problems;
}

/** The sites a task uses, as registrable domains: its start page and the other sites it names. */
function taskSites(t) {
  return [...new Set([t && t.url, ...((t && t.sites) || [])].map((u) => siteOf(String(u || ""))).filter(Boolean))];
}

/**
 * Problems with the holdout file, as sentences: every task needs a
 * difficulty, and no task may use a site that a task of another suite uses.
 * `others` maps a suite's name to its task list.
 */
function holdoutProblems(holdout, others) {
  const problems = [];
  const owner = new Map();
  for (const [suite, list] of Object.entries(others || {})) for (const t of list || []) for (const site of taskSites(t)) if (!owner.has(site)) owner.set(site, `${suite} (${t.id})`);
  for (const t of holdout || []) {
    if (!DIFFICULTIES.includes(t.difficulty)) problems.push(`${t.id}: a holdout task needs a difficulty (${DIFFICULTIES.join(", ")})`);
    for (const site of taskSites(t)) if (owner.has(site)) problems.push(`${t.id}: ${site} is also used by ${owner.get(site)}`);
  }
  return problems;
}

/**
 * Problems with a suite that must keep to sites of its own, as sentences:
 * each of its tasks on a site another suite uses. A clash with an open suite
 * names both tasks and the site. A clash with a sealed suite (SEALED_SUITES)
 * is only counted, since this suite is open and naming its task or site would
 * point at a sealed site in a public log. `detail: true` names those too, for
 * the editor's own machine. `others` maps a suite's name to its task list
 * (null when absent).
 */
function siteOverlapProblems(own, list, others, { detail = false } = {}) {
  const problems = [];
  const sealedCounts = {};
  const owner = new Map();
  for (const [suite, tasks] of Object.entries(others || {})) {
    if (suite === own) continue;
    for (const t of tasks || []) for (const site of taskSites(t)) if (!owner.has(site) || SEALED_SUITES.includes(suite)) owner.set(site, SEALED_SUITES.includes(suite) ? { sealed: suite } : { text: `${suite} (${t.id})` });
  }
  for (const t of list || []) for (const site of taskSites(t)) {
    const o = owner.get(site);
    if (!o) continue;
    if (!o.sealed) problems.push(`${t.id}: ${site} is also used by ${o.text}`);
    else if (detail) problems.push(`${t.id}: ${site} is also used by the ${o.sealed} suite`);
    else (sealedCounts[o.sealed] = sealedCounts[o.sealed] || new Set()).add(t.id);
  }
  for (const [suite, ids] of Object.entries(sealedCounts)) problems.push(`${ids.size} task(s) of this suite are on a site the ${suite} suite also uses (run suite-check --detail on your own machine to see which)`);
  return problems;
}

/**
 * Problems with the widgets practice file, as sentences: its rule says it is
 * open, it holds 24 to 30 widgets tasks, each with a difficulty, a kind of
 * interaction (WIDGET_KINDS) and a source (WIDGET_SOURCES), every kind is
 * practised, both sources are used (at least 5 real sites), no site has more
 * than 3 tasks, and each task's end state can be checked: a pattern, or a
 * rubric that says how the final page is judged.
 */
function widgetsShapeProblems(file) {
  const problems = [];
  const tasks = taskList(file);
  const rule = String((file && file.rule) || "");
  for (const words of ["PRACTICE SET", "tune the agent on them", "suite-check widgets"]) if (!rule.includes(words)) problems.push(`the rule does not say "${words}"`);
  if (tasks.length < 24 || tasks.length > 30) problems.push(`${tasks.length} tasks, not 24 to 30`);
  const kinds = {};
  const sources = {};
  const bySite = {};
  const judged = /final page|screenshot/i;
  for (const t of tasks) {
    if (t.level !== "widgets") problems.push(`${t.id}: level "${t.level}", not widgets`);
    if (!DIFFICULTIES.includes(t.difficulty)) problems.push(`${t.id}: needs a difficulty (${DIFFICULTIES.join(", ")})`);
    if (!WIDGET_KINDS[t.widget]) problems.push(`${t.id}: widget "${t.widget}" is not one of ${Object.keys(WIDGET_KINDS).join(", ")}`);
    else kinds[t.widget] = (kinds[t.widget] || 0) + 1;
    if (!WIDGET_SOURCES.includes(t.source)) problems.push(`${t.id}: source "${t.source}" is not one of ${WIDGET_SOURCES.join(", ")}`);
    else sources[t.source] = (sources[t.source] || 0) + 1;
    if (!t.expect) problems.push(`${t.id}: no expect`);
    else if (!t.pattern && !judged.test(t.expect)) problems.push(`${t.id}: with no pattern, the rubric must say how the final page shows the end state`);
    for (const s of taskSites(t)) bySite[s] = (bySite[s] || 0) + 1;
  }
  for (const k of Object.keys(WIDGET_KINDS)) if (!kinds[k]) problems.push(`no task practises ${k} (${WIDGET_KINDS[k]})`);
  if ((sources["real-site"] || 0) < 5) problems.push(`${sources["real-site"] || 0} tasks on real sites, not 5 or more`);
  if (!sources["library-demo"]) problems.push("no task on a component library's demo page");
  for (const [s, n] of Object.entries(bySite)) if (n > 3) problems.push(`${n} tasks on ${s}, more than 3`);
  return problems;
}

/** The real pages of a reading check (READING_CHECKS), as tasks with an id and a start page, for the overlap rule. */
function readingCheckPages(name, root = path.join(__dirname, "../..")) {
  const mod = require(path.join(root, READING_CHECKS[name]));
  const urls = name === "reading-wild" ? mod.SITES.map(([, url]) => url) : mod.FILES.map((f) => f.url);
  return urls.map((url, i) => ({ id: `${name}-${i + 1}`, url }));
}

/**
 * Every suite's task list, and the pages of each reading check
 * (READING_CHECKS) as tasks with a start page only. The holdout suite's
 * comes from the plain file (holdoutFile) and is null when that is not
 * there: the repository holds it encrypted only.
 */
function readSuites(root = path.join(__dirname, "../..")) {
  const read = (f) => taskList(JSON.parse(fs.readFileSync(f, "utf8")));
  const out = {};
  for (const [name, file] of Object.entries(SUITES)) {
    if (name === "holdout") { const plain = holdoutFile(root); out[name] = plain ? read(plain) : null; } else out[name] = read(path.join(root, file));
  }
  for (const name of Object.keys(READING_CHECKS)) out[name] = readingCheckPages(name, root);
  return out;
}

// In a sealed summary no line may hold fewer tasks than this: a line for one
// or two tasks would be those tasks' own results.
const SEALED_MIN_GROUP = 3;
const SMALL_GROUPS = "other";

/**
 * Problems with the shape of the holdout file, as sentences: its rule, its
 * size, a spread over families, difficulties and languages, a rubric for
 * every task, at most three tasks on one site, and every family big enough
 * for a line of its own in a sealed summary. It counts long documents but
 * fixes no share of PDFs: the suite is not shaped around any one fix.
 */
function holdoutShapeProblems(file) {
  const problems = [];
  const tasks = taskList(file);
  const rule = String((file && file.rule) || "");
  for (const words of ["Nobody tunes the agent on this file", "numbers only", "replaced"]) if (!rule.includes(words)) problems.push(`the rule does not say "${words}"`);
  if (tasks.length < 45 || tasks.length > 50) problems.push(`${tasks.length} tasks, not 45 to 50`);
  const per = (k) => tasks.reduce((m, t) => ({ ...m, [t[k]]: (m[t[k]] || 0) + 1 }), {});
  const families = per("level");
  if (Object.keys(families).length < 10) problems.push(`${Object.keys(families).length} families, not 10 or more`);
  if (families.fixture) problems.push("a fixture task");
  if ((families.widgets || 0) < 6) problems.push(`${families.widgets || 0} widgets tasks, not 6 or more`);
  for (const [f, n] of Object.entries(families)) if (n < SEALED_MIN_GROUP) problems.push(`family ${f} has ${n} task(s), fewer than ${SEALED_MIN_GROUP}`);
  const levels = per("difficulty");
  for (const d of DIFFICULTIES) if ((levels[d] || 0) < 8) problems.push(`${levels[d] || 0} ${d} tasks, not 8 or more`);
  if (new Set(tasks.filter((t) => t.lang).map((t) => t.lang)).size < 5) problems.push("fewer than 5 languages");
  const live = /a page that did not load, or shows none of this, is a failure or a block, never a pass/;
  const form = /harness's list of the final page's form controls/;
  for (const t of tasks) {
    if (!t.expect) problems.push(`${t.id}: no expect`);
    else if (!t.pattern && !live.test(t.expect) && !form.test(t.expect)) problems.push(`${t.id}: with no pattern, the rubric must say how a live value or a form is judged`);
    if (t.level === "form-fill" && !form.test(String(t.expect))) problems.push(`${t.id}: a form task is judged from the final page's form controls`);
  }
  const bySite = {};
  for (const t of tasks) for (const s of taskSites(t)) bySite[s] = (bySite[s] || 0) + 1;
  for (const [s, n] of Object.entries(bySite)) if (n > 3) problems.push(`${n} tasks on ${s}, more than 3`);
  return problems;
}

/**
 * The family table's counts grouped by a field of the task (its family or
 * its difficulty), for a sealed summary. A run is matched to its task by
 * slot. With `min`, groups of fewer distinct tasks than that are put
 * together under "other", and while "other" itself is still under `min`
 * the smallest named group joins it, so no line holds fewer than `min`
 * tasks unless the whole table does (sealedReport refuses that).
 */
function groupTable(rows, tasks, field, min = 0) {
  const all = tasks || [];
  const bySlot = new Map(all.map((t) => [t.slot || t.id, t]));
  const raw = (t) => (t && t[field]) || "none";
  const taskOf = (r) => bySlot.get(r.slot || r.id) || bySlot.get(`${r.id}#${r.run || 1}`) || all.find((x) => x.id === r.id);
  const size = {};
  for (const t of all) (size[raw(t)] = size[raw(t)] || new Set()).add(t.id);
  const pooled = new Set(min ? Object.keys(size).filter((k) => size[k].size < min) : []);
  const pooledTasks = () => [...pooled].reduce((n, k) => n + size[k].size, 0);
  for (;;) {
    const named = Object.keys(size).filter((k) => !pooled.has(k)).sort((a, b) => size[a].size - size[b].size || a.localeCompare(b));
    if (!pooled.size || pooledTasks() >= min || !named.length) break;
    pooled.add(named[0]);
  }
  const keyOfTask = (t) => (min && (!size[raw(t)] || pooled.has(raw(t))) ? SMALL_GROUPS : raw(t));
  const keyOf = (r) => keyOfTask(taskOf(r) || { [field]: r[field] || (field === "level" ? r.family || r.level : "") });
  const keys = [...new Set([...all.map(keyOfTask), ...rows.map(keyOf)])];
  const order = (k) => { const i = DIFFICULTIES.indexOf(k); return k === SMALL_GROUPS ? 999 : i < 0 ? 99 + Object.keys(FAMILIES).indexOf(k) : i; };
  keys.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return keys.map((k) => ({ ...familyTable(rows.filter((r) => keyOf(r) === k), all.filter((x) => keyOfTask(x) === k)).total, family: undefined, [field]: k, distinctTasks: new Set(all.filter((x) => keyOfTask(x) === k).map((x) => x.id)).size }));
}

/** Only the numbers of a line: what a sealed summary may show of it. */
function sealedCounts(l) {
  const scored = l.passed + l.failed + l.timedOut;
  return {
    tasks: l.tasks, passed: l.passed, failed: l.failed, timedOut: l.timedOut, blocked: l.blocked, lost: l.lost, notRun: l.notRun,
    passRate: scored ? l.passed / scored : null,
    strictPassRate: l.tasks ? l.passed / l.tasks : null,
    medianSeconds: l.medianSeconds,
    spendUSD: l.agentUSD + l.judgeUSD + (l.replayUSD || 0) + (l.approverUSD || 0),
  };
}

/**
 * What a sealed run may report, and nothing else: totals, rates, median
 * time, spend, and counts by family and by difficulty. No task id, answer,
 * verdict, reason, site or failure text is in it.
 */
function sealedReport(rows, planned, meta) {
  // Fewer tasks than a line may hold: the total itself would be their result.
  const distinct = new Set((planned || []).map((t) => t.id)).size;
  if (distinct < SEALED_MIN_GROUP) throw new Error(`A sealed summary needs at least ${SEALED_MIN_GROUP} tasks; this run planned ${distinct}. Run a larger limit.`);
  const table = familyTable(rows, planned);
  const byFamily = groupTable(rows, planned, "level", SEALED_MIN_GROUP);
  const byDifficulty = groupTable(rows, planned, "difficulty", SEALED_MIN_GROUP);
  return {
    sealed: true,
    rule: "Held-out results are read as numbers only. Nobody tunes the agent on the holdout file.",
    meta: {
      suite: meta.suite || "", arm: meta.arm || "", agent: meta.agent || "", judge: meta.judge || "", commit: meta.commit ? String(meta.commit).slice(0, 7) : "",
      runs: meta.runs || 1, dry: !!meta.dry, learning: meta.learning || "", capUSD: meta.capUSD || 0, capReached: !!meta.capReached,
      shardsStoppedEarly: (meta.stopped || []).length, armCheck: meta.armProblems && meta.armProblems.length ? "failed" : meta.armChecked ? "passed" : "not checked",
    },
    total: sealedCounts(table.total),
    // Two signals worth a look that name no task.
    patternDisagrees: table.total.patternDisagrees,
    ungrounded: table.total.ungrounded,
    byFamily: byFamily.map((l) => ({ family: l.level, ...sealedCounts(l) })),
    byDifficulty: byDifficulty.map((l) => ({ difficulty: l.difficulty, ...sealedCounts(l) })),
  };
}

/** A sealed report as Markdown, for the job summary. */
function sealedMarkdown(report) {
  const pct = (x) => (x === null || x === undefined ? "-" : `${(100 * x).toFixed(1)}%`);
  const dash = (x) => (x === null || x === undefined ? "-" : x);
  const m = report.meta;
  const t = report.total;
  const out = [`## Held-out trial (sealed: numbers only)${m.dry ? ", dry mode" : ""}`, ""];
  out.push([m.suite ? `suite ${m.suite}` : "", m.arm ? `arm ${m.arm}` : "", m.learning ? `learning ${m.learning}` : "", m.runs > 1 ? `${m.runs} runs per task` : "", m.agent ? `agent ${m.agent}` : "", m.judge ? `judge ${m.judge}` : "", m.commit ? `commit ${m.commit}` : ""].filter(Boolean).join(", "), "");
  out.push("Nobody tunes the agent on this suite. Read these numbers, not the runs behind them: no task, answer or verdict is shown here or in the summary artifact.", "");
  out.push(`Passed ${t.passed} of ${t.passed + t.failed + t.timedOut} scored runs (${pct(t.passRate)}); with blocked, lost and not-run tasks counted as failures, ${t.passed} of ${t.tasks} (${pct(t.strictPassRate)}).`);
  out.push(`Failed ${t.failed}, timed out ${t.timedOut}, blocked by a human check ${t.blocked}, lost ${t.lost}, not run ${t.notRun}. Median ${dash(t.medianSeconds)} s a run. Model spend ${usd(t.spendUSD)}${m.capUSD ? `, cap ${capText(m.capUSD)}` : ""}${m.capReached ? " (the cap stopped the run)" : ""}.`);
  out.push("");
  const head = (first) => [`| ${first} | tasks | passed | failed | timed out | blocked | lost | not run | pass rate |`, "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  const row = (name, l) => `| ${name} | ${l.tasks} | ${l.passed} | ${l.failed} | ${l.timedOut} | ${l.blocked} | ${l.lost} | ${l.notRun} | ${pct(l.passRate)} |`;
  out.push(...head("family"));
  for (const l of report.byFamily) out.push(row(l.family === SMALL_GROUPS ? "Smaller families, together" : FAMILIES[l.family] || l.family, l));
  out.push("", ...head("difficulty"));
  for (const l of report.byDifficulty) out.push(row(l.difficulty === SMALL_GROUPS ? "smaller difficulties, together" : l.difficulty, l));
  out.push("");
  out.push(`A family or difficulty of fewer than ${SEALED_MIN_GROUP} tasks is counted together with others until that line holds ${SEALED_MIN_GROUP} or more, so that no line is one or two tasks' result.`);
  if (report.patternDisagrees) out.push(`The judge and a task's answer pattern disagree in ${report.patternDisagrees} run(s).`);
  if (report.ungrounded) out.push(`${report.ungrounded} passed run(s) state numbers none of which is in any captured page.`);
  out.push(`Arm check: ${m.armCheck}.${m.shardsStoppedEarly ? ` ${m.shardsStoppedEarly} shard(s) stopped early.` : ""}`);
  return out.join("\n");
}

/** The tasks a text names, by id or start page: empty when it names none. */
function leaksIn(text, tasks) {
  const s = String(text || "");
  return (tasks || []).filter((t) => (t.id && s.includes(t.id)) || (t.url && s.includes(t.url))).map((t) => t.id);
}

// The lines a sealed shard's log may hold, and nothing else: run counts, the
// run's own settings, and the numbers table. A failure's text, an ending, a
// judge's reason or an error message can hold a task's words or its address,
// which leaksIn would not see, so every other line is withheld.
const SEALED_WITHHELD = "(a line withheld: a sealed run prints numbers only)";
const SEALED_LOG_LINES = [
  /^$/,
  /^run \d+ of \d+ (done|recorded earlier)$/,
  /^Benchmark: \d+ task\(s\) x \d+ run\(s\), agent [\w.:/-]+ \/ [\w.:/-]+, judge [\w.:/-]+( with the last \d+ screenshots)?$/,
  /^Output: [\w.:/-]+$/,
  /^\| scored tasks \| runs each \| passed \| success \| success, blocked and lost as failures \| solved at least once \| solved every time \| median steps \(passed\) \| steps spent finding \| median seconds \| blocked by site \| lost \|$/,
  /^\|( --- \|)+$/,
  /^\|[\d.%± ()|-]*$/,
  /^\d+ run\(s\) were lost to the browser, the provider or the judge and are left out of the rate\.$/,
  /^Success with the \d+ blocked and \d+ lost run\(s\) counted as failures: [\d.]+%\.$/,
  /^Steps taken by the helper \([\w.:/-]+\): \d+ of \d+( \([\d.]+%\))?\.$/,
  /^Stopped early: a shard stopped early\.$/,
  /^The harness stopped with an error; a sealed run withholds the detail\.$/,
  /^Set BENCH_API_KEY\.$/,
  /^No tasks to run\.$/,
  /^A sealed run takes no learning\.$/,
];

/** A text as a sealed shard's log may show it: each line that is not of an allowed shape is withheld. */
function sealedLogText(text) {
  return String(text).split("\n").map((line) => {
    // The numbers row carries "N of M tasks" in one cell.
    const bare = line.replace(/ of \d+ tasks /g, " ");
    return SEALED_LOG_LINES.some((re) => re.test(bare)) ? line : SEALED_WITHHELD;
  }).join("\n");
}

// The one line a sealed run prints when it stops on an error.
const SEALED_CRASH = "The harness stopped with an error; a sealed run withholds the detail.";

/**
 * Puts the sealed filter in front of console.log and console.error, and
 * catches an uncaught exception or an unhandled rejection: Node would print
 * its stack, which can carry a task's text, so the run prints SEALED_CRASH
 * and exits with 1 instead. run.js calls this first thing in a sealed run.
 */
function sealConsole(con = console, proc = process) {
  const fmt = (args) => args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const rawError = con.error.bind(con);
  for (const name of ["log", "info", "warn", "error"]) {
    const out = con[name].bind(con);
    con[name] = (...args) => out(sealedLogText(fmt(args)));
  }
  const crash = () => { try { rawError(SEALED_CRASH); } finally { proc.exit(1); } };
  proc.on("uncaughtException", crash);
  proc.on("unhandledRejection", crash);
}

function main(argv) {
  const [cmd, target, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : ""; };
  if (cmd === "validate") {
    const list = taskList(JSON.parse(fs.readFileSync(target, "utf8")));
    const problems = validateTasks(list);
    const per = {};
    for (const t of list) per[t.level] = (per[t.level] || 0) + 1;
    console.log(`${list.length} tasks: ${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(", ")}; ${list.filter((t) => t.pattern).length} with a pattern`);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    return;
  }
  if (cmd === "holdout-check") {
    const plain = holdoutFile();
    if (!plain) { console.error(`No plain holdout file: decrypt ${HOLDOUT_ENCRYPTED} to ${SUITES.holdout} first, or set HOLDOUT_TASKS (tests/bench/README.md).`); process.exit(1); }
    const file = JSON.parse(fs.readFileSync(plain, "utf8"));
    const { holdout, ...others } = readSuites();
    const problems = [...validateTasks(holdout), ...holdoutProblems(holdout, others), ...holdoutShapeProblems(file)];
    const sites = new Set(holdout.flatMap(taskSites));
    // Counts only: this command runs in the open part of the workflow. --detail is for the file's editor.
    console.log(`holdout: ${holdout.length} tasks on ${sites.size} sites, none shared with ${Object.keys(others).join(", ")}${problems.length ? `: NOT SO, ${problems.length} problem(s)` : ""}`);
    if (problems.length) { console.error(argv.includes("--detail") ? problems.join("\n") : "Run holdout-check --detail on the plain file to see them."); process.exit(1); }
    return;
  }
  if (cmd === "suite-check") {
    // The open practice suite: sound, shaped as its rule says, and on no site another suite uses,
    // the holdout's too when its plain file is here. Counts only for a clash with a sealed suite: this
    // command runs in the open part of the workflow. --detail names them, for the editor's own machine.
    const name = target || PRACTICE_SUITE;
    if (name !== PRACTICE_SUITE) { console.error(`suite-check knows the ${PRACTICE_SUITE} suite only.`); process.exit(1); }
    const all = readSuites();
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, "../..", SUITES[name]), "utf8"));
    const list = all[name];
    const problems = [...validateTasks(list), ...widgetsShapeProblems(file), ...siteOverlapProblems(name, list, all, { detail: argv.includes("--detail") })];
    const compared = Object.keys(all).filter((k) => k !== name && all[k]);
    const kinds = new Set(list.map((t) => t.widget));
    console.log(`${name}: ${list.length} tasks on ${new Set(list.flatMap(taskSites)).size} sites, ${kinds.size} kinds of interaction; no site shared with ${compared.join(", ")}${all.holdout ? "" : " (not the holdout: no plain holdout file here)"}${problems.length ? `: NOT SO, ${problems.length} problem(s)` : ""}`);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    return;
  }
  if (cmd === "leaks") {
    const tasks = normaliseTasks(JSON.parse(fs.readFileSync(flag("--tasks"), "utf8")));
    const found = leaksIn(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "", tasks);
    if (found.length) { console.error(`${target} names ${found.length} task(s) of a sealed suite.`); process.exit(1); }
    console.log(`${target} names none of the ${tasks.length} task(s).`);
    return;
  }
  if (cmd === "summary") {
    const taskFile = flag("--tasks");
    const all = taskFile ? normaliseTasks(JSON.parse(fs.readFileSync(taskFile, "utf8"))) : [];
    const learnMode = flag("--learn");
    const runs = Math.max(1, parseInt(flag("--runs") || "1", 10));
    // The same sample run.js took, so "not run" counts only runs that were meant to happen.
    const planned = plannedRuns(all, { sample: parseInt(flag("--sample") || "0", 10), seed: parseInt(flag("--seed") || "1", 10), runs, learn: learnMode });
    const rows = readRows(target);
    const shards = readShards(target);
    const first = shards[0] || {};
    const arm = flag("--arm");
    const has = shards.filter((s) => s.agent && s.agent.debuggerAvailable === true).length;
    const sites = new Map();
    for (const r of rows) {
      const site = hostOf(r.startUrl);
      if (!site) continue;
      const e = sites.get(site) || { site, runs: 0, blocked: 0 };
      e.runs++;
      if (bucketOf(r) === "blocked") e.blocked++;
      sites.set(site, e);
    }
    const meta = {
      dry: shards.some((s) => s.dry),
      suite: flag("--suite"),
      arm,
      commit: flag("--commit"),
      runs,
      learning: learnMode === "pairs" ? "on, in pairs" : learnMode === "on" ? "on" : "",
      debuggerShards: shards.length ? `${has === 0 ? "no" : has === shards.length ? "yes" : "MIXED"} (${has} of ${shards.length} shard(s) have it)` : "",
      agent: first.agent ? `${first.agent.provider} / ${first.agent.model}` : "",
      judge: first.judge ? first.judge.model : "",
      capUSD: shards.reduce((a, s) => a + (s.capUSD || 0), 0),
      spentUSD: shards.length ? shards.reduce((a, s) => a + (s.spentUSD || 0), 0) : undefined,
      capReached: shards.some((s) => s.capReached),
      stopped: shards.map((s) => s.stoppedEarly).filter(Boolean),
      blockedSites: [...sites.values()].filter((e) => e.blocked).sort((a, b) => b.blocked - a.blocked),
      armChecked: shards.length > 0,
      armProblems: armProblems(arm, shards, rows, parseInt(flag("--shards") || "0", 10)),
    };
    const table = familyTable(rows, planned);
    if (rest.includes("--sealed")) {
      let report;
      try { report = sealedReport(rows, planned, meta); } catch (e) { console.error(e.message); process.exit(1); }
      const text = sealedMarkdown(report);
      const json = JSON.stringify(report, null, 2);
      // A sealed summary that names a task is not printed or written at all.
      const leaked = [...new Set([...leaksIn(text, planned), ...leaksIn(json, planned)])];
      if (leaked.length) { console.error(`The sealed summary would name ${leaked.length} task(s); nothing was printed or written.`); process.exit(1); }
      console.log(text);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "trial-summary.json"), json);
      const problems = [];
      if (meta.armProblems.length) problems.push(`the arm check failed (${meta.armProblems.length} problem(s); the sealed per-task files hold the detail)`);
      if (rest.includes("--check-dry")) { const n = checkDry(rows, planned, shards).length; if (n) problems.push(`${n} dry-run problem(s)`); }
      for (const leg of (flag("--check") || "").split(",").filter(Boolean)) {
        if (leg === "sealed") { if (!rows.length) problems.push("no run.json to summarise"); continue; }
        const n = checkLeg(leg, { rows, planned, shards, learn: learnTable(rows), recipes: recipeTable(rows) }).length;
        if (n) problems.push(`${n} problem(s) in the ${leg} leg`);
      }
      if (problems.length) { console.error(`\nTrial check failed: ${problems.join("; ")}.`); process.exit(1); }
      if (flag("--check")) console.error(`\nDry leg check (${flag("--check")}): passed.`);
      return;
    }
    const learn = learnTable(rows);
    const recipes = recipeTable(rows);
    const kinds = planned.some((t) => t.widget) ? groupTable(rows, planned, "widget") : null;
    const text = [markdown(table, meta), kinds ? kindMarkdown(kinds) : "", learn ? learnMarkdown(learn) : "", recipes ? recipeMarkdown(recipes) : ""].filter(Boolean).join("\n");
    console.log(text);
    const ran = new Set(rows.map((r) => r.slot || r.id));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "trial-summary.json"), JSON.stringify({
      meta,
      table,
      learn,
      recipes,
      byWidget: kinds || undefined,
      runs: rows.map((r) => ({ id: r.id, slot: r.slot, family: r.family || r.level, outcome: bucketOf(r), ending: r.ending, steps: r.steps, seconds: r.seconds, tokens: tokensOf(r), costUSD: r.costUSD || 0, longPromptUSD: r.longPromptUSD || 0, lostAttemptsUSD: r.lostAttemptsUSD || 0, judgeCostUSD: r.judgeCostUSD || 0, patternMatch: r.patternMatch === undefined ? null : r.patternMatch, grounding: r.grounding || null, counters: r.counters || null, recipe: r.recipe || undefined, learn: r.learn ? { pair: r.learn.pair, phase: r.learn.phase } : undefined, failure: failureOf(r) })),
      notRun: planned.filter((t) => !ran.has(t.slot || t.id)).map((t) => t.slot || t.id),
    }, null, 2));
    const problems = [...meta.armProblems];
    if (rest.includes("--check-dry")) problems.push(...checkDry(rows, planned, shards));
    for (const leg of (flag("--check") || "").split(",").filter(Boolean)) problems.push(...checkLeg(leg, { rows, planned, shards, learn, recipes }));
    if (problems.length) { console.error(`\nTrial check failed:\n${problems.join("\n")}`); process.exit(1); }
    if (rest.includes("--check-dry")) console.error(`\nDry run check: ${planned.length} fixture run(s) ended as expected.`);
    if (flag("--check")) console.error(`\nDry leg check (${flag("--check")}): passed.`);
    return;
  }
  console.error("Usage: node tests/bench/trial.js validate <tasks.json> | holdout-check | suite-check widgets | leaks <log> --tasks <tasks.json> | summary <out dir> --tasks <tasks.json> [--sample N] [--runs N] [--learn on|pairs] [--arm shipped|debugger-on] [--shards N] [--sealed] [--check-dry] [--check cap|learn|recipes|sealed]");
  process.exit(1);
}

module.exports = { FAMILIES, DIFFICULTIES, SUITES, SEALED_SUITES, WIDGET_KINDS, WIDGET_SOURCES, PRACTICE_SUITE, siteOverlapProblems, widgetsShapeProblems, kindMarkdown, READING_CHECKS, SEALED_CRASH, readingCheckPages, SEALED_MIN_GROUP, SEALED_WITHHELD, HOLDOUT_ENCRYPTED, DRY_PORT, PRACTICE_SITES, validateTasks, taskSites, holdoutFile, holdoutProblems, holdoutShapeProblems, readSuites, groupTable, sealedReport, sealedMarkdown, sealedLogText, sealConsole, leaksIn, patternMatch, patternVerdict, learnPlan, plannedRuns, longPromptSurchargeUSD, spendOf, answerGrounding, engineReadingsInWorker, mergeReadings, PAGE_STATES, keepPageState, answerValues, engineExcerpts, READING, countersOf, judgeCostUSD, bucketOf, failureOf, familyTable, markdown, armProblems, learnTable, learnMarkdown, recipeTable, recipeMarkdown, readRows, readShards, checkDry, checkLeg, readFormControls };

if (require.main === module) {
  const argv = process.argv.slice(2);
  // A sealed summary that crashes prints no stack: its paths and values name the runs.
  try { main(argv); } catch (e) {
    if (argv.includes("--sealed")) { console.error("The sealed summary stopped with an error; the detail is withheld."); process.exit(1); }
    throw e;
  }
}
