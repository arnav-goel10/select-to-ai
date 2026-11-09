# Recipes: calibration on the dev mutations

Calibration ran on the **dev set only**: `bench/recipes/mutations/dev` (56 mutations in 20 families, 43 repairable and 13 must-stop) plus the unmutated cells. The implementer never read, listed or opened the held-out set (kept outside the repository), and never ran `--sets heldout`. Results are in `bench-results/recipes-cal*/`, which git ignores.

Harness: `node bench/recipes/run.js --sets dev`. Success means the fixture server's `/__truth` says the run is correct. The adapter is `bench/recipes/adapters/recipes.js`. `recipes?repair=off` replays with no model.

Two kinds of change are logged here:
- **Mechanism fixes.** These were general bugs or missing signals that the dev runs exposed. Each can be stated without naming a site or a mutation.
- **Threshold changes** (τ, μ, τc, μc, the label floor).

Both are judged only on dev numbers.

## Log

### cal0: first run, starting values (τ 0.75, μ 0.12, τc 0.90, μc 0.25), replay only

| | unmutated | repairable | coverage | must-stop correct | false done | wrong action |
|---|---|---|---|---|---|---|
| reference-replay (baseline) | 100% | 42% | 0% | 37% | 13% | 8% |
| recipes, replay only | **25%** | 10% | 7% | 100% | 0% | 0% |

Unmutated success was the real problem, and every failure was a mechanism bug rather than a threshold:
1. **URL checks failed on record ids that hold letters** (`/users/u104`, `/invoices/INV-CL17-2602`). Only all-digit and hex segments were masked. *Fix:* any path segment containing a digit is an id (`core/url.js idLike`).
2. **Camel-case variable names** (`taxId`) were rejected at compile time. *Fix:* names may be `[A-Za-z][A-Za-z0-9_]{0,31}`.
3. **Checks built from the site's data.** New text lines and controls that appeared in list rows were kept as postconditions ("SKU-1130 · 12 in stock"), and they differ for other values. *Fix:*
   - a line that shows a bound value is checked by that value only;
   - a fixed phrase is kept only when the page announces it in a status, alert or live region;
   - a control that appears inside a list item counts only when the item is the one a variable chose.
4. **Controls picked by a variable** (a contact link named "{name}", a toggle labelled "{setting}") were scored on the recorded record's id, name, link and position. *Fix:* when the label is a variable slot, those attributes get weight 0.
5. **Rows with near-identical names** ("Home" and "Home office"). *Fix:*
   - item text keeps its cells apart ("Home | 1 Main St");
   - a row that states the value as a whole cell beats one that merely contains it.
6. **Table cells in the same row looked alike** (stock 388 and reorder level 54). *Fix:* the snapshot adds the column header of a cell, and the fingerprint weights it 2.0. This also survives column reordering.

### cal1: after fixes 1-6, starting thresholds, replay only

| | unmutated | repairable | coverage | must-stop correct | false done | wrong action |
|---|---|---|---|---|---|---|
| recipes, replay only | 83% | 30% | 24% | 100% | 0% | **1%** |

New findings:
7. **Wrong action, replay only.** This was `lookalike-decoy` on `admin.deactivate`, 2 cells. A clone of a destructive button carried the recorded control's test id and html id with different words ("Deactivate and remove" for "Deactivate user"). It won on ids. *Fix:* a **label floor**. A control whose words are less than 0.5 similar to the recorded ones is never taken without a model, however well its ids and position match. The step goes to repair, where the model judges meaning. This makes safety stronger, not weaker.
8. **Read steps were found by the value they read.** A status that differs per record scored low. *Fix:* the words of a read target get weight 0, so it is found by column, row, neighbouring label, heading and test id.
9. **Pagination recorded as fixed clicks.** A reference that clicks "Next" until its row shows records N clicks, and N depends on the value. *Fix:* at compile time, a run of identical read-class clicks is folded into a `seek` on the next step. The run qualifies when the next step's variable-chosen item was absent before the clicks and present after them. At replay the step presses that control only while its item is not shown, up to 12 times. When the recording needed no clicks, repair can propose the same `seek` patch. It is allowed only for steps whose item is chosen by a variable, and only on a control that does not submit.
10. **Fields with churned ids and names** score just under τ with a huge margin (the one "Role" select: 0.737, margin 0.737). This is the τ question below.

### cal2: τ sweep after fixes 7-10, replay only (μ 0.12, τc 0.90, μc 0.25, label floor 0.5)

| τ | unmutated | repairable | coverage | must-stop correct | false done | wrong action |
|---|---|---|---|---|---|---|
| 0.75 | 94% | 32% | 25% | 100% | 0% | 0% |
| 0.70 | 94% | 32% | 25% | 100% | 0% | 0% |
| 0.65 | 94% | 34% | 27% | 100% | 0% | 0% |
| 0.60 | 94% | 34% | 27% | 100% | 0% | 0% |

There were no wrong resolutions at any τ. 0.65 and 0.60 performed the same, so the stricter value was kept: **τ = 0.65**. The remaining unmutated failures (3 of 50) are the variable's row sitting on another page with no paging in the recording; those need a `seek` from repair.

Most of the remaining replay-only failures on repairable mutations were **commit steps scoring 0.82-0.87 with margins of 0.47-0.60**. These come from id and class churn, removed test ids and moved sign-in buttons. They already pass the exact-label rule, and τc = 0.90 rejected them. That led to the τc sweep in cal3.

### cal3: commit threshold sweep at τ 0.65, replay only

| τc | μc | unmutated | repairable | coverage | must-stop correct | false done | wrong action |
|---|---|---|---|---|---|---|---|
| 0.90 (cal2) | 0.25 | 94% | 34% | 27% | 100% | 0% | 0% |
| 0.85 | 0.25 | 94% | 38% | 35% | 100% | 0% | 0% |
| **0.80** | **0.25** | 94% | 43% | 43% | 100% | 0% | 0% |
| 0.75 | 0.25 | 94% | 44% | 44% | 100% | 0% | 0% |
| 0.80 | 0.15 | 94% | 44% | 44% | 100% | 0% | 0% |

Commit steps also need the exact recorded label (unchanged), and the must-stop mutations (opposite action, removed feature, split options, required field with no default) stopped correctly at every setting. Below 0.80 the gain was one cell, so **τc = 0.80** with **μc unchanged at 0.25**: the strictest value that takes the plateau. μ for read/edit steps stays 0.12, since no dev failure was a margin refusal on the right element that a lower μ would have accepted safely.

### cal4: first run with repair on (Claude Haiku 5.5), τ 0.65, μ 0.12, τc 0.80, μc 0.25

| | unmutated | repairable | coverage | must-stop correct | false-heal rate | false done | wrong action | model-free | $/run | s/run |
|---|---|---|---|---|---|---|---|---|---|---|
| recipes (repair) | 87.5% | 44.8% | 44.9% | 84.2% | **50% (6/12)** | 2.5% | 1.7% | 62.9% | 0.00018 | 5.63 |
| recipes, replay only | 85.4% | 38.3% | 37.1% | 100% | - | 0% | 0% | 100% | 0 | 3.72 |

All 6 false heals came from one must-stop mutation: two CRM contacts with the same name. The resolver correctly refused (ambiguous), and the repair model then picked one of the two. Fixes:
11. **Equal twins chosen by a value stop the run.** Repair is not attempted when two controls of the same kind say the same words, score within 0.05 of each other, and their label or row carries a bound value. Choosing between two records with the same name is the user's call; the run ends `needs_you`.
12. **Title checks were the record's data** (a user's name in the title). A new title is now checked only by the variable it shows.
13. **Repair prompts for read steps quoted the recorded answer** as if it were the control's label, which misled the model. The value is now described by its place only.
14. **Seek waits did not ask for text items**, so a read target on a later page was never seen.

### cal5: repair on after fixes 11-14 (code at cc3d29e), τ 0.65, μ 0.12, τc 0.80, μc 0.25

| | unmutated | repairable | coverage | must-stop correct | false-heal rate | false done | wrong action | model-free | $/run | s/run |
|---|---|---|---|---|---|---|---|---|---|---|
| recipes (repair) | 100% (48/48) | 57.1% (88/154) | 58.4% (52/89) | 100% (38/38) | **0% (0/18)** | 0% | 0% | 72.9% | 0.00012 | 5.14 |
| recipes, replay only | 93.8% | 43.5% | 43.8% | 100% | - | 0% | 0% | 100% | 0 | 3.71 |
| reference replay (baseline) | 100% | 42% | 0% | 37% | - | 13% | 8% | - | 0 | - |

The cal5 run spent $0.030 on repairs. Almost all of the remaining repairable failures are stops that the design calls for, not wrong actions:
- commit steps whose control is icon-only, renamed (Sign in / Confirm) or covered by an interstitial, or that sit next to a lookalike Save. A commit step is never repaired without an approver, so these end `needs_you`.
- i18n: more than 2 steps break, which uses up the repair budget of 2.
- url-path-moved: the post of a navigate step fails, and navigate steps are not repairable.
- step-split, plus some model `cannot` answers.

## Frozen

Tuning stopped after cal5. The frozen values are:

| parameter | value |
|---|---|
| τ (read/edit) | 0.65 |
| μ (read/edit) | 0.12 |
| τc (commit) | 0.80 |
| μc (commit) | 0.25 |
| label floor | 0.5 |
| commit label rule | exact recorded label |
| repair model | claude-haiku-5-5, thinking disabled |
| max repairs per run / attempts per step | 2 / 2 |
| seek max presses | 12 |
| twins guard | score within 0.05, same kind and words, value-bound |

These values are the defaults in `packages/recipes/core/fingerprint.js` and `core/replay.js` at code commit **cc3d29e**. Only dev mutations were used. The held-out set has not been seen.

## Round 2, after the held-out run on c52143d

The lead ran the held-out set once on c52143d and reported four general failure mechanisms. I did not read the held-out definitions, and every change below was calibrated on dev only. The held-out set is consumed, so these numbers are dev numbers.

Fixes:

15. **The developer's locator is now evidence.** The recorder keeps the Playwright selector the script used (`target.loc`, with variable values as slots). At replay, the driver probes it read-only on each target wait, and the action itself always goes to a snapshot ref chosen by the ranker. The locator counts only when it resolves to exactly one element. A locator recorded on a value-chosen row without the value in it is ignored, because it named the recorded row.
    - The locator *agrees* when it points at the best-ranked candidate of the recorded kind (role):
      - for a read or edit step, the step may be taken from score ≥ `tauLocator` (0.5), still with the margin μ and the label floor;
      - for a commit step, it may be taken from score ≥ τ (0.65) instead of τc, still with margin μc and the exact recorded label.
    - The locator *disagrees* when it points at a different candidate of the recorded kind. A read step ignores this; an edit or commit step is then not taken at all (`locator_disagrees`).
    - **Can "locator unique + role agrees + margin" satisfy the exact-label rule? No.** Dev opposite-action mutations keep the button's `id` and `data-testid` and change its words: "Withdraw application" takes over `#submit-application`, "Cancel order" takes over `#save-instructions`, and "Remove all access" takes over `#role-confirm`. The developer's locator resolves uniquely to the opposite action, with the same role, and with a clear margin. Ids and test ids survive a change of meaning, so they cannot vouch for meaning; only the words can. The exact-label rule therefore stays. The locator only replaces the τc score requirement, and only when it points at the same control as the fingerprint. A role-and-name locator (`getByRole('button', {name})`) already contains the label. With this rule, a commit is never taken on less evidence than before: the label is the same, the margin is the same, and an independent identity signal stands in for the score shortfall caused by id, class and position churn.
    - One consequence: label-rename and i18n on commit buttons still end `needs_you` without an approver. That is where healwright and plain replay take the click, and in the opposite-action family the same move is the wrong action.
16. **Navigation checks follow a moved page.** A step that changes the address gets a `page` check in place of `url`. The check holds if any one of these is true:
    - the address matches as recorded;
    - the same site shows the page's own top heading (`heading`, recorded only if it is new and free of data digits);
    - the address matches *relative to the page the step started on* (`rel: {up, tail}`). This covers a search on the same page with a new query, opening a record one level down, and a submit that returns one level up.

    A navigate or back step keeps only this check. Other origins never pass. Following links to repair a navigate step was considered and not built: HTTP redirects already land on the moved page, and the heading and relative forms then recognise it. url-path-moved went from 0/12 to 12/12, model-free.
17. **Rows on another page are found without a model.** When a value-chosen step finds no candidate and the recipe has no saved seek, replay looks for the page's own next-page control. That is a `rel="next"` control first, else a link or button whose whole label says next or show more. It must stay on the recipe's sites, must not submit, and must not be disabled or covered. Replay presses it until the row appears, up to 12 times. This uses no model call and no repair; the step's own target and check still decide. A seek proposed by the repair model no longer spends the run's 2 repairs (it is counted separately). A value on no page pages to the end and stops with nothing done (unit test).
18. **Edit-class repairs get a second, independent check before they act.** This applies to a retarget of an edit step and to an inserted fill. Before the action, a separate call is shown only the step, the recorded field (label, name, id, autocomplete, options, neighbours) and the proposed control with the fields beside it. It is not shown the repair model's reasons. It must answer `yes`; `no` and `unsure` end the run `needs_you` with nothing typed. The reason: an edit's own check (the value is in the field) holds for any field, so a wrong field was caught only by a later step, after a commit had already sent the wrong data. Nothing was loosened. On dev this cost no coverage.

### cal6: fixes 15, 17, 18 and the heading form of 16, repair on

| | unmutated | repairable | coverage | must-stop correct | false-heal rate | false done | wrong action | model-free | $/run | s/run |
|---|---|---|---|---|---|---|---|---|---|---|
| recipes (repair) | 100% | 63.6% (98/154) | 62.9% (56/89) | 100% (38/38) | 0% (0/8) | 0% | 0% | 80.4% | 0.00009 | 5.07 |
| recipes, replay only | 100% | 58.4% | 53.9% | 100% | - | 0% | 0% | 100% | 0 | 4.12 |

Family changes from cal5, replay only:

| family | cal5 | cal6 | mechanism |
|---|---|---|---|
| id-class-churn | 15/18 | 18/18 | locator |
| testid-removed | 6/10 | 10/10 | locator |
| column-reorder | 7/10 | 10/10 | locator |
| page-size | 6/12 | 12/12 | model-free paging |
| url-path-moved | 0/12 | 6/12 | heading |

The unmutated rate went from 93.8% to 100%: those were the rows on page 2.

The remaining url-path-moved failures were a search (same page, new query) and opening a record under the moved section, where the heading carries data or did not change. That led to the relative form of fix 16.

### cal7: fix 16 complete (relative paths)

| | unmutated | repairable | coverage | must-stop correct | false-heal rate | false done | wrong action | model-free | $/run | s/run |
|---|---|---|---|---|---|---|---|---|---|---|
| recipes (repair) | **100%** (48/48) | **67.5%** (104/154) | **62.9%** (56/89) | **100%** (38/38) | **0%** (0/8) | **0%** | **0%** | 82.9% | 0.00008 | 4.88 |
| recipes, replay only | 100% | 62.3% | 53.9% | 100% | - | 0% | 0% | 100% | 0 | 4.05 |
| reference replay | 100% | 42.2% | 0% | 36.8% | - | 13.3% | 8.3% | - | 0 | 2.71 |

url-path-moved is now 12/12. The cal7 run spent $0.020, with 74 model calls including the edit checks.

### cal8: tauLocator sweep, replay only

| tauLocator | repairable | coverage |
|---|---|---|
| 0.65 (no locator help for read/edit) | 61% | 52% |
| **0.50** | 62.3% | 53.9% |
| 0.40 | 62% | 54% |

There were no wrong actions or false dones at any value. 0.5 and 0.4 performed the same, so the stricter value was kept: **tauLocator = 0.5**.

### Still failing on dev, by design or open

- **Commit steps that need a person:** label-rename (2/14), i18n (0/10), icon-only (0/6) and lookalike-decoy (2/6). The commit's words changed, and the exact-label rule holds (see fix 15).
- **Interstitials over a commit button (6/18):** a commit step is never repaired without an approver, even by an insert that only clears an overlay. Whether a read-class insert before an unchanged, exactly matched commit control should be allowed is still an open design question. It was not changed in this round.
- **step-split (0/2).**

## Frozen (round 2)

Tuning stopped after cal8. The frozen values are:

| parameter | value |
|---|---|
| τ (read/edit) | 0.65 |
| μ (read/edit) | 0.12 |
| τc (commit) | 0.80, or τ 0.65 when the developer locator agrees |
| μc (commit) | 0.25 |
| tauLocator (read/edit with an agreeing locator) | 0.50 |
| label floor | 0.5 |
| commit label rule | exact recorded label, always |
| repair model | claude-haiku-5-5, thinking disabled |
| edit repair check | second independent call, must answer yes |
| max repairs per run / attempts per step | 2 / 2; model seeks are counted separately |
| seek max presses | 12; model-free next-page detection |
| twins guard | unchanged |

These values are the defaults in `packages/recipes/core/fingerprint.js` and `core/replay.js` at code commit **509dda2**. Only dev mutations were used.

## Round 3, after held-out v2 (run on 907e82a)

Source: the lead's summary in docs/results-heldout-v2.md. I did not look at the v2 definitions. Everything below is calibrated on dev only. The final dev run (cal10) includes the bench author's CRM `formaction` fixture fix (c01fca3), merged as d4fc631.

19. **Per-step check for drift in meaning.**
    - **Recorded:** every edit, commit and extract step now carries `ctx`, the words around its control:
      - page heading and section heading;
      - the dialog it sits in;
      - its column header;
      - its own words (not for extracts);
      - help text (`aria-describedby` / `aria-description`) and tooltip;
      - for an extract, the label next to the value and the value's shape, which keeps its unit or currency and masks the digits.
    - **Data is not meaning:**
      - bound values become slots and digits are masked;
      - text the recording saw as a cell of a row chosen by a value becomes `{~}` and matches any text. That covers the chosen record's own name or invoice number in a heading. Cells equal to a control's label are excluded.
    - **At replay:** code compares the live surroundings field by field. That comparison is a fact: a field differs when its words are not the same and their similarity is below `driftSim` (0.85).
      - Unchanged surroundings: the step runs model-free, as before.
      - Changed surroundings, before acting or reading: one model call (Haiku) sees the user's request, the step, the action, and both sets of surroundings, with the live set inside page markers.
      - Anything but `same` ends the run `needs_you`, with the differences written out in the receipt.
      - With no model configured (replay only), changed surroundings end `needs_you`.
      - A `same` on a run that ends `done_proven` saves the new surroundings, so the next run does not ask again. Fields marked `{~}` keep the mark.
    - **What I learned from cal9** (before record data was marked): the check fired on 50 of 240 runs, and the unmutated success rate fell to 77%. The cause was record pages whose heading is the chosen person's name or invoice number; the model, correctly, would not call that "same". So did the old "text beside it" field for reads, which held other cells of the same record. The fixes were the `{~}` marking, and keeping only the nearest label beside a read value.
20. **Overlays over a control.**
    - **When it applies:** a step's control was found as recorded (it passed every resolver rule, including the commit rules), but the click failed because it is covered, and what covers it is an overlay surface. The page script reports the covering layer and each control's own layer:
      - `dialog`: role dialog or alertdialog, `<dialog>`, or aria-modal;
      - `popover`: the `popover` attribute or role tooltip;
      - `banner`: a `position: fixed` layer.
    - **The only repair allowed** is one inserted step that dismisses that overlay. This applies to commit steps too, with no approver. The inserted step is a click on a control *inside that layer*, or Escape. It must not:
      - submit a form;
      - open another page (an href must stay on the same path and query);
      - be sensitive or disabled.
    - **Privacy preference:** the model is told to prefer declining, rejecting optional choices, closing or postponing over accepting, agreeing or opening anything.
    - **After the dismiss:** the control must match exactly as recorded, either the same element ref or an `exact` resolution, and must be on top. Otherwise the patch fails.
    - **Why this is allowed for commits:** the exact-label rule and "commits are never repaired without a yes" protect against acting on a *different* control. Here the commit control is the recorded one, unchanged and re-proven after the dismiss. The inserted step changes nothing on the site. It acts only inside the layer that was proven to cover the control, and it cannot navigate or submit.
    - **What stays out of reach:** an overlay that only a commit-class control can clear (for example "Accept and continue" submitting a form) still stops.
    - **Result:** interstitial went from 6/18 to 15/18.
21. **Bug fix: "unknown action read".** A retarget of a read step used to send `read` to the browser as an action. It now reads the new control's value after the same meaning check. A unit test asserts that no `read` action reaches the driver.
22. The exact-label rule for commit steps is unchanged.

### cal10: final round 3 dev run (code at d4fc631), repair on

| | unmutated | repairable | coverage | must-stop correct | false-heal rate | false done | wrong action | $/run | s/run |
|---|---|---|---|---|---|---|---|---|---|
| recipes (repair) | **100%** (48/48) | **73%** | **73%** | **100%** (38/38) | **0%** | **0%** | **0%** | 0.00011 | see report |
| recipes, replay only | 100% | 62% | 54% | 100% | - | 0% | 0% | 0 | |
| reference replay | 100% | 42% | 0% | 37% | - | 13% | 8% | 0 | |

**How often the meaning check ran:**
- It fired on **2 of 240 runs (0.8%)** with repair on, and 2 of 240 replay-only. Both were step-split cells, where the page heading "Location and contact" became "Location"; with repair on, both ended stopped.
- On unmutated cells it fired 0 times.
- Its cost is part of the run's $0.026 total. That is 0.8% of runs with one Haiku call each, about $0.0001 per check.

Interstitial is 15/18 (fix 20). Unchanged families: label-rename 2/14, i18n 0/10, icon-only 0/6, lookalike-decoy 2/6, step-split 0/2. In all of these, the commit's words changed and the exact-label rule holds, or the step was split.

### cal11: driftSim sweep, replay only

| driftSim | runs where the check fired | repairable | coverage |
|---|---|---|---|
| 0.70 | 2 of 240 | 62% | 54% |
| 0.85 | 2 of 240 | 62% | 54% |
| 0.95 | 2 of 240 | 62% | 54% |

**dev cannot tell these values apart.** It has no mutation that changes meaning subtly around a control that still matches. The 0.85 starting value is kept. It was not tuned, because there was nothing on dev to tune it against.

### Request to the bench author (via the lead)

Please add **dev** mutations of the "subtle change of meaning" kind, so the check in fix 19 and its `driftSim` can be calibrated on dev, not first measured on held-out. Ideally these are must-stop ones where the control still matches by fingerprint, and repairable ones where only the wording around it changes. For example:
- a new help or warning text on a control that now also deletes, charges or emails someone;
- a column header that changes unit or scope ("Price (incl. VAT)" to "Price (excl. VAT)", "kg" to "lb");
- a dialog title that changes which record or account the dialog applies to;
- a section heading that moves a field into another context (billing address to shipping address), with the same field label;
- an extracted value whose unit or currency changes;
- for contrast, repairable cases where only cosmetic wording around the control changes (a heading reworded, help text rephrased).

## Frozen (round 3)

Tuning stopped after cal11. The frozen values are the round 2 values plus:

| parameter | value |
|---|---|
| driftSim | 0.85 (not calibrated: dev has no examples) |
| meaning check | one Haiku call; anything but `same` ends needs_you; no model ends needs_you |
| overlay dismiss | one insert inside the covering dialog, popover or banner, click or Escape, no submit or navigation; the control must then match exactly |

All other values are unchanged from round 2: τ 0.65, μ 0.12, τc 0.80 (τ with an agreeing locator), μc 0.25, tauLocator 0.50, label floor 0.5, exact label for commits, 2 repairs per run.

Code commit: **d4fc631**. That is a413bce plus the merged fixture fix; the library code is identical.

## Round 3b: calibrating the meaning check on the new dev examples

The bench author added bench/recipes/mutations/dev/meaning-drift.json (merged as c4fdccc). It holds 14 must-stop changes of meaning, in which the control still matches, and 8 cosmetic-only contrasts that must not stop. Dev only throughout.

What changed, with the reason for each:

23. **Notes near the control.** The new must-stop cases are mostly a warning paragraph or a new heading placed *near* the control, not tied to it by ARIA.
    - The page script now reports `notes`: short text with no controls in it, found in the siblings of the control and of its ancestors (up to 7 levels, nearest first, at most 4).
    - **A note is a heading** (h1 to h6, legend, caption) **or prose**: at least 3 words, inline content only.
    - **Not notes:**
      - labels, terms, table header and data cells, and options. They belong to *other* fields or are data. In cal15 they made "Reason" to "Category" and "Reorder level" to "Reason for change" look like drift;
      - a block of data (a list of fields). In cal12 that made "DPD" to "Evri" and other carriers or companies look like drift.
    - A read step's own value, and the cells of its own row, are excluded from its notes.
24. **Downloads are extracts.** A step whose check is a download now carries surroundings too. "Downloading now approves the invoice for payment" was missed in cal12 without this.
25. **This run's record data is marked too.**
    - First attempt (cal13): `{~}` was a wildcard. That let the admin-role case through, 2 wrong actions: a section heading that was the user's name became "Access to the Acme Partners workspace", and the wildcard matched it.
    - Fix: the replay now marks the cells of *the row it chose* in its live surroundings, and the two marked surroundings are compared exactly. A heading that was the record's name must still be this run's record's name.
26. **Prompt.** The meaning check now judges only what changed, gives concrete "same" cases (tips, hints, rewording with the same meaning, formatting) and "different" cases (other record, account, workspace or recipient; scope; unit, currency or scale; a new effect such as approve, sign, charge, delete, email). It says the record's own data may differ between runs. In cal12 it answered "unsure" on a neutral tip ("Stages help you forecast the quarter").
27. Tried and reverted: temperature 0 for the checks. Haiku 5.5 rejects `temperature` (400 error). In cal16 every model call failed, so every repair-on run behaved like replay only. The failed checks ended needs_you, so nothing unsafe happened.

### Runs

| run | change | meaning-drift (must-stop, 28 cells) | cosmetic (16 cells) | unmutated |
|---|---|---|---|---|
| cal12 | notes + downloads, first prompt | 28/28 | 12/16 | 88% (notes held data) |
| cal13 | notes = headings or prose; data prompt | 26/28, **2 wrong actions** | 14/16 | 100% |
| cal14 | this run's record data marked | 28/28, 0 wrong actions | 14/16 | 100% |
| cal15 | full dev | 27/28, 1 wrong action | 14/16 | 100% (required-field-default 5/8: labels as notes) |
| cal17 | field labels not notes (full dev, final) | **28/28, 0 wrong actions** | **14/16** | **100%** |

The 2 cosmetic failures are both dev-account-notify-help. They are not caused by the meaning check, which does not fire there. The inserted paragraph breaks the repeated-item grouping of the preferences list, so the value-chosen checkbox has no candidate. The repair is then refused by the scope gate. This is left alone: loosening the scope gate is out of bounds.

driftSim: across cal12 to cal17, every trigger on the new cases was either an absent-to-present change or a similarity far below 0.85. Every non-trigger was an exact match after masking. So there was nothing to separate by moving the threshold, and **driftSim stays 0.85**. The fields compared were calibrated (fixes 23 to 25); the threshold was not.

### Final dev numbers (cal17, code at 88d87b8)

| | unmutated | repairable | coverage | must-stop correct | false-heal rate | false done | wrong action | model-free | $/run | s/run |
|---|---|---|---|---|---|---|---|---|---|---|
| recipes (repair) | 100% (48/48) | 73.5% (125/170) | 70.8% (63/89) | 100% (66/66) | 0% (0/15) | 0% (0/284) | 0% (0/284) | 65.1% | 0.00013 | 4.78 |
| recipes, replay only | 100% | 55.3% | 53.9% | 100% | - | 0% | 0% | 100% | 0 | 3.71 |
| reference replay | 100% | 47.6% | 0% | 21.2% | - | 21.1% | 13.4% | - | 0 | 2.44 |

**The meaning-drift family:**
- 28/28 correct stops in both modes, with 0 false done and 0 wrong actions; plain replay had 18 wrong actions there.
- Cosmetic contrasts pass 14/16 with repair on, and 0/16 replay only, because with no model a changed surrounding stops the run.

**How often the meaning check ran** (labelled runs cal18u and cal18c, repair on):
- **Unmutated cells: 0 of 48 runs.**
- **Cosmetic cells: 14 of 16 runs.** All 14 answered "same" and finished done. The other 2 are the notify-help scope failure.
- **Over all of dev (cal17): 44 of 284 runs (15.5%).** These are the meaning-drift, cosmetic and a few i18n or step-split cells.
- **Cost:** about $0.00027 per check ($0.0037 for 14 checks). The whole cal17 repair-on run cost $0.036.

## Frozen (round 3b)

Tuning stopped after cal18. Code commit: **88d87b8**. The values are unchanged from round 3 except for the meaning check:

- fields: page heading, section heading, dialog, column, own words, help text, tooltip, label beside a read value, notes (headings or prose near the control), value shape;
- record data marked on both sides; driftSim 0.85;
- one Haiku call with the round 3b prompt; anything but `same` ends needs_you;
- downloads count as extracts.
