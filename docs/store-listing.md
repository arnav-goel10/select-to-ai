# Chrome Web Store listing: 3.3.0

Ready-to-paste copy for the store listing (the live listing still describes
v2.0). Plain text only; the store strips markdown.

## Short description (132 chars max)

Send selected text to ChatGPT, Gemini, Claude, or Perplexity, or run a bounded, safety-gated browser agent with your own API key.

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

The agent is OFF by default. A first-run setup wizard connects the model provider of your choice (OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Mistral, Groq, Together, xAI, OpenCode, or your own local/self-hosted gateway) and verifies your key before anything is enabled.

PRIVACY AND SAFETY BY DESIGN
- Your API keys stay in local browser storage and are excluded from settings exports.
- Requests can only go to the documented provider endpoints or the exact custom gateway you configured.
- The agent asks permission per website, one origin at a time, no blanket access to all sites.
- High-risk actions (purchases, deletions, payments, passwords) require your explicit confirmation.
- Step, cost, domain, and failure limits bound every run. No analytics, no telemetry, no ads.

Open source: https://github.com/arnav-goel10/select-to-ai

## What's new in 3.3.0

- New guided setup: a short wizard connects your API key, verifies it, and explains the agent before turning it on.
- The agent now plans, acts, reflects after failures, and validates its answer against the page before finishing, and asks you instead of guessing at logins or CAPTCHAs.
- Steer a running task with a mid-run message; export the run log or full session recording.
- Cleaner, consistent design across the popup, settings, side panel, and agent, with a real light and dark theme everywhere.
- The popup is now a simple launcher; all settings live in one place.
- Sturdier text sending: URL-based prompts for new ChatGPT/Perplexity chats, verified sends elsewhere, and a clipboard fallback instead of wrong-button clicks.
- The agent sidebar lists your recent completed tasks and lets you view or clear everything the agent remembers.
- Dozens of fixes: accurate cost estimates, readable logs, keyboard-accessible controls, and repaired settings flows.
