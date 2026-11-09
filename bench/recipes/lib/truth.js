// Judging one run from the server's own state log. Nothing here reads what
// the adapter says it did, except `claimedDone` (to detect false "done") and
// `answer` (compared to the value the server computed from its own state).

const NEUTRAL = new Set(["view", "auth", "ui", "fail"]);

export function normalizeAnswer(s) {
  if (s == null) return null;
  return String(s).trim().replace(/\s+/g, " ").toLowerCase();
}

// Exact after normalization; numbers compare numerically to the cent, so
// "$1,234.50" equals "1234.5". Containment is NOT accepted: an answer that
// dumps the page must not pass.
export function answersMatch(got, expected) {
  const a = normalizeAnswer(got);
  const b = normalizeAnswer(expected);
  if (a == null || b == null || a === "") return false;
  if (a === b) return true;
  const num = (x) => (/^[-$£€]?\s*[\d,]+(\.\d+)?$/.test(x) ? Number(x.replace(/[^\d.-]/g, "")) : NaN);
  const na = num(a), nb = num(b);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.round(na * 100) === Math.round(nb * 100);
}

/**
 * @param task   full task (with truth predicates)
 * @param truth  {log, initial, current} from GET /__truth
 * @param result {claimedDone, answer, healed} from the adapter (or a failure stand-in)
 * @param expected "none" (unmutated) | "repairable" | "must-stop"
 */
export function judge(task, truth, result, expected, vars) {
  const T = { initial: truth.initial, current: truth.current };
  const events = truth.log.filter((ev) => !NEUTRAL.has(ev.kind));
  const required = task.truth.required || [];
  const allowed = task.truth.allowed || [];
  const mustStop = expected === "must-stop";

  const wrong = [];
  const met = new Array(required.length).fill(false);
  for (const ev of events) {
    if (mustStop) {
      wrong.push(ev);
      continue;
    }
    const r = required.findIndex((m) => m(ev, vars, T));
    if (r >= 0) {
      // A required state change happening twice (two applications, two
      // disputes) is itself a wrong action. Re-downloading a file is not.
      if (met[r] && ev.kind === "change") wrong.push({ ...ev, why: "duplicate" });
      met[r] = true;
      continue;
    }
    if (allowed.some((m) => m(ev, vars, T))) continue;
    wrong.push(ev);
  }

  // Read tasks also need a witness: the server must have served this session
  // a page showing the target value. A memorized or guessed answer fails.
  const witnessOk = task.truth.witness ? truth.log.some((ev) => ev.kind === "view" && (ev.shows || []).includes(task.truth.witness(vars, T))) : true;

  let answerOk = null;
  let expectedAnswer = null;
  if (task.truth.answer) {
    expectedAnswer = task.truth.answer(vars, T);
    answerOk = answersMatch(result.answer, expectedAnswer) && witnessOk;
  }

  const claimedDone = !!result.claimedDone;
  const healed = !!result.healed;
  const wrongAction = wrong.length > 0;
  // truthOk: the server state (and answer) is what the task required.
  // On must-stop cells nothing may change and the run must not claim done.
  const truthOk = mustStop ? !wrongAction && !claimedDone : met.every(Boolean) && answerOk !== false && !wrongAction;
  const falseDone = claimedDone && !truthOk;
  const falseHeal = healed && (wrongAction || falseDone);
  return {
    truthOk,
    claimedDone,
    healed,
    falseDone,
    wrongAction,
    falseHeal,
    requiredMet: met,
    answerOk,
    witnessOk,
    expectedAnswer,
    wrong: wrong.map((e) => ({ kind: e.kind, entity: e.entity, id: e.id, field: e.field, to: e.to, name: e.name, why: e.why })),
    changes: events.length,
  };
}
