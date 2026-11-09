# The goal

Select to AI's agent should be the best way to get something done on the web without doing it yourself: you say what you want, and it does it in your own browser, on any site, as well as a careful person would, faster than you would, at little or no cost, and better each time because it knows you.

Everything in this file follows from that sentence. When a decision is unclear, read the sentence again.

## Where this leads

The end state is that the user no longer operates the browser. There is no address to type, no page to find, no form to fill in: they say what they want, from wherever they are, and it happens. The browser becomes the place the work is done in, not something the user drives.

That sets requirements beyond doing one task on one open page:

- **Start from nothing.** A request needs no page open and no site named. The agent works out where to go.
- **Carry a whole errand.** Several sites, several tabs, things done side by side, results brought together at the end.
- **Work while the user does something else,** and come back only for what is theirs to decide: a sign-in, a payment, a human check, a choice only they can make.
- **Give back the result, not the journey.** An answer, a table, a filled form waiting for a yes, a booking ready to confirm.
- **Be reachable from anywhere in the browser** with one gesture, so asking is quicker than typing an address.

## What "done well" means

A person hands over a task and stops thinking about it. That only works when all of these hold:

1. **It finishes the task, or says plainly what it could not do.** No confident wrong answers, no "done" with half the job left, no silent giving up.
2. **It works on the web as it is.** Any site, any language, any way a page is built: forms, menus, date pickers, sliders, frames, pop-ups, canvases, drag and drop, several tabs, files.
3. **It is fast.** A task it has done before should take seconds. A new one should take less time than doing it by hand.
4. **It is cheap or free.** It runs well on free and small models, and on a model on the user's own machine. A stronger model is used for the hard moments, not for everything.
5. **It knows the user.** Their details, their sites, their preferences, what they always allow. It asks once and remembers.
6. **It improves with use.** The second time is better than the first, and the user can see why.
7. **It is safe to leave alone.** It never pays, sends, deletes or signs in on its own judgment where the user would want a say, and it cannot be talked into anything by a page.

## The bar

The agent is finished when a person who has used the best commercial browser agents would choose this one. Until that can be asked directly, these stand in for it:

| Measure | Bar |
|---|---|
| Tasks done correctly on real sites, on tasks never seen during development, judged by a model that is not the driver and can see the page | At or above the best published results for agents of its kind |
| The same, on a free model | Within a few points of that |
| Ordinary controls (forms, widgets, lists) | Essentially all correct; every miss explained |
| Time for a task done once before | A fraction of the first time |
| Cost per task | Under one cent on average, zero on a local model |
| The user's own recurring tasks | All of them work |
| Wrong or unsafe actions taken without the user's say | None |

A number counts only if it was measured the way a user would experience it. A score raised by changing the test is not progress.

## How decisions are made

1. **The real web is the test.** A change must fix something a real person meets on a real site, in any language. A benchmark is a way to see that, never the thing being improved.
2. **General mechanisms, not patches.** No rule written for one site, one task, one model's quirk or one language. If a fix cannot be stated without naming the case that prompted it, it is not ready.
3. **The code states facts and keeps the user safe; the model decides.** The engine tells the model what is on the page and what happened, enforces safety and the tool contract, and leaves judgment to the model.
4. **Meaning over word lists.** Where a rule depends on what something means (is this a message or a search?), it is judged by meaning, so it holds in every language.
5. **Safety only gets stronger.** A check is loosened only by a mechanism that is at least as safe, never to make a number go up.
6. **Nothing inherited is assumed.** Every limit, wait, budget and threshold must have a reason that can be stated and a measurement behind it. "It was already there" is not a reason.
7. **Say what is true.** Results are reported with their weak points showing: what was excluded, what was not measured, what is a guess.

## The loop

This is the work, repeated:

1. **Watch it fail on something real.** The user's own tasks first, then unseen tasks on live sites, then controlled pages.
2. **Find the actual cause.** Read the run. Tell apart the model's choice, the harness, the site, the test.
3. **Fix the mechanism.** The smallest general change that removes the whole class of failure.
4. **Prove it.** A test that fails before and passes after; live pages; tasks never read; more than one model.
5. **Measure the cost.** Time, tokens, and what a user would notice.
6. **Write it down.** What changed and why, what is still open, in `agent-v4-status.md`.

## What has to be built

Where each stands is kept in `agent-v4-status.md`. The parts:

- **See the whole page.** Text first, because it is exact and cheap; a look at the screen when words cannot describe what is there.
- **Act like a person.** Real keys and a real pointer: click, type, hover, drag, scroll, upload, across tabs and frames.
- **Send less, wait less.** Tell the model what changed, not the whole page again. Do several things in one step when that is safe.
- **Decide and recover.** A fast model for the routine, a strong one when the run is in difficulty and to check the answer. Stop by progress and by the user's budget, not by a hidden count.
- **Remember.** The user's details, routes that worked on each site, standing approvals, preferences; all of it visible to the user and theirs to remove.
- **Stay safe by meaning.** Approvals and handovers that are right in any language and cannot be argued away by a page.
- **Measure honestly.** The user's tasks, fresh unseen tasks, a judge that can see, results with nothing hidden.

## What this is not

- Not a way around a site's checks. When a site wants a human, the user is asked, on that site.
- Not a benchmark entry. Scores follow from the work; they are not the work.
- Not finished when a number is reached. It is finished when the user stops needing to check on it.
