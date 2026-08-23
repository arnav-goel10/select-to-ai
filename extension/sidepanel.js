/**
 * Select to AI - Side Panel Logic
 * Manages the iframe displaying the AI service and state synchronization.
 */

// Verify CONFIG is loaded
if (typeof CONFIG === 'undefined') {
    console.error("Select to AI: CONFIG not loaded in sidepanel.");
}

const { STORAGE, URLS, HOSTS } = CONFIG;

// DOM Elements
const iframe = document.getElementById('contentFrame');
const selector = document.getElementById('serviceSelector');
const redoBtn = document.getElementById('redoContextBtn');

// --- Theme (shared mechanism: stored preference with system fallback) ---
function applyTheme(storedTheme) {
    const theme = storedTheme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
}

chrome.storage.sync.get(['theme'], (items) => applyTheme(items.theme));
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.theme) {
        applyTheme(changes.theme.newValue);
    }
});

// --- Event Listeners ---

// Handle manual switching via dropdown
selector.addEventListener('change', () => {
    const url = selector.value;
    console.log("Switching service to:", url);
    iframe.src = url;

    // Persist the change so it becomes the new default
    chrome.storage.local.set({
        sidePanelState: {
            url: url,
            selectedText: '', // Reset text on manual switch
            autoSend: false,
            timestamp: Date.now()
        }
    });
});

// Handle 'Redo Context' / Reload button
redoBtn.addEventListener('click', () => {
    // animated rotation effect
    redoBtn.style.transform = 'rotate(180deg)';
    setTimeout(() => { redoBtn.style.transform = ''; }, 300);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        const tab = tabs[0];

        // Construct Context Message
        const contextMsg = `Context: ${tab.url}\n\n`;
        const currentServiceUrl = iframe.src;

        console.log("Sending Context:", contextMsg);

        // Update storage to trigger content script injection
        chrome.storage.local.set({
            sidePanelState: {
                url: currentServiceUrl,
                selectedText: contextMsg,
                autoSend: false, // Let user edit before sending
                insertMode: 'prepend', // Prepend to existing text
                timestamp: Date.now()
            }
        });
    });
});

// --- Companion quick actions ---
// Chips above the iframe: read the active tab's visible text (scripting on
// the active tab) and hand a grounded prompt to the agent view.
(function initQuickActions() {
    const bar = document.createElement('div');
    bar.id = 'companion-quickbar';
    bar.style.cssText = 'display:flex;gap:6px;padding:6px 10px;overflow-x:auto;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--surface);';

    const actions = (window.SELECT_TO_AI_COMPANION && window.SELECT_TO_AI_COMPANION.QUICK_ACTIONS) || [];
    actions.forEach((action) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = action.label;
        chip.title = 'Runs in the AI Browser Agent with this page as context';
        chip.style.cssText = 'white-space:nowrap;font-size:12px;padding:5px 10px;border-radius:var(--radius-full);border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;font-family:var(--font-sans);font-weight:600;';
        chip.addEventListener('mouseenter', () => { chip.style.background = 'var(--surface-2)'; });
        chip.addEventListener('mouseleave', () => { chip.style.background = 'var(--bg)'; });

        chip.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tab = tabs && tabs[0];
                if (!tab || !tab.id) return;
                // Pull readable text via the scripting API; falls back to
                // URL-only context when injection is not possible.
                chrome.scripting.executeScript(
                    {
                        target: { tabId: tab.id },
                        func: () => ({
                            url: window.location.href,
                            title: document.title,
                            text: document.body ? document.body.innerText : '',
                        }),
                    },
                    (results) => {
                        let payload = { url: tab.url || '', title: tab.title || '', text: '' };
                        if (chrome.runtime.lastError || !results || !results[0]) {
                            void chrome.runtime.lastError;
                        } else {
                            payload = results[0].result || payload;
                        }
                        const prompt = window.SELECT_TO_AI_COMPANION.buildQuickActionPrompt(
                            action.id, payload.url, payload.text,
                        );
                        if (!prompt) return;
                        // Hand the task to the agent page (loaded in this
                        // panel's iframe). The agent consumes the pending
                        // companionTask from storage on load.
                        chrome.storage.local.set(
                            { companionTask: { task: prompt, timestamp: Date.now() } },
                            () => {
                                iframe.src = CONFIG.URLS.AGENT;
                                selector.value = CONFIG.URLS.AGENT;
                            },
                        );
                    },
                );
            });
        });
        bar.appendChild(chip);
    });
    document.body.insertBefore(bar, iframe);
})();

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes[STORAGE.SIDE_PANEL_STATE]) {
        updateState(changes[STORAGE.SIDE_PANEL_STATE].newValue);
    }
});

// --- Core Logic ---

/**
 * Updates the side panel UI based on the provided state.
 * @param {object} state - The sidePanelState object from storage.
 */
function updateState(state) {
    if (!state || !state.url) return;

    // Only reload if URL changed
    if (iframe.src !== state.url) {
        console.log("Loading URL:", state.url);
        iframe.src = state.url;
    }

    // Sync dropdown with current URL
    if (state.url.includes(HOSTS.CHATGPT)) {
        selector.value = URLS.CHATGPT;
    } else if (state.url.includes(HOSTS.GEMINI)) {
        selector.value = URLS.GEMINI;
    } else if (state.url.includes(HOSTS.PERPLEXITY)) {
        selector.value = URLS.PERPLEXITY;
    } else if (state.url.includes(HOSTS.CLAUDE)) {
        selector.value = URLS.CLAUDE;
    } else if (state.url.includes(HOSTS.AGENT)) {
        selector.value = URLS.AGENT;
    }
}

// --- Initialization ---

// Check initial state on load - PARALLEL EXECUTION
Promise.all([
    new Promise(resolve => chrome.storage.sync.get(['showChatGPT', 'showGemini', 'showPerplexity', 'showClaude', 'showAgent'], resolve)),
    new Promise(resolve => chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], resolve))
]).then(([settings, items]) => {

    // 1. Setup Dropdown (UI)
    selector.innerHTML = '';
    const addOption = (value, text) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        selector.appendChild(opt);
    };

    if (settings.showChatGPT !== false) addOption(URLS.CHATGPT, "ChatGPT");
    if (settings.showGemini !== false) addOption(URLS.GEMINI, "Gemini");
    if (settings.showClaude !== false) addOption(URLS.CLAUDE, "Claude");
    if (settings.showPerplexity === true) addOption(URLS.PERPLEXITY, "Perplexity");
    if (settings.showAgent === true) addOption(URLS.AGENT, "AI Browser Agent");

    // 2. Load Content (Iframe) - Check state first
    if (items[STORAGE.SIDE_PANEL_STATE] && items[STORAGE.SIDE_PANEL_STATE].url) {
        updateState(items[STORAGE.SIDE_PANEL_STATE]);
    } else {
        // Default load (direct open) - Use first available option
        if (selector.options.length > 0) {
            const defaultUrl = selector.value;
            // Check for saved session for this default service
            let hostname = "";
            if (defaultUrl.includes(HOSTS.CHATGPT)) hostname = HOSTS.CHATGPT;
            else if (defaultUrl.includes(HOSTS.GEMINI)) hostname = HOSTS.GEMINI;
            else if (defaultUrl.includes(HOSTS.PERPLEXITY)) hostname = HOSTS.PERPLEXITY_WWW;
            else if (defaultUrl.includes(HOSTS.CLAUDE)) hostname = HOSTS.CLAUDE;
            else if (defaultUrl.includes(HOSTS.AGENT)) hostname = HOSTS.AGENT;

            if (hostname && hostname !== HOSTS.AGENT) {
                const storageKey = `sessionUrl_${hostname}`;
                chrome.storage.local.get([storageKey], (res) => {
                    const savedUrl = res[storageKey];
                    if (savedUrl && savedUrl.includes(hostname)) {
                        console.log("Restoring session on direct open:", savedUrl);
                        iframe.src = savedUrl;
                    } else {
                        iframe.src = defaultUrl;
                    }
                });
            } else {
                iframe.src = defaultUrl;
            }
        }
    }
});
