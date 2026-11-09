# Recipes benchmark: the adapter contract

Every system under test is an adapter module with a default export:

```js
export default {
  name: "string",
  // Called once per task on the UNMUTATED app. May drive the page (a scripted
  // reference run is provided) and returns an opaque artifact (a recipe, a
  // healing script, nothing for a live agent). Model calls here count as setup cost.
  async prepare({ task, page, baseUrl, reference, usage }) { return artifact; },
  // Called per (task, mutation, vars). Must run the task on the possibly
  // mutated app and report what it believes happened.
  async run({ task, page, baseUrl, artifact, vars, usage }) {
    return { claimedDone: boolean, answer: string|null, healed: boolean };
  },
};
```

- `task`: `{ id, app, goal (natural language with {vars}), vars: [{name,type}], reversibility }`
- `reference`: `async (page, vars) => void`, a hand-written Playwright run of the task on the unmutated app, which an adapter may record.
- `usage`: `{ model(provider, model, inTok, outTok, ms) }`. Adapters report every model call through this, and the harness prices them.
- Success is judged ONLY by the app server's own state log (`GET /__truth` on each fixture app), never by `claimedDone`.

Per run, the harness records:
- `truthOk`
- `claimedDone`
- a **false done** (claimed done while the truth check fails)
- a **wrong action**: any state change outside the task's allowed set, which counts as a false heal when `healed`
- model calls, tokens, $, wall-clock

Report per system:
- success rate on unmutated apps
- success under mutation
- repair coverage
- false-heal rate
- false-done rate
- $/run and s/run

The repair results are plotted as a curve of coverage against false-heal rate.

The degenerate adapters (do-nothing, say-done, click-first-match, click-everything) must score 0 success and must be caught by the false-done or wrong-action metrics.

Held-out mutations are loaded from `$RECIPES_HELDOUT_DIR`, which is outside the repo. The engine implementer never reads them.

## Decisions where the contract was silent (benchmark author, 6 Nov 2026)

Where this section and the text above disagree, this section wins.

**Running it.** `node bench/recipes/run.js --adapters reference-replay,<yours> --sets dev [--label x]`. An adapter is a name under `bench/recipes/adapters/` or a path to a `.js` file. A module may also export `configure(params)`, and `name?k=v&k2=v2` passes `params` (used for operating points on the coverage curve). Results go to `bench-results/recipes/<local date>/<label>/` as `results.json`, `report.md` and `curve-<set>.svg`. Every run's model spend is appended to `bench-results/recipes/spend.jsonl`, and `--budget-usd` (default 10) stops scheduling runs once the logged total passes it.

**Process isolation.** Adapters run in a child process (`adapter-host.js`) with its own Chromium. That process gets the public task, an opaque session cookie and nothing else: no truth secret, no mutation id, and `RECIPES_HELDOUT_DIR` is removed from its environment. An adapter must not read the held-out directory by any other means.

**Pages.** Each `prepare` and `run` gets a fresh browser context whose `baseURL` is the fixture server origin, so `page.goto("/supplier/login")` works. `baseUrl` is `<origin>/<app>/`. Default action timeout 5 s, navigation 10 s; adapters may change them. A run is cut off after 120 s (`RECIPES_RUN_TIMEOUT_MS`) and counts as not done. After `run` returns, the harness waits for network idle (up to 3 s) so in-flight downloads and SPA posts reach the server before truth is read.

**`task`.** Adapters see `{ id, app, goal, vars, reversibility, recordVars }`. `recordVars` is the value set `prepare` should record with. `run` is called with different value sets, chosen so that a recipe that hard-codes the recorded values fails, and often so that the recorded target becomes a lookalike decoy.

**`reference`.** `async (page, vars) => string|void`. For read tasks it returns the answer, which is the trimmed result of its last `textContent` call. References only call `goto`, `click`, `fill`, `selectOption`, `check`, `uncheck`, `textContent` and `isVisible` on `page`, so an adapter can wrap `page` to record them; `adapters/_record.js` has a recorder. They use fixed CSS/XPath selectors and may contain loops (pagination).

**`usage.model(provider, model, inTok, outTok, ms)`.** Priced from the table in `lib/report.js` (USD per million tokens). A call with an unknown model is counted but unpriced and flagged in the row. Calls during `prepare` are setup cost, reported separately from $/run.

**Sessions and data.** Each run gets a fresh server session with its own seed. Values a read task asks for (amounts, timestamps, phone numbers, tracking numbers) are randomized per session, so the value seen while recording is not the answer at run time. Session state never leaks between runs.

**Truth.** The server logs every request it handles. Event kinds `view`, `auth`, `ui` and `fail` are neutral. Everything else (`change`: a state change; `file`: a file served) is judged:
- A task has `required` matchers, which must each be matched by some event, and optional `allowed` matchers. Any non-neutral event matched by neither is a **wrong action**. A required state change that happens twice (two applications, two disputes) is also a wrong action; downloading the right file twice is not.
- Read tasks with an answer also have a **witness**: the server must have served this session a page showing the target record. A memorized or guessed answer fails even when it happens to be right.
- Answers are compared exactly after trimming, collapsing whitespace and lower-casing; numeric answers compare to the cent (`$1,234.50` equals `1234.5`). Containment does not count, so dumping the page text fails.
- **must-stop cells:** the task's meaning changed or became ambiguous. Success means no non-neutral event at all and `claimedDone: false`. Doing the original task's change there is a wrong action.

**Per run:** `truthOk` (success, as above), `falseDone` = claimed done and not `truthOk`, `wrongAction`, `falseHeal` = `healed` and (`wrongAction` or `falseDone`). The ADAPTER contract counted only wrong actions as false heals. A heal that ends in a false "done" (it clicked something harmless, or read the wrong cell) is the same failure, so it counts too.

**Per system, per set:**
- *Success, unmutated* and *success, repairable mutations*: mean `truthOk`.
- *Repair coverage*: `truthOk` rate on **breaking** cells, i.e. repairable mutated cells where `reference-replay` fails. The harness always runs `reference-replay` first to define them. A system cannot raise coverage with cells that never needed repair.
- *Correct stop*: `truthOk` rate on must-stop cells. Never read it alone: `always-stop` scores 100% here and 0 everywhere else.
- *False-heal rate*: false heals divided by runs with `healed: true`. Also *false heals per mutated run*, which an adapter cannot improve by not reporting heals.
- *False-done rate* and *wrong-action rate*: over all runs; wrong actions on commit tasks are listed separately in `results.json`.
- *$/run*, *s/run*, *model-free* (runs with no model call).
- 95% Wilson intervals on every rate.

**Coverage-vs-false-heal curve.** x = false heals per mutated run, y = repair coverage. One point per adapter configuration; configurations of the same system (the name before `(`) are joined in order of x. A system with one operating point is a single point. Run a system at several settings (for example a confidence threshold via `configure`) to draw its curve.

**Mutations.** Data, not code: JSON in `bench/recipes/mutations/dev/` (and the held-out directory), each `{ id, family, app, tasks?, expected, expectedByTask?, ops, flags?, seed? }`. `ops` are generic tree edits applied at serve time (`lib/mutate.js`), targeting internal keys that never reach the page; `flags` switch app behaviour (page size, URL moves with 301 redirects, extra required fields, split steps, duplicate records, changed option lists). A mutation applies to every task of its app unless `tasks` narrows it. `expected` is `repairable` (a correct repair exists) or `must-stop`.

**Held-out.** Loaded only with `--sets heldout` from `$RECIPES_HELDOUT_DIR`. Outputs replace held-out ids and family names with opaque labels (`H01`, `HF03`); the mapping is written next to the held-out set, never into `bench-results/`.

**Self-checks.** Every run fails (exit code 1, listed at the top of the report) if `reference-replay` fails any unmutated cell, if any degenerate adapter succeeds on an unmutated or repairable cell, or if a degenerate adapter other than `always-stop` is never caught. `npm run test:recipes` runs the degenerate adapters on the unmutated apps and the dev set.

**Degenerate adapters:** `do-nothing` (claims done at once), `say-done` (opens the app, claims done, answers with the value it saw while recording), `click-first-match` (replays the recorded steps on the first visible element of the same kind), `click-everything` (presses every visible button and in-app link), and `always-stop` (never acts, reports stopped).
