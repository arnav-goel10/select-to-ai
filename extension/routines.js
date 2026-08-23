/**
 * Select to AI - Routines (scheduled agent tasks).
 *
 * Lets a user run a saved task on a schedule ("every weekday morning,
 * check X"). Scheduling is chrome.alarms; when an alarm fires, the
 * background worker opens the agent page with a one-time pending task
 * payload. The user stays in control: routines only START a run in a
 * visible tab, all existing safety gates still apply, and nothing runs
 * while a run is already active.
 *
 * Pure scheduling logic lives here for testability; storage and alarm
 * wiring live in background.js / options.js. Exposes
 * SELECT_TO_AI_ROUTINES; also CommonJS-exported for Node.
 */
(function initRoutines(root) {
  "use strict";

  // Chrome's minimum alarm period is 30 seconds (unpacked: 1 minute in
  // older versions); we allow honest human-scale schedules only.
  const MINUTES_IN = {
    day: 24 * 60,
    week: 7 * 24 * 60,
  };

  /**
   * Normalizes a routine definition. Returns {ok, routine|error}.
   * schedule: {kind:"daily", time:"HH:MM"} or
   *           {kind:"weekly", day:0-6, time:"HH:MM"} (day: 0=Sun).
   */
  function normalizeRoutine(input) {
    const name = String(input?.name || "").trim().slice(0, 80);
    const task = String(input?.task || "").trim().slice(0, 2000);
    if (!name) return { ok: false, error: "A routine needs a name." };
    if (!task) return { ok: false, error: "A routine needs a task." };

    const schedule = input?.schedule || {};
    if (schedule.kind !== "daily" && schedule.kind !== "weekly") {
      return { ok: false, error: 'Schedule kind must be "daily" or "weekly".' };
    }
    const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(schedule.time || "")
      ? schedule.time
      : null;
    if (!timeMatch) {
      return { ok: false, error: 'Schedule time must be "HH:MM" (24-hour).' };
    }
    if (schedule.kind === "weekly") {
      const day = Number(schedule.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return { ok: false, error: "Weekly schedules need day 0-6 (0=Sunday)." };
      }
      return {
        ok: true,
        routine: {
          id: input.id || null,
          name,
          task,
          enabled: input.enabled !== false,
          schedule: { kind: "weekly", day, time: timeMatch },
        },
      };
    }
    return {
      ok: true,
      routine: {
        id: input.id || null,
        name,
        task,
        enabled: input.enabled !== false,
        schedule: { kind: "daily", time: timeMatch },
      },
    };
  }

  /**
   * Computes the next fire epoch-ms for a normalized schedule, strictly
   * after `afterMs`. Deterministic and pure.
   */
  function nextFireTime(schedule, afterMs) {
    const [hh, mm] = String(schedule.time).split(":").map(Number);
    const next = new Date(afterMs);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= afterMs) {
      next.setDate(next.getDate() + 1);
    }
    if (schedule.kind === "weekly") {
      while (next.getDay() !== schedule.day) {
        next.setDate(next.getDate() + 1);
      }
    }
    return next.getTime();
  }

  /** Alarm name for a routine id (namespaced to survive other alarms). */
  function alarmName(routineId) {
    return `routine:${routineId}`;
  }

  /** Parses an alarm name back into a routine id, or null. */
  function parseAlarmName(name) {
    return typeof name === "string" && name.startsWith("routine:")
      ? name.slice("routine:".length)
      : null;
  }

  root.SELECT_TO_AI_ROUTINES = Object.freeze({
    MINUTES_IN,
    normalizeRoutine,
    nextFireTime,
    alarmName,
    parseAlarmName,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_ROUTINES;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
