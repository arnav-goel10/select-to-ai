/**
 * The replay state machine (design §3.2, §4). `advance(state, event)`
 * returns the next effect for the runner to perform; it does no I/O and
 * reads no clock (times come in with events). It emits a `model` effect
 * only from the repair path, and only when a step could not be completed as
 * recorded and repair is switched on.
 *
 * Effects:  wait {until: target|post|done} · act · model · ask · end
 * Events:   waited · acted · model_replied · model_failed · answered · stop
 */
import { resolve, rank, THRESHOLDS, labelOf, driftOf, learnWeights, fingerprintOf } from "./fingerprint.js";
import { evaluateAll, derivePost, valueOf } from "./post.js";
import { fill, clip, norm, containsValue, templatize } from "./text.js";
import { urlMatches, siteOf } from "./url.js";
import { bindVariables } from "./vars.js";
import { buildRepairRequest, buildVerifyRequest, vetPatch, patchText, actionText } from "./repair.js";
import { newId } from "./schema.js";
import { fromReplay } from "./receipt.js";
import { neighbourhoodOf, driftBetween, driftText, buildMeaningRequest, DATA, markRecordData, recordCells } from "./drift.js";

const DONE_DEADLINE_MS = 3000;

/**
 * @param {object} recipe
 * @param {Record<string,unknown>} values
 * @param {{now?:number, thresholds?:object, repair?:boolean, maxRepairs?:number, approver?:boolean, marker?:string}} [o]
 */
export function newReplay(recipe, values, o = {}) {
  const bound = bindVariables(recipe.variables, values || {});
  return {
    id: newId("rpl"),
    recipe,
    steps: recipe.steps.map((s) => ({ ...s })),
    bindings: bound.bindings,
    inputErrors: bound.errors,
    thresholds: { ...THRESHOLDS, ...(o.thresholds || {}) },
    opts: { repair: !!o.repair, maxRepairs: o.maxRepairs ?? 2, approver: !!o.approver },
    marker: o.marker || newId("m").slice(2, 10),
    startedAt: o.now || 0,
    cursor: -1,
    phase: "start",
    cur: null,
    refs: {},
    lastSnap: null,
    prevAfter: null,
    log: [],
    repairs: [],
    pending: [],
    repairsUsed: 0,
    seeksUsed: 0,
    checks: { drift: 0 },
    cells: [],
    ctxAccepted: [],
    extracts: {},
    downloads: [],
    cost: { modelCalls: 0, inTok: 0, outTok: 0, usd: 0, models: [] },
    drift: [],
    trace: [],
    end: null,
  };
}

/** Start the machine: the first effect. */
export function start(state) {
  if (state.inputErrors.length) return finish(state, "failed", `bad input: ${state.inputErrors.join("; ")}`);
  return nextStep(state);
}

function emit(state, effect) {
  state.trace.push(effect.type === "wait" ? `wait:${effect.until}` : effect.type);
  return { state, effect };
}

function step(state) { return state.steps[state.cursor]; }

function needsTarget(s) {
  return !["navigate", "back"].includes(s.action.do) && !(s.action.do === "press" && !s.action.onTarget);
}

function nextStep(state) {
  state.cursor++;
  if (state.cursor >= state.steps.length) {
    state.phase = "done";
    return emit(state, { type: "wait", until: "done", deadlineMs: DONE_DEADLINE_MS });
  }
  const s = step(state);
  state.cur = { stepId: s.id, ref: null, el: null, resolution: null, before: state.lastSnap, retries: 0, attempts: 0, patch: null, attempt: null, waitedMs: 0, settleMs: 0, actAt: 0 };
  if (!needsTarget(s)) return act(state, null);
  state.phase = "target";
  return targetWait(state, s, s.optional ? Math.min(1500, s.wait.deadlineMs) : s.wait.deadlineMs);
}

function targetWait(state, s, deadlineMs) {
  const e = { type: "wait", until: "target", step: s.id, deadlineMs, texts: s.action.do === "read" };
  if (s.target && s.target.loc) e.probes = [fill(s.target.loc, state.bindings)];
  return emit(state, e);
}

function act(state, ref) {
  const s = step(state);
  const a = s.action;
  const action = { do: a.do };
  if (ref) action.ref = ref;
  if (a.do === "navigate") action.url = fill(a.url, state.bindings);
  if (a.do === "fill") action.value = fill(a.value, state.bindings);
  if (a.do === "press") action.key = a.key;
  state.phase = "acting";
  return emit(state, { type: "act", step: s.id, action });
}

/**
 * Whether a snapshot satisfies what a wait effect is waiting for. The
 * runner calls this on every snapshot the driver takes while waiting.
 */
export function waitCheck(state, effect, snap) {
  if (effect.until === "target") {
    const s = state.steps.find((x) => x.id === effect.step);
    return resolve(s, snap, state.bindings, state.thresholds).ok;
  }
  if (effect.until === "post") {
    const s = state.steps.find((x) => x.id === effect.step);
    return evaluateAll(s.post.all, snap, state.bindings, postCtx(state)).held;
  }
  if (effect.until === "done") {
    return evaluateAll(doneOf(state), snap, state.bindings, postCtx(state)).held;
  }
  return true;
}

function doneOf(state) {
  const d = state.recipe.result && state.recipe.result.done;
  return d && d.length ? d : [];
}

function postCtx(state) {
  return {
    before: state.cur ? state.cur.before : null,
    ref: state.cur ? state.cur.ref : null,
    target: state.cursor >= 0 && state.cursor < state.steps.length ? state.steps[state.cursor].target : null,
    refs: state.refs,
    steps: state.steps,
    downloads: state.downloads,
    since: state.cur ? state.cur.actAt : 0,
    thresholds: state.thresholds,
  };
}

/**
 * Advance on an event.
 * @returns {{state:object, effect:object}}
 */
export function advance(state, ev) {
  if (state.end) return { state, effect: { type: "end" } };
  if (ev.type === "stop") return finish(state, "stopped", ev.why || "stopped by the caller", "user");
  if (ev.snap) state.lastSnap = ev.snap;
  if (ev.at) state.lastAt = ev.at;
  switch (state.phase) {
    case "target": return onTarget(state, ev);
    case "acting": return onActed(state, ev);
    case "inserting": return onInserted(state, ev);
    case "seeking": return onSeekActed(state, ev);
    case "post": return onPost(state, ev);
    case "repair": return onModel(state, ev);
    case "verify": return onVerify(state, ev);
    case "meaning": return onMeaning(state, ev);
    case "ask": return onAnswer(state, ev);
    case "done": return onDone(state, ev);
    default: return finish(state, "failed", `unexpected event ${ev.type} in ${state.phase}`);
  }
}

function onTarget(state, ev) {
  if (ev.type !== "waited") return finish(state, "failed", `expected a wait result, got ${ev.type}`);
  const s = step(state);
  const snap = ev.snap;
  state.cur.waitedMs += ev.elapsedMs || 0;
  const offSite = siteGone(state, snap);
  if (offSite) return finish(state, "failed", offSite, "site");
  const res = resolve(s, snap, state.bindings, state.thresholds);
  state.cur.resolution = res;
  if (state.cur.patch && state.cur.patch.type === "insert" && !state.cur.patch.after) state.cur.patch.after = snap;
  if (!res.ok) {
    if (s.optional && !state.cur.patch) {
      logStep(state, "skipped", { post: [] });
      return nextStep(state);
    }
    if (state.cur.seek) return seekStep(state, snap);
    if (s.seek && !state.cur.seekTried) { state.cur.seekTried = true; return startSeek(state, s.seek.target, s.seek.max, snap); }
    // The row a value chose is not on this part of the list: page through it
    // with the page's own next-page control, without a model. It is a
    // search; the step's target and check still decide.
    if (!s.seek && !state.cur.seekTried && s.target && s.target.scope && res.reason === "no_candidate") {
      const pager = pagerOf(snap, state.recipe.sites);
      state.cur.seekTried = true;
      if (pager) { return startSeek(state, fingerprintOf(pager, snap, state.bindings), SEEK_MAX, snap); }
    }
    if (state.cur.patch && state.cur.patch.type === "insert") return patchFailed(state, snap, `after the inserted step the control was still not found (best ${res.score}, ${res.reason})`);
    const wrongPage = s.pre && s.pre.page && s.pre.page.url && !urlMatches(s.pre.page.url, snap.url, state.bindings);
    return trigger(state, wrongPage ? "wrong_page" : "no_target", `best match ${res.score}, margin ${res.margin} (${res.reason})`, snap, res.ranked);
  }
  state.cur.seek = null;
  if (state.cur.patch && state.cur.patch.overlay) {
    const same = res.ref === state.cur.failedRef || res.method === "exact";
    if (!same || res.el.onTop === false) return patchFailed(state, snap, `after dismissing the overlay the control did not match exactly as recorded (${res.el.onTop === false ? "still covered" : `found ${res.method}, score ${res.score}`})`);
  }
  return proceed(state, s, res.ref, res.el, snap);
}

/**
 * The step's control is found: check that the words around it still mean
 * what they meant when recorded, then read, skip (already so) or act.
 */
function proceed(state, s, ref, el, snap) {
  state.cur.ref = ref;
  state.cur.el = el;
  state.cur.before = snap;
  // The record this run chose: cells of a row a value picked.
  if (s.target && s.target.scope && !state.cur.cellsTaken) { state.cur.cellsTaken = true; state.cells.push(...recordCells(el, snap)); }
  if (s.ctx && !state.cur.meaningOk) {
    const read = s.action.do === "read";
    let live = neighbourhoodOf(el, snap, state.bindings, { read, scoped: !!(s.target && s.target.scope), value: read ? readValue(el) : undefined });
    if (state.cells.length) live = markRecordData(live, state.cells);
    const diffs = driftBetween(s.ctx, live, state.bindings, state.thresholds.driftSim);
    if (diffs.length) {
      state.cur.drift = { live, diffs, ref, el, snap };
      state.checks.drift++;
      const shown = shownBindings(state);
      if (!state.opts.repair) return finish(state, "needs_you", `step ${s.id} (${s.intent}): the words around it changed (${driftText(diffs)}); with no model to check the meaning, a person should look`, "drift");
      state.phase = "meaning";
      return emit(state, { type: "model", purpose: "meaning", step: s.id, request: buildMeaningRequest({ request: state.recipe.request, step: s, rec: s.ctx, live, diffs, bindings: shown, marker: state.marker }) });
    }
  }
  if (s.action.do === "read") {
    const value = readValue(el);
    state.extracts[s.action.name] = value;
    state.refs[s.id] = ref;
    if (state.cur.patch) { state.cur.patch.status = "passed_step"; state.pending.push(state.cur.patch); }
    logStep(state, "ok", { value, post: [] });
    state.prevAfter = snap;
    return nextStep(state);
  }
  // Already so? A read or edit step whose check already holds is skipped;
  // a commit step that looks done already is not pressed again.
  if (s.post.strength === "strong" && !state.cur.patch) {
    const pre = evaluateAll(s.post.all, snap, state.bindings, { ...postCtx(state), before: snap, since: Infinity });
    if (pre.held) {
      if (s.class === "commit") return finish(state, "stopped", `step ${s.id} (${s.intent}) looks done already, so it was not pressed again`, "drift");
      state.refs[s.id] = ref;
      logStep(state, "already", { post: pre.results });
      state.prevAfter = snap;
      return nextStep(state);
    }
  }
  return act(state, ref);
}

function onMeaning(state, ev) {
  const s = step(state);
  if (ev.usage) tally(state, ev.usage);
  const d = state.cur.drift;
  if (ev.type === "model_failed") return finish(state, "needs_you", `step ${s.id} (${s.intent}): the words around it changed (${driftText(d.diffs)}) and the meaning check failed to run: ${clip(ev.error, 160)}`, "drift");
  if (ev.type !== "model_replied") return finish(state, "failed", `expected a model reply, got ${ev.type}`);
  const r = ev.reply || {};
  if (r.same !== "same") return finish(state, "needs_you", `step ${s.id} (${s.intent}): the words around it changed (${driftText(d.diffs)}); a meaning check answered "${r.same || "nothing"}": ${clip(r.why, 200)}`, "drift");
  state.cur.meaningOk = true;
  state.ctxAccepted.push({ stepId: s.id, ctx: d.live });
  return proceed(state, s, d.ref, d.el, d.snap);
}

function readValue(el) {
  const v = valueOf(el);
  if (el.tag === "input" || el.tag === "select" || el.tag === "textarea") return String(v || "").trim();
  return String(el.text || el.name || v || "").trim();
}

function onActed(state, ev) {
  if (ev.type !== "acted") return finish(state, "failed", `expected an action result, got ${ev.type}`);
  const s = step(state);
  state.cur.actAt = ev.startedAt || 0;
  state.cur.settleMs = ev.settleMs || 0;
  if (ev.downloads && ev.downloads.length) state.downloads.push(...ev.downloads);
  if (!ev.ok) {
    if (state.cur.patch) return patchFailed(state, ev.snap || state.lastSnap, `the action failed: ${clip(ev.error, 160)}`);
    if (state.cur.retries < 1 && needsTarget(s)) {
      state.cur.retries++;
      state.phase = "target";
      return targetWait(state, s, Math.min(3000, s.wait.deadlineMs));
    }
    if (!needsTarget(s)) return finish(state, "failed", `could not ${actionText(s.action, shownBindings(state))}: ${clip(ev.error, 160)}`, "site");
    const covered = state.cur.el && state.cur.el.onTop === false;
    const detail = `${covered ? `the recorded control was found (ref ${state.cur.ref}) but something on top of it takes the click; ` : `the recorded control was found (ref ${state.cur.ref}) but acting on it failed; `}${clip(ev.error, 160)}`;
    state.cur.failedRef = state.cur.ref;
    return trigger(state, "action_failed", detail, ev.snap || state.lastSnap, state.cur.resolution && state.cur.resolution.ranked);
  }
  state.phase = "post";
  return emit(state, { type: "wait", until: "post", step: s.id, deadlineMs: s.wait.deadlineMs });
}

/*
 * Seeking: the step's control sits in a list that shows part of its items
 * (pages, "load more"). Press the control that shows more, and look again,
 * up to `max` times. A seek is found by repair once and then saved with the
 * step, so later runs page through without a model.
 */
const SEEK_MAX = 12;

/*
 * A next-page control, from what the page states about it: rel="next" (the
 * HTML link relation for the next page of a series), or a link or button
 * whose whole label says next page or show more. It must stay on the site,
 * not submit a form and not be disabled or sensitive.
 */
const NEXT_LABEL = /^(?:next|next page|more|load more|show more|see more|view more|older|older entries|[›»→>]|>>|next\s*[›»→>]+|[›»→>]+\s*next)$/i;

export function pagerOf(snap, sites) {
  const ok = (e) => ["link", "button"].includes(e.kind) && !e.disabled && !e.sensitive && !(e.submits && !(e.form && e.form.search)) && e.onTop !== false
    && (!e.href || (() => { try { const h = new URL(e.href, snap.url); return /^https?:$/.test(h.protocol) && (!sites || !sites.length || sites.includes(siteOf(h.href))); } catch { return false; } })());
  const els = (snap.elements || []).filter(ok);
  const byRel = els.find((e) => /(^|\s)next(\s|$)/i.test(e.rel || ""));
  if (byRel) return byRel;
  return els.find((e) => NEXT_LABEL.test(norm(labelOf(e)).replace(/\s+/g, " "))) || null;
}

function startSeek(state, fp, max, snap) {
  state.cur.seek = { fp, n: 0, max: max || SEEK_MAX };
  return seekStep(state, snap);
}

function seekStep(state, snap) {
  const s = step(state);
  const sk = state.cur.seek;
  const fail = (why) => {
    state.cur.seek = null;
    if (state.cur.patch && state.cur.patch.type === "seek") return patchFailed(state, snap, why);
    return trigger(state, "no_target", why, snap, state.cur.resolution && state.cur.resolution.ranked);
  };
  if (sk.n >= sk.max) return fail(`looked through ${sk.n} more pages and the control was not there`);
  const more = resolve({ class: "read", action: { do: "click" }, target: sk.fp }, snap, state.bindings, state.thresholds);
  if (!more.ok) return fail(sk.n ? `looked through ${sk.n} more pages; there are no more` : "the control that shows more items is not on the page");
  if (more.el.submits && !(more.el.form && more.el.form.search)) return fail("the control that shows more items submits a form");
  sk.n++;
  state.phase = "seeking";
  return emit(state, { type: "act", step: `${s.id}~`, action: { do: "click", ref: more.ref } });
}

function onSeekActed(state, ev) {
  if (ev.type !== "acted") return finish(state, "failed", `expected an action result, got ${ev.type}`);
  if (!ev.ok) {
    const snap = ev.snap || state.lastSnap;
    state.cur.seek.n = state.cur.seek.max;
    return seekStep(state, snap);
  }
  const s = step(state);
  state.phase = "target";
  return targetWait(state, s, Math.min(2500, s.wait.deadlineMs));
}

function onInserted(state, ev) {
  if (ev.type !== "acted") return finish(state, "failed", `expected an action result, got ${ev.type}`);
  if (!ev.ok) return patchFailed(state, ev.snap || state.lastSnap, `the inserted step failed: ${clip(ev.error, 160)}`);
  const s = step(state);
  state.phase = "target";
  return targetWait(state, s, s.wait.deadlineMs);
}

function onPost(state, ev) {
  if (ev.type !== "waited") return finish(state, "failed", `expected a wait result, got ${ev.type}`);
  const s = step(state);
  state.cur.waitedMs += ev.elapsedMs || 0;
  const r = evaluateAll(s.post.all, ev.snap, state.bindings, postCtx(state));
  if (r.held) {
    if (state.cur.patch) {
      state.cur.patch.status = "passed_step";
      state.pending.push(state.cur.patch);
    }
    state.refs[s.id] = state.cur.ref;
    if (state.cur.el && s.target) {
      const attrs = driftOf(s.target, state.cur.el, state.bindings);
      if (attrs.length) state.drift.push({ step: s.id, attrs });
    }
    logStep(state, "ok", { post: r.results });
    state.prevAfter = ev.snap;
    return nextStep(state);
  }
  const failed = r.results.filter((x) => !x.held).map((x) => `${x.pred.k}: ${x.observed}`).join("; ");
  if (state.cur.patch) return patchFailed(state, ev.snap, `the success check failed (${failed})`, r.results);
  if (state.pending.length) {
    logStep(state, "failed", { post: r.results });
    return rollbackStop(state, `step ${s.id} failed its check after the repair (${failed})`);
  }
  if (s.class === "commit") {
    logStep(state, "failed", { post: r.results });
    return finish(state, "stopped", `step ${s.id} (${s.intent}) was pressed but its check failed, so it may or may not have gone through: ${failed}`, "drift");
  }
  return trigger(state, "post_failed", failed, ev.snap, state.cur.resolution && state.cur.resolution.ranked, r.results);
}

function siteGone(state, snap) {
  if (!snap || !snap.url) return null;
  if (snap.status && snap.status >= 400) return `the site answered with an error (${snap.status})`;
  const sites = state.recipe.sites || [];
  if (sites.length && !/^(about|chrome|data):/.test(snap.url) && !sites.includes(siteOf(snap.url))) return `the page left the recipe's sites (${siteOf(snap.url)})`;
  return null;
}

function trigger(state, kind, detail, snap, ranked, postResults) {
  const s = step(state);
  state.cur.trigger = { kind, detail, ranked: ranked || [] };
  if (postResults) logStep(state, "failed", { post: postResults });
  if (state.pending.length && kind === "post_failed") return rollbackStop(state, `step ${s.id} failed after a repair: ${detail}`);
  // Two controls that match the recording equally and say the same words:
  // the page itself is ambiguous (two records with the same name), and
  // choosing between them is a person's call, not a repair.
  if (snap && s.target) {
    const twins = twinsOf(s, snap, state.bindings);
    if (twins) return finish(state, "needs_you", `step ${s.id} (${s.intent}): ${twins}`, "drift");
  }
  if (!s.target) return finish(state, "stopped", `step ${s.id} (${s.intent}) could not be done as recorded: ${kind}, ${detail}`, "drift");
  if (!state.opts.repair) return finish(state, "stopped", `step ${s.id} (${s.intent}) could not be done as recorded: ${kind}, ${detail}`, "drift");
  if (state.repairsUsed >= state.opts.maxRepairs) return failAll(state, `step ${s.id} needs a repair, but this run already used its ${state.opts.maxRepairs} repairs (${kind}, ${detail})`);
  // A control found exactly as recorded but covered by an overlay (a
  // dialog, banner or popover): the only repair allowed is one inserted step
  // that dismisses that overlay, and the control must then match as
  // recorded. This holds for commit steps too: the commit itself is
  // unchanged (round 3, fix 20).
  const cover = kind === "action_failed" && state.cur.el && state.cur.el.onTop === false && state.cur.el.cover && OVERLAYS.has(state.cur.el.cover.kind) ? state.cur.el.cover : null;
  state.cur.overlay = cover;
  if (s.class === "commit" && !state.opts.approver && !cover) {
    return failAll(state, `step ${s.id} (${s.intent}) submits or sends and could not be done as recorded (${kind}, ${detail}); commit steps are never repaired without a person's yes`, "needs_you");
  }
  return requestRepair(state, snap);
}

const OVERLAYS = new Set(["dialog", "banner", "popover"]);

function twinsOf(s, snap, bindings) {
  const pool = s.action.do === "read" ? [...(snap.elements || []), ...(snap.texts || [])] : (snap.elements || []);
  const ranked = rank(s.target, pool, bindings, s.action, { viewport: snap.viewport });
  if (ranked.length < 2) return null;
  const [a, b] = ranked;
  const la = norm(labelOf(a.el)), lb = norm(labelOf(b.el));
  if (!la || la !== lb || a.el.kind !== b.el.kind || Math.abs(a.score - b.score) > 0.05 || a.score < 0.5) return null;
  // Only when what tells them apart would be a bound value: the label or
  // the item is the variable's.
  const fromVar = Object.values(bindings || {}).some((v) => String(v).trim().length >= 2 && (containsValue(labelOf(a.el), v) || containsValue(a.el.group, v)));
  return fromVar ? `two ${a.el.kind}s say "${clip(labelOf(a.el), 60)}" and match equally; which one is meant is for a person to decide` : null;
}

function requestRepair(state, snap) {
  const s = step(state);
  const t = state.cur.trigger;
  const insertOnly = t.kind === "wrong_page";
  const req = buildRepairRequest({
    step: s, snap, bindings: state.bindings, trigger: t.kind, detail: t.detail, ranked: t.ranked,
    prevAfter: state.prevAfter, attempt: state.cur.attempt, marker: state.marker, insertOnly, overlay: state.cur.overlay,
    secrets: (state.recipe.variables || []).filter((v) => v.type === "secret").map((v) => v.name),
  });
  state.cur.repairSnap = snap;
  state.phase = "repair";
  return emit(state, { type: "model", purpose: "repair", step: s.id, request: req });
}

function onModel(state, ev) {
  const s = step(state);
  if (ev.usage) tally(state, ev.usage);
  if (ev.type === "model_failed") return failAll(state, `step ${s.id} needed a repair, but the repair model failed: ${clip(ev.error, 160)}`);
  if (ev.type !== "model_replied") return finish(state, "failed", `expected a model reply, got ${ev.type}`);
  const snap = state.cur.repairSnap;
  const origin = (() => { try { return new URL(snap.url).origin; } catch { return null; } })();
  const vet = vetPatch(ev.reply, s, snap, state.bindings, state.cur.trigger.ranked, { insertOnly: state.cur.trigger.kind === "wrong_page", overlay: state.cur.overlay, origin, failedRef: state.cur.failedRef, secrets: (state.recipe.variables || []).filter((v) => v.type === "secret").map((v) => v.name) });
  state.cur.attempts++;
  if (!vet.ok) {
    state.repairs.push({ step: s.id, patch: ev.reply && ev.reply.patch, status: "rejected", diffText: vet.why, model: ev.usage && ev.usage.model, why: ev.reply && ev.reply.why });
    if (!vet.stop && state.cur.attempts < 2) {
      state.cur.attempt = { text: `${ev.reply.patch} on ${ev.reply.ref}`, observed: `refused before trying: ${vet.why}` };
      return requestRepair(state, snap);
    }
    return failAll(state, `step ${s.id} (${s.intent}) could not be repaired: ${vet.why}`);
  }
  if (vet.needsYes) {
    if (!state.opts.approver) {
      state.repairs.push({ step: s.id, patch: vet.patch.type, status: "needs_you", diffText: patchText(vet.patch, s, state.bindings), model: ev.usage && ev.usage.model, why: vet.needsYes });
      return failAll(state, `step ${s.id}: a repair was found but ${vet.needsYes}`, "needs_you");
    }
    state.cur.proposal = vet;
    state.phase = "ask";
    return emit(state, { type: "ask", kind: "approve_repair", step: s.id, text: patchText(vet.patch, s, state.bindings), why: vet.needsYes });
  }
  // An edit-class repair is checked a second time, independently, before it
  // acts: its own success check (the value is in the field) holds for any
  // field, so a wrong field would only be caught by a later step, after the
  // wrong data went in.
  const p = vet.patch;
  const editing = (p.type === "retarget" && (vet.raisedClass || s.class) === "edit") || (p.type === "insert" && p.action.do === "fill");
  if (editing) {
    state.cur.proposal = vet;
    state.cur.proposalUsage = ev.usage;
    state.phase = "verify";
    const req = buildVerifyRequest({
      step: s, el: p.el, snap, bindings: state.bindings, marker: state.marker,
      action: p.type === "insert" ? p.action : null,
      secrets: (state.recipe.variables || []).filter((v) => v.type === "secret").map((v) => v.name),
    });
    return emit(state, { type: "model", purpose: "verify", step: s.id, request: req });
  }
  return applyPatch(state, vet, ev.usage);
}

function onVerify(state, ev) {
  const s = step(state);
  if (ev.usage) tally(state, ev.usage);
  const vet = state.cur.proposal;
  if (ev.type === "model_failed") return failAll(state, `step ${s.id}: a repair was found but its check failed to run: ${clip(ev.error, 160)}`);
  if (ev.type !== "model_replied") return finish(state, "failed", `expected a model reply, got ${ev.type}`);
  const r = ev.reply || {};
  if (r.same === "yes") return applyPatch(state, vet, state.cur.proposalUsage);
  const text = patchText(vet.patch, s, shownBindings(state));
  state.repairs.push({ step: s.id, patch: vet.patch.type, status: "needs_you", diffText: text, model: ev.usage && ev.usage.model, why: `a second check answered "${r.same || "nothing"}": ${clip(r.why, 200)}` });
  return failAll(state, `step ${s.id} (${s.intent}): a repair proposed ${text}, but a second check did not confirm it is the same field (${r.same || "no answer"}: ${clip(r.why, 160)})`, "needs_you");
}

function onAnswer(state, ev) {
  if (ev.type !== "answered") return finish(state, "failed", `expected an answer, got ${ev.type}`);
  const s = step(state);
  if (!ev.yes) {
    state.repairs.push({ step: s.id, patch: state.cur.proposal.patch.type, status: "rejected", diffText: patchText(state.cur.proposal.patch, s, state.bindings), why: "declined by the approver" });
    return failAll(state, `the repair to step ${s.id} was declined`, "stopped", "user");
  }
  const vet = state.cur.proposal;
  vet.approved = true;
  return applyPatch(state, vet, null);
}

function applyPatch(state, vet, usage) {
  const s = step(state);
  // Paging is a search, not a change to the step: it has its own small
  // budget and does not use the run's repairs.
  if (vet.patch.type === "seek") state.seeksUsed++;
  else state.repairsUsed++;
  const p = vet.patch;
  const entry = { step: s.id, patch: p.type, status: "trial", diffText: patchText(p, s, state.bindings), model: usage && usage.model, why: p.why, predicted: p.predicted, confidence: p.confidence, approved: !!vet.approved };
  state.repairs.push(entry);
  const before = state.cur.repairSnap;
  if (p.type === "retarget") {
    const oldTarget = s.target;
    state.steps[state.cursor] = { ...s, target: p.fingerprint, class: vet.raisedClass || s.class };
    state.cur.patch = { type: "retarget", stepId: s.id, entry, before: oldTarget, after: p.fingerprint, labelChanged: p.labelChanged, raisedClass: vet.raisedClass, cls: vet.raisedClass || s.class, approved: !!vet.approved };
    state.cur.ref = p.ref;
    state.cur.el = p.el;
    state.cur.before = before;
    // A read step is not acted on: its value is read from the new control,
    // after the same meaning check as any read.
    if (s.action.do === "read") return proceed(state, state.steps[state.cursor], p.ref, p.el, before);
    return act(state, p.ref);
  }
  if (p.type === "seek") {
    state.cur.patch = { type: "seek", stepId: s.id, entry, fingerprint: p.fingerprint, approved: !!vet.approved, cls: s.class };
    return startSeek(state, p.fingerprint, SEEK_MAX, before);
  }
  // insert: act the inserted step, then wait for the original target again.
  state.cur.patch = { type: "insert", stepId: s.id, entry, el: p.el, action: p.action, ref: p.ref, before, after: null, approved: !!vet.approved, cls: s.class, overlay: !!state.cur.overlay };
  const action = { do: p.action.do, ref: p.ref };
  if (p.action.do === "fill") action.value = fill(p.action.value, state.bindings);
  if (p.action.do === "press") action.key = p.action.key;
  state.phase = "inserting";
  return emit(state, { type: "act", step: `${s.id}+`, action });
}

function patchFailed(state, snap, observed, postResults) {
  const s = step(state);
  const p = state.cur.patch;
  p.status = "failed";
  p.entry.status = "failed";
  p.entry.observed = observed;
  // Restore the step as recorded.
  if (p.type === "retarget") state.steps[state.cursor] = { ...s, target: p.before, class: s.class === p.cls && p.raisedClass ? state.recipe.steps[state.cursor].class : s.class };
  state.cur.patch = null;
  state.cur.attempt = { text: p.entry.diffText, observed };
  if (postResults) logStep(state, "failed", { post: postResults });
  if (state.cur.attempts < 2 && state.repairsUsed < state.opts.maxRepairs && state.opts.repair) {
    state.cur.trigger = { ...state.cur.trigger, detail: `${state.cur.trigger.detail}; then a repair failed: ${observed}` };
    return requestRepair(state, snap || state.lastSnap);
  }
  return failAll(state, `step ${s.id} (${s.intent}) could not be repaired: ${observed}`);
}

function rollbackStop(state, why) {
  const first = state.pending[0];
  const blame = first ? ` The repair at step ${first.stepId} may be wrong: a later step failed after it.` : "";
  return failAll(state, `${why}.${blame}`);
}

/** Stop the run; every pending repair is rolled back. */
function failAll(state, why, endState = "stopped", reason = "drift") {
  return finish(state, endState, why, reason);
}

function onDone(state, ev) {
  if (ev.type !== "waited") return finish(state, "failed", `expected a wait result, got ${ev.type}`);
  const done = doneOf(state);
  if (!done.length) {
    const names = (state.recipe.result.extract || []).map((x) => x.name);
    const read = names.length && names.every((n) => String(state.extracts[n] || "").trim() !== "");
    if (read) { state.doneResults = []; return finish(state, "done_proven", "every step's check held and every value was read"); }
    return finish(state, "done_unproven", names.length ? "a value to read was empty" : "the recipe has no end check");
  }
  const r = evaluateAll(done, ev.snap, state.bindings, { ...postCtx(state), since: 0 });
  state.doneResults = r.results;
  if (r.held) return finish(state, "done_proven", "every step's check and the end check held");
  return finish(state, "done_unproven", `the end check did not hold: ${r.results.filter((x) => !x.held).map((x) => `${x.pred.k}: ${x.observed}`).join("; ")}`);
}

function logStep(state, status, extra) {
  const s = step(state);
  const c = state.cur || {};
  const res = c.resolution;
  state.log = state.log.filter((x) => !(x.id === s.id && x.status === "failed" && status !== "failed"));
  state.log.push({
    id: s.id,
    n: state.cursor + 1,
    intent: s.intent,
    class: s.class,
    action: actionText(s.action, shownBindings(state)),
    status,
    resolution: res ? { method: c.patch ? "repair" : res.method || (res.ok ? "fingerprint" : "none"), score: res.score, margin: res.margin, ranked: (res.ranked || []).map((x) => ({ label: x.label, score: x.score })) } : null,
    target: c.el ? clip(labelOf(c.el), 80) : null,
    post: (extra.post || []).map((x) => ({ predicate: x.pred.k, held: x.held, observed: x.observed })),
    value: extra.value,
    settleMs: c.settleMs || 0,
    waitedMs: c.waitedMs || 0,
  });
}

/** Bindings safe to write down: secrets are replaced by a mark. */
function shownBindings(state) {
  const out = { ...state.bindings };
  for (const v of state.recipe.variables || []) if (v.type === "secret" && v.name in out) out[v.name] = "(secret)";
  return out;
}

function tally(state, u) {
  state.cost.modelCalls++;
  state.cost.inTok += u.inTok || 0;
  state.cost.outTok += u.outTok || 0;
  state.cost.usd += u.usd || 0;
  if (u.model && !state.cost.models.includes(u.model)) state.cost.models.push(u.model);
}

/**
 * End the run: settle pending repairs (persist or roll back), update the
 * recipe's versions, counters and state, and build the receipt.
 */
function finish(state, endState, why, reason) {
  const proven = endState === "done_proven";
  for (const p of state.pending) p.entry.status = proven ? "persisted" : "rolled_back";
  for (const r of state.repairs) if (r.status === "trial") r.status = proven ? "persisted" : "rolled_back";
  state.end = { state: endState, why, reason: reason || null, at: state.lastAt || state.startedAt };
  state.recipeOut = proven ? persist(state) : demote(state, endState);
  state.phase = "ended";
  state.receipt = fromReplay(state);
  state.trace.push("end");
  return { state, effect: { type: "end", receipt: state.receipt } };
}

function persist(state) {
  const r = structuredClone(state.recipe);
  const healed = state.pending.length > 0;
  if (healed) {
    const steps = structuredClone(state.recipe.steps);
    const ops = [];
    for (const p of state.pending) {
      const i = steps.findIndex((x) => x.id === p.stepId);
      if (p.type === "seek") {
        steps[i] = { ...steps[i], seek: { target: p.fingerprint, max: SEEK_MAX } };
        ops.push({ op: "edit", step: p.stepId, before: null, after: { seek: steps[i].seek }, why: p.entry.why || "page through the list to find the control" });
        continue;
      }
      if (p.type === "retarget") {
        ops.push({ op: "retarget", step: p.stepId, before: p.before, after: p.after, why: p.entry.why || "" });
        steps[i] = { ...steps[i], target: p.after };
        if (p.raisedClass) { ops.push({ op: "class", step: p.stepId, before: steps[i].class, after: p.raisedClass, why: "the new control submits a form" }); steps[i].class = p.raisedClass; }
        p.entry.review = steps[i].class !== "read" || p.labelChanged;
      } else {
        const id = nextInsertId(steps, p.stepId);
        const fp = fingerprintOf(p.el, p.before, state.bindings);
        const post = p.after ? derivePost({ action: p.action, ref: p.ref, el: p.el }, p.before, p.after, state.bindings) : { all: [{ k: "changed" }], strength: "weak" };
        const ins = {
          id, intent: `Clear the way: ${clip(p.entry.why || "inserted by repair", 100)}`,
          class: p.action.do === "fill" ? "edit" : "read", risk: [],
          pre: { page: steps[i].pre.page, targetPresent: true, noBlockers: true },
          action: p.action.do === "press" ? { do: "press", key: p.action.key, onTarget: true } : p.action.do === "fill" ? { do: "fill", value: p.action.value } : { do: "click" },
          target: fp, post, wait: { ...steps[i].wait },
          // What it cleared may show only sometimes (a banner seen once), so
          // a later run skips it when its control is not there.
          optional: true,
        };
        steps.splice(i, 0, ins);
        ops.push({ op: "insert", step: id, before: null, after: ins, why: p.entry.why || "" });
        p.entry.review = true;
      }
    }
    const prev = r.versions[r.active];
    if (prev) prev.status = "superseded";
    r.versions.push({ v: (prev ? prev.v : 0) + 1, at: state.end.at || state.startedAt, by: "repair", parent: prev ? prev.v : null, ops, steps: structuredClone(steps), receiptId: state.id, status: "active" });
    while (r.versions.length > 10) {
      const k = r.versions.findIndex((v, idx) => idx !== r.versions.length - 1);
      r.versions.splice(k, 1);
    }
    r.active = r.versions.length - 1;
    r.steps = steps;
  } else {
    // A clean pass teaches which attributes are stable (design §1.3.4).
    for (const entry of state.log) {
      const s = r.steps.find((x) => x.id === entry.id);
      const el = s && state.refs[s.id] && findIn(state, state.refs[s.id]);
      if (s && s.target && el) s.target.weights = learnWeights(s.target, el, state.bindings);
    }
    if (r.versions[r.active]) r.versions[r.active].steps = structuredClone(r.steps);
  }
  // Surroundings a meaning check accepted become the recorded ones, so the
  // next run does not ask again.
  for (const a of state.ctxAccepted) {
    for (const list of [r.steps, r.versions[r.active] && r.versions[r.active].steps]) {
      const st = list && list.find((x) => x.id === a.stepId);
      if (st && st.ctx) {
        const next = templateCtx(a.ctx, state);
        // Fields that mark the record's own data keep their mark.
        for (const [k, v] of Object.entries(st.ctx)) if (String(v).includes(DATA) && next[k] !== undefined) next[k] = v;
        st.ctx = next;
      }
    }
  }
  count(r, state, healed ? "healed" : "ok");
  if (!healed && (r.state === "draft" || (r.state === "degraded" && r.counters.last5.slice(-2).every((x) => x === "ok")))) r.state = "verified";
  if (healed && r.counters.last5.filter((x) => x === "healed").length >= 2 && r.state === "verified") r.state = "degraded";
  return r;
}

function templateCtx(ctx, state) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) out[k] = templatize(v, state.bindings);
  return out;
}

function findIn(state, ref) {
  // The element as last seen: from the log's resolution we only keep labels,
  // so look in the last snapshot.
  const snap = state.lastSnap;
  return snap ? (snap.elements || []).find((e) => e.ref === ref) || (snap.texts || []).find((e) => e.ref === ref) : null;
}

function demote(state, endState) {
  const r = structuredClone(state.recipe);
  const rolled = state.repairs.some((x) => x.status === "rolled_back");
  count(r, state, endState === "done_unproven" ? "failed" : "stopped");
  if (rolled) { r.counters.repairsRolledBack++; if (r.state === "verified") r.state = "degraded"; }
  const reason = state.end.reason;
  if (reason && r.counters.stopped[reason] !== undefined) r.counters.stopped[reason]++;
  return r;
}

function count(r, state, outcome) {
  const c = r.counters;
  c.runs++;
  if (outcome === "ok") c.replayOk++;
  if (outcome === "healed") c.repaired++;
  c.last5 = [...c.last5, outcome].slice(-5);
  for (const e of state.log) {
    const ps = c.perStep[e.id] || { exact: 0, fingerprint: 0, repaired: 0, minScore: 1, minMargin: 1, postFails: 0 };
    if (e.resolution) {
      if (e.resolution.method === "exact") ps.exact++;
      else if (e.resolution.method === "repair") ps.repaired++;
      else ps.fingerprint++;
      if (typeof e.resolution.score === "number") ps.minScore = Math.min(ps.minScore, e.resolution.score);
      if (typeof e.resolution.margin === "number") ps.minMargin = Math.min(ps.minMargin, e.resolution.margin);
    }
    if (e.status === "failed") ps.postFails++;
    c.perStep[e.id] = ps;
  }
  for (const d of state.drift) for (const a of d.attrs) c.drift[a] = (c.drift[a] || 0) + 1;
}

function nextInsertId(steps, id) {
  for (const ch of "abcdefghijklmnopqrstuvwxyz") if (!steps.some((s) => s.id === `${id}${ch}`)) return `${id}${ch}`;
  return `${id}_${steps.length}`;
}
