const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Every text and control pair in tokens.css meets WCAG AA in light and dark.
test("every colour pair in tokens.css meets WCAG AA in both themes", () => {
  const script = path.resolve(__dirname, "../../scripts/contrast.mjs");
  const rows = JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8" }));
  assert.ok(rows.length >= 40, `only ${rows.length} pairs were checked`);
  const below = rows.filter((r) => !r.pass).map((r) => `${r.fg} on ${r.bg} (${r.use}): ${r.light} light, ${r.dark} dark, needs ${r.min}`);
  assert.deepEqual(below, []);
});

test("no violet or blue accent is left in the palette", () => {
  const fs = require("node:fs");
  const ext = path.resolve(__dirname, "../../extension");
  for (const file of ["tokens.css", "ui.css", "agent.css", "commandPalette.js", "agentContentScript.js", "popup.html", "options.html", "welcome.html"]) {
    const text = fs.readFileSync(path.join(ext, file), "utf8");
    for (const hex of ["#5051cf", "#8f9bfb", "#5c62d2", "#7c3aed", "#6d28d9", "#8b5cf6", "#4243b8"]) {
      assert.ok(!text.toLowerCase().includes(hex), `${file} still holds ${hex}`);
    }
  }
});
