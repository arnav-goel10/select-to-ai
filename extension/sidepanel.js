/**
 * Select to AI - Side Panel Logic
 *
 * The side panel holds one frame. With the agent switched on it shows the
 * agent (agent.html, the same view as the full page at a narrow width); an
 * assistant site (ChatGPT, Claude, Gemini, Perplexity) is shown when a
 * right-click asks for one or the user picks one, with a bar to go back.
 * With the agent off it shows the assistants as before.
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
const bar = document.getElementById('spBar');
const backBtn = document.getElementById('backToAgentBtn');
const emptyState = document.getElementById('emptyState');

// A hand-off written this long ago or less is a request to show that page now.
const FRESH_MS = 15000;
let agentOn = false;

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

const isAgentUrl = (url) => String(url || '').includes(HOSTS.AGENT);
const agentUrl = () => chrome.runtime.getURL('agent.html');

/** Shows a page in the frame; the bar is there only for an assistant site. */
function show(url) {
    emptyState.hidden = true;
    iframe.hidden = false;
    if (iframe.src !== url && iframe.getAttribute('src') !== url) iframe.src = url;
    const agent = isAgentUrl(url);
    bar.hidden = agent;
    backBtn.hidden = !agentOn;
    iframe.title = agent ? 'Select to AI agent' : 'Assistant site';
    if (!agent) syncSelector(url);
}

/** The picker entry an assistant address belongs to, or '' for none. */
function siteOf(url) {
    const u = String(url || '');
    if (u.includes(HOSTS.CHATGPT)) return URLS.CHATGPT;
    if (u.includes(HOSTS.GEMINI)) return URLS.GEMINI;
    if (u.includes(HOSTS.PERPLEXITY)) return URLS.PERPLEXITY;
    if (u.includes(HOSTS.CLAUDE)) return URLS.CLAUDE;
    return '';
}

function syncSelector(url) {
    const site = siteOf(url);
    if (site) selector.value = site;
}

/** Whether the picker lists the assistant this address is on. */
const listed = (url) => Array.from(selector.options).some((o) => o.value === siteOf(url));

/** Nothing to show: every assistant is off and so is the agent. */
function showEmpty() {
    bar.hidden = true;
    iframe.hidden = true;
    if (iframe.getAttribute('src') !== 'about:blank') iframe.src = 'about:blank';
    emptyState.hidden = false;
}

// claude.ai is optional in 4.0: until it is granted the panel cannot load it.
function hasClaude() {
    return new Promise((resolve) => {
        try {
            chrome.permissions.contains({ origins: ['https://claude.ai/*'] }, (ok) => {
                void chrome.runtime.lastError;
                resolve(ok === true);
            });
        } catch (e) {
            resolve(false);
        }
    });
}

document.getElementById('emptyStateSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// --- Event Listeners ---

// Handle manual switching via dropdown
selector.addEventListener('change', () => {
    const url = selector.value;
    show(url);

    // Persist the change so a later open of the same assistant restores it
    chrome.storage.local.set({
        sidePanelState: {
            url: url,
            selectedText: '', // Reset text on manual switch
            autoSend: false,
            timestamp: Date.now()
        }
    });
});

backBtn.addEventListener('click', () => {
    chrome.storage.local.set({
        sidePanelState: { url: agentUrl(), selectedText: '', autoSend: false, timestamp: Date.now() }
    });
});

// Send this page's address to the assistant shown
redoBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        const tab = tabs[0];

        // Construct Context Message
        const contextMsg = `Context: ${tab.url}\n\n`;
        const currentServiceUrl = iframe.src;

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
    if (namespace === 'sync' && changes.showAgent) {
        agentOn = changes.showAgent.newValue === true;
        backBtn.hidden = !agentOn;
    }
});

// --- Core Logic ---

/**
 * Updates the side panel UI based on the provided state.
 * @param {object} state - The sidePanelState object from storage.
 */
function updateState(state) {
    if (!state || !state.url) return;
    show(state.url);
}

// --- Initialization ---

Promise.all([
    new Promise(resolve => chrome.storage.sync.get(['showChatGPT', 'showGemini', 'showPerplexity', 'showClaude', 'showAgent'], resolve)),
    new Promise(resolve => chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], resolve)),
    hasClaude()
]).then(([settings, items, claudeGranted]) => {
    agentOn = settings.showAgent === true;

    // 1. The assistant picker
    selector.textContent = '';
    const addOption = (value, text) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        selector.appendChild(opt);
    };

    if (settings.showChatGPT !== false) addOption(URLS.CHATGPT, "ChatGPT");
    if (settings.showGemini !== false) addOption(URLS.GEMINI, "Gemini");
    if (settings.showClaude !== false && claudeGranted) addOption(URLS.CLAUDE, "Claude");
    if (settings.showPerplexity === true) addOption(URLS.PERPLEXITY, "Perplexity");

    // 2. What to show. A hand-off that was just written (a right-click,
    // Alt+A, the address bar) is shown. Otherwise the agent when it is on,
    // or the last-used assistant when it is off.
    const state = items[STORAGE.SIDE_PANEL_STATE];
    const fresh = !!(state && state.url && Date.now() - (state.timestamp || 0) < FRESH_MS);
    const agentState = !!(state && isAgentUrl(state.url));
    // Every assistant off and the agent off: an old hand-off is not shown.
    if (!agentOn && selector.options.length === 0) { showEmpty(); return; }
    // A saved assistant the picker no longer lists (turned off, or claude.ai
    // not granted, so its frame would be refused) is not loaded; the first
    // listed one is shown instead.
    const usable = !!(state && state.url && (agentState || listed(state.url)));
    if (usable && (agentOn ? fresh || agentState : !agentState)) { updateState(state); return; }
    if (agentOn) { show(agentUrl()); return; }

    // Default load (direct open): the first assistant, at its saved conversation.
    if (selector.options.length === 0) { showEmpty(); return; }
    const defaultUrl = selector.value;
    let hostname = "";
    if (defaultUrl.includes(HOSTS.CHATGPT)) hostname = HOSTS.CHATGPT;
    else if (defaultUrl.includes(HOSTS.GEMINI)) hostname = HOSTS.GEMINI;
    else if (defaultUrl.includes(HOSTS.PERPLEXITY)) hostname = HOSTS.PERPLEXITY_WWW;
    else if (defaultUrl.includes(HOSTS.CLAUDE)) hostname = HOSTS.CLAUDE;

    const storageKey = `sessionUrl_${hostname}`;
    chrome.storage.local.get([storageKey], (res) => {
        const savedUrl = res[storageKey];
        show(savedUrl && savedUrl.includes(hostname) ? savedUrl : defaultUrl);
    });
});
