/**
 * Variables: infer their types from the controls they were used in, and
 * bind and check values before a replay (design §2.3). Pure functions.
 */
import { slotsOf } from "./text.js";

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * Infer variable declarations from the values the recording was given and
 * where each was used.
 * @param {Record<string,string>} values  the recording's variable values
 * @param {{name:string, el?:object}[]} uses  each slot use, with the control it was typed or chosen in
 * @returns {object[]}
 */
export function inferVariables(values, uses) {
  const out = [];
  for (const [name, value] of Object.entries(values || {})) {
    if (!NAME.test(name)) throw new Error(`bad variable name "${name}": use [A-Za-z][A-Za-z0-9_]{0,31}`);
    const used = (uses || []).filter((u) => u.name === name);
    const el = (used.find((u) => u.el) || {}).el;
    const v = { name, type: "text", required: true, example: String(value), source: "user_marked", checked: "none" };
    if (el && el.tag === "select" && Array.isArray(el.options) && el.options.length) {
      v.type = "enum";
      v.enum = el.options.slice(0, 200);
    } else if (el && (el.inputType === "number" || el.kind === "spinbutton" || el.kind === "slider")) {
      v.type = "number";
      if (el.min != null && el.min !== "" && Number.isFinite(Number(el.min))) v.min = Number(el.min);
      if (el.max != null && el.max !== "" && Number.isFinite(Number(el.max))) v.max = Number(el.max);
    } else if (el && el.inputType === "date") {
      v.type = "date";
      v.format = "YYYY-MM-DD";
    } else if (el && el.inputType === "email") {
      v.format = "email";
    }
    out.push(v);
  }
  return out;
}

/**
 * Bind values to a recipe's variables and check each.
 * @param {object[]} variables
 * @param {Record<string,unknown>} values
 * @returns {{ok:boolean, bindings:Record<string,string>, errors:string[]}}
 */
export function bindVariables(variables, values) {
  const bindings = {}, errors = [];
  const given = values || {};
  for (const v of variables || []) {
    let raw = Object.prototype.hasOwnProperty.call(given, v.name) ? given[v.name] : v.default;
    if (raw === undefined || raw === null || raw === "") {
      if (v.required) errors.push(`${v.name}: a value is required`);
      continue;
    }
    if (v.type === "secret") { bindings[v.name] = String(raw); continue; }
    if (v.type === "date" && typeof raw === "string" && /^today([+-]\d+)?$/.test(raw)) {
      const m = /^today([+-]\d+)?$/.exec(raw);
      const d = new Date();
      d.setDate(d.getDate() + (m[1] ? Number(m[1]) : 0));
      raw = d.toISOString().slice(0, 10);
    }
    const s = String(raw);
    if (v.type === "number") {
      const n = Number(s);
      if (!Number.isFinite(n)) { errors.push(`${v.name}: "${s}" is not a number`); continue; }
      if (v.min != null && n < v.min) { errors.push(`${v.name}: ${n} is below ${v.min}`); continue; }
      if (v.max != null && n > v.max) { errors.push(`${v.name}: ${n} is above ${v.max}`); continue; }
    }
    if (v.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(s)) { errors.push(`${v.name}: "${s}" is not a date (YYYY-MM-DD)`); continue; }
    if (v.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) { errors.push(`${v.name}: "${s}" is not an email address`); continue; }
    if (s.length > 2000) { errors.push(`${v.name}: too long`); continue; }
    bindings[v.name] = s;
  }
  for (const k of Object.keys(given)) {
    if (!(variables || []).some((v) => v.name === k)) errors.push(`${k}: the recipe has no such variable`);
  }
  return { ok: errors.length === 0, bindings, errors };
}

/** Every {slot} a recipe's steps use. */
export function slotsUsed(recipe) {
  const out = new Set();
  const walk = (x) => {
    if (typeof x === "string") for (const s of slotsOf(x)) out.add(s);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(recipe.steps);
  walk(recipe.result);
  walk(recipe.start);
  return out;
}
