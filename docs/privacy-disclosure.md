# Privacy disclosure for 4.0.0

What version 4.0.0 sends and stores, read from the code under `extension/` on 10 Nov 2026 and updated on 16 Nov 2026 for the release manifest, in which notifications and every host beyond the three 2.0 chat sites are optional and asked at first use, and the answers this means for the Chrome Web Store "Privacy practices" tab. The user-facing version is [PRIVACY_POLICY.md](../PRIVACY_POLICY.md).

The store listing for 2.0 says the extension collects no user data. That was close to true for 2.0. It is false for 4.0.0: the agent sends page content, tab titles and addresses, screenshots and memory to the AI service the user picked, and stores personal details and API keys on the device.

There is no developer server. No request in the code goes to a host the developer runs. There is no analytics, telemetry or error reporting.

## Every network request

| # | Destination | What is sent | When | Code |
|---|---|---|---|---|
| 1 | The chosen AI service (11 providers, each an optional host permission asked when the user connects it) or the user's custom gateway | Task text, selected text (up to 800 chars), the current page's text and control list, excerpts of earlier pages in the task, titles and URLs of every tab in the window, excerpts of up to 4 other tabs (900 chars each) when the task is about them, a JPEG screenshot when the model calls `look` on a vision model, memory notes and preferences, a saved detail's value when the model calls `recall`, the API key | Every step of an agent run | `engine.js` model and observe paths; `core/context.js` (prompt assembly, tabs at the "Open tabs" line); `core/llm.js` `buildRequest`; every URL checked by `security.js` `validateProviderUrl` |
| 2 | Same service | Run summary and existing memory, to decide what to keep | After a run, unless learning is off | `engine.js` learning step |
| 3 | Same service, cheaper model | The changed step's description and the page's controls | Recipe replay when the page changed | `recipes/service.js` `modelFrom` |
| 4 | Same service | The API key and the word "Hi", one token | Testing a pasted key on the welcome page | `welcome.js` `testKey` |
| 5 | Same service, through the worker | Connection test or model list, with the API key | Settings page | `background.js` `fetchProxy` |
| 6 | openrouter.ai (sign-in window, then `POST /api/v1/auth/keys`) | PKCE code; an API key comes back | "Continue with OpenRouter" | `welcome.js`, `chrome.identity.launchWebAuthFlow` |
| 7 | chatgpt.com/?q=, perplexity.ai/search?q= | Selected text in the URL when it is short, plus the page address only if "Include the page link" is on (off by default). Each send opens a new chat | Right-click send | `background.js`, `config.js` URL templates |
| 8 | chatgpt.com, gemini.google.com, www.perplexity.ai pages, and claude.ai or perplexity.ai once the user allows them | Selected text (and page address, if the switch is on) typed into the chat box by the content script | Right-click send, side panel | `contentScript.js`, `background.js` |
| 9 | Any site the agent opens | What the task needs, for example search words | During a run | the agent's own actions |

Not a request: a session `declarativeNetRequest` rule removes `X-Frame-Options`, CSP and related headers on the chat sites, only for the side panel's frames, so those sites can show inside the panel (`background.js`). It takes effect on claude.ai only after the user allows that host. The extension's own files (`tokens.css`) load locally. Site icons next to a task's pages are the tab's own icon address (`tab.favIconUrl`), or a generic icon; there is no `favicon` permission in 4.0.0.

## Every stored item

| Key | Area | Holds | Encrypted | Removed by |
|---|---|---|---|---|
| `agentOpenRouterKey` and the other `agent*Key` entries | local | API keys | No | Reset |
| `agentKnown` | local | Personal details (name, email, phone, address, date of birth, company, job title, website), preferences, site notes, lessons, routines, context facts | Yes, AES-GCM, non-exportable key in IndexedDB `select-to-ai` | Per-entry delete, Forget everything, Reset |
| `agentUserMemory`, `agentSkills` | local | Pre-v4 memory, moved into `agentKnown` on first run | No | Reset |
| `agentCrossSessionMemory` | local | Last 20 tasks: the words typed and the outcome | No | Reset |
| `recipesStore` | local | Up to 50 recipes: URLs, control names and nearby words, example values, last 5 results | No | Recipe delete, Reset |
| `sessionUrl_<service>` | local | Last conversation URL on each chat site, recorded only while the site is open inside the side panel | No | Reset |
| `sidePanelState` | local | The panel's URL and text being handed to it | No | Overwritten, Reset |
| `agentProviderPause`, `onboardingComplete` | local | State flags | No | Reset (pause flag) |
| `agentSession:<windowId>` | session | Last 12 turns and the run in progress, with the text it has read and other tabs' excerpts. The text of pages the run read is cleared from the record when the run ends (`core/run.js` `toStored`); the other tabs' excerpts and the selection stay until the browser closes | No | Browser close |
| `agentSelection:<tab>` | session | Selection with nearby text | No | Browser close |
| `recipeDrafts` | session | For the last 4 ended runs: the recipe the run would save as (URLs, control names and nearby words, example values; never a value typed into a password, card or code field), or the reason it cannot be saved. Kept so Save as recipe still works after the service worker restarts | No | Browser close |
| Settings (`CONFIG.STORAGE.SETTINGS`) | sync | Preferences, allow-list, extra instructions | No | Reset |
| IndexedDB `select-to-ai` / `keys` | IndexedDB | The AES key for memory | n/a | Uninstall |

Fixed in this release, found while writing this: a finished run kept up to 800,000 characters of page text in session storage because `toStored` cleared a field name that does not exist; and Reset left recipes and chat URLs behind.

## Store dashboard answers (Privacy practices tab)

**Single purpose.** Using AI on the web page you are reading. Select to AI sends text you select to the AI chat you pick, and its agent reads and acts on the pages you allow, in your own browser, for a task you asked for.

**Data usage: tick these.**

| Category | Tick | Why |
|---|---|---|
| Personally identifiable information | Yes | Name, email, address and phone are stored for filling forms, and one can be sent to the user's AI service when the agent reads it |
| Health information | No | Not asked for or kept. A page the user points the agent at could contain it; that is covered by Website content |
| Financial and payment information | No | Card-like numbers (13 to 19 digits) are refused by memory (`core/memory.js` `SECRET`), card fields are never read, and the agent stops before paying |
| Authentication information | Yes | API keys are stored and sent to the AI service they belong to |
| Personal communications | Yes | The agent reads and sends the text of pages the user points it at, which can be email or chat |
| Location | No | No geolocation. A street address is under PII |
| Web history | Yes | Tab titles and URLs go to the AI service each step; past tasks and chat URLs are stored |
| User activity | Yes | Selected text, typing and clicks the agent makes are part of a run and of saved recipes |
| Website content | Yes | Page text and screenshots go to the AI service |

**Certifications: tick all three, including Limited Use.** The policy states it in its Limited Use section. The data is not sold or transferred to third parties outside the approved use (it goes only to the AI service the user chose, to do what the user asked); it is not used for anything unrelated to the single purpose; it is not used for creditworthiness or lending.

**Remote code.** No. All code is in the package. Recipes are JSON data replayed by packaged code, not code.

**Privacy policy URL.** `https://github.com/arnav-goel10/select-to-ai/blob/main/PRIVACY_POLICY.md` (live only once the repository is public and 4.0.0 is on main; open it signed out and check it loads before pasting it).
