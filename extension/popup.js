/**
 * Select to AI - Popup Logic
 *
 * The popup is a task box for the agent plus three launchers (side panel,
 * agent tab, quick box). Every preference lives in Settings.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Verify CONFIG is loaded
    if (typeof CONFIG === 'undefined') {
        console.error("Select to AI: CONFIG not loaded in popup.");
        return;
    }

    const { STORAGE, URLS, HOSTS } = CONFIG;

    const $ = (id) => document.getElementById(id);
    const openSidebarBtn = $('openSidebarBtn');
    const openAgentBtn = $('openAgentBtn');
    const taskForm = $('taskForm');
    const taskInput = $('taskInput');
    const taskGo = $('taskGo');

    let agentEnabled = false;

    // Shortcut hints show the real bindings, which the user may have changed.
    const isMac = /Mac/i.test(navigator.platform);
    const pretty = (k) => (isMac ? k.replace(/Command|⌘/g, '⌘').replace(/Alt|Option/g, '⌥').replace(/Shift/g, '⇧').replace(/MacCtrl|Ctrl/g, '⌃').replace(/\+/g, '') : k.replace(/\+/g, ' '));
    if (chrome.commands && chrome.commands.getAll) {
        chrome.commands.getAll((cmds) => {
            const find = (n) => ((cmds || []).find((c) => c.name === n) || {}).shortcut;
            const palette = find('open-palette');
            const sidebar = find('open-sidebar');
            $('kbdPalette').hidden = !palette;
            $('kbdSidebar').hidden = !sidebar;
            if (palette) $('kbdPalette').textContent = pretty(palette);
            if (sidebar) $('kbdSidebar').textContent = pretty(sidebar);
        });
    }

    chrome.storage.sync.get(STORAGE.SETTINGS, (items) => {
        const dark = items.theme ? items.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');

        // The agent is ready when it is switched on AND its provider has a key
        // (a custom local server needs none). Otherwise offer the setup.
        const D = globalThis.SELECT_TO_AI_DEFAULTS;
        const provider = items.agentActiveProvider || D.AGENT_DEFAULTS.activeProvider;
        const keyName = provider === 'custom' || provider === 'chatgpt' ? null : (D.PROVIDER_ENDPOINTS[provider] || {}).keyName;
        chrome.storage.local.get(keyName ? [keyName] : ['chatgptAccount'], (local) => {
            // ChatGPT is ready once signed in with plan use on.
            const chatgpt = local.chatgptAccount;
            const ready = provider === 'chatgpt' ? !!(chatgpt && chatgpt.signedIn && chatgpt.planEnabled) : (!keyName || !!local[keyName]);
            agentEnabled = items.showAgent === true && ready;
            taskForm.hidden = !agentEnabled;
            $('ideas').hidden = !agentEnabled;
            openAgentBtn.hidden = !agentEnabled;
            $('setupCard').hidden = agentEnabled;
            if (agentEnabled) taskInput.focus();
        });
    });

    $('setupBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?step=connect') });
        window.close();
    });

    taskInput.addEventListener('input', () => { taskGo.disabled = !taskInput.value.trim(); });
    taskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); taskForm.requestSubmit(); }
    });
    taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const task = taskInput.value.trim();
        if (task) openAgent(task);
    });
    document.querySelectorAll('.idea').forEach((b) => b.addEventListener('click', () => openAgent(b.dataset.task)));

    $('openOptionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
    openAgentBtn.addEventListener('click', () => openAgent('', true));
    $('openPaletteBtn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openPaletteFromPopup' });
        window.close();
    });

    function openAgent(task, inTab) {
        if (!agentEnabled) {
            chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?step=connect') });
            return;
        }

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs && tabs[0];
            const params = new URLSearchParams();
            if (activeTab && activeTab.id) params.set('tabId', String(activeTab.id));
            if (task) { params.set('task', task); params.set('autostart', '1'); }
            const agentUrl = chrome.runtime.getURL('agent.html') + (params.toString() ? `?${params}` : '');

            chrome.storage.sync.get(['openingMode'], (settings) => {
                if (inTab || settings.openingMode === 'tab') {
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
    }

    // openSidebarBtn: open the agent when it is on, else the last-used (or first enabled) assistant.
    openSidebarBtn.addEventListener('click', () => {
        chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], (localState) => {
            chrome.storage.sync.get(STORAGE.SETTINGS, (settings) => {
                let targetBaseUrl = URLS.CHATGPT; // Default fallback (ChatGPT)

                const showChatGPT = settings.showChatGPT !== false;
                const showGemini = settings.showGemini !== false;
                const showPerplexity = settings.showPerplexity === true;
                const showClaude = settings.showClaude !== false;
                const showAgent = settings.showAgent === true;

                // 1. With the agent on, the side panel opens on the agent; the
                // assistant sites are a click away inside it.
                if (showAgent) {
                    targetBaseUrl = chrome.runtime.getURL('agent.html');
                } else if (localState[STORAGE.SIDE_PANEL_STATE] && localState[STORAGE.SIDE_PANEL_STATE].url) {
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

    function getFallbackUrl(settings) {
        if (settings.showChatGPT !== false) return URLS.CHATGPT;
        if (settings.showGemini !== false) return URLS.GEMINI;
        if (settings.showClaude !== false) return URLS.CLAUDE;
        if (settings.showPerplexity === true) return URLS.PERPLEXITY;
        if (settings.showAgent === true) return URLS.AGENT;
        return URLS.CHATGPT;
    }
});
