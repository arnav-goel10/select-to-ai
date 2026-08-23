const test = require("node:test");
const assert = require("node:assert/strict");
const mem = require("../../extension/memoryProfile.js");

test("addFact normalizes whitespace and caps length", () => {
  const list = mem.addFact([], "  I   prefer metric   units  ");
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "I prefer metric units");
  const tooLong = mem.addFact([], "x".repeat(500));
  assert.equal(tooLong[0].text.length, mem.MAX_FACT_CHARS);
});

test("addFact rejects empty input and dedupes case-insensitively", () => {
  let list = mem.addFact([], "");
  assert.equal(list.length, 0);
  list = mem.addFact(list, "Always cite sources");
  const same = mem.addFact(list, "always cite sources ");
  assert.equal(same.length, 1, "duplicate must not be added");
});

test("removeFact drops the matching fact only", () => {
  let list = [];
  list = mem.addFact(list, "Based in Singapore");
  list = mem.addFact(list, "Always cite sources");
  const after = mem.removeFact(list, "based in singapore");
  assert.equal(after.length, 1);
  assert.equal(after[0].text, "Always cite sources");
});

test("profile is capped at MAX_FACTS with oldest falling off", () => {
  let list = [];
  for (let i = 0; i < mem.MAX_FACTS + 10; i++) {
    list = mem.addFact(list, `fact number ${i}`);
  }
  assert.equal(list.length, mem.MAX_FACTS);
  // Oldest (fact 0..9) fell off.
  assert.ok(!list.some((f) => f.text === "fact number 0"));
  assert.ok(list.some((f) => f.text === `fact number ${mem.MAX_FACTS + 9}`));
});

test("formatProfileForPrompt renders numbered context or empty string", () => {
  assert.equal(mem.formatProfileForPrompt([]), "");
  assert.equal(mem.formatProfileForPrompt(null), "");
  const prompt = mem.formatProfileForPrompt([
    { text: "Based in Singapore" },
    { text: "Always cite sources" },
  ]);
  assert.ok(prompt.includes("1. Based in Singapore"));
  assert.ok(prompt.includes("2. Always cite sources"));
  assert.ok(prompt.includes("user-editable"), "must disclose editability in the prompt");
});
