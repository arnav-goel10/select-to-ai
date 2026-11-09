# Held-out v1: first honest result (7 Nov 2026)

**Setup:**
- Engine frozen at 1af5706, run on c52143d, which merges in the bench author's healwright adapter fix.
- The held-out set was written by a separate author and lives outside the repo. The engine implementer never read it, and no tuning happened after the run. The set is now consumed: later engine changes are measured on held-out v2.
- 8 fixture apps, 24 tasks, 44 held-out mutations, 210 cells per system.
- Success is judged only by server-side truth.

| System | Repair coverage (breaking cells) | False heals (of heals) | Correct stop (must-stop) | False "done" | Wrong action | Repairable success | $/run |
|---|---|---|---|---|---|---|---|
| **Recipes (repair on Haiku 5.5)** | **53.1%** [43–63] | **0/23** | **92.3%** | **0.5%** | **1.0%** | 53.7% | $0.0002 |
| Recipes, replay only | 35.4% | n/a | 96.2% | 0.5% | 0.5% | 37.5% | 0 |
| healwright (default) | 41.7% | 20.6% (13/63) | 15.4% | 11.0% | 8.6% | 58.8% | $0.0004 |
| healwright (minConfidence 0.8) | 28.1% | 0% | 61.5% | 5.7% | 5.7% | 49.3% | $0.0003 |
| Plain replay (fixed selectors) | 0% | n/a | 46.2% | 7.6% | 6.7% | 29.4% | 0 |

**How to read it:**
- At zero false heals, Recipes repairs about 1.9× what healwright's safe setting does.
- Healwright at its defaults heals into the wrong element about 1 time in 5. On dev it clicked "Discard" when "Save draft" was removed, and downloaded the full history when "Export CSV" was removed.
- **Where we lose:** raw repairable success (53.7% vs 58.8%). The causes:
  - Commit steps whose target is plainly still there stop as needs_you, below the commit threshold.
  - URL postconditions are too strict on redirects.
  - Rows chosen by a variable on another page use up the repair budget.
  - A wrong edit repair happened before the tail check caught it (2 wrong actions in one must-stop family).

  These are being fixed on dev only and will be re-measured on held-out v2.

**Caveat added 7 Nov:** this run used the CRM fixture before bench fix c01fca3. Its client script ignored `formaction`, so every submit button there acted as "Add note". CRM cells in this run may score differently on the fixed app. The run is not repeated, because the set is consumed.
