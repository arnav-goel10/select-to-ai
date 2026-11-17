# Real-task trial

The agent on 93 ordinary tasks, on live public sites, in the packed 4.0 build. It runs in GitHub Actions only, on the existing bench (`tests/bench/run.js` drives the extension, `tests/bench/judge.js` judges each run). Nothing here is a second harness.

Why it exists: every real-site number in [agent-v4-status.md](agent-v4-status.md) was measured with the debugger permission. 4.0 ships without it, so the agent presses and types through page scripts. This trial measures the build people will get.

## What is in it

| File | What it is |
|---|---|
| `tests/bench/everyday-tasks.json` | 93 tasks in 11 families. Each has a start page, the request as a person would type it, and `expect`: what a right result holds, given to the judge. 63 also have `pattern`, a regular expression the answer should match. |
| `tests/bench/learn-tasks.json` | The learn suite: 12 tasks that each run twice in one browser profile, and 6 pairs (a task, then a neighbour task on the same site). 24 tasks in all, taken from the everyday file. |
| `tests/bench/widgets-tasks.json` | The widgets suite: 30 open practice tasks on interactive widgets, on sites no other suite uses. Read and tune on them freely. Below. |
| `tests/bench/holdout-tasks.json.enc` | The holdout suite, encrypted: 50 held-out tasks on sites that no other suite uses, reported as numbers only. The workflow decrypts it with the `HOLDOUT_KEY` secret. Nobody tunes the agent on it. The rule, and how to edit it: [tests/bench/README.md](../tests/bench/README.md). |
| `tests/bench/fixture-tasks.json`, `tests/bench/fixture-learn-tasks.json` | Tasks on the local fixture pages, for dry mode. |
| `tests/bench/trial.js` | Checks a task file, and turns a folder of results into the tables. |
| `.github/workflows/real-tasks.yml` | The workflow. |

The families, with about 8 to 10 tasks each: look up a fact on a page, search and compare across two sites, fill a form and stop before submit, tables and lists, multi-step navigation, long documents and PDFs, non-English sites (German, French, Spanish, Japanese, Hindi, Portuguese, Chinese, Italian, Arabic), developer tasks, shopping research with no checkout, maps and transit, news and sports.

No task signs in, pays, posts, sends, signs up or deletes. `trial.js validate` refuses a task that asks for one of those. It also refuses a task that asks to submit, subscribe, book, apply, upload, comment or reply, except a form task on a practice site, and a form task may only be on a practice site (the list is `PRACTICE_SITES` in `trial.js`). The bench declines every confirmation except typing on and going to a site the task did not name, as it always has.

These tasks were written for this trial. They are a dev set: read the transcripts freely. They are not from any held-out set and say nothing about one.

## The holdout suite

The everyday tasks are a development set now: their failures were read and the agent was changed to fix them. `suite: holdout` runs 50 other tasks, written blind to the agent's behaviour, mostly on widely used real sites none of the other suites use, with a difficulty (easy, medium, hard) on each and a `widgets` family for the interactions only practice pages offer. The tasks are committed encrypted and the workflow decrypts them with the `HOLDOUT_KEY` secret. Its summary shows totals, pass rates, median seconds, spend and counts by family and difficulty, no line of fewer than 3 tasks, and nothing that names a task or carries a failure's text. The per-task files go to artifacts named `holdout-SEALED-per-task-do-not-open-shard-N`, kept one day. Nobody tunes the agent on this suite, its results are read as numbers only, and a task whose site changes is replaced, not worked around. The full rule: [tests/bench/README.md](../tests/bench/README.md).

`gh workflow run real-tasks.yml --ref rel40-real-tasks -f suite=holdout -f max_usd=5`. A dry leg (`sealed`) on every push checks that the sealed path prints no task, in the shard log and in the summary.

## The widgets suite

The holdout numbers say the agent is weak on interactive widgets, and nobody may read which held-out tasks failed. `suite: widgets` is the open set to work on instead: 30 tasks in `tests/bench/widgets-tasks.json`, all in the `widgets` family, each with a difficulty, the kind of interaction it practises (`widget`) and where it runs (`source`). Read its runs, transcripts and failures freely and change the agent on them.

| Kind (`widget`) | Tasks |
|---|---|
| hover menus and tooltips (an SVG chart's tooltip) | 1 |
| dragging in a list or a board (two lists, a chess board editor) | 2 |
| a card between kanban columns | 1 |
| a drop zone, no file | 1 |
| sliders: a native range input and a custom two-thumb one | 2 |
| date and time pickers of three libraries (a year view, a leap day, a range, a time with seconds) | 4 |
| keyboard-driven widgets: a listbox by arrow keys, a type-ahead combobox | 2 |
| autocomplete on a real site | 1 |
| accordions and tabs | 2 |
| a modal and Escape | 1 |
| a nested frame, and a story in a Storybook frame | 2 |
| shadow DOM: a switch (and a rating, below) | 1 |
| a canvas chart's legend and tooltip | 1 |
| a context menu, a double click, a long press, infinite scroll, a sortable table, a rich text editor | 1 each |
| multi-select and a tag input | 2 |
| toggles and star ratings | 1 |

25 are on the public demo pages of widely used UI libraries (Bootstrap, MUI, Ant Design, Element Plus, Headless UI, React Select, Shoelace, Carbon, Highcharts, Chart.js and others) and 5 on real sites (a dictionary, a streaming service's FAQ, a docs site's tabs, a chess board editor and a population table). No task signs in or hands anything in, and each ends in a state the judge can see on the final page: a value in a field (read from the harness's list of form controls, frames and shadow roots included), an order of items, a selected date, an open panel. Twenty also have an answer pattern.

No task shares a registrable domain with any other suite, the holdout included. `node tests/bench/trial.js suite-check widgets` checks the file's shape (every kind practised, 24 to 30 tasks, at least 5 real sites, at most 3 tasks a site) and the overlap. It reads the holdout from its plain file when one is there (the workflow decrypts it on every push, and `HOLDOUT_TASKS` points at a copy elsewhere), and a clash with the holdout prints only a count, because the workflow log is public and naming the practice task or its site would point at a held-out site. To see which practice task clashes, run `suite-check widgets --detail` on your own machine with `HOLDOUT_TASKS` set. Never paste that output anywhere public. `holdout-check` counts the widgets suite as another suite too. When a site here changes or starts turning the runners away, replace the task with one on a site that passes `suite-check`.

Every start page answered a plain `curl` with its page, not a bot check, on 18 Nov 2026. The fixed values in the rubrics (a chart's peak, a list's order, the countries with the most land) were read in the pages' own HTML or data that day. Values that depend on the run's date (a range next month) or on a demo's live data (a kanban card, a grid cell) are judged from the final page.

`gh workflow run real-tasks.yml --ref rel40-real-tasks -f suite=widgets -f max_usd=2`. The summary adds a table by kind of interaction under the family table.

## Keys

The workflow reads two repository secrets and no others. Each goes to its own provider only.

| Who | Secret | Sent to |
|---|---|---|
| The agent, provider `anthropic` | `ANTHROPIC_API_KEY` | api.anthropic.com |
| The agent, provider `openai` | `OPENAI_API_KEY` | api.openai.com |
| The judge, always | `ANTHROPIC_API_KEY` | api.anthropic.com |

The plan job fails for any other provider, for a model id that is not the provider's (a `claude-` id on `anthropic`, a `gpt-` or `o` id on `openai`), for a judge that is not a Claude model, and for a real run whose key is not set. A manual run without the dry box is a real run or a failed one. It never turns into a dry run.

`run.js` checks again. It is told which provider the key belongs to (`BENCH_KEY_PROVIDER`) and refuses to start when that is not the provider it runs on. `judge-call.js` uses the agent's key for the judge only when the judge's address is the agent's own provider, and otherwise stops with a message.

Use a key with its own spend limit set at the provider. The cap below is counted by the bench; the provider's limit is the one that cannot be wrong.

## Running it

Actions, "Real-task trial", Run workflow. Or from a terminal: `gh workflow run real-tasks.yml --ref <branch> -f suite=everyday -f limit=22 -f max_usd=1`.

The workflow does not have to be on the default branch first. GitHub registered it when it first ran on a push, and it can be started from any branch that holds the file. Confirmed on 17 Nov 2026: a dry dispatch from `rel40-real-tasks` ran and passed (run 43910433466). The two secrets it reads are already in the repository, so a real run is one dispatch away. The go switch is the dispatch itself, with the dry box left unticked.

| Input | Default | Meaning |
|---|---|---|
| `suite` | `everyday` | `everyday` is the 93 tasks. `dev` is `tests/bench/smoke-tasks.json`, the 12 read-only tasks that were already checked in. `learn` is the learn suite, below. `widgets` is the widgets practice suite, above. `holdout` is the sealed holdout suite, above. The WebVoyager dev split is not tracked in the repository, so it cannot run here. |
| `arm` | `shipped` | `shipped` loads the packed zip with no `chrome.debugger`: scripted input. `debugger-on` loads the same zip with the `debugger` permission added to the loaded copy, so the same code uses real input events. Run both to see what the permission is worth on real sites. |
| `provider` | `anthropic` | `anthropic` or `openai`. |
| `model` | empty | The agent's model id. Empty takes the provider's cheap one, below. |
| `judge_model` | `claude-sonnet-5-5` | The judge, a Claude model. It must differ from the agent's model. |
| `learning` | off | Learning on. The tasks of a shard then run one after another in the same browser profile and each starts with what the earlier ones left. The learn suite is always on. |
| `runs` | `1` | Runs per task, 1 to 5. In the learn suite, runs per pair. |
| `recipes` | off | The recipe arm, below. |
| `shards` | `6` | Browsers in parallel, one job each. |
| `limit` | `all` | A number runs that many tasks, spread evenly over the families. |
| `max_usd` | `5` | Hard spend cap, agent and judge together. |
| `dry` | off | Dry mode, below. |

### Cheap models

Both are in `extension/defaults.js` as their provider's `lite` model, and both ids were read on the provider's own model page on 17 Nov 2026.

| Provider | Model id | List price per million tokens, input and output |
|---|---|---|
| `anthropic` | `claude-haiku-5-5` | $0.10 and $0.50 for a prompt up to 100,000 tokens, $0.50 and $2.50 above |
| `openai` | `gpt-5.4-mini` | $0.75 and $4.50 |

### What the loaded build is

The packed zip, unpacked, with two changes to the loaded copy's manifest. `host_permissions` gets `https://*/*` and `http://*/*`, which is what a user gets by choosing "allow on all sites" and which a test cannot click. In the `debugger-on` arm, `permissions` gets `debugger`. Nothing else differs from the zip.

The browser says what it is: the workflow sets `BENCH_DISGUISE=off`, so the headless user agent is not rewritten and the automation flag is not hidden. A site that refuses an automated visit shows as blocked. The summary lists blocked runs by site, and such a site leaves the task file. Nothing is done to get past it.

### What a run costs

Measured on 6 Nov 2026 with the same models on other tasks (agent-v4-status.md): about $0.01 a task for the agent and about $0.02 a task for the judge. So the full suite should cost around $3, and the default cap of $5 leaves room. This is an estimate from another task set, not a measurement of this one.

### The spend cap

The cap is split evenly between the shards. In each shard, a run is not started once the shard's spend has reached its share, and every run is given what is left as its own cost budget (the extension's own per-task budget), so a single long run cannot pass the cap either. A run the cap ended is counted as lost, not failed, and runs never started show under "not run".

What is counted:

- Every attempt at a run. A run lost to the browser still spent what its model calls cost up to then, and that is paid for before the task is tried again.
- Every call to the judge, whether or not its verdict could be read. Once the cap is reached the judge is not asked again.
- The higher price of a long prompt. Claude Haiku 5.5 costs five times as much for a prompt over 100,000 tokens, which the extension's own count does not follow.
- A recipe replay's repair calls.
- With learning on, an allowance of three more calls a run at the run's own mean call price. The calls the extension makes after a run to write down what it learned are in no trace, so this is an estimate, and the only one in the list.

Limits to know. Spend is counted at the list prices in `extension/defaults.js` (`MODEL_PRICES`); a model that is not in that table is counted at the default rate there. A shard can pass its share by about one model call of the agent and one call of the judge, because both are counted after they return.

## The learn suite

`suite: learn` measures whether a second run is better than a first. Each pair gets a fresh browser profile with learning on. Twelve tasks run twice. Six tasks are followed by a neighbour: another task on the same site. The second run starts after the extension has finished writing down what the first taught it.

The summary sets run 1 against run 2: passed, median steps, median seconds and median tokens, how many second runs took fewer steps and how many more, and how many second runs started with something learned and were shown it at their first step. Under that is one line per pair. One pair per task says little. Use `runs` to repeat the suite before reading a difference as real.

## The recipe arm

`recipes: on` uses the extension's own recipes service (`extension/recipes/service.js`), the one behind "Save as recipe" in the panel. After each run the bench asks the service whether the run can be saved, and saves it when it can. When the judge passes the run, the saved recipe is replayed once, in a tab of its own, with the values the run itself typed.

The summary gives the saveable rate over passed runs, the extension's own reason for each run that could not be saved, how many replays ended proven done, and model calls per replay. A replay is judged by the recipe's own receipt, the checks it makes after each step. The judge model does not see it.

A replay does again what the run did. A run only does what the bench allowed, so a replay sends, pays and deletes nothing either. One task adds an item to a demo shop's cart, and its replay adds it again.

## Dry mode

Dry mode proves the plumbing with no key and no spend. The model is the scripted one from the end-to-end tests (`tests/e2e/server.js`), the pages are its local fixtures, and the judge is a stub on the runner that answers, in the judge's own format, with the verdict each task's `pattern` gives. The packed zip, the shards, the per-task files, the judge's code path, the merge and the summary are all the real ones. The costs it prints are prices applied to scripted tokens. Nothing is spent.

It runs when `dry` is ticked and on every push to `rel40-real-tasks`. The summary job checks that each of the seven fixture tasks ended the way its `dry` field says (five pass, one stops at a human check, one has its form submission held and declined), that the counters it expects are there (typing steps, scripted presses, held actions), that the form controls of the signup page were read back with the typed name in them, and that the judge stub was called and its tokens counted.

Five more jobs run the fixtures one more way each, and fail unless that way left its mark:

| Leg | What it proves |
|---|---|
| `debugger-on` | The same build with the debugger permission reports `chrome.debugger`, so the arm check has both arms to tell apart. |
| `spend-cap` | A cap far below one run's priced tokens stops the run, and the tasks after it are never started. |
| `learn` | A repeat pair and a neighbour pair run with learning on, and a second run starts with something learned. |
| `recipes` | Each run gets a record of whether it could be saved, with the reason when not, and each saved, passed run gets one replay. |
| `sealed` | The holdout suite's sealed path: the shard's log and the numbers-only summary name no task. |

Dry mode says nothing about how good the agent is.

## Reading the results

The job summary has one table, a line per family:

| Column | Meaning |
|---|---|
| passed | The judge accepted the result. |
| failed | The run ended and the judge did not accept it. |
| timed out | Still working at 300 seconds. |
| blocked by a human check | The site put up a human-verification check or refused the visit, and the agent stopped. A property of the site and the runner's address, not a failure of the agent. The agent never tries to get past one. |
| lost | The browser, the provider, the judge or the spend cap ended the run. Says nothing about the agent. |
| not run | Never started (the cap, or a shard that stopped). |
| median s | Median seconds per run, lost runs left out. |
| agent cost, judge cost | Model spend at list prices. |
| scripted presses, real presses | Presses, hovers and drags made by page script, and by real input events. In the debugger-on arm a scripted press is a fallback: the real pointer could not be used for that step. |
| typing steps | Steps that typed into a field, chose an option or sent a key. The engine does not record which way these went. In the shipped arm all of them are made by script. |
| held actions | Steps the agent stopped at to ask for a go-ahead (a send, a payment, a deletion, a site outside the request). |

Under the table: the pass rate over scored runs (passed, failed, timed out), and the stricter rate with blocked, lost and not-run tasks counted as failures. Quote both.

The arm check. The summary job fails when any shard loaded a build that is not the arm's (the shipped arm must have no `chrome.debugger`, the debugger-on arm must have it), when a shard left no results file to check, and when any run in the shipped arm made a real input event. A summary that passed says so in one line.

Form tasks. At the end of every run the bench reads every form control on the final page, frames included: its label or name, its value, whether it is ticked, which option is chosen. A password field's text is never read, only its length. The list is in `run.json` as `formState` and the judge is given it, with the instruction to judge a form's values from it before the action list and the screenshots. A fill the agent reported as done that did not stay in the page shows as an empty field.

Live values. For a task with no fixed fact (today's top story, a price), the rubric says each value stated must be in the page text or a screenshot of the run. The bench also checks every number in the answer against all the page text it captured and records how many it found (`grounding` in `run.json`). The judge is told, and the summary counts passed runs none of whose numbers is on any page.

Artifacts, kept 30 days:

- `trial-summary`: `trial-summary.json`, the tables as data plus one line per run (outcome, steps, seconds, tokens, cost, counters, grounding, failure reason).
- `trial-shard-N`: for each task, `<task id>/run1/run.json`, `log.txt` and the screenshots. `run.json` holds the steps taken (`history`), how the run ended (`ending`), the judge's verdict (`success`, `blocked`, `reason`, `keyPoints`), `formState`, `grounding`, `costUSD`, `lostAttemptsUSD`, `longPromptUSD`, `judgeCostUSD`, `judgeUsage`, `seconds`, `failure`, `patternMatch`, `counters` (`scriptedInputs`, `realInputs`, `typedActions`, `heldActions`, `heldRefused`, `heldKinds`, `checkIns`, `failedActions`) and, in the recipe arm, `recipe`. A learn run keeps its two runs under `<task id>/learn1/A` and `B`.

Read first:

1. Runs where the judge and the pattern disagree (the summary counts them). Either the judge erred or the pattern is too loose or too tight. Fix the task file when it is the pattern.
2. Failures in `form-fill`, `tables-lists` and `shopping` with many scripted presses and typing steps. These are where scripted input is most likely to differ from a real press. In a form task, compare `formState` with the action list.
3. The blocked line by site. GitHub's runners have data-centre addresses, and some sites turn those away where they would let a person's browser in. A site that blocks leaves the task file, and a task on a site that takes automated reads replaces it in the same family.

## Limits

- One run per task unless `runs` says more. A single run moves by several points by itself; run the suite three times before comparing two arms.
- Live sites change. Facts that the task file states (a height, a year) were written from memory on 16 Nov 2026 and were not all checked against the live pages before the first run: treat a judge and pattern disagreement on such a task as a possible error in the task file. The five tasks added on 17 Nov 2026 were read on their pages that day.
- Sites that may turn the runners away are still in the file (Britannica, timeanddate, TfL, AP News, the Met Office, SBB, BART, DemoQA, the IRS and the National Archives, the UN, Open Food Facts). The first run will show which do.
- The trial has no task on a signed-in product, on a web app with rich widgets (mail, documents, calendars, spreadsheets), with a file upload or download, or across more than two tabs. 20 of the 93 tasks are Wikipedia pages and 23 are scraping sandboxes or practice sites.
- Adapting to the user (their saved details, their corrections) is not measured. The learn suite measures only whether a second run is better than a first.
- Results are never committed. `tests/bench/out/` is ignored by git, and the numbers live in the Actions run.
