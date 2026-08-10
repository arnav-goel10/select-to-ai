# Changelog

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
