/**
 * Select to AI - Background Service Worker
 * Manages context menus, side panel interactions, and storage caching.
 */

// Import shared configuration
importScripts('config.js', 'defaults.js', 'security.js', 'commonWords.js', 'omnibox.js');
// Optional permissions (notifications, optional hosts) go through one helper.
importScripts('core/grants.js');
// The agent's runs live in this worker (engine.js), not in the side panel.
importScripts('publicSuffixes.js', 'agentTools.js', 'agentPrompt.js', 'usageLimits.js', 'pageSearch.js',
    'chatgptAuth.js', 'chatgptConnect.js',
    'core/step.js', 'core/observe.js', 'core/memory.js', 'core/context.js', 'core/policy.js', 'core/run.js', 'core/llm.js', 'core/learn.js', 'core/view.js', 'core/inject.js',
    'recipes/vendor/recipes-core.js', 'recipes/driver.js', 'recipes/service.js', 'engine.js');
// Saved runs ("recipes") and their replays, for the agent's page.
if (self.SELECT_TO_AI_RECIPES) self.SELECT_TO_AI_RECIPES.install(chrome);

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
/**
 * 3.4 migration: OpenCode's "-free" models only answer inside the OpenCode
 * app, so anyone saved on one (the old default) is moved to OpenRouter's
 * free router, which works from the extension.
 */
function migrateAppOnlyFreeModels() {
    chrome.storage.sync.get(['agentActiveProvider', 'agentModel'], (items) => {
        const provider = items.agentActiveProvider;
        const model = String(items.agentModel || '');
        const onAppOnlyFree = (!provider || provider === 'opencode') && /-free$/.test(model);
        if (!onAppOnlyFree) return;
        const d = SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS;
        chrome.storage.sync.set({ agentActiveProvider: d.activeProvider, agentModel: d.model });
    });
}

/**
 * Settings pages before 3.4 saved every field on any change, which froze a
 * full copy of the agent's instructions (and every tuning default) into
 * storage. The agent then used that stale copy forever. Drop the copies so
 * the built-in values apply; a prompt the user really wrote themselves is
 * kept as their own instructions, which are now added to the built-in ones.
 */
const RETIRED_SETTINGS = [
    'agentSystemPrompt', 'agentPromptCaching', 'agentTimeout', 'agentMaxTokensPerCall',
    'agentTemperature', 'agentElementLimit', 'agentHistoryLimit', 'agentFailureThreshold',
    'promptLibrary',
    // The pre-v4 loop and the address bar's router (removed in 4.0).
    'agentEngine', 'agentMaxSteps', 'omniboxSmartRouting', 'inlineTemporaryChat', 'inlineProvider',
];
function migrateFrozenSettings() {
    chrome.storage.sync.get(['agentSystemPrompt', 'agentExtraInstructions'], (items) => {
        const old = String(items.agentSystemPrompt || '').trim();
        const wasOurs = /<instructions>|browser_action|Select to AI/i.test(old);
        const keep = old && !wasOurs && !items.agentExtraInstructions && old.length <= 2000;
        const done = () => chrome.storage.sync.remove(RETIRED_SETTINGS);
        if (keep) chrome.storage.sync.set({ agentExtraInstructions: old }, done);
        else done();
    });
}

/**
 * The side panel embeds the assistants' own sites, which send headers that
 * forbid framing. This rule lifts them, but only for requests that belong to
 * no tab: the extension's side panel. It used to be a static rule applying to
 * every iframe, so any website could frame a signed-in ChatGPT or Claude
 * (clickjacking). Session rules vanish when the browser closes, so it is
 * installed at every start.
 */
const SIDE_PANEL_FRAME_RULE_ID = 1;
function installSidePanelFrameRule() {
    chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SIDE_PANEL_FRAME_RULE_ID],
        addRules: [{
            id: SIDE_PANEL_FRAME_RULE_ID,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                responseHeaders: ['x-frame-options', 'frame-options', 'content-security-policy',
                    'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'permissions-policy', 'feature-policy']
                    .map((header) => ({ header, operation: 'remove' })),
            },
            condition: {
                requestDomains: ['chatgpt.com', 'gemini.google.com', 'perplexity.ai', 'claude.ai'],
                resourceTypes: ['sub_frame'],
                tabIds: [chrome.tabs.TAB_ID_NONE],
            },
        }],
    }, () => void chrome.runtime.lastError);
}
installSidePanelFrameRule();
chrome.runtime.onStartup.addListener(installSidePanelFrameRule);

chrome.runtime.onInstalled.addListener((details) => {
    updateContextMenus();
    if (details && details.reason === 'update') {
        migrateAppOnlyFreeModels();
        migrateFrozenSettings();
    }
    if (details && details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
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
        cachedSettings.agentCustomUrl =
            items.agentCustomUrl || SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.customUrl;
        cachedSettings.agentActiveProvider =
            items.agentActiveProvider || SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.activeProvider;

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
                create({ id: "openAgent", title: "Ask the agent about this", contexts: ["selection"] });
            }
        } else {
            // Nested menu for multiple services
            create({ id: "parentFolder", title: "Select to AI", contexts: ["selection"] });
            if (cachedSettings.showChatGPT) create({ id: "openChatGPT", parentId: "parentFolder", title: "Send to ChatGPT", contexts: ["selection"] });
            if (cachedSettings.showGemini) create({ id: "openGemini", parentId: "parentFolder", title: "Send to Gemini", contexts: ["selection"] });
            if (cachedSettings.showPerplexity) create({ id: "openPerplexity", parentId: "parentFolder", title: "Send to Perplexity", contexts: ["selection"] });
            if (cachedSettings.showClaude) create({ id: "openClaude", parentId: "parentFolder", title: "Send to Claude", contexts: ["selection"] });
            if (cachedSettings.showAgent) create({ id: "openAgent", parentId: "parentFolder", title: "Ask the agent about this", contexts: ["selection"] });
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

// Where the selection a request is about is kept until the agent page takes
// it: per tab, in session storage, so it survives the click that would
// clear the page's own selection and never outlives the browser session.
const SELECTION_KEY = (tabId) => `agentSelection:${tabId}`;
const SELECTION_BUDGET = 900; // characters of passage around the selection

/**
 * "Ask the agent about this": the agent opens on the tab, and what was
 * selected goes with it, with its place on the page (agentTools.js
 * selectionPlace), for the composer to show and the run to be given.
 * The panel is opened first, inside the click's user gesture.
 */
function askAgentAboutSelection(info, tab) {
    if (!tab || !tab.id) return;
    const url = `${CONFIG.URLS.AGENT}?tabId=${tab.id}&about=selection`;
    if (cachedSettings.openingMode === 'sidePanel') {
        chrome.sidePanel.open({ windowId: tab.windowId }, () => {
            if (chrome.runtime.lastError) console.warn('Side panel did not open:', chrome.runtime.lastError.message);
        });
        chrome.storage.local.set({ sidePanelState: { url, selectedText: "", autoSend: false, timestamp: Date.now() } });
    } else {
        chrome.tabs.create({ url }, () => void chrome.runtime.lastError);
    }
    const fallback = { text: String(info.selectionText || "").replace(/\s+/g, " ").trim().slice(0, 2000), title: tab.title || "", url: tab.url || "", heading: "", passage: "", row: "", column: "" };
    const keep = (place) => chrome.storage.session.set({ [SELECTION_KEY(tab.id)]: { ...(place && place.text ? place : fallback), tabId: tab.id, at: Date.now() } }).catch(() => {});
    if (!chrome.scripting || !self.SELECT_TO_AI_TOOLS.selectionPlace) { keep(null); return; }
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: info.frameId ? [info.frameId] : [0] }, func: self.SELECT_TO_AI_TOOLS.selectionPlace, args: [SELECTION_BUDGET] })
        .then((r) => keep(r && r[0] && r[0].result), () => keep(null));
}

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

    if (info.menuItemId === "openAgent") { askAgentAboutSelection(info, tab); return; }
    let finalUrl = resolveSessionUrlSync(serviceBaseUrl);
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
            if (chrome.runtime.lastError) console.warn('Side panel did not open:', chrome.runtime.lastError.message);
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
        if (prefillUrl) {
            // the URL itself carries the prompt, nothing to deliver afterwards
            chrome.tabs.create({ url: finalUrl }, () => void chrome.runtime.lastError);
        } else {
            createTabAndSend(finalUrl, {
                selectedText: finalText,
                autoSend: cachedSettings.autoSend,
                timestamp: Date.now(),
            });
        }
    }
});

// Keyboard Command Handler (Open Sidebar or Run Agent)
/**
 * Opens the in-page command palette on the active tab.
 *
 * Injected on demand rather than registered as a content script: it costs
 * nothing on pages where the shortcut is never pressed, and activeTab means
 * no broad host permission is added to the install prompt.
 */
function openCommandPalette(tab) {
    const tabId = tab && tab.id;
    if (!tabId || !chrome.scripting) return;
    chrome.scripting.executeScript(
        { target: { tabId }, files: ['commandPalette.js'] },
        () => {
            if (chrome.runtime.lastError) {
                // Chrome blocks injection on its own pages and the Web Store.
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'icon128.png',
                    title: 'Select to AI',
                    message: 'The command palette cannot open on this page. Try it on a normal website tab.',
                });
            }
        },
    );
}

/**
 * Starts the agent on what was typed in the palette, with any text the user
 * had highlighted when they opened it, on the tab it was opened on.
 */
function runPaletteInput(rawText, rawSelection, originTabId) {
    const trimmed = String(rawText || '').slice(0, SELECT_TO_AI_OMNIBOX.LIMIT).trim();
    if (!trimmed) return;
    if (!cachedSettings.showAgent) { notifyAgentDisabled(); return; }
    const selection = String(rawSelection || '').trim().slice(0, 4000);
    const task = selection
        ? trimmed + '\n\n--- selected text from the page ---\n' + selection
        : trimmed;
    // Pass the tab the palette was opened on. Without it the agent falls
    // back to the window's active tab, which can be a different page.
    const tabParam = originTabId != null ? `&tabId=${originTabId}` : '';
    chrome.tabs.create(
        { url: `${CONFIG.URLS.AGENT}?task=${encodeURIComponent(task)}&autostart=1${tabParam}` },
        () => void chrome.runtime.lastError,
    );
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message && message.type === 'SELECT_TO_AI_PALETTE_SUBMIT') {
        runPaletteInput(message.text, message.selection, sender && sender.tab ? sender.tab.id : null);
    }
});

chrome.commands.onCommand.addListener((command, tab) => {
    if (command === CONFIG.COMMANDS.OPEN_PALETTE) {
        openCommandPalette(tab);
        return;
    }
    if (command === CONFIG.COMMANDS.OPEN_SIDEBAR) {
        // 1. Open Side Panel
        const openPanel = (winId) => {
            chrome.sidePanel.open({ windowId: winId }, () => {
                if (chrome.runtime.lastError) console.warn('Side panel did not open:', chrome.runtime.lastError.message);
            });
        };

        if (tab && tab.windowId) openPanel(tab.windowId);
        else chrome.windows.getCurrent((win) => {
            if (chrome.runtime.lastError || !win) { void chrome.runtime.lastError; return; }
            openPanel(win.id);
        });

        // 2. Set State (Restore last used or default)
        chrome.storage.local.get([CONFIG.STORAGE.SIDE_PANEL_STATE], (result) => {
            let targetBaseUrl = CONFIG.URLS.CHATGPT; // Absolute fallback
            const existing = result[CONFIG.STORAGE.SIDE_PANEL_STATE];

            if (cachedSettings.showAgent) {
                // With the agent on, the side panel opens on the agent; the
                // assistant sites are a click away inside it.
                targetBaseUrl = chrome.runtime.getURL('agent.html') + (tab && tab.id ? `?tabId=${tab.id}` : '');
            } else if (existing && existing.url) {
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
                if (chrome.runtime.lastError) console.warn('Side panel did not open:', chrome.runtime.lastError.message);
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
/**
 * Opens a tab and delivers the prompt once it has finished loading.
 *
 * Guards three failure paths the previous inline versions did not: a create
 * that fails leaves newTab undefined (reading newTab.id threw), a tab that
 * never reaches "complete" because it was closed or blocked left its
 * onUpdated listener attached for the life of the service worker, and
 * sendMessage into a tab with no content script raised an unchecked
 * lastError.
 */
function createTabAndSend(url, message) {
    chrome.tabs.create({ url }, (newTab) => {
        if (chrome.runtime.lastError || !newTab || !newTab.id) {
            void chrome.runtime.lastError;
            return;
        }
        const tabId = newTab.id;
        let finished = false;

        const cleanup = () => {
            if (finished) return;
            finished = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.onRemoved.removeListener(onRemoved);
            clearTimeout(timer);
        };
        const onUpdated = (id, changeInfo) => {
            if (id !== tabId || changeInfo.status !== 'complete') return;
            cleanup();
            // The top frame only: the content script also runs in sub-frames.
            chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, () => void chrome.runtime.lastError);
        };
        const onRemoved = (id) => { if (id === tabId) cleanup(); };

        const timer = setTimeout(cleanup, 30000);
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);
    });
}

function notifyAgentDisabled() {
    // Straight to the one-step setup instead of a settings page to hunt through.
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?step=connect') });
}

// --- CORS Bypassing Proxy Handlers ---

// 1. Unary Message Proxy (for one-off requests like connection tests and model fetches) and Utility Handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // The popup's "Quick box" row: open the palette on the tab behind it.
    if (message.action === 'openPaletteFromPopup') {
        if (!SELECT_TO_AI_SECURITY.isTrustedExtensionSender(sender, chrome.runtime.id)) return false;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0]) openCommandPalette(tabs[0]);
        });
        return false;
    }

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
        // the engine's own requests still accept the saved URL only.
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
});

// --- Omnibox: type "ai" then space in the address bar ---
// Enter starts the agent on what was typed (omnibox.js). The rows under it
// are earlier requests that fit what is typed.

// The window the user is typing in and its active tab, kept up to date so
// Enter can open the side panel before awaiting anything (the gesture an
// omnibox Enter carries does not survive an await).
const omniboxWhere = { windowId: null, tabId: null };
function noteWhere(windowId, tabId) {
    if (Number.isInteger(windowId) && windowId >= 0) omniboxWhere.windowId = windowId;
    if (Number.isInteger(tabId)) omniboxWhere.tabId = tabId;
}
function refreshWhere() {
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }, (win) => {
        if (chrome.runtime.lastError || !win) { void chrome.runtime.lastError; return; }
        noteWhere(win.id, null);
        chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
            if (chrome.runtime.lastError) { void chrome.runtime.lastError; return; }
            if (tabs && tabs[0]) noteWhere(win.id, tabs[0].id);
        });
    });
}
chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === omniboxWhere.windowId || omniboxWhere.windowId === null) noteWhere(info.windowId, info.tabId);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) refreshWhere();
});
refreshWhere();

// The run history the suggestions draw on: the agent's finished tasks.
let omniboxHistory = [];
// The address bar suggests only tasks that worked; the history also keeps the rest.
const finishedTasks = (list) => list.filter((x) => x && (!x.outcome || x.outcome === 'success'));
chrome.storage.local.get('agentCrossSessionMemory', (res) => {
    if (!chrome.runtime.lastError && res && Array.isArray(res.agentCrossSessionMemory)) omniboxHistory = finishedTasks(res.agentCrossSessionMemory);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.agentCrossSessionMemory) omniboxHistory = finishedTasks(changes.agentCrossSessionMemory.newValue || []);
});

if (chrome.omnibox) {
    const OMNI = SELECT_TO_AI_OMNIBOX;
    chrome.omnibox.onInputStarted.addListener(() => refreshWhere());

    chrome.omnibox.onInputChanged.addListener((text, suggest) => {
        const shown = OMNI.suggestionsFor(text, omniboxHistory, { agentOn: !!cachedSettings.showAgent });
        chrome.omnibox.setDefaultSuggestion({ description: shown.defaultDescription });
        suggest(shown.suggestions);
    });

    chrome.omnibox.onInputEntered.addListener((text, disposition) => {
        const plan = OMNI.planEntry(text, disposition);
        if (!plan) return;
        // Same gate as Alt+A, the palette and the side panel.
        if (!cachedSettings.showAgent) { notifyAgentDisabled(); return; }
        OMNI.startRun(chrome, plan, omniboxWhere).catch((e) => console.warn('Select to AI: the address bar request did not start:', e));
    });
}
