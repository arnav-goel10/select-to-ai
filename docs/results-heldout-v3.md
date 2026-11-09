# Held-out v3 (7 Nov 2026): one shot, engine frozen at 88d87b8, run on the merge with recipes-bench (no package changes)

v3 was written by the independent author after v2 was used up. It has 42 mutations in 21 families, 7 of them new.

- **15 must-stop mutations.** In 13 of them the meaning changed while the developer's selector still points at the control, often with the same label.
- **8 cosmetic-only mutations.** These must NOT stop the run.
- **All 27 repairable mutations are verified.** Each was either solved by an oracle script or already passes on plain replay.
- **192 cells per system.** Success is judged only by server truth.

| System | Success, repairable | Repair coverage | Correct stop | False "done" | Wrong action | False heals | $/run | s/run |
|---|---|---|---|---|---|---|---|---|
| **Recipes (repair on Haiku 5.5)** | **77.2%** [69–84] | **55.6%** [42–68] | **100%** (30/30) | **0%** (0/192) | **0%** (0/192) | **0/20** | $0.00014 | 4.7 |
| Recipes, replay only | 36.8% | 14.8% | 100% | 0% | 0% | n/a | 0 | 3.4 |
| healwright (default) | 70.2% | 37.0% | 6.7% | 18.8% | 13.5% | 0/25 | $0.00014 | 2.5 |
| healwright (minConfidence 0.8) | 62.3% | 20.4% | 6.7% | 18.8% | 13.5% | 0/18 | $0.00011 | 2.2 |
| Plain replay (fixed selectors) | 52.6% | 0% | 6.7% | 18.8% | 13.5% | n/a | 0 | 2.1 |

**What this says:**

- **Ours stopped every time the meaning changed (30/30).** A selector-healing tool and plain replay both acted anyway in 28 of 30 must-stop cells. The two cells they got right are from a family where every system stops. Those actions were wrong changes (13.5% of all runs) and stale answers reported as done (18.8%).
- **The per-step meaning check fired only when a step's surroundings changed.**
  - It never fired on unmutated pages: 100% model-free there.
  - On cosmetic changes it answered "same", so all 46 cosmetic cells passed.
- **Replay without the model correctly refuses every changed surrounding.** That is why its coverage is low: the model is what turns "something changed" into "still the same meaning".

**Progress over the three held-out sets.** Each set was run once, then retired.

| | v1 | v2 | v3 |
|---|---|---|---|
| Our coverage / healwright default | 53% / 42% | 51% / 50% | 56% / 37% |
| Our false "done" / healwright | 0.5% / 11% | 7.1% / 18.8% | 0% / 18.8% |
| Our wrong action / healwright | 1.0% / 8.6% | 3.5% / 10.6% | 0% / 13.5% |
| Our correct stop / healwright | 92% / 15% | 54% / 15% | 100% / 7% |

**Weak points:**

- These are fixture apps written by our own (separate) benchmark author, not real sites. The next proof has to be real portals and real users.
- Commit buttons whose wording changed still stop for the user's approval, by design.
- There are 54 breaking cells, so the coverage interval is wide (42–68%).
- Repair runs on Haiku 5.5 only. Other models are untested.
