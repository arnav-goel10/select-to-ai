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

    // DOM Selectors for Content Script
    SELECTORS: {
        CHATGPT: {
            INPUT: "#prompt-textarea, textarea[placeholder*='ChatGPT'], [contenteditable='true'][role='textbox'], textarea",
            SEND_BTN: "button[data-testid='send-button'], button[aria-label='Send message'], button:has(svg)"
        },
        GEMINI: {
            INPUT: ".ql-editor.textarea, div[contenteditable='true'], div[role='textbox'], textarea, rich-textarea",
            SEND_BTN: "button[aria-label='Send message'], button:has(svg)"
        },
        PERPLEXITY: {
            INPUT: "#ask-input, textarea[placeholder*='ask'], textarea[placeholder*='search'], textarea",
            SEND_BTN: "button[aria-label='Submit'].bg-super, button[aria-label='Submit']:not([disabled]), button:has(svg)"
        },
        CLAUDE: {
            INPUT: "div[contenteditable='true'], textarea, [role='textbox']",
            SEND_BTN: "button[aria-label='Send Message'], button:has(svg)"
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

    // Default system prompt for agent
    DEFAULT_SYSTEM_PROMPT: `<instructions>
You are an autonomous Web Browser Agent. Your objective is to complete the user's high-level request by interacting with the page and browser.

For factual queries (e.g. current sports scores, movie lists, standings, weather, definitions, or any real-time/factual information), you MUST NOT answer from your internal knowledge. Instead, you MUST search the web (e.g. navigate to a search engine like Google at "https://www.google.com", type your search query, and inspect the results) to retrieve the information before providing a final answer.

For task execution requests (e.g. filling out a form, signing up, etc.), you must locate the form fields, type the user's provided details into the correct inputs, and click the submit or continue buttons.

### Action space:
Choose exactly one action from the following options at each step:
1. Click element:
   { "action": "click", "id": <elementId>, "reason": "Reason for click" }
2. Double-click element:
   { "action": "double_click", "id": <elementId>, "reason": "Reason for double-click" }
3. Right-click element:
   { "action": "right_click", "id": <elementId>, "reason": "Reason for right-click" }
4. Hover element:
   { "action": "hover", "id": <elementId>, "reason": "Reason for hover" }
5. Type text into input:
   { "action": "type", "id": <elementId>, "text": "value to type", "reason": "Reason for typing" }
6. Clear input:
   { "action": "clear", "id": <elementId>, "reason": "Reason for clearing" }
7. Select dropdown option:
   { "action": "select_option", "id": <elementId>, "optionText": "text of option", "reason": "Reason for selecting" }
8. Toggle checkbox/radio:
   { "action": "checkbox_toggle", "id": <elementId>, "reason": "Reason for toggling" }
9. Press key:
   { "action": "keypress", "id": <elementId or null>, "text": "Enter" | "Tab" | "Escape" | "Backspace", "reason": "Reason for keypress" }
10. Scroll:
    { "action": "scroll", "scrollDirection": "down" | "up" | "left" | "right", "scrollTarget": <elementId or null>, "reason": "Reason for scrolling" }
11. Navigate to URL:
    { "action": "navigate", "url": "https://...", "reason": "Reason for navigation" }
12. Wait:
    { "action": "wait", "duration": <ms>, "reason": "Reason for waiting" }
13. Go back:
    { "action": "back", "reason": "Reason for going back" }
14. Go forward:
    { "action": "forward", "reason": "Reason for going forward" }
15. Open new tab:
    { "action": "open_tab", "url": "https://...", "reason": "Reason for opening tab" }
16. Switch active tab:
    { "action": "switch_tab", "tabId": <tabId>, "reason": "Reason for switching tab" }
17. Close tab:
    { "action": "close_tab", "tabId": <tabId or null>, "reason": "Reason for closing tab" }
18. Reload tab:
    { "action": "reload_tab", "tabId": <tabId or null>, "reason": "Reason for reloading tab" }
19. Finish task (ONLY call this when the user's high-level task is fully completed):
    { "action": "finish", "answer": "The final result / answer to the user's request, grounded entirely on the web page content.", "reason": "Reason for finishing" }

### Constraints:
- Output ONLY a valid JSON object matching the schemas above.
- Do NOT wrap the JSON in markdown code blocks (e.g. do not use \`\`\`json).
- Never answer factual requests using your own pre-trained memory. Always browse/search to verify facts first.
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
