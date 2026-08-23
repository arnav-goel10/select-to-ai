const test = require("node:test");
const assert = require("node:assert/strict");
const routines = require("../../extension/routines.js");

test("normalizeRoutine accepts valid daily and weekly schedules", () => {
  const daily = routines.normalizeRoutine({
    name: "Morning check",
    task: "Check the dashboard for alerts",
    schedule: { kind: "daily", time: "08:30" },
  });
  assert.ok(daily.ok);
  assert.equal(daily.routine.schedule.kind, "daily");
  assert.equal(daily.routine.enabled, true);

  const weekly = routines.normalizeRoutine({
    name: "Weekly report",
    task: "Pull last week's numbers",
    schedule: { kind: "weekly", day: 1, time: "09:00" },
  });
  assert.ok(weekly.ok);
  assert.equal(weekly.routine.schedule.day, 1);
});

test("normalizeRoutine rejects bad names, tasks, times, days", () => {
  const base = { name: "n", task: "t", schedule: { kind: "daily", time: "08:00" } };
  assert.ok(!routines.normalizeRoutine({ ...base, name: "  " }).ok);
  assert.ok(!routines.normalizeRoutine({ ...base, task: "" }).ok);
  assert.ok(!routines.normalizeRoutine({ ...base, schedule: { kind: "hourly", time: "8:00" } }).ok);
  assert.ok(!routines.normalizeRoutine({ ...base, schedule: { kind: "daily", time: "25:00" } }).ok);
  assert.ok(!routines.normalizeRoutine({ ...base, schedule: { kind: "daily" } }).ok);
  assert.ok(
    !routines.normalizeRoutine({
      ...base,
      schedule: { kind: "weekly", day: 9, time: "08:00" },
    }).ok,
    "day must be 0-6",
  );
});

test("nextFireTime returns the next occurrence strictly in the future", () => {
  // Wednesday 2026-08-26 10:00 local.
  const after = new Date(2026, 7, 26, 10, 5).getTime();
  const dailyNext = new Date(routines.nextFireTime({ kind: "daily", time: "09:00" }, after));
  assert.equal(dailyNext.getDate(), 27);
  assert.equal(dailyNext.getHours(), 9);

  // Same-day earlier time is tomorrow; later today is today.
  const sameDayLater = new Date(
    routines.nextFireTime({ kind: "daily", time: "16:00" }, after),
  );
  assert.equal(sameDayLater.getDate(), 26);
  assert.equal(sameDayLater.getHours(), 16);
});

test("nextFireTime weekly lands on the requested weekday", () => {
  // Wed Aug 26, 2026 -> next Monday (day 1) is Aug 31.
  const after = new Date(2026, 7, 26, 12, 0).getTime();
  const next = new Date(
    routines.nextFireTime({ kind: "weekly", day: 1, time: "08:15" }, after),
  );
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 31);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 15);
});

test("alarm names round-trip", () => {
  const name = routines.alarmName("abc-123");
  assert.ok(name.startsWith("routine:"));
  assert.equal(routines.parseAlarmName(name), "abc-123");
  assert.equal(routines.parseAlarmName("other"), null);
});
