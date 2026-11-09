/**
 * Splits a task file once into a dev set and a held-out set.
 *
 *   node tests/bench/split.js tests/bench/data/webvoyager-all.json
 *
 * Dev tasks may be read while working. Held-out tasks are only ever scored:
 * run them with BENCH_QUIET=1 and read the totals, never a transcript. Any
 * task whose runs have been read is listed in data/inspected.json and goes to
 * dev whatever its hash says; add an id there the moment a held-out run is
 * opened, and run this again.
 *
 * Writes, next to the task file: <name>-dev.json, <name>-heldout.json, and a
 * fixed sample of each for routine comparisons (SAMPLE_DEV, SAMPLE_HELDOUT
 * tasks per site; defaults 3 and 5).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normaliseTasks, splitTasks, samplePerGroup } = require("./judge.js");

const file = process.argv[2];
if (!file) { console.error("Usage: node tests/bench/split.js <tasks.json>"); process.exit(1); }
const dir = path.dirname(file);
const name = path.basename(file, ".json").replace(/-all$/, "");
const tasks = normaliseTasks(JSON.parse(fs.readFileSync(file, "utf8")));
const inspectedFile = path.join(dir, "inspected.json");
const inspected = fs.existsSync(inspectedFile) ? JSON.parse(fs.readFileSync(inspectedFile, "utf8")) : [];
const { dev, heldOut } = splitTasks(tasks, { inspected });
const write = (suffix, list) => { fs.writeFileSync(path.join(dir, `${name}-${suffix}.json`), JSON.stringify(list, null, 1)); return list.length; };
const perSite = (list) => { const n = {}; for (const t of list) n[t.level] = (n[t.level] || 0) + 1; return n; };

console.log(`${tasks.length} tasks, ${inspected.length} already read`);
console.log(`dev ${write("dev", dev)}:`, perSite(dev));
console.log(`held-out ${write("heldout", heldOut)}:`, perSite(heldOut));
console.log(`dev sample ${write("dev-sample", samplePerGroup(dev, parseInt(process.env.SAMPLE_DEV || "3", 10)))}, held-out sample ${write("heldout-sample", samplePerGroup(heldOut, parseInt(process.env.SAMPLE_HELDOUT || "5", 10)))}`);
