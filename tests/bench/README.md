# The bench

`run.js` drives the packed extension through tasks on live sites, `judge.js` and `judge-call.js` judge each run, and `trial.js` checks task files and turns a folder of results into tables. How to run the real-task trial and read its results: [docs/real-task-trial.md](../../docs/real-task-trial.md).

## The holdout suite: read this first

The holdout tasks are a held-out set. The everyday, dev, learn and widgets suites are a development set: their failures have been read and the agent has been changed to fix them, so a better score on them no longer shows that the agent got better in general. The holdout suite is there to show that.

The rule:

- **Nobody tunes the agent on these tasks.** Do not decrypt or read them while working on a fix, do not run them one by one to see how the agent does, and do not change the agent, a prompt or a heuristic because of anything in a holdout run.
- **Results are read as numbers only.** A holdout run (`suite: holdout` in the Real-task trial workflow) prints totals, pass rates, median seconds, spend and counts by family and by difficulty. It never prints a task id, an answer, a judge's reason, a failure's text or the name of a failing task, in the job summary, in the shard logs or in the `trial-summary` artifact. A shard's log passes only run counts and the numbers table and withholds every other line (`sealedLogText` in `trial.js`). No line of the summary holds fewer than 3 tasks: small families or difficulties are counted together until the line holds 3 or more, and a run of fewer than 3 tasks gets no summary (the plan refuses a limit below 3). The per-task files go to artifacts named `holdout-SEALED-per-task-do-not-open-shard-N`, kept one day, because the summary job needs them. Do not download them.
- **A task that breaks because its site changed is replaced, not worked around.** When the numbers show more blocked or lost runs than before, check the start pages with curl (status and no bot check), and replace a task whose site has changed or turns automated visitors away with a new task on a site no other suite uses. Do not change the agent to get past a site.

The file carries the same rule in its `rule` field.

What is in it: 50 tasks, none on a site any other suite uses (`node tests/bench/trial.js holdout-check` fails otherwise, and the workflow runs it after decrypting). Each task has a `difficulty` (easy, medium or hard) besides its family. Most are on widely used real sites (a retailer's catalogue, a route search, a bus search with no booking, a library catalogue, a government service page, a health information page, a currency and a weather page judged against the run's own page); the `widgets` family keeps the interactions only practice pages offer (sliders, keys, drag and drop, date pickers, frames, browser dialogs). Long documents are a mix of PDFs and long HTML pages, and no check holds the suite to a share of either: it is not shaped around any one fix. The tasks were written on 17 Nov 2026 without reading any agent transcript or result, and revised the same day after a cold review. Each start page was fetched that day and each fixed fact was read on the page or in the data it loads.

### Where the tasks are, and how to edit them

The repository holds the tasks encrypted only, at `tests/bench/holdout-tasks.json.enc`, so that nobody working in the repository reads them by accident. The workflow decrypts them with the repository secret `HOLDOUT_KEY` before it plans, to `tests/bench/holdout-tasks.json`, which git ignores. The plain file and the passphrase are kept outside the repository, on the owner's machine (`~/Documents/s2a-heldout/real-task-holdout/holdout-tasks.json` and `~/Documents/s2a-heldout/holdout-key.txt`). Unit tests that need the plain tasks skip when it is not there; the overlap and shape checks run in the workflow, after decryption.

Git history holds a plain first draft of the file: commit 85cd008 added it and commit 643cc72 still has it in its tree (18d5814 removed it when the encrypted copy came in). That draft overlaps the live set heavily. At the second cold review on 17 Nov 2026, 36 of the 50 live tasks kept the draft's start page and 33 kept its answer pattern (after that review three tasks moved to new sites and one cross-site task changed its second site), so reading the draft is reading most of the live set. The history is not rewritten. The rule that follows:

- **Nobody reads those two commits' copy of `tests/bench/holdout-tasks.json`**, by `git show`, `git checkout`, a diff of either commit, the pull request's file view or any other way. Treat it exactly as the decrypted file.
- **Before the repository is made public, this branch is merged in a way that keeps the draft out of main**, so the public history never holds it. The owner decides how.
- Never commit the plain file again.

To edit the tasks:

```
# Edit the plain copy outside the repository, then check it (--detail names the problems; the workflow prints counts only).
HOLDOUT_TASKS=~/Documents/s2a-heldout/real-task-holdout/holdout-tasks.json node tests/bench/trial.js holdout-check --detail
HOLDOUT_TASKS=~/Documents/s2a-heldout/real-task-holdout/holdout-tasks.json node --test tests/unit/holdout.test.js

# Re-encrypt it into the repository and commit only the .enc file.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt \
  -in ~/Documents/s2a-heldout/real-task-holdout/holdout-tasks.json \
  -out tests/bench/holdout-tasks.json.enc \
  -pass file:$HOME/Documents/s2a-heldout/holdout-key.txt

# To recover the plain file from the repository (the same passphrase):
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -in tests/bench/holdout-tasks.json.enc -out ~/Documents/s2a-heldout/real-task-holdout/holdout-tasks.json \
  -pass file:$HOME/Documents/s2a-heldout/holdout-key.txt
```

To change the passphrase, write a new one with `openssl rand -base64 32 | tr -d '\n' > ~/Documents/s2a-heldout/holdout-key.txt` (never printed), re-encrypt as above, and set the secret from the file: `gh secret set HOLDOUT_KEY -R arnav-goel10/select-to-ai < ~/Documents/s2a-heldout/holdout-key.txt`.

Dispatch (a real run spends money on the agent and the judge):

```
gh workflow run real-tasks.yml -R arnav-goel10/select-to-ai --ref rel40-real-tasks -f suite=holdout -f max_usd=5
```

A summary to compare against another needs the same arm, provider, model and judge. Run it more than once before reading a difference of a few points as real.

## Measuring before changing the agent

Four parts make a score worth comparing. None of them changes the agent.

- **Blocks in their own column.** `blocks.js` decides whether the task's own site refused the browser, from the page alone: a thin page with a refusing status (202, 401, 403, 405, 407, 429, 451, 503), with an opaque request id or the visitor's address, with nothing of its own to press beside a frame from another origin, or a thin front page of the task's site that offers no link in, where the agent never got to act. No site name, vendor name or word takes part, and a test swaps every word of a page for made-up letters to keep it so. The decision is made on the last page the run saw on the task's site, so a refusal on a site the agent chose to go to stays the agent's outcome. `run.js` records each page's structure and status for it, and the judge's own word is kept beside as `judgeBlocked`. `om2w-dev-block-labels.json` holds hand labels of 30 stored end pages; `node tests/bench/blocks.js check <folder>=<source run>... --labels tests/bench/om2w-dev-block-labels.json` compares.
- **Frozen key points.** `keypoints.js` writes each dev task's key points once, from the task alone, before any agent change. The judge then judges those points (`judge.js` `JUDGE_SYSTEM_FROZEN`) and still sees the final answer. The dev tasks are gated, so the repository holds the points only encrypted with `OM2W_DEV_KEY` (`om2w-dev-keypoints.tar.gz.enc`), beside a clear lock of their digest (`om2w-dev-keypoints.lock.json`). A file whose digest differs from the lock is refused. Sealed parts get no key points.
- **Votes on a fail.** With `BENCH_JUDGE_VOTES=3` a run whose first vote fails is judged again until one side has two votes. A first pass stands alone.
- **Noise floor and interruptions.** The om2w workflow's `noise-floor` mode runs every task several times and the summary gives each task's passes out of its runs and the flip rate, with no task named. Every summary gives holds per run as an interruption count, and, with the simulated approver on (`BENCH_APPROVER=on`, approver.js), both scores side by side.

The om2w workflow's `rejudge` mode runs no agent. It downloads the stored dev runs of earlier workflow runs (`source_runs`), writes the key points once if none are committed, judges each run three times with the voting judge under the spend cap (`stability.js`), and checks the block detector against the hand labels. The clear summary is counts only; every judging is uploaded encrypted.

```
gh workflow run om2w.yml -R arnav-goel10/select-to-ai --ref <branch> -f mode=rejudge -f part=dev -f judge_model=claude-haiku-5-5 -f max_usd=3
```
