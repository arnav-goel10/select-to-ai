/**
 * Generality check for the page reader, with no model and no hand-written
 * questions, on pages that were never used for tuning (wild-sites.js).
 *
 *   node tests/reading/wild.js                 (needs network)
 *   WILD_OLD=<git ref> node tests/reading/wild.js   (compare with an older reader)
 *   WILD_ONLY=news,docs   WILD_REPORT=out.json
 *
 * The reference for "what is the content of this page" is Mozilla
 * Readability (Firefox Reader View), not anything written here. Per page:
 *
 * - kept:    share of Readability's sentences present in the reader's text
 * - on-topic: share of the reader's text that is also in Readability's
 *            (clutter proxy; only meaningful on article-like pages, so the
 *            summary reports it for those categories only)
 * - find:    in-page search, queried with words from sentences picked at
 *            evenly spaced positions of the page, must return that sentence.
 *            "rare" uses the sentence's rarest words, "loose" three words at
 *            random (seeded), which is closer to how people half-remember text.
 * - elements: count and prompt characters of the element list, duplicates
 *
 * Pages that are bot-walled for a headless browser are reported and left out
 * of the averages; in the extension the user's own browser loads them.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { SITES } = require("./wild-sites.js");

const ROOT = path.resolve(__dirname, "../..");
const EXT = path.join(ROOT, "extension");
const OLD_REF = process.env.WILD_OLD || "";
const ONLY = (process.env.WILD_ONLY || "").split(",").filter(Boolean);
const ARTICLE_LIKE = new Set(["reference", "docs", "lifestyle", "paper", "gov"]);
const READABILITY = fs.readFileSync(require.resolve("@mozilla/readability/Readability.js"), "utf8");

function loadReader(ref) {
  if (!ref) {
    return {
      name: "current",
      files: ["agentTools.js", "agentContentScript.js"].map((f) => fs.readFileSync(path.join(EXT, f), "utf8")),
      tools: require(path.join(EXT, "agentTools.js")),
      page: require(path.join(EXT, "pageSearch.js")),
    };
  }
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "s2a-old-"));
  for (const f of ["agentTools.js", "agentContentScript.js", "commonWords.js"]) {
    try { fs.writeFileSync(path.join(dir, f), execFileSync("git", ["show", `${ref}:extension/${f}`], { cwd: ROOT })); } catch (_e) { /* not in that version */ }
  }
  return {
    name: ref,
    files: ["agentTools.js", "agentContentScript.js"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")),
    tools: require(path.join(dir, "agentTools.js")),
    page: null,
  };
}

const words = (s) => String(s || "").toLowerCase().replace(/\]\([^)]*\)/g, "]").match(/[\p{L}\p{N}]+/gu) || [];
const shingles = (ws, n = 4) => { const out = []; for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(" ")); return out; };
function sentencesOf(text) {
  return String(text || "").split(/\n+/).flatMap((l) => l.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/))
    .map((s) => s.trim()).filter((s) => s.length >= 50 && s.length <= 400 && words(s).length >= 8);
}
function coverage(sentence, set) {
  const sh = shingles(words(sentence));
  return sh.length ? sh.filter((x) => set.has(x)).length / sh.length : 0;
}
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const BLOCKED = /captcha|access denied|are you a (robot|human)|verify you are (a )?human|unusual traffic|just a moment|enable javascript and cookies|request blocked|pardon our interruption|robot check|403 forbidden/i;

async function scanWith(browser, url, reader) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setBypassCSP(true);
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      window.chrome = window.chrome || {};
      window.chrome.runtime = { onMessage: { addListener: (fn) => { window.__s2aListener = fn; } }, sendMessage: () => {}, getURL: (x) => x };
    });
    // Ad-heavy pages never go network-idle; give scripts a few seconds after load instead.
    try { await page.goto(url, { waitUntil: "load", timeout: 30000 }); } catch (_e) { /* scan whatever loaded */ }
    await new Promise((r) => setTimeout(r, 3000));
    const probe = await page.evaluate(() => ({ title: document.title, text: (document.body && document.body.innerText || "").slice(0, 3000), len: (document.body && document.body.innerText || "").length }));
    let reference = "";
    if (reader.withReference) {
      await page.addScriptTag({ content: READABILITY });
      reference = await page.evaluate(() => {
        // Rendered text of Readability's article, so blocks are separated by
        // line breaks (its textContent runs "Free" and "A simpler way" together).
        try {
          const r = new Readability(document.cloneNode(true)).parse();
          if (!r || !r.content) return "";
          const box = document.createElement("div");
          box.style.cssText = "position:absolute;left:-99999px;top:0;width:1200px";
          box.innerHTML = r.content;
          document.body.appendChild(box);
          const text = box.innerText;
          box.remove();
          return text;
        } catch (_e) { return ""; }
      });
    }
    for (const content of reader.files) await page.addScriptTag({ content });
    const scan = await page.evaluate(() => new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      window.__s2aListener({ action: "scan", limit: 60, task: "" }, {}, (r) => { clearTimeout(t); resolve(r); });
    }));
    return { probe, reference, scan };
  } finally {
    await page.close().catch(() => {});
  }
}

function findHit(reader, text, query, sentence) {
  const target = new Set(words(sentence));
  let hits;
  if (reader.page) hits = reader.page.findInText(text, query, { maxHits: 3, budget: 1800 }).map((h) => h.text || h.snippet || String(h));
  else hits = reader.tools.relevantPassages(text, query, { max: 3, maxChars: 600 });
  return hits.some((h) => { const w = new Set(words(h)); let n = 0; for (const t of target) if (w.has(t)) n++; return n / target.size >= 0.6; });
}

function measure(reader, scan, reference) {
  seed = 7; // same queries for every reader and every run
  const text = (scan && scan.innerText) || "";
  const refSents = sentencesOf(reference);
  const extSet = new Set(shingles(words(text)));
  const refSet = new Set(shingles(words(reference)));
  const kept = refSents.length ? refSents.filter((s) => coverage(s, extSet) >= 0.8).length / refSents.length : null;
  const extSh = shingles(words(text));
  const onTopic = extSh.length && refSet.size ? extSh.filter((x) => refSet.has(x)).length / extSh.length : null;
  const els = (scan && scan.elements) || [];
  const lines = els.map((e) => reader.tools.formatElementLine(e, {}));
  const keyOf = (e) => `${String(e.text || e.label || "").trim().toLowerCase()}|${e.href || ""}`;
  const dupes = els.length - new Set(els.map(keyOf)).size;
  // Sentences at evenly spaced positions of the reference, queried two ways.
  const freq = {};
  for (const w of words(reference)) freq[w] = (freq[w] || 0) + 1;
  const STOP = new Set(words("the a an and or of to in on for with is are was were be been by as at from that this it its which who what when where how why not but can will would should could has have had their they them there these those than then also into about more most such other some any all each only over after before under between during through while"));
  const picks = refSents.length ? [0.1, 0.3, 0.5, 0.7, 0.9].map((q) => refSents[Math.min(refSents.length - 1, Math.floor(q * refSents.length))]) : [];
  let rareHits = 0, looseHits = 0, asked = 0;
  for (const s of [...new Set(picks)]) {
    if (coverage(s, extSet) < 0.8) { asked++; continue; } // not in the text at all: counts as a miss
    const content = [...new Set(words(s).filter((w) => w.length > 2 && !STOP.has(w)))];
    if (content.length < 4) continue;
    asked++;
    const rare = [...content].sort((a, b) => (freq[a] || 0) - (freq[b] || 0)).slice(0, 4).join(" ");
    const loose = [...content].sort(() => rand() - 0.5).slice(0, 3).join(" ");
    if (findHit(reader, text, rare, s)) rareHits++;
    if (findHit(reader, text, loose, s)) looseHits++;
    else if (process.env.WILD_DEBUG) console.log(`  [${reader.name}] loose miss: "${loose}" <- ${s.slice(0, 110)}`);
  }
  return {
    chars: text.length, refChars: reference.length, refSentences: refSents.length,
    kept, onTopic,
    findRare: asked ? rareHits / asked : null, findLoose: asked ? looseHits / asked : null, asked,
    elements: els.length, elementChars: lines.join("\n").length, dupes,
  };
}

(async () => {
  const puppeteer = require("puppeteer");
  const readers = [loadReader("")];
  if (OLD_REF) readers.push(loadReader(OLD_REF));
  readers[0].withReference = true;
  const browser = await puppeteer.launch({ headless: true, args: ["--no-first-run"] });
  const rows = [];
  try {
    const todo = SITES.filter(([c]) => !ONLY.length || ONLY.includes(c));
    const results = new Array(todo.length);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next++;
        results[i] = await measureSite(browser, readers, todo[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    rows.push(...results);
  } finally {
    await browser.close();
  }
  report(readers, rows);
})().catch((e) => { console.error(e); process.exit(1); });

async function measureSite(browser, readers, [category, url]) {
      const row = { category, url };
      const first = await scanWith(browser, url, readers[0]).catch((e) => ({ error: e.message }));
      const blocked = !first.probe || first.error || BLOCKED.test(`${first.probe.title} ${first.probe.text.slice(0, 600)}`) || first.probe.len < 150;
      row.blocked = !!blocked;
      if (!blocked) {
        row[readers[0].name] = measure(readers[0], first.scan, first.reference);
        for (const r of readers.slice(1)) {
          const other = await scanWith(browser, url, r).catch(() => null);
          row[r.name] = other && other.scan ? measure(r, other.scan, first.reference) : null;
        }
      }
      const fmt = (m) => (m ? `kept ${pct(m.kept)} on-topic ${pct(m.onTopic)} find ${pct(m.findRare)}/${pct(m.findLoose)} text ${String(m.chars).padStart(6)} els ${String(m.elements).padStart(2)} (${String(m.elementChars).padStart(5)}c, ${m.dupes} dup)` : "n/a");
      console.log(`${category.padEnd(9)} ${url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 44).padEnd(44)} ${row.blocked ? "BLOCKED for headless" : readers.map((r) => `${r.name}: ${fmt(row[r.name])}`).join("  |  ")}`);
      return row;
}

function report(readers, rows) {
  const ok = rows.filter((r) => !r.blocked);
  console.log(`\n${ok.length} pages measured, ${rows.length - ok.length} bot-walled for headless (left out).`);
  console.log("\n| reader | pages | content kept | on-topic (article-like) | find: rare words | find: loose words | empty reads | avg element chars | duplicate elements |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of readers) {
    const ms = ok.map((x) => x[r.name]).filter(Boolean);
    const avg = (f, set = ms) => { const v = set.map(f).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const art = ok.filter((x) => ARTICLE_LIKE.has(x.category)).map((x) => x[r.name]).filter(Boolean);
    const empty = ms.filter((m) => m.chars < 200 && m.refChars > 500).length;
    console.log(`| ${r.name} | ${ms.length} | ${pct(avg((m) => m.kept))} | ${pct(avg((m) => m.onTopic, art))} | ${pct(avg((m) => m.findRare))} | ${pct(avg((m) => m.findLoose))} | ${empty} | ${Math.round(avg((m) => m.elementChars) || 0)} | ${(avg((m) => m.dupes) || 0).toFixed(1)} |`);
  }
  if (process.env.WILD_REPORT) fs.writeFileSync(process.env.WILD_REPORT, JSON.stringify(rows, null, 2));
}

function pct(x) { return x === null || x === undefined ? "  - " : `${String(Math.round(x * 100)).padStart(3)}%`; }
