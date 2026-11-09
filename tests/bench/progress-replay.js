"use strict";
/**
 * Replays the run's wandering rule (extension/core/run.js, PROGRESS) on
 * saved benchmark runs, and prints, per run, at which steps it would have
 * fired, against whether the run passed; and where a failing address was
 * asked for again.
 *
 *   node tests/bench/progress-replay.js <folder> [<folder> ...]
 *
 * Each folder holds <task>/run1/run.json as tests/bench/run.js writes it.
 * A saved run keeps its actions and their results, not the pages, so the
 * steps' records are rebuilt from them:
 * - the address a step ended on is the last one its results name ("now
 *   at", "Opened", "Now at"); a step whose results name none stayed where
 *   it was, unless it asked for the address it was on, which is an arrival;
 * - a search is an arrival at an address that carries text the run typed
 *   (into a box, or in a query of several words in an address it wrote).
 *   Search forms are not in the saved run, so a results address is known
 *   only by the text it carries, and a search that does not change the
 *   address is not seen: the live rule sees both.
 * - the next page of results is an arrival at an address that differs from
 *   a results address only by a page number, or a press on a control
 *   labelled with a number or arrows while on results;
 * - a read is progress when it read a part of a page not read before;
 *   a note is progress (runs saved before notes were traced have none).
 * Firing follows the live rule: stated once when it begins, then the
 * helper's spell of up to HELPER_STEPS steps (ending early at a step that
 * makes progress), after which the window starts again. The replay cannot
 * know what the helper would have done, so the saved steps stand in for
 * its steps. Wandering no longer counts toward the stuck stop.
 */
const fs = require("node:fs");
const path = require("node:path");
const RUN = require("../../extension/core/run.js");

const P = RUN.PROGRESS;
const ARRIVED = /(?:now at|Opened|Now at) (https?:\/\/\S+)/;
const plain = (u) => String(u || "").split("#")[0];

function records(history, request) {
  const steps = new Map();
  for (const h of history || []) {
    if (!steps.has(h.step)) steps.set(h.step, []);
    steps.get(h.step).push(h);
  }
  const p = { typed: [], searchForms: [] };
  const visits = {};
  const readParts = new Set();
  let results = [];
  let last = "";
  const out = [];

  for (const [step, actions] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
    let at = "";
    let filled = false;
    let submitted = false;
    let asked = false;
    let read = false;
    let pager = false;
    let note = false;
    for (const a of actions) {
      const text = String(a.action || "");
      const outcome = String(a.outcome || "");
      if (a.note) note = true;
      // The action as the run held it: the text it typed, or the address it wrote.
      const fill = /^fill \[\d+\](?: "[^"]*":)? "(.*)"$/.exec(text);
      if (fill) { P.typedText(p, { do: "fill", value: fill[1] }, request); filled = true; }
      const nav = /^(?:navigate|tabs open) (https?:\/\/\S+)/.exec(text);
      if (nav) P.typedText(p, { do: "navigate", url: nav[1] }, request);
      // Typed text sent with Enter: a search box submitted. The live rule
      // knows a search box from the page; the saved run does not.
      if (filled && /^press \[\d+\].* Enter$/.test(text)) submitted = true;
      const m = ARRIVED.exec(outcome);
      if (m) at = plain(m[1].replace(/[.,]+$/, ""));
      if (nav && a.ok && m) asked = true;
      // A long address is cut short in the saved action ("…"): the one it opened stands for it.
      if (nav && /…$/.test(nav[1]) && m) P.typedText(p, { do: "navigate", url: at }, request);
      const part = /^Read (part \d+ of \d+)/.exec(outcome);
      if (/^read/.test(text) && a.ok && part) {
        const key = `${plain(a.url)} ${part[1]}`;
        if (!readParts.has(key)) { readParts.add(key); read = true; }
      }
      const press = /^click \[\d+\] "([^"]*)"/.exec(text);
      if (press && a.ok && results.includes(plain(a.url)) && /^\s*(?:\d{1,4}|[›»→>⟩❯]+)\s*$/.test(press[1])) pager = true;
    }
    const arrived = !!at && (at !== last || asked);
    if (arrived) visits[at] = (visits[at] || 0) + 1;
    const revisit = arrived && visits[at] > 1;
    const paged = arrived ? !revisit && (pager || results.some((u) => P.nextPageOf(u, at))) : pager;
    const isResults = arrived && (paged || P.isSearchAddress(p, at));
    if (isResults) results = [...results.filter((u) => u !== at), at].slice(-20);
    out.push({ step, url: arrived ? at : "", revisit, search: (isResults && !paged) || submitted, newPage: arrived && !revisit && !isResults, note, ...(paged ? { paged: true } : {}), ...(read ? { read: true } : {}) });
    if (at) last = at;
  }
  return out;
}

/** Steps where a failing address was asked for again: {step, url, n, how}. */
function failingAgain(history) {
  const asks = new Map();
  const out = [];
  for (const a of history || []) {
    const nav = /^(?:navigate|tabs open) (https?:\/\/\S+)/.exec(String(a.action || ""));
    const m = ARRIVED.exec(String(a.outcome || ""));
    if (!nav || !a.ok || !m) continue;
    const url = plain(m[1].replace(/[.,]+$/, ""));
    const st = /status (\d{3})/.exec(a.outcome);
    const how = /did not load/.test(a.outcome) ? "error" : st ? `status ${st[1]}` : /sent you to another address|sent to a different site/.test(a.outcome) ? "redirect" : "";
    const key = /…$/.test(nav[1]) ? url : plain(nav[1]);
    const n = how ? (asks.get(key) || 0) + 1 : 0;
    asks.set(key, n);
    if (n >= 2) out.push({ step: a.step, url: key, n, how });
  }
  return out;
}

function replay(run) {
  const recs = records(run.history, run.task);
  const fired = [];
  let from = 0;
  let spell = null;
  let was = null;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (spell) {
      spell.steps += 1;
      if (P.madeProgress(r) || spell.steps >= P.HELPER_STEPS) { from = r.step; spell = null; was = null; continue; }
    }
    const w = P.wanderingOf(recs.slice(0, i + 1).filter((x) => x.step > from));
    // The run would see it, and the helper take its spell, at the next step.
    if (w && !was) { fired.push({ step: r.step + 1, rule: w.rule }); if (!spell) spell = { steps: 0 }; }
    was = w;
  }
  const again = failingAgain(run.history);
  return { fired, again, steps: run.steps, arrivals: recs.filter((r) => r.url).length, revisits: recs.filter((r) => r.revisit).length, searches: recs.filter((r) => r.search).length, paged: recs.filter((r) => r.paged).length, reads: recs.filter((r) => r.read).length };
}

function main() {
  const folders = process.argv.slice(2);
  if (!folders.length) {
    console.error("Usage: node tests/bench/progress-replay.js <folder> [<folder> ...]");
    process.exit(2);
  }
  console.log(`Rule: revisits >= ${P.REVISITS} of the last ${P.REVISIT_WINDOW} steps, or searches >= ${P.SEARCHES} of the last ${P.SEARCH_WINDOW} with no progress; one helper spell of up to ${P.HELPER_STEPS} steps per firing, then the window starts again.\n`);
  const all = [];
  for (const folder of folders) {
    const arm = path.basename(folder);
    const rows = [];
    for (const task of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, task, "run1", "run.json");
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      if (run.blocked || run.judgeFailed) continue;
      rows.push({ id: run.id || task, pass: !!run.success, ...replay(run) });
    }
    console.log(`== ${arm}`);
    for (const r of rows) {
      const fire = r.fired.length ? `fires ${r.fired.length}x at ${r.fired.map((f) => `${f.step} (${f.rule})`).join(", ")}` : "-";
      const again = r.again.length ? `  failing address asked again ${r.again.length}x` : "";
      console.log(`${r.pass ? "PASS" : "FAIL"}  ${String(r.id).padEnd(20)} steps ${String(r.steps).padStart(3)}  arr ${String(r.arrivals).padStart(2)} rev ${String(r.revisits).padStart(2)} srch ${String(r.searches).padStart(2)} paged ${String(r.paged).padStart(2)} reads ${r.reads}  ${fire}${again}`);
    }
    summary(rows);
    all.push(...rows);
  }
  if (folders.length > 1) { console.log("== all"); summary(all); }
}

function summary(rows) {
  const failed = rows.filter((r) => !r.pass);
  const passed = rows.filter((r) => r.pass);
  const n = (list) => list.reduce((k, r) => k + r.fired.length, 0);
  console.log(`fired on ${failed.filter((r) => r.fired.length).length} of ${failed.length} failed runs (${n(failed)} firings), and on ${passed.filter((r) => r.fired.length).length} of ${passed.length} passed runs (${n(passed)} firings): ${passed.filter((r) => r.fired.length).map((r) => `${r.id} at ${r.fired.map((f) => f.step).join("/")} of ${r.steps}`).join(", ") || "none"}`);
  console.log(`failing address asked for again: ${failed.filter((r) => r.again.length).length} failed runs, ${passed.filter((r) => r.again.length).length} passed runs\n`);
}

if (require.main === module) main();
module.exports = { records, replay, failingAgain };
