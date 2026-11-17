"use strict";
// Test-only. Writes small PDF files by hand, so each part of the format
// extension/pdfText.js reads can be checked on its own, and so the e2e
// server can serve a real PDF without one being checked in.
const zlib = require("node:zlib");

const pad = (n, w) => String(n).padStart(w, "0");

/**
 * objects: [{num, dict, data?}] where dict is the object's text (a
 * dictionary for a stream) and data its stream bytes. seal(num, bytes)
 * encrypts a stream's bytes. Returns the file as a Buffer.
 */
function writePdf(objects, trailer, seal) {
  const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let size = parts[0].length;
  const offsets = {};
  for (const o of objects) {
    offsets[o.num] = size;
    let chunk;
    if (o.data) {
      const data = seal ? seal(o.num, o.data) : o.data;
      const dict = o.dict.replace(/>>\s*$/, ` /Length ${data.length} >>`);
      chunk = Buffer.concat([Buffer.from(`${o.num} 0 obj\n${dict}\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    } else chunk = Buffer.from(`${o.num} 0 obj\n${o.dict}\nendobj\n`, "latin1");
    parts.push(chunk);
    size += chunk.length;
  }
  const max = Math.max(...objects.map((o) => o.num));
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) xref += offsets[i] !== undefined ? `${pad(offsets[i], 10)} 00000 n \n` : "0000000000 65535 f \n";
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${max + 1} ${trailer} >>\nstartxref\n${size}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

const flate = (s) => zlib.deflateSync(Buffer.from(s, "latin1"));
const escape = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A plain PDF: one page per entry of `pages`, each an array of lines, set
 * in Helvetica with Flate-compressed content streams.
 */
function simplePdf(pages) {
  const font = 3 + pages.length * 2;
  const kids = pages.map((_p, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = [
    { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, dict: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} /Resources << /Font << /F1 ${font} 0 R >> >> >>` },
  ];
  pages.forEach((lines, i) => {
    const body = ["BT /F1 12 Tf 14 TL 72 720 Td", ...lines.map((l, j) => `${j ? "T* " : ""}(${escape(l)}) Tj`), "ET"].join("\n");
    objects.push({ num: 3 + i * 2, dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>` });
    objects.push({ num: 4 + i * 2, dict: "<< /Filter /FlateDecode >>", data: flate(body) });
  });
  objects.push({ num: font, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });
  return writePdf(objects, "/Root 1 0 R");
}

module.exports = { writePdf, flate, simplePdf };
