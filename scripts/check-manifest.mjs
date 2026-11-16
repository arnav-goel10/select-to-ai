// The manifest contract for 4.0: what the shipped manifest may ask for so a
// 2.0 user updates without a new permission prompt and without being
// disabled. Used by tests/contract/manifest-contract.test.js and runnable on
// its own:
//
//   node scripts/check-manifest.mjs [extensionDir]
//
// Every rule returns a list of problems in plain words. An empty list means
// the rule holds.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Required permissions the update may hold. The first five were in the 2.0
// manifest, the rest add no install or update warning.
export const ALLOWED_PERMISSIONS = [
  "contextMenus", "storage", "sidePanel", "tabs", "declarativeNetRequest",
  "activeTab", "scripting", "identity", "alarms", "idle",
];

// The three hosts the 2.0 manifest held, for host_permissions and for every
// static content_scripts match. Everything else stays optional.
export const ALLOWED_HOSTS = [
  "https://chatgpt.com/*",
  "https://gemini.google.com/*",
  "https://www.perplexity.ai/*",
];

export const MINIMUM_CHROME_VERSION = "120";

const list = (value) => (Array.isArray(value) ? value : []);

export function checkPermissions(manifest) {
  const extra = list(manifest.permissions).filter((p) => !ALLOWED_PERMISSIONS.includes(p));
  return extra.map((p) => `required permission "${p}" is not allowed (allowed: ${ALLOWED_PERMISSIONS.join(", ")})`);
}

export function checkNamedPermissions(manifest) {
  const problems = [];
  for (const name of ["debugger", "favicon"]) {
    if (list(manifest.permissions).includes(name)) problems.push(`"${name}" is in permissions`);
    if (list(manifest.optional_permissions).includes(name)) problems.push(`"${name}" is in optional_permissions`);
  }
  return problems;
}

export function checkHosts(manifest) {
  const extra = list(manifest.host_permissions).filter((h) => !ALLOWED_HOSTS.includes(h));
  return extra.length
    ? [`${extra.length} host_permissions outside the three 2.0 hosts: ${extra.join(", ")}`]
    : [];
}

export function checkContentScriptMatches(manifest) {
  const problems = [];
  list(manifest.content_scripts).forEach((entry, i) => {
    const extra = list(entry.matches).filter((m) => !ALLOWED_HOSTS.includes(m));
    if (extra.length) problems.push(`content_scripts[${i}] matches outside the three 2.0 hosts: ${extra.join(", ")}`);
  });
  return problems;
}

export function checkOmnibox(manifest) {
  return manifest.omnibox ? [`omnibox key is present (keyword "${manifest.omnibox.keyword}")`] : [];
}

export function checkMinimumChrome(manifest) {
  if (!manifest.minimum_chrome_version) return ["minimum_chrome_version is missing"];
  const major = parseInt(String(manifest.minimum_chrome_version), 10);
  if (!(major >= parseInt(MINIMUM_CHROME_VERSION, 10))) {
    return [`minimum_chrome_version is ${manifest.minimum_chrome_version}, expected ${MINIMUM_CHROME_VERSION} or later`];
  }
  return [];
}

// The first "## x.y.z" heading of the changelog.
export function changelogVersion(text) {
  const m = /^##\s+v?(\d+\.\d+\.\d+)\b/m.exec(text);
  return m ? m[1] : null;
}

export function checkVersions({ manifest, packageJson, changelog }) {
  const versions = {
    "extension/manifest.json": manifest.version,
    "package.json": packageJson.version,
    "CHANGELOG.md": changelogVersion(changelog),
  };
  const distinct = new Set(Object.values(versions));
  if (distinct.size === 1 && !distinct.has(null) && !distinct.has(undefined)) return [];
  return [`versions differ: ${Object.entries(versions).map(([f, v]) => `${f} ${v}`).join(", ")}`];
}

export function loadInputs(projectRoot, extensionDir = path.join(projectRoot, "extension")) {
  return {
    manifest: JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8")),
    packageJson: JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")),
    changelog: fs.readFileSync(path.join(projectRoot, "CHANGELOG.md"), "utf8"),
  };
}

export const RULES = {
  "required permissions are in the allow-list": ({ manifest }) => checkPermissions(manifest),
  "no debugger and no favicon permission": ({ manifest }) => checkNamedPermissions(manifest),
  "host_permissions are the three 2.0 hosts at most": ({ manifest }) => checkHosts(manifest),
  "content_scripts matches are the three 2.0 hosts at most": ({ manifest }) => checkContentScriptMatches(manifest),
  "no omnibox keyword": ({ manifest }) => checkOmnibox(manifest),
  "minimum_chrome_version is set": ({ manifest }) => checkMinimumChrome(manifest),
  "version matches in manifest, package.json and CHANGELOG": (inputs) => checkVersions(inputs),
};

export function checkAll(inputs) {
  return Object.entries(RULES).map(([rule, run]) => ({ rule, problems: run(inputs) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const extensionDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const results = checkAll(loadInputs(projectRoot, extensionDir));
  let failed = 0;
  for (const { rule, problems } of results) {
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${rule}`);
    for (const p of problems) console.log(`      ${p}`);
    if (problems.length) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} manifest rules hold`);
  process.exitCode = failed ? 1 : 0;
}
