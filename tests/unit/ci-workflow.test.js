const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const projectRoot = path.resolve(__dirname, "../..");
const workflowDir = path.join(projectRoot, ".github", "workflows");
const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: fs.readFileSync(path.join(workflowDir, name), "utf8") }));

// Splits a workflow into its steps: each starts at a "- " list item under "steps:".
function steps(text) {
  const out = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (/^\s*- (uses|run|name|id|if|with|env):?/.test(line) || /^\s*- \w+:/.test(line)) {
      if (current) out.push(current);
      current = [line];
    } else if (current) {
      if (/^\s{0,4}\S/.test(line)) { out.push(current); current = null; } else current.push(line);
    }
  }
  if (current) out.push(current);
  return out.map((lines) => lines.join("\n"));
}

test("a check that tests for a file fails when the file is missing", () => {
  // A step that looks for a test file and only reports the answer lets the job
  // go green while running nothing. Every presence check must stop the job.
  for (const { name, text } of workflows) {
    for (const step of steps(text)) {
      if (!/\[\s*!?\s*-f\s+\S+\s*\]/.test(step)) continue;
      assert.match(step, /exit 1/, `${name}: a file check that does not fail the job:\n${step}`);
    }
  }
});

test("no step is skipped on the answer of a file check", () => {
  for (const { name, text } of workflows) {
    assert.doesNotMatch(text, /if:\s*steps\.\w+\.outputs\.file\b/, `${name} gates steps on a file being present`);
  }
});

test("every test file a workflow runs exists", () => {
  for (const { name, text } of workflows) {
    for (const [, file] of text.matchAll(/\bnode\s+((?:tests|scripts)\/[\w./-]+\.(?:js|mjs|cjs))/g)) {
      assert.ok(fs.existsSync(path.join(projectRoot, file)), `${name} runs ${file}, which is not in the repo`);
    }
  }
});
