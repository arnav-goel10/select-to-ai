/**
 * Recording: run a scripted automation once through a driver, capture a
 * before and after snapshot around every action, and compile the tape into
 * a recipe (design §2). Driver-agnostic: the driver turns whatever the
 * caller passes as a target (a Playwright locator, a selector, a ref) into
 * a snapshot element with `locate`.
 */
import { fingerprintOf, labelOf, gate } from "./fingerprint.js";
import { neighbourhoodOf, markRecordData, recordCells } from "./drift.js";
import { derivePost } from "./post.js";
import { templatize, fill, wordsOf, maskDigits, clip, slotsOf, snakeName } from "./text.js";
import { urlPattern, siteOf } from "./url.js";
import { inferVariables } from "./vars.js";
import { SCHEMA, newId, newCounters, validate } from "./schema.js";
import { actionText } from "./repair.js";

/** deadlineMs = clamp(3 × recordedSettleMs + 2000, 3000, 20000) (design §3.3). */
export function deadlineFor(settleMs) {
  return Math.max(3000, Math.min(20000, Math.round(3 * (settleMs || 0) + 2000)));
}

const CLASS_RANK = { read: 0, edit: 1, commit: 2 };
const higher = (a, b) => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);

/**
 * Reversibility class from what was observed (design §4.5): commit when the
 * action submits a non-search form or sent a state-changing request; edit
 * for a fill or toggle outside a search form; read otherwise.
 */
export function classOf(entry) {
  const a = entry.action, el = entry.el;
  const searchForm = !!(el && el.form && el.form.search);
  const sentWrite = (entry.requests || []).some((r) => r.method && !/^(GET|HEAD|OPTIONS)$/i.test(r.method));
  let cls = "read";
  if (a.do === "fill") cls = searchForm ? "read" : "edit";
  if (a.do === "click" && el && ["checkbox", "radio", "switch"].includes(el.kind)) cls = "edit";
  if (a.do === "click" && el && el.submits && !searchForm) cls = "commit";
  if (a.do === "press" && a.key === "Enter" && el && el.form && !searchForm && (el.form.fields | 0) > 0) cls = "commit";
  if (sentWrite && a.do !== "navigate") cls = "commit";
  if (entry.declaredClass) cls = higher(cls, entry.declaredClass);
  return cls;
}

function pageSig(snap, bindings) {
  return {
    url: snap && snap.url ? urlPattern(snap.url, bindings) : null,
    titleWords: snap ? [...new Set(wordsOf(templatize(snap.title, bindings)).filter((w) => !/\d/.test(w)))].slice(0, 6) : [],
    outline: snap ? (snap.outline || []).slice(0, 6).map((h) => maskDigits(clip(templatize(h, bindings), 80))) : [],
    forms: [],
  };
}

/**
 * The recorder. `api` is what the caller's script uses.
 */
export class Recorder {
  /**
   * @param {object} driver  a RecipeDriver
   * @param {{vars?:Record<string,string>, title?:string, request?:string}} [opts]
   */
  constructor(driver, opts = {}) {
    this.driver = driver;
    this.vars = { ...(opts.vars || {}) };
    for (const k of Object.keys(this.vars)) this.vars[k] = String(this.vars[k]);
    this.opts = opts;
    this.tape = [];
    this.uses = [];
    this.extracts = [];
    this.done = null;
    this.startUrl = null;
    this.reads = 0;
    this.secretVars = new Set();
    this.secrets = opts.secrets || {};
  }

  /** A literal or {var} template given by the caller, as a template and as the value to type. */
  _value(v) {
    const s = String(v);
    if (slotsOf(s).length) {
      for (const n of slotsOf(s)) if (!(n in this.vars)) throw new Error(`record: {${n}} is used but no value was given for it in opts.vars`);
      return { template: s, literal: fill(s, this.vars) };
    }
    // A literal equal to a variable's value becomes that variable (design §2.3).
    const exact = Object.entries(this.vars).find(([, x]) => x === s);
    if (exact) return { template: `{${exact[0]}}`, literal: s };
    return { template: templatize(s, this.vars), literal: s };
  }

  async _snap(texts) {
    return this.driver.snapshot({ texts: !!texts });
  }

  async goto(url) {
    const before = this.tape.length ? await this._snap() : null;
    const { template, literal } = this._value(url);
    const t0 = Date.now();
    const r = await this.driver.act({ do: "navigate", url: literal });
    if (r.ok === false) throw new Error(`record: could not open ${literal}: ${r.error}`);
    const after = await this._snap();
    if (!this.startUrl) this.startUrl = after.url;
    // Keep {var} slots; make a relative address absolute against where we ended up.
    let urlT = template;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(template)) {
      try { const o = new URL(after.url); urlT = template.startsWith("/") ? `${o.origin}${template}` : templatize(new URL(literal, after.url).href, this.vars); } catch { /* keep */ }
    }
    this._push({ action: { do: "navigate", url: urlT }, el: null, ref: null, before: before || emptySnap(), after, settleMs: r.settleMs || 0, downloads: r.downloads || [], requests: r.requests || [], since: t0 });
  }

  async back() {
    const before = await this._snap();
    const t0 = Date.now();
    const r = await this.driver.act({ do: "back" });
    if (r.ok === false) throw new Error(`record: could not go back: ${r.error}`);
    const after = await this._snap();
    this._push({ action: { do: "back" }, el: null, ref: null, before, after, settleMs: r.settleMs || 0, downloads: [], requests: r.requests || [], since: t0 });
  }

  async _target(target, opts, action) {
    const before = await this._snap(action.do === "read");
    const { ref, el, loc } = await this.driver.locate(target);
    if (!el) throw new Error("record: the target was not found on the page");
    const pool = action.do === "read" ? "texts" : "elements";
    if (!(before[pool] || []).some((e) => e.ref === ref) && !(before.elements || []).some((e) => e.ref === ref)) {
      before[pool] = [...(before[pool] || []), el];
    }
    return { before, ref, el, loc: loc || null };
  }

  async _act(target, action, opts = {}) {
    const { before, ref, el, loc } = await this._target(target, opts, action);
    const literalAction = { ...action, ref };
    let templ = { ...action };
    if (action.do === "fill") {
      let { template, literal } = this._value(action.value);
      if (el.sensitive) {
        // A password, card or code is never stored: it becomes a secret
        // variable the caller supplies at replay (handed back in opts.secrets).
        if (!slotsOf(template).length) {
          const taken = new Set([...Object.keys(this.vars), ...this.secretVars]);
          const name = snakeName(el.sensitive === "password" ? "password" : el.name || el.sensitive, taken);
          template = `{${name}}`;
          this.secrets[name] = literal;
        }
        for (const n of slotsOf(template)) { this.secretVars.add(n); if (n in this.vars) this.secrets[n] = this.vars[n]; }
      }
      templ.value = template;
      literalAction.value = literal;
      for (const n of slotsOf(template)) this.uses.push({ name: n, el });
    }
    const t0 = Date.now();
    const r = await this.driver.act(literalAction);
    if (r.ok === false) throw new Error(`record: ${action.do} failed: ${r.error}`);
    const after = await this._snap();
    this._push({ action: templ, el, ref, before, after, settleMs: r.settleMs || 0, downloads: r.downloads || [], requests: r.requests || [], since: t0, intent: opts.intent, declaredClass: opts.class, loc });
    return r;
  }

  async click(target, opts) { return this._act(target, { do: "click" }, opts); }
  async hover(target, opts) { return this._act(target, { do: "hover" }, opts); }
  async fill(target, value, opts) { return this._act(target, { do: "fill", value: String(value) }, opts); }
  async select(target, value, opts) { return this._act(target, { do: "fill", value: String(value) }, opts); }
  async check(target, opts) { return this._act(target, { do: "fill", value: "on" }, opts); }
  async uncheck(target, opts) { return this._act(target, { do: "fill", value: "off" }, opts); }
  async press(target, key, opts) {
    if (target == null) {
      const before = await this._snap();
      const t0 = Date.now();
      const r = await this.driver.act({ do: "press", key });
      if (r.ok === false) throw new Error(`record: press ${key} failed: ${r.error}`);
      const after = await this._snap();
      this._push({ action: { do: "press", key, onTarget: false }, el: null, ref: null, before, after, settleMs: r.settleMs || 0, downloads: r.downloads || [], requests: r.requests || [], since: t0, intent: opts && opts.intent, declaredClass: opts && opts.class });
      return r;
    }
    return this._act(target, { do: "press", key, onTarget: true }, opts);
  }
  /** Click something that downloads a file; the receipt keeps the file's name, size and hash. */
  async download(target, opts) {
    const r = await this._act(target, { do: "click" }, opts);
    if (!r.downloads || !r.downloads.length) throw new Error("record: the click did not download a file");
    return r.downloads[r.downloads.length - 1];
  }

  /**
   * Read a value from the page; it becomes part of the run's answer.
   * @returns {Promise<string>}
   */
  async read(target, name, opts = {}) {
    const n = name || `value${++this.reads}`;
    const { before, ref, el, loc } = await this._target(target, opts, { do: "read" });
    const value = el.tag === "input" || el.tag === "select" || el.tag === "textarea" ? String(el.value ?? "") : String(el.text || el.name || "");
    this.extracts.push({ name: n, value });
    this._push({ action: { do: "read", name: n }, el, ref, before, after: before, settleMs: 0, downloads: [], requests: [], since: Date.now(), intent: opts.intent, read: true, loc, value });
    return value.trim();
  }

  /**
   * Declare what proves the whole task is done: text that must be on the
   * final page (with {var} slots allowed), checked at the end of every replay.
   */
  async expectText(text) {
    const { template } = this._value(text);
    const snap = await this._snap();
    if (!snap.text || !snap.text.toLowerCase().includes(fill(template, this.vars).toLowerCase())) throw new Error(`record: "${text}" is not on the page now, so it cannot be the end check`);
    this.done = [...(this.done || []), { k: "text", contains: template, where: "visible" }];
  }

  _push(entry) {
    const a = entry.action;
    if (!entry.read) {
      entry.post = derivePost({ action: a, ref: entry.ref, el: entry.el }, entry.before, entry.after, this.vars, {
        downloads: entry.downloads, since: entry.since,
        target: entry.el ? fingerprintOf(entry.el, entry.before, this.vars) : null,
      });
    }
    this.tape.push(entry);
  }

  /** Compile the tape into a recipe. */
  compile() {
    if (!this.tape.length) throw new Error("record: nothing was recorded");
    const vars = this.vars;
    const tape = this.tape;
    const seeks = foldSeeks(tape, vars);
    // Cells of rows chosen by a value, so far: that record's own data.
    const cells = [];
    const steps = tape.filter((e) => !e.folded).map((e, i) => {
      const id = `s${i + 1}`;
      const cls = e.read ? "read" : classOf(e);
      const target = e.el ? fingerprintOf(e.el, e.before, vars, { read: !!e.read }) : null;
      // The developer's own locator, kept as one more piece of evidence.
      if (target && e.loc) target.loc = templatize(e.loc, vars);
      // What the step means, in the words around it (round 3, fix 19).
      if (target && target.scope) cells.push(...recordCells(e.el, e.before));
      // Edit, commit and extract steps; a download is an extract (its file is the result).
      const extract = e.read || (e.post && e.post.all.some((p) => p.k === "download"));
      let ctx = target && (cls !== "read" || extract) ? neighbourhoodOf(e.el, e.before, vars, { read: !!e.read, scoped: !!target.scope, value: e.value }) : null;
      if (ctx && cells.length) ctx = markRecordData(ctx, cells);
      const label = e.el ? clip(templatize(labelOf(e.el), vars), 60) : "";
      const intent = e.intent || `${actionText(e.action, {})}${label ? ` "${label}"` : ""}`;
      return {
        id, intent, class: cls, risk: [],
        pre: { page: pageSig(e.before.url ? e.before : null, vars), targetPresent: !!target, noBlockers: true },
        action: e.action,
        target,
        post: e.read ? { all: [], strength: "strong" } : e.post,
        wait: { recordedSettleMs: e.settleMs || 0, deadlineMs: deadlineFor(e.settleMs) },
        ...(seeks.has(e) ? { seek: seeks.get(e) } : {}),
        ...(ctx && Object.keys(ctx).length ? { ctx } : {}),
      };
    });
    const variables = inferVariables(Object.fromEntries(Object.entries(vars).filter(([k]) => !this.secretVars.has(k))), this.uses);
    for (const name of this.secretVars) variables.push({ name, type: "secret", required: true, source: "user_typed", checked: "none" });
    const last = [...steps].reverse().find((s) => s.action.do !== "read" && s.post.strength === "strong");
    const done = this.done || (last ? last.post.all.filter((p) => p.k !== "value" && p.k !== "download") : []);
    const doneFinal = done.length ? done : (last ? last.post.all : []);
    const extract = this.extracts.map((x, i) => ({ name: x.name, at: steps.filter((s) => s.action.do === "read")[i].id }));
    const sites = [...new Set(this.tape.map((e) => e.after && e.after.url).filter((u) => /^https?:/.test(u || "")).map(siteOf))];
    const now = Date.now();
    const id = newId("rcp");
    const title = this.opts.title || clip(`${steps.map((s) => s.intent).slice(0, 3).join(", ")}`, 120);
    const recipe = {
      schema: SCHEMA,
      id, lineage: id,
      title,
      request: clip(this.opts.request || title, 500),
      sites,
      start: { url: this.startUrl ? urlPattern(this.startUrl, vars) : null, newTab: false },
      variables,
      steps,
      result: { kind: extract.length ? "extract" : "action", ...(extract.length ? { extract } : {}), done: extract.length && !this.done ? [] : doneFinal },
      state: "draft",
      trust: null,
      schedule: null,
      provenance: { source: "record", compiledAt: now, compiler: "recipes/0.1", author: "you" },
      versions: [{ v: 1, at: now, by: "record", parent: null, ops: [], steps: structuredClone(steps), status: "active" }],
      active: 0,
      counters: newCounters(),
    };
    const v = validate(recipe);
    if (!v.ok) throw new Error(`record: the compiled recipe is invalid: ${v.errors.slice(0, 5).join("; ")}`);
    return recipe;
  }
}

/**
 * Clicks that only paged through a list until the item a variable chose
 * appeared ("Next" twice, then the row's Edit) depend on where that item
 * happened to be. They are folded into the following step as a seek: at
 * replay the step presses that control only while its item is not shown.
 * The rule is structural: the clicks are read-class, on one control, and the
 * next step's item was absent before them and present after.
 */
function foldSeeks(tape, vars) {
  const out = new Map();
  for (let i = 0; i < tape.length; i++) {
    const e = tape[i];
    if (!e.el || e.action.do === "navigate") continue;
    const fp = fingerprintOf(e.el, e.before, vars, { read: !!e.read });
    if (!fp.scope) continue;
    let j = i - 1;
    const run = [];
    while (j >= 0 && tape[j].action.do === "click" && tape[j].el && !tape[j].read && classOf(tape[j]) === "read" && !scopeShown(fp, tape[j].before, vars)) {
      if (run.length && labelOf(run[0].el) !== labelOf(tape[j].el)) break;
      run.unshift(tape[j]);
      j--;
    }
    if (!run.length || !scopeShown(fp, e.before, vars)) continue;
    for (const r of run) r.folded = true;
    out.set(e, { target: fingerprintOf(run[0].el, run[0].before, vars), max: 12 });
  }
  return out;
}

function scopeShown(fp, snap, vars) {
  if (!snap) return false;
  const pool = [...(snap.elements || []), ...(snap.texts || [])];
  return pool.some((el) => !gate({ ...fp, attrs: { ...fp.attrs, sensitive: el.sensitive || undefined, frame: el.frame || 0 } }, el, null, vars));
}

function emptySnap() {
  return { url: "", title: "", outline: [], text: "", elements: [], texts: [], viewport: { w: 1280, h: 800 } };
}
