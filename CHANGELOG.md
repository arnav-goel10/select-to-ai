# Changelog

## 4.0.0 - 2026-08-24

### Added

- Playbook gallery: six bundled, versioned task templates (competitor price scan, page fact extractor, job application tracker, recipe shopper, news briefing, flight options scan) with one-click run from Options and JSON import for sharing your own. Playbooks with a blank use an explicit {input} placeholder the user fills; empty input never silently drops the blank.
- Edge Add-ons target: per-browser packaging (`npm run package -- --all` emits chrome + edge zips), a compatibility checker module (`browserTargets.js`), and a publishing runbook (`docs/publishing.md`). The same MV3 source now ships to both stores.
- i18n scaffold: `default_locale` + `_locales/{en,de,zh_CN}` catalogs for all user-facing manifest strings, a fallback-safe `i18n.js` helper, and tests that keep every locale's key set in lockstep with en.
- Local agent benchmark: `npm run bench:agent` runs the real pipeline (planner, executor, validator) against localhost fixtures only and writes `dist/benchmark-report.md` plus machine-readable results — honest numbers anyone can reproduce without API keys or network access.

### Changed

- README reflects the two-store reality, hosted mode, routines, artifacts, and the benchmark; store listing copy updated in the same release.

137 unit tests, security benchmark 10/10, e2e 4 of 4, benchmark 12/12 checks.

## 3.5.0 - 2026-08-24

### Added

- Side panel companion: quick-action chips (Summarize page, Key points, Extract data, Draft reply) read the current tab and hand a grounded, size-capped prompt straight to the agent; the agent view consumes pending hand-off tasks automatically on load.
- Artifacts: final answers containing markdown tables or JSON arrays now offer one-click CSV downloads (correct quoting, union headers for object rows), rendered as safe buttons under the answer.
- Memory profile: durable, user-editable facts ("Based in Singapore", "Always cite sources") stored locally, managed from Options with add/remove UI, and injected into every planning prompt with an explicit user-editable disclosure. Capped at 50 facts of 300 characters.
- Routines: schedule a saved task daily or weekly via chrome.alarms. When one fires, the agent opens with the task queued through the same companion hand-off; every safety gate still applies. Alarms re-derive their true next occurrence after each run and only fire while Chrome is running.
- Cross-tab agent guidance: the capability prompt now teaches the executor that its scan/screenshot/action context follows open_tab and switch_tab, enabling real multi-site tasks (compare across two sites) using remember notes between switches.

130 unit tests (up from 107), security benchmark 10/10, e2e 4 of 4.

## 3.4.0 - 2026-08-24

### Added

- Hosted free mode: a new "Hosted (free)" provider lets anyone run the full browser agent without creating provider accounts or touching an API key. Requests relay through the bundled zero-dependency server (`relay/server.js`, `node relay/server.js` and you are done); the upstream credential lives only on that server, which enforces per-IP rate limits, a body-size cap, an optional model allowlist, and stores nothing. Bring-your-own-key providers remain exactly as local as before.
- Contextual suggested first tasks: the agent welcome screen now derives its three suggestion cards from the page you are actually on (GitHub repos get repo tasks, shopping pages get comparison tasks, unknown sites get universal ones), computed locally with no network calls, so a first run is one click instead of a blank prompt.

### Changed

- The agent runtime began its module split with zero behavior change: provider/model policy moved to `providerModels.js` (compatibility checks, tier resolution, key-shape validation) and payload building to `providerPayload.js` (system-content shapes, prompt-caching splits, error cleanup). Both are unit-tested directly; `agent.js` shrank by ~140 lines of logic now exercised by 20 new focused tests.

### Fixed

- The store listing no longer describes v2.0: release copy now ships in the same PR as the release (`docs/store-listing.md`), starting with this one.

107 unit tests (up from 87), security benchmark 10/10, e2e 4 of 4.

## 3.3.1 - 2026-08-16

### Fixed

- Starting an agent task from a blank tab or another protected browser page no longer aborts: the agent is told the page cannot be read and simply navigates to the site the task needs.

### Improved

- Address-bar routing: the built-in site list nearly tripled, "site + country code" inputs like `amazon sg` open the right storefront directly, and an optional smart-routing assist (on by default when a key is configured) refines the suggestion with a small model call while you type - Enter never waits on the network, and model-suggested URLs pass the same https-only checks as typed ones.

## 3.3.0 - 2026-08-15

A quality overhaul of the browser agent and every surface around it.

### The agent got honest and got better

- The agent now really plans, acts, reflects, and validates: a planner fills a live checklist with subtasks and observable "done when" conditions, the executor performs one provider-native tool call per step, two consecutive failures trigger a reflection step that changes strategy instead of retrying blindly, and a validator must confirm the final answer against on-page evidence before the run counts as done.
- Every action is judged by what actually changed on the page (URL, DOM mutations, element counts) instead of assuming success. Element ids stay stable while you remain on a page.
- Honest exits: the agent asks you when it hits logins, CAPTCHAs, payments, or ambiguity, and gives up with a reason instead of inventing an answer. Only validated runs are stored in memory.
- Stop now really stops: retries, confirmation dialogs, and in-flight typing all cancel; closing the target tab aborts the run instead of silently switching tabs.
- Steer while it runs: queue one guidance message and it is delivered to the agent before its next step, no need to stop and restart.
- Legible runs: per-step reasoning sits in collapsed expanders, final answers render clean formatting (bold, lists, safe links), the run log exports as Markdown and the full session as JSON, timestamps are readable, and the cost badge shows a clear "est." total with the exact figure on hover.
- The agent header shows the actual provider and model in use; the decorative mode dropdown is gone. The sidebar now lists your validated recent sessions and lets you view or clear the scratchpad notes and stored task memory.

### Getting started is guided

- New installs open a four-step onboarding wizard: what the extension does, connect a provider, verify the key with a one-token test, then enable the agent (it stays off until you do). Re-run it anytime from Options.
- One master switch ("Enable AI Browser Agent") now controls every agent entry point consistently: popup, Alt+A, address bar, side panel, and context menu.

### One design system

- All four surfaces (popup, options, side panel, agent) share one palette, one accent, one font stack, and one light/dark theme that follows your stored preference with a system fallback, including a real light mode for the agent page.
- Keyboard accessibility across the board: visible focus rings, focusable tooltips, real labels on the theme toggles and side panel selector, and reduced-motion support on every page.
- The popup is now a simple launcher (sidebar, agent, settings, opening mode); service shortcuts and behavior defaults live only in Options.

### Sending text to assistants is sturdier

- New ChatGPT and Perplexity conversations receive your prompt via the URL itself, no fragile DOM automation.
- Other inserts use per-provider selector chains that prefer stable attributes, verify the message was actually sent, and never click a guessed button; if nothing matches, your text is copied to the clipboard and a toast says so.
- Address-bar questions honor your Auto-submit preference (on by default for that flow, documented on the option).

### Options page repairs

- Fetching models fills a suggestion list without overwriting your chosen model; only the active provider's key field is shown; a typed custom-gateway URL can be tested before saving; errors surface as toasts with a details expander instead of alert() popups.

### Testing

- A new end-to-end harness (`npm run bench:e2e`) drives four full agent scenarios (search, form fill, login wall, price comparison) through the real pipeline against a scripted local gateway; 18 new unit tests bring the suite to 83.

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
