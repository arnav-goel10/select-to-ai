/**
 * Captures what the agent sees on every decision-eval page, using the
 * extension's real page reader (agentContentScript.js) in a real browser,
 * and saves it to snapshots-v4.json. The eval itself then runs with no browser.
 *
 *   node tests/decisions/capture.js
 *
 * Re-run after changing cases.js or the page reader. Pages are served at
 * their realistic URLs through request interception; nothing hits the web.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CASES } = require("./cases.js");

const EXT = path.resolve(__dirname, "../../extension");
const OUT = path.join(__dirname, "snapshots-v4.json");

// What agent.js hands the model for a tab it cannot read.
function protectedScan(url) {
  return {
    url,
    title: "New Tab",
    elements: [],
    innerText: `[This tab is a protected browser page (${url}). Extensions cannot read or interact with it. Use the navigate action to go to the website this task needs, or open_tab to start one.]`,
    protectedPage: true,
  };
}

async function scanHtml(browser, url, html, prep, task, frames) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  const served = new Map([[url, html], ...(frames || []).map((f) => [f.url, f.html])]);
  page.on("request", (req) => {
    if (served.has(req.url())) req.respond({ status: 200, contentType: "text/html", body: served.get(req.url()) });
    else req.respond({ status: 404, body: "" });
  });
  // The content script only needs chrome.runtime.onMessage; capture its listener.
  // A frame keeps the token the page hands it, as the engine's announceFrame does.
  await page.evaluateOnNewDocument(() => {
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      onMessage: { addListener: (fn) => { window.__s2aListener = fn; } },
      sendMessage: () => {},
      getURL: (p) => p,
    };
    window.addEventListener("message", (e) => { if (e.data && typeof e.data.selectToAiFrame === "string") window.__s2aToken = e.data.selectToAiFrame; });
  });
  await page.goto(url, { waitUntil: "load" });
  if (prep) await page.evaluate(prep);
  const inject = async (frame) => {
    for (const file of ["agentTools.js", "agentContentScript.js"]) await frame.addScriptTag({ content: fs.readFileSync(path.join(EXT, file), "utf8") });
  };
  await inject(page);
  // What the engine reads: every control on the page.
  const request = { action: "scan", limit: 500, whole: true };
  const ask = (frame, r) => frame.evaluate((m) => new Promise((resolve) => window.__s2aListener(m, {}, resolve)), r);
  const scan = await ask(page, { ...request, task: task || "" });
  if (scan.frames) await readFrames(page, scan, task, inject, ask);
  await page.close();
  return scan;
}

/**
 * The frames the v4 engine reads as part of the page (engine.js readFrames),
 * read the same way: the page names them, each is scanned on its own, and
 * its controls join the listing numbered after the page's own.
 */
async function readFrames(page, scan, task, inject, ask) {
  const FRAME_BASE = 100000;
  const offered = await ask(page, { action: "frameTokens" });
  await new Promise((r) => setTimeout(r, 200));
  const children = page.frames().filter((f) => f !== page.mainFrame());
  let k = 0;
  for (const f of (offered.frames || []).slice(0, 3)) {
    let frame = null;
    for (const c of children) if (await c.evaluate(() => window.__s2aToken).catch(() => null) === f.token) frame = c;
    if (!frame) continue;
    await inject(frame);
    const got = await ask(frame, { action: "scan", limit: 120, task: task || "", whole: true, inFrame: true });
    if (!got || !Array.isArray(got.elements) || !got.elements.length) continue;
    k += 1;
    const name = `frame${f.label ? ` "${f.label}"` : ""}`;
    for (const el of got.elements) {
      scan.elements.push({
        ...el, id: k * FRAME_BASE + el.id, frame: k, position: f.position || el.position,
        ...(f.onTop ? { onTop: true } : {}),
        groupKey: `f${k}:${el.groupKey || 0}`, groupKind: el.groupKind || "frame", group: el.group ? `${name} > ${el.group}` : name,
      });
    }
    const text = String(got.innerText || "").trim();
    if (text) scan.innerText = `${scan.innerText || ""}\n\n[In the ${name} on this page]\n${text.slice(0, 3000)}`;
    for (const b of got.blockers || []) (scan.blockers = scan.blockers || []).push({ ...b, whole: false });
    if (f.onTop) for (const o of scan.overlays || []) if (o.framed && !o.controls) { o.framed = false; o.controls = got.elements.length; break; }
  }
}

/**
 * History written against the page's controls: idOf (and submitOf for a
 * form sent with a button) name the control by its words, and idOffset
 * points that many numbers away from it, for a control that has moved.
 */
function resolveIds(entries, scan) {
  const lines = (scan.elements || []).map((el) => ({ id: el.id, text: [el.accName, el.text, el.label, el.placeholder].filter(Boolean).join(" ") }));
  const find = (re) => {
    const hit = lines.find((l) => re.test(l.text));
    if (!hit) throw new Error(`${re} matched no element`);
    return hit.id;
  };
  return (entries || []).map((h) => {
    if (!h.action || !(h.action.idOf || h.action.submitOf)) return h;
    const { idOf, idOffset, submitOf, ...rest } = h.action;
    const action = idOf ? { ...rest, id: find(idOf) + (idOffset || 0) } : { ...rest, submitId: find(submitOf) };
    return { ...h, action, message: String(h.message).replace(/\{id\}/g, idOf ? action.id : action.submitId) };
  });
}

(async () => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-first-run"] });
  const snapshots = {};
  try {
    for (const c of CASES) {
      const scan = c.protectedPage ? protectedScan(c.url) : await scanHtml(browser, c.url, c.html, c.prep, c.task, c.frames);
      const tabs = await Promise.all(
        (c.otherTabs || []).map(async (t) => ({
          ...t,
          scan: t.html ? await scanHtml(browser, t.url, t.html) : null,
        })),
      );
      snapshots[c.name] = { scan, history: resolveIds(c.history, scan), tabs };
      console.log(`captured ${c.name.padEnd(32)} ${scan.elements.length} elements, ${String(scan.innerText || "").length} chars`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(snapshots, null, 1));
  console.log(`\n${Object.keys(snapshots).length} snapshots written to ${path.relative(process.cwd(), OUT)}`);
})().catch((e) => { console.error(e); process.exit(1); });
