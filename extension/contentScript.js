(function () {
    'use strict';

    // Verify CONFIG is loaded
    if (typeof CONFIG === 'undefined') {
        console.error("Select to AI: CONFIG not loaded. Injection failed.");
        return;
    }

    const { HOSTS, ADAPTERS, DELAYS } = CONFIG;
    const hostname = window.location.hostname;
    let adapter = null;
    let lastProcessedTimestamp = 0;

    // --- Adapter Selection ---
    // Only the supported AI chat hosts get an adapter; on any other page
    // this script does nothing. Selector chains live in config.js.
    if (hostname.includes(HOSTS.CHATGPT)) {
        adapter = ADAPTERS.CHATGPT;
    } else if (hostname.includes(HOSTS.GEMINI)) {
        adapter = ADAPTERS.GEMINI;
    } else if (hostname.includes(HOSTS.PERPLEXITY)) {
        adapter = ADAPTERS.PERPLEXITY;
    } else if (hostname.includes(HOSTS.CLAUDE)) {
        adapter = ADAPTERS.CLAUDE;
    }

    if (adapter) {
        init();
    }

    /**
     * Returns the first element matching an ORDERED selector chain.
     * Order expresses preference: stable ids / data-testids first,
     * aria-labels next, structural fallbacks last.
     * @param {string[]} chain
     * @returns {Element|null}
     */
    function queryChain(chain) {
        for (const selector of chain || []) {
            let el = null;
            try {
                el = document.querySelector(selector);
            } catch (e) {
                continue; // skip selectors this browser cannot parse
            }
            if (el) return el;
        }
        return null;
    }

    /**
     * Waits until any selector in the chain matches (in preference order).
     * @param {string[]} chain
     * @param {number} timeout - Max time to wait (ms).
     * @returns {Promise<Element>}
     */
    function waitForChain(chain, timeout = DELAYS.MAX_WAIT) {
        return new Promise((resolve, reject) => {
            const existing = queryChain(chain);
            if (existing) return resolve(existing);

            const observer = new MutationObserver(() => {
                const el = queryChain(chain);
                if (el) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timeout waiting for selectors: ${(chain || []).join(' | ')}`));
            }, timeout);
        });
    }

    // --- User feedback helpers ---

    /** Shows a small transient toast on the page. */
    function showPageToast(message) {
        try {
            const existing = document.getElementById('select-to-ai-toast');
            if (existing) existing.remove();
            const toast = document.createElement('div');
            toast.id = 'select-to-ai-toast';
            toast.textContent = message;
            toast.style.cssText = [
                'position:fixed', 'bottom:24px', 'left:50%',
                'transform:translateX(-50%)', 'background:#26262c',
                'color:#ffffff', 'padding:10px 18px', 'border-radius:8px',
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
                'font-size:13px', 'font-weight:500', 'z-index:2147483647',
                'box-shadow:0 4px 16px rgba(0,0,0,0.25)', 'max-width:80vw',
                'pointer-events:none'
            ].join(';');
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 4000);
        } catch (e) {
            console.warn('Select to AI: toast failed:', e);
        }
    }

    /** Copies text to the clipboard (async API with execCommand fallback). */
    function copyToClipboard(text) {
        const fallback = () => {
            try {
                const scratch = document.createElement('textarea');
                scratch.value = text;
                scratch.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
                document.body.appendChild(scratch);
                scratch.focus();
                scratch.select();
                document.execCommand('copy');
                scratch.remove();
                return true;
            } catch (e) {
                return false;
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(() => true).catch(fallback);
        }
        return Promise.resolve(fallback());
    }

    // --- Composer state helpers (used for send verification) ---

    function readComposerText(element) {
        if (!element) return '';
        const tag = element.tagName ? element.tagName.toLowerCase() : '';
        if (tag === 'textarea' || tag === 'input') return element.value || '';
        return element.textContent || '';
    }

    function countSentProbes() {
        if (!adapter.sentProbe) return null;
        try {
            return document.querySelectorAll(adapter.sentProbe).length;
        } catch (e) {
            return null;
        }
    }

    /**
     * Verifies a send attempt actually worked before reporting success:
     * either the composer emptied, or a new user-message bubble appeared
     * (adapter.sentProbe count increased). Polls for up to `windowMs`.
     * @returns {Promise<boolean>}
     */
    function verifySendWorked(element, probeCountBefore, windowMs = 3000) {
        const startedAt = Date.now();
        return new Promise((resolve) => {
            const check = () => {
                const composerEmpty = readComposerText(element).trim().length === 0;
                const probeCountNow = countSentProbes();
                const bubbleAppeared =
                    probeCountBefore !== null &&
                    probeCountNow !== null &&
                    probeCountNow > probeCountBefore;
                if (composerEmpty || bubbleAppeared) {
                    resolve(true);
                    return;
                }
                if (Date.now() - startedAt >= windowMs) {
                    resolve(false);
                    return;
                }
                setTimeout(check, 200);
            };
            setTimeout(check, 300);
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

        console.log(`Select to AI: Processing text for ${hostname} (Mode: ${insertMode})`);

        waitForChain(adapter.input).then((element) => {
            window.focus();
            element.focus();

            const tagName = element.tagName.toLowerCase();
            const isEditable =
                element.getAttribute('contenteditable') === 'true' ||
                (tagName !== 'textarea' && tagName !== 'input');

            if (isEditable) {
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
                if (nativeInputValueSetter && tagName === 'textarea') {
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
            if (autoSend && adapter.send && adapter.send.length > 0) {
                // Determine service-specific delay from CONFIG
                let delay = DELAYS.POLLING_INTERVAL; // Default low
                if (hostname.includes(HOSTS.CHATGPT)) delay = DELAYS.CHATGPT;
                else if (hostname.includes(HOSTS.GEMINI)) delay = DELAYS.GEMINI;
                else if (hostname.includes(HOSTS.PERPLEXITY)) delay = DELAYS.PERPLEXITY;
                else if (hostname.includes(HOSTS.CLAUDE)) delay = DELAYS.CLAUDE;

                console.log(`Select to AI: Auto-sending in ${delay}ms...`);

                setTimeout(() => {
                    attemptSend(element);
                }, delay);
            }

        }).catch((error) => {
            // No composer selector matched within the wait window. Do NOT
            // guess at elements, put the text on the clipboard and say so.
            console.warn("Select to AI: composer not found:", error.message);
            copyToClipboard(text).then(() => {
                showPageToast("Pasted text is on your clipboard");
            });
        });

        /**
         * Clicks the send control (ordered chain, no generic fallbacks) and
         * verifies the send actually happened before treating it as done.
         */
        function attemptSend(element, isRetry = false) {
            const btn = queryChain(adapter.send);
            if (!btn) {
                // The text IS in the composer; only the send control was not
                // found. Never click a guessed button, tell the user.
                console.warn("Select to AI: Send button not found.");
                showPageToast("Couldn't find the send button, press Enter to send.");
                return;
            }

            const probeCountBefore = countSentProbes();
            btn.click();

            verifySendWorked(element, probeCountBefore).then((sent) => {
                if (sent) {
                    console.log("Select to AI: send verified (composer emptied or message bubble appeared).");
                    return;
                }
                if (!isRetry) {
                    console.warn("Select to AI: send not confirmed, retrying once...");
                    attemptSend(element, true);
                    return;
                }
                showPageToast("Send didn't complete, your text is in the message box, press Enter to send.");
            });
        }
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
                    if (adapter && state.selectedText) {
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
                if (newState && newState.selectedText && adapter) {
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
            if (!adapter) return;
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
