/**
 * Select to AI - Popup Logic
 *
 * The popup is now the PRIMARY task surface: type anything, and a
 * deterministic router (the same one that powers the address bar) shows
 * live where it will go - browser agent, question, or site navigation -
 * then runs it on Enter. Every run is recorded in local task history so
 * nothing is lost between sessions.
 *
 * Secondary actions (full agent view, sidebar, settings) stay in the
 * footer; behavioral defaults live in Options only.
 */

document.addEventListener('DOMContentLoaded', () => {
    if (typeof CONFIG === 'undefined') {
        console.error("Select to AI: CONFIG not loaded in popup.");
        return;
    }

    const { STORAGE, URLS, HOSTS } = CONFIG;
    const History = window.SELECT_TO_AI_TASK_HISTORY;

    // DOM Elements
    const taskInput = document.getElementById('taskInput');
    const runBtn = document.getElementById('runBtn');
    const routePreview = document.getElementById('routePreview');
    const composerError = document.getElementById('composerError');
    const historyList = document.getElementById('historyList');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const openAgentBtn = document.getElementById('openAgentBtn');
    const openSidebarBtn = document.getElementById('openSidebarBtn');
    const openOptionsBtn = document.getElementById('openOptionsBtn');
    const themeToggleBtn = document.getElementById('theme-toggle');

    let agentEnabled = false;
    let currentRoute = null;

    // --- Theme (shared mechanism) ---
    chrome.storage.sync.get(STORAGE.SETTINGS, (items) => {
        const theme = items.theme ||
            (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeToggleLabel(theme);
        agentEnabled = items.showAgent === true;
    });

    // --- Routing preview ---
    function describeRoute(route) {
        if (!route) return null;
        switch (route.intent) {
            case 'agent':
                return { label: 'Agent', icon: '⚡', desc: 'Runs as a browser task' };
            case 'navigate':
                return { label: 'Open', icon: '↗', desc: `Opens ${shorten(route.url || route.query || '', 34)}` };
            default:
                return { label: 'Ask', icon: '?', desc: 'Sends as a question' };
        }
    }

    function shorten(text, max) {
        const t = String(text || '').replace(/^https?:\/\/(www\.)?/, '');
        return t.length > max ? t.slice(0, max - 1) + '…' : t;
    }

    function renderRoutePreview() {
        const text = taskInput.value.trim();
        currentRoute = text ? window.SELECT_TO_AI_INTENT.classifyOmniboxInput(text) : null;
        runBtn.disabled = !text;
        if (!text) {
            routePreview.innerHTML =
                '<span class="route-desc">Tasks run in the agent · questions go to your assistant · site names open directly</span>';
            return;
        }
        const d = describeRoute(currentRoute);
        if (!d) return;
        // Agent intent requires the master switch on.
        if (currentRoute.intent === 'agent' && !agentEnabled) {
            routePreview.innerHTML =
                `<span class="route-badge">⚠ Agent off</span><span class="route-desc">Enable it in Settings to run this</span>`;
            return;
        }
        routePreview.innerHTML =
            `<span class="route-badge">${d.icon} ${d.label}</span><span class="route-desc">${escapeHtml(d.desc)}</span>`;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text ?? '');
        return div.innerHTML;
    }

    // --- Task history rendering ---
    function renderHistory(entries) {
        historyList.innerHTML = '';
        const list = entries || [];
        if (list.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'history-empty';
            empty.textContent = 'Nothing yet. Tasks you run here are saved so you can spot them later.';
            historyList.appendChild(empty);
            return;
        }
        list.slice(0, 8).forEach((entry, i) => {
            const row = document.createElement('div');
            row.className = 'history-item anim-rise';
            row.style.setProperty('--anim-delay', `${i * 40}ms`);
            row.title = `${entry.task}${entry.detail ? ` — ${entry.detail}` : ''}`;

            const icon = document.createElement('span');
            icon.className = `h-icon route-${entry.route || 'agent'}`;
            icon.textContent = entry.route === 'site' ? '↗'
                : entry.route === 'question' ? '?' : '⚡';

            const text = document.createElement('span');
            text.className = 'h-text';
            text.textContent = entry.task || '(untitled task)';

            const status = document.createElement('span');
            status.className = `h-status ${entry.status || 'running'}`;
            status.title = entry.status || '';

            row.appendChild(icon);
            row.appendChild(text);
            row.appendChild(status);
            row.addEventListener('click', () => rerunEntry(entry));
            historyList.appendChild(row);
        });
    }

    function loadHistory() {
        chrome.storage.local.get(History.STORAGE_KEY, (res) => {
            renderHistory(res[History.STORAGE_KEY] || []);
        });
    }

    /** Clicking a history item refills the composer with that task. */
    function rerunEntry(entry) {
        taskInput.value = entry.task || '';
        taskInput.focus();
        renderRoutePreview();
        autoResize();
    }

    clearHistoryBtn.addEventListener('click', () => {
        chrome.storage.local.set({ [History.STORAGE_KEY]: [] }, loadHistory);
    });

    // --- Running tasks from the popup ---

    function showError(message) {
        composerError.textContent = message;
        composerError.classList.add('visible');
    }

    function hideError() {
        composerError.classList.remove('visible');
    }

    /** Appends a running entry and returns its id. */
    function recordStart(route, task) {
        const entry = History.createEntry({ route, task });
        chrome.storage.local.get(History.STORAGE_KEY, (res) => {
            chrome.storage.local.set({
                [History.STORAGE_KEY]: History.prepend(res[History.STORAGE_KEY], entry),
            });
        });
        return entry.id;
    }

    /**
     * Opens the agent view for a task. Prefers the side panel (seamless),
     * falls back to a tab per the stored opening mode.
     */
    function openAgentForTask(task, sourceTabId) {
        const agentUrl = chrome.runtime.getURL('agent.html') +
            `?task=${encodeURIComponent(task)}&autostart=1` +
            (sourceTabId ? `&tabId=${sourceTabId}` : '');

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
                    timestamp: Date.now(),
                },
            }, () => {
                chrome.windows.getCurrent((win) => {
                    chrome.sidePanel.open({ windowId: win.id }, () => {
                        if (chrome.runtime.lastError) {
                            // Side panel unavailable (e.g. no user gesture):
                            // fall back to a tab so the task still runs.
                            void chrome.runtime.lastError;
                            chrome.tabs.create({ url: agentUrl });
                        }
                    });
                });
            });
        });
    }

    function runTask() {
        hideError();
        const text = taskInput.value.trim();
        if (!text) return;
        const route = window.SELECT_TO_AI_INTENT.classifyOmniboxInput(text);

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs && tabs[0];

            if (route.intent === 'agent') {
                if (!agentEnabled) {
                    showError('The browser agent is off. Enable "Enable AI Browser Agent" in Settings first.');
                    return;
                }
                recordStart(History.ROUTES.AGENT, text);
                openAgentForTask(route.query || text, activeTab?.id);
                window.close();
                return;
            }

            if (route.intent === 'navigate') {
                recordStart(History.ROUTES.SITE, text);
                if (activeTab?.id) {
                    chrome.tabs.update(activeTab.id, { url: route.url });
                } else {
                    chrome.tabs.create({ url: route.url });
                }
                window.close();
                return;
            }

            // Question: send to the last-used / preferred assistant sidebar,
            // prefilled via URL when supported (new ChatGPT/Perplexity chats).
            recordStart(History.ROUTES.QUESTION, text);
            chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], (localState) => {
                let target = URLS.CHATGPT;
                if (localState[STORAGE.SIDE_PANEL_STATE]?.url) target = localState[STORAGE.SIDE_PANEL_STATE].url;
                const prefill = buildPrefill(target, route.query || text);
                const finalUrl = prefill || target;
                chrome.storage.local.set({
                    sidePanelState: prefill
                        ? { url: finalUrl, selectedText: '', autoSend: false, timestamp: Date.now() }
                        : {
                            url: finalUrl,
                            selectedText: `${route.query || text}`,
                            autoSend: false,
                            insertMode: 'replace',
                            timestamp: Date.now(),
                        },
                }, () => {
                    chrome.windows.getCurrent((win) => {
                        chrome.sidePanel.open({ windowId: win.id }, () => {
                            if (chrome.runtime.lastError) {
                                void chrome.runtime.lastError;
                                chrome.tabs.create({ url: finalUrl });
                            }
                        });
                    });
                });
                window.close();
            });
        });
    }

    function buildPrefill(baseUrl, text) {
        if (baseUrl.includes(HOSTS.CHATGPT)) {
            return `https://chatgpt.com/?q=${encodeURIComponent(text)}`;
        }
        if (baseUrl.includes(HOSTS.PERPLEXITY)) {
            return `https://www.perplexity.ai/search?q=${encodeURIComponent(text)}`;
        }
        return null;
    }

    // --- Events ---
    let resizeFrame = null;
    function autoResize() {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
            taskInput.style.height = 'auto';
            taskInput.style.height = Math.min(taskInput.scrollHeight, 110) + 'px';
        });
    }

    taskInput.addEventListener('input', () => {
        hideError();
        autoResize();
        renderRoutePreview();
    });

    taskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            runTask();
        }
    });

    runBtn.addEventListener('click', runTask);

    // Footer actions
    openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

    openAgentBtn.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            openAgentForTask('', tabs?.id);
            window.close();
        });
    });

    // Sidebar: reuse the launcher logic (last-used or fallback assistant).
    openSidebarBtn.addEventListener('click', () => {
        chrome.storage.local.get([STORAGE.SIDE_PANEL_STATE], (localState) => {
            chrome.storage.sync.get(STORAGE.SETTINGS, (settings) => {
                let targetBaseUrl = getFallbackUrl(settings);
                const state = localState[STORAGE.SIDE_PANEL_STATE];
                if (state?.url && isServiceEnabled(state.url, settings)) {
                    targetBaseUrl = state.url;
                }
                chrome.storage.local.set({
                    sidePanelState: {
                        url: targetBaseUrl,
                        selectedText: '',
                        autoSend: false,
                        timestamp: Date.now(),
                    },
                }, () => {
                    chrome.windows.getCurrent((win) => {
                        chrome.sidePanel.open({ windowId: win.id });
                        window.close();
                    });
                });
            });
        });
    });

    function isServiceEnabled(url, settings) {
        if (url.includes(HOSTS.CHATGPT)) return settings.showChatGPT !== false;
        if (url.includes(HOSTS.GEMINI)) return settings.showGemini !== false;
        if (url.includes(HOSTS.PERPLEXITY)) return settings.showPerplexity === true;
        if (url.includes(HOSTS.CLAUDE)) return settings.showClaude !== false;
        if (url.includes(HOSTS.AGENT)) return settings.showAgent === true;
        return true;
    }

    function getFallbackUrl(settings) {
        if (settings.showChatGPT !== false) return URLS.CHATGPT;
        if (settings.showGemini !== false) return URLS.GEMINI;
        if (settings.showClaude !== false) return URLS.CLAUDE;
        if (settings.showPerplexity === true) return URLS.PERPLEXITY;
        if (settings.showAgent === true) return URLS.AGENT;
        return URLS.CHATGPT;
    }

    // Theme toggle (unchanged mechanism)
    function updateThemeToggleLabel(theme) {
        if (!themeToggleBtn) return;
        themeToggleBtn.setAttribute(
            'aria-label',
            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        );
    }

    themeToggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        updateThemeToggleLabel(newTheme);
        chrome.storage.sync.set({ theme: newTheme });
    });

    // Init
    loadHistory();
    renderRoutePreview();
    taskInput.focus();
});
