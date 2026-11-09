/**
 * Text helpers shared by the core: normalisation, word similarity that works
 * in any script, templates with {var} slots, and structural tests on values
 * (machine-made ids, volatile tokens). Pure functions.
 */

/** Lower case, whitespace collapsed, trimmed. */
export function norm(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Clip to n characters with an ellipsis. */
export function clip(text, n) {
  const v = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Word tokens of a text. Letters and digits in any script; scripts written
 * without spaces are split into character bigrams so similarity still works.
 * @param {string} text
 * @returns {string[]}
 */
export function wordsOf(text) {
  const raw = String(text == null ? "" : text).toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .match(/[\p{L}\p{N}]+(?:[.'][\p{L}\p{N}]+)*/gu) || [];
  const out = [];
  for (const w of raw) {
    if (CJK.test(w) && w.length > 2) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else out.push(w);
  }
  return out;
}

/**
 * Similarity of two texts in [0,1]: 1 when equal after normalisation, else
 * the Dice coefficient over their word multisets.
 */
export function textSim(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = wordsOf(na), wb = wordsOf(nb);
  if (!wa.length || !wb.length) return 0;
  const counts = new Map();
  for (const w of wa) counts.set(w, (counts.get(w) || 0) + 1);
  let common = 0;
  for (const w of wb) {
    const c = counts.get(w) || 0;
    if (c > 0) { common++; counts.set(w, c - 1); }
  }
  return (2 * common) / (wa.length + wb.length);
}

/** Jaccard similarity of two lists of strings, normalised. */
export function jaccard(a, b) {
  const sa = new Set((a || []).map(norm)), sb = new Set((b || []).map(norm));
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

/**
 * Every number replaced by "0" (a run of digits with its separators), so
 * "$987.25" and "$2,310.00" compare equal: the shape, not the value.
 */
export function maskDigits(text) {
  return String(text == null ? "" : text).replace(/\d(?:[\d,.]*\d)?/g, "0");
}

/**
 * Whether an id-like value looks machine-made: at least 30% digits, a hex run
 * of 8 or more, or a framework marker such as ":r1:" or "ember123". A
 * structural test on the value, not a list of sites.
 */
export function looksGenerated(value) {
  const v = String(value == null ? "" : value);
  if (!v) return false;
  const digits = (v.match(/\d/g) || []).length;
  if (v.length >= 3 && digits / v.length >= 0.3) return true;
  if (/[0-9a-f]{8,}/i.test(v) && /\d/.test(v)) return true;
  if (/^:r[0-9a-z]+:$/i.test(v) || /^[a-z]+-?\d{2,}$/i.test(v)) return true;
  if (/(^|[-_])[a-z0-9]{5,}[-_][a-z0-9]{4,}$/i.test(v) && digits >= 2) return true;
  return false;
}

/**
 * Whether a text holds something that changes by itself between runs: a
 * time, a date, a long number, or a random-looking token.
 */
export function looksVolatile(text) {
  const v = String(text == null ? "" : text);
  if (/\b\d{1,2}:\d{2}\b/.test(v)) return true;
  if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(v)) return true;
  if (/\d{4,}/.test(v)) return true;
  if (/[0-9a-f]{10,}/i.test(v)) return true;
  if (/\b(ago|just now)\b/i.test(v)) return true;
  return false;
}

/** The {name} slots used in a template. */
export function slotsOf(template) {
  const out = [];
  String(template == null ? "" : template).replace(/\{([A-Za-z][A-Za-z0-9_]{0,31})\}/g, (_, n) => { out.push(n); return ""; });
  return out;
}

/**
 * Fill a template's {name} slots from bindings. Unknown slots stay as they
 * are, so a literal brace in page text is never lost.
 */
export function fill(template, bindings) {
  if (template == null) return template;
  return String(template).replace(/\{([A-Za-z][A-Za-z0-9_]{0,31})\}/g, (m, n) => (bindings && Object.prototype.hasOwnProperty.call(bindings, n) ? String(bindings[n]) : m));
}

/**
 * Replace occurrences of bound values in a literal text with their {name}
 * slots. Longer values first so "TX-1042-B" is not split by "TX-1042".
 * Values shorter than 2 characters are never templated.
 */
export function templatize(text, bindings) {
  if (text == null) return text;
  let out = String(text);
  const entries = Object.entries(bindings || {})
    .filter(([, v]) => v != null && String(v).trim().length >= 2)
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [name, value] of entries) {
    const v = String(value);
    // Only at token boundaries, so "40" in "40mm" or "TX-1" in "TX-10" stays.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, `{${name}}`);
  }
  return out;
}

/** Whether a text contains a bound value (case-insensitive). */
export function containsValue(text, value) {
  if (value == null || String(value).trim() === "") return false;
  const v = norm(value);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, "u").test(norm(text));
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** snake_case name from a label, for a variable inferred from a control. */
export function snakeName(label, taken) {
  let base = wordsOf(label).slice(0, 4).join("_").replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "");
  if (!base) base = "value";
  base = base.slice(0, 28);
  let name = base, i = 2;
  while (taken && taken.has(name)) name = `${base}_${i++}`;
  return name;
}
