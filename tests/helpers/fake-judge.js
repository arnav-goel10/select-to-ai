"use strict";
// Test-only. A stand-in for the model that answers the page-blind press
// check (agentTools.js labelsMessages): it reads the numbered entries out
// of the request, as a model would, and answers each from `says`, a
// function from an entry to "pays", "sends", "deletes", "decides",
// "unsure" or null (stays within the visit), each answered as the
// reaches and undo a model would give for it (EFFECT). The default reads English names the
// way a model would for these fixtures. It is a fixture, not the
// extension's decision: the extension sends the question and reads the
// reply, and nothing in it holds a list of words.

const T = require("../../extension/agentTools.js");

const ACTS = [
  ["pays", /\b(pay|buy|purchase|checkout|check out|place (?:your |my )?order|order now|complete (?:purchase|order|booking)|confirm and pay|book|reserve|subscribe|donate|start (?:free )?trial|kaufen|bestellen|購入)/i],
  ["deletes", /\b(delete|remove|erase|unsubscribe|deactivate|discard|cancel (?:my |the |your )?(?:order|subscription|booking|account|plan)|empty (?:trash|cart)|löschen|supprimer|削除)/i],
  ["sends", /\b(send|submit|post|publish|sign up|create (?:an |my )?account|register|transfer|withdraw|invite|apply now|senden|envoyer|enviar|送信)/i],
  ["decides", /\b(leave (?:team|group)|join|close (?:my )?account|make public|accept invitation|reject application)/i],
];

/** What the stand-in says of one entry by default. */
function readsAs(entry) {
  const names = (entry.names || []).join(" | ");
  for (const [does, re] of ACTS) if (re.test(names)) return does;
  return null;
}

/** The entries a press-check request lists, read back from its text. */
function entriesOf(user) {
  const out = [];
  for (const line of String(user || "").split("\n")) {
    const m = /^(\d+)\. (\{.*\})$/.exec(line);
    if (m) out.push(JSON.parse(m[2]));
  }
  return out;
}

// What a model would answer, in the check's two fields, for each verdict
// the stand-in reads: where the effect lands and whether it can be put back.
const EFFECT = Object.freeze({
  pays: { reaches: "money", undo: "no" },
  sends: { reaches: "other_people", undo: "no" },
  decides: { reaches: "other_people", undo: "no" },
  deletes: { reaches: "own_record", undo: "no" },
  unsure: { reaches: "unsure", undo: "unsure" },
});

/** The reply the stand-in gives to a press-check effect. */
function answer(fx, says) {
  const entries = entriesOf(fx.user);
  const effects = [];
  entries.forEach((e, i) => {
    const d = (says || readsAs)(e);
    if (d) effects.push({ n: i + 1, ...(EFFECT[d] || EFFECT.unsure) });
  });
  return { effects, count: entries.length };
}

const isCheck = (f) => f && f.type === "model" && f.purpose === "labels";
// A press asked about alone (the page's check failed, or the press was not on it): the same tool.
const isSingle = (f) => f && f.type === "model" && f.purpose === "opinion" && f.tool && f.tool.name === "press_check";

/**
 * RUN.advance with every press check it asks (for a page, or for one
 * press alone) answered at once by the
 * stand-in, the way a fast judge would: the effects come back without the
 * check, with whatever its answer led to. The verdicts the engine would
 * keep for later runs are left out too. `says` as above.
 */
function judging(RUN, says) {
  const advance = (run, event, env) => {
    const out = [];
    for (const f of RUN.advance(run, event, env)) {
      if (f.type === "verdicts" || (f.type === "child_fx" && f.fx.type === "verdicts")) continue;
      // A sub-task's check is answered the same way, as its driver would deliver it.
      if (f.type === "child_fx" && isCheck(f.fx)) { out.push(...advance(run, { type: "child", child: f.child, event: { type: "model_replied", purpose: "labels", tag: f.fx.tag, reply: answer(f.fx, says), usage: {} } }, env)); continue; }
      if (isSingle(f)) { out.push(...advance(run, { type: "model_replied", purpose: "opinion", reply: answer(f, says), usage: {} }, env)); continue; }
      if (!isCheck(f)) { out.push(f); continue; }
      out.push(...advance(run, { type: "model_replied", purpose: "labels", tag: f.tag, reply: answer(f, says), usage: {} }, env));
    }
    return out;
  };
  return advance;
}

/** A run's opinions with every entry of `page` answered by the stand-in, for deciding a press directly. */
function judged(page, says, opinions) {
  const out = { ...(opinions || {}) };
  for (const e of T.pressEntries(page)) {
    const d = (says || readsAs)(e);
    out[e.key] = { does: d === null ? "none" : T.effectVerdict(EFFECT[d] || EFFECT.unsure) };
  }
  return out;
}

module.exports = { EFFECT, answer, entriesOf, judging, judged, readsAs, isCheck, isSingle };
