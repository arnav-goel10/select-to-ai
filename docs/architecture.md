# Architecture

Select to AI is a build-free Chrome Manifest V3 extension. Its trust boundaries are deliberately small: extension pages initiate actions, the background service worker validates privileged requests, and content scripts interact with explicitly granted sites.

## Components

| Component | Responsibility | Trust level |
| --- | --- | --- |
| Popup and options | User configuration and selected-text workflow | Trusted extension page |
| Agent page | Planning, safety UI, budgets, and execution state | Trusted extension page |
| Background worker | Context menus, tab coordination, screenshots, provider proxy | Privileged boundary |
| Provider policy | Exact-origin URL and request validation | Security-critical, unit tested |
| Content scripts | Read visible page structure and execute typed actions | Untrusted page boundary |
| Chrome storage | Sync preferences; local credentials and task memory | Browser profile |

## Request lifecycle

1. The agent chooses a configured provider and constructs the provider-specific payload.
2. The agent opens a named extension port for streaming, or sends a unary proxy message.
3. The service worker verifies that the caller is an extension page.
4. `extension/security.js` checks the exact destination origin, HTTP method, request-body type, and size.
5. The service worker sends the request with ambient credentials omitted and streams the result back.

This design prevents a compromised content script (or an injected message containing a look-alike URL) from using API credentials as an arbitrary exfiltration primitive.

## Browser automation lifecycle

1. The user starts a task from the agent UI.
2. Chrome grants the active tab temporarily, or the agent shows an explicit per-origin permission card.
3. The content script returns a bounded list of actionable elements.
4. The model emits one structured action.
5. Domain, loop, failure, cost, and high-risk checks run before execution.
6. The action result is logged and the next bounded step begins.

## Storage model

`CONFIG.STORAGE.SETTINGS` contains only non-sensitive preferences and is read from `chrome.storage.sync`. `CONFIG.STORAGE.API_KEYS` is read from `chrome.storage.local`. A migration path copies any legacy synced keys locally, then removes the synced values. Settings exports intentionally omit keys.

## Deliberate constraints

- No remote JavaScript or build-time code generation.
- No first-party analytics backend.
- No arbitrary background fetch destinations.
- No permanent all-sites permission by default.
- No silent approval of high-risk actions by default.
