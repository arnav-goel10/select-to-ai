/**
 * Reading the text of a PDF the browser shows (extension/pdfText.js).
 *
 * The browser's PDF viewer gives an extension no text, so the agent saw an
 * empty page on every PDF (trial of 17 Nov 2026: a tax form failed in all
 * three runs with "I could not read the PDF's printed text"). The engine
 * now reads the file itself. These PDFs are built here, so each part of
 * the format the reader handles is checked on its own.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "../../extension");
const PDF = require(path.join(EXT, "pdfText.js"));
const PAGE = require(path.join(EXT, "pageSearch.js"));

// ------------------------------------------------------------ a PDF writer

const { writePdf, flate, simplePdf } = require("../helpers/pdf-writer.js");
const hex = (s) => Buffer.from(s, "latin1").toString("hex");
const WIDTHS = `/FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(500).join(" ")}]`;

// Codes of the composite font: 0x100 + the character, so "a" is <0161>.
const cid = (s) => `<${[...s].map((c) => (0x100 + c.charCodeAt(0)).toString(16).padStart(4, "0")).join("")}>`;
const TO_UNICODE = [
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
  "1 begincodespacerange <0000> <FFFF> endcodespacerange",
  "1 beginbfchar <0003> <00660069> endbfchar",
  "1 beginbfrange <0100> <017F> <0000> endbfrange",
  "endcmap CMapName currentdict /CMap defineresource pop end end",
].join("\n");

/** A two-page document using a simple font, a composite font, a Differences font and a form. */
function sampleObjects() {
  const page1 = [
    "BT /F1 10 Tf 72 700 Td",
    "[(Form W-9 )(\\(Rev. March 2024\\))] TJ",
    "0 -14 Td [(Request)-600(for)-600(Taxpayer)] TJ",
    "( Iden) Tj [(ti)20(fication)] TJ ( Num) Tj (ber) Tj",
    "0 -14 Td /F3 10 Tf (\\001nd it\\002s caf\\003 \\004 now) Tj",
    "ET",
  ].join("\n");
  const page2 = [
    "BT /F2 12 Tf 1 0 0 1 72 700 Tm",
    `[${cid("The encoder is a stack of N = 6 identical layers. Speci")}<0003>${cid("cation.")}] TJ`,
    "ET",
    "q 1 0 0 1 0 -100 cm /X1 Do Q",
  ].join("\n");
  return [
    { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, dict: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 9 0 R >> /XObject << /X1 10 0 R >> >> >>" },
    { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R >>" },
    { num: 4, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [12 0 R] >>" },
    { num: 5, dict: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ${WIDTHS} >>` },
    { num: 6, dict: "<< /Type /Font /Subtype /Type0 /BaseFont /Sans /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>" },
    { num: 7, dict: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sans /DW 500 /W [3 [1000]] >>" },
    { num: 8, dict: "<< /Filter /FlateDecode >>", data: flate(TO_UNICODE) },
    { num: 9, dict: `<< /Type /Font /Subtype /Type1 /BaseFont /Serif /FirstChar 1 /LastChar 126 /Widths [${Array(126).fill(500).join(" ")}] /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /f_i /quoteright /eacute /uni2013] >> >>` },
    { num: 10, dict: "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Filter [/ASCIIHexDecode /FlateDecode] >>", data: Buffer.from(`${flate("BT /F1 9 Tf 72 500 Td (Inside a form.) Tj ET").toString("hex")}>`, "latin1") },
    { num: 11, dict: "<< /Filter /FlateDecode >>", data: flate(page1) },
    { num: 12, dict: "<< >>", data: Buffer.from(page2, "latin1") },
  ];
}

const sampleId = "<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>";
const ID0 = Buffer.from("00112233445566778899aabbccddeeff", "hex");

test("a PDF's text is read page by page, with its words and lines as printed", async () => {
  const got = await PDF.extract(writePdf(sampleObjects(), `/Root 1 0 R /ID [${sampleId}]`));
  assert.equal(got.error, undefined);
  assert.equal(got.total, 2);
  const [one, two] = got.pages;
  assert.equal(one.split("\n")[0], "Form W-9 (Rev. March 2024)");
  assert.equal(one.split("\n")[1], "Request for Taxpayer Identification Number", "a gap in a TJ is a space; a kern and two strings that touch are not");
  assert.equal(one.split("\n")[2], "find it’s café – now", "glyph names of a Differences encoding");
  assert.match(two, /^The encoder is a stack of N = 6 identical layers\. Specification\.$/m, "a composite font through its ToUnicode map, a code for two letters among them");
  assert.match(two, /\nInside a form\.$/, "text drawn by a form on the page, through two filters");
});

test("a document kept in object streams is read as the same text", async () => {
  // Catalog, page tree and fonts inside one object stream, with a
  // cross-reference stream in place of a trailer.
  const objs = sampleObjects();
  const packed = objs.filter((o) => !o.data && o.num !== 3);
  const rest = objs.filter((o) => o.data || o.num === 3);
  let body = "";
  const head = [];
  for (const o of packed) { head.push(`${o.num} ${body.length}`); body += `${o.dict}\n`; }
  const index = `${head.join(" ")}\n`;
  const objstm = { num: 20, dict: `<< /Type /ObjStm /N ${packed.length} /First ${index.length} /Filter /FlateDecode >>`, data: flate(index + body) };
  const xrefStream = { num: 21, dict: `<< /Type /XRef /Size 22 /Root 1 0 R /W [1 2 1] /ID [${sampleId}] /Filter /FlateDecode >>`, data: flate("\x00\x00\x00\x00") };
  const file = writePdf([...rest, objstm, xrefStream], "/Size 22").toString("latin1").replace(/xref\n[\s\S]*$/, "startxref\n0\n%%EOF\n");
  const got = await PDF.extract(Buffer.from(file, "latin1"));
  assert.equal(got.total, 2);
  assert.match(got.pages[0], /^Form W-9 \(Rev\. March 2024\)$/m);
  assert.match(got.pages[1], /identical layers/);
});

// ------------------------------------------------------------ encrypted

const PADDING = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

function aesSeal(key) {
  return (data) => {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv(key.length === 32 ? "aes-256-cbc" : "aes-128-cbc", key, iv);
    return Buffer.concat([iv, c.update(data), c.final()]);
  };
}

test("a PDF encrypted with AES-128 and no user password is read", async () => {
  const O = crypto.randomBytes(32);
  const P = -3904;
  const p = Buffer.alloc(4); p.writeInt32LE(P);
  let key = crypto.createHash("md5").update(Buffer.concat([PADDING, O, p, ID0])).digest();
  for (let i = 0; i < 50; i++) key = crypto.createHash("md5").update(key.subarray(0, 16)).digest();
  key = key.subarray(0, 16);
  const seal = (num, data) => {
    const ok = crypto.createHash("md5").update(Buffer.concat([key, Buffer.from([num & 255, (num >> 8) & 255, num >> 16, 0, 0]), Buffer.from("sAlT")])).digest();
    return aesSeal(ok)(data);
  };
  const enc = { num: 30, dict: `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${O.toString("hex")}> /U <${"00".repeat(32)}> /P ${P} >>` };
  const file = writePdf([...sampleObjects(), enc], `/Root 1 0 R /Encrypt 30 0 R /ID [${sampleId}]`, seal);
  const got = await PDF.extract(file);
  assert.equal(got.error, undefined);
  assert.match(got.pages[0], /Form W-9 \(Rev\. March 2024\)/);
  assert.match(got.pages[1], /identical layers/);
});

/** ISO 32000-2 algorithm 2.B, written apart from the extension's. */
function hash2B(pw, salt) {
  let K = crypto.createHash("sha256").update(Buffer.concat([pw, salt])).digest();
  for (let round = 0; ; round++) {
    const K1 = Buffer.concat(Array(64).fill(Buffer.concat([pw, K])));
    const c = crypto.createCipheriv("aes-128-cbc", K.subarray(0, 16), K.subarray(16, 32)); c.setAutoPadding(false);
    const E = Buffer.concat([c.update(K1), c.final()]);
    let sum = 0; for (let i = 0; i < 16; i++) sum += E[i];
    K = crypto.createHash(["sha256", "sha384", "sha512"][sum % 3]).update(E).digest();
    if (round >= 63 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}

function aes256Encrypt(userPassword) {
  const fileKey = crypto.randomBytes(32);
  const vsalt = crypto.randomBytes(8), ksalt = crypto.randomBytes(8);
  const pw = Buffer.from(userPassword, "utf8");
  const U = Buffer.concat([hash2B(pw, vsalt), vsalt, ksalt]);
  const c = crypto.createCipheriv("aes-256-cbc", hash2B(pw, ksalt), Buffer.alloc(16)); c.setAutoPadding(false);
  const UE = Buffer.concat([c.update(fileKey), c.final()]);
  const enc = { num: 30, dict: `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <${"00".repeat(48)}> /U <${U.toString("hex")}> /OE <${"00".repeat(32)}> /UE <${UE.toString("hex")}> /P -4 /Perms <${"00".repeat(16)}> >>` };
  return writePdf([...sampleObjects(), enc], `/Root 1 0 R /Encrypt 30 0 R /ID [${sampleId}]`, (_n, data) => aesSeal(fileKey)(data));
}

test("a PDF encrypted with AES-256 and no user password is read", async () => {
  const got = await PDF.extract(aes256Encrypt(""));
  assert.equal(got.error, undefined);
  assert.match(got.pages[0], /Request for Taxpayer Identification Number/);
});

test("a PDF that needs a password says so, and gives no text", async () => {
  const got = await PDF.extract(aes256Encrypt("secret"));
  assert.equal(got.locked, true);
  assert.match(got.error, /locked with a password/);
});

test("a PDF made by macOS with 128-bit RC4 is read", async () => {
  // Written by Quartz (cupsfilter, then PDFKit with an owner password only).
  const got = await PDF.extract(fs.readFileSync(path.join(__dirname, "../fixtures/pdf/quartz-rc4.pdf")));
  assert.equal(got.error, undefined);
  assert.equal(got.total, 2);
  assert.match(got.pages[0], /^Form W-9 \(Rev\. March 2024\)\nRequest for Taxpayer Identification Number and Certification$/m);
  assert.match(got.pages[1], /we employ h = 8 parallel attention layers, or heads\./);
});

test("md5 matches the standard one", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 200]) {
    const b = crypto.randomBytes(n);
    assert.equal(Buffer.from(PDF.md5(new Uint8Array(b))).toString("hex"), crypto.createHash("md5").update(b).digest("hex"), `length ${n}`);
  }
});

test("a file that is not a PDF gives an error, not text", async () => {
  assert.match((await PDF.extract(Buffer.from("<html><body>hi</body></html>"))).error, /not a PDF/);
});

// ------------------------------------------------------------ as the page's text

test("the PDF's text becomes the page's text, and find finds a passage with its page", async () => {
  const got = await PDF.extract(writePdf(sampleObjects(), `/Root 1 0 R /ID [${sampleId}]`));
  const scan = { url: "https://example.org/form.pdf", title: "form.pdf", contentType: "application/pdf", elements: [{ id: 1, tagName: "embed" }], innerText: "", visibleText: "" };
  assert.equal(PDF.isPdfPage(scan), true);
  assert.equal(PDF.isPdfPage({ ...scan, contentType: "text/html" }), false);
  assert.equal(PDF.pdfAddress(scan), "https://example.org/form.pdf", "the viewer's document is the file");
  const page = PDF.withPdfText(scan, got);
  assert.deepEqual(page.elements, scan.elements, "the page keeps its controls");
  assert.match(page.innerText, /^## Page 1 of 2\nForm W-9 \(Rev\. March 2024\)/);
  const hits = PAGE.findInText(page.innerText, "identical layers", { maxHits: 4, budget: 2400 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0], /^\[in "Page 2 of 2"\]/);
  assert.match(hits[0], /N = 6 identical layers/);
});

test("a PDF with no text, or that could not be read, says why", async () => {
  const blank = PDF.withPdfText({ contentType: "application/pdf", innerText: "" }, { pages: ["", ""], total: 2 });
  assert.match(blank.innerText, /^\[This PDF has 2 pages but no text in it: its pages may be pictures of print\./);
  const locked = PDF.withPdfText({ contentType: "application/pdf", innerText: "" }, { error: "This PDF is locked with a password, so its text cannot be read.", locked: true });
  assert.equal(locked.innerText, "[This PDF is locked with a password, so its text cannot be read.]");
  assert.match(PDF.withPdfText({ innerText: "" }, null).innerText, /could not be read/);
});

test("in the tab, the PDF is fetched again from its own address once, and read", async () => {
  const file = writePdf(sampleObjects(), `/Root 1 0 R /ID [${sampleId}]`);
  const calls = [];
  const saved = { location: globalThis.location, fetch: globalThis.fetch };
  globalThis.location = { href: "https://example.org/files/form" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => String(file.length) }, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) };
  };
  try {
    const got = await PDF.readHere();
    assert.match(got.pages[0], /Form W-9/);
    await PDF.readHere();
    assert.equal(calls.length, 1, "read once per document");
    assert.equal(calls[0].url, "https://example.org/files/form");
    assert.equal(calls[0].init.credentials, "include", "with the tab's own cookies");
    assert.equal(calls[0].init.cache, "force-cache", "from the browser's cache when it has the file");
  } finally {
    globalThis.location = saved.location;
    globalThis.fetch = saved.fetch;
  }
});

test("an HTML page that only embeds a PDF is read from the embed's address, and keeps its own text when the file gives none", () => {
  const html = { url: "https://example.org/viewer", contentType: "text/html", pdfEmbed: "https://example.org/files/a.pdf", innerText: "Quarterly report, see below", elements: [] };
  assert.equal(PDF.isPdfPage(html), true);
  assert.equal(PDF.pdfAddress(html), "https://example.org/files/a.pdf", "the file, not the HTML page");
  assert.equal(PDF.isPdfPage({ ...html, pdfEmbed: "" }), false, "an embed with no web address of its own is no PDF to read");
  assert.equal(PDF.isPdfPage({ ...html, pdfEmbed: "about:blank" }), false);
  const kept = PDF.withPdfText(html, { error: "This is not a PDF file." });
  assert.equal(kept.innerText, "Quarterly report, see below\n\n[This is not a PDF file.]", "what the scan read stays");
});

test("a PDF longer than the pages read is labelled with its real length and marked as cut short", async () => {
  const n = PDF.LIMITS.pages + 2;
  const file = simplePdf(Array.from({ length: n }, (_x, i) => [`Sheet ${i + 1}`]));
  const got = await PDF.extract(file);
  assert.equal(got.total, n, "every page is counted");
  assert.equal(got.pages.length, PDF.LIMITS.pages);
  assert.equal(got.cut, true);
  const text = PDF.asPageText(got);
  assert.match(text, new RegExp(`^## Page 1 of ${n}\\nSheet 1`));
  assert.match(text, new RegExp(`\\[The text stops here: the rest of this ${n}-page PDF was not read\\.\\]$`));
});

test("in the tab, two looks at once share one reading, and a file that failed is not fetched again", async () => {
  const file = simplePdf([["Shared reading"]]);
  const saved = globalThis.fetch;
  const calls = [];
  let answer = 200;
  globalThis.fetch = async (url) => {
    calls.push(url);
    await new Promise((r) => setTimeout(r, 20));
    return { ok: answer === 200, status: answer, headers: { get: () => String(file.length) }, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) };
  };
  try {
    const [a, b] = await Promise.all([PDF.readHere("https://example.org/once.pdf"), PDF.readHere("https://example.org/once.pdf")]);
    assert.equal(calls.length, 1, "the second look joins the reading still going");
    assert.match(a.pages[0], /Shared reading/);
    assert.equal(a, b);
    answer = 503;
    const failed = await PDF.readHere("https://example.org/gone.pdf");
    assert.match(failed.error, /answered 503/);
    await PDF.readHere("https://example.org/gone.pdf");
    assert.equal(calls.length, 2, "a failure is kept too");
  } finally {
    globalThis.fetch = saved;
  }
});

// ------------------------------------------------------------ the engine's use of it

const { fakeWorker } = require("../helpers/fake-worker.js");

/**
 * The engine's scan of tab 9 in a worker of stand-ins. The content script
 * answers with `page`; chrome.scripting runs the injected function in the
 * worker's own copy of pdfText.js, against `fetch`. `hang` makes the
 * reading never answer, as a slow file does.
 */
function pdfWorker(page, fetch, o = {}) {
  const runs = [];
  const w = fakeWorker({
    timerScale: 50,
    tabs: { 9: { id: 9, url: page.url, title: "file", windowId: 1, active: true } },
    onTabMessage: (_tab, m) => (m.action === "scan" ? { elements: [], frames: 0, netView: true, ...page } : { ok: true }),
    fetch,
    executeScript: async (req) => {
      if (req.files) return [{ result: undefined }];
      runs.push(req.args || []);
      if (o.hang) return new Promise(() => {});
      return [{ result: await req.func(...(req.args || [])) }];
    },
  });
  const session = { windowId: 1, run: { id: o.runId || "r1", task: "What does the form say?", status: "running" }, runners: new Map() };
  return { w, runs, session, scan: () => w.engine.scan(session, w.tabs[9], () => {}) };
}

const served = (file, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status === 200, status, headers: { get: () => String(file.length) }, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) };
  };
  return { calls, fetch };
};

test("the engine's scan of a PDF tab gives the file's text page by page, read once per run", async () => {
  const file = simplePdf([["Form W-9 (Rev. March 2024)"], ["Part II Certification"]]);
  const net = served(file);
  const t = pdfWorker({ url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf", contentType: "application/pdf", innerText: "" }, net.fetch);
  const page = await t.scan();
  assert.match(page.innerText, /^## Page 1 of 2\nForm W-9 \(Rev\. March 2024\)/);
  assert.match(page.innerText, /## Page 2 of 2\nPart II Certification/);
  assert.equal(net.calls[0].url, "https://www.irs.gov/pub/irs-pdf/fw9.pdf");
  assert.equal(net.calls[0].init.credentials, "include");
  await t.scan();
  assert.equal(t.runs.length, 1, "the next look in the same run does not read the file again");
  // The run ends: what it read goes with it.
  t.w.engine.release(t.session);
  await t.scan();
  assert.equal(t.runs.length, 2, "kept only for the run that read it");
});

test("a PDF that could not be fetched is not tried again on every step", async () => {
  const net = served(simplePdf([["x"]]), 500);
  const t = pdfWorker({ url: "https://example.org/broken.pdf", contentType: "application/pdf", innerText: "" }, net.fetch);
  assert.equal((await t.scan()).innerText, "[The PDF could not be fetched again (the site answered 500).]");
  await t.scan();
  await t.scan();
  assert.equal(t.runs.length, 1);
  assert.equal(net.calls.length, 1);
});

test("a reading that runs past the wait is waited on briefly a few times, then given up on for the run", async (ctx) => {
  const t = pdfWorker({ url: "https://example.org/huge.pdf", contentType: "application/pdf", innerText: "" }, async () => { throw new Error("unused"); }, { hang: true });
  // The worker's timers do not hold the process open, and the reading never answers.
  const open = setInterval(() => {}, 1000);
  ctx.after(() => clearInterval(open));
  const t0 = Date.now();
  assert.match((await t.scan()).innerText, /could not be read/);
  const first = Date.now() - t0;
  for (let i = 0; i < 6; i++) await t.scan();
  assert.equal(t.runs.length, 4, "the first wait and three short ones, then no more");
  assert.match((await t.scan()).innerText, /took too long/);
  assert.ok(first >= 400, `the first look waits the full time (${first} ms at 1/50)`);
});

test("the engine reads a page that only embeds a PDF from the embed's address, keeping the page's text on failure", async () => {
  const net = served(Buffer.from("<!doctype html><p>not a pdf</p>"));
  const t = pdfWorker({ url: "https://example.org/viewer", contentType: "text/html", pdfEmbed: "https://example.org/files/report.pdf", innerText: "Annual report" }, net.fetch);
  const page = await t.scan();
  assert.equal(t.runs[0][0], "https://example.org/files/report.pdf", "the embed's file, not the HTML page's address");
  assert.equal(page.innerText, "Annual report\n\n[This is not a PDF file.]");
  await t.scan();
  assert.equal(net.calls.length, 1, "and not fetched again on the next look");
});

test("the PDF reader ships in the worker with no new permission", () => {
  const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
  assert.match(read("background.js"), /importScripts\([^)]*'pdfText\.js'/s);
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(!manifest.permissions.includes("debugger"));
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://gemini.google.com/*", "https://www.perplexity.ai/*"]);
});

test("loading the file again in the same tab joins the reading already going", async () => {
  const vm = require("node:vm");
  const src = fs.readFileSync(path.join(EXT, "pdfText.js"), "utf8");
  let fetches = 0;
  const ctx = vm.createContext({
    location: { href: "https://example.test/slow.pdf" },
    fetch: () => { fetches += 1; return new Promise(() => {}); },
  });
  vm.runInContext(src, ctx);
  const first = vm.runInContext("SELECT_TO_AI_PDF.readHere()", ctx);
  vm.runInContext(src, ctx);
  const second = vm.runInContext("SELECT_TO_AI_PDF.readHere()", ctx);
  assert.equal(fetches, 1);
  assert.equal(first, second);
});
