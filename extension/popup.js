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
            $('taskHelper').hidden = !agentEnabled;
            openAgentBtn.hidden = !agentEnabled;
            // The quick box starts the agent, so it shows only when the agent is on.
            $('openPaletteBtn').hidden = !agentEnabled;
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
        // Enter that confirms an IME word is not a send.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); taskForm.requestSubmit(); }
    });
    taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const task = taskInput.value.trim();
        if (task) openAgent(task);
    });
    document.querySelectorAll('.idea').forEach((b) => b.addEventListener('click', () => openAgent(b.dataset.task)));

    $('openOptionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('rightClickSettingsBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html#ask') });
        window.close();
    });

    // Once, after the update from an earlier version: what changed, in the
    // popup, with no tab opened. The worker writes this key (background.js
    // onInstalled), and both take its name from config.js.
    const WHATS_NEW = STORAGE.UPGRADE_NOTICE;
    chrome.storage.local.get(WHATS_NEW, (r) => {
        if (chrome.runtime.lastError || !r || !r[WHATS_NEW]) return;
        $('whatsNew').hidden = false;
    });
    $('whatsNewClose').addEventListener('click', () => {
        $('whatsNew').hidden = true;
        chrome.storage.local.remove(WHATS_NEW);
    });

    // Claude was on for this user, but Chrome does not hold claude.ai (the
    // host became optional in 4.0), so "Send to Claude" is not in the menu.
    // It is never dropped without a word: this row adds it back.
    const G = globalThis.SELECT_TO_AI_GRANTS;
    const addClaudeBtn = $('addClaudeBtn');
    chrome.storage.sync.get(['showClaude'], (s) => {
        if (chrome.runtime.lastError || !G || !s || s.showClaude !== true) return;
        G.hasHost(G.ASSISTANT_HOSTS.claude).then((held) => { addClaudeBtn.hidden = held; });
    });
    addClaudeBtn.addEventListener('click', () => {
        // Asked for inside the click. Chrome's prompt can close the popup;
        // the worker hears of the grant either way and rebuilds the menu.
        G.requestHost(G.ASSISTANT_HOSTS.claude).then((held) => { if (held) addClaudeBtn.hidden = true; });
    });
    openAgentBtn.addEventListener('click', () => openAgent('', true));
    // The worker says whether the quick box opened. Chrome keeps extensions
    // off its own pages and the Web Store, so there the popup stays open and
    // says why, rather than closing on nothing.
    $('openPaletteBtn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openPaletteFromPopup' }, (reply) => {
            void chrome.runtime.lastError;
            if (reply && reply.opened === false) { $('paletteNote').hidden = false; return; }
            window.close();
        });
    });

    function openAgent(task, inTab) {
        if (!agentEnabled) {
            chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?step=connect') });
            return;
        }

        // The popup moves toward where the task goes while the panel opens.
        document.body.classList.add('handing-off');
        // If nothing opens (a closed window, a refused panel), the popup comes back.
        setTimeout(() => document.body.classList.remove('handing-off'), 900);
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs && tabs[0];
            const tabId = activeTab && activeTab.id ? activeTab.id : null;
            const params = new URLSearchParams();
            if (tabId) params.set('tabId', String(tabId));

            chrome.storage.sync.get(['openingMode'], (settings) => {
                if (inTab || settings.openingMode === 'tab') {
                    // A tab is opened once from this address, and the agent
                    // page drops the task from it as soon as it is read.
                    if (task) { params.set('task', task); params.set('autostart', '1'); }
                    chrome.tabs.create({ url: chrome.runtime.getURL('agent.html') + (params.toString() ? `?${params}` : '') });
                    return;
                }
                // The side panel reloads its saved address whenever it is
                // opened again, so the task goes as a one-time handoff that
                // the agent page takes and removes, never in that address.
                const OMNI = globalThis.SELECT_TO_AI_OMNIBOX;
                const addressFor = task
                    ? OMNI.handOff(chrome.storage.session, task, tabId).then((h) => chrome.runtime.getURL(h.path))
                    : Promise.resolve(chrome.runtime.getURL('agent.html') + (params.toString() ? `?${params}` : ''));
                addressFor.then((agentUrl) => {
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
    }

    // claude.ai is optional in 4.0. The side panel cannot load it until
    // Chrome holds the host, and its picker leaves Claude out until then.
    const claudeHeld = () => (G ? G.hasHost(G.ASSISTANT_HOSTS.claude) : Promise.resolve(false));

    // openSidebarBtn: open the agent when it is on, else the last-used (or first enabled) assistant.
    openSidebarBtn.addEventListener('click', () => {
        chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], (localState) => {
            chrome.storage.sync.get(STORAGE.SETTINGS, (settings) => {
                claudeHeld().then((claudeGranted) => openSidePanelOn(localState, settings, claudeGranted));
            });
        });
    });

    function openSidePanelOn(localState, settings, claudeGranted) {
        const showChatGPT = settings.showChatGPT !== false;
        const showGemini = settings.showGemini !== false;
        const showPerplexity = settings.showPerplexity === true;
        const showClaude = settings.showClaude !== false && claudeGranted;
        const showAgent = settings.showAgent === true;
        const last = localState[STORAGE.SIDE_PANEL_STATE];

        let targetBaseUrl;
        // 1. With the agent on, the side panel opens on the agent; the
        // assistant sites are a click away inside it.
        if (showAgent) {
            targetBaseUrl = chrome.runtime.getURL('agent.html');
        } else if (last && last.url) {
            targetBaseUrl = last.url;

            // Verify if that service is still enabled
            let isEnabled = true;
            if (targetBaseUrl.includes(HOSTS.CHATGPT) && !showChatGPT) isEnabled = false;
            else if (targetBaseUrl.includes(HOSTS.GEMINI) && !showGemini) isEnabled = false;
            else if (targetBaseUrl.includes(HOSTS.PERPLEXITY) && !showPerplexity) isEnabled = false;
            else if (targetBaseUrl.includes(HOSTS.CLAUDE) && !showClaude) isEnabled = false;
            else if (targetBaseUrl.includes(HOSTS.AGENT) && !showAgent) isEnabled = false;

            if (!isEnabled) targetBaseUrl = getFallbackUrl(settings, claudeGranted);
        } else {
            // 2. No history: Default Hierarchy
            targetBaseUrl = getFallbackUrl(settings, claudeGranted);
        }

        const openPanel = () => chrome.windows.getCurrent((win) => {
            chrome.sidePanel.open({ windowId: win.id });
        });
        // Nothing the panel can show: it opens on its own empty state,
        // which points to Settings, and the saved address is left alone.
        if (!targetBaseUrl) { openPanel(); return; }

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
            }, openPanel);
        });
    }

    /**
     * The first site the side panel can show, in the order its own picker
     * and the worker use: ChatGPT, Gemini, Perplexity, then Claude once
     * Chrome holds claude.ai, then the agent. null when there is none.
     */
    function getFallbackUrl(settings, claudeGranted) {
        if (settings.showChatGPT !== false) return URLS.CHATGPT;
        if (settings.showGemini !== false) return URLS.GEMINI;
        if (settings.showPerplexity === true) return URLS.PERPLEXITY;
        if (settings.showClaude !== false && claudeGranted) return URLS.CLAUDE;
        if (settings.showAgent === true) return URLS.AGENT;
        return null;
    }
});
