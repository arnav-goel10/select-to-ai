/**
 * Postconditions: evaluate predicates on a snapshot, and derive a step's
 * postcondition from its before and after snapshots, keeping only checks
 * that were false before and true after (design §2.2). Pure functions.
 */
import { norm, wordsOf, templatize, fill, looksVolatile, clip, containsValue, slotsOf } from "./text.js";
import { urlPattern, urlMatches, patternText } from "./url.js";
import { fingerprintOf, rank, labelOf, THRESHOLDS } from "./fingerprint.js";

/** Lines of visible text, trimmed, non-empty. */
export function linesOf(text) {
  return String(text || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function findEl(snap, ref) {
  return (snap.elements || []).find((e) => e.ref === ref) || (snap.texts || []).find((e) => e.ref === ref) || null;
}

/** A control's current value as a comparable string. */
export function valueOf(el) {
  if (!el) return null;
  if (el.checked === true || el.checked === false) return el.checked ? "on" : "off";
  if (el.tag === "select") return el.selectedText != null ? el.selectedText : el.value;
  return el.value == null ? "" : String(el.value);
}

function valueEquals(el, want) {
  if (!el) return false;
  if (el.sensitive) return !!el.filled && String(want) !== "";
  const have = valueOf(el);
  const w = String(want);
  if (el.checked === true || el.checked === false) {
    const on = /^(on|true|checked|yes)$/i.test(w);
    return el.checked === on;
  }
  if (norm(have) === norm(w)) return true;
  if (el.tag === "select" && el.value != null && norm(el.value) === norm(w)) return true;
  const a = Number(have), b = Number(w);
  if (have !== "" && w !== "" && Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return false;
}

/**
 * Evaluate one predicate.
 * @param {object} pred
 * @param {object} snap
 * @param {Record<string,string>} bindings
 * @param {{before?:object, ref?:string, refs?:Record<string,string>, steps?:object[], downloads?:object[], since?:number, thresholds?:object}} ctx
 * @returns {{held:boolean, observed:string}}
 */
export function evaluate(pred, snap, bindings, ctx = {}) {
  const th = ctx.thresholds || THRESHOLDS;
  switch (pred.k) {
    case "url": {
      const held = urlMatches(pred.match, snap.url, bindings);
      return { held, observed: snap.url };
    }
    case "page": {
      // The address as recorded, or, when the site moved the page (a
      // redirect, a new path, a changed query), the same site showing the
      // page's own heading.
      if (urlMatches(pred.match, snap.url, bindings)) return { held: true, observed: snap.url };
      // Where the step went relative to where it started (the same page with
      // a new query, or one level down into a record): checked against the
      // page the step started on, so a moved section still counts.
      if (pred.rel && ctx.before && ctx.before.url) {
        try {
          const b = new URL(ctx.before.url).pathname.split("/");
          if (b.length - pred.rel.up >= 2) {
            const path = [...b.slice(0, b.length - pred.rel.up), ...pred.rel.tail].join("/") || "/";
            if (urlMatches({ origin: pred.match.origin, path, query: pred.match.query }, snap.url, bindings)) return { held: true, observed: `${snap.url} (as recorded, from the page the step started on)` };
          }
        } catch { /* no before page */ }
      }
      if (pred.heading && sameOrigin(pred.match, snap.url)) {
        const want = norm(fill(pred.heading, bindings));
        const hit = (snap.outline || []).some((h) => norm(h) === want);
        if (hit) return { held: true, observed: `${snap.url} (heading "${clip(fill(pred.heading, bindings), 60)}")` };
      }
      return { held: false, observed: snap.url };
    }
    case "title": {
      const have = new Set(wordsOf(snap.title));
      const held = (pred.words || []).every((w) => have.has(norm(fill(w, bindings))));
      return { held, observed: snap.title };
    }
    case "appears": {
      const best = rank(pred.target, snap.elements || [], bindings, null, { viewport: snap.viewport })[0];
      const min = pred.minScore || th.tau;
      return { held: !!best && best.score >= min, observed: best ? `${clip(labelOf(best.el), 60)} (${best.score.toFixed(2)})` : "nothing like it" };
    }
    case "gone": {
      const best = rank(pred.target, snap.elements || [], bindings, null, { viewport: snap.viewport })[0];
      const min = pred.minScore || th.tau;
      return { held: !best || best.score < min, observed: best ? `${clip(labelOf(best.el), 60)} (${best.score.toFixed(2)})` : "gone" };
    }
    case "value": {
      const ref = pred.of === "target" ? ctx.ref : (ctx.refs || {})[pred.of];
      let el = ref ? findEl(snap, ref) : null;
      if (!el && pred.of === "target" && ctx.target) {
        const best = rank(ctx.target, snap.elements || [], bindings, null, { viewport: snap.viewport })[0];
        if (best && best.score >= th.tau) el = best.el;
      }
      if (!el && pred.of !== "target" && ctx.steps) {
        const s = ctx.steps.find((x) => x.id === pred.of);
        if (s && s.target) {
          const best = rank(s.target, snap.elements || [], bindings, null, { viewport: snap.viewport })[0];
          if (best && best.score >= th.tau) el = best.el;
        }
      }
      const want = fill(pred.equals, bindings);
      return { held: valueEquals(el, want), observed: el ? String(valueOf(el)) : "control not found" };
    }
    case "text": {
      const want = norm(fill(pred.contains, bindings));
      const hay = norm(snap.text);
      return { held: !!want && hay.includes(want), observed: hay.includes(want) ? clip(fill(pred.contains, bindings), 80) : "not on the page" };
    }
    case "download": {
      const since = ctx.since || 0;
      const dl = (ctx.downloads || []).filter((d) => (d.at || 0) >= since);
      const ext = pred.ext ? norm(pred.ext) : "";
      const hit = dl.find((d) => !ext || norm(d.name).endsWith(ext));
      return { held: !!hit, observed: hit ? `${hit.name} (${hit.bytes} bytes)` : "no download" };
    }
    case "changed": {
      const b = ctx.before;
      const held = !b || b.url !== snap.url || b.title !== snap.title || norm(b.text) !== norm(snap.text) || signature(b) !== signature(snap);
      return { held, observed: held ? "the page changed" : "the page did not change" };
    }
    default:
      return { held: false, observed: `unknown check ${pred.k}` };
  }
}

function sameOrigin(match, href) {
  try { return !match.origin || new URL(href).origin === match.origin; } catch { return false; }
}

/**
 * The heading that names a page reached by a step: the first top heading
 * that is new, carries no data (digits) unless a variable put it there.
 */
function landmarkOf(before, after, bindings) {
  const old = new Set(((before && before.outline) || []).map(norm));
  for (const h of (after.outline || []).slice(0, 3)) {
    if (!h || old.has(norm(h)) || h.length > 80) continue;
    const t = templatize(h, bindings);
    if (/\d/.test(t.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ""))) continue;
    return t;
  }
  return null;
}

/**
 * The after-path relative to the before-path: how many trailing segments
 * of the before-path to drop (they share at least one leading real
 * segment), and the after pattern's segments to add.
 */
function relOf(beforeUrl, p) {
  let b;
  try { b = new URL(beforeUrl).pathname.split("/"); } catch { return null; }
  const a = String(p.path).split("/");
  let keep = 0;
  while (keep < b.length && keep < a.length && a[keep] === b[keep]) keep++;
  if (keep < 2 || (keep === 2 && !a[1])) return null;
  return { up: b.length - keep, tail: a.slice(keep) };
}

function signature(snap) {
  return (snap.elements || []).map((e) => `${e.kind}:${norm(labelOf(e))}:${valueOf(e)}`).join("|");
}

/** Evaluate every predicate; all must hold. */
export function evaluateAll(preds, snap, bindings, ctx) {
  const results = (preds || []).map((p) => ({ pred: p, ...evaluate(p, snap, bindings, ctx) }));
  return { held: results.every((r) => r.held), results };
}

/** A predicate in words. */
export function describePredicate(p, bindings) {
  switch (p.k) {
    case "url": return `the address is ${patternText({ ...p.match, path: fill(p.match.path, bindings) })}`;
    case "page": return `the address is ${patternText({ ...p.match, path: fill(p.match.path, bindings) })}${p.heading ? `, or the same site shows the heading "${clip(fill(p.heading, bindings), 60)}"` : ""}`;
    case "title": return `the title has the words ${p.words.map((w) => `"${fill(w, bindings)}"`).join(", ")}`;
    case "appears": return `a ${p.target.attrs.kind} "${clip(fill(labelOf({ name: p.target.attrs.accName, text: p.target.attrs.text, label: p.target.attrs.label }), bindings), 60)}" is shown`;
    case "gone": return `the ${p.target.attrs.kind} "${clip(fill(labelOf({ name: p.target.attrs.accName, text: p.target.attrs.text, label: p.target.attrs.label }), bindings), 60)}" is gone`;
    case "value": return `${p.of === "target" ? "the control" : `the control from step ${p.of}`} holds "${fill(p.equals, bindings)}"`;
    case "text": return `the page shows "${clip(fill(p.contains, bindings), 80)}"`;
    case "download": return `a file${p.ext ? ` (${p.ext})` : ""} was downloaded`;
    case "changed": return "the page changed";
    default: return p.k;
  }
}

const RANK = { value: 0, download: 0, url: 1, page: 1, appears: 2, gone: 3, textVar: 4, title: 5, text: 6, changed: 9 };

function rankOf(p) {
  if (p.k === "text") return slotsOf(p.contains).length ? RANK.textVar : RANK.text;
  return RANK[p.k] ?? 8;
}

function keyOf(e) {
  return `${e.kind}|${norm(labelOf(e))}|${norm(e.group)}`;
}

/**
 * Propose and keep postcondition predicates from a step's before and after
 * snapshots (design §2.2).
 * @param {{action:object, ref?:string, el?:object}} step  what was done; el is the target as it was before
 * @param {object} before
 * @param {object} after
 * @param {Record<string,string>} bindings
 * @param {{downloads?:object[], since?:number, max?:number}} [ctx]
 * @returns {{all:object[], strength:"strong"|"weak"}}
 */
export function derivePost(step, before, after, bindings, ctx = {}) {
  const max = ctx.max || 3;
  const cands = [];
  const a = step.action || {};

  if (a.do === "fill" && step.ref) {
    cands.push({ k: "value", of: "target", equals: a.value });
  }
  if (a.do === "download" || (ctx.downloads || []).some((d) => (d.at || 0) >= (ctx.since || 0))) {
    const d = (ctx.downloads || []).filter((x) => (x.at || 0) >= (ctx.since || 0)).pop();
    if (d) {
      const m = /\.([a-z0-9]{1,8})$/i.exec(d.name || "");
      cands.push({ k: "download", ...(m ? { ext: `.${m[1].toLowerCase()}` } : {}) });
    }
  }
  if (before.url !== after.url) {
    const p = urlPattern(after.url, bindings);
    const heading = landmarkOf(before, after, bindings);
    const rel = p ? relOf(before.url, p) : null;
    if (p) cands.push({ k: "page", match: p, ...(heading ? { heading } : {}), ...(rel ? { rel } : {}) });
  }
  // Controls that appeared.
  const beforeKeys = new Set((before.elements || []).map(keyOf));
  const withVar = (e) => Object.values(bindings || {}).some((v) => containsValue(labelOf(e), v) || containsValue(e.group, v));
  // A control inside a list item belongs to that item's data; it proves
  // something only when the item is the one a variable chose.
  const appeared = (after.elements || []).filter((e) => !beforeKeys.has(keyOf(e)) && labelOf(e) && !looksVolatile(labelOf(e)) && (e.groupKind !== "item" || withVar(e)));
  appeared.sort((x, y) => (withVar(y) - withVar(x)) || ((y.groupKind === "dialog") - (x.groupKind === "dialog")));
  for (const e of appeared.slice(0, 1)) {
    const fp = fingerprintOf(e, after, bindings);
    cands.push({ k: "appears", target: fp, minScore: THRESHOLDS.tau });
  }
  // The target, or a dialog, that went away.
  const afterKeys = new Set((after.elements || []).map(keyOf));
  const gone = [];
  if (step.el && !afterKeys.has(keyOf(step.el)) && a.do !== "fill") gone.push(step.el);
  for (const e of before.elements || []) if (e.groupKind === "dialog" && !afterKeys.has(keyOf(e)) && labelOf(e)) gone.push(e);
  for (const e of gone.slice(0, 1)) cands.push({ k: "gone", target: fingerprintOf(e, before, bindings), minScore: THRESHOLDS.tau });
  // New lines of text.
  const old = new Set(linesOf(before.text).map(norm));
  const fresh = linesOf(after.text).filter((l) => !old.has(norm(l)) && l.length <= 120);
  const varLines = [], staticLines = [];
  for (const l of fresh) {
    const t = templatize(l, bindings);
    // A new line that shows a bound value proves the value is on the page;
    // the rest of the line is often other data (a row's stock, a date), so
    // only the value itself is checked.
    if (t !== l) { for (const sl of slotsOf(t)) if (!varLines.includes(`{${sl}}`)) varLines.push(`{${sl}}`); }
    // A fixed phrase only: numbers in a line are data unless a variable put them there.
    // A fixed phrase the page announces (a status or alert message). Other
    // new lines are the site's data, which differs for other values.
    else if (!/\d/.test(l) && wordsOf(l).length >= 1 && l.length >= 3 && l.length <= 60 && (after.notices || []).some((n) => norm(n).includes(norm(l)))) staticLines.push(l);
  }
  for (const t of varLines.slice(0, 2)) cands.push({ k: "text", contains: t, where: "visible" });
  for (const t of staticLines.slice(0, 2)) cands.push({ k: "text", contains: t, where: "visible" });
  // A new title is kept only as the variable it shows: other new title
  // words are usually the record's own data (a person's name).
  if (before.title !== after.title) {
    const t = templatize(after.title, bindings);
    const slotWords = (t.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) || []).filter((x) => !before.title.includes(fill(x, bindings)));
    if (slotWords.length) cands.push({ k: "text", contains: slotWords[0], where: "page" });
  }

  // Keep only discriminating predicates: false before, true after.
  const ctxBefore = { ref: step.ref, target: ctx.target, downloads: [], since: ctx.since };
  const ctxAfter = { ref: step.ref, target: ctx.target, downloads: ctx.downloads, since: ctx.since };
  const kept = [];
  const seen = new Set();
  for (const p of cands.sort((x, y) => rankOf(x) - rankOf(y))) {
    const sig = JSON.stringify(p.k === "appears" || p.k === "gone" ? [p.k, p.target.attrs.kind, p.target.attrs.accName, p.target.attrs.text] : p);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const was = p.k === "value" ? valueEqualsBefore(step, before, bindings, p) : evaluate(p, before, bindings, ctxBefore).held;
    const now = evaluate(p, after, bindings, ctxAfter).held;
    if (!was && now) kept.push(p);
    if (kept.length >= max) break;
  }
  // Opening an address is proven by the address: page text on arrival is
  // the site's content, not the step's effect.
  if ((a.do === "navigate" || a.do === "back") && kept.some((p) => p.k === "page")) return { all: kept.filter((p) => p.k === "page"), strength: "strong" };
  if (!kept.length) return { all: [{ k: "changed" }], strength: "weak" };
  return { all: kept, strength: "strong" };
}

function valueEqualsBefore(step, before, bindings, p) {
  const el = (before.elements || []).find((e) => e.ref === step.ref);
  return el ? valueEquals(el, fill(p.equals, bindings)) : false;
}
