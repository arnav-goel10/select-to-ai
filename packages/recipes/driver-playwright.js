/**
 * The Playwright driver: snapshots of a page's controls, actions on them by
 * ref, state-based waits, downloads, and a recording proxy for scripts
 * written against Playwright's own Page and Locator API.
 *
 * Implements the RecipeDriver interface in index.d.ts. Nothing here makes a
 * decision: it reports what is on the page and does what it is told.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pageScript } from "./page-script.js";

const PAGE_SCRIPT = `(${pageScript.toString()})()`;

/* ------------------------------------------------------------------------ */
/* Driver                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * @param {import('playwright').Page} page
 * @param {{actionTimeoutMs?:number, settleQuietMs?:number, settleMaxMs?:number, downloadDir?:string}} [opts]
 */
export function playwrightDriver(page, opts = {}) {
  return new PlaywrightDriver(page, opts);
}

export class PlaywrightDriver {
  constructor(page, opts = {}) {
    this.page = page;
    this.opts = { actionTimeoutMs: 4000, settleQuietMs: 200, settleMaxMs: 4000, ...opts };
    this.frames = [page.mainFrame()];
    this.inflight = new Set();
    this.requests = [];
    this.downloads = [];
    this.pendingDownloads = [];
    this.lastActivity = Date.now();
    this.navigated = 0;
    this.status = 0;
    this.dir = opts.downloadDir || null;
    page.on("request", (r) => { this.inflight.add(r); this.lastActivity = Date.now(); this.requests.push({ method: r.method(), url: r.url(), at: Date.now(), type: r.resourceType() }); if (this.requests.length > 500) this.requests.shift(); });
    const done = (r) => { this.inflight.delete(r); this.lastActivity = Date.now(); };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    page.on("download", (d) => { this.pendingDownloads.push({ d, at: Date.now() }); this.lastActivity = Date.now(); });
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) this.navigated++; });
    page.on("response", (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) this.status = r.status(); });
  }

  async _install(frame) {
    try { await frame.evaluate(PAGE_SCRIPT); return true; } catch { return false; }
  }

  async _frameOffset(frame) {
    if (frame === this.page.mainFrame()) return { x: 0, y: 0 };
    try {
      const fe = await frame.frameElement();
      const b = await fe.boundingBox();
      return b ? { x: b.x, y: b.y } : null;
    } catch { return null; }
  }

  /**
   * A snapshot of the page: controls in every frame, and optionally text items.
   * @param {{texts?:boolean}} [o]
   */
  async snapshot(o = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this._snapshot(o); } catch (e) {
        if (attempt === 2) throw e;
        await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      }
    }
    return null;
  }

  async _snapshot(o) {
    const frames = this.page.frames().filter((f) => !f.isDetached());
    // Keep indices stable for frames we already know.
    for (const f of frames) if (!this.frames.includes(f)) this.frames.push(f);
    const main = this.page.mainFrame();
    let out = null;
    for (const f of frames) {
      const fi = this.frames.indexOf(f);
      if (f !== main && (f.url() === "about:blank" || !f.url())) continue;
      const off = await this._frameOffset(f);
      if (!off) continue;
      if (!(await this._install(f))) { if (f === main) throw new Error("page not ready"); continue; }
      let s;
      try { s = await f.evaluate((x) => window.__s2a.snapshot(x), { texts: !!o.texts }); } catch (e) { if (f === main) throw e; continue; }
      const fix = (e) => { e.ref = `f${fi}e${e.n}`; delete e.n; e.frame = f === main ? 0 : fi; if (off.x || off.y) { e.rect.x += Math.round(off.x); e.rect.y += Math.round(off.y); } return e; };
      s.elements = s.elements.map(fix);
      s.texts = s.texts.map(fix);
      if (f === main) out = { ...s, status: this.status, frames: frames.length };
      else if (out) { out.elements.push(...s.elements); out.texts.push(...s.texts); out.text += `\n${s.text}`; }
      else { out = { url: main.url(), title: "", outline: [], text: s.text, viewport: s.viewport, elements: s.elements, texts: s.texts, status: this.status }; }
    }
    if (!o.texts) delete out.texts;
    if (o.probes && o.probes.length) {
      out.locs = {};
      for (const sel of o.probes) out.locs[sel] = await this._probe(sel);
    }
    return out;
  }

  /**
   * Where a developer's recorded locator points now: the refs it resolves
   * to (only when it resolves to exactly one element). Read-only: it is
   * evidence for the resolver, never something acted on directly.
   */
  async _probe(sel) {
    try {
      const loc = this.page.locator(sel);
      const n = await loc.count();
      if (n !== 1) return { n, refs: [] };
      const h = await loc.elementHandle({ timeout: 500 });
      if (!h) return { n: 0, refs: [] };
      const frame = await h.ownerFrame();
      const fi = this.frames.indexOf(frame);
      if (fi < 0) return { n, refs: [] };
      const r = await frame.evaluate((el) => (window.__s2a ? window.__s2a.refFor(el) : null), h);
      return { n, refs: r ? [`f${fi}${r}`] : [] };
    } catch { return { n: 0, refs: [] }; }
  }

  async _handle(ref) {
    const m = /^f(\d+)e(\d+)$/.exec(String(ref));
    if (!m) throw new Error(`bad ref ${ref}`);
    const frame = this.frames[Number(m[1])];
    if (!frame || frame.isDetached()) throw new Error(`the frame for ${ref} is gone`);
    const h = await frame.evaluateHandle((r) => (window.__s2a ? window.__s2a.map.get(r) || null : null), `e${m[2]}`);
    const el = h.asElement();
    if (!el) throw new Error(`the control ${ref} is no longer on the page`);
    const connected = await el.evaluate((x) => x.isConnected);
    if (!connected) throw new Error(`the control ${ref} is no longer on the page`);
    return el;
  }

  /**
   * Turn a target into a snapshot element: a Playwright Locator, an
   * ElementHandle, a selector string, or {ref}.
   */
  async locate(target) {
    if (target && typeof target === "object" && target.ref) {
      const s = await this.snapshot({ texts: true });
      const el = [...s.elements, ...(s.texts || [])].find((e) => e.ref === target.ref);
      return { ref: target.ref, el: el || null };
    }
    let handle;
    const loc = locatorText(target);
    if (typeof target === "string") handle = await this.page.locator(target).first().elementHandle({ timeout: 5000 });
    else if (target && typeof target.elementHandle === "function" && typeof target.evaluate === "function" && typeof target.asElement !== "function") handle = await target.elementHandle({ timeout: 5000 });
    else if (target && typeof target.asElement === "function") handle = target.asElement();
    else throw new Error("locate: pass a Playwright Locator, an ElementHandle, a selector or {ref}");
    if (!handle) return { ref: null, el: null };
    const frame = await handle.ownerFrame();
    if (!this.frames.includes(frame)) this.frames.push(frame);
    const fi = this.frames.indexOf(frame);
    await this._install(frame);
    const d = await frame.evaluate((el) => window.__s2a.describe(el), handle);
    const off = await this._frameOffset(frame) || { x: 0, y: 0 };
    d.ref = `f${fi}e${d.n}`;
    delete d.n;
    d.frame = frame === this.page.mainFrame() ? 0 : fi;
    d.rect.x += Math.round(off.x); d.rect.y += Math.round(off.y);
    return { ref: d.ref, el: d, loc };
  }

  /**
   * Perform one action. Never throws: failures come back as {ok:false, error}.
   * @param {{do:string, ref?:string, value?:string, key?:string, url?:string}} a
   */
  async act(a) {
    const t0 = Date.now();
    const reqFrom = this.requests.length;
    const timeout = this.opts.actionTimeoutMs;
    const nav0 = this.navigated;
    try {
      switch (a.do) {
        case "navigate":
          this.status = 0;
          await this.page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          break;
        case "back":
          await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
          break;
        case "press":
          if (a.ref) await (await this._handle(a.ref)).press(a.key, { timeout });
          else await this.page.keyboard.press(a.key);
          break;
        case "click":
          await (await this._handle(a.ref)).click({ timeout });
          break;
        case "hover":
          await (await this._handle(a.ref)).hover({ timeout });
          break;
        case "fill":
          await this._fill(await this._handle(a.ref), String(a.value ?? ""), timeout);
          break;
        default:
          return { ok: false, error: `unknown action ${a.do}` };
      }
    } catch (e) {
      await this._settle(t0, nav0).catch(() => {});
      return { ok: false, error: firstLines(e), settleMs: Date.now() - t0, requests: this.requests.slice(reqFrom), downloads: await this._collectDownloads(t0) };
    }
    const settleMs = await this._settle(t0, nav0);
    return { ok: true, settleMs, requests: this.requests.slice(reqFrom).filter((r) => r.type === "xhr" || r.type === "fetch" || r.type === "document").map((r) => ({ method: r.method, url: r.url })), downloads: await this._collectDownloads(t0) };
  }

  async _fill(h, value, timeout) {
    const info = await h.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: el.type ? String(el.type).toLowerCase() : "", role: el.getAttribute("role") || "", checked: el.getAttribute("aria-checked"), editable: el.isContentEditable }));
    const on = /^(on|true|checked|yes)$/i.test(value), off = /^(off|false|unchecked|no)$/i.test(value);
    if (info.tag === "select") {
      try { await h.selectOption({ label: value }, { timeout }); } catch { await h.selectOption(value, { timeout }); }
      return;
    }
    if (info.tag === "input" && (info.type === "checkbox" || info.type === "radio") && (on || off)) { await h.setChecked(on, { timeout }); return; }
    if (["checkbox", "switch", "radio", "menuitemcheckbox"].includes(info.role) && (on || off)) {
      if ((info.checked === "true") !== on) await h.click({ timeout });
      return;
    }
    if (info.editable && info.tag !== "input" && info.tag !== "textarea") {
      await h.click({ timeout });
      await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await this.page.keyboard.insertText(value);
      return;
    }
    await h.fill(value, { timeout });
  }

  /** Wait until the page is quiet: no DOM changes and no requests for a moment. */
  async _settle(t0, nav0) {
    const { settleQuietMs: quiet, settleMaxMs: max } = this.opts;
    const start = Date.now();
    if (this.navigated !== nav0) await this.page.waitForLoadState("domcontentloaded", { timeout: max }).catch(() => {});
    let lastMut = -1, lastChange = Date.now();
    while (Date.now() - start < max) {
      let mut = lastMut;
      try { mut = await this.page.evaluate(() => (window.__s2a ? window.__s2a.mut : -1)); } catch { lastChange = Date.now(); }
      if (mut !== lastMut) { lastMut = mut; lastChange = Date.now(); }
      const busy = [...this.inflight].filter((r) => ["document", "xhr", "fetch", "script", "stylesheet"].includes(r.resourceType())).length;
      const since = Math.min(Date.now() - lastChange, Date.now() - this.lastActivity);
      if (!busy && since >= quiet) break;
      await sleep(50);
    }
    return Date.now() - t0;
  }

  async _collectDownloads(since) {
    const out = [];
    const keep = [];
    for (const p of this.pendingDownloads) {
      if (p.at < since) { keep.push(p); continue; }
      if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), "recipes-dl-"));
      const name = p.d.suggestedFilename();
      const path = join(this.dir, `${Date.now()}-${name}`);
      try {
        await p.d.saveAs(path);
        const buf = readFileSync(path);
        const rec = { name, path, bytes: statSync(path).size, sha256: createHash("sha256").update(buf).digest("hex"), at: p.at };
        this.downloads.push(rec);
        out.push(rec);
      } catch (e) {
        out.push({ name, path: null, bytes: 0, sha256: "", at: p.at, error: firstLines(e) });
      }
    }
    this.pendingDownloads = keep;
    return out;
  }

  /**
   * Wait until `check(snapshot)` is true or the deadline passes. Re-checks
   * after every batch of DOM changes or navigation, with a short poll as a
   * fallback.
   */
  async waitForState(check, { deadlineMs = 5000, texts = false, probes = null } = {}) {
    const t0 = Date.now();
    let snap = null;
    for (;;) {
      snap = await this.snapshot({ texts, probes });
      if (check(snap)) return { held: true, snapshot: snap, elapsedMs: Date.now() - t0 };
      const left = deadlineMs - (Date.now() - t0);
      if (left <= 0) return { held: false, snapshot: snap, elapsedMs: Date.now() - t0 };
      const mut = snap.mut;
      await this.page.mainFrame().waitForFunction((m) => !window.__s2a || window.__s2a.mut !== m, mut, { timeout: Math.min(400, left), polling: 100 }).catch(() => {});
    }
  }

  /** Read a downloaded file. */
  async readFile(path) {
    return readFileSync(path);
  }

  /** A screenshot (PNG, base64) for receipts or a repair model that can see. */
  async screenshot() {
    const buf = await this.page.screenshot({ type: "png" });
    return buf.toString("base64");
  }
}

/**
 * The selector text of what the caller acted on: a selector string, or a
 * Playwright Locator's own selector (without the ".first()" the recording
 * proxy adds). Null when there is none.
 */
function locatorText(target) {
  let sel = null;
  if (typeof target === "string") sel = target;
  else if (target && typeof target === "object" && typeof target._selector === "string") sel = target._selector;
  if (!sel) return null;
  sel = sel.replace(/ >> nth=0$/, "");
  return sel.length <= 400 ? sel : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function firstLines(e) { return String(e && e.message || e).split("\n").slice(0, 3).join(" ").slice(0, 400); }

/* ------------------------------------------------------------------------ */
/* Recording proxy for scripts written against Playwright's Page API.       */
/* ------------------------------------------------------------------------ */

const LOCATOR_FACTORIES = new Set(["locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId", "first", "last", "nth", "filter", "and", "or", "frameLocator", "contentFrame", "owner"]);

function isLocator(x) {
  return x && typeof x === "object" && typeof x.click === "function" && typeof x.fill === "function" && typeof x.elementHandle === "function";
}

/**
 * Wrap a Locator so its actions are recorded.
 * @param {object} loc
 * @param {import('./core/compile.js').Recorder} rec
 */
function wrapLocator(loc, rec) {
  return new Proxy(loc, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      switch (prop) {
        case "click": case "dblclick": case "tap": return async () => { await rec.click(target); };
        case "fill": return async (value) => { await rec.fill(target, value); };
        case "type": case "pressSequentially": return async (value) => { await rec.fill(target, value); };
        case "press": return async (key) => { await rec.press(target, key); };
        case "check": return async () => { await rec.check(target); };
        case "uncheck": return async () => { await rec.uncheck(target); };
        case "setChecked": return async (on) => { await (on ? rec.check(target) : rec.uncheck(target)); };
        case "selectOption": return async (value) => { const v = Array.isArray(value) ? value[0] : value; const s = typeof v === "object" && v ? (v.label ?? v.value) : v; await rec.select(target, s); return [s]; };
        case "hover": return async () => { await rec.hover(target); };
        case "textContent": case "innerText": case "inputValue": return async () => rec.read(target);
        case "setInputFiles": case "dragTo": return () => { throw new Error(`record: ${String(prop)} cannot be recorded in this version`); };
        default:
          if (LOCATOR_FACTORIES.has(prop)) return (...args) => { const r = v.apply(target, args); return isLocator(r) ? wrapLocator(r, rec) : r; };
          return v.bind(target);
      }
    },
  });
}

/**
 * A Page whose actions are recorded: page.goto, page.click(selector),
 * page.fill(selector, value), page.getByRole(...).click() and so on. Reads
 * (textContent, innerText, inputValue) become read steps. Everything else
 * passes through to the real page unrecorded.
 * @param {import('playwright').Page} page
 * @param {import('./core/compile.js').Recorder} rec
 */
export function recordingPage(page, rec) {
  const keyboard = new Proxy(page.keyboard, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (prop === "press") return async (key) => { await rec.press(null, key); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return new Proxy(page, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "keyboard") return keyboard;
      if (typeof v !== "function") return v;
      const loc = (sel) => target.locator(sel).first();
      switch (prop) {
        case "goto": return async (url) => { await rec.goto(url); return null; };
        case "goBack": return async () => { await rec.back(); return null; };
        case "click": case "dblclick": case "tap": return async (sel) => { await rec.click(loc(sel)); };
        case "fill": case "type": return async (sel, value) => { await rec.fill(loc(sel), value); };
        case "press": return async (sel, key) => { await rec.press(loc(sel), key); };
        case "check": return async (sel) => { await rec.check(loc(sel)); };
        case "uncheck": return async (sel) => { await rec.uncheck(loc(sel)); };
        case "selectOption": return async (sel, value) => { const v1 = Array.isArray(value) ? value[0] : value; const s = typeof v1 === "object" && v1 ? (v1.label ?? v1.value) : v1; await rec.select(loc(sel), s); return [s]; };
        case "hover": return async (sel) => { await rec.hover(loc(sel)); };
        case "textContent": case "innerText": case "inputValue": return async (sel) => rec.read(loc(sel));
        default:
          if (LOCATOR_FACTORIES.has(prop)) return (...args) => { const r = v.apply(target, args); return isLocator(r) ? wrapLocator(r, rec) : r; };
          return v.bind(target);
      }
    },
  });
}

export { wrapLocator };
