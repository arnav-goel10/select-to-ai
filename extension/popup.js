/**
 * Select to AI - Popup Logic
 * Handles user settings, theme toggling, and opening the sidebar/options manually.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Verify CONFIG is loaded
    if (typeof CONFIG === 'undefined') {
        console.error("Select to AI: CONFIG not loaded in popup.");
        return;
    }

    const { STORAGE, URLS, HOSTS } = CONFIG;

    // DOM Elements
    const autoSendToggle = document.getElementById('autoSend');
    const autoContextToggle = document.getElementById('autoContext');
    const openingModeSelect = document.getElementById('openingMode');
    const openSidebarBtn = document.getElementById('openSidebarBtn');
    
    // AI Browser Agent Settings elements
    const agentSettingsPanel = document.getElementById('agent-settings');
    const openOptionsBtn = document.getElementById('openOptionsBtn');

    // Service Toggles map
    const serviceToggles = {
        chatgpt: document.getElementById('chatgpt'),
        gemini: document.getElementById('gemini'),
        perplexity: document.getElementById('perplexity'),
        claude: document.getElementById('claude'),
        agent: document.getElementById('agent')
    };
    const serviceKeys = ['chatgpt', 'gemini', 'perplexity', 'claude', 'agent'];

    // --- Initialization ---

    // Load saved settings
    chrome.storage.sync.get(STORAGE.SETTINGS, (items) => {
        autoSendToggle.checked = items.autoSend === true;
        autoContextToggle.checked = items.autoContext !== false; // Default true

        // Theme initialization
        const theme = items.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);

        // Robust Opening Mode Logic
        let mode = items.openingMode;
        if (!mode) {
            mode = 'sidePanel';
            chrome.storage.sync.set({ openingMode: mode });
        }

        const validOptions = ['tab', 'sidePanel'];
        if (!validOptions.includes(mode)) {
            mode = 'sidePanel'; // Fallback
            chrome.storage.sync.set({ openingMode: mode });
        }

        openingModeSelect.value = mode;

        // Load Service Toggles
        serviceToggles.chatgpt.checked = items.showChatGPT !== false;
        serviceToggles.gemini.checked = items.showGemini !== false;
        serviceToggles.perplexity.checked = items.showPerplexity === true;
        serviceToggles.claude.checked = items.showClaude !== false;
        serviceToggles.agent.checked = items.showAgent === true;

        // Show/hide Agent settings panel based on checked state
        toggleSettingsPanel(serviceToggles.agent.checked);
    });

    // --- Event Listeners ---

    // Settings Toggles
    autoSendToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ autoSend: autoSendToggle.checked });
    });

    autoContextToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ autoContext: autoContextToggle.checked });
    });

    openingModeSelect.addEventListener('change', () => {
        chrome.storage.sync.set({ openingMode: openingModeSelect.value });
    });

    // Redirect to Advanced Options Dashboard
    openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Helper to toggle panel visibility
    function toggleSettingsPanel(show) {
        if (show) {
            agentSettingsPanel.style.display = "flex";
        } else {
            agentSettingsPanel.style.display = "none";
        }
    }

    // Service Visibility Toggles
    serviceKeys.forEach(key => {
        serviceToggles[key].addEventListener('change', () => {
            const isChecked = serviceToggles[key].checked;

            if (!isChecked) {
                // Prevent disabling all services
                const anyChecked = serviceKeys.some(k => serviceToggles[k].checked);
                if (!anyChecked) {
                    serviceToggles[key].checked = true;
                    return; // Abort change
                }
            }

            if (key === 'agent') {
                toggleSettingsPanel(isChecked);
            }

            // Save new state
            const settingKey = getSettingKey(key);
            chrome.storage.sync.set({ [settingKey]: isChecked });
        });
    });

    // openSidebarBtn Logic
    openSidebarBtn.addEventListener('click', () => {
        // Determine which service to open (Prefer last used, then Default)
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
                        // Open the side panel in the current window
                        chrome.windows.getCurrent((win) => {
                            chrome.sidePanel.open({ windowId: win.id });
                        });
                    });
                });
            });
        });
    });

    // Handle Theme Toggle
    const themeToggleBtn = document.getElementById('theme-toggle');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            chrome.storage.sync.set({ theme: newTheme });
        });
    }

    function getSettingKey(key) {
        if (key === 'chatgpt') return 'showChatGPT';
        if (key === 'gemini') return 'showGemini';
        if (key === 'perplexity') return 'showPerplexity';
        if (key === 'claude') return 'showClaude';
        if (key === 'agent') return 'showAgent';
        return `show${key.charAt(0).toUpperCase() + key.slice(1)}`;
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
