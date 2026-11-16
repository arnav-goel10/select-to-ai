# Decisions for the 4.0 release

One line per decision, with the date it was made. An open item stays open until the owner answers it here.

| # | Question | Answer | Status | Date |
|---|---|---|---|---|
| 1 | Does 4.0 ship with the `debugger` permission? | No. It is dropped for 4.0, so the update from 2.0 installs without a new permission prompt. This reverses the 10 Nov 2026 recommendation. See [debugger-permission.md](../debugger-permission.md). | Decided | 16 Nov 2026 |
| 2 | Is the version 4.0.0 or 4.0.1? | 4.0.0, unless the owner says the 10 Nov 2026 zip was uploaded to the store dashboard. If it was, the next upload must be 4.0.1, because the store refuses a version it has already seen. | 4.0.0 unless the owner says otherwise | 16 Nov 2026 |
| 3 | Do Recipes go public (engine package, benchmark, calibration log and held-out results, all already on main)? | Awaiting owner. Making the repository public cannot be undone. If the answer is no, main's history has to be replaced, or a fresh repository used, before the flip. | Awaiting owner | |

## How to record an answer

Change the Answer, Status and Date cells in the same commit that acts on the answer. Do not delete a row. If a decision changes later, add a new row that says which row it replaces.
