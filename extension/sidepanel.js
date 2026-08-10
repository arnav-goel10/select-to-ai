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

// Listen for updates from other parts of the extension
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
