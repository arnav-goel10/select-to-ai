/**
 * Select to AI - Background Service Worker
 * Manages context menus, side panel interactions, and storage caching.
 */

// Import shared configuration
importScripts('config.js', 'defaults.js', 'security.js', 'intentRouter.js', 'routines.js');

if (typeof CONFIG === 'undefined') {
    console.error("Select to AI: CONFIG failed to load in background.");
}

// Cached settings to minimize storage reads
let cachedSettings = {
    autoSend: false,
    // Address-bar questions auto-send by default UNLESS the user explicitly
    // turned Auto-send off (documented in the option's tooltip in Options).
    omniboxAutoSend: true,
    autoContext: false,
    openingMode: 'sidePanel',
    showChatGPT: true,
    showGemini: true,
    showPerplexity: false, // Default false
    showClaude: true, // Default true
    showAgent: false, // Default false
    agentCustomUrl: SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.customUrl,
    singleMode: false
};

// --- Initialization ---

// Initialize cache on startup
updateCache();

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        updateCache();
    }
});

// Initialize context menus on install/startup. On a FRESH install also open
// the options page so new users meet the onboarding wizard: it explains that
// the browser agent exists, that it is off by default, and that it needs an
// API key before it can run.
chrome.runtime.onInstalled.addListener((details) => {
    updateContextMenus();
    if (details && details.reason === 'install') {
        chrome.runtime.openOptionsPage(() => {
            void chrome.runtime.lastError;
        });
    }
});

/**
 * Updates the local settings cache from chrome.storage.sync.
 * Also triggers a context menu update if settings changed.
 */
function updateCache() {
    chrome.storage.sync.get(CONFIG.STORAGE.SETTINGS, (items) => {
        cachedSettings.autoSend = items.autoSend === true;
        // Omnibox flow: default ON when unset, honoring an explicit OFF.
        cachedSettings.omniboxAutoSend = items.autoSend !== false;
        cachedSettings.autoContext = items.autoContext !== false; // Default true

        // Settings defaults
        cachedSettings.showChatGPT = items.showChatGPT !== false;
        cachedSettings.showGemini = items.showGemini !== false;
        cachedSettings.showPerplexity = items.showPerplexity === true;
        cachedSettings.showClaude = items.showClaude !== false;
        cachedSettings.showAgent = items.showAgent === true;
        cachedSettings.agentCustomUrl =
            items.agentCustomUrl || SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.customUrl;

        // Opening Mode Migration Logic
        let mode = items.openingMode;
        if (!mode) mode = 'sidePanel';
        // Fallback checks
        if (!['tab', 'sidePanel'].includes(mode)) mode = 'sidePanel';
        cachedSettings.openingMode = mode;

        // Calculate Single Mode
        const activeCount =
            (cachedSettings.showChatGPT ? 1 : 0) +
            (cachedSettings.showGemini ? 1 : 0) +
            (cachedSettings.showPerplexity ? 1 : 0) +
            (cachedSettings.showClaude ? 1 : 0) +
            (cachedSettings.showAgent ? 1 : 0);

        cachedSettings.singleMode = (activeCount === 1);

        console.log("Settings Cache Updated:", cachedSettings);
        updateContextMenus();
    });
}

/**
 * Re-creates the context menu items based on current settings.
 */
function updateContextMenus() {
    chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) console.warn("Menu cleanup warn:", chrome.runtime.lastError);

        const isSingleMode = cachedSettings.singleMode;

        const create = (props) => {
            chrome.contextMenus.create(props, () => {
                if (chrome.runtime.lastError) console.log("Menu creation ignored:", chrome.runtime.lastError.message);
            });
        };

        if (isSingleMode) {
            // Flat menu for single service
            if (cachedSettings.showChatGPT) {
                create({ id: "openChatGPT", title: "Send to ChatGPT", contexts: ["selection"] });
            } else if (cachedSettings.showGemini) {
                create({ id: "openGemini", title: "Send to Gemini", contexts: ["selection"] });
            } else if (cachedSettings.showPerplexity) {
                create({ id: "openPerplexity", title: "Send to Perplexity", contexts: ["selection"] });
            } else if (cachedSettings.showClaude) {
                create({ id: "openClaude", title: "Send to Claude", contexts: ["selection"] });
            } else if (cachedSettings.showAgent) {
                create({ id: "openAgent", title: "Open AI Browser Agent", contexts: ["selection"] });
            }
        } else {
            // Nested menu for multiple services
            create({ id: "parentFolder", title: "Select to AI", contexts: ["selection"] });
            if (cachedSettings.showChatGPT) create({ id: "openChatGPT", parentId: "parentFolder", title: "Send to ChatGPT", contexts: ["selection"] });
            if (cachedSettings.showGemini) create({ id: "openGemini", parentId: "parentFolder", title: "Send to Gemini", contexts: ["selection"] });
            if (cachedSettings.showPerplexity) create({ id: "openPerplexity", parentId: "parentFolder", title: "Send to Perplexity", contexts: ["selection"] });
            if (cachedSettings.showClaude) create({ id: "openClaude", parentId: "parentFolder", title: "Send to Claude", contexts: ["selection"] });
            if (cachedSettings.showAgent) create({ id: "openAgent", parentId: "parentFolder", title: "Open AI Browser Agent", contexts: ["selection"] });
        }
    });
}

/**
 * Synchronous URL Resolver using a memory cache.
 * Avoids async storage calls during critical user gestures (like opening side panel).
 */
const sessionCache = {};

// Load cache from storage on startup
chrome.storage.local.get(null, (items) => {
    for (const key in items) {
        if (key.startsWith('sessionUrl_')) {
            const hostname = key.replace('sessionUrl_', '');
            sessionCache[hostname] = items[key];
        }
    }
});

// Listen for updates to keep memory cache fresh
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        for (const key in changes) {
            if (key.startsWith('sessionUrl_')) {
                const hostname = key.replace('sessionUrl_', '');
                sessionCache[hostname] = changes[key].newValue;
            }
        }
    }
});

function resolveSessionUrlSync(baseUrl) {
    let hostname = "";
    if (baseUrl.includes(CONFIG.HOSTS.CHATGPT)) hostname = CONFIG.HOSTS.CHATGPT;
    else if (baseUrl.includes(CONFIG.HOSTS.GEMINI)) hostname = CONFIG.HOSTS.GEMINI;
    else if (baseUrl.includes(CONFIG.HOSTS.PERPLEXITY)) hostname = CONFIG.HOSTS.PERPLEXITY_WWW;
    else if (baseUrl.includes(CONFIG.HOSTS.CLAUDE)) hostname = CONFIG.HOSTS.CLAUDE;
    else if (baseUrl.includes(CONFIG.HOSTS.AGENT)) hostname = CONFIG.HOSTS.AGENT;

    if (!hostname) return baseUrl;

    const savedUrl = sessionCache[hostname];
    if (savedUrl && savedUrl.includes(hostname)) {
        return savedUrl;
    }
    return baseUrl;
}

/**
 * URL-parameter prefill for NEW conversations. ChatGPT and Perplexity accept
 * the prompt as a query parameter and submit it on load, which skips the
 * DOM-selector dance entirely. Only used when:
 *  - the resolved URL is the service's base URL (a new conversation, a
 *    continue-session URL still needs the DOM adapter), and
 *  - the send is expected to submit (prefill URLs submit on load).
 * Returns the prefill URL, or null when the DOM path should be used.
 */
function buildPrefillUrl(finalUrl, serviceBaseUrl, text, willAutoSend) {
    if (!willAutoSend || !text) return null;
    if (finalUrl !== serviceBaseUrl) return null; // continue-session insert
    const prefillTemplates = CONFIG.PREFILL_URLS || {};
    let template = null;
    if (serviceBaseUrl === CONFIG.URLS.CHATGPT) template = prefillTemplates.CHATGPT;
    else if (serviceBaseUrl === CONFIG.URLS.PERPLEXITY) template = prefillTemplates.PERPLEXITY;
    if (!template) return null;
    return template.replace('{query}', encodeURIComponent(text));
}

// --- Interaction Handlers ---

chrome.contextMenus.onClicked.addListener((info, tab) => {
    let serviceBaseUrl = "";

    // Map Menu ID to Service URL
    switch (info.menuItemId) {
        case "openChatGPT": serviceBaseUrl = CONFIG.URLS.CHATGPT; break;
        case "openGemini": serviceBaseUrl = CONFIG.URLS.GEMINI; break;
        case "openPerplexity": serviceBaseUrl = CONFIG.URLS.PERPLEXITY; break;
        case "openClaude": serviceBaseUrl = CONFIG.URLS.CLAUDE; break;
        case "openAgent": serviceBaseUrl = CONFIG.URLS.AGENT; break;
        default: return; // Unknown menu item
    }

    let finalUrl = resolveSessionUrlSync(serviceBaseUrl);
    if (info.menuItemId === "openAgent" && tab && tab.id) {
        finalUrl += `?tabId=${tab.id}`;
    }
    const selectedText = info.selectionText || "";

    // Prepare content
    // Auto-Context: Prepend URL if enabled
    let finalText = selectedText;
    if (cachedSettings.autoContext) {
        finalText = `Context: ${tab.url}\n\n${selectedText}`;
    }

    // New-conversation prefill: ChatGPT / Perplexity accept the prompt as a
    // URL parameter (which also submits), skipping DOM insertion entirely.
    const prefillUrl = info.menuItemId === "openAgent"
        ? null
        : buildPrefillUrl(finalUrl, serviceBaseUrl, finalText, cachedSettings.autoSend);
    if (prefillUrl) {
        finalUrl = prefillUrl;
        finalText = ""; // content script has nothing left to do
    }

    // Handle Opening Mode
    if (cachedSettings.openingMode === 'sidePanel') {
        // SIDE PANEL MODE
        // 1. Open Side Panel (Sync, requires user gesture usually, context menu provides it)
        chrome.sidePanel.open({ windowId: tab.windowId }, () => {
            if (chrome.runtime.lastError) console.error("Side Panel Open Error:", chrome.runtime.lastError);
        });

        // 2. Set State (Content script listens for this)
        chrome.storage.local.set({
            sidePanelState: {
                url: finalUrl,
                selectedText: finalText,
                autoSend: prefillUrl ? false : cachedSettings.autoSend,
                timestamp: Date.now()
            }
        });

    } else {
        // TAB MODE
        chrome.tabs.create({ url: finalUrl }, (newTab) => {
            if (prefillUrl) return; // the URL itself carries the prompt
            // Wait for tab to load before sending message
            const listener = (tabId, changeInfo) => {
                if (tabId === newTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    chrome.tabs.sendMessage(newTab.id, {
                        selectedText: finalText,
                        autoSend: cachedSettings.autoSend,
                        timestamp: Date.now()
                    });
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
    }
});

// Keyboard Command Handler (Open Sidebar or Run Agent)
chrome.commands.onCommand.addListener((command, tab) => {
    if (command === CONFIG.COMMANDS.OPEN_SIDEBAR) {
        // 1. Open Side Panel
        const openPanel = (winId) => {
            chrome.sidePanel.open({ windowId: winId }, () => {
                if (chrome.runtime.lastError) console.error("Side Panel Open Error:", chrome.runtime.lastError);
            });
        };

        if (tab && tab.windowId) openPanel(tab.windowId);
        else chrome.windows.getCurrent((win) => openPanel(win.id));

        // 2. Set State (Restore last used or default)
        chrome.storage.local.get([CONFIG.STORAGE.SIDE_PANEL_STATE], (result) => {
            let targetBaseUrl = CONFIG.URLS.CHATGPT; // Absolute fallback
            const existing = result[CONFIG.STORAGE.SIDE_PANEL_STATE];

            if (existing && existing.url) {
                targetBaseUrl = existing.url; // Use last used
            } else {
                // Determine default hierarchy relative to what is enabled
                if (cachedSettings.showChatGPT) targetBaseUrl = CONFIG.URLS.CHATGPT;
                else if (cachedSettings.showGemini) targetBaseUrl = CONFIG.URLS.GEMINI;
                else if (cachedSettings.showPerplexity) targetBaseUrl = CONFIG.URLS.PERPLEXITY;
                else if (cachedSettings.showClaude) targetBaseUrl = CONFIG.URLS.CLAUDE;
                else if (cachedSettings.showAgent) targetBaseUrl = CONFIG.URLS.AGENT;
            }

            const finalUrl = resolveSessionUrlSync(targetBaseUrl);

            chrome.storage.local.set({
                sidePanelState: {
                    url: finalUrl,
                    selectedText: '', // Empty on open
                    autoSend: false,
                    timestamp: Date.now()
                }
            });
        });
    } else if (command === 'run-agent') {
        // One coherent gate: "Enable AI Browser Agent" in Options controls
        // EVERY agent entry point. When it is off, Alt+A routes the user to
        // Options (where the switch lives) instead of opening the agent.
        if (!cachedSettings.showAgent) {
            notifyAgentDisabled();
            return;
        }
        const openPanel = (winId) => {
            chrome.sidePanel.open({ windowId: winId }, () => {
                if (chrome.runtime.lastError) console.error("Side Panel Open Error:", chrome.runtime.lastError);
            });
        };
        if (tab && tab.windowId) openPanel(tab.windowId);
        else chrome.windows.getCurrent((win) => openPanel(win.id));

        const agentUrl = chrome.runtime.getURL('agent.html');
        chrome.storage.local.set({
            sidePanelState: {
                url: agentUrl + (tab ? `?tabId=${tab.id}` : ''),
                selectedText: '',
                autoSend: false,
                timestamp: Date.now()
            }
        });
    }
});

/** Shared "agent is disabled" handling for gated entry points. */
function notifyAgentDisabled() {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'Select to AI',
        message: 'The AI Browser Agent is turned off. Enable it in Settings (General Setup) to use this entry point.'
    });
    chrome.runtime.openOptionsPage(() => {
        void chrome.runtime.lastError;
    });
}

// Tab Closure Detection
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    chrome.runtime.sendMessage({ action: 'tabClosed', tabId: tabId }).catch(() => {});
});

// --- Routines: scheduled agent tasks (chrome.alarms) ---

/**
 * Re-registers all alarms from stored routines. Called on install/startup
 * and whenever routines change. Alarms only fire while the browser runs;
 * a missed schedule fires on the next matching occurrence, never retroactively.
 */
function syncRoutineAlarms() {
    chrome.storage.local.get('agentRoutines', (res) => {
        const routines = Array.isArray(res.agentRoutines) ? res.agentRoutines : [];
        // Clear every existing routine alarm first, then recreate for enabled ones.
        chrome.alarms.getAll((existing) => {
            const stale = (existing || []).filter(
                (a) => SELECT_TO_AI_ROUTINES.parseAlarmName(a.name) !== null,
            );
            stale.forEach((a) => chrome.alarms.clear(a.name));

            const now = Date.now();
            routines.forEach((routine) => {
                if (!routine.enabled || !routine.id) return;
                const normalized = SELECT_TO_AI_ROUTINES.normalizeRoutine(routine);
                if (!normalized.ok) return;
                const when = SELECT_TO_AI_ROUTINES.nextFireTime(normalized.routine.schedule, now);
                chrome.alarms.create(SELECT_TO_AI_ROUTINES.alarmName(routine.id), {
                    when,
                    // Recurring at hour granularity keeps Chrome from coalescing
                    // long schedules away; each fire re-derives the real next time.
                    periodInMinutes: 60,
                });
            });
        });
    });
}

// Alarm fired: hand the task to the agent page in a new tab. The run still
// passes through every existing gate (credentials check, risk confirmation).
chrome.alarms.onAlarm.addListener((alarm) => {
    const routineId = SELECT_TO_AI_ROUTINES.parseAlarmName(alarm?.name);
    if (!routineId) return;

    chrome.storage.local.get('agentRoutines', (res) => {
        const routine = (res.agentRoutines || []).find((r) => r.id === routineId);
        if (!routine || routine.enabled === false) return;

        // One-shot pending payload consumed by the agent page on load.
        chrome.storage.local.set({
            companionTask: {
                task: routine.task,
                timestamp: Date.now(),
                source: 'routine',
            },
        }, () => {
            chrome.tabs.create({ url: `${chrome.runtime.getURL('agent.html')}?autorun=1` });
        });

        // Re-derive the true next occurrence (the 60-minute alarm period is
        // only a keepalive; this corrects it to the real schedule).
        const normalized = SELECT_TO_AI_ROUTINES.normalizeRoutine(routine);
        if (normalized.ok) {
            const when = SELECT_TO_AI_ROUTINES.nextFireTime(normalized.routine.schedule, Date.now());
            chrome.alarms.create(SELECT_TO_AI_ROUTINES.alarmName(routineId), {
                when,
                periodInMinutes: 60,
            });
        }
    });
});

chrome.runtime.onInstalled.addListener(() => syncRoutineAlarms());
chrome.runtime.onStartup.addListener(() => syncRoutineAlarms());
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.agentRoutines) {
        syncRoutineAlarms();
    }
});

// --- CORS Bypassing Proxy Handlers ---

// 1. Unary Message Proxy (for one-off requests like connection tests and model fetches) and Utility Handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetchProxy') {
        if (!SELECT_TO_AI_SECURITY.isTrustedExtensionSender(sender, chrome.runtime.id)) {
            sendResponse({ success: false, error: 'Untrusted proxy caller.' });
            return true;
        }

        // Test-only candidate gateway: extension pages (already verified as
        // trusted senders above) may name a typed-but-unsaved custom-gateway
        // URL for a single connection test / model fetch. The candidate goes
        // through the SAME origin policy as a saved gateway (HTTPS or
        // loopback, no embedded credentials, exact-origin match), this
        // scopes only which custom origin this one request may target, and
        // the streaming agent path below still accepts the saved URL only.
        const customUrlForRequest =
            typeof message.candidateCustomUrl === 'string' && message.candidateCustomUrl
                ? message.candidateCustomUrl
                : cachedSettings.agentCustomUrl;

        const destination = SELECT_TO_AI_SECURITY.validateProviderUrl(
            message.url,
            customUrlForRequest
        );
        const request = SELECT_TO_AI_SECURITY.validateProxyOptions(message.options);
        if (!destination.ok || !request.ok) {
            sendResponse({ success: false, error: destination.error || request.error });
            return true;
        }

        fetch(destination.url, request.options)
            .then(async (response) => {
                const status = response.status;
                const ok = response.ok;
                const headers = {};
                response.headers.forEach((value, key) => {
                    headers[key] = value;
                });
                const text = await response.text();
                sendResponse({ success: true, status, ok, headers, text });
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message || String(error) });
            });
        return true; // Keep message channel open for async response
    }

    if (message.action === 'captureScreenshot') {
        // captureVisibleTab can only capture a window's ACTIVE tab. When the
        // target tab is already active, capture directly, no focus change at
        // all. Otherwise activate it within its own window (never focusing
        // the window itself), capture, then restore the previously active
        // tab so the user's focus is not yanked away.
        const capture = (windowId, done) => {
            chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 }, (dataUrl) => {
                if (chrome.runtime.lastError) {
                    done({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    done({ success: true, dataUrl: dataUrl });
                }
            });
        };

        if (message.tabId) {
            chrome.tabs.get(message.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Target tab not found.' });
                    return;
                }

                if (tab.active) {
                    capture(tab.windowId, sendResponse);
                    return;
                }

                chrome.tabs.query({ active: true, windowId: tab.windowId }, (activeTabs) => {
                    const previousActive = activeTabs && activeTabs[0];
                    chrome.tabs.update(message.tabId, { active: true }, () => {
                        if (chrome.runtime.lastError) {
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                            return;
                        }
                        // Give the tab a moment to paint before capturing.
                        setTimeout(() => {
                            capture(tab.windowId, (result) => {
                                if (previousActive && previousActive.id && previousActive.id !== message.tabId) {
                                    chrome.tabs.update(previousActive.id, { active: true }, () => {
                                        void chrome.runtime.lastError;
                                        sendResponse(result);
                                    });
                                } else {
                                    sendResponse(result);
                                }
                            });
                        }, 150);
                    });
                });
            });
        } else {
            capture(null, sendResponse);
        }
        return true;
    }

    if (message.action === 'showNotification') {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon128.png',
            title: message.title || 'Select to AI',
            message: message.message || 'Task completed'
        });
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'injectAgentScript') {
        if (!SELECT_TO_AI_SECURITY.isTrustedExtensionSender(sender, chrome.runtime.id)) {
            sendResponse({ success: false, error: 'Untrusted script-injection caller.' });
            return true;
        }
        chrome.scripting.executeScript({
            target: { tabId: message.tabId, allFrames: true },
            files: ['agentTools.js', 'agentContentScript.js']
        }, () => {
            sendResponse({ success: !chrome.runtime.lastError });
        });
        return true;
    }
});

// 2. Streaming Port Proxy (for agent LLM completion runs)
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'streamFetch') {
        if (!SELECT_TO_AI_SECURITY.isTrustedExtensionSender(port.sender, chrome.runtime.id)) {
            port.disconnect();
            return;
        }
        let abortController = null;

        port.onMessage.addListener(async (message) => {
            const destination = SELECT_TO_AI_SECURITY.validateProviderUrl(
                message.url,
                cachedSettings.agentCustomUrl
            );
            const request = SELECT_TO_AI_SECURITY.validateProxyOptions(message.options);
            if (!destination.ok || !request.ok) {
                port.postMessage({ type: 'error', error: destination.error || request.error });
                return;
            }
            abortController = new AbortController();
            const signal = abortController.signal;

            try {
                const response = await fetch(destination.url, {
                    ...request.options,
                    signal
                });

                if (!response.ok) {
                    const text = await response.text();
                    const headers = {};
                    response.headers.forEach((value, key) => {
                        headers[key] = value;
                    });
                    port.postMessage({
                        type: 'error',
                        status: response.status,
                        statusText: response.statusText,
                        error: text,
                        headers: headers
                    });
                    return;
                }

                // Send initial response metadata
                const headers = {};
                response.headers.forEach((value, key) => {
                    headers[key] = value;
                });
                port.postMessage({
                    type: 'connected',
                    status: response.status,
                    headers
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            port.postMessage({ type: 'done' });
                            break;
                        }
                        const chunk = decoder.decode(value, { stream: true });
                        port.postMessage({ type: 'chunk', chunk });
                    }
                } catch (readError) {
                    if (signal.aborted) return;
                    port.postMessage({ type: 'error', error: readError.message });
                } finally {
                    reader.releaseLock();
                }
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError') {
                    // silent
                } else {
                    port.postMessage({ type: 'error', error: error.message || String(error) });
                }
            }
        });

        port.onDisconnect.addListener(() => {
            if (abortController) {
                abortController.abort();
            }
        });
    }
});


// --- Omnibox: type "ai" then space in the address bar ---
// The intent router decides whether the text is a site to open, a question
// for the AI, or a task for the browser agent. Suggestions show the routing
// live so the user always sees what Enter will do, and one prefix (ask/do/open)
// overrides the guess.

const OMNIBOX_LIMIT = 400;

function omniboxEscape(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function omniboxDescribe(route, text) {
    const shown = omniboxEscape(text.length > 60 ? text.slice(0, 57) + '...' : text);
    if (route.intent === 'navigate') {
        let host = route.query;
        try { host = new URL(route.url).hostname; } catch (_e) { /* keep query */ }
        return `Open <match>${omniboxEscape(host)}</match> <dim>· go straight there</dim>`;
    }
    if (route.intent === 'agent') {
        return `Agent task: <match>${shown}</match> <dim>· plans first, risky actions need your OK</dim>`;
    }
    return `Ask AI: <match>${shown}</match>`;
}


// --- Smart omnibox routing: a tiny cached model call refines the heuristic ---
// The heuristic answer is always shown instantly; while the user is still
// typing, one small lite-tier request classifies the input and (if it lands
// before Enter) upgrades the suggestion. Enter never waits on the network.
const SMART_ROUTE_CACHE_MAX = 50;
const smartRouteCache = new Map();
let smartRouteTimer = null;
let smartRouteAbort = null;
let smartRouteLastInput = '';

const SMART_ROUTE_PROMPT =
    'Classify one browser address-bar input. Reply with ONLY a JSON object: ' +
    '{"intent":"navigate|ask|agent","url":"https://..."}. ' +
    'navigate = the input names a website or destination; set "url" to the most likely real https URL. ' +
    'ask = a question or request for information; omit "url". ' +
    'agent = a multi-step task to perform in the browser; omit "url". No other text.';

function cacheSmartRoute(input, routed) {
    smartRouteCache.set(input, routed);
    if (smartRouteCache.size > SMART_ROUTE_CACHE_MAX) {
        smartRouteCache.delete(smartRouteCache.keys().next().value);
    }
}

async function fetchSmartRoute(input) {
    const sync = await chrome.storage.sync.get(['omniboxSmartRouting', 'agentActiveProvider', 'agentModel']);
    if (sync.omniboxSmartRouting === false) return null;
    const provider = sync.agentActiveProvider || SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.activeProvider;
    const isCustom = provider === 'custom';
    const entry = SELECT_TO_AI_DEFAULTS.PROVIDER_ENDPOINTS[provider];
    if (!entry && !isCustom) return null;
    const keyName = isCustom ? 'agentCustomKey' : entry.keyName;
    const local = await chrome.storage.local.get([keyName]);
    const apiKey = local[keyName] || '';
    if (!apiKey && !isCustom) return null;
    const baseUrl = isCustom ? cachedSettings.agentCustomUrl : entry.baseUrl;
    if (!baseUrl) return null;
    const fallbacks = SELECT_TO_AI_DEFAULTS.PROVIDER_FALLBACK_MODELS[provider] || {};
    const model = fallbacks.lite || sync.agentModel;
    if (!model) return null;

    if (smartRouteAbort) smartRouteAbort.abort();
    smartRouteAbort = new AbortController();
    const timeout = setTimeout(() => smartRouteAbort.abort(), 3500);
    try {
        let raw = '';
        if (provider === 'anthropic') {
            const res = await fetch(baseUrl, {
                method: 'POST',
                signal: smartRouteAbort.signal,
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 60,
                    system: SMART_ROUTE_PROMPT,
                    messages: [{ role: 'user', content: input }],
                }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            raw = (data.content || []).map((blockItem) => blockItem.text || '').join('');
        } else {
            let endpoint = String(baseUrl).replace(/\/$/, '');
            if (!endpoint.endsWith('/chat/completions')) endpoint += '/chat/completions';
            const res = await fetch(endpoint, {
                method: 'POST',
                signal: smartRouteAbort.signal,
                headers: {
                    'content-type': 'application/json',
                    ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
                },
                body: JSON.stringify({
                    model,
                    temperature: 0,
                    max_tokens: 60,
                    messages: [
                        { role: 'system', content: SMART_ROUTE_PROMPT },
                        { role: 'user', content: input },
                    ],
                }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            raw = data.choices?.[0]?.message?.content || '';
        }
        return SELECT_TO_AI_INTENT.parseSmartRoute(raw);
    } catch (_error) {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function smartRouteAsRoute(smart, text) {
    return { intent: smart.intent, url: smart.url, query: text, confidence: 'high', reason: 'smart route' };
}

function scheduleSmartRoute(trimmed) {
    clearTimeout(smartRouteTimer);
    smartRouteTimer = setTimeout(() => {
        fetchSmartRoute(trimmed).then((smart) => {
            if (!smart) return;
            cacheSmartRoute(trimmed, smart);
            if (smartRouteLastInput === trimmed && chrome.omnibox) {
                chrome.omnibox.setDefaultSuggestion({
                    description: omniboxDescribe(smartRouteAsRoute(smart, trimmed), trimmed) + ' <dim>· smart</dim>',
                });
            }
        });
    }, 350);
}

if (chrome.omnibox) {
    chrome.omnibox.onInputChanged.addListener((text, suggest) => {
        const trimmed = String(text || '').slice(0, OMNIBOX_LIMIT).trim();
        if (!trimmed) {
            chrome.omnibox.setDefaultSuggestion({
                description: 'Type a site to open it, a question to ask, or a task for the agent',
            });
            suggest([]);
            return;
        }
        const route = SELECT_TO_AI_INTENT.classifyOmniboxInput(trimmed);
        smartRouteLastInput = trimmed;
        const cachedSmart = smartRouteCache.get(trimmed);
        if (cachedSmart) {
            chrome.omnibox.setDefaultSuggestion({
                description: omniboxDescribe(smartRouteAsRoute(cachedSmart, trimmed), trimmed) + ' <dim>· smart</dim>',
            });
        } else {
            chrome.omnibox.setDefaultSuggestion({ description: omniboxDescribe(route, trimmed) });
            if (route.confidence !== 'high' && trimmed.length >= 3) {
                scheduleSmartRoute(trimmed);
            }
        }

        const alternates = [];
        if (route.intent !== 'ask') {
            alternates.push({
                content: `ask ${trimmed}`,
                description: `Ask AI instead: <match>${omniboxEscape(trimmed)}</match>`,
            });
        }
        if (route.intent !== 'agent') {
            alternates.push({
                content: `do ${trimmed}`,
                description: `Run as agent task instead: <match>${omniboxEscape(trimmed)}</match>`,
            });
        }
        if (route.intent !== 'navigate') {
            const nav = SELECT_TO_AI_INTENT.normalizeNavigationUrl(trimmed.split(/\s+/)[0]);
            if (nav) {
                alternates.push({
                    content: `open ${trimmed.split(/\s+/)[0]}`,
                    description: `Open the site instead: <match>${omniboxEscape(trimmed.split(/\s+/)[0])}</match>`,
                });
            }
        }
        suggest(alternates);
    });

    chrome.omnibox.onInputEntered.addListener((text, disposition) => {
        const trimmed = String(text || '').slice(0, OMNIBOX_LIMIT).trim();
        if (!trimmed) return;
        let route = SELECT_TO_AI_INTENT.classifyOmniboxInput(trimmed);
        const smart = smartRouteCache.get(trimmed);
        if (smart && route.confidence !== 'high') {
            route = smartRouteAsRoute(smart, trimmed);
        }

        if (route.intent === 'navigate' && route.url) {
            if (disposition === 'currentTab') {
                chrome.tabs.update({ url: route.url });
            } else {
                chrome.tabs.create({ url: route.url, active: disposition !== 'newBackgroundTab' });
            }
            return;
        }

        if (route.intent === 'agent') {
            // Same master gate as Alt+A / popup / side panel.
            if (!cachedSettings.showAgent) {
                notifyAgentDisabled();
                return;
            }
            const agentUrl = `${CONFIG.URLS.AGENT}?task=${encodeURIComponent(route.query)}&autostart=1`;
            chrome.tabs.create({ url: agentUrl });
            return;
        }

        openServiceWithText(route.query);
    });
}

/**
 * Opens the preferred AI service with prepared text, honoring the user's
 * opening mode. Mirrors the context-menu flow. Auto-send honors the user's
 * Auto-send preference, for the address-bar flow it defaults ON when the
 * preference was never set (documented in the option's tooltip), because an
 * omnibox question is an explicit "send this" gesture.
 */
function openServiceWithText(text) {
    let serviceBaseUrl = CONFIG.URLS.CHATGPT;
    if (cachedSettings.showChatGPT) serviceBaseUrl = CONFIG.URLS.CHATGPT;
    else if (cachedSettings.showGemini) serviceBaseUrl = CONFIG.URLS.GEMINI;
    else if (cachedSettings.showPerplexity) serviceBaseUrl = CONFIG.URLS.PERPLEXITY;
    else if (cachedSettings.showClaude) serviceBaseUrl = CONFIG.URLS.CLAUDE;

    let finalUrl = resolveSessionUrlSync(serviceBaseUrl);
    const willAutoSend = cachedSettings.omniboxAutoSend;

    // New-conversation prefill (ChatGPT / Perplexity): the URL parameter
    // carries and submits the prompt, so no DOM insertion is needed.
    const prefillUrl = buildPrefillUrl(finalUrl, serviceBaseUrl, text, willAutoSend);
    let finalText = text;
    if (prefillUrl) {
        finalUrl = prefillUrl;
        finalText = "";
    }

    if (cachedSettings.openingMode === 'sidePanel') {
        chrome.windows.getLastFocused((win) => {
            chrome.sidePanel.open({ windowId: win.id }, () => {
                if (chrome.runtime.lastError) console.error('Side Panel Open Error:', chrome.runtime.lastError);
            });
            chrome.storage.local.set({
                sidePanelState: {
                    url: finalUrl,
                    selectedText: finalText,
                    autoSend: prefillUrl ? false : willAutoSend,
                    timestamp: Date.now(),
                },
            });
        });
        return;
    }

    chrome.tabs.create({ url: finalUrl }, (newTab) => {
        if (prefillUrl) return; // the URL itself carries the prompt
        const listener = (tabId, changeInfo) => {
            if (tabId === newTab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                chrome.tabs.sendMessage(newTab.id, {
                    selectedText: finalText,
                    autoSend: willAutoSend,
                    timestamp: Date.now(),
                });
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}
