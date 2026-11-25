"use strict";
/**
 * The cached conversation takes the same actions as the one message did:
 * the v4 scenarios (run-v4.js) run twice, once with each step asked as one
 * message (E2E_PROMPT_CACHING=off) and once as the run's conversation,
 * and every scenario's actions must match, in order, field for field.
 *
 *   node tests/e2e/same-actions.js one-message.json conversation.json
 *
 * The model is the scripted gateway in server.js, which reads what it is
 * sent as one text and decides from it, so a change in what the model is
 * shown that changes a decision shows up here, and nothing is paid for.
 */
const fs = require("node:fs");

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
if (!a || !b) { console.error("Give the two E2E_ACTIONS_OUT files: one message, then conversation."); process.exit(1); }
if (a.promptCaching !== false || b.promptCaching !== true) { console.error("The first file must be the one-message run (E2E_PROMPT_CACHING=off) and the second the conversation."); process.exit(1); }

const differ = [];
const n = Math.max(a.played.length, b.played.length);
for (let i = 0; i < n; i++) {
  const x = a.played[i];
  const y = b.played[i];
  if (!x || !y || x.scenario !== y.scenario) { differ.push(`run ${i + 1}: ${x ? x.scenario : "nothing"} against ${y ? y.scenario : "nothing"}`); continue; }
  if (JSON.stringify(x.actions) !== JSON.stringify(y.actions)) differ.push(`${x.scenario} (run ${i + 1}):\n  one message:  ${JSON.stringify(x.actions)}\n  conversation: ${JSON.stringify(y.actions)}`);
}
const passed = (r) => new Map(r.results.map((t) => [t.title, t.pass]));
const pa = passed(a);
for (const [title, pass] of passed(b)) if (pa.get(title) !== pass) differ.push(`${title}: ${pa.get(title) ? "passed" : "failed"} as one message, ${pass ? "passed" : "failed"} as a conversation`);

const actions = a.played.reduce((t, p) => t + p.actions.length, 0);
console.log(`${a.played.length} scenario runs, ${actions} actions as one message, ${b.played.reduce((t, p) => t + p.actions.length, 0)} as a conversation`);
if (differ.length) { console.log(`\n${differ.length} differ:\n${differ.join("\n")}`); process.exit(1); }
console.log("Every scenario took the same actions both ways.");
