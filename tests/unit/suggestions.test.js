const test = require("node:test");
const assert = require("node:assert/strict");
const suggestions = require("../../extension/suggestions.js");

test("github URLs get repository-specific suggestions", () => {
  const s = suggestions.buildSuggestions(
    "https://github.com/arnav-goel10/select-to-ai",
  );
  assert.equal(s.length, 3);
  assert.ok(s[0].prompt.toLowerCase().includes("repositor"));
});

test("shopping sites get product comparison suggestions", () => {
  const s = suggestions.buildSuggestions("https://www.amazon.sg/dp/B0XYZ");
  assert.equal(s.length, 3);
  assert.ok(s.some((x) => /product|price|review/i.test(x.prompt)));
});

test("unknown sites fall back to generic suggestions", () => {
  const s = suggestions.buildSuggestions("https://example-mystery-site.org/page");
  assert.equal(s.length, 3);
  assert.ok(s[0].prompt.toLowerCase().includes("summarize"));
});

test("empty or protected-page URLs still yield three suggestions", () => {
  for (const url of ["", "chrome://newtab", "not a url"]) {
    const s = suggestions.buildSuggestions(url);
    assert.equal(s.length, 3, `url: ${url}`);
    for (const item of s) {
      assert.ok(item.label && item.prompt);
    }
  }
});

test("suggestions are deterministic for the same input", () => {
  const a = suggestions.buildSuggestions("https://stackoverflow.com/q/123");
  const b = suggestions.buildSuggestions("https://stackoverflow.com/q/123");
  assert.deepEqual(a, b);
});

test("every suggestion prompt is a self-contained agent task", () => {
  const urls = [
    "https://github.com/x/y",
    "https://www.amazon.com/dp/1",
    "https://youtube.com/watch?v=1",
    "https://linkedin.com/in/someone",
    "https://en.wikipedia.org/wiki/Test",
    "https://docs.example.dev/guide",
    "https://stackoverflow.com/q/1",
    "https://www.bbc.com/news",
    "https://random-site.io",
  ];
  for (const url of urls) {
    for (const s of suggestions.buildSuggestions(url)) {
      // Prompts must be imperative sentences long enough to be unambiguous.
      assert.ok(s.prompt.length > 30, `${url}: ${s.prompt}`);
      assert.ok(/^[A-Z]/.test(s.prompt), s.prompt);
    }
  }
});
