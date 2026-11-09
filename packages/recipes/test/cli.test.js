import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("the CLI pretty-prints a receipt and says why a run stopped", () => {
  const r = {
    id: "rpl_1", recipeId: "rcp_1", recipeVersion: 1, request: "Save the draft", variables: [{ name: "note", shown: "hi" }],
    steps: [{ id: "s1", n: 1, intent: "open the page", class: "read", status: "ok", post: [{ predicate: "page", held: true, observed: "https://x/draft" }] }],
    repairs: [], end: { state: "needs_you", why: "step s2: the words around it changed", proof: { kind: "none", items: [] } },
    cost: { modelCalls: 1, usd: 0.0002 }, checks: { drift: 1 },
  };
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rcli-")), "r.json");
  fs.writeFileSync(f, JSON.stringify(r));
  const out = execFileSync(process.execPath, [cli, "receipt", f], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.match(out, /^NEEDS YOU {2}Save the draft/);
  assert.match(out, /Why it stopped\n {2}step s2: the words around it changed/);
  assert.match(out, /meaning checks: 1/);
  assert.throws(() => execFileSync(process.execPath, [cli, "receipt", path.join(path.dirname(f), "missing.json")], { stdio: "pipe" }));
});
