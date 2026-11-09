/**
 * Two MiniWoB++ runs side by side, episode by episode: the text engine
 * (miniwob.js) against the screenshot model (miniwob-vision.js), or any
 * two runs of either.
 *
 *   node tests/bench/miniwob-compare.js tests/bench/out/miniwob tests/bench/out/miniwob-vision
 *
 * Each argument is a run folder (or its results.json). Only episodes found
 * in both runs are counted, so a run that is still going compares fairly
 * with one that has finished. For each task and in total: episodes passed,
 * median and total steps, seconds per step and per episode, prompt and
 * completion tokens per step and per episode; then the episodes one run
 * passed and the other did not.
 *
 * A step is one turn of the agent's loop in miniwob.js (which can do
 * more than one action) and one model call in miniwob-vision.js.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function load(arg) {
  const file = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? path.join(arg, "results.json") : arg;
  if (!fs.existsSync(file)) throw new Error(`No results at ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows || [];
  return { name: path.basename(path.dirname(path.resolve(file))), rows: new Map(rows.map((r) => [`${r.task}#${r.episode}`, r])) };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x >= 1000 ? String(Math.round(x)) : x.toFixed(digits));

/** The numbers for one run over some episodes. */
function measure(rows) {
  const steps = rows.reduce((n, r) => n + (r.steps || 0), 0);
  const seconds = rows.reduce((n, r) => n + (r.seconds || 0), 0);
  // Rows recorded before tokens were kept carry none: no number rather than zero.
  const withTokens = rows.filter((r) => r.tokens);
  const tokenSteps = withTokens.reduce((n, r) => n + (r.steps || 0), 0);
  const prompt = withTokens.reduce((n, r) => n + (r.tokens.prompt || 0), 0);
  const completion = withTokens.reduce((n, r) => n + (r.tokens.completion || 0), 0);
  const withTiming = rows.filter((r) => r.timing);
  const modelMs = withTiming.reduce((n, r) => n + (r.timing.model || 0), 0);
  const timedSteps = withTiming.reduce((n, r) => n + (r.steps || 0), 0);
  const has = withTokens.length === rows.length && rows.length > 0;
  return {
    passed: rows.filter((r) => r.success).length, episodes: rows.length,
    medianSteps: median(rows.map((r) => r.steps || 0)), steps,
    secondsPerStep: steps ? seconds / steps : null, secondsPerEpisode: rows.length ? seconds / rows.length : null,
    modelSecondsPerStep: timedSteps ? modelMs / 1000 / timedSteps : null,
    promptPerStep: has && tokenSteps ? prompt / tokenSteps : null, completionPerStep: has && tokenSteps ? completion / tokenSteps : null,
    promptPerEpisode: has ? prompt / rows.length : null, completionPerEpisode: has ? completion / rows.length : null,
  };
}

function line(task, arm, m) {
  return `| ${task} | ${arm} | ${m.passed}/${m.episodes} | ${fmt(m.medianSteps)} | ${m.steps} | ${fmt(m.secondsPerStep)} | ${fmt(m.modelSecondsPerStep)} | ${fmt(m.secondsPerEpisode)} | ${fmt(m.promptPerStep, 0)} | ${fmt(m.completionPerStep, 0)} | ${fmt(m.promptPerEpisode, 0)} | ${fmt(m.completionPerEpisode, 0)} |`;
}

function main() {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("Usage: node tests/bench/miniwob-compare.js <run folder A> <run folder B>"); process.exit(1); }
  const A = load(a);
  const B = load(b);
  if (A.name === B.name) { A.name = `A:${A.name}`; B.name = `B:${B.name}`; }
  const both = [...A.rows.keys()].filter((k) => B.rows.has(k));
  const onlyA = A.rows.size - both.length;
  const onlyB = B.rows.size - both.length;
  const tasks = [...new Set(both.map((k) => k.split("#")[0]))].sort();
  const out = [
    `A = ${A.name}, B = ${B.name}: ${both.length} episodes in both${onlyA || onlyB ? ` (left out: ${onlyA} only in A, ${onlyB} only in B)` : ""}.`,
    "",
    "| task | run | passed | median steps | total steps | s/step | model s/step | s/episode | prompt tok/step | completion tok/step | prompt tok/episode | completion tok/episode |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const task of tasks) {
    const keys = both.filter((k) => k.split("#")[0] === task);
    out.push(line(task, "A", measure(keys.map((k) => A.rows.get(k)))));
    out.push(line("", "B", measure(keys.map((k) => B.rows.get(k)))));
  }
  out.push(line("**all**", "A", measure(both.map((k) => A.rows.get(k)))));
  out.push(line("", "B", measure(both.map((k) => B.rows.get(k)))));
  const aOnly = both.filter((k) => A.rows.get(k).success && !B.rows.get(k).success);
  const bOnly = both.filter((k) => B.rows.get(k).success && !A.rows.get(k).success);
  out.push("", `Passed by A, failed by B (${aOnly.length}): ${aOnly.join(", ") || "none"}`);
  out.push(`Passed by B, failed by A (${bOnly.length}): ${bOnly.join(", ") || "none"}`);
  out.push("", "A step is one turn of the text engine's loop (it may do several actions) and one model call for the screenshot runner.");
  console.log(out.join("\n"));
}

main();
