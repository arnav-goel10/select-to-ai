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
            // Sep 2026: chatgpt.com moved to a new build whose composer is
            // textarea#mobile-composer-prompt at every width; the older
            // ProseMirror #prompt-textarea stays as a fallback.
            input: [
                "#mobile-composer-prompt",
                "textarea[aria-label='Chat with ChatGPT']",
                "#prompt-textarea",
                "div[contenteditable='true'][id='prompt-textarea']",
                "[contenteditable='true'][role='textbox']",
                "form textarea[placeholder]",
                "textarea[placeholder*='ChatGPT']"
            ],
            // Chain: data-testid (locale-independent) -> composer submit
            // button id -> aria-labels (en).
            send: [
                "button[data-testid='send-button']",
                "#composer-submit-button",
                "form button[type='submit'][aria-label='Send message']",
                "button[aria-label='Send message']",
                "button[aria-label='Send prompt']"
            ],
            sentProbe: "[data-message-role='user'], [data-message-author-role='user']"
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
            'agentBackupProvider',
            'agentCustomUrl',
            'agentModel',
            'agentHelperModel',
            'agentCheckInMinutes',
            'theme',
            'sidebarCollapsed',
            'agentCostBudget',
            'agentDomainAllowlist',
            'agentRiskConfirmation',
            'agentExtraInstructions',
            'agentLearning',
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
            'agentOpencodeKey',
            'agentCerebrasKey'
        ]
    },

    // Commands
    COMMANDS: {
        OPEN_SIDEBAR: 'open-sidebar',
        OPEN_PALETTE: 'open-palette'
    }
};

// Export for module environments if needed (unused in vanilla extension but good practice)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
