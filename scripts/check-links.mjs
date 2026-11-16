// Logged-out link check for everything a user or reviewer can click
// (plan: link-check).
//
//   node scripts/check-links.mjs
//
// Collects every https link in extension/*.html, extension/manifest.json,
// docs/store-listing.md and PRIVACY_POLICY.md, adds the repository root,
// its privacy policy and its issues page, and requests each with no
// credentials. Anything but a final HTTP 200 fails. It stays red while the
// repository is private, so CI runs it on release tags and by hand only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/arnav-goel10/select-to-ai";
const MUST = [REPO, `${REPO}/blob/main/PRIVACY_POLICY.md`, `${REPO}/issues`];

export function linksIn(text) {
  const found = text.match(/https:\/\/[^\s"'<>)\]`]+/g) || [];
  return found.map((u) => u.replace(/[.,;:]+$/, ""));
}

function sources() {
  const ext = path.join(root, "extension");
  const html = fs.readdirSync(ext).filter((f) => f.endsWith(".html")).map((f) => path.join("extension", f));
  return [...html, "extension/manifest.json", "docs/store-listing.md", "PRIVACY_POLICY.md"];
}

async function status(url) {
  const attempt = async (method) => {
    const r = await fetch(url, { method, redirect: "follow", headers: { "User-Agent": "link-check" }, signal: AbortSignal.timeout(20000) });
    return r.status;
  };
  try {
    const head = await attempt("HEAD");
    return head === 200 ? head : await attempt("GET");
  } catch (e) {
    return `error: ${e.message}`;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const where = new Map();
  for (const u of MUST) where.set(u, ["required"]);
  for (const file of sources()) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    for (const u of linksIn(fs.readFileSync(abs, "utf8"))) {
      // Template placeholders are not links.
      if (/[{}$]/.test(u)) continue;
      where.set(u, [...(where.get(u) || []), file]);
    }
  }
  let failed = 0;
  for (const [url, files] of where) {
    const code = await status(url);
    const ok = code === 200;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${code}  ${url}  (${[...new Set(files)].join(", ")})`);
  }
  console.log(`\n${where.size - failed}/${where.size} links return 200 logged out`);
  process.exitCode = failed ? 1 : 0;
}
