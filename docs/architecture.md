# Architecture

Select to AI is a build-free Chrome Manifest V3 extension. Its trust boundaries are deliberately small: extension pages initiate actions, the background service worker validates privileged requests, and content scripts interact with explicitly granted sites.

## Components

| Component | Responsibility | Trust level |
| --- | --- | --- |
| Popup and options | User configuration and selected-text workflow | Trusted extension page |
| Agent page (side panel) | A view of the run: shows the journal, takes the user's answers, approvals and edits | Trusted extension page |
| Engine (`extension/engine.js`, `extension/core/`) | The run as a state machine in the service worker: observes the page, asks the model, applies the safety policy, acts, hands over to the user and resumes, learns | Privileged boundary |
| Background worker | Context menus, tab coordination, screenshots, provider proxy, hosts the engine | Privileged boundary |
| Provider policy | Exact-origin URL and request validation | Security-critical, unit tested |
| Content scripts | Read visible page structure and execute typed actions | Untrusted page boundary |
| Chrome storage | Sync preferences; local credentials and task memory | Browser profile |

## One engine, one way in

There is one agent: the engine in the service worker. Every way of asking starts it, and the agent decides for itself whether a request is a question about the page, a site to open, or a task to carry out.

| Way in | What it does |
| --- | --- |
| The agent page or side panel (Alt+A, Control+Shift+G on macOS) | The composer sends the request to the engine |
| The quick box (Control+Shift+Q on macOS, Alt+K elsewhere, `extension/commandPalette.js`) | Enter starts the agent on the request, with any text selected on the page, in the tab it was opened on |
| Right-click, "Ask the agent about this" | Opens the agent on that tab |

With the agent switched off, each of these opens the setup page. The right-click "Send to ChatGPT, Claude, Gemini or Perplexity" items are separate: they paste the selection into that assistant's own site (`extension/contentScript.js`) and involve no model call of the extension's.

## Request lifecycle

1. The engine (`extension/core/llm.js`) chooses the configured provider and builds the provider-specific payload.
2. `extension/security.js` checks the exact destination origin, HTTP method, request-body type, and size.
3. The service worker sends the request with ambient credentials omitted and streams the result into the run.
4. The settings page's connection tests go through a unary proxy message, which first verifies that the caller is an extension page.

This design prevents a compromised content script (or an injected message containing a look-alike URL) from using API credentials as an arbitrary exfiltration primitive.

## Browser automation lifecycle

1. The user starts a task from any way in above. The run lives in the service worker and is saved to `chrome.storage.session` after every transition, so closing the panel or putting the worker to sleep does not lose it.
2. Chrome grants the active tab temporarily, or the agent shows an explicit per-origin permission card.
3. The content script lists every control on the page (and in a frame drawn on top of it), with what is new since the last step and what is on top; `extension/core/observe.js` fits the listing to the model's budget by structure, never by guessing what the task needs.
4. The model calls one tool, `step`: its notes, the goal of the step, and one action with what it needs (more actions can follow in `then`). An action is one thing a person would do: press this, put this value there, go here, read that.
5. `extension/core/policy.js` decides, deterministically, whether the action runs, is confirmed by the user, is handed to the user (sign-in, human check, code, the button that pays), or is refused. Passwords, card numbers and codes are never typed by the agent.
6. The action runs; its result states what the page did (what appeared, by number; what was chosen; what changed), and the next step begins. Facts the browser measured (repeats, failures, the date, what is on top of the page, a tab in the background) are stated to the model; nothing in them is an order.
7. `done` carries the answer with quotes; the quotes are checked in code against everything the model was shown, and a multi-step answer is checked by a second model call in a fresh context. The check's opinion is shown under the answer, never written into it.
8. A run that stops for the user (a check, a sign-in) shows a card in the panel, a banner on the page and a badge; it notifies only when the user is away, reminds once after two minutes, watches the page for the blocker to clear, and resumes the same run.

## Storage model

`CONFIG.STORAGE.SETTINGS` contains only non-sensitive preferences and is read from `chrome.storage.sync`. `CONFIG.STORAGE.API_KEYS` is read from `chrome.storage.local`. A migration path copies any legacy synced keys locally, then removes the synced values. Settings exports intentionally omit keys.

What the agent knows about the user (`extension/core/memory.js`: profile details keyed by HTML autocomplete tokens, preferences, site notes, lessons, routines) is one record in `chrome.storage.local` under `agentKnown`, encrypted with AES-GCM under a non-extractable key kept in IndexedDB. Only the user can put a detail or a preference there; a page cannot. A run in progress is in `chrome.storage.session`.

## Deliberate constraints

- No remote JavaScript or build-time code generation.
- No first-party analytics backend.
- No arbitrary background fetch destinations.
- No permanent all-sites permission by default.
- No silent approval of high-risk actions by default.
