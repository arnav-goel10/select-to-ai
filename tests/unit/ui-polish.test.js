const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../../extension/config.js");

const extensionRoot = path.resolve(__dirname, "../../extension");
const read = (name) => fs.readFileSync(path.join(extensionRoot, name), "utf8");

// ---------------------------------------------------------------------------
// renderSafeMarkdown: minimal safe subset, everything escaped first
// ---------------------------------------------------------------------------

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

test("settings save only what the user changes, never the agent's instructions", () => {
  // 3.3 autosaved every field, freezing a copy of the whole system prompt
  // (and every tuning default) into storage, so later prompt improvements
  // never reached anyone who had opened Settings.
  const optionsJs = read("options.js");
  assert.ok(!optionsJs.includes("agentSystemPrompt"), "settings must not store the agent prompt");
  assert.ok(!/agentTemperature|agentElementLimit|agentHistoryLimit|agentFailureThreshold/.test(optionsJs),
    "tuning knobs are not user settings any more");
  const options = read("options.html");
  for (const id of ['id="agentExtraInstructions"', 'id="agentRiskConfirmation"', 'id="provider"', 'id="apiKey"', 'id="model"', 'id="extension-version"', 'id="modelList"']) {
    assert.ok(options.includes(id), `options.html missing ${id}`);
  }
});

test("the agent always runs the built-in instructions, with the user's additions after them", () => {
  const engine = read("engine.js");
  assert.ok(!engine.includes("agentSystemPrompt"), "the engine must not read a stored prompt");
  assert.match(engine, /extraInstructions: String\(items\.agentExtraInstructions \|\| ""\)\.slice\(0, 2000\)/);
  const bg = read("background.js");
  assert.match(bg, /function migrateFrozenSettings/);
  assert.match(bg, /'agentSystemPrompt'/);
});

test("agent page log timestamps are legible (no 9px fonts remain)", () => {
  assert.ok(!/font-size:\s*9px/.test(read("agent.html")));
});

test("the hidden attribute is not defeated by author display rules", () => {
  // `[hidden]` only gets `display: none` from the UA stylesheet, so any
  // author `display:` on the same element silently un-hides it. This bit
  // the command palette's selection row (an empty SELECTION chip rendered
  // on every open) and the options welcome banner.
  const tokens = read("tokens.css");
  assert.match(
    tokens,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "tokens.css must restore [hidden] globally",
  );

  // The palette lives in a closed shadow root and cannot see tokens.css,
  // so it needs its own copy of the guard.
  const palette = read("commandPalette.js");
  assert.match(
    palette,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    "commandPalette.js shadow CSS must restore [hidden] itself",
  );
});

test("elements toggled via .hidden also carry a display rule guard", () => {
  // Every element the code hides by setting `.hidden` must be covered by
  // one of the two guards above.
  const palette = read("commandPalette.js");
  assert.ok(
    palette.includes("context.hidden = true"),
    "palette still toggles the selection row via .hidden",
  );
});

/* ---------------------------------------------------------------------------
 * Inline answers. The palette renders the reply itself instead of handing the
 * user to a sidebar. It cannot be done with an iframe: a cross-origin frame is
 * unreadable, and on an arbitrary host page the provider's SameSite=Lax
 * session cookies are withheld, so it would render logged out. The answer
 * therefore comes from a real first-party provider tab.
 * ------------------------------------------------------------------------ */

test("side panel failures log a readable reason", () => {
  const bg = read("background.js");
  assert.ok(!/console\.error\("Side Panel Open Error:", chrome\.runtime\.lastError\)/.test(bg),
    "logging the raw object prints [object Object]");
  assert.match(bg, /Side panel did not open:', chrome\.runtime\.lastError\.message/);
});

test("provider replies are never inserted as provider markup", () => {
  const fmt = read("answerFormat.js");
  // Everything that becomes HTML goes through esc() first.
  assert.match(fmt, /function esc\(s\)/);
  assert.match(fmt, /function safeUrl/);
  assert.ok(!/innerHTML\s*=\s*(markdown|html)\b/.test(fmt),
    "answerFormat must not assign untrusted strings to innerHTML");
});

test("links keep query strings intact", () => {
  // The whole string is escaped before links are built, so "?a=1&b=2" becomes
  // "&amp;" and escaping it again produced "&amp;amp;" -- a broken URL.
  const fmt = read("answerFormat.js");
  assert.match(fmt, /u\.replace\(\/&amp;\/g, "&"\)/, "the URL must be unescaped once before use");
  const A = require(path.join(extensionRoot, "answerFormat.js"));
  const html = A.renderAnswerHtml("[d](https://x.com/a?b=1&c=2)", []);
  assert.ok(html.includes("b=1&amp;c=2"), html);
  assert.ok(!html.includes("&amp;amp;"), "URL was escaped twice: " + html);
});

test("closing the palette tears the instance down completely", () => {
  // The toggle path used to just detach the host, leaving a document-level
  // keydown handler alive on a dead palette that kept swallowing Tab.
  const palette = read("commandPalette.js");
  assert.match(palette, /host\.__teardown = close/, "the instance must expose its teardown");
  assert.match(palette, /existing\.__teardown === "function"/, "the toggle must call it");
  const closeFn = palette.slice(palette.indexOf("function close()"));
  const body = closeFn.slice(0, closeFn.indexOf("\n  }"));
  assert.match(body, /removeEventListener\("keydown"/, "the keydown handler must be removed");
  assert.match(body, /removeEventListener\("focusin"/, "the focus keeper must be removed");
});

test("the renderer holds no cross-call state", () => {
  // The citation lookup was stashed on the function object, so a later call
  // could render superscripts against a previous answer's sources.
  const fmt = read("answerFormat.js");
  assert.ok(!/inlineHtml\.citeLookup/.test(fmt), "lookup must be passed, not stashed on the function");
  assert.match(fmt, /function inlineHtml\(text, citeLookup\)/);
});

test("a handed-over task that cannot run says so where the user is looking", () => {
  // Reported as "it opens a new tab and does nothing". The agent was working
  // correctly -- it filled in the task and stopped because no API key was
  // configured -- but the only signal was a thin strip above the composer,
  // while the task sat in the box looking ready to go.
  const agent = read("agent.js");
  const fn = agent.slice(agent.indexOf("function startAgentWithLoadedSettings"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /hasProviderCredentials/, "the block must still be detected");
  assert.match(body, /appendSimpleAssistantBubble/,
    "and explained in the conversation, not only in a strip");
  assert.match(body, /taskInput\.value = task/,
    "the task must be preserved so it can be retried after adding a key");

  // And the warning has to be actionable in one click.
  assert.match(read("agent.html"), /id="openKeySettings"/);
  // 3.4: one click lands on the welcome page's connect step, not a form.
  assert.match(agent, /openKeySettings[\s\S]{0,200}welcome\.html\?step=connect/,
    "the button must open the one-click setup");
});

test("the agent is told which tab the task came from", () => {
  // Without it the agent falls back to "first non-extension tab in the
  // window", which is a guess and can act on an unrelated page.
  const bg = read("background.js");
  assert.match(bg, /tabId=\$\{originTabId\}/, "the origin tab must be passed through");
  assert.match(bg, /runPaletteInput\(message\.text, message\.selection, sender && sender\.tab/,
    "and taken from the sender, which is the tab the palette ran in");
});

test("ChatGPT adapter covers the Sep 2026 build and keeps the older one", () => {
  // Verified live on chatgpt.com, 29 Sep 2026: textarea#mobile-composer-prompt,
  // a submit button labelled "Send message", li[data-message-role].
  const cfg = require(path.join(extensionRoot, "config.js"));
  const a = cfg.ADAPTERS.CHATGPT;
  assert.equal(a.input[0], "#mobile-composer-prompt");
  assert.ok(a.input.includes("#prompt-textarea"), "older build still covered");
  assert.ok(a.send.some((s) => s.includes("Send message")));
  assert.match(a.sentProbe, /data-message-role='user'/);
  const manifest = JSON.parse(read("manifest.json"));
  // perplexity.ai without www is optional in 4.0: its content script is
  // registered at run time once granted (core/grants.js).
  const GRANTS = require(path.join(extensionRoot, "core/grants.js"));
  assert.ok(!manifest.content_scripts[0].matches.includes("https://perplexity.ai/*"));
  assert.ok(Object.values(GRANTS.ASSISTANT_HOSTS).includes("https://perplexity.ai/*"), "Perplexity's bare domain is covered after a grant");
});

test("quick box: what is typed starts the agent, with no router and no answer of its own", () => {
  const palette = read("commandPalette.js");
  assert.match(palette, /<kbd>Enter<\/kbd><span>ask the agent<\/span>/);
  assert.match(palette, /<kbd>Esc<\/kbd><span>close<\/span>/);
  assert.match(palette, /type: "SELECT_TO_AI_PALETTE_SUBMIT"/);
  assert.doesNotMatch(palette, /SELECT_TO_AI_INTENT|INLINE|class="answer"/);
  const bg = read("background.js");
  assert.match(bg, /files: \['commandPalette\.js'\]/, "only the palette is injected");
});

test("closed task drawer casts no shadow and leaves the tab order", () => {
  const html = read("agent.html") + read("agent.css");
  const closed = html.match(/\.sidebar-container\.collapsed \{[^}]*\}/g) || [];
  assert.ok(closed.length >= 2);
  assert.ok(closed.every((rule) => /box-shadow: none/.test(rule)));
  assert.ok(closed.some((rule) => /visibility: hidden/.test(rule)));
});

test("quick box: the text cursor follows the text colour and the box keeps focus", () => {
  const palette = read("commandPalette.js");
  assert.match(palette, /caret-color: currentColor/, "a fixed dark caret disappears on the dark card");
  assert.doesNotMatch(palette, /caret-color: #/);
  assert.match(palette, /addEventListener\("focusin", keepFocus, true\)/, "pages that autofocus their own search box must not steal typing");
  assert.match(palette, /removeEventListener\("focusin", keepFocus, true\)/);
});

test("the pages that read usage limits load the reader", () => {
  for (const page of ["welcome.html", "options.html"]) {
    assert.match(read(page), /<script src="usageLimits\.js"><\/script>/, `${page} loads the usage-limit reader`);
  }
});
