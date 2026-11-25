# Privacy Policy for Select to AI

Last updated: November 16, 2026 (version 4.0.0)

Select to AI has no server of its own. It does not use analytics, advertising, error reporting or telemetry, and it does not sell or share data with anyone. What it reads from your pages goes to one place: the AI service you chose in Settings (or your own gateway), so that service can answer you or do the task you gave it. That service's own terms and privacy policy apply to what it receives.

A full list of every request the extension makes and every item it stores, with the code that does it, is in [docs/privacy-disclosure.md](docs/privacy-disclosure.md).

## What is sent, and to whom

**To the AI service you chose** (OpenRouter, OpenAI, Anthropic, Google Gemini, DeepSeek, Mistral, Groq, Together AI, xAI, OpenCode, Cerebras, or a custom gateway you set up), only while you use the agent:

- The task you typed, and any text you had selected when you asked.
- The text of the page the agent is working on and a list of its buttons, links and fields, at every step. Password, card and one-time-code fields are never read: the agent is told such a field exists and whether it is filled, not what is in it.
- Short excerpts (about 600 characters each) of pages it read earlier in the same task.
- Your last few messages in the same conversation and the agent's replies to them (up to six, about 500 characters each), at every step, so it can follow up on what you said before. A reply can quote pages from an earlier task. The conversation is kept in `chrome.storage.session` until the browser closes.
- The titles and addresses of the tabs open in the same window, at every step.
- Short excerpts (about 900 characters each, at most four) of other open tabs, only when the task is about them, judged from their titles and addresses.
- A screenshot of the page, or a picture of one control on it such as a chart, only when the agent asks to look at it and only if your model can read images.
- What the agent knows about you (see Memory below): your preferences and notes in your own words, and which of your saved details exist. A saved detail's value (for example your email) goes to the AI service only when the agent asks to read it, and the conversation shows that it did. Otherwise your details go straight from your browser into the form.
- After a task that could teach it something, one more request with a summary of the task and your existing memory, to decide what to keep. Turn learning off under Settings > Memory to stop this.
- For each page the agent reads, the names of its buttons and links, their kind, the address path of a link or form and the names of a form's fields, so a separate check can say which of them would pay, send, delete or decide something for you before the agent presses one. This check is never sent the page text or your task.
- When a saved recipe meets a page that has changed, a short description of that step and of the page's controls, to check or repair the step.
- Your API key for that service, in the request header.

If you set a **backup provider** (Settings > Browser agent > Backup when limits run out), the same requests go to that provider while your main one is out of quota. Each switch is shown in the conversation. Some free tiers, such as Google Gemini's outside the EU and UK, may use prompts to improve their products.

**To ChatGPT, Claude, Gemini or Perplexity**, when you right-click selected text and send it there: the selected text, and the page address only if you turned on "Include the page link" in Settings. That switch is off unless you turn it on. Each send opens a new chat. For ChatGPT and Perplexity a short selection is put in the address that opens their page (`?q=`), so it can appear in that site's history. Claude is listed only after you allow claude.ai.

**To OpenRouter**, when you click "Sign in with OpenRouter" on the welcome page: OpenRouter's own sign-in runs in a Chrome window (OAuth with PKCE) and returns an API key. The extension never sees your OpenRouter password. Once a key works, the welcome page asks OpenRouter, with that key, whether the account has bought credit, so it can preselect free or paid models. Nothing else is sent in that request.

**To the websites the agent opens for you**: whatever the task needs, for example search words typed into a search box. This is the agent using the site the way you would.

## What is stored in your browser

Nothing below leaves your browser except as listed above.

| What | Where | How long |
|---|---|---|
| API keys | `chrome.storage.local` (not synced, left out of settings exports) | Until Settings > Reset or uninstall |
| Settings and preferences | `chrome.storage.sync` (may sync with your Chrome account) | Until Reset |
| Memory: your details for forms (name, email, phone, address, company and the like, each saved only after you typed or confirmed it), preferences, notes about how sites work, lessons from your corrections, opening steps of tasks that worked | `chrome.storage.local`, encrypted with a key that never leaves this browser profile | Until you delete an entry, use Forget everything, or Reset |
| Your last 20 tasks: the words you typed (including any text you selected for the quick box) and whether each worked | `chrome.storage.local` | Until Reset |
| Recipes you saved: addresses, the names of the controls used and the words near them, the example values you typed, the last five results | `chrome.storage.local` | Until you delete the recipe, or Reset |
| The task in progress: its steps, what it read and the excerpts of other tabs it used, so it can carry on if Chrome pauses the extension | `chrome.storage.session`, which Chrome keeps in memory and clears when the browser closes. The text of the pages it read is dropped as soon as the task ends. The excerpts of other tabs and your selection stay until the browser closes | Until the browser closes |
| What the agent's check said about buttons and links it met: the site, the page path, the names of the control and of its form fields or dialog, and whether pressing it pays, sends, deletes or decides something, so the same control is not checked again | `chrome.storage.local`, at most 3000 answers | 30 days, or until Reset |
| The last text you sent to a chat site in the side panel, so that site can receive it | `chrome.storage.local` | Until your next side-panel send or switch, or Reset |
| The address of your last conversation on ChatGPT, Claude, Gemini or Perplexity, recorded only while that site is open inside the side panel (never from an ordinary tab), so opening the side panel takes you back to it | `chrome.storage.local` | Until Reset |

Memory refuses anything that looks like a password, one-time code, card number (any run of 13 to 19 digits), social security number, passport or ID number, or API key. Recipes never keep passwords, codes or card numbers: a recipe asks for them each time it runs. A task that used your saved details cannot be saved as a recipe.

Storage in your browser profile is protected by Chrome, but apart from Memory it is not encrypted. Someone with access to your unlocked computer could read it.

## Permissions that touch your data

Right-click sending needs no new permission. Everything the agent adds is optional, and Chrome asks you the first time a feature needs it.

- **Access to websites** is optional. Chrome asks before the agent works on a site, for that site or for all sites, your choice. Claude, perplexity.ai without www, your AI service's address, OpenRouter and a model on your own computer are asked for the same way, when you pick them.
- **Tabs** lets the agent see the titles and addresses of your tabs, and open and switch tabs for a task.
- **Notifications** is optional and asked when you turn on "Tell me when a task is done" in Settings. It shows the outcome of a task you left running. The text stays on your device.

## Deleting your data

- **Settings > Reset** removes your settings, API keys, Memory, task history, recipes, saved chat addresses and the kept answers of the button check.
- **Forget everything** in the Memory panel deletes Memory only.
- Uninstalling the extension removes everything it stored.

## Security

- Requests go only to the listed AI services, or to the exact address of a gateway you set up. A remote gateway must use HTTPS; plain HTTP is allowed only for your own computer.
- Actions that pay, send or delete stop and ask you first, by default.
- Settings exports leave out API keys.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Limited Use

Select to AI's use of the information it handles complies with the Chrome Web Store User Data Policy, including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements. It is used only to provide the features described here. It is sent only to the AI service you chose, to do what you asked. It is never sold, never used for advertising, and never used to judge creditworthiness or for lending.

## Contact

For privacy questions, open an issue on [arnav-goel10/select-to-ai](https://github.com/arnav-goel10/select-to-ai). For suspected vulnerabilities, follow the private process in [SECURITY.md](SECURITY.md).
