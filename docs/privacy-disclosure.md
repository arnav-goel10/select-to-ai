# Privacy disclosure for 4.0.0

What version 4.0.0 sends and stores, read from the code under `extension/` on 10 Nov 2026, and the answers this means for the Chrome Web Store "Privacy practices" tab. The user-facing version is [PRIVACY_POLICY.md](../PRIVACY_POLICY.md).

The store listing for 2.0 says the extension collects no user data. That was close to true for 2.0. It is false for 4.0.0: the agent sends page content, tab titles and addresses, screenshots and memory to the AI service the user picked, and stores personal details and API keys on the device.

There is no developer server. No request in the code goes to a host the developer runs. There is no analytics, telemetry or error reporting.

## Every network request

| # | Destination | What is sent | When | Code |
|---|---|---|---|---|
| 1 | The chosen AI service (11 providers in `host_permissions`) or the user's custom gateway | Task text, selected text (up to 800 chars), the current page's text and control list, excerpts of earlier pages in the task, titles and URLs of every tab in the window, excerpts of up to 4 other tabs (900 chars each) when the task is about them, a JPEG screenshot when the model calls `look` on a vision model, memory notes and preferences, a saved detail's value when the model calls `recall`, the API key | Every step of an agent run | `engine.js` model and observe paths; `core/context.js` (prompt assembly, tabs at the "Open tabs" line); `core/llm.js` `buildRequest`; every URL checked by `security.js` `validateProviderUrl` |
| 2 | Same service | Run summary and existing memory, to decide what to keep | After a run, unless learning is off | `engine.js` learning step |
| 3 | Same service, cheaper model | The changed step's description and the page's controls | Recipe replay when the page changed | `recipes/service.js` `modelFrom` |
| 4 | Same service | The API key and the word "Hi", one token | Testing a pasted key on the welcome page | `welcome.js` `testKey` |
| 5 | Same service, through the worker | Connection test or model list, with the API key | Settings page | `background.js` `fetchProxy` |
| 6 | openrouter.ai (sign-in window, then `POST /api/v1/auth/keys`) | PKCE code; an API key comes back | "Continue with OpenRouter" | `welcome.js`, `chrome.identity.launchWebAuthFlow` |
| 7 | auth.openai.com, api.openai.com | OAuth code and tokens | Sign in with ChatGPT. **Off in 4.0.0** (`FEATURES.chatgptSignIn = false` in `defaults.js`; the worker refuses it) | `chatgptAuth.js`, `chatgptConnect.js` |
| 8 | chatgpt.com/?q=, perplexity.ai/search?q= | Selected text in the URL, plus the page address if "Include the page link" is on | Right-click send | `background.js`, `config.js` URL templates |
| 9 | chatgpt.com, claude.ai, gemini.google.com, perplexity.ai pages | Selected text (and page address) typed into the chat box by the content script | Right-click send, side panel | `contentScript.js`, `background.js` |
| 10 | Any site the agent opens | What the task needs, for example search words | During a run | the agent's own actions |

Not a request: a session `declarativeNetRequest` rule removes `X-Frame-Options`, CSP and related headers on the four chat sites, only for the side panel's frames, so those sites can show inside the panel (`background.js`). The extension's own files (`tokens.css`, `chrome-extension://_favicon`) load locally.

## Every stored item

| Key | Area | Holds | Encrypted | Removed by |
|---|---|---|---|---|
| `agentOpenRouterKey` and the other `agent*Key` entries | local | API keys | No | Reset |
| `agentKnown` | local | Personal details (name, email, phone, address, date of birth, company, job title, website), preferences, site notes, lessons, routines, context facts | Yes, AES-GCM, non-exportable key in IndexedDB `select-to-ai` | Per-entry delete, Forget everything, Reset |
| `agentUserMemory`, `agentSkills` | local | Pre-v4 memory, moved into `agentKnown` on first run | No | Reset |
| `agentCrossSessionMemory` | local | Last 20 tasks: the words typed and the outcome | No | Reset |
| `recipesStore` | local | Up to 50 recipes: URLs, control names and nearby words, example values, last 5 results | No | Recipe delete, Reset |
| `sessionUrl_<service>` | local | Last conversation URL on each chat site | No | Reset |
| `sidePanelState` | local | The panel's URL and text being handed to it | No | Overwritten, Reset |
| `chatgptCredentials`, `chatgptAccount`, `chatgptHostId` | local | ChatGPT tokens (encrypted), account email and model list, an install ID. Empty in 4.0.0 while the feature is off | Tokens only | Sign out, Reset |
| `agentProviderPause`, `onboardingComplete` | local | State flags | No | Reset (pause flag) |
| `agentSession:<windowId>` | session | Last 12 turns and the run in progress, with the text it has read and other tabs' excerpts. The text of pages the run read is cleared from the record when the run ends (`core/run.js` `toStored`); the other tabs' excerpts and the selection stay until the browser closes | No | Browser close |
| `agentSelection:<tab>`, `agentHandoff`, `chatgptPending`, `chatgptSignIn` | session | Selection with nearby text, a task handed from the address bar, sign-in attempt state | No | Browser close |
| Settings (`CONFIG.STORAGE.SETTINGS`) | sync | Preferences, allow-list, extra instructions | No | Reset |
| IndexedDB `select-to-ai` / `keys` | IndexedDB | The AES keys for memory and ChatGPT tokens | n/a | Uninstall |

Fixed in this release, found while writing this: a finished run kept up to 800,000 characters of page text in session storage because `toStored` cleared a field name that does not exist; and Reset left recipes, chat URLs and the ChatGPT install ID behind.

## Store dashboard answers (Privacy practices tab)

**Single purpose.** Select to AI helps you use AI on the page you are reading: send selected text to an AI chat, or ask an AI agent to read and act on websites for you in your own browser.

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

**Certifications: tick all three.** The data is not sold or transferred to third parties outside the approved use (it goes only to the AI service the user chose, to do what the user asked); it is not used for anything unrelated to the single purpose; it is not used for creditworthiness or lending.

**Remote code.** No. All code is in the package. Recipes are JSON data replayed by packaged code, not code.

**Privacy policy URL.** `https://github.com/arnav-goel10/select-to-ai/blob/main/PRIVACY_POLICY.md` (live only once 4.0.0 is pushed to public main; until then it shows the 3.3.1 policy).
