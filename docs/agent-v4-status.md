# Agent v4: where it stands (3 Oct 2026)

The new engine is the default since 3 Oct and the only engine since 5 Oct: the old loop and the address bar's command router are removed (old-loop figures below were measured before that). This page is the short version of two nights of measurement.

## 23 Nov 2026: one page-blind check decides what a press commits

Two gaps from the 4.0.0 audit ("Close my account" and "Leave team" pressed with no card, and an "Unsubscribe" link's address opened with `navigate`) were first closed with word lists. Those lists are gone. The model now decides, and nothing in the extension holds a list of words that stands in for that decision.

- **One check per page, beside the step.** When a page is read, `run.js` `askPresses` sends every named control on it that structure does not settle to the helper model in one `press_check` call. It runs in parallel with the step call. The check never sees the page or the request. It is shown the site, the page path, and for each control only its names from the markup, its kind, its form's method, path and box types, a link's address, and the name of the dialog it sits in. It answers which controls pay, send, delete or decide, and which it cannot tell. A reply whose count does not match is not used.
- **Waiting.** A press the check has not answered waits for it. The batch is given 6 s plus the longest of the run's last three steps and last three answered checks, and a press asked alone gets 8 s plus the same, with at most 30 s added. A check that ran out of time adds nothing, so an outage does not stretch later waits. Asking the same press again is the same miss, and any answer clears the count. After two different questions missed in a row, single asks stop, but each page is still sent beside the step, so the run picks up when the check answers. Unsure is held as a decision, and so is a control the reply lists by its number alone. With confirmations off in Settings, no check is asked and nothing waits.
- **When the check does not answer, nothing is let through.** A press the check could not answer for, a button or a link, is held. The first such hold shows one card for the run that says the safety check is not answering and offers two choices, carry on with this task without it, or stop. Carrying on lets unjudged presses through for the rest of that run only, as with confirmations off for those presses alone. What the check did answer, the step's own `commits`, the user's declines and the structural holds all still apply. The choice is kept on the run, nowhere else, and ends when the check answers again, so a later outage asks again. A recipe replay has no one to ask: a press the check never answered is recorded as a commit, so the replay stops for a person.
- **Structure settles some presses with no call.** A same-page fragment link, a tab inside a tab list, a disclosure (`aria-expanded`, `summary`, `popovertarget`), a choice staged in a form that has its own submit, and the submit of a search form. A search form is one marked as a search (`role=search`, or a box of type search) and sent with GET. A POST form with fields still holds its submit by structure, and a one-box form still gets its own form check.
- **The step can only tighten.** The step tool has a required `commits` field. True holds a press the check let through. False grants nothing.
- **Names are checked again at the press.** The content script refuses a press, as "changed", when the control's names differ from the ones read with the page, so a check on "Save draft" never lets through a button that now says "Delete account".
- **Links.** Opening a link's address with `navigate` or `tabs open` is decided as pressing that link, whether it is on this page or was read on an earlier one (`run.linkIndex`). A sub-task merges its answers and its link index into the parent run, so a link a child judged is not opened unchecked by the parent.
- **Kept across runs.** Definite answers are kept in `chrome.storage.local` (`agentPressVerdicts`) for 30 days, at most 3000, least recently used first out. The key includes a stamp of the prompt, the question, the tool and the judging model, so a change to any of them starts afresh. Unsure answers are never kept. Reset in Settings removes them, with the worker's own copy, and they are listed in `docs/privacy-disclosure.md`.
- **Recipes** record every named button press as a commit, whatever the check said, and a link only when the run's check said it commits something. The earlier version let a button the check called harmless be recorded as no commit, which loosened replays.
- **Cost.** On the 55 pages of the decision snapshots, 50 have at least one control to check, 9.6 on average and 39 at most. That is one extra helper-model call per page read, about 1,800 characters in (7,700 at most) and a short tool reply out. It runs beside the step, so it adds no wait unless the step is pressing something the check has not answered yet. A page whose controls were all judged before, in this run or in the last 30 days with the same judge, costs no call. A failed batch adds one call per press made on that page. The snapshots were captured before the structural passes existed, so these counts are an upper bound. Before this change the same pages had 43 controls checked one call each, so a fresh run makes slightly more calls than before, and a repeated one far fewer.
- **Tests.** Design tests 1 to 13 are in `core-run.test.js`, `risk.test.js`, `core-delegate.test.js` and `no-word-lists.test.js`. Test 4 is live: `npm run eval:decisions` now asks the press check in German, French, Japanese, Hindi and English, and in four dialogs where the same word means different things (`tests/decisions/press-cases.js`). The scanner's part is in `tests/e2e/scan-structure.js`.
- **Live result on Claude Haiku 5.5 (24 Nov).** `tests/decisions/press-eval.js` (`npm run eval:presses`, and the `press_eval` input of the CI workflow) sends 13 made-up pages, 123 controls in eight languages with consent banners, carts, menus, calendars, sign in and out and a 38-control page, through the engine's own client. On Claude Haiku 5.5, three rounds: every reply usable, 0 of 285 ordinary controls held, 1 of 84 committing controls let through (a "Subscribe for $1 a week" link, once in three). Batch time median 2.2 s, worst 4.6 s. About $0.0003 a page. The first live run found two faults the stand-in judge could not: the model set `count` to the number of commits, which threw away 18 of 39 replies, and it held consent banners as decisions (11% false holds). Both were fixed in the tool's general wording.
- **Live result on the models a default install uses (24 Nov).** With no helper set, the batch goes to the run's own model, so the check was run on the Anthropic default and on free NVIDIA NIM models, three rounds of the same 13 pages each. The eval now takes an OpenAI-compatible endpoint (`PRESS_EVAL_PROVIDER=custom`, `PRESS_EVAL_BASE_URL`). Step times come from `tests/decisions/run-v4.js` on the same models, the 55 step cases.

  | Model | Usable replies | False holds, ordinary | Missed holds, committing | Batch median / worst | Over 6 s | Step median / worst |
  |---|---|---|---|---|---|---|
  | Claude Sonnet 5.5 (Anthropic default) | 39 of 39 | 7 of 285 (2.5%) | 2 of 84 (2.4%) | 2.4 s / 7.4 s | 1 of 39 | not measured |
  | Nemotron 3.5 Super VL 120B (NIM, free) | 39 of 39 | 0 of 285 | 0 of 84 | 6.9 s / 43.4 s | 25 of 39 | 3.0 s / 10.2 s |
  | Nemotron 3.5 Lightning 30B (NIM, free) | 39 of 39 | 9 of 285 (3.2%) | 0 of 84 | 18.1 s / 74.4 s | 36 of 39 | 4.8 s / 24.2 s |

  Sonnet's false holds are cookie banners in French and Spanish ("Tout accepter", "Rechazar todo") held as decisions, and once the Japanese "次へ" as unsure. Its two misses are the "Subscribe for $1 a week" link, two rounds of three. Lightning holds "Log out" in English and Japanese, a newsletter's "Close" and "次へ". The free models missed no committing control. Sonnet cost $0.23 over four rounds. The NIM free tier charged nothing (the eval prices it at OpenRouter's rates, so its own spend line is not a bill).
- **What the measurement changed.** Before any change, Lightning gave 8 usable replies of 13: four listed committing controls as bare numbers in `commits` and one answered with something else entirely. `readLabels` now holds a control listed by its number alone as unsure, which kept every Lightning reply in the three rounds above. The fixed 6 s wait threw away most free-model answers, so the wait now comes from the run's own call times. Replaying the measured times through both rules (an estimate, 20 pages a run): on Super VL presses the check could not answer go from 9% to none, and on Lightning from 87% to 15%. On Lightning the wait past the step is then 12 s at the median and 35 s at the 90th percentile. That is slow, and the 15% shows the card. It holds rather than guesses.
- **Not measured.** `openrouter/free` itself (no OpenRouter key here), and the chain's first two models, which NIM has retired (`qwen3.8-27b`, `nemotron-3-super-120b`). `gemma-4-31b` did not answer a one-word prompt on NIM within 90 s. The OpenAI, Gemini and DeepSeek defaults (no keys). Real sites.

## 23 Nov 2026: presses with no spot aimed clear of inner controls

- **What was wrong.** A press with no spot on a listed card, row or label was aimed at its middle, and the events made by script started on whatever was drawn there, as long as it sat inside the control. A link in a row's middle column, a button the page draws invisibly over a card's picture, or a link inside the words of a tick box got the press instead, and the result said only "Clicked element [5]". The policy had judged [5], not the inner control. 4.0 has no debugger, so this was the ordinary click path. The status entry below listed it as still open.
- **What changed (`agentContentScript.js`).** One rule, `innerControlAt`, says when a hit inside a control belongs to a control of its own: a listed one, or any element that is a control (`CONTROL_SELECTOR`), shown or not, that the listing left out. What it is decides, not whether it made the listing. A part that fills nearly all of the control, carries exactly its words (a tab and its link), or is what is drawn at every spot of the control on screen (a link stretched over a whole card) is the same control. `aimAt` passes over such spots and keeps looking on the control's own surface. `pointerOnControl` aims before it knows which pointer it will use and hands the point to the scripted press, and `double_click`, `right_click`, `hold` and a click with keys held aim the same way (`scriptedAim`). `pointerTargetIn` never starts the events on an inner control. When every spot is on inner controls, nothing is pressed and the result names one and says how to reach either. A real press that lands on an inner control says so. A press that went round an inner control and got no answer at all from the page (`passedOverNote`) says so and names that control, because a wrapper listed for its pointer or its tab stop may do nothing but hold its link; the model decides whether to press the link. Drags still take hold of and drop on any part.
- **Pinned bars.** A control on screen with a bar pinned over all of it (a sticky header after a scroll) was refused as covered, with or without the debugger. `aimClear` and `aimAtSpot` now scroll it to the middle once and aim again, so the press arrives where the control is drawn.
- **Covered controls.** What still covers a control after that (a dialog, a layer over the page) is refused and named, as on main. That holds in 4.0 too: `agentTools.js` is always injected, so `POINTER_TOOLS` is set without the debugger and main's `pointerOnControl` aimed and refused before the engine said no real pointer was there. A layer drawn see-through counts, because a press reaches it as it reaches an invisible inner button. Refusing is kept because it is what a person meets: pressing through a dialog or a wall acts on a page its owner has put out of reach, and the result names what is in the way for the model to deal with. `double_click`, `right_click`, `hold` and a click with keys held pressed through a cover on main; they now refuse the same way (`scriptedAim`), so every gesture on a control follows one rule.
- **Cost.** A list item whose only action is its link now takes one more step than on main: the first press lands on the item and the result names the link. A card whose link is stretched over it takes none.
- **Tests.** `tests/unit/nested-spot.test.js` (aim, scripted target, refusal wording, unseen buttons, labels, tabs, pinned bars, the real-press note). e2e `pressInside` (a row with a link at its middle, a card with an invisible button, a label with a drawn box and a link), `pinnedHeader` (a message under a sticky bar; the page checks that the press arrived where the message is drawn, which fails on main with the debugger off), `pressThrough` (a card with a stretched link, a list item that works only through its link) and `pressUnderLayer` (a button under a see-through layer, refused and named), all in the CI suite with the debugger off.

## 23 Nov 2026: first-run and upgrade rough edges

From the 4.0.0 audit (first-run and upgrade findings, each confirmed by a second reviewer). Each fix is in the mechanism, not a rule for one case. Tests in `tests/unit/first-run-edges.test.js`.

- **A popup task ran again whenever the panel was reopened.** The popup wrote `task` and `autostart=1` into the side panel's saved address. The popup now hands the task over the way the address bar does, through `omnibox.js` `handOff` (one id in session storage, taken once by `agent.js`). A tab opened from the popup still carries the task in its own address, which the agent page drops at once.
- **A welcome-page first task took over another tab.** `engine.js` `targetTab`, given no tab while the active tab is the extension's own page, searched the window for any web tab. It now returns the tab the conversation's last run worked in (`session.run.tabId`, then the latest of `session.view.tabs`) while that tab is open, and otherwise null, so `startingPlace` opens a fresh tab. A follow-up typed in the agent's tab goes on where the last run was. If the task needs one of the user's tabs, the model asks to switch. `tests/e2e/run-v4.js` now passes the fixture's tab id, as the popup and the side panel do.
- **A task typed in the quick box with the agent off was lost.** `background.js` kept it, but no page read it. `background.js` `offerKeptTask` now runs whenever `showAgent` goes from off to on, however that happens (the setup page, the Settings switch, a key already saved). It opens the agent page on the tab the task was typed on with the task in its box, not started, and removes it. Older than 30 minutes, it is dropped.
- **The quick box did nothing on browser pages.** Without the notifications grant the failure was silent. The toolbar icon is now marked for that tab with a grey cross and the reason as its title. The tab is recorded in `iconTabMarks` (session storage), and a run that needs the user sets its orange "!" and its title on those tabs too, since Chrome shows a tab's own mark over the window-wide one. They are put back when the wait ends. The popup's row waits for the worker's answer and stays open with the reason. The welcome page says "on any website".
- **The popup could open claude.ai before it was allowed.** Its fallback now uses the side panel's order (ChatGPT, Gemini, Perplexity, then Claude only when Chrome holds claude.ai, then the agent), and with nothing usable it opens the panel on its empty state. A saved claude.ai address without the grant is not reopened, and `sidepanel.js` does not load a saved site its picker does not list. The open-sidebar shortcut checks the grant too.
- **Perplexity was promised but missing on a fresh install.** `onInstalled` with reason `install` writes `CONFIG.STORAGE.FRESH_SETTINGS` (`showPerplexity: true`) where a key is unset, and Reset in Settings writes the same after removing the settings. Upgraders keep what they had, and no default changed in the five files that read it. Accepted trade-off: an install on a second device writes the value before Chrome sync brings that user's own choice, so a synced `false` can be replaced.
- **2.0's page right-click item was gone.** `buildContextMenus` again creates a page item, "Open Select to AI side panel", whatever is turned on. Its click goes through `onOpenSidebarCommand`, so the panel opens inside the click on a cold worker.

## 23 Nov 2026: audit fixes for CI and the store texts

- **CI.** `core-flow-e2e` and `consent-gate` looked for their test file and, if it was missing, printed a line and passed. A rename would have left both required checks green while running nothing. Both jobs now run their file unconditionally. `tests/unit/ci-workflow.test.js` checks that any file check in a workflow fails the job, that no step is skipped on one, and that every test file a workflow runs exists.
- **Privacy policy.** It did not list two items the code has. Each step sends up to six earlier turns of the same conversation, about 500 characters each (`core/context.js` `stepMessages`), and every side-panel send keeps the selected text in `sidePanelState` in `chrome.storage.local`. Both are now in `PRIVACY_POLICY.md` and `docs/privacy-disclosure.md`. `hygiene.test.js` reads the count and clip length from the code.
- **Right-click texts.** A fresh install shows Send to ChatGPT and Send to Gemini only (`showPerplexity` is false in `DEFAULT_SETTINGS`), but the welcome page, the long description and reviewer step 2 named Perplexity. The texts now name ChatGPT and Gemini and say Perplexity and Claude are in Settings, which stays true if Perplexity is later turned on by default. A test checks the named sites against the worker's defaults. Reviewer step 4 now mentions the "What the agent sends" card and the openrouter.ai prompt in the order they appear.

## 23 Nov 2026: nightly CI fixed, PRs 30 and 31 merged, store package rebuilt

- **Why the nightly failed (every night since 17 Nov).** The `e2e debugger on (nightly)` job loaded `extension/` as it is. Commit `20e03ce` (16 Nov) took `debugger` out of the 4.0 manifest so the update adds no warning, so from then on the "debugger on" suite ran a build with no debugger. The six real-input scenarios (`listened`, `pointerHover`, `pointerFrame`, `pointerDrag`, `pointerCanvas`, `realKeys`) could never pass. They are the ones `tests/e2e/not-applicable-4.0.json` lists for the shipped build. This was not a flaky site or an expired secret.
- **Fix (PR #32).** `tests/helpers/granted-build.js` gives its test copy the `debugger` permission when `E2E_DEBUGGER` is not `off`. `run-v4.js` stops at once if a debugger-on run has no `chrome.debugger`. The shipped manifest is unchanged, and `permission-warning-diff` still checks the real package. With the debugger back, one scenario still failed. `pointerCanvas` expected two real presses, but `c873739` (17 Nov) had stopped a refused press on a covered control from reporting a pointer. That change came while the suite was broken, so the test was never updated. The scenario now expects the one press that was made, and every other check in it is unchanged. Nightly on the merged tree: 90 of 90.
- **PR #30 (editors, frames, read-back, keys), merged.** A cold review found two defects, fixed on the branch. (1) The rule that the agent's own typing is not evidence could be bypassed: field values went into the evidence texts unfiltered, and a clipped or space-collapsed read-back kept a prefix of the typed text. `run.js` `withoutTyped` now removes typed text by runs of words, and `locateQuotes` accepts a quote that lies wholly in typed text only from text the typing did not reach. (2) A real key on the debugger path skipped the shortcut retry, and CDP runs Mac editing shortcuts only when `commands` is passed. `agentTools.js` `editCommands` now supplies them. Tests in `new-actions-safety`, `editing-keys`, `review-fixes` and `declined-edits`.
- **PR #31 (whole gestures), merged.** One safety defect, fixed. An aimed press (`fx`, `fy`) on a listed control could land on a different listed control inside it, such as a Delete button on a card, which the policy had never judged. `aimAtSpot` now refuses such a spot and names the inner control (`tests/unit/nested-spot.test.js`). The merge with #30 kept `type` and `select_text` in the approved-action label check, `needsRef` and `PAGE_ACTIONS`. A press marked `once` no longer repeats `times`.
- **Still open.** A press with no spot, aimed at the middle of a card, can still land on a button inside it (`aimAt`, and the scripted click). This was already on main before #31 and is not fixed here. Fixed since, in the entry above.
- **Store package.** Built by the `package-integrity` job from the final main commit, version 4.0.0, with no new permission warning over 2.0 (`permission-warning-diff`). It is in `~/Desktop/select-to-ai-4.0-release/` with the listing text, the privacy text and the upload steps. Not uploaded.
- **Docs.** New `docs/walkthrough.md` with two real traces from trial run 44139261360. `docs/demo.md` now says what it is (where the images come from), and `docs/demo-recording.md`, the README and the CHANGELOG describe the current agent, including the approval card.

## 6 Nov 2026: three defects from the Claude Haiku baseline, fixed at the root

Commits `7e89acf`, `feb45d1`, `e0428b6`, `b66f175`.

- **Stalls (3 of 105 runs: BBC News--8, ESPN--23, ESPN--11).** Every one ended on a step that loaded a new page and hit the settle ceiling (6.5 to 9.2 s), so the page was still loading when it was read. The engine injects its reader with `chrome.scripting.executeScript`, which holds a script until the document is finished; a document that never finishes (a frame whose server keeps the answer open, as advertising frames do, or a page still being sent) holds it for ever, and `readFrames` injects into every frame. Shown with a probe: on a page with one never-ending frame the all-frames injection was still pending after 5 s; with `injectImmediately` it returned at once. Nothing after it had a bound, so the run waited on the injection for the rest of its time. Now (`engine.js` `inject`) every injection keeps the usual wait for 2 s, then runs on the document as it is, within 3 s more, and a page that still cannot be read says "still loading" to the model. A first version injected at once every time (`7e89acf`); `b66f175` puts the usual wait back, since a page read mid-write is a change the stall did not need. Regression: e2e `stillLoading` (a page with a never-ending frame, then a page whose server never finishes): before, "Task Started" and nothing for 45 s; after, both read and answered.
- **Quotes on the page rejected (16 rejections in 7 dev runs).** Two causes, read from live re-scans of the pages: the check compared quotes only with the page text and control labels, while the model is also shown the outline, what is on screen and the names of the cards controls sit in (Coursera's "4.8" is drawn in an image with its text hidden, so it is only in the card's name; arXiv's "Replacement submissions (showing 16 of 16 entries)" was past where the 80,000-character text stops and only in the outline); and text from two elements side by side reads as one word in one place and two in another ("closed this as completedin 967f599" in GitHub's own text, "michael-smallclosed" in a quote). Now `run.js` `shownText` holds everything the model was shown from the page, and `context.js` `acrossBoundaries` matches the same characters in the same order, starting and ending on the page's word breaks, never joining or splitting a number. A made-up quote still fails: other words, another date, part of a word, "1 200" for "1200" (unit tests both ways). On the live scans, the two quotes that failed now pass and the same quotes with one number changed still fail.
- **False payment hold (Apple--30).** The 13-inch model is a radio button named "13-inch model Ultra Retina XDR display Buy from $1499 or $124.91/mo."; the word rule read "Buy" and held it as a payment, and the bench declines payments. A choice's words name the choice, not what pressing it does. Now (`agentTools.js` `choiceOf`) a radio button, box to tick, option, tab or switch whose words carry a pay, send or delete word is not held for them but put to the second opinion, told what kind of control it is; it is held when the opinion says it pays, sends or deletes, or cannot answer. Buttons are held by their words as before. Decision eval: `choose-configuration-not-pay` and `buy-configured-is-pay`; the eval now puts the engine's second-opinion question to the same model and scores holds (`hold`). Haiku 5.5, 3 repeats: 6 of 6 right; on the old policy the configuration case fails (held as pay) and the Buy now case passes.

Held-out set, once, Haiku 5.5 alone, Sonnet 5.5 judge, same settings as the baseline (900 s, 3 browsers). Measured on `e0428b6`, before `b66f175`:

| | Passed | Median s | p90 s | Agent $ / task | Model calls / task | Steps / task | Timed out | Quote rejections |
|---|---|---|---|---|---|---|---|---|
| Baseline (`b9ba691`) | 44 of 60 | 43 | 106 | $0.0091 | 9.6 | 7.1 | 2 | 31 |
| After (`e0428b6`) | **38 of 60** | 37.5 | 75 | $0.0077 | 8.1 | 6.0 | 0 | 6 |

- No stall; both baseline timeouts finished (ESPN--23 now passes). Quote rejections fell from 31 to 6, answer checks from 81 to 73, held steps from 15 to 7.
- The pass count fell by 6: 12 tasks flipped to failed, 6 to passed. Read from counters only (held-out rules): 10 of the 12 had no quote rejection and no second opinion in either run, so neither of those changes touched them; a single run per task moves by several points by itself, and 12 against 6 is not a significant split (sign test, p about 0.24). Not proven to be noise either.
- Dev set (45, 600 s) on the final tree `b66f175`: 24 of 42 against 27 of 42 (same 3 blocked), median 44 s, p90 78 s, $0.0102 per task, 9.9 calls, no timeout, quote rejections 16 to 11. Of the 11 flips, Apple--30 now passes (the configuration choice ran). One loss is the quote change working as meant with a cost: on ESPN--4 the baseline's rejected quote (it was on the page) sent the run back to look again and find all 14 games; now it is accepted and the check passed an answer with 8 of 14. That is the answer check missing an incomplete list, not a loose quote match. The other failures read as the model's own choices (a cheaper room missed, a hotel not in the evidence, a query never run).
- Open: the answer check passing incomplete lists; whether the held-out drop is noise needs a second run of both arms or the dev set repeated.
- Spend: about $3.3 (held-out agent $0.46 and judge about $1.30; dev agent $0.46 and judge about $1.07; decision eval under $0.02).

## 5 Oct 2026, night: lasting facts about the user

- Before: what the user answered to the agent's questions was kept only when they ticked "remember my answer" (profile field or preference) or the model called `remember`; "where are your assignments?" answered with a service was gone after the run.
- Now (`core/learn.js` context, `core/memory.js` `groundContext`, `putFact`, `knownBlock`, `engine.js` `learnContext`): a new entry kind, `context`, holds lasting facts about the user's life with their quote, the run they came from, whether a site is part of them, first and last seen, times said and active or retired.
- The gate, no model call: the user said something beyond the bare request (an answer to a question, something added mid-run, a thumbs-down reason), or a checked, uncorrected run with no text speaking to an AI was done on a host no fact names and no earlier run put to the call (noted in `contextSites`, so a site alone asks once). Thumbs-up never asks.
- The call is shown only the user's words (request, earlier turns, each question with its answer, mid-run additions, the reason) and the run's hosts, never a page. It decides add, update (id), supersede (id) or nothing per item, for facts or preferences. Because it never sees a page, anything in a proposal that is not in the user's words is the model's inference or invention, not injection: grounding is about not putting words in the user's mouth. Code keeps each value that is in the user's words, the fact it replaces, or a host the checked run used (or its parent), drops the others, and refuses the item only when no value is left. The fact's text may add common knowledge (Lyon, France; Outlook, outlook.com; NetEase for 网易邮箱). The quote must be the user's words verbatim; when it is not (gpt-oss quoted the agent's question) and the user-typed values sit in exactly one thing the user typed, that becomes the quote. Sensitive items (health, religion, politics, sexuality, finances, legal matters, of the user or anyone else; the model judges, no keyword list) need the "remember" tick. About other people, only who they are to the user and what tasks need (a sister's city). Then all new texts go to the meaning check page text gets (`addressedMessages`); anything but a clear no keeps nothing.
- Several services: supersede only when the user's words say the old fact no longer holds ("not Gmail", "I switched"); a second service ("Outlook for work") is an add, or an update by id that widens the fact. Facts carry their purpose in their wording.
- Consolidation: a new item sharing 60% of its words with a kept one, and naming nothing the kept one does not, is that fact said again (confirmed, times +1); one holding every word of a kept one is a fuller wording (updated in place). So "Uses Outlook for work" is never merged into "Uses Gmail for email". Supersede retires the old one (up to 25 retired kept for 90 days, never shown) and adds the new with links both ways. Only a run in which the user said something can update or retire.
- The limit is what a step is shown, not what is stored: all facts when 10 or fewer, else the 10 sharing most words with the request. Storage is bounded by size only (300 live facts, about 70 KB); beyond that the least useful goes: user-written last, then least (helped - hurt + times), then oldest.
- Each shown fact reads `- Lives in Lyon, France; pays in euros (the user said "I live in Lyon so euros"; since 2 Oct 2026; from their words in 1 task)`. "Said" is only ever the quote, shown when it is 80 characters or less and differs from the text.
- Site notes now carry the step they are about and are kept under that step's site (fallback: the run's first site, not its last).
- Tests: `tests/unit/core-context.test.js` (17: gate, grounding with dropped values and inferred text, quote put right, sensitive incl. another person, second service vs switched, fuller wording, page text, consolidation, supersede, 300 cap, block with quote, note site); e2e `contextLearned` (run 1 asks and learns from the answer and the checked site, a line on the page about the user is refused and never reaches the call; run 2, a different request, goes straight there); decision cases `blank-tab-known-service` and `-pick` with selftest outcomes.
- Live (5 Oct, NVIDIA free tier, 2 repeats, scratchpad `context-live.js`): first pass with the literal grounding, gpt-oss-20b 11 correct keeps, 3 missed, 2 wrong keeps, 12 correct nothing; nemotron-3-ultra 8, 6 missed, 0 wrong, 14 nothing; most misses were the grounding (France, outlook.com, 网易邮箱 not in the English text, the quote taken from the question). After this change, same 14 cases (update-same-fact proposing nothing now counts as correct; the sister case now expects no health fact rather than nothing): gpt-oss 12 keeps, 0 missed, 2 wrong, 14 nothing; nemotron 13, 0 missed, 1 wrong, 14 nothing. Two new cases (Outlook for work beside Gmail; switched to Outlook) correct 4/4 for both. The wrong keeps are judgment the literal checks used to hide: gpt-oss keeps a one-off trip ("Traveling to Tokyo from 14 Nov to 21 Nov", 2/2); nemotron once kept "Uses US dollars" and "Prefers the cheapest option" from a one-off price question. The 60% threshold and the caps are judgment, not measured.
- Closed in the 15 Oct hardening pass: the `remember` tool now supports `kind: "context"` facts as well as preferences when grounded in the user's words (`saidByUser` also matches common verb/noun inflections like `study`/`studies`); hosts named in user-sourced `context` facts (`KNOWN.knownSites`) are trusted for deep-link navigation unless the URL carries a stored profile detail not in the request; blank-tab runs (`site === ""`) retrieve matching routines with their starting site; post-run learning writes are serialized through `memoryChain` via atomic delta ops; and `RUN.toStored` strips bulk `seenPages` once a run or sub-task finishes.

## 5 Oct 2026, evening: following the agent from its own page

- Cause of "randomly transported" when the agent page is a tab of its own: `tabs open` and links opening a new tab created active tabs; `tabs switch` activated the tab; a picture of a tab behind another brought it forward for about 150 ms and back; a run with no web tab opened an active one. All of these were for reading or opening, none for acting.
- Measured on Chrome (puppeteer probe, headless and in a window): on a tab behind another, the debugger's mouse move, press, release, wheel and keys all arrive (hover, click and typing took effect) and `Page.captureScreenshot` returns the page in 86 to 97 ms; but animation frames do not run (0 in 500 ms) and a CSS transition stays at its start and never ends, with or without a screencast running. So reading needs nothing; acting on a page that animates needs it in front.
- Now (`core/view.js`, `engine.js` "the view", `agentBar.js`): reading never activates a tab; an action on a page brings its tab to front only while the user follows the run (their window shows the agent page that started it or a tab the run works in), then waits until the page is drawn (two animation frames; 39 ms in the e2e run). From the agent page tab, that page carries a bar (step text, status, Stop, Back to agent, Open side panel). At the end, or at a wait answered on the agent page, the user is taken back unless they clicked, typed or scrolled on the page themselves (the agent's own trusted input is told apart by the mark the content script keeps while it acts). On-page waits (sign in, check, code, payment) keep them on the page.
- The model is told, for a tab behind another, whether an action brings it to front or the user is elsewhere; the fact no longer says `tabs switch` brings a tab forward, which is no longer true.
- Tests: `tests/unit/core-view.test.js` (which actions bring to front, following, return on end with and without the user's hand, the bar's states); e2e `followBar`, `followTouched`, `followPanel`, `followRead` in `tests/e2e/run-v4.js`. Screenshots: `node tests/e2e/agent-bar-screenshot.js` into `docs/screenshots/agent-bar/`.
- Found on the way: the e2e harness had the page behind the agent page in every scenario, so no scenario had acted on a drawn page. With the page in front, the press into another site's frame failed in headless Chrome: the debugger's pointer reached the frame element in the outer page, not the frame's button. In a Chrome window the same press lands first time with the page brought to front (probe in the scratchpad, `front` 27 to 30 ms). `pointerFrame` is now played with the user on a tab of their own (the page stays behind, and the scenario checks the user is left there and the model is told). The scroll that brings a control on screen before a press is now instant, not smooth, so a drawn page is not still moving when the pointer is aimed.
- Open: Side panel runs are covered by the unit tests only: the e2e harness drives the agent page as a tab. (Closed in the 15 Oct pass: the user's own clicks, keys and scrolls inside subframes on the page are now reported by `agentContentScript.js` and `agentBar.js` iframe-focus detection to `engine.js` `agentBarTouched` across all frameIds.)

## 5 Oct 2026, later: answer first, check behind it

- Read from a real run ("how many years in a decade?" on Wikipedia, 39 s for one step): the answer waited for the check; the check's model replied in prose and was re-asked; the re-ask showed as a step; "Pages used" named the start tab; the saved log had one line.
- The answer now shows at done, marked as being checked; the check runs as before and ends the run, or sends the answer back, which is then marked replaced. Scripted one-step run (step 0.6 s, check 2.5 s), five runs each: first visible answer 3.15 to 3.19 s before, 0.64 to 0.69 s after; the final answer at the same time as before. Not measured on a live model.
- The checker's prose: the tool handling was already the steps' (offered, offered with the reminder, forced, written JSON). The cause was the instructions, which asked it to "list" requirements and "say" things before "Call the verdict tool" at the end. They now say the whole judgment goes in the tool. Not yet re-measured live.
- Pages used, the saved log, quiet internal lines and the selection with its place: see CHANGELOG.

## 5 Oct 2026, night: what changed

- One engine and one way in: the old loop and the command router are removed (extension/ 29,787 to 20,922 lines). The address-bar keyword `ai` starts the agent; a run started on a page it cannot use opens a tab and goes where the request needs.
- The interface is redesigned to `ui-direction.md`: shared tokens, the run told as a story, both themes, calm motion; `scripts/ui-states.mjs` renders every state.
- Sub-tasks: `delegate` runs up to four parts of an errand side by side in background tabs.
- Learning measured (each task twice, 12 dev tasks): where something was learned the second run took about half the steps and time; one wrongly checked success taught a wrong route. Matching works in any script now; failing notes are dropped.
- Convergence: progress (a new note or a new non-search page) is measured; wandering is stated and brings in the helper; the helper keeps the steps until it makes progress; find misses are information; failed or redirected addresses say so; the instructions are 12% shorter and name the site as the source.
- Sign in with ChatGPT is built (Plus or Pro only); untested on a real plan.

Fresh never-read tasks, 65, before the convergence change (old judge; blocked runs left out):

| Setup | Passed |
|---|---|
| gpt-oss-20b with Nemotron Ultra helper | 30 of 57 (53%) |
| Nemotron Ultra alone | 39 of 58 (67%) |

Third unseen set (60 tasks, Cambridge Dictionary left out because its bot check blocks every run), same tasks for every row:

| Code | gpt-oss-20b + helper | Nemotron Ultra alone |
|---|---|---|
| 060db8c (before the convergence change) | 40 of 60 | |
| f4d3424 (first convergence change) | 37 of 60 | 45 of 59 |

The first convergence change did not help: a read of the 15 flipped tasks found the helper holding too long, wandering ending runs, paging not counted as progress, step-1 answers unchecked and wording that invited early surrender. Reworked in c517919 and being retested twice on the same tasks.

Also fixed on 5 Oct: a control cut off inside a scrolling box was refused as covered (MiniWoB++ on a local Gemma 4 E4B went 49, 54, 51, then 57 of 75 after the fix); page scroll moves the inner pane on apps whose window does not scroll; lone surrogate halves no longer make a provider refuse a request.

## 4 Oct 2026: where it stands

The goal and the rules it is built by are in `agent-goal.md`. This section is the current state; the older sections below are kept as the record.

Measured on 65 WebVoyager held-out tasks whose failures have since been read (so no longer unseen), 15-minute limit, free models on NVIDIA's endpoint:

| Setup | Passed (blocked and lost left out) |
|---|---|
| Nemotron 3 Ultra 550B alone, before the answer fix | 36 of 61 (59%) |
| Nemotron 3 Ultra 550B alone, after | 44 of 60 (73%); a careful reader put it at about 70% |
| gpt-oss-20b alone, after | 30 of 53 (57%) |
| gpt-oss-20b with Nemotron as helper, after | 36 of 56 (64%); the helper took about a fifth of the steps |

The answer fix: a forced tool call on that endpoint ended a text field at its first line break, so an answer that introduced a list arrived without the list. Ten of the strong model's 25 failures were this. The tool is now offered, and forced only on a second re-ask.

A fresh sample of 65 held-out tasks nobody has read is in `tests/bench/data/webvoyager-fresh-sample.json` (local only; the data folder is not tracked).

Changed on 4 Oct, all with tests:
- Safety by meaning in any language: a button or one-box form the English rules cannot read is put to the run's own model, page-blind; no answer holds the action. Fill-but-do-not-send is enforced.
- Stopping: no step cap. A check-in after a set time of work (default five minutes) that continues the same run; a stop after six steps with nothing to show; rate limits pause and resume.
- The answer check and learning use the run's own model or the helper, never another provider's fallback; no model family skips the check.
- Model size is read from the name (every Gemini, Llama, Qwen and Nemotron model had been given the small model's limits).
- Notes are added to each step, not rewritten; routine steps ask for low thinking effort (output per decision halved on the decision eval).
- After an action the page is looked at again when its requests and busy signs have settled, up to 12 s.
- Prompt injection: no English pattern gating every click; hidden sentences are judged by meaning; page text never authorises.
- Sites by the Public Suffix List; search forms read on any site.
- Going round in circles is a stated fact; an answer the check still objects to ends as unconfirmed.

Open, in order: real pointer (drag, hover, click at a point) through the debugger; a look at the screen when text cannot describe a thing; several tabs; the judge (a model other than the driver, with screenshots); learning measured (each task twice); the user's own tasks as a test set.

## The short version

- On unseen tasks the new engine is ahead of the old loop on both models where both arms are complete: gpt-oss-20b, **31 of 59 against 22 of 59**, and Nemotron 120B, **26 of 60 against 21 of 60**. On the tasks both scored, the new engine alone passed 15 and 11, the old loop alone 6 and 6. Taken together that is 26 against 12 (two-sided sign test p = 0.03). The Gemini arms are incomplete because the free quota ran out, and point the same way where they overlap.
- On the dev tasks, measured earlier in the night on older commits, the two were level. The gate asked for three models on unseen tasks: **two are done and favour the new engine, the third (Gemini) needs its old-loop arm finished** after the quota resets.
- Every benchmark number from before 2 Oct was wrong for both engines, because the benchmark itself was broken (next section). Do not quote them.
- Two nights of reading failed dev runs produced a list of real faults in how the agent sees and operates pages, each fixed and tested. They are listed under "What was fixed".
- The ceiling is still the model. Both engines pass about half of the tasks or fewer on free small models. The products this is being compared with run frontier models.

## The benchmark was broken

`tests/bench/run.js` opened the agent's panel as a tab in the same window as the page. That put the page in a background tab, and Chrome does not draw background tabs: animations stand still, so a menu, a date picker or a dropdown never finished opening. Every task that needed one failed, for both engines, for a reason that had nothing to do with the agent.

Fixed on 2 Oct: the panel gets a window of its own, as the side panel sits beside the page in real use, and a run records a problem if the page was not in view. On the same model and tasks the old loop went from 14 of 41 to 19 of 40 from this fix alone.

## Numbers

"Scored" leaves out runs lost to the harness or the provider and runs a site's bot check blocked.

Held-out tasks (65 unseen; only counts and ending categories are read, never transcripts). New engine frozen at commit `0c3fb95`; both arms of a model run at the same time of night.

| Model | Old loop | New engine | On tasks both scored |
|---|---|---|---|
| gpt-oss-20b (NVIDIA, free) | 22 of 59 (37%) | 31 of 59 (53%) | 58 tasks: new 31, old 22 |
| Gemini 3.5 Flash-Lite (32 tasks) | 7 of 12, quota ran out | 14 of 29 (48%) | 11 tasks: new 8, old 6 |
| Gemini Flash-Lite (33 tasks) | 2 of 5, quota ran out | 16 of 31 (52%) | 5 tasks: new 2, old 2 |
| Nemotron 120B (NVIDIA, free) | 21 of 60 (35%) | 26 of 60 (43%) | 60 tasks: new 26, old 21 |
| gpt-oss-20b again, new engine at the newest commit (`661b11a`) | same old arm | 32 of 60 (53%) | 59 tasks: new 31, old 22; against the frozen new engine 32 to 31 |

The second gpt-oss-20b pass says the fixes made after the freeze did not move the pass rate on unseen tasks for this model (they changed which tasks pass: 8 gained, 7 lost), while the median time per task fell from 77 s to 66 s. The old loop's is 97 s.

How the gpt-oss-20b runs ended: the new engine finished 43 of 65, ran out of steps in 7 and timed out in 4; the old loop finished 31, answered without acting in 7, gave up in 6, timed out in 8 and stopped at a send confirmation in 5. Median time per task 77 s against 97 s.

Dev tasks (45 from WebVoyager; transcripts are read and used to find faults, so these are not evidence for the gate).

| Model | Old loop | New engine | Note |
|---|---|---|---|
| gpt-oss-20b (OpenRouter, paid) | 19 of 40 | 20 of 42 (2 Oct), 17 of 41 (3 Oct, before the last ten fixes) | Level, within run-to-run noise of about 3 tasks |
| Gemini 3.1 Flash-Lite (free) | 8 of 10, quota ran out | 19 of 36 | On the nine tasks both scored: 7 and 7, the new engine in far fewer steps |

To finish the Gemini arms after the quota resets (about 15:00 Singapore time), rerun `g-gemlite.sh`, `g-gem35.sh` and `d5-gem.sh` from the scratchpad; each resumes and fills only what is missing.

## What was fixed (all general, each with a test)

How the agent sees a page:
- The listing keeps what the last action opened (a menu, a dialog) and never cuts controls that are on screen before ones that are not. Before, the first paper link on an arXiv list was dropped while links three screens down were listed.
- A link written as a button (`href="#"`, as on the Open and Closed tabs of a GitHub issue list) and the page numbers of a pager were both being left out of the listing, the first as "a link to the same page", the second as "a footnote marker". Both are listed now. These two were found by an audit that compares every clickable thing on a live page with what the scan numbered (`coverage.js` in the scratchpad); it is worth running on any site that behaves oddly.
- Native checkboxes, radio buttons and sliders that a page makes transparent to draw its own control are listed with their state. Booking's guest counters are such sliders; setting "3 adults, 2 rooms" is now two fills.
- What is drawn on top of a page (a dialog, a cookie or sign-up notice, a bar pinned to the bottom of the window) is found by where it sits, listed first, and stated as a fact.
- A frame that is part of what the user sees (a consent notice another site serves on top of the page, or a frame that fills much of the window) is read, its controls are listed under its name, and actions on them are carried out in that frame. Human-check frames are never read.
- The model is told today's date, and when its tab is behind another one.

How the agent operates a page:
- `fill` matches an option by its words ("One-way" chooses "One way"); a search made of several fields is treated as a form; typing follows the cursor when a page moves it to an overlay box; a field that opens a list of suggestions names them by their listing numbers and says when nothing was chosen.
- Typing goes to the box that is actually at the field's spot when a page has drawn a larger one over it, and a typed name chooses the one suggestion that is that name with a qualifier after it ("London" chooses "London, United Kingdom").
- A fill ends the way a person ends typing, by leaving the field. Date boxes and other fields that keep the text only once they are left now take it; this was why a typed date on a flight search never held. Focus and blur events are sent by hand when the page's window does not have the keyboard, which is the normal case with the side panel.
- An action's result names what it brought up, by number ("That brought up: [141] slider Adults, ..."), so a popover that opened is not mistaken for nothing having happened.
- Enter does only what Enter does in a browser: it submits the field's form or presses the button it is on.
- A click on a control number that is no longer on the page is a failed action with a pointer to the control's new number, not a reason to end the run.
- A link made to open in a new tab is opened for the run (a scripted click cannot open a tab), and the run moves to any tab a page opens during an action.
- `find` is one search of the whole page, text and controls, and says the words are there only when all of them are; `read` only continues a long page from where the shown text stops; `scroll` says how far down it got.

How a run ends:
- A reply that cannot be run no longer ends the run, and the run keeps its notes; several loose reply shapes are read as what they plainly mean.
- Quotes are checked against everything the model was shown, including the control listing and the stated date, and a quote shortened with an ellipsis is matched by its pieces.
- The answer check's opinion is shown under the answer and is no longer written into the answer's text; it is told the date and shown how the page begins.
- A rate limit counted by the minute is waited out instead of ending the run.
- Giving up with the account written in the notes and no answer field is taken as that account, not sent back.

Most of the items from "A fill ends" downward were made after the held-out freeze (`0c3fb95`). The second gpt-oss-20b pass at `661b11a` includes them; the Nemotron and Gemini arms do not.
- `fill` chooses from a menu built of plain buttons or links (Hugging Face's sort menu), and takes only the entries the control itself brought up.
- `find` sees into the page's frames, and a notice closed by its own button inside a frame is reported as closed, not as a failure.

Checks and blocks (decisions of 3 Oct):
- A site's own browser check is given twelve seconds to pass by itself before the user is asked. Nothing on it is touched.
- The agent never solves or evades a human check, and never goes to a different site to get around a block. It waits for the user on the same site.

## MiniWoB++ (3 Oct, afternoon)

A second benchmark, to test the harness on widgets rather than on live sites: 75 MiniWoB++ form and widget tasks, two seeded episodes each, run with `tests/bench/miniwob.js` on a free small model (Qwen 27B through OpenRouter). Drag, drawing, hover, clipboard, timed and picture tasks are left out. Transcripts of this benchmark are read, so it is a dev set, not evidence for the gate.

First pass: **95 of 150 (63%)**. Reading the failures and the passes gave these general changes, each with a test:

- A list of suggestions with no markup saying it is one is found by what typing brings up against the box.
- A click starts at the innermost element drawn at the control's middle, as a press does. A tab that listened on the link inside it never heard the old click.
- An icon with no words is listed with what the page's markup calls it (`no name, marked "star"`).
- A click or key press ends with what its control now shows (checked, open, its value). A read-only box says so in the listing; a link to the page it is on names no address.
- The agent's own cursor, labels and control numbers no longer count as the page changing, so a click that did nothing is reported as that.
- `scroll` with a ref scrolls the box that control is in (a long text box, a panel with its own bar).
- `find` gives a number to a short piece of text no control covers, and looks for symbols as written ("+"), so a thing to press that only a script listener marks can still be pressed.
- A row of short separate labels under one pointer ("Reply" beside "Forward") is listed label by label; an element given the pointer hand only on hover is listed.
- Words that are not drawn no longer leak into the page text.
- `press` takes `times`.
- A step goes on after a change in place when the next action's control is still there under the same words with nothing new on top. Ticking five boxes was five model calls.
- A model that ran out of room for a reply once is given that room from the start afterwards.

Not done, and why:
- Clicking a menu's parent item where a person would hover is the model's choice with the facts stated.
- Passwords are the user's to type; those tasks end at a handover by design.
- Controls known only by a script listener, with no text to find: the only way to list them is to patch `addEventListener` in every page from load, which sites that fingerprint browsers can detect. That would raise the rate of human checks, so it is not built. Arnav's call if he wants it tried.
- Keys are sent as events, which do not scroll or move focus the way a real key does. Sending real keys needs the debugger permission and its banner.

## How a run stops and waits (4 Oct)

Limits that were inherited and hurt real use were replaced; not yet measured on live tasks.
- **No step cap.** The hidden 25 steps is gone. A run asks the user after a stretch of working time (5 minutes by default; `agentCheckInMinutes` 2, 5, 10, 20 or never) whether to keep going, showing what it has found. Keeping going continues the same run; stopping gives the model one last step that can only answer or ask. Waiting for the user is not counted.
- **Stopping when going round.** Six steps in a row in difficulty that shows nothing came of them (repeats with no effect, failures, a round of actions with the page back as it was), with the helper taking at least one when set, and the model gets one last step to say so. The same action on a page that keeps changing (paging a list in place) never counts.
- **A guard on cost.** 200 model calls in a run pause it with the same question; keeping going allows 200 more.
- **The answer check** is the helper when set, otherwise the run's own model; no model family skips it, and nothing goes to the provider's free lite model.
- **Quotes** are checked against up to 800,000 characters of page text, oldest let go first; a quote from a page let go is said to be unchecked, with the page named.
- **Notes** have room for 6,000 characters (was 2,400), and the model is told the room, its use, and how much was cut.
- **Rate limits** longer than about a minute pause the run with a countdown and it carries on by itself (an alarm wakes the worker); a spent daily allowance still ends it, with what was found.

## What the failures are now

From the dev transcripts of the latest runs:
- **Wrong or thin answers that the model is confident about.** The answer check (the same small model) catches about half. When it rejects an answer the model resubmits it at once in about 60% of cases, and three quarters of those are failed by the judge too.
- **Searching instead of acting.** gpt-oss-20b spends about 30% of its actions on `find`, most of them for words that are not on the page.
- **The place the test runs from.** Amazon shows Singapore dollars, Google Flights starts from Singapore; tasks that say "under $50" fail on that alone, for both engines.
- **Site checks.** After a night of test traffic Amazon and Cloudflare challenge this machine. Those runs are counted as blocked, not failed.
- **Approvals the test declines.** A "Compute" or "Continue" button in a form that is not plainly a search is held for the user's go-ahead, and the benchmark says no. That costs both engines the same few tasks. In the product it is one click, and a standing "always allow on this site" would remove even that.

## Where the time goes

Measured on 3 Oct with the run timer (`timing` in each run record): reading the page is 0.03 s a step, acting about 1 s, and the model is the rest: median 2 s a step on Gemini Flash-Lite, 5 s on gpt-oss-20b through OpenRouter, 9 to 24 s on NVIDIA's free endpoint. Prompts are about 8,000 tokens a step; reasoning models write 450 to 600 tokens before each action. An ad blocker changes none of this (uBlock Origin Lite beside the extension: 8,096 prompt tokens a step against 7,902 without, 20 against 19 tasks passed of 41 shared).

## Running and watching

- Watch the agent work in a visible Chrome: set `BENCH_HEADFUL=1` when running `tests/bench/run.js`.
- Long batches run from the Terminal panel (`tests/bench/matrix.js <arms.json>`); a batch resumes where it stopped.
