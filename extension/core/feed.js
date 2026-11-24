/**
 * Select to AI: what the engine sends the agent page as a run goes, in parts.
 *
 * A reply being written is sent as the text added since the last part, and
 * the run's trace as the fields that changed since the last batch, with the
 * history from the first entry that changed. The page joins them back. A
 * long answer is therefore never cut, and a long run is not sent whole on
 * every batch.
 */
(function (root) {
  "use strict";

  /** The part of `text` to send when the page has `shown`: {at, text}. */
  function streamPart(shown, text) {
    const was = String(shown || "");
    const now = String(text || "");
    if (was && now.length >= was.length && now.startsWith(was)) return { at: was.length, text: now.slice(was.length) };
    return { at: 0, text: now };
  }

  /** The page's text after a part, or null when the part does not follow on from it. */
  function joinStream(had, part) {
    const p = part || {};
    const text = String(p.text || "");
    if (!p.at) return text;
    const was = String(had || "");
    return p.at === was.length ? was + text : null;
  }

  /**
   * What changed from trace `was` to trace `now`: the changed fields, and
   * the history as {from, items} when it changed. Null when nothing did.
   */
  function traceDelta(was, now) {
    const out = {};
    let any = false;
    for (const key of Object.keys(now || {})) {
      if (key === "history") continue;
      if (JSON.stringify(now[key]) !== JSON.stringify(was ? was[key] : undefined)) { out[key] = now[key]; any = true; }
    }
    const gone = Object.keys(was || {}).filter((k) => k !== "history" && !(k in (now || {})));
    if (gone.length) { out.gone = gone; any = true; }
    const before = (was && was.history) || [];
    const after = (now && now.history) || [];
    let from = 0;
    while (from < before.length && from < after.length && JSON.stringify(before[from]) === JSON.stringify(after[from])) from++;
    if (from < after.length || before.length !== after.length) { out.history = { from, items: after.slice(from) }; any = true; }
    return any ? out : null;
  }

  /** The trace after applying `delta` to `was`. */
  function applyTrace(was, delta) {
    if (!delta) return was;
    const next = { ...(was || {}) };
    for (const [key, value] of Object.entries(delta)) {
      if (key === "history" || key === "gone") continue;
      next[key] = value;
    }
    for (const key of delta.gone || []) delete next[key];
    if (delta.history) next.history = [...((was && was.history) || []).slice(0, delta.history.from), ...delta.history.items];
    return next;
  }

  const api = Object.freeze({ streamPart, joinStream, traceDelta, applyTrace });
  root.SELECT_TO_AI_FEED = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
