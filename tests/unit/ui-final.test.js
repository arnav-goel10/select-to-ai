"use strict";
// The interface items from the design critique that the first round left:
// the Recipes empty state, the sidebar, the composer, the header and the
// view under it, and the Memory panel's pause switch.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const read = (name) => fs.readFileSync(path.resolve(__dirname, "../../extension", name), "utf8");
const agentJs = read("agent.js");
const agentCss = read("agent.css");
const agentHtml = read("agent.html");
const uiCss = read("ui.css");
/** The body of one CSS rule, by its exact selector. */
const rule = (css, selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};
const fn = (name) => agentJs.slice(agentJs.indexOf(`function ${name}(`), agentJs.indexOf("\n  }\n", agentJs.indexOf(`function ${name}(`)));

test("Recipes with none saved says what one is for and offers a way to start", () => {
  const empty = fn("recipesEmptyState");
  assert.match(empty, /Start a task/);
  assert.match(empty, /closeRecipesModal\(\);\s*taskInput\.focus\(\)/, "the action closes the sheet and puts the user in the box");
  assert.doesNotMatch(agentHtml, /cheap tier|low-cost model call/, "the intro has no model jargon");
  assert.match(rule(uiCss, ".modal"), /align-items: safe center/, "a short dialog sits in the middle, not at the top");
});

test("the sidebar's New task is a button, not a box, and the status dots are explained", () => {
  const btn = rule(agentCss, ".new-task-btn");
  assert.match(btn, /border: 0/);
  assert.match(btn, /background: transparent/);
  assert.match(agentHtml, /class="new-task-mark"/, "a filled mark says it is an action");
  const recent = fn("renderRecentSessions");
  assert.match(recent, /outcome-legend/, "a legend names each colour of dot in the list");
  assert.match(recent, /dot\.title = OUTCOME_WORDS\[outcome\]/, "each dot says what it means on hover");
  assert.match(rule(agentCss, ".sidebar-chat-item .session-title"), /-webkit-line-clamp: 2/, "titles get two lines before the cut");
});

test("in the composer the model is quiet and the cost says what it is", () => {
  const pill = rule(agentCss, ".composer-bar .header-model");
  assert.match(pill, /background: transparent/);
  assert.match(pill, /border-color: transparent/);
  assert.match(fn("updateCostDashboard"), /\} spent`/, "the amount is labelled as spent");
});

test("the header gives the goal two lines and Stop shrinks to a square on a narrow panel", () => {
  assert.match(rule(agentCss, ".live-goal"), /-webkit-line-clamp: 2/);
  assert.match(rule(agentCss, ".topbar"), /min-height: var\(--topbar-h\)/, "the header can grow for a second line");
  assert.match(agentHtml, /id="liveStopBtn" aria-label="Stop the task"/);
  assert.match(agentCss, /\.live-stop \.live-stop-label \{ display: none; \}/);
});

test("text scrolled under the header fades out instead of being cut mid-line", () => {
  assert.match(rule(agentCss, ".chat-viewport.is-scrolled"), /mask-image: linear-gradient\(to bottom, transparent 0, #000 20px\)/);
  assert.match(rule(agentCss, ".chat-viewport"), /scroll-padding-top: 20px/);
  assert.match(agentJs, /classList\.toggle\("is-scrolled", chatViewport\.scrollTop > 0\)/);
});

test("the Memory pause switch says what it does in two short parts", () => {
  assert.match(agentHtml, /<span>Pause memory<\/span><span class="memory-toggle-hint" id="knownPausedHint">While paused, nothing is used or learned\.<\/span>/);
  assert.match(fn("renderKnown"), /KNOWN\.fieldLayout\(fields\)/, "the details are laid out by group");
});
