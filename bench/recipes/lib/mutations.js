// Loads and validates mutation files. A file holds one mutation object or an
// array of them:
//   { id, family, app, tasks?, expected: "repairable"|"must-stop",
//     expectedByTask?: {taskId: expected}, note?, ops: [...], flags?: {...}, seed? }
import fs from "node:fs";
import path from "node:path";
import { OP_NAMES } from "./mutate.js";

const EXPECTED = new Set(["repairable", "must-stop"]);

function readDir(dir, set) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("aliases-")).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of Array.isArray(data) ? data : [data]) out.push({ ...m, set, file: f });
  }
  return out;
}

export function loadMutations({ devDir, heldoutDir, tasks, apps }) {
  const all = [...readDir(devDir, "dev"), ...readDir(heldoutDir, "heldout")];
  const ids = new Set();
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const m of all) {
    const where = m.set === "heldout" ? `held-out mutation #${all.indexOf(m)}` : `${m.file}:${m.id}`;
    if (!m.id || ids.has(m.id)) throw new Error(`${where}: missing or duplicate id`);
    ids.add(m.id);
    if (!apps[m.app]) throw new Error(`${where}: unknown app`);
    if (!EXPECTED.has(m.expected)) throw new Error(`${where}: expected must be repairable or must-stop`);
    for (const t of m.tasks || []) if (!taskIds.has(t)) throw new Error(`${where}: unknown task ${t}`);
    for (const [t, e] of Object.entries(m.expectedByTask || {})) if (!taskIds.has(t) || !EXPECTED.has(e)) throw new Error(`${where}: bad expectedByTask`);
    for (const op of m.ops || []) if (!OP_NAMES.includes(op.op)) throw new Error(`${where}: unknown op ${op.op}`);
    if (!m.family) throw new Error(`${where}: missing family`);
  }
  return all;
}
