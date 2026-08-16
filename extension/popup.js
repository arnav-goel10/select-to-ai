/**
 * Select to AI - Popup Logic
 *
 * The popup is a launcher: open the sidebar, open the browser agent, open
 * settings, and pick the opening mode. Per-service toggles and behavioral
 * defaults live in Options only (their single home).
 */

document.addEventListener('DOMContentLoaded', () => {
    // Verify CONFIG is loaded
    if (typeof CONFIG === 'undefined') {
        console.error("Select to AI: CONFIG not loaded in popup.");
        return;
    }

    const { STORAGE, URLS, HOSTS } = CONFIG;

    // DOM Elements
    const openingModeSelect = document.getElementById('openingMode');
    const openSidebarBtn = document.getElementById('openSidebarBtn');
    const openAgentBtn = document.getElementById('openAgentBtn');
    const openAgentLabel = document.getElementById('openAgentLabel');
    const agentDisabledHint = document.getElementById('agentDisabledHint');
    const openOptionsBtn = document.getElementById('openOptionsBtn');
    const themeToggleBtn = document.getElementById('theme-toggle');

    let agentEnabled = false;

    // --- Initialization ---

    chrome.storage.sync.get(STORAGE.SETTINGS, (items) => {
        // Theme: stored preference with system fallback (shared mechanism).
        const theme = items.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeToggleLabel(theme);

        // Opening mode with validation fallback.
        let mode = items.openingMode;
        if (!['tab', 'sidePanel'].includes(mode)) {
            mode = 'sidePanel';
            chrome.storage.sync.set({ openingMode: mode });
        }
        openingModeSelect.value = mode;

        // Agent gate: the "Enable AI Browser Agent" setting in Options is the
        // one master switch for every agent entry point (popup, Alt+A,
        // address bar, side panel dropdown, context menu).
        agentEnabled = items.showAgent === true;
        if (!agentEnabled) {
            openAgentLabel.textContent = 'Browser Agent (off) · Settings';
            agentDisabledHint.classList.remove('u-hidden');
        }
    });

    // --- Event Listeners ---

    openingModeSelect.addEventListener('change', () => {
        chrome.storage.sync.set({ openingMode: openingModeSelect.value });
    });

    openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    openAgentBtn.addEventListener('click', () => {
        if (!agentEnabled) {
            // Same gate as every other entry point: point the user at the
            // Options switch instead of silently opening a disabled surface.
            chrome.runtime.openOptionsPage();
            return;
        }

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs && tabs[0];
            const agentUrl = chrome.runtime.getURL('agent.html') +
                (activeTab && activeTab.id ? `?tabId=${activeTab.id}` : '');

            chrome.storage.sync.get(['openingMode'], (settings) => {
                if (settings.openingMode === 'tab') {
                    chrome.tabs.create({ url: agentUrl });
                    return;
                }
                chrome.storage.local.set({
                    sidePanelState: {
                        url: agentUrl,
                        selectedText: '',
                        autoSend: false,
                        timestamp: Date.now()
                    }
                }, () => {
                    chrome.windows.getCurrent((win) => {
                        chrome.sidePanel.open({ windowId: win.id });
                    });
                });
            });
        });
    });

    // openSidebarBtn: open the last-used (or first enabled) assistant.
    openSidebarBtn.addEventListener('click', () => {
        chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], (localState) => {
            chrome.storage.sync.get(STORAGE.SETTINGS, (settings) => {
                let targetBaseUrl = URLS.CHATGPT; // Default fallback (ChatGPT)

                const showChatGPT = settings.showChatGPT !== false;
                const showGemini = settings.showGemini !== false;
                const showPerplexity = settings.showPerplexity === true;
                const showClaude = settings.showClaude !== false;
                const showAgent = settings.showAgent === true;

                // 1. Check Last Used
                if (localState[STORAGE.SIDE_PANEL_STATE] && localState[STORAGE.SIDE_PANEL_STATE].url) {
                    targetBaseUrl = localState[STORAGE.SIDE_PANEL_STATE].url;

                    // Verify if that service is still enabled
                    let isEnabled = true;
                    if (targetBaseUrl.includes(HOSTS.CHATGPT) && !showChatGPT) isEnabled = false;
                    else if (targetBaseUrl.includes(HOSTS.GEMINI) && !showGemini) isEnabled = false;
                    else if (targetBaseUrl.includes(HOSTS.PERPLEXITY) && !showPerplexity) isEnabled = false;
                    else if (targetBaseUrl.includes(HOSTS.CLAUDE) && !showClaude) isEnabled = false;
                    else if (targetBaseUrl.includes(HOSTS.AGENT) && !showAgent) isEnabled = false;

                    if (!isEnabled) {
                        targetBaseUrl = getFallbackUrl(settings);
                    }
                } else {
                    // 2. No history: Default Hierarchy
                    targetBaseUrl = getFallbackUrl(settings);
                }

                // Helper to resolve session URL
                const resolveSession = (baseUrl, callback) => {
                    let hostname = "";
                    if (baseUrl.includes(HOSTS.CHATGPT)) hostname = HOSTS.CHATGPT;
                    else if (baseUrl.includes(HOSTS.GEMINI)) hostname = HOSTS.GEMINI;
                    else if (baseUrl.includes(HOSTS.PERPLEXITY)) hostname = HOSTS.PERPLEXITY_WWW;
                    else if (baseUrl.includes(HOSTS.CLAUDE)) hostname = HOSTS.CLAUDE;
                    else if (baseUrl.includes(HOSTS.AGENT)) hostname = HOSTS.AGENT;

                    if (!hostname) {
                        callback(baseUrl);
                        return;
                    }

                    const storageKey = `sessionUrl_${hostname}`;
                    chrome.storage.local.get([storageKey], (result) => {
                        const savedUrl = result[storageKey];
                        if (savedUrl && savedUrl.includes(hostname)) {
                            callback(savedUrl);
                        } else {
                            callback(baseUrl);
                        }
                    });
                };

                resolveSession(targetBaseUrl, (finalUrl) => {
                    // Save state and open side panel
                    chrome.storage.local.set({
                        sidePanelState: {
                            url: finalUrl,
                            selectedText: '',
                            autoSend: false,
                            timestamp: Date.now()
                        }
                    }, () => {
                        chrome.windows.getCurrent((win) => {
                            chrome.sidePanel.open({ windowId: win.id });
                        });
                    });
                });
            });
        });
    });

    // Theme toggle: shared stored-preference mechanism.
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            updateThemeToggleLabel(newTheme);
            chrome.storage.sync.set({ theme: newTheme });
        });
    }

    function updateThemeToggleLabel(theme) {
        if (!themeToggleBtn) return;
        themeToggleBtn.setAttribute(
            'aria-label',
            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
        );
    }

    function getFallbackUrl(settings) {
        if (settings.showChatGPT !== false) return URLS.CHATGPT;
        if (settings.showGemini !== false) return URLS.GEMINI;
        if (settings.showClaude !== false) return URLS.CLAUDE;
        if (settings.showPerplexity === true) return URLS.PERPLEXITY;
        if (settings.showAgent === true) return URLS.AGENT;
        return URLS.CHATGPT;
    }
});
