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
Highlight text on any page, right-click, and send it to ChatGPT or Gemini. Perplexity and Claude are in Settings too (Claude once you allow claude.ai). The chat opens in Chrome's side panel or a new tab with your text already in it. This part needs no account with us and no API key. Right-click sending works exactly as before.

The agent does tasks on websites for you. Type what you want, for example "what's the top story on Hacker News" or "find the cheapest of these three laptops", and it opens pages, clicks, types, drags, scrolls and reads in your tab, then gives you the answer with the pages it came from. Before it answers, it checks its quotes against the pages it read. You can follow each step as it happens, send it a message to change course, or stop it.

Start it from the side panel, the toolbar button or the quick box (Alt+K on Windows and Linux, Control+Shift+Q on Mac).

YOUR DATA
There is no Select to AI server. Page text, tab titles, URLs and screenshots go only to the AI provider you chose, and only while a task runs. API keys stay in this browser. No analytics, no ads. The agent works only on sites you allow, site by site or on every site. Chrome asks for each new access the first time you use it: a site, your AI provider, Claude, and desktop notifications if you want them. The privacy policy lists everything it stores and sends.

WHAT YOU NEED
The agent needs an AI model. Connect a free OpenRouter account in one click, no card needed. Free models have a daily limit and do less well on long tasks, so for regular use paste a key from OpenAI, Anthropic, Google Gemini, Groq, xAI, DeepSeek, Mistral or another listed provider, or point it at your own local model.

WHAT IT WON'T DO WITHOUT YOU
It stops and asks before anything that pays, sends or deletes.
It hands sign-ins, CAPTCHAs and one-time codes back to you, and carries on once you are done. It never types a password or a card number.

MEMORY
Tell it your details once (name, email, address) and it fills forms with them. They are stored encrypted in your browser. It also keeps preferences you state and what it learned about sites you use, such as where a site keeps its search. Settings > Memory shows every entry, and you can edit or delete any of them.

RECIPES
Save a task that worked as a recipe and run it again later. If the pages haven't changed, a recipe replays without calling the AI. If a page has changed, it checks that step with your AI model, and it stops if a button now does something different.

Open source, MIT licence: https://github.com/arnav-goel10/select-to-ai
```

## What's new in 4.0.0 (for the release notes field, if shown)

```
Right-click sending works as in 2.0, except that the popup window mode is gone. Each send opens a new chat.
New: an agent that does tasks on websites for you. It is off until you set it up.
It pauses for sign-ins, CAPTCHAs, codes and payments, and carries on when you are done.
Memory: your details fill forms, stored encrypted in your browser.
Recipes: save a task that worked and replay it without calling the AI while the pages stay the same.
The popup window opening mode is retired. Chats open in the side panel or a new tab.
```

## Single purpose (Privacy practices tab)

Using AI on the web page you are reading. Select to AI sends text you select to the AI chat you pick, and its agent reads and acts on the pages you allow, in your own browser, for a task you asked for.

## Permission justifications (Privacy practices tab)

Required permissions. All of them were in 2.0 or give Chrome no install warning, so the update installs without a new prompt.

- contextMenus: the "Send to ChatGPT" and "Send to Gemini" items on the right-click menu for selected text, plus Perplexity and Claude when the user has them on in Settings (Claude once the user allows claude.ai).
- storage: preferences, the user's API key, their memory (encrypted) and saved recipes, all on the device.
- sidePanel: shows the chat sites and the agent in Chrome's side panel.
- tabs: lets the agent read tab titles and addresses, and open and switch tabs, for a task the user asked for.
- declarativeNetRequest: lets the chat sites load inside the side panel. The rule covers only those sites and only the side panel's frames, and Claude only after the user allowed claude.ai.
- activeTab: reads the current page when the user starts the agent from the toolbar button, a shortcut or the menu.
- scripting: runs the agent's page reader on sites the user allowed, so it can see and act on the page.
- identity: opens OpenRouter's sign-in window for "Continue with OpenRouter" (OAuth with PKCE).
- alarms: one reminder two minutes after a task paused for the user.
- idle: checks whether the user is at the computer, so a waiting task reminds them only when they are away.
- Host permissions, chatgpt.com, gemini.google.com and www.perplexity.ai (the same three as 2.0): puts the user's selected text into that site's chat box when they send it from the right-click menu or side panel.

Optional permissions. None is granted at install. Chrome asks for each one the first time the user picks the feature that needs it.

- notifications (optional): asked when the user turns on "Tell me when a task is done" in Settings. Tells the user a task finished or is waiting for them while they are away from it. If it is not granted, the badge and the panel still show the state.
- Optional host permissions, AI provider domains and openrouter.ai: asked when the user connects or picks that provider. Sends the user's requests to the provider they picked.
- Optional host permissions, claude.ai and perplexity.ai: asked when the user turns on Claude or picks perplexity.ai. Puts the selected text into that chat box.
- Optional host permissions, localhost and 127.0.0.1: asked when a user points the agent at a model served on their own computer (for example Ollama). Requests go to the exact address they enter.
- Optional host permissions, other sites: asked only when the user lets the agent work on a website, per site or for all.

## Data usage answers

See docs/privacy-disclosure.md, section "Store dashboard answers". In short: tick Personally identifiable information, Authentication information, Personal communications, Web history, User activity and Website content; leave Health, Financial and Location unticked; tick all three certifications, including Limited Use; remote code is No.

## Note to the reviewer (optional field)

```
Right-click sending needs no account. 4.0.0 adds a browser agent that is off until the user sets it up and acts only on sites the user grants, one at a time or all at once. Every new access (sites, the AI provider, claude.ai, notifications) is an optional permission asked at first use. Recipes are saved JSON replayed by packaged code; no remote code is loaded. There is no developer server: page content goes only to the AI provider the user configures.
```

## Test instructions (Test instructions tab)

No account or key is needed for steps 1 to 3. Do not put a real API key in this field.

```
1. Install the extension. Open any article, for example https://en.wikipedia.org/wiki/Web_browser.
2. Select a sentence, right-click, and choose Select to AI > Send to ChatGPT (or Gemini). The side panel opens that site with the text in its chat box. No account with Select to AI is needed.
3. In Settings, set "Open in" to New tab and send again. The site opens in a new tab instead.
4. To try the agent, click the toolbar button, then Connect for free, then Continue with OpenRouter (free). A card titled "What the agent sends" appears below the key box. Press Agree and continue. When Chrome asks to allow openrouter.ai, allow it. Then create a free OpenRouter account in the window that opens (no card needed) and approve.
5. In the toolbar popup, type a task such as "What is the top story on Hacker News?" and press Enter. When asked, allow the agent to use news.ycombinator.com. The agent opens the site, reads it and answers with the page it used.
```

## Screenshots

The five 1280x800 store screenshots come from the CI artifact store-screens (the screenshots job loads the packed build). Lead with right-click send, then the side panel, agent result, needs-you card and Recipes sheet.
