/**
 * The recipe format `select-to-ai.recipe/1` and its strict validator
 * (design §1.2). Unknown keys, wrong types and out-of-range values are
 * rejected. A recipe is data only: no code, selectors or regular
 * expressions are ever evaluated from it (design §7.2). Pure functions.
 */

export const SCHEMA = "select-to-ai.recipe/1";

const CAPS = { steps: 60, bytes: 256 * 1024, variables: 32 };

// A tiny structural type language: "string", "number", "boolean", "null",
// ["enum", ...values], { key: type } (strict object), [type] (array),
// { "?key": type } optional, { "*": type } a record, ["or", t1, t2].
const S = "string", N = "number", B = "boolean";
const opt = (t) => ({ __opt: t });
const or = (...ts) => ["or", ...ts];
const en = (...vs) => ["enum", ...vs];
const rec = (t) => ({ "*": t });

const UrlPattern = { origin: S, path: S, query: rec(S) };
const Rect = { x: N, y: N, w: N, h: N, vw: N, vh: N };
const FpAttrs = {
  kind: S,
  accName: opt(S), label: opt(S), text: opt(S), placeholder: opt(S), title: opt(S), name: opt(S),
  htmlId: opt(S), testId: opt(S), autocomplete: opt(S), inputType: opt(S), hrefPath: opt(S),
  options: opt([S]), group: opt(S), groupKind: opt(S),
  form: opt({ action: S, search: B, fields: N }),
  heading: opt(S), column: opt(S), ancestors: opt([S]), siblings: opt([S]), marked: opt(S),
  ordinal: { of: N, n: N }, rect: opt(Rect), frame: N, onTop: B, sensitive: opt(S), submits: opt(B),
};
const Fingerprint = {
  attrs: FpAttrs,
  weights: rec(N),
  scope: opt({ groupKind: en("item"), contains: S }),
  ambiguousAtRecord: N,
  read: opt(B),
  loc: opt(S),
};
const Predicate = or(
  { k: en("url"), match: UrlPattern },
  { k: en("page"), match: UrlPattern, heading: opt(S), rel: opt({ up: N, tail: [S] }) },
  { k: en("title"), words: [S] },
  { k: en("appears"), target: Fingerprint, minScore: N },
  { k: en("gone"), target: Fingerprint, minScore: opt(N) },
  { k: en("value"), of: S, equals: S },
  { k: en("text"), contains: S, where: opt(en("visible", "page")) },
  { k: en("download"), ext: opt(S) },
  { k: en("changed") },
);
const Action = or(
  { do: en("navigate"), url: S },
  { do: en("click", "hover") },
  { do: en("fill"), value: S },
  { do: en("press"), key: S, onTarget: B },
  { do: en("back") },
  { do: en("read"), name: S },
);
const Step = {
  id: S,
  intent: S,
  class: en("read", "edit", "commit"),
  risk: [S],
  pre: { page: { url: or(UrlPattern, "null"), titleWords: [S], outline: [S], forms: [{ action: S, labels: [S] }] }, targetPresent: B, noBlockers: B, fieldsHold: opt([{ step: S, value: S }]) },
  action: Action,
  target: or(Fingerprint, "null"),
  post: { all: [Predicate], strength: en("strong", "weak"), capture: opt([{ name: S, near: S, shape: S }]) },
  wait: { recordedSettleMs: N, deadlineMs: N },
  approval: opt({ by: en("user"), at: N, receiptId: S }),
  optional: opt(B),
  seek: opt({ target: Fingerprint, max: N }),
  ctx: opt(rec(S)),
};
const Variable = {
  name: S,
  type: en("text", "enum", "date", "number", "profile", "secret"),
  required: B,
  example: opt(S), default: opt(S), enum: opt([S]), format: opt(S), min: opt(N), max: opt(N), profileKey: opt(S),
  source: en("request", "user_typed", "profile", "user_marked"),
  checked: en("second_value", "preview", "none"),
};
const Op = { op: en("retarget", "insert", "post", "var", "edit", "class"), step: S, before: "any", after: "any", why: S };
const Version = {
  v: N, at: N, by: en("compile", "repair", "user", "import", "record"), parent: or(N, "null"),
  ops: [Op], steps: [Step], receiptId: opt(S), status: en("active", "pending", "superseded", "rolled_back"),
};
const Recipe = {
  schema: en(SCHEMA),
  id: S,
  lineage: S,
  title: S,
  request: S,
  sites: [S],
  start: { url: or(UrlPattern, "null"), newTab: B },
  variables: [Variable],
  steps: [Step],
  result: {
    kind: en("action", "extract"),
    extract: opt([{ name: S, at: S }]),
    answer: opt(S),
    done: [Predicate],
  },
  state: en("draft", "verified", "degraded", "imported", "retired"),
  trust: or("null"),
  schedule: or("null"),
  provenance: {
    source: en("run", "demo", "import", "edit", "record"),
    runId: opt(S), receiptId: opt(S), models: opt([S]),
    compiledAt: N, compiler: S, author: S,
  },
  versions: [Version],
  active: N,
  counters: {
    runs: N, replayOk: N, repaired: N, repairsRolledBack: N,
    stopped: { drift: N, blocker: N, refused: N, user: N, site: N },
    overrides: N, last5: [en("ok", "healed", "stopped", "failed")], lastRunAt: N, lastOkAt: N,
    perStep: rec({ exact: N, fingerprint: N, repaired: N, minScore: N, minMargin: N, postFails: N }),
    drift: rec(N),
  },
};

function check(value, type, path, errors) {
  if (errors.length > 50) return;
  if (type === "any") return;
  if (type === S) { if (typeof value !== "string") errors.push(`${path}: expected a string`); return; }
  if (type === N) { if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected a number`); return; }
  if (type === B) { if (typeof value !== "boolean") errors.push(`${path}: expected true or false`); return; }
  if (type === "null") { if (value !== null) errors.push(`${path}: expected null`); return; }
  if (Array.isArray(type) && type[0] === "enum") {
    if (!type.slice(1).includes(value)) errors.push(`${path}: expected one of ${type.slice(1).join(", ")}`);
    return;
  }
  if (Array.isArray(type) && type[0] === "or") {
    for (const t of type.slice(1)) {
      const e = [];
      check(value, t, path, e);
      if (!e.length) return;
    }
    errors.push(`${path}: matches none of the allowed shapes`);
    return;
  }
  if (Array.isArray(type)) {
    if (!Array.isArray(value)) { errors.push(`${path}: expected a list`); return; }
    value.forEach((v, i) => check(v, type[0], `${path}[${i}]`, errors));
    return;
  }
  if (type && typeof type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${path}: expected an object`); return; }
    if (type["*"]) {
      for (const [k, v] of Object.entries(value)) check(v, type["*"], `${path}.${k}`, errors);
      return;
    }
    for (const k of Object.keys(value)) if (!(k in type)) errors.push(`${path}.${k}: unknown key`);
    for (const [k, t] of Object.entries(type)) {
      const optional = t && typeof t === "object" && "__opt" in t;
      if (!(k in value) || value[k] === undefined) { if (!optional) errors.push(`${path}.${k}: missing`); continue; }
      check(value[k], optional ? t.__opt : t, `${path}.${k}`, errors);
    }
  }
}

/**
 * Validate a recipe strictly.
 * @param {unknown} recipe
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validate(recipe) {
  const errors = [];
  check(recipe, Recipe, "recipe", errors);
  if (errors.length) return { ok: false, errors };
  const r = /** @type {any} */ (recipe);
  if (r.steps.length > CAPS.steps) errors.push(`recipe.steps: at most ${CAPS.steps}`);
  if (r.variables.length > CAPS.variables) errors.push(`recipe.variables: at most ${CAPS.variables}`);
  if (JSON.stringify(r).length > CAPS.bytes) errors.push(`recipe: larger than ${CAPS.bytes} bytes`);
  const ids = new Set();
  for (const s of r.steps) {
    if (ids.has(s.id)) errors.push(`step ${s.id}: duplicate id`);
    ids.add(s.id);
    if (s.action.do === "navigate") {
      const u = String(s.action.url);
      if (/^\s*(javascript|data|file|vbscript):/i.test(u)) errors.push(`step ${s.id}: only http(s) addresses may be opened`);
    }
    const needsTarget = !["navigate", "back"].includes(s.action.do) && !(s.action.do === "press" && !s.action.onTarget);
    if (needsTarget && !s.target) errors.push(`step ${s.id}: ${s.action.do} needs a target`);
    if (!s.post.all.length && s.action.do !== "read") errors.push(`step ${s.id}: a step needs at least one postcondition`);
  }
  for (const v of r.variables) if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(v.name)) errors.push(`variable ${v.name}: bad name`);
  if (r.active < 0 || r.active >= Math.max(1, r.versions.length)) errors.push("recipe.active: out of range");
  return { ok: errors.length === 0, errors };
}

/** Fresh counters for a new recipe. */
export function newCounters() {
  return { runs: 0, replayOk: 0, repaired: 0, repairsRolledBack: 0, stopped: { drift: 0, blocker: 0, refused: 0, user: 0, site: 0 }, overrides: 0, last5: [], lastRunAt: 0, lastOkAt: 0, perStep: {}, drift: {} };
}

/** A random id with a prefix: "rcp_" + 16 hex. */
export function newId(prefix) {
  let s = "";
  const g = globalThis.crypto;
  if (g && g.getRandomValues) {
    const b = new Uint8Array(8);
    g.getRandomValues(b);
    s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  } else {
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  }
  return `${prefix}_${s}`;
}
