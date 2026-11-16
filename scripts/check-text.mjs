// Text lint for the 4.0 release (plan: text-lint).
//
//   node scripts/check-text.mjs
//
// Rules, each reported with file and line:
//   1. No em dash (U+2014) or its HTML entity in extension/, README.md,
//      CHANGELOG.md, PRIVACY_POLICY.md, SECURITY.md or docs/.
//   2. No placeholder repository path (OWNER followed by /REPO) in any
//      tracked file.
//   3. No word "undefined" in the visible text of the extension's HTML pages.
//      The screenshots job checks the rendered text of the same pages.
//   4. No "debugger" in docs/store-listing.md, docs/privacy-disclosure.md or
//      PRIVACY_POLICY.md (4.0 ships without the permission).
//   5. PRIVACY_POLICY.md has a "Limited Use" section.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EM_DASH = /\u2014|&mdash;|&#8212;|&#x2014;/i;
// Built from parts so this file does not match its own rule.
const PLACEHOLDER = new RegExp(["OWNER", "REPO"].join("/"));
const TEXT_EXT = /\.(js|mjs|cjs|json|html|css|md|txt|yml|yaml|svg)$/i;

function trackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch (_e) {
    return [];
  }
}

function linesMatching(root, file, re) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return [];
  const out = [];
  fs.readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
    if (re.test(line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  return out;
}

// The text a reader sees: tags, scripts, styles and comments removed.
export function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function lint(root) {
  const files = trackedFiles(root);
  const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join("/");
  const inScope = (f) => f.startsWith("extension/") || f.startsWith("docs/")
    || ["README.md", "CHANGELOG.md", "PRIVACY_POLICY.md", "SECURITY.md"].includes(f);

  const results = [];

  results.push({
    rule: "no em dash in extension/, docs/ and the top-level policy files",
    problems: files.filter((f) => inScope(f) && TEXT_EXT.test(f)).flatMap((f) => linesMatching(root, f, EM_DASH)),
  });

  results.push({
    rule: "no placeholder repository path anywhere",
    problems: files.filter((f) => f !== self && TEXT_EXT.test(f)).flatMap((f) => linesMatching(root, f, PLACEHOLDER)),
  });

  results.push({
    rule: "no 'undefined' in the visible text of extension pages",
    problems: files.filter((f) => /^extension\/[^/]+\.html$/.test(f)).flatMap((f) => {
      const text = visibleText(fs.readFileSync(path.join(root, f), "utf8"));
      return /\bundefined\b/.test(text) ? [`${f}: visible text contains "undefined"`] : [];
    }),
  });

  results.push({
    rule: "no 'debugger' in the store texts and privacy policy",
    problems: ["docs/store-listing.md", "docs/privacy-disclosure.md", "PRIVACY_POLICY.md"]
      .flatMap((f) => linesMatching(root, f, /debugger/i)),
  });

  const policy = path.join(root, "PRIVACY_POLICY.md");
  results.push({
    rule: "PRIVACY_POLICY.md has a Limited Use section",
    problems: fs.existsSync(policy) && /^#+\s.*Limited Use/im.test(fs.readFileSync(policy, "utf8"))
      ? [] : ["PRIVACY_POLICY.md has no heading containing \"Limited Use\""],
  });

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const results = lint(root);
  let failed = 0;
  for (const { rule, problems } of results) {
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${rule}${problems.length ? ` (${problems.length})` : ""}`);
    for (const p of problems.slice(0, 50)) console.log(`      ${p}`);
    if (problems.length > 50) console.log(`      ... and ${problems.length - 50} more`);
    if (problems.length) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} text rules hold`);
  process.exitCode = failed ? 1 : 0;
}
