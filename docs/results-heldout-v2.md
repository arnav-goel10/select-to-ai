# Held-out v2 (7 Nov 2026): one shot, frozen at 509dda2, run on 907e82a

v2 was written by the independent author after v1 was used up. It has 42 mutations in 23 families, 7 of them new, and 8 subtle changes of meaning. 26 of its 29 repairable mutations are proven solvable by oracle scripts. There are 170 cells per system. Success is judged by the server's own truth, never by what a system reports.

| System | Repair coverage | False heals (of heals) | Correct stop | False "done" | Wrong action | Repairable success | $/run |
|---|---|---|---|---|---|---|---|
| **Recipes (repair on)** | **51.4%** [40–62] | **0/3** | 53.8% | **7.1%** | **3.5%** | 50.0% | $0.0001 |
| Recipes, replay only | 45.9% | n/a | 53.8% | 7.1% | 3.5% | 45.8% | 0 |
| healwright (default) | 50.0% | 14.0% (6/43) | 15.4% | 18.8% | 10.6% | 61.5% | $0.0003 |
| healwright (minConfidence 0.8) | 29.7% | 6.7% | 30.8% | 16.5% | 9.4% | 45.8% | $0.0002 |
| Plain replay | 0% | n/a | 38.5% | 16.5% | 8.2% | 22.9% | 0 |

**What this says:**

1. **On safety, we lead everywhere.**
   - False "done" is 7.1% against healwright's 18.8%.
   - Wrong actions are 3.5% against 10.6%.
   - False heals are 0 against 14%.
2. **Repair coverage ties healwright's default** (51% against 50%). Its safe setting reaches only 30%.
3. **The safety rates are no longer zero.** All 12 false "done" runs and all 6 wrong actions sit in three must-stop families where the meaning changed subtly.
   - Our **model-free replay** found a control that still matched, acted on it, and claimed done.
   - The postconditions didn't catch the change in meaning.
   - This is the central risk of replaying without a model: code can tell that a step's surroundings changed, but it can't tell what that change means.
4. **Where we lose coverage:**
   - Commit buttons whose label changed stop as needs_you. This is by design, because of the exact-label rule.
   - An overlay over a control can't be dismissed by repair.
   - A repair of a read step failed with "unknown action read", which is a bug.

**Next mechanism (round 3):**
- **Per-step drift detection.** Code compares the text around each step (heading, dialog, column header, nearby labels, the control's own description) with what was recorded. When it differs on an edit, commit or extract step, a cheap model is asked whether the step still means the same thing, before acting. When it doesn't differ, the run stays model-free.
- **Overlays.** An inserted dismiss step is allowed when an overlay covers the target, with the privacy-preserving choice taken.
- Fix the read-repair bug.

Measured next on held-out v3.

**Caveat added 7 Nov:** this run used the CRM fixture before bench fix c01fca3. Its client script ignored `formaction`, so every submit button there acted as "Add note". CRM cells in this run may score differently on the fixed app. The run is not repeated, because the set is consumed.
