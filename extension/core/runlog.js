/**
 * Select to AI - a run as a readable Markdown log, for "Save log".
 *
 * Built from what the panel already holds: the run's trace (core/run.js
 * trace) and its journal entries. Both are what the engine shows the user,
 * so values the engine masks (secret fields, details typed from file) are
 * masked here too: nothing is read from anywhere else.
 */
(function initRunLog(root) {
  "use strict";

  const oneLine = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  // Markdown that would break a list line is escaped; the rest stays as written.
  const safe = (t) => oneLine(t).replace(/([`|])/g, "\\$1");
  const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
  const ENDS = { success: "Done", unconfirmed: "Answered, not confirmed", error: "Stopped with a problem", limit: "Usage limit reached", idle: "Stopped" };
  const PURPOSE = { step: "step", verify: "answer check", opinion: "second opinion", addressed: "hidden text" };

  /** The time of an entry from the start of the run, as "+12.3 s", or "". */
  function stamp(at, start) {
    return at && start && at >= start ? `+${secs(at - start)}` : "";
  }

  /**
   * @param o {trace, journal}
   * @returns the log as Markdown
   */
  function toMarkdown(o) {
    const trace = (o && o.trace) || {};
    const journal = (o && o.journal) || [];
    const start = (journal.find((e) => e.at) || {}).at || 0;
    const out = [];
    out.push("# Select to AI - task log", "");
    out.push(`**Request:** ${oneLine(trace.task)}`);
    const answer = [...journal].reverse().find((e) => e.k === "answer");
    if (answer) out.push(`**Ended:** ${ENDS[answer.state] || answer.state}${answer.verified === true ? ", checked" : answer.verified === false ? ", not confirmed" : ""}`);
    else out.push(`**Ended:** not yet${trace.waitingForUser ? " (waiting for the user)" : trace.running ? " (still working)" : ""}`);
    const facts = [`${trace.steps || 0} step${trace.steps === 1 ? "" : "s"}`];
    if (trace.helperSteps) facts.push(`${trace.helperSteps} by the helper`);
    if (trace.activeMs) facts.push(`${secs(trace.activeMs)} working`);
    if (trace.firstAnswerMs) facts.push(`first answer shown after ${secs(trace.firstAnswerMs)}`);
    if (trace.endedMs) facts.push(`ended after ${secs(trace.endedMs)}`);
    out.push(`**Run:** ${facts.join(", ")}`);
    if (trace.timing) {
      const t = trace.timing;
      out.push(`**Time spent:** model ${secs(t.model || 0)}, reading pages ${secs(t.observe || 0)}, acting ${secs(t.act || 0)} (of which waiting for pages to settle ${secs(t.settle || 0)})`);
    }
    out.push(`**Model calls:** ${trace.calls || 0}${(trace.models || []).length ? ` on ${trace.models.join(", ")}` : ""}; tokens ${(trace.tokens && trace.tokens.prompt) || 0} in, ${(trace.tokens && trace.tokens.completion) || 0} out${trace.costUSD ? `; cost $${Number(trace.costUSD).toFixed(4)}` : ""}`);
    out.push("");

    // The run as it happened, entry by entry.
    out.push("## What happened", "");
    for (const e of journal) {
      const when = stamp(e.at, start);
      const at = when ? ` _(${when})_` : "";
      const sub = e.sub ? `[sub-task ${String(e.sub).split("-").pop()}] ` : "";
      if (e.k === "log") {
        const step = /^Step (\d+)$/.exec(e.title || "");
        if (step && e.role === "executor" && !e.sub) {
          out.push("", `### Step ${step[1]}${at}`, "", `- Goal: ${safe(e.text)}`);
          continue;
        }
        if (e.role === "executor" && e.title === "Action") { out.push(`- ${sub}Action: \`${oneLine(e.text).replace(/`/g, "'")}\``); continue; }
        if (e.role === "executor" && e.title === "Result") { out.push(`  - ${sub}Result: ${safe(e.text)}`); continue; }
        if (e.title === "Action Failed") { out.push(`  - ${sub}Failed: ${safe(e.text)}`); continue; }
        const role = e.role === "validator" ? "Check" : e.role === "error" ? "Problem" : "Note";
        out.push(`- ${sub}${role}: **${safe(e.title)}**${e.text ? `: ${safe(e.text)}` : ""}${at}${e.quiet ? " (not shown in the timeline)" : ""}`);
        continue;
      }
      if (e.k === "status") continue;
      if (e.k === "ask") {
        const w = e.wait || {};
        out.push(`- ${sub}Asked the user (${safe(w.kind)}${w.risk ? `, ${safe(w.risk)}` : ""}): ${safe(w.question)}${at}`);
        for (const d of w.detail || []) out.push(`  - ${safe(d)}`);
        continue;
      }
      if (e.k === "ask_done") { out.push(`- ${sub}The user's reply: ${safe({ approved: "allowed", declined: "declined", answered: "answered", user_done: "done", done: "done", cleared: "cleared", skipped: "skipped", pause_over: "the wait ended", keep_going: "keep going", wrap_up: "answer now" }[e.how] || e.how)}${at}`); continue; }
      if (e.k === "user") { out.push(`- The user said: ${safe(e.text)}${at}`); continue; }
      if (e.k === "note") { out.push(`- Note: ${safe(e.text)}${at}`); continue; }
      if (e.k === "memory") { out.push(`- Remembered: ${safe(e.text)}${at}`); continue; }
      if (e.k === "subtasks") { out.push(`- Handed out ${(e.tasks || []).length} sub-tasks${at}:`); for (const t of e.tasks || []) out.push(`  - ${safe(t.task)}${t.url ? ` (${safe(t.url)})` : ""}`); continue; }
      if (e.k === "sub") { out.push(`- Sub-task ${String(e.id).split("-").pop()} ${e.state === "ended" ? `ended: ${safe(e.outcome)}${e.text ? `: ${safe(e.text)}` : ""}` : "started"}${at}`); continue; }
      if (e.k === "provisional") { out.push(`- Answer shown while being checked (check ${e.round || 1})${at}:`, "", quoteBlock(e.text), ""); continue; }
      if (e.k === "provisional_replaced") { out.push(`- That answer was sent back${e.why ? `: ${safe(e.why)}` : ""}${at}`); continue; }
      if (e.k === "offer") { out.push(`- Offered to remember: ${(e.items || []).map((x) => safe(x.text || x.key || "")).join("; ")}`); continue; }
    }
    out.push("");

    out.push("## Final answer", "");
    if (answer) {
      out.push(`How it ended: ${ENDS[answer.state] || answer.state}${answer.verified === true ? " (the check passed)" : answer.verified === false ? " (not confirmed)" : answer.state === "success" ? " (not double-checked)" : ""}.`, "");
      out.push(quoteBlock(answer.text), "");
      if (answer.note) out.push(`Note: ${safe(answer.note)}`, "");
      if ((answer.sources || []).length) out.push(`Pages used: ${answer.sources.map((s) => s.url).join(", ")}`, "");
    } else out.push("(none yet)", "");

    const calls = trace.modelCalls || [];
    if (calls.length) {
      out.push("## Model calls", "", "| # | Step | For | By | Model | Time | Tokens in | Tokens out | Result |", "|---|---|---|---|---|---|---|---|---|");
      calls.forEach((c, i) => out.push(`| ${i + 1} | ${c.step || ""} | ${PURPOSE[c.purpose] || safe(c.purpose)} | ${safe(c.by)} | ${safe(c.model)} | ${c.ms ? secs(c.ms) : ""} | ${c.prompt || 0} | ${c.completion || 0} | ${c.ok ? "ok" : `failed (${safe(c.failed)})`} |`));
      out.push("");
    }

    const history = trace.history || [];
    if (history.length) {
      out.push("## Actions", "", "| Step | Taken by | Goal | Action | Page | Result |", "|---|---|---|---|---|---|");
      for (const h of history) out.push(`| ${h.sub ? `${String(h.sub).split("-").pop()}.` : ""}${h.step} | ${safe(h.by || "main")} | ${safe(h.goal)} | ${safe(h.action)} | ${safe(h.url)} | ${h.ok ? "ok" : "FAILED"}: ${safe(h.outcome)} |`);
      out.push("");
    }
    return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function quoteBlock(text) {
    return String(text || "").split("\n").map((l) => `> ${l}`).join("\n");
  }

  const api = Object.freeze({ toMarkdown });
  root.SELECT_TO_AI_RUNLOG = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
