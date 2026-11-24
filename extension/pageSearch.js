/**
 * Select to AI - search inside a page's text the way Ctrl+F does, for the
 * engine's find step (engine.js).
 *
 * Pure functions: loaded by the service worker (importScripts) and by Node
 * via require(); both paths expose SELECT_TO_AI_PAGE.
 */
(function initPageSearch(root) {
  "use strict";

  const TOOLS =
    root.SELECT_TO_AI_TOOLS ||
    (typeof require === "function" ? require("./agentTools.js") : null);

  /** Sections from the page's own headings (# lines in Markdown). */
  function sectionsOf(text) {
    const lines = String(text || "").split("\n");
    const sections = [];
    let cur = { title: "(start of page)", level: 0, start: 0, lines: [] };
    let offset = 0;
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        sections.push(cur);
        cur = { title: m[2].trim(), level: m[1].length, start: offset, lines: [] };
      }
      cur.lines.push(line);
      offset += line.length + 1;
    }
    sections.push(cur);
    return sections
      .map((s) => ({ title: s.title, level: s.level, start: s.start, text: s.lines.join("\n").trim() }))
      .filter((s) => s.text.replace(/^#+\s+.+$/m, "").trim().length > 0 || s.level > 0);
  }

  /**
   * Search inside the page the way Ctrl+F does: exact phrase first (then the
   * query's longest distinctive words), each hit returned with the text
   * around it and the section it sits in; keyword ranking only as a fallback.
   */
  function findInText(text, query, opts) {
    const o = Object.assign({ maxHits: 5, window: 360, section: 1600, budget: 2600 }, opts || {});
    const body = String(text || "");
    const lower = body.toLowerCase();
    if (!body.trim()) return [];
    const secs = sectionsOf(body);
    const sectionAt = (i) => { let t = ""; for (const x of secs) { if (x.start <= i && x.level > 0) t = x.title; } return t; };
    const q = String(query || "").trim().toLowerCase();
    // Every word the model asked for, in any language: how much each counts is measured on the page (idf).
    const terms = [...new Set((q.match(/[\p{L}\p{N}_$.()[\]-]{3,}/gu) || []).map((w) => w.replace(/^[.(\[-]+|[.,;:!?\]-]+$/g, "")).filter((w) => w.length >= 3))];
    if (!terms.length) return [];
    // Where each term occurs, and how rare it is on this page (rare words
    // point at the answer; words used everywhere point at nothing).
    const total = Math.max(1, (lower.match(/\S+/g) || []).length);
    const occ = {};
    for (const t of terms) {
      const at = [];
      let from = 0;
      while (at.length < 400) { const k = lower.indexOf(t, from); if (k < 0) break; at.push(k); from = k + t.length; }
      if (at.length) occ[t] = { at, idf: Math.log(1 + total / at.length) };
    }
    const found = Object.keys(occ);
    const telling = terms.filter((t) => !(occ[t] && occ[t].at.length > 5 && occ[t].at.length > total / 100));
    if (!found.length) return TOOLS.relevantPassages(body, query, { max: 3, maxChars: 700 }).map((p) => `[related] ${p}`);
    const phraseAt = q.length >= 6 ? lower.indexOf(q) : -1;
    const half = Math.floor(o.window / 2);
    // Adjacent query words found together ("jury selection") are strong evidence.
    const seq = q.match(/[\p{L}\p{N}_]{3,}/gu) || [];
    const pairAt = [];
    for (let k = 0; k + 1 < seq.length; k++) {
      const pair = `${seq[k]} ${seq[k + 1]}`;
      let from = 0;
      while (pairAt.length < 200) { const x = lower.indexOf(pair, from); if (x < 0) break; pairAt.push(x); from = x + pair.length; }
    }
    const scored = [];
    for (const t of found) {
      for (const c of occ[t].at) {
        let score = 0;
        for (const u of found) if (occ[u].at.some((k) => Math.abs(k - c) <= half)) score += occ[u].idf;
        if (phraseAt >= 0 && Math.abs(phraseAt - c) <= half) score += 10;
        if (pairAt.some((x) => Math.abs(x - c) <= half)) score += 4;
        scored.push({ c, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const x of scored) {
      if (picked.length >= o.maxHits) break;
      if (picked.some((p) => Math.abs(p.c - x.c) < o.window)) continue;
      picked.push(x);
    }
    // Best first within the budget, then shown in page order.
    let used = 0;
    const kept = [];
    const starts = new Set();
    for (const p of picked) {
      if (used > o.budget) break;
      // A hit on a heading is a hit on its section: the text under it is
      // what was looked for, so it comes with the heading, up to the next
      // heading of the same or a higher level (and a bound on its length).
      // Only a heading that has every telling word looked for: one that
      // shares a word with the query ("Garden Supplies" for "Garden Hose")
      // is not it. A word used all over the page (more than once in a
      // hundred words, in whatever language) is not a telling one.
      const lineStart = body.lastIndexOf("\n", Math.max(0, p.c - 1)) + 1;
      const lineEnd = body.indexOf("\n", lineStart);
      const headingLine = lower.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
      const heading = /^#{1,6}\s/.test(headingLine) && telling.length && telling.every((t) => headingLine.includes(t)) ? secs.find((s) => s.start === lineStart && s.level > 0) : null;
      let start = Math.max(0, p.c - half, body.lastIndexOf("\n", Math.max(0, p.c - half)) + 1);
      let end = Math.min(body.length, start + o.window);
      if (heading) {
        const next = secs.find((s) => s.start > lineStart && s.level > 0 && s.level <= heading.level);
        start = lineStart;
        end = Math.min(next ? next.start : body.length, lineStart + Math.max(o.window, o.section));
      }
      // A hit inside a section already given whole adds nothing.
      if (starts.has(start) || kept.some((k) => p.c >= k.start && p.c < k.end)) continue;
      starts.add(start);
      const whole = heading && (end === body.length || /^#{1,6}\s/.test(body.slice(end, end + 7)));
      const piece = `${sectionAt(p.c) ? `[in "${sectionAt(p.c)}"] ` : ""}${start > 0 && body[start - 1] !== "\n" ? "…" : ""}${body.slice(start, end).trim()}${end < body.length && !whole ? "…" : ""}`;
      kept.push({ c: p.c, start, end, piece });
      used += piece.length;
    }
    return kept.sort((a, b) => a.c - b.c).map((k) => k.piece);
  }

  const api = Object.freeze({ sectionsOf, findInText });
  root.SELECT_TO_AI_PAGE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
