# Documentation

- [Architecture](architecture.md): trust boundaries, request lifecycle, automation lifecycle, and storage model.
- [Security model](security.md): protected assets, threat controls, residual risks, and verification.
- [Privacy policy](../PRIVACY_POLICY.md): user-facing data handling and retention behavior.
- [Privacy disclosure](privacy-disclosure.md): every request and stored item in 4.0.0, read from the code.
- [Debugger permission](debugger-permission.md): why 4.0 ships without `debugger`, and what the end-to-end scenarios show it costs.

## Results

- [Held-out v3](results-heldout-v3.md): the latest recipe replay benchmark, with the comparison against healwright and plain replay.
- [Held-out v2](results-heldout-v2.md) and [held-out v1](results-heldout-v1.md): the two earlier held-out sets, each run once.
- [Recipes calibration](recipes-calibration.md): tuning on the dev mutations only, before any held-out run.
- [Agent v4 status](agent-v4-status.md): the engine measurements behind 4.0.
- [Real-task trial](real-task-trial.md): 93 everyday tasks on live sites in the packed build, run in GitHub Actions. How to run it and read it.

The distributable browser-extension package is isolated in `extension/`; repository tooling and documentation are never required at runtime.
