# Select to AI

[![CI](https://github.com/arnav-goel10/select-to-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/arnav-goel10/select-to-ai/actions/workflows/ci.yml)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A privacy-first Chrome extension for moving selected text into ChatGPT, Gemini, Claude, or Perplexity, and for running bounded browser-agent workflows with your own model provider.

![Select to AI context-menu action for sending selected text to ChatGPT](assets/select-to-ai-overview.png)

The published extension has served approximately 1,000 users. The count is intentionally approximate because it changes over time.

This repository contains the next-generation agent and security architecture.

## Why it is different

- **One gesture to any assistant:** send selected text from the context menu to a side panel or new tab.
- **Provider-agnostic agent:** use OpenAI, Anthropic, OpenRouter, Gemini, DeepSeek, Mistral, Groq, Together, xAI, OpenCode, or an HTTPS/local custom gateway.
- **Human control:** a spending limit, a site allowlist and regular check-ins bound autonomous runs; sensitive actions require confirmation.
- **Local-first credentials:** API keys stay in `chrome.storage.local`, are removed from legacy sync storage, and are excluded from exports.
- **Least-privilege browsing:** websites are optional permissions. Allow the agent on all sites once, or one site at a time.
- **Tested request boundary:** every model request is restricted to a known provider or the exact configured custom-gateway origin.

## Quick start

Requirements: Chrome 114+ and Node.js 20+ for development checks.

1. Clone the repository.
2. Run `npm ci && npm run check`.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Choose **Load unpacked** and select the repository's `extension/` directory.
5. The welcome page opens. Click **Continue with OpenRouter (free)** or paste an API key to turn on the agent.

No build step is required. The checked-in JavaScript is the extension source Chrome loads.

## Core workflows

### Send selected text

Select text on a webpage, right-click, choose **Select to AI**, then select an enabled assistant. The extension can open the assistant in a tab or its Chrome side panel and optionally submit the prompt. For new ChatGPT and Perplexity conversations with auto-send on, the prompt travels as a URL parameter, no DOM automation involved. Other inserts use per-provider selector chains that verify the send actually happened; if no selector matches, your text is copied to the clipboard and a toast tells you so, instead of the extension clicking a guessed button.

### Use the popup

The toolbar popup is a task box for the agent (with one-tap ideas: summarize, cheapest option, compare my tabs), plus **Chat in the side panel**, **Open the agent in a tab** and **Quick box**, each with its shortcut. Every preference lives in **Settings**, one page with four sections. Settings save only what you change, so improved defaults reach everyone who has not chosen otherwise.

### Run the browser agent

Open the **agent** (`Alt+A`, or `Control+Shift+G` on macOS, the popup button, the side panel dropdown, the address bar or the quick box), say what you want, and watch it work. There is one agent and one way it runs, whatever you ask: it decides for itself whether the request is a question about the page, a site to open, or a task to carry out.

1. **See the page:** every control on the page is listed for the model with what is new since the last step, inside a budget fitted by the page's structure.
2. **Act like a person:** each step is one `step` tool call with the agent's notes, the goal of the step and the actions to take (press, fill, go to, read); real keys and a real pointer do them, and the result says what the page did.
3. **Stay safe:** a fixed policy in code decides whether each action runs, waits for your approval, is handed to you (a sign-in, a human check, a code, the button that pays) or is refused. Passwords, card numbers and codes are never typed by the agent.
4. **Check the answer:** the answer's quotes are checked against what the agent was shown, and a multi-step answer gets a second look by a fresh model call. Its opinion is shown under the answer.

The run lives in the service worker, so closing the side panel loses nothing; reopen it and the run is still there. It asks you when it needs you (a sign-in, a human check, a choice only you can make) and carries on once that is done, and it says plainly what it could not do instead of making a result up. While a run works you can send it a message that it reads before its next step, save the run's steps as Markdown, and stop it at any time.

New installs open a short welcome page. Highlight-to-ask works straight away; to turn the agent on, click **Continue with OpenRouter (free)** (sign in, and a key is created for you) or paste any provider key, which is recognised from its prefix and tested before it is saved. The default model is OpenRouter's free router (`openrouter/free`), so the agent works without a card. The first time the agent needs a website, choose **Allow on all sites** (one prompt, ever) or **Only this site**. Keep **Ask before purchases, payments and deletions** on.

### Type in the address bar

Type `ai` then a space in Chrome's address bar, say what you want, and press Enter. The agent opens in the side panel and starts on it: no page needs to be open and no site needs to be named. Started on the new-tab page it works in that tab; started on a page it cannot use (browser settings, the Web Store, a PDF) it leaves that page alone and works in a new tab. Alt+Enter runs it in a new tab. The suggestions show your recent tasks that match what you type.

The quick box (`Control+Shift+Q` on macOS, `Alt+K` elsewhere) does the same from any page, without the address bar: what you type, with any text you had selected, starts the agent on that tab. With the agent turned off, both open the setup page. Agent tasks still stop at the risk-confirmation gate before any consequential action.

### Use a custom gateway

In Settings, under Browser agent, choose **Change**, then **Your own server (OpenAI-compatible)** and enter its address. Remote gateways must use HTTPS; HTTP is accepted only on `localhost` or `127.0.0.1`. Requests are origin-bound to the configured gateway.

## Architecture

```mermaid
flowchart LR
  UI["Popup / side panel / agent"] --> SW["MV3 service worker"]
  SW --> Policy["Outbound request policy"]
  Policy --> Providers["Approved AI provider APIs"]
  UI --> Permissions["Per-origin permission prompt"]
  Permissions --> CS["DOM action content script"]
  Sync["chrome.storage.sync\nnon-sensitive preferences"] --> UI
  Local["chrome.storage.local\nAPI keys + local history"] --> UI
```

See [Architecture](docs/architecture.md) and [Security model](docs/security.md) for boundaries and design decisions.

## How it is tested

```bash
npm run check          # syntax, unit tests, security benchmark, page-reader and end-to-end checks (CI-required)
npm test               # Node test runner
npm run benchmark      # deterministic outbound-policy evaluation
npm run test:v4        # the agent's scripted end-to-end scenarios (also run by check)
```

The benchmark covers approved endpoints, look-alike domains, exfiltration targets, unsafe schemes, local gateways, and origin mismatches. CI runs the same clean-install command on every pull request.

`npm run test:v4` is the end-to-end receipt: it launches Chromium with the unpacked extension, points the agent at a scripted OpenAI-compatible gateway on `127.0.0.1` (`tests/e2e/server.js`, the same loopback path a real local gateway uses), and drives every scenario through the real engine: the run in the service worker, the page actions, the safety policy, the waits for the user, and the panel as a view. The harness plays the user where a scenario needs one: it approves or declines, signs in on the page, answers a question, closes the panel and opens it again. `E2E_ONLY=signin,form` runs a subset; `E2E_HEADFUL=1` shows the browser. The manual **E2E agent harness** GitHub workflow runs it in a visible browser.

### Decision eval

The e2e harness proves the pipeline works; the decision eval measures whether the agent picks the right next step. `tests/decisions/cases.js` holds 25 situations (a blank tab, a search box, a cookie banner, a login wall, a CAPTCHA, a form with a dropdown, a step that just failed, "compare these two tabs", selected text, and more). `npm run eval:capture` reads each page with the extension's real page reader in headless Chromium and saves what the agent would see; `npm run eval:decisions` then puts each case to a model the way the engine does (its instructions, its `step` tool, its checks) and scores the step it chooses. No browser, a couple of minutes per run.

```bash
DECISION_API_KEY=sk-or-... DECISION_REPEAT=2 npm run eval:decisions
```

| Variable | Effect |
| --- | --- |
| `DECISION_BASE_URL`, `DECISION_MODEL` | Any OpenAI-compatible provider and model (default OpenRouter, `openrouter/free`). |
| `DECISION_ONLY=safety,form` | Run some cases or categories. |
| `DECISION_INSTRUCTIONS_FILE=variant.txt` | A/B rewritten instructions against the built-in ones on the same cases. |
| `DECISION_REPORT=report.json` | Write every decision as JSON. |
| `DECISION_DRY=1` | No model: check each case's answer actually reaches the prompt. |

### Page-reader check

`npm run eval:reading-wild` checks the page reader on 46 real pages it was never tuned on (tests/reading/wild-sites.js), with Mozilla Readability as the judge of what each page's content is and no model: content kept, share of on-topic text, whether in-page search finds sentences picked at random positions, and the size of the element list. `WILD_OLD=<git ref>` compares with an older reader.

## Permissions

| Permission | Purpose |
| --- | --- |
| `contextMenus` | Add the selected-text workflow. |
| `storage` | Store preferences, local credentials, and local task memory. |
| `sidePanel` | Render the chosen assistant or browser agent beside the page. |
| `tabs`, `activeTab`, `scripting` | Inspect and operate the user-selected tab. |
| `notifications` | Notify when an agent run completes or fails. |
| `declarativeNetRequest` | Allow the supported assistant sites to render inside the side panel. The rule covers only those domains and only the side panel, never ordinary tabs. |
| Provider host access | Call only the documented model-provider endpoints. |
| Optional website access | Granted per origin by the user when browser automation needs it. |

## Repository guide

- `extension/`: the complete build-free Manifest V3 package loaded by Chrome.
- `tests/unit/`: dependency-free policy and storage regression tests.
- `tests/benchmark/`: deterministic adversarial request-policy evaluation.
- `tests/e2e/`: the puppeteer harnesses (scripted gateway, fixture pages, the agent's end-to-end scenarios, page-reader and widget checks).
- `scripts/`: repository validation tooling.
- `docs/`: architecture and security design documentation.
- [`docs/provenance.md`](docs/provenance.md): project origin, attribution, and Arnav Goel's contribution.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public issue.

## Privacy and license

Read the plain-language [Privacy Policy](PRIVACY_POLICY.md). Select to AI is available under the [MIT License](LICENSE).
