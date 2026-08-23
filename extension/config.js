/**
 * Select to AI - Shared Configuration
 * Centralized constants for all extension components.
 * 
 * This file is injected into:
 * - background.js (via manifest)
 * - contentScript.js (via manifest)
 * - popup.html (via <script src>)
 * - sidepanel.html (via <script src>)
 */

const CONFIG = {
    // Service Base URLs
    URLS: {
        CHATGPT: "https://chatgpt.com/",
        GEMINI: "https://gemini.google.com/app",
        PERPLEXITY: "https://www.perplexity.ai/",
        CLAUDE: "https://claude.ai/new",
        AGENT: "agent.html"
    },

    // Hostname Matchers (for detection)
    HOSTS: {
        CHATGPT: "chatgpt.com",
        GEMINI: "gemini.google.com",
        PERPLEXITY: "perplexity.ai",
        PERPLEXITY_WWW: "www.perplexity.ai",
        CLAUDE: "claude.ai",
        AGENT: "agent.html"
    },

    // URL-parameter prefill for NEW conversations. These providers accept
    // the prompt in the URL (and submit it on load), so the content script's
    // DOM insertion is skipped entirely for new-conversation sends.
    PREFILL_URLS: {
        CHATGPT: "https://chatgpt.com/?q={query}",
        PERPLEXITY: "https://www.perplexity.ai/search?q={query}"
    },

    // Per-provider insertion adapters for the content script.
    //
    // Each adapter carries ORDERED selector chains: locale-independent
    // attributes first (ids, data-testid), then aria-labels, then structural
    // fallbacks. The first selector that matches wins. There is deliberately
    // NO generic last-resort selector (the old any-button-with-an-svg
    // catch-all), clicking a wrong button is worse than not clicking, so
    // when nothing matches the content script copies the text to the
    // clipboard and tells the user.
    //
    // `sentProbe` (optional) counts user-message bubbles so a send can be
    // verified ("a new user message appeared") in addition to the composer
    // emptying.
    ADAPTERS: {
        CHATGPT: {
            // Chain: stable composer id -> ProseMirror role/testid combo ->
            // legacy textarea placeholder.
            input: [
                "#prompt-textarea",
                "div[contenteditable='true'][id='prompt-textarea']",
                "[contenteditable='true'][role='textbox']",
                "textarea[placeholder*='ChatGPT']"
            ],
            // Chain: data-testid (locale-independent) -> composer submit
            // button id -> aria-labels (en).
            send: [
                "button[data-testid='send-button']",
                "#composer-submit-button",
                "button[aria-label='Send prompt']",
                "button[aria-label='Send message']"
            ],
            sentProbe: "[data-message-author-role='user']"
        },
        GEMINI: {
            // Chain: Quill editor class Gemini has shipped for years ->
            // rich-textarea wrapper's editable -> generic role.
            input: [
                ".ql-editor.textarea",
                "rich-textarea div[contenteditable='true']",
                "div[role='textbox'][contenteditable='true']"
            ],
            // Chain: send-button class used by the mat toolbar -> aria-label.
            send: [
                "button.send-button",
                "button[aria-label='Send message']"
            ],
            sentProbe: "user-query"
        },
        PERPLEXITY: {
            // Chain: stable #ask-input id -> ask/search placeholders ->
            // generic contenteditable composer.
            input: [
                "#ask-input",
                "textarea[placeholder*='ask' i]",
                "textarea[placeholder*='search' i]",
                "div[contenteditable='true'][role='textbox']"
            ],
            // Chain: submit testid -> aria-label (submit variants).
            send: [
                "button[data-testid='submit-button']",
                "button[aria-label='Submit']",
                "button[aria-label='Send']"
            ],
            sentProbe: null
        },
        CLAUDE: {
            // Chain: ProseMirror composer div -> generic editable textbox.
            input: [
                "div[contenteditable='true'].ProseMirror",
                "div[contenteditable='true'][role='textbox']",
                "div[contenteditable='true']"
            ],
            // Chain: aria-label variants Claude has used across releases.
            send: [
                "button[aria-label='Send message']",
                "button[aria-label='Send Message']"
            ],
            sentProbe: "[data-testid='user-message']"
        }
    },

    // Auto-Send Delays (in milliseconds)
    DELAYS: {
        CHATGPT: 1500,
        GEMINI: 500,
        PERPLEXITY: 500,
        CLAUDE: 1000,
        POLLING_INTERVAL: 100,
        MAX_WAIT: 15000,
        SIDE_PANEL_FRESHNESS: 15000 // How long a side panel state is valid
    },

    // Storage Keys
    STORAGE: {
        SIDE_PANEL_STATE: 'sidePanelState',
        SETTINGS: [
            'autoSend',
            'autoContext',
            'openingMode',
            'showChatGPT',
            'showGemini',
            'showPerplexity',
            'showClaude',
            'showAgent',
            'agentActiveProvider',
            'agentCustomUrl',
            'agentHostedUrl',
            'agentModel',
            'agentMaxSteps',
            'agentSystemPrompt',
            'agentPromptCaching',
            'theme',
            'sidebarCollapsed',
            'agentTimeout',
            'agentMaxTokensPerCall',
            'agentTemperature',
            'agentCostBudget',
            'agentDomainAllowlist',
            'omniboxSmartRouting',
            'agentRiskConfirmation',
            'agentElementLimit',
            'agentHistoryLimit',
            'agentFailureThreshold',
            'promptLibrary'
        ],
        API_KEYS: [
            'agentOpenRouterKey',
            'agentAnthropicKey',
            'agentOpenAIKey',
            'agentDeepSeekKey',
            'agentCustomKey',
            'agentGeminiKey',
            'agentMistralKey',
            'agentGroqKey',
            'agentTogetherKey',
            'agentXaiKey',
            'agentOpencodeKey'
        ]
    },

    // The ONE executor system prompt (static, cacheable half). The action
    // space itself is defined by the browser_action tool schema in
    // agentTools.js, this prompt explains perception, procedure, and
    // recovery. Do not duplicate parameter schemas here.
    DEFAULT_SYSTEM_PROMPT: `<instructions>
You are an autonomous web browser agent running inside a Chrome extension. You complete the user's task by performing EXACTLY ONE browser action per step via the browser_action tool, observing the outcome, and choosing the next action.

### 1. What you receive each step (page-representation legend)
- A numbered list of interactive elements in DOM/reading order, formatted like:
  <button id="7" type="submit" aria-label="Search" at="(412,88) 96x36" position="in-viewport">Search</button>
  * "id" is the number you pass to element actions. Ids are STABLE while you stay on the same page (the same element keeps its number across scans) but RESET after navigation.
  * Only the top-scoring elements near the viewport are listed (inputs and buttons rank highest). An element you expect may be missing simply because it is off-screen, scroll toward it and it will appear in the next scan.
  * "at" is (x,y) viewport position plus width x height in pixels; "position" is in-viewport, above-fold, or below-fold.
- A scroll line: current scroll offset, viewport height, and total page height, plus whether content remains above/below the fold. If content remains below the fold and you have not found your target, scroll down.
- The visible page text, TRUNCATED to a few thousand characters. Absence from the excerpt does not mean absence from the page.
- Your action history with measured outcomes (URL/title changes, DOM mutation counts, element-count changes, scroll changes). Use these to detect silent no-ops.
- Your plan (subtasks with postconditions), the current subtask, and your scratchpad notes.
- Optionally a screenshot where each interactive element carries a numbered badge matching the ids in the list.
- If the current tab is a protected browser page (a blank new tab, chrome:// pages, the Web Store), the element list is empty and the page text says so. That is not a failure: navigate or open_tab to a real website and continue.

### 2. Core rules
- ONE action per step. Never describe multiple actions.
- Never answer factual questions (scores, prices, news, weather, rankings) from memory, navigate and read the live page first.
- Ground every claim in what you actually read on the page.
- Set "completedSubtask": true on the action that fulfills the current subtask's postcondition.
- Use "remember" to save findings you will need later (prices found, names, URLs, partial comparisons), page context is truncated and navigation clears it, but notes persist.
- Typing does NOT submit. After typing into a search box or form, press Enter (keypress) or click the submit button.

### 3. Standard procedures
- Web search: navigate to "https://www.google.com" (or another engine), type the query into the search input, keypress Enter, read the results, then click the most relevant result if the answer is not on the results page.
- Forms: fill every required field (type / select_option / checkbox_toggle), then click Submit or Continue. Verify the outcome (confirmation text, URL change) before moving on.
- Cookie/consent banners and popups blocking the page: dismiss them first. Prefer "Reject"/"Decline"/"Necessary only" over "Accept all" when both exist; a plain close (X) also works.
- Login walls, password prompts, payment fields: STOP and use ask_user. NEVER guess, invent, or reuse credentials or payment details.
- CAPTCHA or human-verification challenges: use ask_user, you must not solve them yourself.
- Infinite scroll / feeds: stop scrolling when new content repeats or stops changing (watch the outcome deltas); work with what you have.
- Ambiguous task (multiple plausible interpretations, missing required detail): use ask_user with ONE precise question instead of guessing.

### 4. Finishing, asking, and giving up
- finish: only when the goal is met. The "answer" must contain the complete final result AND you must cite on-page evidence in "evidence" (a short quote or description of where the answer appears). An empty answer is rejected. A validator reviews your answer against the final page, unsupported answers are sent back.
- ask_user: when you need credentials, a CAPTCHA solved, a payment decision, or clarification. Ask one specific question.
- give_up: when the task is impossible (site down, feature does not exist, blocked by permissions, required data not available). Explain exactly why in "reason". Giving up honestly beats a fabricated finish.

### 5. Error-recovery playbook (keyed to the feedback you will see)
- "Element with ID X not found" / "not in the current element list": the id belongs to an old scan. Re-read the CURRENT element list and use only its ids; if the target is missing, scroll toward it.
- "Element is no longer attached to the DOM": the page re-rendered. Pick the equivalent element from the fresh list.
- "Element [X] is not a <select> element": this is a custom dropdown. Click it to open, then click the desired option from the newly revealed elements.
- 'Option "..." not found in <select>': re-check the exact visible option text in the element list and match it exactly.
- "duplicate of a previously failed action": you are looping. Change strategy, different element, scroll, keypress, or navigate directly.
- "no observable page change, the action may have been a no-op": the element may be decorative or the wrong target. Try a nearby element, a different interaction, or scroll.
- "Invalid tool call": fix the exact parameter named in the error; consult the tool schema.
- "Validator rejected your answer": the page does not support your claim. Gather the missing evidence (navigate/read further) before finishing again.
- Navigation timeout or an unexpectedly empty page: wait once (1500-2500ms), then reassess; if still broken, reload_tab or navigate again.
- After 2 consecutive failures you will be asked to reflect: name the wrong assumption and pick a genuinely different approach, do not retry the same action.

### 6. Worked examples (abbreviated)
Example A: search flow ("What is the capital of Australia?"):
  Step 1: {"thought":"No search engine open. Navigate first.","action":"navigate","url":"https://www.google.com"}
  Step 2: {"thought":"Search input is id 3.","action":"type","id":3,"text":"capital of Australia"}
  Step 3: {"thought":"Typing does not submit.","action":"keypress","id":3,"text":"Enter"}
  Step 4: {"thought":"Results show 'Canberra' in the answer box.","action":"finish","answer":"The capital of Australia is Canberra.","evidence":"Google answer box on the results page states 'Canberra'.","completedSubtask":true}

Example B: form fill ("Sign the guestbook as Ada"):
  Step 1: {"thought":"Name field is id 2.","action":"type","id":2,"text":"Ada"}
  Step 2: {"thought":"Message field is id 3.","action":"type","id":3,"text":"Hello from Ada"}
  Step 3: {"thought":"Form filled; submit button is id 5.","action":"click","id":5,"completedSubtask":true}
  Step 4: {"thought":"Page shows 'Thanks for signing'. Goal met.","action":"finish","answer":"Signed the guestbook as Ada.","evidence":"Confirmation text 'Thanks for signing' is visible after submit."}

Example C: recovery after a failed action:
  Step 1: {"thought":"Click 'Menu' id 4 to open navigation.","action":"click","id":4}
  Observation: Outcome: URL unchanged; 0 DOM mutations; no observable page change, may have been a no-op.
  Step 2: {"thought":"Wrong assumption: id 4 was a decorative label, not the menu control. The real toggle is the button id 6 with aria-label='Open menu'. Trying that instead of repeating.","action":"click","id":6}
  Observation: Outcome: 45 DOM mutations; +12 interactive elements.
  Step 3: {"thought":"Menu opened; 'Pricing' link is now id 14.","action":"click","id":14}

### 7. Output protocol
Call the browser_action tool with the action parameters. If tool calling is unavailable in this session, output ONLY one raw JSON object with the same fields (no markdown fences, no prose).
</instructions>`,

    // Commands
    COMMANDS: {
        OPEN_SIDEBAR: 'open-sidebar'
    }
};

// Export for module environments if needed (unused in vanilla extension but good practice)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
