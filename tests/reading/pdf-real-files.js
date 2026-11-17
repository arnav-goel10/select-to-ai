/**
 * The PDF reader (extension/pdfText.js) on real files from the web, the ones
 * the 17 Nov 2026 trial failed on. Run in CI, which downloads them; they are
 * never checked in.
 *
 *   node tests/reading/pdf-real-files.js        (needs network)
 *
 * For each file, the line that must come out is printed with the page it is
 * on, and the run fails when it is missing.
 */
"use strict";
const path = require("node:path");
const PDF = require(path.join(__dirname, "../../extension/pdfText.js"));

const FILES = [
  { name: "IRS Form W-9", url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf", want: /Rev\.\s*March\s*2024/ },
  { name: "Attention Is All You Need", url: "https://arxiv.org/pdf/1706.03762", want: /h\s*=\s*8\s+parallel\s+attention\s+layers,?\s+or\s+heads/ },
];

async function main() {
  let failed = 0;
  for (const f of FILES) {
    const res = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (pdf reader check)" }, redirect: "follow" });
    if (!res.ok) { console.log(`FAIL  ${f.name}: the download answered ${res.status}`); failed++; continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const t0 = Date.now();
    const got = await PDF.extract(bytes);
    const ms = Date.now() - t0;
    if (got.error) { console.log(`FAIL  ${f.name}: ${got.error}`); failed++; continue; }
    const text = PDF.asPageText(got);
    const page = got.pages.findIndex((p) => f.want.test(p.replace(/\s+/g, " ")));
    const line = page < 0 ? "" : got.pages[page].split("\n").find((l) => f.want.test(l)) || got.pages[page].replace(/\s+/g, " ").match(new RegExp(`.{0,60}${f.want.source}.{0,40}`))[0];
    console.log(`${page < 0 ? "FAIL" : "PASS"}  ${f.name} (${f.url}): ${bytes.length} bytes, ${got.total} pages, ${text.length} characters in ${ms} ms`);
    if (page < 0) { console.log(`      no match for ${f.want}; first page begins: ${JSON.stringify(got.pages[0].slice(0, 300))}`); failed++; continue; }
    console.log(`      page ${page + 1} of ${got.total}: ${JSON.stringify(line.trim())}`);
  }
  if (failed) process.exit(1);
}

// The holdout check (tests/bench/trial.js) reads FILES; only a run from the command line downloads them.
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { FILES };
