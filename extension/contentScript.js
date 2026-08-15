(function () {
    'use strict';

    // Verify CONFIG is loaded
    if (typeof CONFIG === 'undefined') {
        console.error("Select to AI: CONFIG not loaded. Injection failed.");
        return;
    }

    const { URLS, HOSTS, SELECTORS, DELAYS } = CONFIG;
    const hostname = window.location.hostname;
    let config = null;
    let lastProcessedTimestamp = 0;

    // --- Configuration Selection ---
    // Only the supported AI chat hosts get a config; on any other page this
    // script does nothing.
    if (hostname.includes(HOSTS.CHATGPT)) {
        config = {
            selector: SELECTORS.CHATGPT.INPUT,
            inputType: "contenteditable",
            sendButtonSelector: SELECTORS.CHATGPT.SEND_BTN
        };
    } else if (hostname.includes(HOSTS.GEMINI)) {
        config = {
            selector: SELECTORS.GEMINI.INPUT,
            inputType: "contenteditable",
            sendButtonSelector: SELECTORS.GEMINI.SEND_BTN
        };
    } else if (hostname.includes(HOSTS.PERPLEXITY)) {
        config = {
            selector: SELECTORS.PERPLEXITY.INPUT,
            inputType: "contenteditable",
            sendButtonSelector: SELECTORS.PERPLEXITY.SEND_BTN
        };
    } else if (hostname.includes(HOSTS.CLAUDE)) {
        config = {
            selector: SELECTORS.CLAUDE.INPUT,
            inputType: "contenteditable",
            sendButtonSelector: SELECTORS.CLAUDE.SEND_BTN
        };
    }

    if (config) {
        init();
    }

    /**
     * Waits for an element to appear in the DOM.
     * @param {string} selector - The CSS selector to wait for.
     * @param {number} timeout - Max time to wait (ms).
     * @returns {Promise<Element>}
     */
    function waitForElement(selector, timeout = DELAYS.MAX_WAIT) {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) {
                return resolve(element);
            }

            const observer = new MutationObserver((mutations, obs) => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                    obs.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timeout waiting for element: ${selector}`));
            }, timeout);
        });
    }

    /**
     * Processes text injection and auto-sending.
     * @param {string} text - The text to inject.
     * @param {boolean} autoSend - Whether to automatically click send.
     * @param {string} insertMode - 'append', 'prepend', or 'replace'.
     * @param {number} reqId - Unique timestamp ID for deduplication.
     */
    function processText(text, autoSend, insertMode = 'append', reqId = null) {

        // FORCE APPEND FOR PERPLEXITY (Stability Fix)
        if (hostname.includes(HOSTS.PERPLEXITY)) {
            insertMode = 'append';
        }

        console.log(`Select to AI: Processing text for ${hostname} (Mode: ${insertMode})`, text);

        waitForElement(config.selector).then((element) => {
            console.log("Select to AI: Input element found.");

            window.focus();
            element.focus();

            // Detect input type if unknown
            let currentInputType = config.inputType;
            if (currentInputType === "unknown") {
                const tagName = element.tagName.toLowerCase();
                currentInputType = (tagName === 'textarea' || tagName === 'input') ? 'text' : 'contenteditable';
            }

            if (currentInputType === "contenteditable" || element.getAttribute('contenteditable') === 'true') {
                element.focus();

                // Cursor Positioning
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(element);

                if (insertMode === 'prepend') {
                    range.collapse(true); // Start
                } else if (insertMode === 'append') {
                    // Fix for Sequential Sends on Perplexity: Clear before append to prevent duplication
                    if (hostname.includes(HOSTS.PERPLEXITY)) {
                        element.textContent = '';
                    }
                    range.collapse(false); // End
                } else if (insertMode === 'replace') {
                    // Safe Replace Logic: Select All -> Delete -> Paste
                    selection.removeAllRanges();
                    selection.addRange(range);
                    document.execCommand('delete');

                    // Reset range after delete
                    const newRange = document.createRange();
                    newRange.selectNodeContents(element);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }

                if (insertMode !== 'replace') {
                    selection.removeAllRanges();
                    selection.addRange(range);
                }

                // Injection: execCommand (Standard) + Fallback
                const result = document.execCommand('insertText', false, text);
                if (!result) {
                    if (insertMode === 'replace') element.textContent = text;
                    else element.textContent += text;
                }

                // Event Dispatching (Required for frameworks like React/Quill/Lexical)
                element.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: text
                }));
            } else {
                // Standard Input/Textarea Logic
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                if (nativeInputValueSetter && element.tagName.toLowerCase() === 'textarea') {
                    nativeInputValueSetter.call(element, text);
                } else {
                    element.value = text;
                }
            }

            // Trigger UI Updates
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));

            // Rich Keyboard Events (for complex editors)
            ['keydown', 'keypress', 'keyup'].forEach(type => {
                element.dispatchEvent(new KeyboardEvent(type, { bubbles: true }));
            });

            // Auto-Send Logic
            if (autoSend && config.sendButtonSelector) {
                // Determine service-specific delay from CONFIG
                let delay = DELAYS.POLLING_INTERVAL; // Default low
                if (hostname.includes(HOSTS.CHATGPT)) delay = DELAYS.CHATGPT;
                else if (hostname.includes(HOSTS.GEMINI)) delay = DELAYS.GEMINI;
                else if (hostname.includes(HOSTS.PERPLEXITY)) delay = DELAYS.PERPLEXITY;
                else if (hostname.includes(HOSTS.CLAUDE)) delay = DELAYS.CLAUDE;

                console.log(`Select to AI: Auto-sending in ${delay}ms...`);

                setTimeout(() => {
                    clickSend();
                }, delay);
            }

            function clickSend() {
                const btn = document.querySelector(config.sendButtonSelector);
                if (btn) {
                    const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
                    if (!isDisabled) {
                        btn.click();
                    } else {
                        btn.click(); // Try anyway
                    }
                } else {
                    console.warn("Select to AI: Send button not found.");
                }
            }

        }).catch((error) => {
            console.error("Select to AI: Error finding input element:", error);
        });
    }

    /**
     * Initializes the main state checking, runtime message listening, and session saving hooks.
     */
    function init() {
        // 1. Initial State Check (Polling)
        chrome.storage.local.get([CONFIG.STORAGE.SIDE_PANEL_STATE], (items) => {
            if (items[CONFIG.STORAGE.SIDE_PANEL_STATE]) {
                const state = items[CONFIG.STORAGE.SIDE_PANEL_STATE];
                const timeDiff = Date.now() - (state.timestamp || 0);

                // Freshness & Deduplication Check
                if (timeDiff < CONFIG.DELAYS.SIDE_PANEL_FRESHNESS && (!state.timestamp || state.timestamp > lastProcessedTimestamp)) {
                    if (config && state.selectedText) {
                        if (state.timestamp) lastProcessedTimestamp = state.timestamp;
                        processText(state.selectedText, state.autoSend, state.insertMode || 'replace', state.timestamp);
                    }
                }
            }
        });

        // 2. Storage Listener
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes[CONFIG.STORAGE.SIDE_PANEL_STATE]) {
                const newState = changes[CONFIG.STORAGE.SIDE_PANEL_STATE].newValue;
                if (newState && newState.selectedText && config) {
                    if (newState.timestamp && newState.timestamp > lastProcessedTimestamp) {

                        // URL Verification Logic
                        const currentUrl = window.location.href;
                        const targetUrl = newState.url;
                        let isMatch = false;

                        // Relaxed matching for SPA navigation
                        if (targetUrl === currentUrl) isMatch = true;
                        else if (currentUrl.includes(targetUrl)) isMatch = true;
                        else if (targetUrl.length > 50 && currentUrl.includes(targetUrl.substring(0, 50))) isMatch = true;
                        else if (new URL(targetUrl).hostname === window.location.hostname) {
                            // Specific check for app-like URLs
                            if (targetUrl.includes("/c/") || targetUrl.includes("/app/")) {
                                if (currentUrl.replace(/\/$/, '') === targetUrl.replace(/\/$/, '')) isMatch = true;
                            } else isMatch = true;
                        }

                        if (isMatch) {
                            lastProcessedTimestamp = newState.timestamp;
                            processText(newState.selectedText, newState.autoSend, newState.insertMode || 'replace', newState.timestamp);
                        }
                    }
                }
            }
        });

        // 3. Runtime Message Listener
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!config) return;
            if (message.selectedText) {
                // Deduplication
                if (message.timestamp && message.timestamp <= lastProcessedTimestamp) {
                    sendResponse({ status: "success", info: "duplicate" });
                    return;
                }
                if (message.timestamp) lastProcessedTimestamp = message.timestamp;

                processText(message.selectedText, message.autoSend, 'replace', message.timestamp || Date.now());
                sendResponse({ status: "success" });
            }
        });

        // --- Session Tracking ---
        // Tracks current URL to allow "Resume Session" functionality
        const validHosts = [HOSTS.CHATGPT, HOSTS.GEMINI, HOSTS.PERPLEXITY, HOSTS.CLAUDE];
        const isSupportedHost = validHosts.some(h => hostname.includes(h));

        if (isSupportedHost) {
            let lastUrl = window.location.href;
            const saveSessionUrl = () => {
                const currentUrl = window.location.href;
                if (currentUrl !== lastUrl) {
                    lastUrl = currentUrl;
                    let serviceKey = "unknown";
                    if (hostname.includes("chatgpt")) serviceKey = HOSTS.CHATGPT;
                    else if (hostname.includes("gemini")) serviceKey = HOSTS.GEMINI;
                    else if (hostname.includes("perplexity")) serviceKey = HOSTS.PERPLEXITY_WWW;
                    else if (hostname.includes("claude")) serviceKey = HOSTS.CLAUDE;

                    if (serviceKey !== "unknown") {
                        const storageKey = `sessionUrl_${serviceKey}`;
                        const data = {};
                        data[storageKey] = currentUrl;
                        chrome.storage.local.set(data);
                    }
                }
            };

            // Aggressive polling/event listening for SPA URL changes
            setInterval(saveSessionUrl, 500);
            window.addEventListener('popstate', saveSessionUrl);
            window.addEventListener('hashchange', saveSessionUrl);
            document.addEventListener('click', () => setTimeout(saveSessionUrl, 100)); // Capture clicks
            document.addEventListener('keyup', (e) => {
                if (e.key === 'Enter') setTimeout(saveSessionUrl, 500);
            });
        }
    }

})();
