# Real-task trial

The agent on 93 ordinary tasks, on live public sites, in the packed 4.0 build. It runs in GitHub Actions only, on the existing bench (`tests/bench/run.js` drives the extension, `tests/bench/judge.js` judges each run). Nothing here is a second harness.

Why it exists: every real-site number in [agent-v4-status.md](agent-v4-status.md) was measured with the debugger permission. 4.0 ships without it, so the agent presses and types through page scripts. This trial measures the build people will get.

## What is in it

| File | What it is |
|---|---|
| `tests/bench/everyday-tasks.json` | 93 tasks in 11 families. Each has a start page, the request as a person would type it, and a way to check it: `expect` (what a right result holds, given to the judge), `pattern` (a regular expression the answer should match), or both. |
| `tests/bench/fixture-tasks.json` | 6 tasks on the local fixture pages, for dry mode. |
| `tests/bench/trial.js` | Checks a task file, and turns a folder of results into the table by family. |
| `.github/workflows/real-tasks.yml` | The workflow. |

The families, with about 8 to 10 tasks each: look up a fact on a page, search and compare across two sites, fill a form and stop before submit, tables and lists, multi-step navigation, long documents and PDFs, non-English sites (German, French, Spanish, Japanese, Hindi, Portuguese, Chinese, Italian, Arabic), developer tasks, shopping research with no checkout, maps and transit, news and sports.

No task signs in, pays, posts, sends, signs up or deletes. `trial.js validate` refuses a task that asks for one of those, and the bench declines every confirmation except typing on and going to a site the task did not name, as it always has.

These tasks were written for this trial. They are a dev set: read the transcripts freely. They are not from any held-out set and say nothing about one.

## Running it

1. Add the repository secret `BENCH_API_KEY` (Settings, Secrets and variables, Actions): the key of the provider the agent runs on. The default provider is `anthropic`.
2. Optional: `BENCH_JUDGE_KEY`, when the judge runs on another account. Without it the judge uses `BENCH_API_KEY`. Optional repository variable `BENCH_JUDGE_URL`, for a judge on another OpenAI-compatible endpoint.
3. Actions, "Real-task trial", Run workflow.

| Input | Default | Meaning |
|---|---|---|
| `suite` | `everyday` | `everyday` is the 93 tasks. `dev` is `tests/bench/smoke-tasks.json`, the 12 read-only tasks that were already checked in. The WebVoyager dev split is not tracked in the repository, so it cannot run here. |
| `arm` | `shipped` | `shipped` loads the packed zip as it is: no `chrome.debugger`, scripted input. `debugger-on` loads the same zip with the `debugger` permission added to the loaded copy, so the same code uses real input events. Run both to see what the permission is worth on real sites. |
| `provider`, `model` | `anthropic`, `claude-haiku-5-5` | What the agent runs on. Any provider id in `extension/defaults.js`. |
| `judge_model` | `claude-sonnet-5-5` | The judge. Keep it a different model from the agent's. |
| `shards` | `6` | Browsers in parallel, one job each. |
| `limit` | `all` | A number runs that many tasks, spread evenly over the families. |
| `max_usd` | `5` | Hard spend cap, agent and judge together. |
| `dry` | off | Dry mode, below. |

The workflow file has to be on the default branch before "Run workflow" offers it. Until then only dry mode runs, on pushes to `rel40-real-tasks`.

### What a run costs

Measured on 6 Nov 2026 with the same models on other tasks (agent-v4-status.md): about $0.01 a task for the agent and about $0.02 a task for the judge. So the full suite should cost around $3, and the default cap of $5 leaves room. This is an estimate from another task set, not a measurement of this one.

### The spend cap

The cap is split evenly between the shards. In each shard, a task is not started once the shard's spend has reached its share, and every run is given what is left as its own cost budget (the extension's own per-task budget), so a single long run cannot pass the cap either. A run the cap ended is counted as lost, not failed, and tasks never started show under "not run".

Two limits to know. Spend is counted at the list prices in `extension/defaults.js` (`MODEL_PRICES`); a model that is not in that table is counted at the default rate there. The judge's spend is counted only when the judge is a Claude model on Anthropic's API, because that is the only path where the bench records the judge's token use.

## Dry mode

Dry mode proves the plumbing with no key and no spend. The model is the scripted one from the end-to-end tests (`tests/e2e/server.js`), the pages are its local fixtures, and each task's `pattern` stands in for the judge. The packed zip, the shards, the per-task files, the merge and the summary are all the real ones.

It runs when `dry` is ticked, when `BENCH_API_KEY` is not set, and on every push to `rel40-real-tasks`. The summary job then checks that each of the six fixture tasks ended the way its `dry` field says (four pass, one stops at a human check, one has its form submission held and declined) and fails if any did not. Dry mode says nothing about how good the agent is.

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
| scripted inputs, real inputs | Pointer actions made by page script, and by real input events. The shipped arm should show 0 real inputs. |
| held actions | Steps the agent stopped at to ask for a go-ahead (a send, a payment, a deletion, a site outside the request). |

Under the table: the pass rate over scored runs (passed, failed, timed out), and the stricter rate with blocked, lost and not-run tasks counted as failures. Quote both.

Artifacts, kept 30 days:

- `trial-summary`: `trial-summary.json`, the table as data plus one line per run (outcome, steps, seconds, cost, counters, failure reason).
- `trial-shard-N`: for each task, `<task id>/run1/run.json`, `log.txt` and the screenshots. `run.json` holds the steps taken (`history`), how the run ended (`ending`), the judge's verdict (`success`, `blocked`, `reason`, `keyPoints`), `costUSD`, `judgeCostUSD`, `seconds`, `failure`, `patternMatch` and `counters` (`scriptedInputs`, `realInputs`, `heldActions`, `heldRefused`, `heldKinds`, `checkIns`, `failedActions`).

Read first:

1. Runs where the judge and the pattern disagree (the summary counts them). Either the judge erred or the pattern is too loose or too tight. Fix the task file when it is the pattern.
2. Failures in `form-fill`, `tables-lists` and `shopping` with many scripted inputs. These are where scripted input is most likely to differ from a real press.
3. The blocked column by site. GitHub's runners have data-centre addresses, and some sites turn those away where they would let a person's browser in. A site that blocks every run should leave the task file.

## Limits

- One run per task. A single run moves by several points by itself; run the suite three times before comparing two arms.
- Live sites change. Tasks about today's news or prices carry a rubric about the process and the judge checks the answer against the pages the run saw. Facts that the task file states (a height, a year) were written from memory on 16 Nov 2026 and were not checked against the live pages before the first run: treat a judge and pattern disagreement on such a task as a possible error in the task file.
- Form tasks are judged from the screenshots and the action list, because a field's value is not in a page's text. They need a judge that sees images.
- Results are never committed. `tests/bench/out/` is ignored by git, and the numbers live in the Actions run.
