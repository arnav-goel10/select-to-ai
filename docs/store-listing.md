# Chrome Web Store listing: 4.0.0

Copy to paste into the developer dashboard. The store strips markdown, so the long description is plain text. The live listing still describes 2.0.

## Title

Select to AI

(From the manifest `name`. Unchanged, so existing users and search keep finding it.)

## Short description (125 of 132 characters)

Send selected text to ChatGPT, Claude, Gemini or Perplexity, or ask an AI agent to read and use websites in your own browser.

(The store takes this from the manifest `description`, which now matches.)

## Long description

```
Highlight text on any page, right-click, and send it to ChatGPT, Claude, Gemini or Perplexity. The chat opens in Chrome's side panel or a new tab with your text already in it. This part needs no account with us and no API key.

The agent does tasks on websites for you. Type what you want, for example "what's the top story on Hacker News" or "find the cheapest of these three laptops", and it opens pages, clicks, types, scrolls and reads in your tab, then gives you the answer with the pages it came from. Before it answers, it checks its quotes against the pages it read. You can follow each step as it happens, send it a message to change course, or stop it.

Start it from the side panel, the toolbar button, the quick box (Alt+K on Windows and Linux, Control+Shift+Q on Mac) or by typing ai and a space in the address bar.

YOUR DATA
There is no Select to AI server. Page text, tab titles, URLs and screenshots go only to the AI provider you chose, and only while a task runs. API keys stay in this browser. No analytics, no ads. The agent works only on sites you allow, site by site or on every site. The privacy policy lists everything it stores and sends.

WHAT YOU NEED
The agent needs an AI model. Connect a free OpenRouter account in one click, no card needed. Free models have a daily limit and do less well on long tasks, so for regular use paste a key from OpenAI, Anthropic, Google Gemini, Groq, xAI, DeepSeek, Mistral or another listed provider, or point it at your own local model.

WHAT IT WON'T DO WITHOUT YOU
It stops and asks before anything that pays, sends or deletes.
It hands sign-ins, CAPTCHAs and one-time codes back to you, and carries on once you are done. It never types a password or a card number.

MEMORY
Tell it your details once (name, email, address) and it fills forms with them. They are stored encrypted in your browser. It also keeps preferences you state and what it learned about sites you use, such as where a site keeps its search. Settings > Memory shows every entry, and you can edit or delete any of them.

RECIPES
Save a task that worked as a recipe and run it again later. If the pages haven't changed, a recipe replays without calling the AI. If a page has changed, it checks that step with your AI model, and it stops if a button now does something different.

Chrome shows a "debugging this browser" bar while the agent controls a tab. That's how it types and clicks the way a person does.

Open source, MIT licence: https://github.com/arnav-goel10/select-to-ai
```

## What's new in 4.0.0 (for the release notes field, if shown)

```
The agent is rebuilt. Runs live in the background, so you can close the panel and come back.
It pauses for sign-ins, CAPTCHAs, codes and payments, and carries on when you are done.
Memory: your details fill forms, stored encrypted in your browser.
Recipes: save a task that worked and replay it without calling the AI while the pages stay the same.
New shortcuts on Mac: Control+Shift+S side panel, Control+Shift+G agent, Control+Shift+Q quick box.
```

## Permission justifications (Privacy practices tab)

- contextMenus: the "Send to ChatGPT / Claude / Gemini / Perplexity" items on the right-click menu for selected text.
- storage: preferences, the user's API key, their memory (encrypted) and saved recipes, all on the device.
- sidePanel: shows the chat sites and the agent in Chrome's side panel.
- tabs: lets the agent read tab titles and addresses, and open and switch tabs, for a task the user asked for.
- activeTab: reads the current page when the user starts the agent from the toolbar button, a shortcut or the menu.
- scripting: runs the agent's page reader on sites the user allowed, so it can see and act on the page.
- debugger: sends real key presses and pointer input (Enter, Tab, hover menus, drag, presses inside another site's frame, canvas) and takes screenshots of a tab behind another, only on a tab where the user is running an agent task. Chrome does not allow `debugger` to be optional. Without it, 7 of the 59 scripted end-to-end scenarios fail (see docs/debugger-permission.md).
- favicon: shows site icons next to the pages a task used.
- declarativeNetRequest: lets ChatGPT, Claude, Gemini and Perplexity load inside the side panel. The rule covers only those four sites and only the side panel's frames.
- notifications: tells the user a task finished or is waiting for them while they are away from it.
- alarms: one reminder two minutes after a task paused for the user.
- idle: checks whether the user is at the computer, so a waiting task notifies them only when they are away.
- identity: opens OpenRouter's sign-in window for "Continue with OpenRouter" (OAuth with PKCE).
- Host permissions, AI provider domains: sends the user's requests to the provider they picked.
- Host permissions, chatgpt.com, claude.ai, gemini.google.com and perplexity.ai: puts the user's selected text into that site's chat box when they send it from the right-click menu or side panel.
- Host permissions, localhost and 127.0.0.1: lets a user run the agent on a model served on their own computer (for example Ollama). Requests go to the exact address they enter.
- Optional host permissions (all sites): asked for only when the user lets the agent work on websites, per site or for all.

## Data usage answers

See docs/privacy-disclosure.md, section "Store dashboard answers". In short: tick Personally identifiable information, Authentication information, Personal communications, Web history, User activity and Website content; tick all three certifications; remote code is No.

## Note to the reviewer (optional field)

```
4.0.0 adds a browser agent that acts only on sites the user grants, one at a time or all at once. The debugger permission is used for real key and pointer input and background-tab screenshots during a task the user started; Chrome does not allow it as an optional permission. Recipes are saved JSON replayed by packaged code; no remote code is loaded. There is no developer server: page content goes only to the AI provider the user configures. Sign in with ChatGPT is present in the code but turned off in this build.
```

## Screenshots

Real captures from the built extension are in docs/screens/ (see docs/screens/README.md). The store wants 1280x800 or 640x400.
