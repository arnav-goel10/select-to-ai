# Decisions for the 4.0 release

One line per decision, with the date it was made. An open item stays open until the owner answers it here.

| # | Question | Answer | Status | Date |
|---|---|---|---|---|
| 1 | Does 4.0 ship with the `debugger` permission? | No. It is dropped for 4.0, so the update from 2.0 installs without a new permission prompt. This reverses the 10 Nov 2026 recommendation. See [debugger-permission.md](../debugger-permission.md). | Decided. The owner left the call to the release plan on 16 Nov 2026. To be looked at again once the real-task trial has compared both builds. | 16 Nov 2026 |
| 2 | Is the version 4.0.0 or 4.0.1? | 4.0.0. The owner confirmed on 16 Nov 2026 that nothing has been uploaded to the store dashboard since 2.0. | Decided | 16 Nov 2026 |
| 3 | Do Recipes go public (engine package, benchmark, calibration log and held-out results, all already on main)? | Yes. The owner left the call to the release plan on 16 Nov 2026. The visibility change itself stays the owner's click. | Decided | 16 Nov 2026 |

## How to record an answer

Change the Answer, Status and Date cells in the same commit that acts on the answer. Do not delete a row. If a decision changes later, add a new row that says which row it replaces.
