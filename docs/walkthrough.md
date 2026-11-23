# Walkthrough

A short tour for an engineer reading the code for the first time. It covers what the extension is, how one agent run goes, where the agent has to stop and ask, and two real runs from the trial logs.

## What it is

Select to AI is a Manifest V3 Chrome extension with two parts.

- **Right-click sending.** Highlight text, right-click, and send it to ChatGPT, Gemini, Perplexity or Claude. This is the original 2.0 product.
- **A browser agent.** You give it a task in plain words. It reads the page, presses and types in your own browser, and answers. It runs on your own model provider and key (OpenRouter's free router by default, or OpenAI, Anthropic, Gemini, a local gateway and others).

The 4.0 package has no `debugger` permission, so the update from 2.0 adds no permission warning. The agent's clicks, keys and drags are made by page scripts. [debugger-permission.md](debugger-permission.md) covers what that costs.

## How a run works

A run is plain data in the service worker. `extension/core/run.js` is a state machine with no browser calls. `advance(run, event, env)` takes what just happened and returns the next things to do. `extension/engine.js` does them and reports back. Because the run is saved after every step, closing the panel or letting the worker sleep loses nothing.

```
start -> observe -> model -> act -> observe -> ... -> done -> verify -> end
```

1. **Read the page.** `engine.js` `observe` injects `agentContentScript.js`. It lists every control with a number (`[50] summary "What are the limitations of the Trial plan?"`), plus the page text, what is new since the last step, and any blocker it can see (a sign-in form, a human check, card fields). `run.js` `onObserved` fits all of this to a budget and writes the prompt.
2. **Choose an action.** The model answers with one `step` tool call: its notes, the goal of the step, and one or more actions such as `click`, `fill`, `type`, `press`, `hover`, `drag`, `find`, `read` or `navigate` (the full list is in `core/step.js`). `run.js` `onModelReplied` validates the call, and `next` sends each action through the policy before anything touches the page (next section).
3. **Act.** `engine.js` `act` runs the action in the page. A click goes through the pointer events a mouse sends. If the page shows no answer to them, the press is tried once more by keyboard where that is allowed, and the result says which way worked.
4. **Read again to confirm.** `engine.js` `lookAgain` reads the page once the action has settled. The result the model gets says what the page did: `[9] now shows "4"`, `That brought up: [51] ...`, or that nothing changed. The next `observe` starts the following step from the page as it is now.
5. **Check the answer.** When the model calls `done`, `run.js` `onDone` checks each evidence quote against everything the run was shown (`locateQuotes`). Text the agent typed into the page does not count as evidence. A multi-step answer also goes to a fresh model call (`purpose: "verify"`), and its verdict is shown under the answer.

## Where the agent stops and asks

Every action the model picks goes through `POLICY.decide` in `extension/core/policy.js` before it runs. It is called from `run.js` `next`. The policy is plain code on purpose. It reads the page's structure and where an address came from, never the model's reasons, so text on a page cannot argue its way past it. It returns one of four verdicts.

| Verdict | What happens | Examples |
|---|---|---|
| allow | the action runs | reading, scrolling, typing a search query, opening a menu |
| confirm | the run waits, and the panel shows an approval card | a button that sends, submits, deletes or spends money, putting your saved details into a form, opening an address no page showed |
| hand over | the run waits for you to act on the page | a sign-in, a human check, a one-time code, the final button that pays |
| refuse | the model is told why, and nothing is done | typing into a password or card field, closing a tab the run did not open |

How it decides:

- `TOOLS.actionRisk` in `extension/agentTools.js` reads what a press would do from the control's words, its form and the page. Where the words don't settle it (an unlabelled button, a one-box form), the run asks a second model call that is shown the control but never the page. If that call can't answer, the press is held for you.
- `blockersOf` and `guardHumanCheck` find human checks, sign-in walls and card fields. `secretField` makes sure the agent never types a password, a card number or a code, whatever action it tries.
- In `next`, a `confirm` verdict becomes `waitFor(... { kind: "approval" })`. `extension/agent.js` `drawWait` shows the card ("Allow this step? This deletes, cancels or removes something. On: ..."). Nothing runs until you choose.
- If you allow it, `run.js` `onUser` tags the action with the control's words. `engine.js` `approvedChanged` reads the page again before acting. If that control is gone or now says something else, nothing is pressed. An approved press is made exactly once.
- If you decline, the step is recorded as declined. `decide` then holds any other route to the same thing (another button with the same words, a key, a link) until you say something new.

The approval step is on by default. It is the **Ask before purchases, payments and deletions** switch in Settings (`agentRiskConfirmation`, read in `engine.js`). It was in the 4.0 package built on 16 Nov and is still on main. Turning it off skips the approval cards only. Secret fields, sign-ins and human checks are still left to you. The end-to-end scenarios in `tests/e2e/run-v4.js` check it on every pull request. For example, `payPress` leaves the paying button to the user, `commentSends` shows the card for a comment box, `calcAsks` shows no card for a calculator form, and `pointerRisk` and `delegateDecline` have the user decline and check that nothing was done. Also, `tests/unit/new-actions-safety.test.js` and `tests/unit/declined-edits.test.js` check the newer actions.

## Two real runs

Both traces come from one real-task trial in GitHub Actions: [run 44139261360](https://github.com/arnav-goel10/select-to-ai/actions/runs/44139261360), 17 Nov 2026. That run used the packed 4.0 build without the debugger (commit `71d40a7`, before the editor and gesture work merged on 23 Nov), Claude Haiku 5.5 as the agent and Claude Sonnet 5.5 as the judge. Each is the run's own `log.txt` from the trial-shard artifacts. Both sites are public and nothing was signed in, so there was no personal data to take out. I removed only the clock times and cut long result lines, marked with `...`.

### A successful action: open an FAQ answer on kagi.com/pricing

Task: *"In the questions near the bottom of the pricing page, open the one about the limitations of the Trial plan and tell me the limits it gives."*

```
Step 1. Locate the Trial limitations FAQ question
Action. find "What are the limitations of the Trial p..."
Result. "What are the limitations of the Trial plan?" is in 1 place in the text and
        1 control ([50] "What are the limitations of the Trial plan?"). ...
Step 2. Open the Trial limitations question
Action. click [50]
Result. Clicked element [50]. That brought up: [51] a "Learn more" -> help.kagi.com/...;
        [52] summary "Why should I pay for search?"; [53] summary "What are the
        limitations of the Trial plan?"; ...
Step 3. Answer with the Trial plan limits
Checking Answer. Checking the answer against what was read.
Check Passed. The assistant clicked the "What are the limitations of the Trial plan?"
        question, and the page text shows its answer: a limit of 100 searches and 100
        interactions with Kagi Assistant, plus access to all features. ...
```

Answer: 100 searches and 100 interactions with Kagi Assistant. It took 3 steps and 9 seconds, and the judge passed it.

What to notice:

- `find` searched the whole page, so the agent didn't scroll to look.
- The click result comes from reading the page again after the press. What opened is reported to the model, not assumed.
- The answer was checked against what the run was shown before it went out.

### A failed action, handled: a 403, then a human check on another site

Task: *"Type "serendip" into the dictionary search box and choose the suggestion "serendipity" from the list that drops down. Tell me which word's entry opens."* The start page was wordreference.com.

```
Step 1. Retry opening the dictionary site in case the block was temporary
Action. navigate https://www.wordreference.com/
Result. Opened https://www.wordreference.com/
        (page text: "403 Forbidden nginx/...")
Step 2. Open another dictionary site with a search box
Action. navigate https://www.merriam-webster.com/
Result. Opened https://www.merriam-webster.com/
        (page text: "Performing security verification ... verifies you are not a bot")
Step 3. Report that the search could not be done
```

Answer (shortened): *"I could not complete this. I did not type "serendip" or choose "serendipity", so I cannot tell you which entry opens. WordReference returned "403 Forbidden" on two tries... Merriam-Webster showed a security check instead of its search box. I did not go past it, and I did not hand it to you because the request did not need that site. If you want this done, open WordReference or Merriam-Webster yourself in this browser, complete any check it shows, and I can try the search again."*

The trial counted it as blocked (the site refused the browser), not as a pass. What to notice:

- The run made no input at all on either page: 0 scripted presses, 0 typing steps, 0 held actions in the run's counters. It did not try to get past the bot check.
- The page reader marks a check page like this as a human check (`blockersOf`, `TOOLS.isChallengePage`). `core/context.js` tells the model so as a fact of the page. On the task's own site, any action there is handed to the user (`guardHumanCheck`, verdict "hand over"). Here the check was on a second site the agent had opened itself and the task didn't need. So the fact told the model to go back and finish from what it had read, and the user wasn't asked to solve a check for a detour. The answer says why.
- The answer says what was not done instead of making up a result.

## Where to go next

- [architecture.md](architecture.md) and [security.md](security.md): trust boundaries and the outbound request policy.
- [privacy-disclosure.md](privacy-disclosure.md): every request and stored item, read from the code.
- Open pull request #17: the real-task trial harness that produced the traces above.
- `npm run test:v4`: the scripted end-to-end scenarios. They run in CI on the packed build.
