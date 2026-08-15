const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const tools = require("../../extension/agentTools.js");
const config = require("../../extension/config.js");

const extensionRoot = path.resolve(__dirname, "../../extension");
const read = (name) => fs.readFileSync(path.join(extensionRoot, name), "utf8");

// ---------------------------------------------------------------------------
// renderSafeMarkdown: minimal safe subset, everything escaped first
// ---------------------------------------------------------------------------

test("renderSafeMarkdown escapes HTML before any formatting", () => {
  const html = tools.renderSafeMarkdown('<img src=x onerror=alert(1)> & "quotes"');
  assert.ok(!html.includes("<img"), "raw tags must be escaped");
  assert.ok(html.includes("&lt;img"), "escaped tag text is preserved");
  assert.ok(html.includes("&amp;"), "ampersands are escaped");
});

test("renderSafeMarkdown renders bold and italics", () => {
  const html = tools.renderSafeMarkdown("This is **bold** and *slanted* and _also slanted_.");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>slanted</em>"));
  assert.ok(html.includes("<em>also slanted</em>"));
});

test("renderSafeMarkdown keeps snake_case untouched", () => {
  const html = tools.renderSafeMarkdown("value of user_name_field stays plain");
  assert.ok(!html.includes("<em>"), `no italics expected, got: ${html}`);
});

test("renderSafeMarkdown renders bullet lists", () => {
  const html = tools.renderSafeMarkdown("Results:\n- first\n- second\n* third");
  assert.ok(html.includes("<ul><li>first</li><li>second</li><li>third</li></ul>"));
  assert.ok(html.includes("<p>Results:</p>"));
});

test("renderSafeMarkdown renders http(s) links with noopener", () => {
  const html = tools.renderSafeMarkdown("See [docs](https://example.com/a?b=1).");
  assert.ok(html.includes('href="https://example.com/a?b=1"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes(">docs</a>"));
});

test("renderSafeMarkdown never links javascript: or data: URLs", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) {
    const html = tools.renderSafeMarkdown(`click [here](${url})`);
    assert.ok(!html.includes("<a "), `no anchor expected for ${url}: ${html}`);
  }
});

test("renderSafeMarkdown handles empty and non-string input", () => {
  assert.equal(tools.renderSafeMarkdown(""), "");
  assert.equal(tools.renderSafeMarkdown(null), "");
  assert.equal(tools.renderSafeMarkdown(undefined), "");
});

test("escapeHtml escapes all five significant characters", () => {
  assert.equal(
    tools.escapeHtml(`<a href="x" data-y='z'>&</a>`),
    "&lt;a href=&quot;x&quot; data-y=&#039;z&#039;&gt;&amp;&lt;/a&gt;",
  );
});

// ---------------------------------------------------------------------------
// Provider insertion adapters
// ---------------------------------------------------------------------------

test("adapters exist for every supported chat service with ordered chains", () => {
  for (const service of ["CHATGPT", "GEMINI", "PERPLEXITY", "CLAUDE"]) {
    const adapter = config.ADAPTERS[service];
    assert.ok(adapter, `missing adapter for ${service}`);
    assert.ok(Array.isArray(adapter.input) && adapter.input.length > 0);
    assert.ok(Array.isArray(adapter.send) && adapter.send.length > 0);
  }
});

test("no last-resort button:has(svg) selectors remain anywhere", () => {
  const configText = read("config.js");
  assert.ok(!configText.includes(":has("), "config.js still has a :has() selector");
  const contentText = read("contentScript.js");
  assert.ok(!contentText.includes(":has("), "contentScript.js still has a :has() selector");
});

test("prefill URLs cover ChatGPT and Perplexity and carry the query slot", () => {
  assert.ok(config.PREFILL_URLS.CHATGPT.startsWith("https://chatgpt.com/?q="));
  assert.ok(
    config.PREFILL_URLS.PERPLEXITY.startsWith("https://www.perplexity.ai/search?q="),
  );
  for (const template of Object.values(config.PREFILL_URLS)) {
    assert.ok(template.includes("{query}"), `template missing {query}: ${template}`);
  }
});

// ---------------------------------------------------------------------------
// Design-system hygiene across the four surfaces
// ---------------------------------------------------------------------------

const PAGES = ["popup.html", "options.html", "sidepanel.html", "agent.html"];

test("all four pages link the shared tokens stylesheet", () => {
  for (const page of PAGES) {
    assert.ok(
      read(page).includes('href="tokens.css"'),
      `${page} does not link tokens.css`,
    );
  }
});

test("the never-bundled Outfit font is gone", () => {
  for (const page of PAGES) {
    assert.ok(!read(page).includes("Outfit"), `${page} still declares Outfit`);
  }
});

test("page titles are distinct", () => {
  const titles = PAGES.map((page) => {
    const match = read(page).match(/<title>([^<]*)<\/title>/);
    return match ? match[1].trim() : "";
  });
  assert.equal(new Set(titles).size, titles.length, `duplicate titles: ${titles}`);
});

test("theme toggles no longer ship the meaningless aria-label auto", () => {
  for (const page of PAGES) {
    assert.ok(
      !read(page).includes('aria-label="auto"'),
      `${page} still has aria-label="auto"`,
    );
  }
});

test("popup is a launcher: per-service and behavior toggles live in Options only", () => {
  const popup = read("popup.html");
  for (const id of ['id="chatgpt"', 'id="gemini"', 'id="perplexity"', 'id="claude"', 'id="autoSend"', 'id="autoContext"']) {
    assert.ok(!popup.includes(id), `popup.html still contains ${id}`);
  }
  const options = read("options.html");
  for (const id of ['id="showChatGPT"', 'id="autoSend"', 'id="autoContext"']) {
    assert.ok(options.includes(id), `options.html lost ${id}`);
  }
});

test("options page ships the onboarding wizard markup its logic expects", () => {
  const options = read("options.html");
  for (const needle of [
    'id="onboarding-overlay"',
    'id="wizardProvider"',
    'id="wizardApiKey"',
    'id="wizardKeyLabel"',
    'id="wizardUrlGroup"',
    'id="wizardCustomUrl"',
    'id="wizard-test-btn"',
    'id="wizard-test-status"',
    'id="wizard-step-3-next"',
    "next-step-btn",
    "prev-step-btn",
    "skip-onboarding-btn",
    "finish-onboarding-btn",
    'id="agentModelList"',
    'id="extension-version"',
  ]) {
    assert.ok(options.includes(needle), `options.html missing ${needle}`);
  }
  // Four wizard steps, first active.
  const stepCount = (options.match(/class="onboarding-step/g) || []).length;
  assert.equal(stepCount, 4, `expected 4 wizard steps, found ${stepCount}`);
});

test("agent page log timestamps are legible (no 9px fonts remain)", () => {
  assert.ok(!/font-size:\s*9px/.test(read("agent.html")));
});
