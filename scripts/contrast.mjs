// Contrast of every text and control pair in extension/tokens.css, light and dark.
//   node scripts/contrast.mjs            prints a Markdown table
//   node scripts/contrast.mjs --json     prints the rows as JSON
// It resolves light-dark() pairs and var() references, and composites a
// translucent colour over the surface under it before it measures.
// Text needs 4.5:1 (WCAG 1.4.3); a control's edge, a focus ring, an icon or a
// state mark needs 3:1 against what is next to it (WCAG 1.4.11).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "extension", "tokens.css"), "utf8");
const start = css.indexOf(":root {");
const root = css.slice(start, css.indexOf("\n}\n", start));
const raw = {};
for (const m of root.matchAll(/(--[\w-]+):\s*([^;]+);/g)) raw[m[1]] = m[2].trim();

function split(v) {
  const m = v.match(/^light-dark\((.*)\)$/);
  if (!m) return [v, v];
  let depth = 0;
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return [m[1].slice(0, i).trim(), m[1].slice(i + 1).trim()];
  }
  throw new Error(`bad light-dark(): ${v}`);
}
function resolve(name, t) {
  if (!(name in raw)) throw new Error(`no token ${name}`);
  const v = split(raw[name])[t];
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(ref[1], t) : v;
}
function parse(c) {
  if (c.startsWith("#")) {
    const h = c.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = c.match(/rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\)/);
  if (!m) throw new Error(`cannot read colour ${c}`);
  return [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1];
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = ([r, g, b]) => {
  const f = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const col = (spec, t) => (spec.startsWith("--") ? parse(resolve(spec, t)) : parse(spec));
// A background may be "--top over --base": the translucent top composited on the base.
const bgOf = (spec, t) => {
  const parts = spec.split(" over ");
  return parts.length === 2 ? over(col(parts[0], t), bgOf(parts[1], t)) : col(spec, t);
};

const TEXT = 4.5;
const UI = 3;
const SURFACES = ["--bg", "--surface", "--surface-2", "--surface-3", "--surface-sunken"];
const pairs = [];
const add = (fg, bg, min, use) => pairs.push({ fg, bg, min, use });

for (const fg of ["--text", "--text-muted", "--text-subtle"]) for (const bg of SURFACES) add(fg, bg, TEXT, "text");
for (const bg of ["--bg", "--surface", "--surface-2"]) add("--accent", bg, TEXT, "link, card icon");
add("--text", "--accent-selected over --surface", TEXT, "selected chip label");
add("--text", "--hover-overlay over --surface", TEXT, "text on a hovered row");
add("--text", "--needs-wash over --surface", TEXT, "needs-you card title on its wash");
add("--text-muted", "--needs-wash over --surface", TEXT, "needs-you card text on its wash");
add("--accent-contrast", "--accent-fill", TEXT, "primary button label");
add("--accent-contrast", "--accent-fill-hover", TEXT, "primary button label, hovered");
add("--bg", "--text", TEXT, "stop button icon, toast text");
for (const s of ["--needs", "--done", "--failed"]) {
  add(s, "--surface", TEXT, "state text");
  add(s, "--bg", TEXT, "state text");
  add(s, `${s}-soft over --surface`, TEXT, "state text on its tint");
}
add("--text-subtle", "--surface-3", UI, "send button arrow while empty");
// Non-text: edges, rings, marks.
for (const bg of ["--bg", "--surface", "--surface-2"]) add("--accent", bg, UI, "focus ring");
add("--accent", "--needs-wash over --surface", UI, "focus ring inside a needs-you card");
add("--accent-fill", "--surface", UI, "primary button against a card");
add("--accent-fill", "--bg", UI, "primary button against the page");
add("--working", "--bg", UI, "live dot");
add("--working", "--surface", UI, "live dot");
add("--accent-fill", "--surface", UI, "switch on: track against the card");
add("--accent-contrast", "--accent-fill", UI, "switch on: thumb against the track");
for (const bg of ["--bg", "--surface", "--surface-2"]) add("--control-edge", bg, UI, "field edge, chosen chip edge, switch off edge");
add("--needs-mark", "--surface", UI, "needs-you stripe, dot and icon");
add("--needs-mark", "--bg", UI, "needs-you dot in the header");
add("--done", "--surface", UI, "done mark");
add("--failed", "--surface", UI, "failed mark");

const rows = pairs.map((p) => {
  const r = [0, 1].map((t) => ratio(over(col(p.fg, t), bgOf(p.bg, t)), bgOf(p.bg, t)));
  return { ...p, light: +r[0].toFixed(2), dark: +r[1].toFixed(2), pass: r.every((x) => x >= p.min) };
});

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 1));
else {
  const mark = (x, min) => `${x.toFixed(2)}${x >= min ? "" : " FAIL"}`;
  console.log("| Foreground | Background | Use | Needs | Light | Dark |\n|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| \`${r.fg}\` | \`${r.bg}\` | ${r.use} | ${r.min}:1 | ${mark(r.light, r.min)} | ${mark(r.dark, r.min)} |`);
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length} pairs, ${failed} below AA.`);
  if (failed) process.exitCode = 1;
}
