"use strict";
// Test-only. The content script is one closure that needs a page, so a unit
// test takes single functions out of its source by name and runs them with
// stand-ins for the page.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const CONTENT = fs.readFileSync(path.join(__dirname, "../../extension/agentContentScript.js"), "utf8");

/** The source of one top-level function of the content script, by name. */
function source(name) {
  const at = [`    function ${name}(`, `    async function ${name}(`].map((s) => CONTENT.indexOf(s)).filter((i) => i > 0).sort((a, b) => a - b)[0];
  assert.ok(at > 0, `${name} is in agentContentScript.js`);
  const end = CONTENT.indexOf("\n    }\n", at);
  return CONTENT.slice(at, end + 6);
}

/**
 * The named functions, made with `scope` as the names they reach for.
 * Returns them by name.
 */
function build(names, scope) {
  const keys = Object.keys(scope);
  const make = new Function(...keys, `${names.map(source).join("\n")}\nreturn { ${names.join(", ")} };`);
  return make(...keys.map((k) => scope[k]));
}

module.exports = { CONTENT, source, build };
