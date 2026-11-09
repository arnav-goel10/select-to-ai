// The recipes benchmark must not be passable by a degenerate policy.
// Runs every degenerate adapter on the unmutated apps and the dev mutation
// set (first variable set; RECIPES_TEST_FULL=1 for all) and checks that each
// scores 0 success and is caught by the false-done or wrong-action metric.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBench, DEGENERATE } from "../../bench/recipes/run.js";

test("degenerate adapters score 0 and are caught", { timeout: 60 * 60 * 1000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "recipes-degenerate-"));
  const res = await runBench({
    adapters: DEGENERATE.join(","),
    sets: "dev",
    vars: process.env.RECIPES_TEST_FULL ? undefined : "0",
    concurrency: 6,
    quiet: true,
    label: "degenerate-test",
    out,
  });
  const rows = res.rows;
  assert.deepEqual(res.problems, [], res.problems.join("\n"));
  for (const name of DEGENERATE) {
    const mine = rows.filter((r) => r.adapter === name);
    assert.ok(mine.length > 0, `${name} produced no rows`);
    const wins = mine.filter((r) => r.truthOk && r.expected !== "must-stop");
    assert.equal(wins.length, 0, `${name} succeeded on: ${wins.map((w) => `${w.task}/${w.mutation || "none"}`).join(", ")}`);
    if (name === "always-stop") {
      // It may "stop correctly" on must-stop cells, which is why correct-stop
      // is never read without success on unmutated and repairable cells.
      assert.ok(mine.every((r) => !r.claimedDone && !r.wrongAction));
      continue;
    }
    const caught = mine.filter((r) => r.falseDone || r.wrongAction).length;
    assert.ok(caught === mine.length, `${name}: ${mine.length - caught} runs neither false-done nor wrong-action`);
  }
  // The reference must pass every unmutated cell, or the suite is broken.
  const ref = rows.filter((r) => r.adapter === "reference-replay" && !r.mutation);
  assert.ok(ref.length > 0 && ref.every((r) => r.truthOk));
  fs.rmSync(out, { recursive: true, force: true });
});
