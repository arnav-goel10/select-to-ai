const test = require("node:test");
const assert = require("node:assert/strict");
const companion = require("../../extension/companion.js");

test("four quick actions exist with distinct ids and templates", () => {
  const ids = companion.QUICK_ACTIONS.map((a) => a.id);
  assert.equal(ids.length, new Set(ids).size, "ids must be unique");
  assert.ok(ids.includes("summarize"));
  assert.ok(ids.includes("keypoints"));
  assert.ok(ids.includes("extract"));
  assert.ok(ids.includes("draft-reply"));
});

test("buildQuickActionPrompt substitutes url and page text", () => {
  const prompt = companion.buildQuickActionPrompt(
    "summarize",
    "https://example.com/article",
    "Some page text",
  );
  assert.ok(prompt.includes("https://example.com/article"));
  assert.ok(prompt.includes("Some page text"));
  assert.ok(!prompt.includes("{url}"));
  assert.ok(!prompt.includes("{page}"));
});

test("page text is truncated to the hard cap", () => {
  const huge = "x".repeat(companion.MAX_PAGE_CHARS + 5000);
  const prompt = companion.buildQuickActionPrompt("extract", "https://e.com", huge);
  // The template plus truncated page must stay bounded.
  assert.ok(prompt.length < companion.MAX_PAGE_CHARS + 300);
});

test("empty page falls back to a readable placeholder", () => {
  const prompt = companion.buildQuickActionPrompt("keypoints", "", "");
  assert.ok(prompt.includes("(no readable text)"));
  assert.ok(prompt.includes("(current page)"));
});

test("unknown action id returns null", () => {
  assert.equal(companion.buildQuickActionPrompt("nope", "u", "t"), null);
});
