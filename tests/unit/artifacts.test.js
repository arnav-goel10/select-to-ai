const test = require("node:test");
const assert = require("node:assert/strict");
const artifacts = require("../../extension/artifacts.js");

test("rowsToCsv quotes cells with separators, quotes, newlines", () => {
  assert.equal(artifacts.rowsToCsv([["a", "b"]]), "a,b");
  assert.equal(artifacts.rowsToCsv([["a,x", 'say "hi"']]), '"a,x","say ""hi"""');
  const multiline = artifacts.rowsToCsv([["line1\nline2"]]);
  assert.equal(multiline, '"line1\nline2"');
});

test("object rows get a union-key header row", () => {
  const csv = artifacts.rowsToCsv([
    { name: "Widget", price: 9.99 },
    { name: "Gadget", rating: 4.5 },
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "name,price,rating");
  assert.equal(lines[1], "Widget,9.99,");
  assert.equal(lines[2], "Gadget,,4.5");
});

test("extractArtifacts finds a markdown table with title and CSV", () => {
  const answer = [
    "Here is the comparison:",
    "",
    "**Product comparison**",
    "",
    "| Product | Price | Rating |",
    "|---------|-------|--------|",
    "| A       | $10   | 4.5    |",
    "| B       | $12   | 4.0    |",
    "",
    "That is all.",
  ].join("\n");
  const found = artifacts.extractArtifacts(answer);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "table");
  assert.equal(found[0].title, "Product comparison");
  assert.equal(found[0].rows.length, 3);
  assert.ok(found[0].csv.includes("A,$10,4.5"));
});

test("extractArtifacts ignores separator-only or malformed tables", () => {
  assert.equal(
    artifacts.extractArtifacts("| a |\n| - |").length,
    0,
    "separator without body rows",
  );
  assert.equal(artifacts.extractArtifacts("").length, 0);
});

test("extractArtifacts pulls JSON arrays from fenced blocks", () => {
  const answer = [
    "Data:",
    "```json",
    '[{"item":"pen","qty":2},{"item":"pad","qty":1}]',
    "```",
  ].join("\n");
  const found = artifacts.extractArtifacts(answer);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "json");
  assert.equal(found[0].csv.split("\r\n")[0], "item,qty");
});

test("extractArtifacts skips invalid JSON fences", () => {
  const answer = "```json\n[{broken\n```";
  assert.equal(artifacts.extractArtifacts(answer).length, 0);
});

test("renderArtifactButtons creates one button per downloadable artifact", () => {
  const made = [];
  const list = [
    { kind: "table", title: "T", rows: [["a"]], csv: "a" },
    { kind: "json", title: "D", rows: [{ x: 1 }], csv: "x\r\n1" },
    { kind: "json", title: "Empty", rows: [], csv: "" },
  ];
  const count = artifacts.renderArtifactButtons(list, "", (label, onClick) => {
    made.push({ label, onClick });
    return {};
  });
  assert.equal(count, 2);
  assert.match(made[0].label, /table as CSV/);
  assert.match(made[1].label, /data as CSV/);
});

test("slugify produces safe filename fragments", () => {
  assert.equal(artifacts.slugify("Product Comparison!!"), "product-comparison");
  assert.equal(artifacts.slugify(""), "");
});
