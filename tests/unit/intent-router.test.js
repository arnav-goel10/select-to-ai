const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const router = require(path.resolve(__dirname, "../../extension/intentRouter.js"));
const { classifyOmniboxInput, normalizeNavigationUrl } = router;

function intentOf(input) {
  return classifyOmniboxInput(input).intent;
}

test("bare domains navigate", () => {
  assert.equal(intentOf("youtube.com"), "navigate");
  assert.equal(intentOf("news.ycombinator.com/item?id=1"), "navigate");
  assert.equal(intentOf("https://example.org/path"), "navigate");
  assert.equal(intentOf("localhost:3000"), "navigate");
  assert.equal(intentOf("192.168.1.1"), "navigate");
});

test("known single-word sites navigate", () => {
  assert.equal(intentOf("youtube"), "navigate");
  assert.equal(intentOf("gmail"), "navigate");
  assert.equal(classifyOmniboxInput("github").url, "https://github.com");
});

test("navigation prefixes with a site navigate", () => {
  assert.equal(intentOf("open youtube.com"), "navigate");
  assert.equal(intentOf("go to github"), "navigate");
  assert.equal(intentOf("visit arnavg.com"), "navigate");
});

test("navigation verb followed by a task goes to the agent", () => {
  assert.equal(intentOf("open youtube and play lofi beats"), "agent");
  assert.equal(intentOf("go to amazon and find a usb-c cable under 10 dollars"), "agent");
});

test("questions go to ask", () => {
  assert.equal(intentOf("what is a bloom filter?"), "ask");
  assert.equal(intentOf("how do I center a div"), "ask");
  assert.equal(intentOf("explain the transformer architecture"), "ask");
  assert.equal(intentOf("is rust worth learning"), "ask");
});

test("random words fall back to ask, not navigation", () => {
  assert.equal(intentOf("hello"), "ask");
  assert.equal(intentOf("cheap flights inspiration"), "ask");
  const res = classifyOmniboxInput("hello");
  assert.equal(res.confidence, "low");
});

test("imperative browser work goes to the agent", () => {
  assert.equal(intentOf("search for mechanical keyboards on amazon"), "agent");
  assert.equal(intentOf("fill the signup form with my details"), "agent");
  assert.equal(intentOf("compare iphone prices then list the cheapest"), "agent");
  assert.equal(intentOf("close all my tabs"), "agent");
});

test("page and tab context forces the agent", () => {
  assert.equal(intentOf("summarize this page"), "agent");
  assert.equal(intentOf("what does this page say about pricing"), "agent");
  assert.equal(intentOf("close these tabs"), "agent");
});

test("find out reads as a question", () => {
  assert.equal(intentOf("find out who founded stripe"), "ask");
  assert.equal(intentOf("find a cheap hotel on booking.com"), "agent");
});

test("explicit prefixes override everything", () => {
  assert.equal(intentOf("ask youtube.com"), "ask");
  assert.equal(intentOf("do open youtube.com"), "agent");
  assert.equal(intentOf("agent: check my github notifications"), "agent");
  assert.equal(classifyOmniboxInput("ask what is love").query, "what is love");
});

test("normalizeNavigationUrl accepts http(s) shapes only", () => {
  assert.equal(normalizeNavigationUrl("example.com"), "https://example.com/");
  assert.equal(normalizeNavigationUrl("http://example.com/a"), "http://example.com/a");
  assert.equal(normalizeNavigationUrl("javascript:alert(1)"), null);
  assert.equal(normalizeNavigationUrl("file:///etc/passwd"), null);
  assert.equal(normalizeNavigationUrl("https://user:pass@example.com"), null);
  assert.equal(normalizeNavigationUrl("not a url"), null);
  assert.equal(normalizeNavigationUrl("wordwithnodot"), null);
});

test("classification is total: never throws, always returns an intent", () => {
  const weird = ["", "   ", "?", "🤖", "a", String("x").repeat(5000), null, undefined];
  for (const w of weird) {
    const res = classifyOmniboxInput(w);
    assert.ok(["navigate", "ask", "agent"].includes(res.intent));
  }
});
