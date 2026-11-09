/**
 * Element fingerprints: build one from a recorded element, score a live
 * element against it, and resolve a step's target with a threshold and a
 * margin (design §1.3). Pure functions.
 *
 * A snapshot element (`El`) is what a driver reports for one control; see
 * index.d.ts for the shape.
 */
import { norm, textSim, jaccard, maskDigits, looksGenerated, templatize, fill, containsValue, clip, slotsOf } from "./text.js";

/** Starting weights (design §1.3.2, plus ancestors and siblings from replay-sota implication 2). */
export const WEIGHTS = Object.freeze({
  testId: 3.0,
  accName: 3.0,
  name: 2.0,
  label: 2.0,
  text: 2.0,
  column: 2.0,
  hrefPath: 2.0,
  kind: 1.5,
  group: 1.5,
  form: 1.5,
  htmlId: 1.5,
  autocomplete: 1.5,
  placeholder: 1.5,
  heading: 1.0,
  options: 1.0,
  title: 1.0,
  inputType: 1.0,
  ancestors: 1.0,
  siblings: 0.75,
  ordinal: 0.5,
  rect: 0.5,
});

/**
 * Thresholds (design §1.3.5, §10 decision 1). Starting values; calibrated on
 * dev mutations only, then frozen (docs/recipes-calibration.md).
 */
export const THRESHOLDS = Object.freeze({
  tau: 0.65,
  mu: 0.12,
  tauCommit: 0.8,
  muCommit: 0.25,
  // A control whose words are less like the recorded ones than this is not
  // taken without a model, however well its ids and place match: words
  // carry meaning ("Deactivate user" is not "Deactivate and remove").
  labelFloor: 0.5,
  // A read or edit step whose developer locator still points, uniquely, at
  // the best-scoring control of the same kind may be taken from this score.
  tauLocator: 0.5,
  // Words around a step (headings, dialog, column, help text, the text
  // beside it) that are less alike than this have changed: a model is asked
  // whether the step still means the same thing before it acts.
  driftSim: 0.85,
});

const FAMILIES = [
  new Set(["button", "link", "menuitem", "tab"]),
  new Set(["textbox", "searchbox", "combobox", "spinbutton"]),
  new Set(["checkbox", "switch", "radio", "menuitemcheckbox"]),
  new Set(["option", "menuitem", "listitem", "treeitem"]),
];

/** Kind similarity: equal 1, same family 0.5, else 0. */
export function kindSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return FAMILIES.some((f) => f.has(a) && f.has(b)) ? 0.5 : 0;
}

const TEXT_ENTRY = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox", "textarea", "date"]);
const TOGGLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

/** The label people see on a control: accessible name, else text, else aria-label. */
export function labelOf(el) {
  return el ? (el.name || el.text || el.label || el.placeholder || el.title || "") : "";
}

function hrefPathOf(href) {
  if (!href) return "";
  try {
    const u = new URL(href, "http://x.invalid");
    return u.pathname.split("/").map((s) => (/^\d+$|^[0-9a-f]{12,}$/i.test(s) ? "*" : s)).join("/");
  } catch { return ""; }
}

/**
 * Ordinal of an element among controls with the same kind and label, and
 * how many such controls there are.
 */
export function ordinalOf(el, elements) {
  const key = `${el.kind}|${norm(labelOf(el))}|${el.frame || 0}`;
  const same = elements.filter((e) => `${e.kind}|${norm(labelOf(e))}|${e.frame || 0}` === key);
  return { of: Math.max(0, same.findIndex((e) => e.ref === el.ref)), n: same.length || 1 };
}

/**
 * Build a fingerprint from a recorded element.
 * @param {object} el  snapshot element
 * @param {object} snap  the snapshot it came from
 * @param {Record<string,string>} bindings  variable values used in the run, so literals become {var} slots
 * @param {{read?: boolean}} [o]
 */
export function fingerprintOf(el, snap, bindings, o = {}) {
  const t = (v) => (v ? templatize(v, bindings) : v);
  const attrs = { kind: el.kind || "generic" };
  const put = (k, v) => { if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) attrs[k] = v; };
  put("accName", t(clip(el.name, 200)));
  put("label", t(clip(el.label, 200)));
  put("text", t(clip(el.text, 200)));
  put("placeholder", el.placeholder);
  put("title", el.title);
  put("name", el.nameAttr);
  put("htmlId", el.htmlId);
  put("testId", el.testId);
  put("autocomplete", el.autocomplete);
  put("inputType", el.inputType);
  put("hrefPath", t(hrefPathOf(el.href)));
  if (Array.isArray(el.options) && el.options.length) attrs.options = el.options.slice(0, 40).map((x) => clip(x, 60));
  put("group", t(clip(el.group, 200)));
  put("groupKind", el.groupKind);
  if (el.form) attrs.form = { action: hrefPathOf(el.form.action), search: !!el.form.search, fields: el.form.fields | 0 };
  put("heading", t(clip(el.heading, 120)));
  put("column", t(clip(el.column, 60)));
  if (Array.isArray(el.ancestors) && el.ancestors.length) attrs.ancestors = el.ancestors.slice(0, 4).map((a) => t(clip(a, 80)));
  if (Array.isArray(el.siblings) && el.siblings.length) attrs.siblings = el.siblings.slice(0, 4).map((a) => t(clip(a, 60)));
  const elements = (snap && snap.elements) || [];
  attrs.ordinal = elements.length ? ordinalOf(el, elements) : { of: 0, n: 1 };
  const vw = (snap && snap.viewport && snap.viewport.w) || 1280, vh = (snap && snap.viewport && snap.viewport.h) || 800;
  if (el.rect) attrs.rect = { x: Math.round(el.rect.x), y: Math.round(el.rect.y), w: Math.round(el.rect.w), h: Math.round(el.rect.h), vw, vh };
  attrs.frame = el.frame || 0;
  attrs.onTop = el.onTop !== false;
  if (el.sensitive) attrs.sensitive = el.sensitive;
  if (el.submits) attrs.submits = true;

  const weights = {};
  for (const k of Object.keys(WEIGHTS)) {
    if (attrs[k] === undefined) continue;
    let w = WEIGHTS[k];
    if ((k === "htmlId" || k === "testId" || k === "name") && looksGenerated(attrs[k])) w = 0;
    if (k === "ordinal" && attrs.ordinal.n <= 1) w = 0;
    weights[k] = w;
  }
  // A control picked by a variable (its label is "{name}"): its id, name,
  // test id, link and position belonged to the recorded record and will
  // differ for another value, so only the variable and the context count.
  const picked = ["accName", "label", "text"].some((k) => typeof attrs[k] === "string" && /\{[A-Za-z][A-Za-z0-9_]*\}/.test(attrs[k]));
  if (picked) {
    for (const k of ["htmlId", "name", "testId", "hrefPath", "rect", "ordinal"]) {
      if (weights[k] !== undefined && !(typeof attrs[k] === "string" && /\{[A-Za-z][A-Za-z0-9_]*\}/.test(attrs[k]))) weights[k] = 0;
    }
  }
  const fp = { attrs, weights, ambiguousAtRecord: Math.max(0, attrs.ordinal.n - 1) };
  if (o.read) {
    fp.read = true;
    // What a read step reads is the unknown: its own words are the answer,
    // not its identity. It is found by where it is (column, row, label next
    // to it, heading, test id), never by what it says.
    for (const k of ["accName", "text", "label", "title"]) if (weights[k] !== undefined) weights[k] = 0;
  }
  // A row or card chosen by variables: "the row that says {client} and {month}".
  if (el.groupKind === "item" && el.group && bindings) {
    const hits = Object.entries(bindings)
      .filter(([, v]) => v != null && String(v).trim().length >= 2 && containsValue(el.group, v))
      .map(([k]) => `{${k}}`);
    if (hits.length) fp.scope = { groupKind: "item", contains: hits.join(" ") };
  }
  return fp;
}

/**
 * Gates (design §1.3.1): a candidate that fails any is not scored.
 * @returns {string|null} the reason it fails, or null
 */
export function gate(fp, el, action, bindings) {
  const a = fp.attrs;
  if ((el.frame || 0) !== (a.frame || 0)) return "frame";
  if ((el.sensitive || "") !== (a.sensitive || "")) return "sensitive";
  if (fp.scope) {
    if (el.groupKind !== "item") return "scope";
    const slots = slotsOf(fp.scope.contains);
    const wants = slots.length ? slots.map((n) => (bindings && n in bindings ? bindings[n] : `{${n}}`)) : [fp.scope.contains];
    if (!wants.every((w) => containsValue(el.group, w))) return "scope";
  }
  if (action) {
    const d = action.do;
    if (d === "fill") {
      const v = String(fill(action.value, bindings) ?? "");
      const toggle = TOGGLES.has(el.kind);
      if (toggle) { if (!/^(on|off|true|false)$/i.test(v)) return "action"; }
      else if (!(TEXT_ENTRY.has(el.kind) || el.editable || el.tag === "select" || el.tag === "textarea" || el.tag === "input")) return "action";
      if (el.tag === "select" && Array.isArray(el.options) && el.options.length && !el.options.some((x) => norm(x) === norm(v))) {
        if (!(el.optionValues || []).some((x) => norm(x) === norm(v))) return "option";
      }
      if (el.disabled) return "disabled";
    } else if (d === "click" || d === "check" || d === "hover") {
      if (el.disabled && d !== "hover") return "disabled";
    } else if (d === "press") {
      if (el.disabled) return "disabled";
    }
  }
  return null;
}

function rectSim(r, live, viewport) {
  if (!r || !live) return 0;
  const vw = r.vw || (viewport && viewport.w) || 1280, vh = r.vh || (viewport && viewport.h) || 800;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, lx = live.x + live.w / 2, ly = live.y + live.h / 2;
  const half = Math.hypot(vw, vh) / 2;
  const d = Math.hypot(cx - lx, cy - ly);
  const pos = 1 - Math.min(1, d / half);
  const areaA = Math.max(1, r.w * r.h), areaB = Math.max(1, live.w * live.h);
  return pos * (Math.min(areaA, areaB) / Math.max(areaA, areaB));
}

function listSim(a, b, bindings, read) {
  const m = read ? maskDigits : (x) => x;
  const A = (a || []).map((x) => m(fill(x, bindings))), B = (b || []).map(m);
  if (!A.length) return 1;
  if (!B.length) return 0;
  return textSim(A.join(" | "), B.join(" | "));
}

/**
 * Score a live element against a fingerprint: Σ w·s ÷ Σ w over the
 * attributes present in the recorded fingerprint.
 * @returns {{score:number, sims:Record<string,number>}}
 */
export function score(fp, el, bindings, ctx = {}) {
  const a = fp.attrs, w = fp.weights || {};
  const f = (v) => fill(v, bindings);
  const read = !!fp.read;
  const sims = {};
  const sim = {
    testId: () => (el.testId && norm(el.testId) === norm(a.testId) ? 1 : 0),
    accName: () => (read ? textSim(maskDigits(f(a.accName)), maskDigits(el.name)) : textSim(f(a.accName), el.name)),
    name: () => (el.nameAttr && norm(el.nameAttr) === norm(f(a.name)) ? 1 : 0),
    label: () => textSim(f(a.label), el.label),
    text: () => textSim(maskDigits(f(a.text)), maskDigits(el.text)),
    hrefPath: () => {
      const want = String(f(a.hrefPath) || "").split("/"), have = hrefPathOf(el.href).split("/");
      if (!el.href) return 0;
      if (want.join("/") === have.join("/")) return 1;
      if (want.length === have.length && want.slice(0, -1).join("/") === have.slice(0, -1).join("/")) return 0.5;
      return 0;
    },
    kind: () => kindSim(a.kind, el.kind),
    group: () => textSim(read ? maskDigits(f(a.group)) : f(a.group), read ? maskDigits(el.group) : el.group),
    form: () => {
      if (!el.form) return 0;
      const ff = a.form;
      return (hrefPathOf(el.form.action) === ff.action ? 0.5 : 0) + (!!el.form.search === ff.search ? 0.25 : 0) + ((el.form.fields | 0) === ff.fields ? 0.25 : 0);
    },
    htmlId: () => (el.htmlId && el.htmlId === a.htmlId ? 1 : 0),
    autocomplete: () => (el.autocomplete && el.autocomplete === a.autocomplete ? 1 : 0),
    placeholder: () => textSim(f(a.placeholder), el.placeholder),
    heading: () => textSim(f(a.heading), el.heading),
    column: () => textSim(f(a.column), el.column),
    options: () => jaccard(a.options, el.options),
    title: () => textSim(f(a.title), el.title),
    inputType: () => (el.inputType && el.inputType === a.inputType ? 1 : 0),
    ancestors: () => listSim(a.ancestors, el.ancestors, bindings, read),
    siblings: () => listSim(a.siblings, el.siblings, bindings, read),
    ordinal: () => {
      const o = ctx.ordinal ? ctx.ordinal(el) : null;
      if (!o) return 0;
      const d = Math.abs(o.of - a.ordinal.of);
      return d === 0 ? 1 : d === 1 ? 0.5 : 0;
    },
    rect: () => rectSim(a.rect, el.rect, ctx.viewport),
  };
  let num = 0, den = 0;
  for (const [k, wk] of Object.entries(w)) {
    if (!wk || !sim[k] || a[k] === undefined) continue;
    const s = Math.max(0, Math.min(1, sim[k]()));
    sims[k] = Math.round(s * 1000) / 1000;
    num += wk * s;
    den += wk;
  }
  return { score: den ? num / den : 0, sims };
}

/** Whether the live element carries the recorded label exactly (after substitution). */
export function sameLabel(fp, el, bindings) {
  const a = fp.attrs;
  const want = [a.accName, a.text, a.label].filter(Boolean).map((x) => norm(fill(x, bindings)));
  if (!want.length) return false;
  const have = [el.name, el.text, el.label].filter(Boolean).map(norm);
  return want.some((x) => have.includes(x));
}

function sameElement(a, b) {
  return (a.frame || 0) === (b.frame || 0) && a.rect && b.rect && Math.abs(a.rect.x - b.rect.x) < 2 && Math.abs(a.rect.y - b.rect.y) < 2
    && Math.abs(a.rect.w - b.rect.w) < 2 && Math.abs(a.rect.h - b.rect.h) < 2 && norm(labelOf(a)) === norm(labelOf(b));
}

/**
 * Rank every candidate that passes the gates.
 * @returns {{el:object, score:number, sims:object}[]}
 */
export function rank(fp, elements, bindings, action, ctx = {}) {
  const list = [];
  const ordinalCache = new Map();
  const ordinal = (el) => {
    if (!ordinalCache.has(el.ref)) ordinalCache.set(el.ref, ordinalOf(el, elements));
    return ordinalCache.get(el.ref);
  };
  for (const el of elements) {
    if (gate(fp, el, action, bindings)) continue;
    const { score: s, sims } = score(fp, el, bindings, { ordinal, viewport: ctx.viewport });
    list.push({ el, score: s, sims });
  }
  // A row that says a bound value as a whole cell or line beats one that
  // merely contains it ("Home" over "Home office").
  if (fp.scope) {
    const slots = slotsOf(fp.scope.contains);
    const exact = (el) => slots.some((n) => bindings && n in bindings && String(el.group || "").split(" | ").some((seg) => norm(seg) === norm(bindings[n])));
    if (list.some((c) => exact(c.el))) for (let i = list.length - 1; i >= 0; i--) if (!exact(list[i].el)) list.splice(i, 1);
  }
  list.sort((x, y) => y.score - x.score);
  // The same element seen twice (a label and its control, a nested role) counts once.
  const out = [];
  for (const c of list) if (!out.some((o) => sameElement(o.el, c.el))) out.push(c);
  return out;
}

/**
 * Resolve a step's target on a snapshot (design §1.3.5, §3.4).
 * @param {object} step  recipe step with target and class
 * @param {object} snap  snapshot
 * @param {Record<string,string>} bindings
 * @param {object} [thresholds]
 * @returns {{ok:true, ref:string, el:object, score:number, margin:number, method:string, ranked:object[]} | {ok:false, reason:string, score:number, margin:number, ranked:object[]}}
 */
export function resolve(step, snap, bindings, thresholds = THRESHOLDS) {
  const fp = step.target;
  const pool = fp && fp.read ? [...(snap.elements || []), ...(snap.texts || [])] : (snap.elements || []);
  const ranked = rank(fp, pool, bindings, step.action, { viewport: snap.viewport });
  const best = ranked[0], second = ranked[1];
  const top = ranked.slice(0, 5).map((c) => ({ ref: c.el.ref, label: clip(labelOf(c.el), 80), kind: c.el.kind, score: round(c.score), sims: c.sims }));
  if (!best) return { ok: false, reason: "no_candidate", score: 0, margin: 0, ranked: top };
  const margin = best.score - (second ? second.score : 0);
  const commit = step.class === "commit";
  const tau = commit ? thresholds.tauCommit : thresholds.tau;
  const mu = commit ? thresholds.muCommit : thresholds.mu;
  const label = norm(labelOf(best.el));
  const exact = label && label === norm(fill(fp.attrs.accName || fp.attrs.text || fp.attrs.label || "", bindings))
    && best.el.kind === fp.attrs.kind
    && ranked.filter((c) => norm(labelOf(c.el)) === label && c.el.kind === fp.attrs.kind).length === 1;
  const res = { score: round(best.score), margin: round(margin), ranked: top };
  const loc = locatorEvidence(fp, snap, bindings, ranked);
  if (loc) res.locator = loc;
  // The developer's own locator points, uniquely, at another control of the
  // same kind than the fingerprint's choice: the two kinds of evidence
  // disagree, and a step that changes something is not taken on either.
  if (loc === "disagrees" && step.class !== "read") return { ok: false, reason: "locator_disagrees", ...res };
  const byLocator = loc === "agrees" && best.score >= (commit ? thresholds.tau : thresholds.tauLocator ?? thresholds.tau);
  if (best.score < tau && !byLocator) return { ok: false, reason: "low_score", ...res };
  if (!fp.read && thresholds.labelFloor != null) {
    const want = fill(fp.attrs.accName || fp.attrs.text || fp.attrs.label || "", bindings);
    if (want && Math.max(textSim(want, best.el.name), textSim(want, best.el.text), textSim(want, best.el.label)) < thresholds.labelFloor) return { ok: false, reason: "label_differs", ...res };
  }
  if (margin < mu) return { ok: false, reason: "ambiguous", ...res };
  if (commit && !sameLabel(fp, best.el, bindings)) return { ok: false, reason: "label_changed", ...res };
  return { ok: true, ref: best.el.ref, el: best.el, method: best.score < tau ? "locator" : exact ? "exact" : "fingerprint", ...res };
}

/**
 * What the developer's recorded locator says now (design note in
 * docs/recipes-calibration.md, fix 15): "agrees" when it resolves to exactly
 * one element and that is the best-ranked candidate, of the recorded kind;
 * "disagrees" when it resolves to exactly one other candidate of the
 * recorded kind; null when it says nothing (absent, not unique, not a
 * candidate). A locator recorded on a row chosen by a value, without that
 * value in it, named the recorded row only, so it says nothing for others.
 */
export function locatorEvidence(fp, snap, bindings, ranked) {
  if (!fp || !fp.loc || !snap || !snap.locs || !ranked.length) return null;
  if ((fp.scope || isPicked(fp)) && !slotsOf(fp.loc).length) return null;
  const probe = snap.locs[fill(fp.loc, bindings)];
  if (!probe || !probe.refs || probe.refs.length !== 1) return null;
  const hit = ranked.find((c) => c.el.ref === probe.refs[0]);
  if (!hit || hit.el.kind !== fp.attrs.kind) return null;
  return hit === ranked[0] || sameElement(hit.el, ranked[0].el) ? "agrees" : "disagrees";
}

function isPicked(fp) {
  return ["accName", "label", "text"].some((k) => typeof fp.attrs[k] === "string" && /\{[A-Za-z][A-Za-z0-9_]*\}/.test(fp.attrs[k]));
}

/** Which recorded attributes did not match on a live element (s < 1). */
export function driftOf(fp, el, bindings) {
  const { sims } = score(fp, el, bindings, {});
  return Object.entries(sims).filter(([k, s]) => s < 1 && k !== "rect" && k !== "ordinal").map(([k]) => k);
}

/**
 * Stability learning (design §1.3.4): after a passing replay, every
 * attribute of a resolved target that changed has its weight halved (floor
 * a quarter of the start weight); every one that held is raised 10% (cap
 * the start weight). Returns new weights.
 */
export function learnWeights(fp, el, bindings) {
  const changed = new Set(driftOf(fp, el, bindings));
  const out = { ...fp.weights };
  for (const [k, w] of Object.entries(out)) {
    const base = WEIGHTS[k];
    if (!base || !w) continue;
    out[k] = changed.has(k) ? Math.max(base * 0.25, w * 0.5) : Math.min(base, w * 1.1);
    out[k] = Math.round(out[k] * 1000) / 1000;
  }
  return out;
}

/** A fingerprint in words, for receipts and the repair model. */
export function describeFingerprint(fp, bindings) {
  const a = fp.attrs;
  const parts = [fp.read ? "the value" : `${a.kind || "control"}`];
  // A read step's own words were the recorded answer, not its identity.
  const label = fp.read ? "" : fill(a.accName || a.text || a.label || a.placeholder || "", bindings);
  if (label) parts.push(`"${clip(label, 80)}"`);
  // A row chosen by a variable is described by that value only: the rest of
  // the row's text was the recorded row's data and differs for other values.
  if (a.group && !fp.scope) parts.push(`in ${a.groupKind || "group"} "${clip(fill(a.group, bindings), 80)}"`);
  if (a.column) parts.push(`in table column "${clip(fill(a.column, bindings), 40)}"`);
  if (a.heading) parts.push(`under heading "${clip(fill(a.heading, bindings), 60)}"`);
  if (a.form) parts.push(`in a ${a.form.search ? "search " : ""}form (${a.form.action || "same page"}, ${a.form.fields} fields)`);
  if (a.testId) parts.push(`test id "${a.testId}"`);
  if (a.name) parts.push(`name="${a.name}"`);
  if (a.rect) parts.push(`at about (${a.rect.x}, ${a.rect.y})`);
  if (fp.scope) parts.push(`in the row that says ${slotsOf(fp.scope.contains).map((n) => `"${fill(`{${n}}`, bindings)}"`).join(" and ")}`);
  return parts.join(" ");
}

function round(x) { return Math.round(x * 1000) / 1000; }
