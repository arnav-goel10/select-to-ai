// Package integrity for the store zip (plan: package-integrity).
//
//   node scripts/check-package.mjs dist/select-to-ai-extension.zip
//
// Reads the zip itself, not the source tree, and checks:
//   - every path the extension loads is in the zip: manifest entries
//     (worker, pages, icons, content scripts, rule files, web accessible
//     resources), importScripts() arguments in the worker, files passed to
//     chrome.scripting.executeScript, getURL() literals, and local
//     <script src> and <link href> targets in every HTML page;
//   - no remote <script src>;
//   - the exclude list: no Sign in with ChatGPT files (cut from 4.0), no
//     .DS_Store, .env, source maps, logs, tests or _metadata;
//   - size under the budget.
// It prints the sha256 and, on GitHub Actions, writes it to the job summary.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SIZE_BUDGET_BYTES = 800 * 1024;
export const EXCLUDED = [
  { re: /(^|\/)chatgptAuth\.js$/, why: "Sign in with ChatGPT is cut from 4.0" },
  { re: /(^|\/)chatgptConnect\.js$/, why: "Sign in with ChatGPT is cut from 4.0" },
  { re: /(^|\/)chatgptUi\.js$/, why: "Sign in with ChatGPT is cut from 4.0" },
  { re: /(^|\/)chatgpt-logo[^/]*\.svg$/, why: "Sign in with ChatGPT is cut from 4.0" },
  { re: /(^|\/)\.DS_Store$/, why: "Finder metadata" },
  { re: /(^|\/)\.env(\.|$)/, why: "environment file" },
  { re: /\.map$/, why: "source map" },
  { re: /\.log$/, why: "log file" },
  { re: /(^|\/)(tests?|__tests__)\//, why: "test files" },
  { re: /\.test\.[cm]?js$/, why: "test files" },
  { re: /^_metadata\//, why: "reserved by the Web Store" },
];

const isRemote = (p) => /^(https?:)?\/\//i.test(p) || /^(data|blob|chrome|about|javascript|mailto):/i.test(p);
const clean = (p) => p.replace(/[?#].*$/, "").replace(/^\.\//, "").replace(/^\//, "");

function stringArgs(src) {
  return [...src.matchAll(/(['"`])([^'"`\n]+?)\1/g)].map((m) => m[2]);
}

// Paths the manifest names, with where each came from.
export function manifestRefs(m) {
  const refs = [];
  const add = (p, from) => { if (typeof p === "string" && p) refs.push({ path: p, from }); };
  add(m.background && m.background.service_worker, "background.service_worker");
  add(m.action && m.action.default_popup, "action.default_popup");
  if (m.action && m.action.default_icon) {
    const icon = m.action.default_icon;
    if (typeof icon === "string") add(icon, "action.default_icon");
    else Object.values(icon).forEach((p) => add(p, "action.default_icon"));
  }
  add(m.options_page, "options_page");
  add(m.options_ui && m.options_ui.page, "options_ui.page");
  add(m.side_panel && m.side_panel.default_path, "side_panel.default_path");
  Object.values(m.icons || {}).forEach((p) => add(p, "icons"));
  ((m.declarative_net_request || {}).rule_resources || []).forEach((r) => add(r.path, "declarative_net_request"));
  (m.content_scripts || []).forEach((c, i) => [...(c.js || []), ...(c.css || [])].forEach((p) => add(p, `content_scripts[${i}]`)));
  (m.web_accessible_resources || []).forEach((w, i) => (w.resources || []).forEach((p) => { if (!/[*]/.test(p)) add(p, `web_accessible_resources[${i}]`); }));
  return refs;
}

// Paths named in a script's code.
export function scriptRefs(file, src) {
  const refs = [];
  const dir = path.posix.dirname(file);
  for (const m of src.matchAll(/importScripts\s*\(([\s\S]*?)\)/g)) {
    // importScripts resolves against the worker's own URL.
    for (const p of stringArgs(m[1])) refs.push({ path: path.posix.join(dir, p), from: `${file} importScripts` });
  }
  for (const m of src.matchAll(/files\s*:\s*\[([^\]]*)\]/g)) {
    // executeScript and insertCSS file paths are relative to the extension root.
    for (const p of stringArgs(m[1])) if (/\.(js|css)$/.test(p)) refs.push({ path: p, from: `${file} executeScript files` });
  }
  for (const m of src.matchAll(/getURL\(\s*(['"`])([^'"`$]+?)\1\s*\)/g)) {
    refs.push({ path: m[2], from: `${file} getURL` });
  }
  return refs;
}

// Local script and stylesheet targets in an HTML page, and any remote script.
export function htmlRefs(file, html) {
  const refs = [];
  const remote = [];
  const dir = path.posix.dirname(file);
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    if (isRemote(m[1])) remote.push(`${file}: remote script ${m[1]}`);
    else refs.push({ path: path.posix.join(dir, m[1]), from: `${file} <script>` });
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (!href || isRemote(href[1])) continue;
    if (!/\brel\s*=\s*["'](stylesheet|icon|preload|modulepreload)["']/i.test(m[0])) continue;
    refs.push({ path: path.posix.join(dir, href[1]), from: `${file} <link>` });
  }
  return { refs, remote };
}

export function checkEntries(entries, readText) {
  const have = new Set(entries);
  const problems = { missing: [], remote: [], excluded: [] };
  if (!have.has("manifest.json")) {
    problems.missing.push("manifest.json is not at the zip root");
    return problems;
  }
  const manifest = JSON.parse(readText("manifest.json"));
  const refs = manifestRefs(manifest);
  for (const f of entries) {
    if (/\.(js|mjs)$/.test(f)) refs.push(...scriptRefs(f, readText(f)));
    if (/\.html$/.test(f)) {
      const h = htmlRefs(f, readText(f));
      refs.push(...h.refs);
      problems.remote.push(...h.remote);
    }
  }
  const seen = new Set();
  for (const r of refs) {
    if (isRemote(r.path)) continue;
    const p = clean(path.posix.normalize(r.path));
    const key = `${p}|${r.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!have.has(p)) problems.missing.push(`${p} (named by ${r.from})`);
  }
  for (const f of entries) {
    const hit = EXCLUDED.find((x) => x.re.test(f));
    if (hit) problems.excluded.push(`${f} (${hit.why})`);
  }
  return problems;
}

function zipEntries(zip) {
  return execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter((e) => e && !e.endsWith("/"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const zip = path.resolve(process.argv[2] || "dist/select-to-ai-extension.zip");
  const bytes = fs.readFileSync(zip);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const entries = zipEntries(zip);
  const readText = (f) => execFileSync("unzip", ["-p", zip, f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const problems = checkEntries(entries, readText);
  const sizeProblem = bytes.length > SIZE_BUDGET_BYTES ? [`zip is ${bytes.length} bytes, budget ${SIZE_BUDGET_BYTES}`] : [];
  const sections = [
    ["every referenced path exists in the zip", problems.missing],
    ["no remote script", problems.remote],
    ["exclude list holds", problems.excluded],
    ["size within budget", sizeProblem],
  ];
  let failed = 0;
  const lines = [];
  for (const [rule, list] of sections) {
    lines.push(`${list.length ? "FAIL" : "PASS"}  ${rule}${list.length ? ` (${list.length})` : ""}`);
    for (const p of list) lines.push(`      ${p}`);
    if (list.length) failed++;
  }
  lines.push("", `zip: ${path.basename(zip)}, ${entries.length} files, ${bytes.length} bytes`, `sha256: ${sha256}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Package integrity\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\n`);
  process.exitCode = failed ? 1 : 0;
}
