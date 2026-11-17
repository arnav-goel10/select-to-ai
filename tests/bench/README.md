# The bench

`run.js` drives the packed extension through tasks on live sites, `judge.js` and `judge-call.js` judge each run, and `trial.js` checks task files and turns a folder of results into tables. How to run the real-task trial and read its results: [docs/real-task-trial.md](../../docs/real-task-trial.md).

## The holdout suite: read this first

`holdout-tasks.json` is a held-out set. The everyday, dev and learn suites are a development set: their failures have been read and the agent has been changed to fix them, so a better score on them no longer shows that the agent got better in general. The holdout suite is there to show that.

The rule:

- **Nobody tunes the agent on this file.** Do not read its tasks while working on a fix, do not run them one by one to see how the agent does, and do not change the agent, a prompt or a heuristic because of anything in a holdout run.
- **Results are read as numbers only.** A holdout run (`suite: holdout` in the Real-task trial workflow) prints totals, pass rates, median seconds, spend and counts by family and by difficulty. It never prints a task id, an answer, a judge's reason or the name of a failing task, in the job summary, in the shard logs or in the `trial-summary` artifact. The per-task files go to artifacts named `holdout-SEALED-per-task-do-not-open-shard-N`, kept one day, because the summary job needs them. Do not download them.
- **A task that breaks because its site changed is replaced, not worked around.** When the numbers show more blocked or lost runs than before, check the start pages with curl (status and no bot check), and replace a task whose site has changed or turns automated visitors away with a new task on a site no other suite uses. Do not change the agent to get past a site.

The file carries the same rule in its `rule` field.

What is in it: 50 tasks on 44 sites, none of which any other suite uses (`node tests/bench/trial.js holdout-check` fails otherwise, and the workflow runs it). Each task has a `difficulty` (easy, medium or hard) besides its family. The families are the everyday ones plus `widgets` (hover menus, drag and drop, sliders, arrow keys, date pickers, frames, accordions, browser dialogs). The tasks were written on 17 Nov 2026 without reading any agent transcript or result, from what ordinary users ask a browser agent to do. Each start page was fetched that day and each fixed fact was read on the page or in the data it loads.

Dispatch (a real run spends money on the agent and the judge):

```
gh workflow run real-tasks.yml -R arnav-goel10/select-to-ai --ref rel40-real-tasks -f suite=holdout -f max_usd=5
```

A summary to compare against another needs the same arm, provider, model and judge. Run it more than once before reading a difference of a few points as real.
