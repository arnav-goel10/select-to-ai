/**
 * Select to AI - Background Service Worker
 * Manages context menus, side panel interactions, and storage caching.
 */

// Import shared configuration
importScripts('config.js', 'defaults.js', 'security.js', 'omnibox.js');
// Optional permissions (notifications, optional hosts) go through one helper.
importScripts('core/grants.js');
// The agent's runs live in this worker (engine.js), not in the side panel.
// Loaded on its own: an error in any agent file must not stop the right-click
// menu, which needs nothing below.
let agentLoaded = false;
try {
    importScripts('publicSuffixes.js', 'agentTools.js', 'agentPrompt.js', 'usageLimits.js', 'pageSearch.js',
        'core/step.js', 'core/observe.js', 'core/memory.js', 'core/context.js', 'core/policy.js', 'core/run.js', 'core/llm.js', 'core/learn.js', 'core/view.js', 'core/inject.js', 'pdfText.js',
        // The data consent, kept per provider: the engine checks it before a held run goes on.
        'setup.js',
        'recipes/vendor/recipes-core.js', 'recipes/driver.js', 'recipes/service.js', 'engine.js');
    // Saved runs ("recipes") and their replays, for the agent's page.
    if (self.SELECT_TO_AI_RECIPES) self.SELECT_TO_AI_RECIPES.install(chrome);
    agentLoaded = true;
} catch (e) {
    console.error('Select to AI: the agent did not load, right-click sending still works.', e);
}

if (typeof CONFIG === 'undefined') {
    console.error("Select to AI: CONFIG failed to load in background.");
}

const GRANTS = self.SELECT_TO_AI_GRANTS;
const CLAUDE_ORIGIN = 'https://claude.ai/*';

// What the worker assumes until the stored settings have been read.
const DEFAULT_SETTINGS = Object.freeze({
    autoSend: false,
    autoContext: false,
    openingMode: 'sidePanel',
    showChatGPT: true,
    showGemini: true,
    showPerplexity: false,
    showClaude: true,
    showAgent: false,
    agentCustomUrl: SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.customUrl,
});

// Cached settings to minimize storage reads
let cachedSettings = { ...DEFAULT_SETTINGS };

// A woken worker runs a click before storage has answered, so anything that
// reads the settings awaits this first. True once one read has landed.
let settingsLoaded = false;
let settingsReady = null;

// --- Initialization ---

// Initialize cache on startup
updateCache();

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        updateCache();
    }
});

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
                    'cross-origin-opener-policy', 'cross-origin-embedder-policy']
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
chrome.runtime.onStartup.addListener(() => {
    installSidePanelFrameRule();
    if (GRANTS) GRANTS.registerAssistantScripts();
});

// A grant made on any page (Claude, perplexity.ai, notifications): the frame
// rule only applies to hosts the extension holds, so it is put in again, the
// assistant content script follows the grant, and the menu shows Claude.
function onGrantsChanged() {
    installSidePanelFrameRule();
    if (GRANTS) GRANTS.registerAssistantScripts();
    updateContextMenus();
}
if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(onGrantsChanged);
if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(onGrantsChanged);

/**
 * The leading number of a version string ("2.0" -> 2, "3.3.1" -> 3), or
 * NaN when there is none.
 */
function majorVersion(version) {
    return parseInt(String(version || '').split('.')[0], 10);
}

/** -1, 0 or 1 for two dotted versions, missing parts read as 0. */
function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

const LEGACY_V2_SETTINGS = ['sidebarMode', 'contextMode'];
// Read by the popup: shows a one-time "What is new" note. No tab is opened.
// Worker and popup take the key from config.js, so they cannot drift apart.
const UPGRADE_NOTICE_KEY = CONFIG.STORAGE.UPGRADE_NOTICE;

/**
 * "New" on the toolbar icon while the note is unread: an update opens no
 * tab, so this is what tells the user there is something to open the popup
 * for. Chrome forgets a badge when the browser closes, so it is set again at
 * every worker start and cleared when the popup removes the notice.
 */
function showUpgradeBadge(on) {
    if (!chrome.action || typeof chrome.action.setBadgeText !== 'function') return;
    try {
        const done = chrome.action.setBadgeText({ text: on ? 'New' : '' }, () => void chrome.runtime.lastError);
        if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch (e) { /* the badge is a hint, never a reason to fail */ }
}
chrome.storage.local.get(UPGRADE_NOTICE_KEY, (items) => {
    if (!chrome.runtime.lastError && items && items[UPGRADE_NOTICE_KEY]) showUpgradeBadge(true);
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes[UPGRADE_NOTICE_KEY]) showUpgradeBadge(!!changes[UPGRADE_NOTICE_KEY].newValue);
});

/**
 * 2.0 saved a setting only when its control was touched, and read the
 * untouched ones differently from 4.0: Perplexity shown, the page address not
 * added, and a popup-window mode 4.0 no longer has. This writes what 2.0 was
 * showing, so the update changes nothing the user sees.
 */
function v2SettingsFix(items) {
    const set = {};
    if (items.showPerplexity === undefined) set.showPerplexity = true;
    if (items.autoContext === undefined) set.autoContext = false;
    if (items.openingMode !== 'tab' && items.openingMode !== 'sidePanel') set.openingMode = 'sidePanel';
    return set;
}

function migrateFromV2() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['showPerplexity', 'autoContext', 'openingMode', ...LEGACY_V2_SETTINGS], (items) => {
            const set = v2SettingsFix(items || {});
            const done = () => chrome.storage.sync.remove(LEGACY_V2_SETTINGS, () => { void chrome.runtime.lastError; resolve(set); });
            if (Object.keys(set).length) chrome.storage.sync.set(set, done);
            else done();
        });
    });
}

/**
 * 3.x showed Claude unless it was turned off, and held claude.ai from the
 * install. 4.0 asks for that host, so what 3.x was showing is written down:
 * the popup and Settings then know this user had Claude, and offer it back
 * when Chrome does not hold the host after the update.
 */
function keepClaudeChoice() {
    chrome.storage.sync.get(['showClaude'], (items) => {
        if (chrome.runtime.lastError || !items || items.showClaude !== undefined) return;
        chrome.storage.sync.set({ showClaude: true });
    });
}

/**
 * A new install starts with CONFIG.STORAGE.FRESH_SETTINGS (Perplexity in
 * the right-click menu: its host is a required permission, so nothing more
 * is asked). A key already set is kept. Only a fresh install: an upgrade
 * keeps what that user's version was showing (see v2SettingsFix and
 * keepClaudeChoice). Reset in Settings writes the same settings.
 */
function writeFreshSettings() {
    const fresh = CONFIG.STORAGE.FRESH_SETTINGS;
    chrome.storage.sync.get(Object.keys(fresh), (items) => {
        if (chrome.runtime.lastError || !items) return;
        const unset = Object.fromEntries(Object.entries(fresh).filter(([k]) => items[k] === undefined));
        if (Object.keys(unset).length) chrome.storage.sync.set(unset);
    });
}

// The menu is built at every worker start from the stored settings (see
// updateCache), so onInstalled only migrates. A fresh install also opens the
// welcome page; an update opens nothing.
function onInstalledHandler(details) {
    const reason = details && details.reason;
    if (GRANTS) GRANTS.registerAssistantScripts();
    if (reason === 'update') {
        const previous = details.previousVersion;
        if (majorVersion(previous) < 3) migrateFromV2();
        else if (compareVersions(previous, '4.0.0') < 0) keepClaudeChoice();
        if (previous && compareVersions(previous, '4.0.0') < 0) {
            chrome.storage.local.set({ [UPGRADE_NOTICE_KEY]: { from: String(previous), at: Date.now() } });
        }
        migrateAppOnlyFreeModels();
        migrateFrozenSettings();
    }
    if (reason === 'install') {
        writeFreshSettings();
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
}
chrome.runtime.onInstalled.addListener(onInstalledHandler);

/** Puts stored settings into the cache, with the defaults for what is unset. */
function applySettings(items) {
    cachedSettings.autoSend = items.autoSend === true;
    cachedSettings.autoContext = items.autoContext === true; // Off unless chosen
    cachedSettings.showChatGPT = items.showChatGPT !== false;
    cachedSettings.showGemini = items.showGemini !== false;
    cachedSettings.showPerplexity = items.showPerplexity === true;
    cachedSettings.showClaude = items.showClaude !== false;
    cachedSettings.showAgent = items.showAgent === true;
    cachedSettings.agentCustomUrl =
        items.agentCustomUrl || SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.customUrl;
    cachedSettings.agentActiveProvider =
        items.agentActiveProvider || SELECT_TO_AI_DEFAULTS.AGENT_DEFAULTS.activeProvider;
    // Anything but a new tab (including 2.0's retired popup window) is the side panel.
    cachedSettings.openingMode = items.openingMode === 'tab' ? 'tab' : 'sidePanel';
}

/**
 * Reads the settings into the cache and rebuilds the menu from them.
 * settingsReady resolves once the cache holds the stored values.
 */
function updateCache() {
    const read = new Promise((resolve) => {
        chrome.storage.sync.get(CONFIG.STORAGE.SETTINGS, (items) => {
            void chrome.runtime.lastError;
            applySettings(items || {});
            settingsLoaded = true;
            resolve(cachedSettings);
        });
    });
    settingsReady = read;
    read.then(() => updateContextMenus());
    return read;
}

/** The settings, once read: what every handler awaits before using them. */
function whenSettings() {
    return settingsReady || updateCache();
}

// --- Context menu ---

// Menu ids carry how the click opens ("openChatGPT|tab"), so a click on a
// worker that has just woken knows whether to open the side panel inside the
// click's gesture without waiting for storage. Ids without the suffix (menus
// built by an older version) mean the side panel.
const MENU_SERVICES = {
    openChatGPT: () => CONFIG.URLS.CHATGPT,
    openGemini: () => CONFIG.URLS.GEMINI,
    openPerplexity: () => CONFIG.URLS.PERPLEXITY,
    openClaude: () => CONFIG.URLS.CLAUDE,
    openAgent: () => CONFIG.URLS.AGENT,
};
const MODE_SUFFIX = { tab: 'tab', sidePanel: 'panel' };
// The page item opens the side panel whatever the opening mode, so its id
// needs no mode.
const OPEN_PANEL_MENU_ID = 'openSidePanel';

function menuId(name, mode) {
    return `${name}|${MODE_SUFFIX[mode] || MODE_SUFFIX.sidePanel}`;
}

/** { name, mode } for a menu id, mode null when the id has no suffix. */
function parseMenuId(id) {
    const [name, suffix] = String(id || '').split('|');
    if (!MENU_SERVICES[name]) return null;
    const mode = suffix === MODE_SUFFIX.tab ? 'tab' : suffix === MODE_SUFFIX.sidePanel ? 'sidePanel' : null;
    return { name, mode };
}

/** The items the menu shows, in order, for the given settings and grants. */
function menuItems(settings, claudeGranted) {
    const items = [];
    if (settings.showChatGPT) items.push({ name: 'openChatGPT', title: 'Send to ChatGPT' });
    if (settings.showGemini) items.push({ name: 'openGemini', title: 'Send to Gemini' });
    if (settings.showPerplexity) items.push({ name: 'openPerplexity', title: 'Send to Perplexity' });
    // claude.ai is optional in 4.0: the item appears once the user grants it.
    // A user who had Claude and lost the host is offered it back in the
    // popup and in Settings (showClaude true with the host not held).
    if (settings.showClaude && claudeGranted) items.push({ name: 'openClaude', title: 'Send to Claude' });
    if (settings.showAgent) items.push({ name: 'openAgent', title: 'Ask the agent about this' });
    return items;
}

function removeAllMenus() {
    return new Promise((resolve) => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; resolve(); }));
}

async function buildContextMenus() {
    const settings = await whenSettings();
    const claudeGranted = GRANTS ? await GRANTS.hasHost(CLAUDE_ORIGIN) : false;
    await removeAllMenus();
    const items = menuItems(settings, claudeGranted);
    const mode = settings.openingMode;
    const create = (props) => {
        chrome.contextMenus.create(props, () => {
            if (chrome.runtime.lastError) console.log("Menu creation ignored:", chrome.runtime.lastError.message);
        });
    };
    // Right-click on the page itself (2.0's "Open AI Sidebar"): opens the
    // side panel as the open-sidebar shortcut does, on whatever it would
    // show. It is there whatever is turned on, as in 2.0; with nothing on,
    // the panel says where to turn something on.
    create({ id: OPEN_PANEL_MENU_ID, title: 'Open Select to AI side panel', contexts: ["page"] });
    // Nothing turned on: no selection menu, rather than an empty "Select to AI".
    if (!items.length) return;
    if (items.length === 1) {
        create({ id: menuId(items[0].name, mode), title: items[0].title, contexts: ["selection"] });
        return;
    }
    create({ id: "parentFolder", title: "Select to AI", contexts: ["selection"] });
    for (const item of items) {
        create({ id: menuId(item.name, mode), parentId: "parentFolder", title: item.title, contexts: ["selection"] });
    }
}

// One rebuild at a time: two overlapping removeAll and create passes leave
// duplicate or missing items.
let menuChain = Promise.resolve();
let menuQueued = false;

/**
 * Re-creates the context menu items based on current settings. Calls made
 * while a rebuild is waiting collapse into that one.
 */
function updateContextMenus() {
    if (menuQueued) return menuChain;
    menuQueued = true;
    menuChain = menuChain.then(() => {
        menuQueued = false;
        return buildContextMenus();
    }).catch((e) => console.warn('Select to AI: menu rebuild failed:', e));
    return menuChain;
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
// Past this many encoded characters the prompt goes in through the page
// instead: long URLs are cut or refused by the sites (a whole article, or
// about 900 CJK characters, already reaches it).
const PREFILL_MAX_ENCODED = 2000;

function buildPrefillUrl(finalUrl, serviceBaseUrl, text, willAutoSend) {
    if (!willAutoSend || !text) return null;
    if (finalUrl !== serviceBaseUrl) return null; // continue-session insert
    const prefillTemplates = CONFIG.PREFILL_URLS || {};
    let template = null;
    if (serviceBaseUrl === CONFIG.URLS.CHATGPT) template = prefillTemplates.CHATGPT;
    else if (serviceBaseUrl === CONFIG.URLS.PERPLEXITY) template = prefillTemplates.PERPLEXITY;
    if (!template) return null;
    const encoded = encodeURIComponent(text);
    if (encoded.length > PREFILL_MAX_ENCODED) return null;
    return template.replace('{query}', encoded);
}

/** Opens the side panel. Must run inside the click, before any await. */
function openSidePanel(windowId) {
    try {
        chrome.sidePanel.open({ windowId }, () => {
            if (chrome.runtime.lastError) console.warn('Side panel did not open:', chrome.runtime.lastError.message);
        });
    } catch (e) {
        console.warn('Side panel did not open:', e && e.message);
    }
}

// A window the side panel can open in: a click outside a normal tab (a PDF
// viewer, some browser pages) brings no tab or a tab without one.
const hasWindow = (tab) => !!(tab && Number.isInteger(tab.windowId) && tab.windowId >= 0);

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
function askAgentAboutSelection(info, tab, openingMode) {
    if (!tab || !tab.id || tab.id < 0) return;
    const url = `${CONFIG.URLS.AGENT}?tabId=${tab.id}&about=selection`;
    const mode = openingMode || cachedSettings.openingMode;
    if (mode === 'sidePanel' && hasWindow(tab)) {
        openSidePanel(tab.windowId);
        chrome.storage.local.set({ sidePanelState: { url, selectedText: "", autoSend: false, timestamp: Date.now() } });
    } else {
        chrome.tabs.create({ url }, () => void chrome.runtime.lastError);
    }
    const fallback = { text: String(info.selectionText || "").replace(/\s+/g, " ").trim().slice(0, 2000), title: tab.title || "", url: tab.url || "", heading: "", passage: "", row: "", column: "" };
    const keep = (place) => chrome.storage.session.set({ [SELECTION_KEY(tab.id)]: { ...(place && place.text ? place : fallback), tabId: tab.id, at: Date.now() } }).catch(() => {});
    if (!chrome.scripting || !self.SELECT_TO_AI_TOOLS || !self.SELECT_TO_AI_TOOLS.selectionPlace) { keep(null); return; }
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: info.frameId ? [info.frameId] : [0] }, func: self.SELECT_TO_AI_TOOLS.selectionPlace, args: [SELECTION_BUDGET] })
        .then((r) => keep(r && r[0] && r[0].result), () => keep(null));
}

/**
 * What a right-click send does once the settings are known: the text (with
 * the page address only if the user turned that on), always into a new
 * conversation at the service's base URL, as 2.0 did.
 */
function deliverSelection(serviceBaseUrl, mode, info, tab, settings) {
    const selectedText = (info && info.selectionText) || "";
    let finalText = selectedText;
    if (settings.autoContext && tab && tab.url) {
        finalText = `Context: ${tab.url}\n\n${selectedText}`;
    }

    // New-conversation prefill: ChatGPT / Perplexity accept the prompt as a
    // URL parameter (which also submits), skipping DOM insertion entirely.
    let finalUrl = serviceBaseUrl;
    const prefillUrl = buildPrefillUrl(finalUrl, serviceBaseUrl, finalText, settings.autoSend);
    if (prefillUrl) {
        finalUrl = prefillUrl;
        finalText = ""; // content script has nothing left to do
    }

    if (mode === 'sidePanel') {
        // The panel was opened in the click; the content script inside it
        // picks this up.
        chrome.storage.local.set({
            sidePanelState: {
                url: finalUrl,
                selectedText: finalText,
                autoSend: prefillUrl ? false : settings.autoSend,
                timestamp: Date.now()
            }
        });
    } else if (prefillUrl) {
        // the URL itself carries the prompt, nothing to deliver afterwards
        chrome.tabs.create({ url: finalUrl }, () => void chrome.runtime.lastError);
    } else {
        createTabAndSend(finalUrl, {
            selectedText: finalText,
            autoSend: settings.autoSend,
            timestamp: Date.now(),
        });
    }
}

/**
 * The right-click handler. The side panel opens first, inside the click's
 * user gesture, using the mode written into the menu id; everything that
 * reads settings waits for them, so a click that woke the worker behaves as
 * one on a warm worker.
 */
function onMenuClicked(info, tab) {
    if (info && info.menuItemId === OPEN_PANEL_MENU_ID) { onOpenSidebarCommand(tab); return; }
    const parsed = parseMenuId(info && info.menuItemId);
    if (!parsed) return; // Unknown menu item
    let mode = parsed.mode || (settingsLoaded ? cachedSettings.openingMode : 'sidePanel');
    if (mode === 'sidePanel' && !hasWindow(tab)) mode = 'tab';

    if (parsed.name === "openAgent") { askAgentAboutSelection(info, tab, mode); return; }
    if (mode === 'sidePanel') openSidePanel(tab.windowId);
    const serviceBaseUrl = MENU_SERVICES[parsed.name]();
    whenSettings()
        .then((settings) => deliverSelection(serviceBaseUrl, mode, info, tab, settings))
        .catch((e) => console.warn('Select to AI: the send did not go through:', e));
}
chrome.contextMenus.onClicked.addListener(onMenuClicked);

// Keyboard Command Handler (Open Sidebar or Run Agent)
/**
 * Opens the in-page command palette on the active tab.
 *
 * Injected on demand rather than registered as a content script: it costs
 * nothing on pages where the shortcut is never pressed, and activeTab means
 * no broad host permission is added to the install prompt.
 */
function openCommandPalette(tab, onResult) {
    const tabId = tab && tab.id;
    const report = (opened) => { if (typeof onResult === 'function') onResult(opened); };
    if (!tabId || tabId < 0 || !chrome.scripting) { report(false); return; }
    chrome.scripting.executeScript(
        { target: { tabId }, files: ['commandPalette.js'] },
        () => {
            if (chrome.runtime.lastError) {
                void chrome.runtime.lastError;
                // Chrome blocks injection on its own pages and the Web Store.
                paletteBlockedOn(tabId);
                report(false);
                return;
            }
            report(true);
        },
    );
}

/**
 * Says on the toolbar icon, for this tab only, that the quick box could not
 * open here: a mark on the icon and the reason on hover, with a notification
 * as well when the user granted those. Chrome drops a tab's own mark and
 * title when that tab loads another page, so nothing has to clear them.
 * The mark is a grey '×', not the engine's orange '!' (a run needs you),
 * and the tab is recorded so that a later "needs you" is set over it
 * (engine.js attention).
 */
const PALETTE_BLOCKED_TEXT = 'The quick box cannot open on this page. Try it on a website tab.';
function paletteBlockedOn(tabId) {
    const a = chrome.action;
    const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
    try {
        if (a && typeof a.setBadgeText === 'function') quiet(a.setBadgeText({ tabId, text: '\u00d7' }, () => void chrome.runtime.lastError));
        if (a && typeof a.setBadgeBackgroundColor === 'function') quiet(a.setBadgeBackgroundColor({ tabId, color: '#6b7280' }, () => void chrome.runtime.lastError));
        if (a && typeof a.setTitle === 'function') quiet(a.setTitle({ tabId, title: PALETTE_BLOCKED_TEXT }, () => void chrome.runtime.lastError));
    } catch (e) { /* the mark is a hint, never a reason to fail */ }
    const area = chrome.storage && chrome.storage.session;
    const key = CONFIG.STORAGE.ICON_TAB_MARKS;
    if (area) quiet(area.get(key).then((got) => area.set({ [key]: { ...((got && got[key]) || {}), [tabId]: 'hint' } })));
    if (GRANTS) GRANTS.notify({ message: PALETTE_BLOCKED_TEXT });
}

/**
 * Starts the agent on what was typed in the palette, with any text the user
 * had highlighted when they opened it, on the tab it was opened on.
 */
async function runPaletteInput(rawText, rawSelection, originTabId) {
    const trimmed = String(rawText || '').slice(0, SELECT_TO_AI_OMNIBOX.LIMIT).trim();
    if (!trimmed) return;
    const selection = String(rawSelection || '').trim().slice(0, 4000);
    const task = selection
        ? trimmed + '\n\n--- selected text from the page ---\n' + selection
        : trimmed;
    const settings = await whenSettings();
    if (!settings.showAgent) { notifyAgentDisabled(task, originTabId); return; }
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
        runPaletteInput(message.text, message.selection, sender && sender.tab ? sender.tab.id : null)
            .catch((e) => console.warn('Select to AI: the quick box request did not start:', e));
    }
});

/** Opens the side panel in the tab's window, or the current one. */
function openPanelFor(tab, onFail) {
    const open = (windowId) => {
        try {
            chrome.sidePanel.open({ windowId }, () => {
                const err = chrome.runtime.lastError;
                if (err) { console.warn('Side panel did not open:', err.message); if (onFail) onFail(); }
            });
        } catch (e) {
            console.warn('Side panel did not open:', e && e.message);
            if (onFail) onFail();
        }
    };
    if (hasWindow(tab)) { open(tab.windowId); return; }
    chrome.windows.getCurrent((win) => {
        if (chrome.runtime.lastError || !win) { void chrome.runtime.lastError; if (onFail) onFail(); return; }
        open(win.id);
    });
}

const tabQuery = (tab) => (tab && Number.isInteger(tab.id) && tab.id >= 0 ? `?tabId=${tab.id}` : '');

function writePanelState(url) {
    chrome.storage.local.set({
        sidePanelState: { url, selectedText: '', autoSend: false, timestamp: Date.now() }
    });
}

/** The open-sidebar shortcut: the panel at once, its page once settings are read. */
function onOpenSidebarCommand(tab) {
    openPanelFor(tab);
    Promise.all([
        whenSettings(),
        new Promise((resolve) => chrome.storage.local.get([CONFIG.STORAGE.SIDE_PANEL_STATE], (r) => resolve((r || {})[CONFIG.STORAGE.SIDE_PANEL_STATE]))),
        GRANTS ? GRANTS.hasHost(CLAUDE_ORIGIN) : Promise.resolve(false),
    ]).then(([settings, existing, claudeGranted]) => {
        let targetBaseUrl = CONFIG.URLS.CHATGPT; // Absolute fallback
        if (settings.showAgent) {
            // With the agent on, the side panel opens on the agent; the
            // assistant sites are a click away inside it.
            targetBaseUrl = chrome.runtime.getURL('agent.html') + tabQuery(tab);
        } else if (existing && existing.url) {
            targetBaseUrl = existing.url; // Use last used
        } else if (settings.showChatGPT) targetBaseUrl = CONFIG.URLS.CHATGPT;
        else if (settings.showGemini) targetBaseUrl = CONFIG.URLS.GEMINI;
        else if (settings.showPerplexity) targetBaseUrl = CONFIG.URLS.PERPLEXITY;
        else if (settings.showClaude && claudeGranted) targetBaseUrl = CONFIG.URLS.CLAUDE;
        writePanelState(resolveSessionUrlSync(targetBaseUrl));
    });
}

/**
 * Alt+A. One coherent gate: "Enable AI Browser Agent" controls every agent
 * entry point, and with it off the shortcut opens the setup. On a warm worker
 * the panel opens inside the key press; on one the key press just woke, the
 * settings are read first and the agent opens in a tab if the panel can no
 * longer be opened.
 */
function onRunAgentCommand(tab) {
    const agentUrl = () => chrome.runtime.getURL('agent.html') + tabQuery(tab);
    const inTab = () => chrome.tabs.create({ url: agentUrl() }, () => void chrome.runtime.lastError);
    if (settingsLoaded) {
        if (!cachedSettings.showAgent) { notifyAgentDisabled(); return; }
        openPanelFor(tab, inTab);
        writePanelState(agentUrl());
        return;
    }
    whenSettings().then((settings) => {
        if (!settings.showAgent) { notifyAgentDisabled(); return; }
        openPanelFor(tab, inTab);
        writePanelState(agentUrl());
    });
}

chrome.commands.onCommand.addListener((command, tab) => {
    if (command === CONFIG.COMMANDS.OPEN_PALETTE) openCommandPalette(tab);
    else if (command === CONFIG.COMMANDS.OPEN_SIDEBAR) onOpenSidebarCommand(tab);
    else if (command === 'run-agent') onRunAgentCommand(tab);
});

/**
 * Opens a tab and delivers the prompt once it has finished loading.
 *
 * Guards the failure paths: a create that fails leaves newTab undefined, a
 * tab that never reaches "complete" (closed or blocked) must not keep its
 * listeners for the life of the worker, and a message into a tab whose
 * content script is not listening yet is tried again, every 300 ms up to 10
 * times, inside the same 30 s limit. The content script drops repeats by
 * timestamp, so a retry never pastes twice.
 */
const DELIVERY_TRIES = 10;
const DELIVERY_RETRY_MS = 300;
function createTabAndSend(url, message) {
    chrome.tabs.create({ url }, (newTab) => {
        if (chrome.runtime.lastError || !newTab || !newTab.id) {
            void chrome.runtime.lastError;
            return;
        }
        const tabId = newTab.id;
        let finished = false;
        let tries = 0;
        let retry = null;

        const cleanup = () => {
            if (finished) return;
            finished = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.onRemoved.removeListener(onRemoved);
            clearTimeout(timer);
            clearTimeout(retry);
        };
        const attempt = () => {
            if (finished) return;
            tries += 1;
            // The top frame only: the content script also runs in sub-frames.
            chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (reply) => {
                const failed = chrome.runtime.lastError || !reply || reply.status !== 'success';
                if (!failed) { cleanup(); return; }
                if (tries >= DELIVERY_TRIES) { cleanup(); return; }
                retry = setTimeout(attempt, DELIVERY_RETRY_MS);
            });
        };
        const onUpdated = (id, changeInfo) => {
            if (id !== tabId || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            attempt();
        };
        const onRemoved = (id) => { if (id === tabId) cleanup(); };

        const timer = setTimeout(cleanup, 30000);
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);
    });
}

// What was typed into the quick box while the agent was off, kept until the
// agent is turned on (session storage: only extension pages can read it).
const PENDING_TASK_KEY = 'pendingAgentTask';
const PENDING_TASK_MS = 30 * 60000;

/**
 * The one place a kept quick-box task is offered. Whenever the agent is
 * turned on, from the setup page, Settings or anywhere else, the agent page
 * opens on the tab the task was typed on with the task in its box, for the
 * user to send or change. It is taken once, and not offered after 30 minutes.
 */
function offerKeptTask() {
    const area = chrome.storage.session;
    if (!area) return Promise.resolve();
    return area.get(PENDING_TASK_KEY).then((got) => {
        const kept = got && got[PENDING_TASK_KEY];
        if (!kept) return undefined;
        return area.remove(PENDING_TASK_KEY).then(() => {
            const text = String(kept.text || '').trim();
            if (!text || !(Date.now() - (kept.at || 0) < PENDING_TASK_MS)) return;
            const params = new URLSearchParams();
            if (Number.isInteger(kept.tabId)) params.set('tabId', String(kept.tabId));
            params.set('task', text.slice(0, 2000));
            chrome.tabs.create({ url: chrome.runtime.getURL(`agent.html?${params}`) }, () => void chrome.runtime.lastError);
        });
    }).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, namespace) => {
    const on = namespace === 'sync' && changes.showAgent;
    if (on && on.newValue === true && on.oldValue !== true) offerKeptTask();
});

/** Shared "agent is disabled" handling for gated entry points. */
function notifyAgentDisabled(task, tabId) {
    if (task) {
        chrome.storage.session.set({ [PENDING_TASK_KEY]: { text: String(task), tabId: tabId != null ? tabId : null, at: Date.now() } })
            .catch(() => {});
    }
    // Straight to the one-step setup instead of a settings page to hunt through.
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?step=connect') }, () => void chrome.runtime.lastError);
}

// --- CORS Bypassing Proxy Handlers ---

// 1. Unary Message Proxy (for one-off requests like connection tests and model fetches) and Utility Handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // The popup's "Quick box" row: open the palette on the tab behind it.
    if (message.action === 'openPaletteFromPopup') {
        if (!SELECT_TO_AI_SECURITY.isTrustedExtensionSender(sender, chrome.runtime.id)) return false;
        // The popup waits for the answer: it stays open to say why when the
        // quick box cannot open on the tab behind it.
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            openCommandPalette(tabs && tabs[0], (opened) => {
                try { sendResponse({ opened }); } catch (e) { /* the popup closed */ }
            });
        });
        return true;
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
        // Same gate as Alt+A, the palette and the side panel. startRun opens
        // the panel before awaiting anything, so it runs at once when the
        // settings are already read.
        const start = () => OMNI.startRun(chrome, plan, omniboxWhere)
            .catch((e) => console.warn('Select to AI: the address bar request did not start:', e));
        if (settingsLoaded) {
            if (!cachedSettings.showAgent) { notifyAgentDisabled(); return; }
            start();
            return;
        }
        whenSettings().then((settings) => {
            if (!settings.showAgent) { notifyAgentDisabled(); return; }
            start();
        });
    });
}
