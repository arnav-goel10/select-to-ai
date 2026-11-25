/**
 * The block detector: whether a site refused the bench's browser, decided
 * from the page's structure and the HTTP status of its document. No site
 * name, no vendor name and no list of words takes part. A run the detector
 * calls blocked goes to the blocked column, apart from the agent's passes
 * and failures, whatever the judge said about it.
 *
 * A page is a refusal page when it is thin (little text) and one of these
 * holds:
 *
 *   status      its document came back with a status that refuses the visit
 *               (REFUSAL_STATUSES)
 *   request id  it shows an opaque request identifier or the visitor's own
 *               network address, the two things a page that turns a visitor
 *               away gives them to quote: a run of letters and digits that is
 *               no word, a dotted hex reference, a UUID, an IPv4 address
 *   only frame  it has nothing to press of its own, and all it offers sits in
 *               a frame drawn by another origin
 *   front door  it is on the task's own site, the run never saw anything but
 *               thin pages there and no press, fill or other act of the
 *               agent's worked, and it offers no link into the site and at
 *               most WAY_ON.controls controls
 *
 * A run is blocked when the last page it saw on the task's own site (the
 * start page's registrable domain, or a site the task names) is a refusal
 * page. A refusal on a site the agent chose to go to is the agent's outcome,
 * not a block of the task's site.
 *
 *   node tests/bench/blocks.js check <run folder>=<source>... --labels <file>
 *
 * `check` reads stored runs (run.json files), decides each end page, and
 * compares with hand labels keyed by labelKey(). `source` names where a
 * folder's runs came from (the workflow run that made them), so a label
 * finds its run wherever the folder sits. It prints counts only.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// A page with more visible text than this is not a refusal page, whatever else it shows.
const THIN = Object.freeze({ chars: 1000 });
// The most controls a front door may offer and still count as offering no way on.
const WAY_ON = Object.freeze({ controls: 3 });
// Statuses a server gives a visitor it will not serve: accepted but not served (a challenge),
// unauthorised, forbidden, method refused, proxy sign-in, too many requests, unavailable for
// legal reasons, unavailable. A plain 404 or 500 is an error, not a refusal.
const REFUSAL_STATUSES = Object.freeze([202, 401, 403, 405, 407, 429, 451, 503]);
// The agent's own tools that act on no page: going to an address, waiting, reading, looking,
// asking and finishing. Any other step that worked is an act on a page (agentTools.js).
const PASSIVE_TOOLS = Object.freeze(["navigate", "wait", "find", "read", "look", "scroll", "back", "tabs", "done", "ask_user", "give_up"]);

/** Whether any step of a run's own that acts on a page worked. */
const actedOnPage = (run) => ((run && run.history) || []).some((h) => h && h.ok && !PASSIVE_TOOLS.includes(String(h.action || "").split(" ")[0]));

const siteOfUrl = (url) => {
  try { return require("../../extension/agentTools.js").siteOf(new URL(String(url)).href) || new URL(String(url)).hostname; } catch (_e) { return ""; }
};
const collapse = (t) => String(t || "").replace(/\s+/g, " ").trim();

/**
 * Runs in the page: what the detector reads of a page's structure. The
 * document's status from the navigation timing entry, the visible links and
 * the hosts they point at, the visible controls, and the frames, with those
 * of another origin counted apart (their inside cannot be read).
 */
function pageFactsInPage() {
  const nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || null;
  const status = nav && Number(nav.responseStatus) > 0 ? Number(nav.responseStatus) : null;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const linkHosts = {};
  let links = 0;
  for (const a of document.querySelectorAll("a[href]")) {
    if (!shown(a)) continue;
    let host = "";
    try { const u = new URL(a.href, location.href); if (!/^https?:$/.test(u.protocol)) continue; host = u.hostname; } catch (_e) { continue; }
    links++;
    linkHosts[host] = (linkHosts[host] || 0) + 1;
  }
  let controls = 0;
  for (const el of document.querySelectorAll("button, input, select, textarea, summary, [role=button], [role=checkbox], [role=radio], [role=link], [role=tab], [contenteditable=''], [contenteditable='true']")) {
    if (el.tagName === "INPUT" && String(el.type).toLowerCase() === "hidden") continue;
    if (shown(el)) controls++;
  }
  let frames = 0;
  let crossFrames = 0;
  for (const f of document.querySelectorAll("iframe, frame")) {
    if (!shown(f)) continue;
    frames++;
    let inside = null;
    try { inside = f.contentDocument; } catch (_e) { inside = null; }
    if (!inside) crossFrames++;
  }
  return { status, links, linkHosts, controls, frames, crossFrames };
}

/**
 * What the engine's listing of a page shows of its structure: the numbered
 * entries of the main document and those inside a frame, the links among
 * them and where each points, and the page text with the entries left out.
 * The listing is the engine's own reading (agentContentScript.js): a line
 * "[n] role ..." is one thing the model could press, and a line opening
 * "[In the frame" starts what a frame holds.
 */
function listingFacts(listing, pageUrl) {
  const lines = String(listing || "").split("\n");
  let inFrame = false;
  let own = 0;
  let framed = 0;
  let links = 0;
  let siteLinks = 0;
  const words = [];
  const site = siteOfUrl(pageUrl);
  for (const line of lines) {
    if (/^\[In the frame\b/.test(line)) { inFrame = true; continue; }
    const m = /^\[\d+\]\s+(\S+)/.exec(line);
    if (!m) { if (!/^(frame|iframe)\s"/.test(line)) words.push(line); continue; }
    if (inFrame) { framed++; continue; }
    own++;
    if (m[1] === "a") {
      links++;
      const to = /→\s*(\S+)/.exec(line);
      const target = to ? to[1] : "";
      const same = target.startsWith("/") ? true : target ? siteOfUrl(/^https?:/.test(target) ? target : `https://${target}`) === site : false;
      if (same) siteLinks++;
    }
  }
  return { own, framed, links, siteLinks, text: words.join("\n") };
}

/** Whether a text shows an opaque request identifier or the visitor's own network address. Addresses (URLs) are left out first. */
function requestToken(text) {
  const t = String(text || "").replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\b\S+\.\S+\/\S*/g, " ");
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const dottedHex = /\b[0-9a-f]{1,8}(?:\.[0-9a-f]{6,}){2,}\b/i;
  const ipv4 = /(?:^|[^\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\w|\.\d)/;
  if (uuid.test(t) || dottedHex.test(t) || ipv4.test(t)) return true;
  // A run of 16 or more letters, digits and joiners with at least three of each: no word and no plain number.
  for (const m of t.matchAll(/[A-Za-z0-9_:-]{16,}/g)) {
    const s = m[0];
    if ((s.match(/[A-Za-z]/g) || []).length >= 3 && (s.match(/\d/g) || []).length >= 3) return true;
  }
  return false;
}

/**
 * One page as the detector sees it. `page` is {url, title, text, facts?,
 * listing?, controlsShown?}: `facts` from pageFactsInPage when the harness
 * recorded them, `listing` the engine's reading of the page when it has
 * one, `controlsShown` the visible form controls the harness read back.
 * Unknown parts stay null.
 */
function snapshotOf(page) {
  const p = page || {};
  const site = siteOfUrl(p.url);
  const fromListing = p.listing ? listingFacts(p.listing, p.url) : null;
  const chars = Math.max(collapse(p.text).length, fromListing ? collapse(fromListing.text).length : 0);
  const f = p.facts || null;
  let own = null;
  let framed = null;
  let siteLinks = null;
  if (f) {
    own = (f.links || 0) + (f.controls || 0);
    framed = f.crossFrames || 0;
    siteLinks = Object.entries(f.linkHosts || {}).reduce((n, [host, k]) => n + (siteOfUrl(`https://${host}/`) === site ? k : 0), 0);
  } else if (fromListing) {
    own = fromListing.own;
    framed = fromListing.framed;
    siteLinks = fromListing.siteLinks;
  }
  return {
    url: p.url || "",
    chars,
    status: f && Number.isFinite(f.status) ? f.status : null,
    own,
    framed,
    siteLinks,
    token: requestToken(`${p.text || ""}\n${fromListing ? fromListing.text : ""}`),
  };
}

/** Whether a snapshot is a refusal page, and the signals that say so. `onTaskSite` and `neverIn` decide the front-door signal. */
function refusalPage(s, { onTaskSite = false, neverIn = false } = {}) {
  const signals = [];
  if (!s || s.chars > THIN.chars) return { blocked: false, signals };
  if (REFUSAL_STATUSES.includes(s.status)) signals.push("status");
  if (s.token) signals.push("request id");
  if (s.own === 0 && s.framed > 0) signals.push("only frame");
  if (onTaskSite && neverIn && s.siteLinks === 0 && s.own !== null && s.own <= WAY_ON.controls) signals.push("front door");
  return { blocked: signals.length > 0, signals };
}

/** The sites a run's task is on: the start page's registrable domain and any the task names. */
function taskSites(run) {
  return new Set([run.startUrl, ...(run.sites || []).map((s) => (/^https?:/.test(s) ? s : `https://${s}`))].map(siteOfUrl).filter(Boolean));
}

/**
 * The pages of a stored or live run, oldest first, the final page last,
 * each ready for snapshotOf. The engine's reading of an address is its
 * listing; the final page also carries the form controls read back.
 */
function pagesOf(run) {
  const listings = new Map((run.engineReadings || []).filter((e) => e && e.url).map((e) => [e.url, e.text]));
  const list = (run.pages || []).filter((p) => p && p.url).map((p, i) => ({ ...p, order: p.lastSeen || i + 1 }));
  list.sort((a, b) => a.order - b.order);
  const out = list.map((p) => ({ url: p.url, title: p.title, text: p.text, facts: p.facts || null, listing: listings.get(p.url) || "" }));
  if (run.finalUrl) out.push({ url: run.finalUrl, title: run.finalTitle, text: run.finalText, facts: run.finalFacts || null, listing: listings.get(run.finalUrl) || "", final: true });
  return out;
}

/**
 * The end page of a run on the task's own site and whether it is a refusal
 * page. Returns {decided, blocked, signals, onTaskSite, at}: decided is
 * false when the run left no page at all (a run lost before it began).
 */
function siteBlockOf(run) {
  const pages = pagesOf(run || {});
  if (!pages.length) return { decided: false, blocked: false, signals: [] };
  const sites = taskSites(run);
  const onSite = (p) => sites.has(siteOfUrl(p.url));
  let last = -1;
  pages.forEach((p, i) => { if (onSite(p)) last = i; });
  if (last < 0) return { decided: true, blocked: false, signals: [], onTaskSite: false };
  const neverIn = !actedOnPage(run) && pages.slice(0, last + 1).filter(onSite).every((p) => snapshotOf(p).chars <= THIN.chars);
  const verdict = refusalPage(snapshotOf(pages[last]), { onTaskSite: true, neverIn });
  return { decided: true, ...verdict, onTaskSite: true, at: pages[last].final ? "final page" : "an earlier page" };
}

/**
 * The run's final page alone, whatever site it is on: what a hand label of
 * an end page is compared with. The front-door signal applies when the page
 * is on the task's site and the run never saw more than thin pages there.
 */
function endPageOf(run) {
  const pages = pagesOf(run || {});
  const end = pages[pages.length - 1];
  if (!end) return { decided: false, blocked: false, signals: [] };
  const sites = taskSites(run);
  const onTaskSite = sites.has(siteOfUrl(end.url));
  const neverIn = onTaskSite && !actedOnPage(run) && pages.filter((p) => sites.has(siteOfUrl(p.url))).every((p) => snapshotOf(p).chars <= THIN.chars);
  return { decided: true, ...refusalPage(snapshotOf(end), { onTaskSite, neverIn }), onTaskSite };
}

/** The key a hand label is filed under: a hash of the runs' source, the task id and the run, so the file names no task. */
function labelKey(source, id, run) {
  return crypto.createHash("sha256").update(`${source}\n${id}\n${run}`).digest("hex").slice(0, 20);
}

/** Every run.json under some folders, each given as "folder=source" or a folder alone (its name is then the source). */
function storedRuns(folders) {
  const out = [];
  for (const spec of folders) {
    const at = spec.lastIndexOf("=");
    const top = at > 0 ? spec.slice(0, at) : spec;
    const name = at > 0 ? spec.slice(at + 1) : path.basename(path.resolve(top));
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "run.json") { try { out.push({ folder: name, run: JSON.parse(fs.readFileSync(p, "utf8")) }); } catch (_e) { /* a file cut short */ } }
      }
    };
    if (fs.existsSync(top)) walk(top);
  }
  return out;
}

/** Hand labels against the detector: {labelled, agree, missing, differ: [{key, label, detector, signals}]}. */
function compareLabels(runs, labels) {
  const byKey = new Map((labels || []).map((l) => [l.key, l]));
  const differ = [];
  let agree = 0;
  let labelled = 0;
  const seen = new Set();
  for (const { folder, run } of runs) {
    const key = labelKey(folder, run.id, run.run);
    const l = byKey.get(key);
    if (!l) continue;
    seen.add(key);
    labelled++;
    const d = endPageOf(run);
    const said = d.blocked ? "blocked" : "not blocked";
    if (said === l.label) agree++;
    else differ.push({ key, label: l.label, detector: said, signals: d.signals });
  }
  return { labelled, agree, missing: [...byKey.keys()].filter((k) => !seen.has(k)).length, differ };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") throw new Error("Usage: node tests/bench/blocks.js check <run folder>=<source>... --labels <file>");
  const i = rest.indexOf("--labels");
  const labelsFile = i >= 0 ? rest[i + 1] : "";
  const folders = rest.filter((x, j) => j !== i && j !== i + 1);
  const runs = storedRuns(folders);
  const labels = labelsFile ? JSON.parse(fs.readFileSync(labelsFile, "utf8")).labels || [] : [];
  const c = compareLabels(runs, labels);
  const blockedRuns = runs.filter(({ run }) => siteBlockOf(run).blocked).length;
  console.log(`Block detector: ${runs.length} stored run(s), ${blockedRuns} blocked on the task's own site.`);
  if (labels.length) console.log(`Hand labels of end pages: ${c.labelled} found of ${labels.length}, the detector agrees on ${c.agree} of ${c.labelled}${c.missing ? `, ${c.missing} label(s) match no stored run` : ""}.`);
  for (const d of c.differ) console.log(`  differs: label ${d.key} is ${d.label}, the detector says ${d.detector}${d.signals.length ? ` (${d.signals.join(", ")})` : ""}`);
  if (labels.length && (c.agree !== c.labelled || c.missing)) process.exitCode = 1;
}

module.exports = { THIN, WAY_ON, REFUSAL_STATUSES, PASSIVE_TOOLS, actedOnPage, pageFactsInPage, listingFacts, requestToken, snapshotOf, refusalPage, taskSites, pagesOf, siteBlockOf, endPageOf, labelKey, storedRuns, compareLabels };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
}
