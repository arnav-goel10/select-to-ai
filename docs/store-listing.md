# Chrome Web Store listing: 3.4.0

Ready-to-paste copy for the store listing. The live listing historically
lagged releases (it described v2.0 while the repo shipped 3.x); from 3.4.0
onward update this file in the same PR as the release so it never goes stale
again. Plain text only; the store strips markdown.

## Short description (132 chars max)

Send selected text to ChatGPT, Gemini, Claude, or Perplexity, or run a bounded, safety-gated browser agent. Free hosted mode, no key needed.

## Full description

Select to AI does two things, both under your control.

SEND SELECTED TEXT TO ANY ASSISTANT
Highlight text on any page, right-click, and send it to ChatGPT, Gemini, Claude, or Perplexity, in a new tab or Chrome's side panel. New ChatGPT and Perplexity conversations receive your prompt through the URL itself, so nothing fragile happens on the page. Optional auto-submit and automatic page-context appending are one switch each in Settings. If the extension ever cannot find the chat box, it copies your text to the clipboard and tells you; it never clicks a guessed button.

Type "ai" plus a space in the address bar and just say what you want: a site name opens the site, a question goes to your preferred assistant, and a multi-step task is handed to the browser agent. The suggestion row shows exactly what Enter will do before you press it.

A BROWSER AGENT THAT SHOWS ITS WORK
The AI Browser Agent plans your task into a visible checklist, performs one page action at a time, and checks its own results:

- It plans subtasks with observable "done when" conditions you can watch complete.
- Every click and keystroke is verified by what actually changed on the page, not assumed.
- After repeated failures it stops and rethinks its approach instead of looping.
- Before it says "done", a validator checks the answer against what is actually on the page.
- It asks YOU when it meets logins, CAPTCHAs, payments, or an ambiguous request, it never guesses credentials.
- You can steer a running task with a message, export the full run log, and stop instantly at any time.

START IN MINUTES, NO API KEY REQUIRED
The agent is OFF by default. Setup takes one of two paths:
- Hosted mode: pick "Hosted (free)" during setup and you are done. Requests relay through a small relay server to the model provider. No account, no API key, no card.
- Bring your own key: connect OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Mistral, Groq, Together, xAI, OpenCode, or your own local/self-hosted gateway. Keys never leave your browser.
After setup the extension suggests three concrete first tasks based on the page you are on, so your first run is one click, not a blank prompt.

PRIVACY AND SAFETY BY DESIGN
- Bring-your-own-key mode is fully local: keys stay in local browser storage, are excluded from settings exports, and requests go only to the documented provider endpoints or the exact custom gateway you configured.
- Hosted mode sends model traffic through the relay you configured; page content travels only when you run a task, and nothing is stored by the relay.
- The agent asks permission per website, one origin at a time, no blanket access to all sites.
- High-risk actions (purchases, deletions, payments, passwords) require your explicit confirmation.
- Step, cost, domain, and failure limits bound every run. No analytics, no telemetry, no ads.

Open source: https://github.com/arnav-goel10/select-to-ai

## What's new in 3.4.0

- Hosted free mode: try the full agent without an API key; bring-your-own-key stays fully local as always.
- Suggested first tasks: after setup, one-click starter tasks based on your current tab end the blank-prompt problem.
- Under the hood: the agent runtime is now organized into focused modules (state, provider payloads, streaming, run loop) with zero behavior change, keeping the codebase maintainable as features land.
