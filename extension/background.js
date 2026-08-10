/**
 * Select to AI - Background Service Worker
 * Manages context menus, side panel interactions, and storage caching.
 */

// Import shared configuration
importScripts('config.js', 'security.js');

if (typeof CONFIG === 'undefined') {
    console.error("Select to AI: CONFIG failed to load in background.");
}

// Cached settings to minimize storage reads
let cachedSettings = {
    autoSend: false,
    autoContext: false,
    openingMode: 'sidePanel',
    showChatGPT: true,
    showGemini: true,
    showPerplexity: false, // Default false
    showClaude: true, // Default true
    showAgent: false, // Default false
    agentCustomUrl: 'http://localhost:11434/v1',
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

// Initialize context menus on install/startup
chrome.runtime.onInstalled.addListener(() => {
    updateContextMenus();
});

/**
 * Updates the local settings cache from chrome.storage.sync.
 * Also triggers a context menu update if settings changed.
 */
function updateCache() {
    chrome.storage.sync.get(CONFIG.STORAGE.SETTINGS, (items) => {
        cachedSettings.autoSend = items.autoSend === true;
        cachedSettings.autoContext = items.autoContext !== false; // Default true

        // Settings defaults
        cachedSettings.showChatGPT = items.showChatGPT !== false;
        cachedSettings.showGemini = items.showGemini !== false;
        cachedSettings.showPerplexity = items.showPerplexity === true;
        cachedSettings.showClaude = items.showClaude !== false;
        cachedSettings.showAgent = items.showAgent === true;
        cachedSettings.agentCustomUrl = items.agentCustomUrl || 'http://localhost:11434/v1';

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
                autoSend: cachedSettings.autoSend,
                timestamp: Date.now()
            }
        });

    } else {
        // TAB MODE
        chrome.tabs.create({ url: finalUrl }, (newTab) => {
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

// Tab Closure Detection
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    chrome.runtime.sendMessage({ action: 'tabClosed', tabId: tabId }).catch(() => {});
});

// --- CORS Bypassing Proxy Handlers ---

// 1. Unary Message Proxy (for one-off requests like connection tests and model fetches) and Utility Handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetchProxy') {
        if (!SELECT_TO_AI_SECURITY.isTrustedExtensionSender(sender, chrome.runtime.id)) {
            sendResponse({ success: false, error: 'Untrusted proxy caller.' });
            return true;
        }

        const destination = SELECT_TO_AI_SECURITY.validateProviderUrl(
            message.url,
            cachedSettings.agentCustomUrl
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
        const capture = (windowId = null) => {
            chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 }, (dataUrl) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    sendResponse({ success: true, dataUrl: dataUrl });
                }
            });
        };

        if (message.tabId) {
            chrome.tabs.get(message.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Target tab not found.' });
                    return;
                }
                chrome.tabs.update(message.tabId, { active: true }, () => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ success: false, error: chrome.runtime.lastError.message });
                        return;
                    }
                    capture(tab.windowId);
                });
            });
        } else {
            capture(null);
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
            files: ['agentContentScript.js']
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
