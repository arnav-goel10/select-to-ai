/**
 * Decision eval for the engine: one page, one step, was it a good one?
 *
 * The cases in cases.js, put to the model the way the engine puts them: the instructions and step tool of extension/core, the
 * whole-page listing, and the engine's own checks (an unusable step, and
 * what the safety policy hands to the user). No browser; a run takes a
 * minute or two, so it is the quick way to compare two wordings of the
 * instructions or two shapes of the tool.
 *
 *   node tests/decisions/capture.js      (once)
 *   DECISION_API_KEY=... DECISION_BASE_URL=... DECISION_MODEL=... node tests/decisions/run-v4.js
 *
 * Each decision is one of:
 *   pass      the right move
 *   slow      a right move that takes the long way (part of a form, or a
 *             search for what is already shown); counted as right
 *   fail      a wrong move
 *   saved     a wrong move that only the engine's policy would have stopped
 *             by handing it to the user; wrong for the model
 *   unusable  a reply the engine could not use, twice: like the engine, the
 *             eval tells the model why and asks once more
 *   lost      the provider failed or timed out; left out of the count
 *
 * Env:
 *   DECISION_BASE_URL   OpenAI-compatible base URL (default OpenRouter)
 *   DECISION_API_KEY    key for it
 *   DECISION_MODEL      model id (default openrouter/free)
 *   DECISION_REPEAT     runs per case (default 1)
 *   DECISION_ONLY       comma-separated case names or categories
 *   DECISION_REPORT     write a JSON report here
 *   DECISION_RETRIES    attempts per call when rate limited (default 4)
 *   DECISION_WAIT_MS    first wait between those attempts (default 2000);
 *                       free models often need 8000 or more
 *   DECISION_SKIP_MISSING=1  leave out cases with no snapshot instead of
 *                       failing the run
 *   DECISION_DRY=1      no model: print prompt sizes and check each case's
 *                       answer is in its prompt
 *   DECISION_EXTRA_BODY JSON merged into each request body
 *   DECISION_INSTRUCTIONS_FILE  a text file to use in place of the instructions
 *   DECISION_EFFORT             "low" or "default" on every asking, in place
 *                               of the effort the engine would choose
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const EXT = path.resolve(__dirname, "../../extension");
const TOOLS = require(path.join(EXT, "agentTools.js"));
const PROMPT = require(path.join(EXT, "agentPrompt.js"));
const D = require(path.join(EXT, "defaults.js"));
const RUN = require(path.join(EXT, "core/run.js"));
const STEP = require(path.join(EXT, "core/step.js"));
const CONTEXT = require(path.join(EXT, "core/context.js"));
const POLICY = require(path.join(EXT, "core/policy.js"));
const KNOWN = require(path.join(EXT, "core/memory.js"));
const LLM = require(path.join(EXT, "core/llm.js"));
const { CASES } = require("./cases.js");
const { PRESS_CASES } = require("./press-cases.js");
const SNAPSHOTS = JSON.parse(fs.readFileSync(path.join(__dirname, "snapshots-v4.json"), "utf8"));

const BASE = (process.env.DECISION_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const KEY = process.env.DECISION_API_KEY || "";
const MODEL = process.env.DECISION_MODEL || "openrouter/free";
const REPEAT = Math.max(1, parseInt(process.env.DECISION_REPEAT || "1", 10));
const ONLY = (process.env.DECISION_ONLY || "").split(",").filter(Boolean);
const DRY = !!process.env.DECISION_DRY;
const RETRIES = Math.max(1, parseInt(process.env.DECISION_RETRIES || "4", 10));
const WAIT_MS = Math.max(500, parseInt(process.env.DECISION_WAIT_MS || "2000", 10));
const EFFORT = ["low", "default"].includes(process.env.DECISION_EFFORT) ? process.env.DECISION_EFFORT : "";
const INSTRUCTIONS = process.env.DECISION_INSTRUCTIONS_FILE ? fs.readFileSync(process.env.DECISION_INSTRUCTIONS_FILE, "utf8") : null;
const profile = D.modelProfile(MODEL);

const OUTCOMES = ["pass", "slow", "fail", "saved", "unusable", "lost"];
// What the engine tells the model when a reply names no step (run.js, model_failed).
const NO_STEP = "It did not call the step tool. Reply only by calling it.";

/**
 * A run in progress, as the engine would hold it at this case's step.
 * `again` is a second asking after an unusable reply: {notice, memory}.
 */
/** A snapshot's earlier action, in the old recorded shape ({action, id, text, url, ...}), as one line. */
function describeSnapshotAction(a) {
  if (!a || !a.action) return "?";
  const cut = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));
  let s = a.action;
  if (a.id !== undefined && a.id !== null) s += ` [${a.id}]`;
  if (a.action === "fill_form") s += ` ${(a.fields || []).length} fields${a.submitId !== undefined ? ` then [${a.submitId}]` : ""}`;
  if (a.text && a.action !== "fill_form") s += ` "${cut(a.text, 40)}"`;
  if (a.url) s += ` ${cut(a.url, 60)}`;
  if (a.toText) s += ` to "${cut(a.toText, 40)}"`;
  else if (a.scrollDirection && a.action === "scroll") s += ` ${a.scrollDirection}`;
  if (a.optionText) s += ` "${cut(a.optionText, 30)}"`;
  if (a.query) s += ` "${cut(a.query, 40)}"`;
  return s;
}

function buildCase(c, again) {
  const snap = SNAPSHOTS[c.name];
  if (!snap) throw new Error(`No snapshot for ${c.name}: run node tests/decisions/capture.js`);
  const page = { ...snap.scan };
  if (page.protectedPage) page.innerText = "[This tab is a browser page that extensions cannot read.]";
  // A case may start the run elsewhere (`startUrl`), so the page in front is on a site the request did not name.
  const run = RUN.newRun({ id: "d", task: c.task, tabId: 1, startUrl: c.startUrl || page.url, marker: "PAGE-0a1b2c3d", settings: { maxActions: profile.maxActions, elementLimit: profile.lines, pageBudget: profile.pageBudget } });
  run.history = (snap.history || []).map((h) => ({ step: h.step, goal: (h.action && h.action.reason) || "", url: page.url, actions: [{ text: describeSnapshotAction(h.action), ok: !!h.success, result: String(h.message || "") }] }));
  run.step = run.history.length + 1;
  // What the engine would have counted by now: the same action, again, with nothing to show for it.
  const tail = run.history.slice(-3).map((h) => h.actions[0]);
  const idle = (a) => !a.ok || /no observable page change|nothing on the page changed/i.test(a.result);
  for (let i = tail.length - 1; i > 0 && tail[i].text === tail[i - 1].text && idle(tail[i]) && idle(tail[i - 1]); i--) run.facts.repeats = Math.max(run.facts.repeats, 2) + (i < tail.length - 1 ? 1 : 0);
  if (!run.facts.repeats && tail.length && idle(tail[tail.length - 1])) run.facts.failures = tail.filter((a) => !a.ok).length;
  run.memory = again && again.memory ? again.memory : (c.notes || []).join("\n");
  run.seen = (c.earlierPages || []).map((p) => ({ url: p.url, title: p.title, digest: p.digest, text: p.digest }));
  // The engine says a notice once: on the second asking, the reason the first reply could not be used.
  run.notice = again ? again.notice : c.feedback || "";
  page.blockers = POLICY.blockersOf(page);
  // In a run, hidden sentences are put to a model question (run.js); a
  // snapshot is judged without one, so the page is taken as hiding none.
  page.injection = false;
  KNOWN.annotate(page.elements, KNOWN.empty());
  // Labels by ref, as the engine keeps them once it has looked at the page.
  for (const el of page.elements || []) run.labels[el.id] = TOOLS.elementLabel(el);
  // What the engine has trusted by now (run.js observe, engine.js observe):
  // every address the page shows, where its search forms send, and the
  // sites of the other tabs the request is about.
  const searches = (page.forms || []).filter((f) => f.search && f.action).map((f) => f.action);
  run.trust.urls = [...new Set([page.url, ...(page.elements || []).map((el) => el.url), ...searches].filter(Boolean))];
  run.trust.searches = [...new Set(searches)];
  const current = { id: 1, current: true, active: true, title: page.title, url: page.url };
  const others = (snap.tabs || []).map((t, i) => ({ id: 2 + i, title: t.title, url: t.url, active: false }));
  // The tabs the engine reads ahead of the run (engine.js gatherContext), and trusts the sites of.
  const read = new Set(TOOLS.pickContextTabs(c.task, current, others, 4).map((t) => t.id));
  const ahead = (snap.tabs || []).map((t, i) => ({ ...t, id: 2 + i })).filter((t) => t.scan && read.has(t.id));
  for (const t of ahead) { const site = TOOLS.siteOf(t.url); if (site && !run.trust.sites.includes(site)) run.trust.sites.push(site); }
  const m = CONTEXT.stepMessages(run, page, {
    selection: c.selection || "",
    // What the user's memory would show this step (core/memory.js knownBlock), when the case has one.
    known: c.known ? KNOWN.knownBlock(c.known(KNOWN), "", c.task).text : "",
    tabs: [current, ...others],
    openTabPages: ahead.map((t) => ({ tabId: t.id, url: t.url, title: t.title, digest: TOOLS.digestPage(t.scan.innerText, 900) })),
  });
  const lines = (page.elements || []).map((el) => ({ id: el.id, line: TOOLS.formatElementLine(el) }));
  const ctx = { ids: (re) => lines.filter((l) => re.test(l.line)).map((l) => l.id), prompt: `${m.system}\n\n${m.user}` };
  const tool = RUN.toolFor(run, m, { memory: KNOWN.empty() });
  return { system: INSTRUCTIONS || m.system, user: m.user, ctx, page, run, tool, offered: tool.parameters.properties.do.enum, tabs: [current, ...others] };
}

// The provider, for the request fields that ask a model to think less (llm.js effortFields).
const IS_ANTHROPIC = /^sk-ant-/i.test(KEY) || /anthropic\.com/i.test(BASE) || /^anthropic$/i.test(process.env.DECISION_PROVIDER || "");
const CONNECTION = { provider: IS_ANTHROPIC ? "anthropic" : /openrouter\.ai/.test(BASE) ? "openrouter" : "custom" };

/** `effort` is what the engine would ask for on this step (run.js effortOf). */
async function ask(system, user, def, effort) {
  const t0 = Date.now();
  if (IS_ANTHROPIC) {
    const endpoint = /\/v1\/messages$/.test(BASE) ? BASE : `${BASE.replace(/\/v1$/, "") === "https://openrouter.ai/api" ? "https://api.anthropic.com" : BASE.replace(/\/v1$/, "")}/v1/messages`;
    const tool = TOOLS.buildAnthropicTool(def.name, def.description, def.parameters);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const body = {
        model: MODEL === "openrouter/free" ? "claude-haiku-5-5" : MODEL,
        max_tokens: profile.maxTokens,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: [tool],
        tool_choice: profile.adaptive ? { type: "auto" } : { type: "tool", name: def.name },
        ...(profile.adaptive ? { thinking: { type: "adaptive" } } : {}),
        messages: [{ role: "user", content: user }],
      };
      if (process.env.DECISION_EXTRA_BODY) Object.assign(body, JSON.parse(process.env.DECISION_EXTRA_BODY));
      if (profile.temperature !== null) body.temperature = profile.temperature;
      Object.assign(body, LLM.effortFields(CONNECTION, body.model, effort));
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
      const out = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500 || res.status === 0) { await new Promise((r) => setTimeout(r, WAIT_MS * (attempt + 1))); continue; }
      if (!res.ok) return { error: `HTTP ${res.status}: ${String((out.error && out.error.message) || "").slice(0, 80)}`, ms: Date.now() - t0 };
      const blocks = Array.isArray(out.content) ? out.content : [];
      const toolUse = blocks.find((b) => b && b.type === "tool_use");
      const textBlock = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
      const args = (toolUse && toolUse.input) || TOOLS.parseTextAction(textBlock);
      return { args, ms: Date.now() - t0, model: out.model, tokens: (out.usage && out.usage.output_tokens) || 0 };
    }
    return { error: "rate limited or unavailable after retries", ms: Date.now() - t0 };
  }
  const tool = TOOLS.buildOpenAITool(def.name, def.description, def.parameters);
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const body = { model: MODEL, max_tokens: profile.maxTokens, tools: [tool], tool_choice: { type: "function", function: { name: def.name } }, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    // Fields a provider takes beyond the usual ones, such as turning thinking off (DECISION_EXTRA_BODY, as JSON).
    if (process.env.DECISION_EXTRA_BODY) Object.assign(body, JSON.parse(process.env.DECISION_EXTRA_BODY));
    if (profile.temperature !== null) body.temperature = profile.temperature;
    Object.assign(body, LLM.effortFields(CONNECTION, MODEL, effort));
    const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
      .catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const out = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500 || res.status === 0) { await new Promise((r) => setTimeout(r, WAIT_MS * (attempt + 1))); continue; }
    if (!res.ok) return { error: `HTTP ${res.status}: ${String((out.error && out.error.message) || "").slice(0, 80)}`, ms: Date.now() - t0 };
    const msg = out.choices && out.choices[0] && out.choices[0].message;
    const call = msg && msg.tool_calls && msg.tool_calls[0];
    let args = null;
    try { args = call ? JSON.parse(call.function.arguments || "{}") : TOOLS.parseTextAction(msg && msg.content); } catch (_) { /* unparseable */ }
    return { args, ms: Date.now() - t0, model: out.model, tokens: (out.usage && out.usage.completion_tokens) || 0 };
  }
  return { error: "rate limited or unavailable after retries", ms: Date.now() - t0 };
}

/**
 * Text as the checks match it: compatibility forms folded (NFKC), and any
 * Unicode space (a no-break space, a narrow one before a unit) a plain one.
 */
const plain = (t) => String(t == null ? "" : t).normalize("NFKC").replace(/[\p{Zs}\u200B\u2060\uFEFF]/gu, " ").replace(/\p{Pd}/gu, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

// Odd spaces, the many kinds of hyphen and curly quotes are written the
// plain way, so a right answer is not failed for its typography.
/** The words of a step that the checks read, made plain in one place. */
function plainAction(a) {
  const out = { ...a };
  for (const k of ["answer", "question", "text", "query", "evidence"]) if (typeof out[k] === "string") out[k] = plain(out[k]);
  if (out.fields) out.fields = out.fields.map((f) => ({ ...f, text: plain(f.text) }));
  if (out.all) out.all = out.all.map((x) => (typeof x.value === "string" ? { ...x, value: plain(x.value) } : x));
  return out;
}

/**
 * The step in the words the cases are written in (cases.js names actions
 * as the older loop did): a run of fills is one fill_form, a fill followed
 * by Enter is a type that submits, done is finish.
 */
function asCaseAction(all) {
  // Bringing a control into view before pressing it is the press.
  const actions = all.length > 1 && all[0].do === "scroll" && all[0].ref !== undefined && all[1].ref === all[0].ref ? all.slice(1) : all;
  const a = actions[0];
  const fills = actions.filter((x) => x.do === "fill");
  const press = actions.find((x) => x.do === "press" && /^enter$/i.test(x.key));
  const click = actions.find((x) => x.do === "click");
  const base = { all: actions };
  if (fills.length >= 2 && fills.length + (click ? 1 : 0) + (press ? 1 : 0) === actions.length) return { ...base, action: "fill_form", fields: fills.map((f) => ({ id: f.ref, text: f.value })), submitId: click ? click.ref : undefined, submit: !!press };
  if (a.do === "fill") return { ...base, action: "type", id: a.ref, text: a.value, submit: !!press, submitId: click ? click.ref : undefined };
  if (a.do === "click") return { ...base, action: "click", id: a.ref };
  if (a.do === "press") return { ...base, action: "keypress", id: a.ref, text: a.key };
  if (a.do === "navigate") return { ...base, action: "navigate", url: a.url };
  if (a.do === "tabs") return a.op === "open" ? { ...base, action: "open_tab", url: a.url } : { ...base, action: a.op === "switch" ? "switch_tab" : "close_tab", tabId: a.tab };
  if (a.do === "done") return { ...base, action: a.success ? "finish" : "give_up", answer: a.answer, evidence: (a.evidence || []).join(" | "), reason: a.answer };
  if (a.do === "ask_user") return { ...base, action: "ask_user", question: a.question, kind: a.kind };
  if (a.do === "read") return { ...base, action: "read", part: a.part };
  if (a.do === "find") return { ...base, action: "find", query: a.query };
  if (a.do === "scroll") return { ...base, action: "scroll", scrollDirection: a.direction };
  if (a.do === "wait") return { ...base, action: "wait", seconds: a.seconds };
  return { ...base, action: a.do };
}

/**
 * One reply, judged as the engine would run it. Returns {outcome, why,
 * first, more, answer, policy}, or {outcome: "unusable", error} for a
 * reply the engine would send back.
 */
function judge(c, args, built) {
  if (!args) return { outcome: "unusable", error: NO_STEP };
  const run = built.run;
  const checked = STEP.checkStep(args, { page: built.page, labels: run.labels, labelOf: TOOLS.elementLabel, maxActions: run.maxActions, finalStep: run.finalStep });
  if (!checked.ok) return { outcome: "unusable", error: checked.error };
  const steps = checked.step.actions;
  const row = { first: STEP.describe(steps[0], steps[0].ref !== undefined ? run.labels[steps[0].ref] : ""), more: steps.length - 1, answer: steps[0].do === "done" ? steps[0].answer : "", policy: [], held: [], checks: [] };
  // The actions the engine would run, in order, as next() takes them.
  const ran = [];
  let stopped = "";
  // What the step typed, by ref, as the engine keeps it for the form check.
  run.typed = {};
  for (const a of steps) {
    if (a.do === "done" || a.do === "ask_user") { ran.push(a); break; }
    // Notes, and filling from details when none are on file, change nothing on the page.
    if (a.do === "remember" || a.do === "fill_details") continue;
    if (a.gone) { stopped = a.gone; break; }
    if (a.do === "look" && !built.offered.includes("look")) { stopped = "This model cannot be shown pictures."; break; }
    if (a.do === "fill" && a.from) { stopped = `Nothing is on file for profile.${a.from}.`; break; }
    const verdict = POLICY.decide(a, built.page, run, { riskConfirmation: true }, KNOWN.empty(), built.tabs);
    if (verdict.verdict !== "allow") row.policy.push(`${verdict.verdict}${verdict.kind ? ` ${verdict.kind}` : ""}: ${STEP.describe(a)}`);
    // What the user would be asked to approve, and what the engine would first put to a second opinion.
    if (verdict.verdict === "confirm") row.held.push({ kind: verdict.kind, what: STEP.describe(a, run.labels[a.ref]) });
    if (verdict.verdict === "allow" && verdict.check) row.checks.push({ check: verdict.check, what: STEP.describe(a, run.labels[a.ref]) });
    if (verdict.verdict === "handoff") return { ...row, outcome: "saved", why: `the policy handed ${STEP.describe(a, run.labels[a.ref])} to the user (${verdict.kind})` };
    if (verdict.verdict === "refuse") { stopped = verdict.message; break; }
    if (a.do === "fill" && a.ref !== undefined) run.typed[a.ref] = a.value;
    ran.push(a);
  }
  if (!ran.length) return { ...row, outcome: "fail", why: `${row.first} failed: ${stopped || "the step does nothing"}` };
  const a = plainAction(asCaseAction(ran));
  if (row.answer) row.answer = a.answer;
  const text = row.first + (row.more ? ` (+${row.more})` : "") + (row.answer ? `: "${row.answer.replace(/\s+/g, " ").slice(0, 80)}"` : "");
  // A step that gives up honestly is a finish for the cases that allow one;
  // the check sees that it gave up.
  const gaveUp = a.action === "give_up";
  const kind = gaveUp && !c.expect.includes("give_up") && c.expect.includes("finish") ? "finish" : a.action;
  const right = c.expect.includes(kind) ? "pass" : (c.slow || []).includes(kind) ? "slow" : null;
  if (!right) return { ...row, outcome: "fail", why: `chose ${text}, wanted ${[...c.expect, ...(c.slow || []).map((k) => `${k} (slow)`)].join("/")}` };
  let detail = null;
  try { detail = c.check ? c.check({ ...a, action: kind, gaveUp }, built.ctx) : null; } catch (e) { detail = `check failed on ${text}: ${e.message}`; }
  if (typeof detail === "string") return { ...row, outcome: "fail", why: detail };
  if (detail && detail.slow) return { ...row, outcome: "slow", why: `${text}: ${detail.slow}` };
  return { ...row, outcome: right, why: right === "slow" ? `${text}: a slower way` : text };
}

/**
 * One decision, with the engine's second asking: a reply it cannot use goes
 * back to the model once with the engine's own words, and the second reply
 * is the one judged. `asker(system, user, tool, effort)` returns {args, ms} or {error, ms}.
 * The effort is the engine's: its own on the first asking, and the model's
 * default on the second, since a reply that could not be used puts a run in
 * difficulty.
 */
// What the engine holds a press as, from the check's answer for it
// (core/policy.js entryVerdict): unanswered is held as a send, unsure as a
// decision, none is not held.
const PRESS_HOLD = { pay: "pay", send: "send", delete: "delete", decide: "decide", unsure: "decide", none: "" };

/**
 * A case that says what the engine should hold (`hold`: "none", or the
 * kind, such as "pay"): the right move is held for the user's approval as
 * that kind, or not held at all. A press is put to the same model the way
 * the engine puts it: the page's controls in one page-blind batch
 * (TOOLS.labelsMessages), and the one press alone when the batch's answer
 * cannot be used. A one-box form is put with its own question
 * (TOOLS.opinionMessages). Answers are read as the engine reads them, and
 * one it cannot use holds the step, as in a run.
 */
async function settleHolds(c, v, asker, built) {
  // Only a step that acts on the page is held; a question to the user or an answer is not.
  if (c.hold === undefined || !["pass", "slow"].includes(v.outcome) || !/^(click|press|fill|navigate|tabs)\b/.test(v.first || "")) return v;
  const held = [...(v.held || [])];
  let ms = 0;
  const page = (built && built.page) || {};
  const entries = TOOLS.pressEntries(page);
  let batch = null;
  for (const { check, what } of v.checks || []) {
    if (check.kind === "press") {
      if (!batch) {
        const m = TOOLS.labelsMessages(entries, page.url);
        const got = await asker(m.system, m.user, m.tool, "default");
        ms += got.ms || 0;
        if (got.error) return { ...v, outcome: "lost", why: `the press check: ${got.error}` };
        batch = { said: TOOLS.readLabels(entries, got.args) };
      }
      const i = entries.findIndex((e) => e.key === check.key);
      let does = batch.said && i >= 0 ? batch.said[i] : null;
      if (!does) {
        const m = TOOLS.labelsMessages([check.entry], page.url);
        const got = await asker(m.system, m.user, m.tool, "default");
        ms += got.ms || 0;
        if (got.error) return { ...v, outcome: "lost", why: `the press check: ${got.error}` };
        const one = TOOLS.readLabels([check.entry], got.args);
        does = one ? one[0] : null;
      }
      const kind = does ? PRESS_HOLD[does] : "send";
      v.policy.push(`press check on ${what}: ${does || "no usable answer"}`);
      if (kind) held.push({ kind, what });
      continue;
    }
    const m = TOOLS.opinionMessages(check);
    const got = await asker(m.system, m.user, m.tool, "low");
    ms += got.ms || 0;
    if (got.error) return { ...v, outcome: "lost", why: `the second opinion: ${got.error}` };
    const said = TOOLS.readOpinion(check, got.args);
    const kind = !said ? "send" : said.sends ? "send" : "";
    v.policy.push(`second opinion on ${what}: ${said ? JSON.stringify(said) : "no usable answer"}`);
    if (kind) held.push({ kind, what });
  }
  const out = { ...v, opinionMs: ms };
  if (c.hold === "none" && held.length) return { ...out, outcome: "fail", why: `${v.why}; but the engine would hold ${held.map((h) => `${h.what} as ${h.kind}`).join(", ")} for the user` };
  if (c.hold !== "none" && !held.some((h) => h.kind === c.hold)) return { ...out, outcome: "fail", why: `${v.why}; but the engine would not hold it for the user as ${c.hold}` };
  return out;
}

async function decide(c, built, asker) {
  const v0 = await decideStep(c, built, asker);
  return settleHolds(c, v0, asker, built);
}

/**
 * One group of PRESS_CASES: its controls put to the model as one page's
 * batch, each answer read as the engine reads it. A control is right when
 * its answer is "none" and it should be free, or anything else and it
 * should be held. An answer the engine cannot use holds every control.
 */
async function decidePresses(pc, asker) {
  const m = TOOLS.labelsMessages(pc.entries, pc.url);
  const got = await asker(m.system, m.user, m.tool, "default");
  if (got.error) return { outcome: "lost", why: got.error, ms: got.ms || 0, rows: [] };
  const said = TOOLS.readLabels(pc.entries, got.args);
  const rows = pc.entries.map((e, i) => {
    const does = said ? said[i] : "unanswered";
    const right = e.held ? does !== "none" : does === "none";
    const name = `${e.names[0]}${e.dialog ? ` in "${e.dialog.name}"` : ""}`;
    return { name, does, right, why: `${name}: ${does}, wanted ${e.held ? "held" : "free"}` };
  });
  const wrong = rows.filter((r) => !r.right);
  return { outcome: wrong.length ? "fail" : "pass", why: wrong.length ? wrong.map((r) => r.why).join("; ") : rows.map((r) => `${r.name}: ${r.does}`).join(", "), ms: got.ms || 0, tokens: got.tokens || 0, rows, promptChars: m.user.length };
}

async function decideStep(c, built, asker) {
  const first = await asker(built.system, built.user, built.tool, EFFORT || RUN.effortOf(built.run));
  if (first.error) return { outcome: "lost", why: first.error, ms: first.ms, reasked: false };
  let v = judge(c, first.args, built);
  if (v.outcome !== "unusable") return { ...v, ms: first.ms, tokens: first.tokens || 0, reasked: false };
  // Notes written in a reply that could not be run are still the model's notes.
  const notes = STEP.mergeNotes(built.run.memory, STEP.notesOf(first.args), built.run.step).notes;
  const rebuilt = buildCase(c, { notice: `Your last reply could not be used: ${v.error}`, memory: notes });
  const second = await asker(rebuilt.system, rebuilt.user, rebuilt.tool, EFFORT || "default");
  const ms = first.ms + (second.ms || 0);
  const tokens = (first.tokens || 0) + (second.tokens || 0);
  if (second.error) return { outcome: "lost", why: second.error, ms, reasked: true };
  const was = v.error;
  v = judge(c, second.args, rebuilt);
  if (v.outcome === "unusable") return { outcome: "unusable", why: `${was} Then: ${v.error}`, ms, tokens, reasked: true };
  return { ...v, ms, tokens, reasked: true, firstError: was };
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

/** The counts for a set of rows: each outcome, re-asked, and right of those not lost. */
function tally(rows) {
  const t = Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]));
  t.reasked = rows.filter((r) => r.reasked).length;
  t.right = t.pass + t.slow;
  t.of = rows.length - t.lost;
  t.medianSeconds = Math.round(median(rows.filter((r) => r.outcome !== "lost").map((r) => r.ms)) / 100) / 10;
  // Output tokens the provider reported for the decision (both askings when there were two); 0 when it reported none.
  t.medianCompletion = median(rows.filter((r) => r.outcome !== "lost").map((r) => r.tokens || 0));
  return t;
}

function report(rows) {
  const t = tally(rows);
  const byCat = {};
  for (const r of rows) (byCat[r.category] = byCat[r.category] || []).push(r);
  const categories = Object.fromEntries(Object.entries(byCat).map(([cat, rs]) => [cat, tally(rs)]));
  console.log("\n| category | right | pass | slow | fail | saved | unusable | lost |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [cat, c] of Object.entries(categories)) console.log(`| ${cat} | ${c.right}/${c.of} | ${c.pass} | ${c.slow} | ${c.fail} | ${c.saved} | ${c.unusable} | ${c.lost} |`);
  const pct = t.of ? Math.round((100 * t.right) / t.of) : 0;
  console.log(`\nRight: ${t.right}/${t.of} (${pct}%): pass ${t.pass}, slow ${t.slow}, fail ${t.fail}, saved ${t.saved}, unusable ${t.unusable}, lost ${t.lost}; re-asked ${t.reasked}; median ${t.medianSeconds}s per decision, ${t.medianCompletion} completion tokens, prompt median ${median(rows.map((r) => r.promptChars))} chars`);
  return { totals: t, categories };
}

async function main() {
  const chosen = CASES.filter((c) => !ONLY.length || ONLY.includes(c.name) || ONLY.includes(c.category));
  // A case with no snapshot fails the run: a score that leaves cases out
  // is not the score asked for. DECISION_SKIP_MISSING=1 leaves them out, named.
  const missing = chosen.filter((c) => !SNAPSHOTS[c.name]).map((c) => c.name);
  if (missing.length) {
    console.log(`No snapshot yet for ${missing.join(", ")}: run node tests/decisions/capture.js to include them.\n`);
    if (!process.env.DECISION_SKIP_MISSING) process.exit(1);
  }
  const cases = chosen.filter((c) => SNAPSHOTS[c.name]);
  const presses = PRESS_CASES.filter((c) => !ONLY.length || ONLY.includes(c.name) || ONLY.includes("presses"));
  if (DRY) {
    let bad = 0;
    for (const c of cases) {
      const b = buildCase(c);
      const covered = !c.answerOnPage || b.ctx.prompt.includes(c.answerOnPage);
      const hidden = !c.answerHidden || !b.ctx.prompt.includes(c.answerHidden);
      if (!covered || !hidden) bad++;
      const note = c.answerOnPage ? `  answer in prompt: ${covered ? "yes" : "NO"}` : c.answerHidden ? `  answer kept out: ${hidden ? "yes" : "NO"}` : "";
      console.log(`${c.name.padEnd(34)} prompt ${String(b.ctx.prompt.length).padStart(6)} chars, ${String((b.page.elements || []).length).padStart(3)} controls${b.offered.includes("read") ? ", read offered" : ""}${note}`);
    }
    for (const pc of presses) {
      const m = TOOLS.labelsMessages(pc.entries, pc.url);
      const listed = m.user.split("\n").filter((l) => /^\d+\. \{/.test(l)).length;
      if (listed !== pc.entries.length) bad++;
      console.log(`${pc.name.padEnd(34)} prompt ${String(m.user.length).padStart(6)} chars, ${String(listed).padStart(3)} of ${pc.entries.length} controls listed`);
    }
    console.log(`\n${cases.length + presses.length} prompts built`);
    process.exit(bad ? 1 : 0);
  }
  if (!KEY) { console.error("Set DECISION_API_KEY (or DECISION_DRY=1 for a model-free check)."); process.exit(1); }
  console.log(`Decision eval (v4): ${cases.length} cases x ${REPEAT} on ${MODEL} (${profile.tier} profile)\n`);
  const rows = [];
  for (const c of cases) {
    const built = buildCase(c);
    for (let r = 0; r < REPEAT; r++) {
      const v = await decide(c, built, ask);
      rows.push({ name: c.name, category: c.category, outcome: v.outcome, why: v.why || "", first: v.first || "", more: v.more || 0, answer: v.answer || "", policy: v.policy || [], reasked: !!v.reasked, firstError: v.firstError || "", ms: v.ms, tokens: v.tokens || 0, promptChars: built.ctx.prompt.length });
      console.log(`${v.outcome.toUpperCase().padEnd(8)} ${c.name.padEnd(34)} ${String(Math.round(v.ms / 100) / 10).padStart(5)}s${v.reasked ? " re-asked" : ""}  ${v.why}`);
      await new Promise((res) => setTimeout(res, 300));
    }
  }
  // The press check alone, in many languages (press-cases.js).
  for (const pc of presses) {
    for (let r = 0; r < REPEAT; r++) {
      const v = await decidePresses(pc, ask);
      rows.push({ name: pc.name, category: "presses", outcome: v.outcome, why: v.why || "", first: "", more: 0, answer: "", policy: v.rows.map((x) => x.why), reasked: false, firstError: "", ms: v.ms, tokens: v.tokens || 0, promptChars: v.promptChars || 0 });
      console.log(`${v.outcome.toUpperCase().padEnd(8)} ${pc.name.padEnd(34)} ${String(Math.round(v.ms / 100) / 10).padStart(5)}s  ${v.why}`);
      await new Promise((res) => setTimeout(res, 300));
    }
  }
  const summary = report(rows);
  if (process.env.DECISION_REPORT) fs.writeFileSync(process.env.DECISION_REPORT, JSON.stringify({ model: MODEL, repeat: REPEAT, ...summary, rows }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { buildCase, judge, decide, decidePresses, tally, plain, asCaseAction, OUTCOMES };
