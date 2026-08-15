# Changelog

## 3.2.0 - 2026-08-15

### Added

- Address-bar entry point: type `ai` plus a space, and an intent router decides between opening a site, asking the assistant, or handing the task to the browser agent. Live suggestions show the routing before Enter, and `ask` / `do` / `open` prefixes override it.
- `extension/intentRouter.js`, a dependency-free classifier shared with the test suite, with URL normalization that rejects non-http(s) schemes and credentialed URLs.
- Omnibox agent handoff: `agent.html?task=...&autostart=1` pre-fills and starts planning; the risk-confirmation gate still applies to consequential actions.

## 3.1.0 - 2026-08-06

### Security

- Store provider keys locally, migrate legacy synced credentials, and exclude secrets from backups.
- Restrict background requests to known providers or the exact custom-gateway origin.
- Validate privileged message senders, methods, and payload size.
- Replace permanent all-sites access with per-origin optional permissions.
- Remove remote font dependencies from extension pages.

### Engineering

- Add dependency-free unit tests, a deterministic adversarial benchmark, syntax checks, and GitHub Actions CI.
- Add architecture, threat-model, contribution, privacy, and vulnerability-reporting documentation.
