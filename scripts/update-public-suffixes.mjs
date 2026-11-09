// Rebuilds extension/publicSuffixes.js from the Public Suffix List.
//
//   node scripts/update-public-suffixes.mjs            fetches the list from publicsuffix.org
//   node scripts/update-public-suffixes.mjs list.dat   uses a copy already on disk
//
// Both sections of the list are kept: the ICANN one (co.uk, com.au) and the
// private one (github.io, vercel.app), where every user's name is a site of
// its own. Rules are stored in ASCII, the form a URL's hostname takes, and
// grouped by their last label so that label is written once.
import fs from "node:fs";
import path from "node:path";
import { domainToASCII } from "node:url";
import { fileURLToPath } from "node:url";

const SOURCE = "https://publicsuffix.org/list/public_suffix_list.dat";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "extension", "publicSuffixes.js");

const local = process.argv[2];
const text = local ? fs.readFileSync(local, "utf8") : await (await fetch(SOURCE)).text();
const version = (text.match(/^\/\/ VERSION: (\S+)/m) || [])[1] || "unknown";
const commit = (text.match(/^\/\/ COMMIT: (\S+)/m) || [])[1] || "unknown";

const groups = new Map();
let rules = 0;
for (const raw of text.split("\n")) {
  const line = raw.trim().split(/\s/)[0];
  if (!line || line.startsWith("//")) continue;
  const mark = line.startsWith("!") ? "!" : "";
  const body = mark ? line.slice(1) : line;
  // Each label on its own, so "*" survives the conversion to ASCII.
  const labels = body.split(".").map((l) => (l === "*" ? "*" : domainToASCII(l)));
  if (labels.some((l) => !l)) throw new Error(`Cannot convert rule: ${line}`);
  const last = labels.pop();
  if (!groups.has(last)) groups.set(last, new Set());
  if (labels.length) groups.get(last).add(mark + labels.join("."));
  rules += 1;
}

const data = [...groups.keys()].sort().map((tld) => `${tld}:${[...groups.get(tld)].sort().join("|")}`).join("\n");
const today = new Date().toISOString().slice(0, 10);
const file = `/**
 * Select to AI - the Public Suffix List, for siteOf in agentTools.js.
 *
 * Produced by scripts/update-public-suffixes.mjs on ${today} from
 * ${SOURCE}
 * (list version ${version}, commit ${commit}), with its ICANN and private
 * sections: ${rules} rules. Run the script again to refresh it; do not edit
 * this file by hand.
 *
 * One line per last label: "uk:co|ac|*.sch|...". Each entry is a rule's
 * labels before the last one, in ASCII; "*" and "!" mean what they mean in
 * the list. A last label with no entries is a rule on its own.
 *
 * The list is Mozilla's, under the Mozilla Public License 2.0.
 */
(function initPublicSuffixes(root) {
  "use strict";
  const data = ${JSON.stringify(data)};
  root.SELECT_TO_AI_PSL = data;
  if (typeof module !== "undefined" && module.exports) module.exports = data;
})(typeof globalThis !== "undefined" ? globalThis : this);
`;
fs.writeFileSync(out, file);
console.log(`Wrote ${path.relative(root, out)}: ${rules} rules, ${groups.size} last labels, ${(Buffer.byteLength(file) / 1024).toFixed(0)} KB.`);
