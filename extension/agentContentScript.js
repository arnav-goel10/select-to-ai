(function () {
    'use strict';

    if (window.selectToAiAgentInitialized) {
        return;
    }
    window.selectToAiAgentInitialized = true;

    console.log("Select to AI: Agent Content Script injected and running.");

    // =========================================================================
    // State
    // =========================================================================

    /** @type {Object<number, Element>} Map of assigned IDs to DOM elements */
    let elementMap = {};

    /** @type {HTMLDivElement|null} Container for overlay badges */
    let overlayContainer = null;

    /** @type {HTMLDivElement|null} Active highlight ring element */
    let highlightOverlay = null;

    /** @type {HTMLDivElement|null} Visual cursor used to show agent movement */
    let agentCursor = null;

    /** @type {HTMLDivElement|null} Small label beside the visual cursor */
    let agentCursorLabel = null;

    // =========================================================================
    // Constants
    // =========================================================================

    /** ARIA roles considered interactive */
    const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'checkbox', 'tab', 'menuitem',
        'menuitemcheckbox', 'menuitemradio', 'switch', 'slider',
        'spinbutton', 'combobox', 'listbox', 'option', 'treeitem',
        'gridcell', 'searchbox', 'radio', 'textbox'
    ]);

    /** Roles that indicate purely presentational elements */
    const PRESENTATION_ROLES = new Set(['presentation', 'none']);

    /** Native HTML tags that are inherently interactive */
    const INTERACTIVE_TAGS = new Set([
        'a', 'button', 'input', 'select', 'textarea', 'option'
    ]);

    /** Form element tags that should receive a `change` event after click */
    const FORM_TAGS = new Set(['input', 'select', 'textarea']);

    /**
     * Key metadata lookup — keyCode, code, and whether the key is printable.
     * @type {Object<string, {keyCode: number, code: string, printable: boolean}>}
     */
    const KEY_MAP = {
        Enter:      { keyCode: 13,  code: 'Enter',        printable: false },
        Tab:        { keyCode: 9,   code: 'Tab',          printable: false },
        Escape:     { keyCode: 27,  code: 'Escape',       printable: false },
        Backspace:  { keyCode: 8,   code: 'Backspace',    printable: false },
        Delete:     { keyCode: 46,  code: 'Delete',       printable: false },
        ' ':        { keyCode: 32,  code: 'Space',        printable: true  },
        Space:      { keyCode: 32,  code: 'Space',        printable: true  },
        ArrowUp:    { keyCode: 38,  code: 'ArrowUp',      printable: false },
        ArrowDown:  { keyCode: 40,  code: 'ArrowDown',    printable: false },
        ArrowLeft:  { keyCode: 37,  code: 'ArrowLeft',    printable: false },
        ArrowRight: { keyCode: 39,  code: 'ArrowRight',   printable: false },
        Home:       { keyCode: 36,  code: 'Home',         printable: false },
        End:        { keyCode: 35,  code: 'End',          printable: false },
        PageUp:     { keyCode: 33,  code: 'PageUp',       printable: false },
        PageDown:   { keyCode: 34,  code: 'PageDown',     printable: false },
    };

    // Populate letter keys a-z
    for (let i = 65; i <= 90; i++) {
        const lower = String.fromCharCode(i + 32);
        const upper = String.fromCharCode(i);
        KEY_MAP[lower] = { keyCode: i, code: `Key${upper}`, printable: true };
        KEY_MAP[upper] = { keyCode: i, code: `Key${upper}`, printable: true };
    }
    // Populate digit keys 0-9
    for (let i = 48; i <= 57; i++) {
        const ch = String.fromCharCode(i);
        KEY_MAP[ch] = { keyCode: i, code: `Digit${ch}`, printable: true };
    }

    // =========================================================================
    // Utility Helpers
    // =========================================================================

    /**
     * Small async delay helper.
     * @param {number} ms - Milliseconds to wait.
     * @returns {Promise<void>}
     */
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Waits for a CSS selector to appear in the DOM.
     * Uses MutationObserver with a 5-second timeout.
     * @param {string} selector - CSS selector to wait for.
     * @param {number} [timeout=5000] - Max wait time in ms.
     * @returns {Promise<Element>}
     */
    function waitForElement(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`waitForElement: "${selector}" not found within ${timeout}ms`));
            }, timeout);
        });
    }

    /**
     * Waits until the DOM is "stable" — no mutations for `quietPeriod` ms.
     * @param {number} [quietPeriod=500] - How long (ms) with no mutations to consider stable.
     * @param {number} [timeout=3000] - Hard timeout in ms.
     * @returns {Promise<void>}
     */
    function waitForDomStable(quietPeriod = 500, timeout = 3000) {
        return new Promise((resolve) => {
            let debounce = null;
            const observer = new MutationObserver(() => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    observer.disconnect();
                    resolve();
                }, quietPeriod);
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            // Start the quiet-period timer immediately (in case nothing mutates)
            debounce = setTimeout(() => {
                observer.disconnect();
                resolve();
            }, quietPeriod);

            // Hard timeout fallback
            setTimeout(() => {
                observer.disconnect();
                clearTimeout(debounce);
                resolve();
            }, timeout);
        });
    }

    /**
     * Checks that an element is still attached to the DOM.
     * @param {Element} el
     * @returns {{ok: boolean, error?: object}}
     */
    function requireConnected(el) {
        if (!el || !el.isConnected) {
            return {
                ok: false,
                error: {
                    success: false,
                    error: 'Element is no longer attached to the DOM. Please re-scan the page.'
                }
            };
        }
        return { ok: true };
    }

    /**
     * Gets the native value setter for an input or textarea element.
     * Bypasses React / framework-controlled value wrappers.
     * @param {HTMLElement} el
     * @returns {Function|null}
     */
    function getNativeValueSetter(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea') {
            return Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            )?.set || null;
        }
        if (tag === 'input') {
            return Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            )?.set || null;
        }
        return null;
    }

    /**
     * Resolves key metadata from the KEY_MAP, falling back to sensible defaults
     * for characters not explicitly listed (punctuation, etc.).
     * @param {string} key
     * @returns {{keyCode: number, code: string, printable: boolean}}
     */
    function resolveKeyMeta(key) {
        if (KEY_MAP[key]) return KEY_MAP[key];
        // Fallback for any other single character
        if (key.length === 1) {
            return { keyCode: key.charCodeAt(0), code: `Key${key.toUpperCase()}`, printable: true };
        }
        return { keyCode: 0, code: key, printable: false };
    }

    // =========================================================================
    // Styles & Containers
    // =========================================================================

    /** Injects CSS styles for overlay badges and highlight rings. */
    function injectStyles() {
        const styleId = "select-to-ai-agent-styles";
        if (document.getElementById(styleId)) return;

        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            #select-to-ai-overlay-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 2147483647;
            }

            .select-to-ai-badge {
                position: absolute;
                pointer-events: auto;
                background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                font-weight: 700;
                padding: 3px 7px;
                border-radius: 12px;
                border: 2px solid #ffffff;
                box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4), 0 0 0 1px rgba(0,0,0,0.1);
                transform: translate(-50%, -50%) scale(0.9);
                opacity: 0;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
                animation: selectToAiBadgeEntrance 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
            }

            .select-to-ai-badge:hover {
                transform: translate(-50%, -50%) scale(1.15);
                background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                cursor: help;
            }

            .select-to-ai-badge.active-target {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                box-shadow: 0 0 15px rgba(16, 185, 129, 0.8);
                transform: translate(-50%, -50%) scale(1.2);
                animation: selectToAiPulseTarget 1s infinite alternate;
            }

            .select-to-ai-target-ring {
                position: absolute;
                pointer-events: none;
                border: 3px solid #10b981;
                border-radius: 8px;
                box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
                z-index: 2147483646;
                box-sizing: border-box;
                transform: scale(1.2);
                opacity: 0;
                transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .select-to-ai-agent-cursor {
                position: fixed;
                left: 0;
                top: 0;
                width: 22px;
                height: 22px;
                pointer-events: none;
                z-index: 2147483647;
                opacity: 0;
                transform: translate3d(20px, 20px, 0);
                transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
            }

            .select-to-ai-agent-cursor::before {
                content: '';
                position: absolute;
                left: 0;
                top: 0;
                width: 0;
                height: 0;
                border-left: 14px solid #ffffff;
                border-top: 10px solid transparent;
                border-bottom: 10px solid transparent;
                filter: drop-shadow(0 3px 7px rgba(0, 0, 0, 0.45));
                transform: rotate(-35deg);
            }

            .select-to-ai-agent-cursor::after {
                content: '';
                position: absolute;
                left: 7px;
                top: 7px;
                width: 8px;
                height: 8px;
                border-radius: 999px;
                background: #8b5cf6;
                box-shadow: 0 0 0 6px rgba(139, 92, 246, 0.22);
            }

            .select-to-ai-agent-cursor.clicking::after {
                animation: selectToAiCursorClick 0.35s ease-out;
            }

            .select-to-ai-agent-label {
                position: fixed;
                left: 0;
                top: 0;
                pointer-events: none;
                z-index: 2147483647;
                opacity: 0;
                transform: translate3d(44px, 24px, 0);
                transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
                background: rgba(17, 24, 39, 0.92);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 999px;
                padding: 5px 9px;
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                font-weight: 650;
                box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
                white-space: nowrap;
            }

            @keyframes selectToAiBadgeEntrance {
                to {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }
            }

            @keyframes selectToAiPulseTarget {
                0% { box-shadow: 0 0 0 0px rgba(16, 185, 129, 0.7); }
                100% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
            }

            @keyframes selectToAiCursorClick {
                0% { transform: scale(1); box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.3); }
                50% { transform: scale(0.72); box-shadow: 0 0 0 12px rgba(139, 92, 246, 0.2); }
                100% { transform: scale(1); box-shadow: 0 0 0 18px rgba(139, 92, 246, 0); }
            }
        `;
        document.head.appendChild(style);
    }

    /** Creates (or recreates) the overlay container element. */
    function ensureContainers() {
        injectStyles();

        const old = document.getElementById("select-to-ai-overlay-container");
        if (old) old.remove();

        overlayContainer = document.createElement("div");
        overlayContainer.id = "select-to-ai-overlay-container";

        const bodyHeight = Math.max(
            document.body.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.clientHeight
        );
        overlayContainer.style.height = bodyHeight + "px";

        document.body.appendChild(overlayContainer);
        ensureAgentCursor();
    }

    function ensureAgentCursor() {
        if (!agentCursor || !document.body.contains(agentCursor)) {
            agentCursor = document.createElement("div");
            agentCursor.className = "select-to-ai-agent-cursor";
            document.body.appendChild(agentCursor);
        }
        if (!agentCursorLabel || !document.body.contains(agentCursorLabel)) {
            agentCursorLabel = document.createElement("div");
            agentCursorLabel.className = "select-to-ai-agent-label";
            document.body.appendChild(agentCursorLabel);
        }
    }

    async function moveAgentCursorTo(clientX, clientY, label = "Working") {
        ensureAgentCursor();
        const x = Math.max(8, Math.min(window.innerWidth - 24, clientX));
        const y = Math.max(8, Math.min(window.innerHeight - 24, clientY));
        agentCursor.style.opacity = "1";
        agentCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        agentCursorLabel.textContent = label;
        agentCursorLabel.style.opacity = "1";
        agentCursorLabel.style.transform = `translate3d(${Math.min(window.innerWidth - 180, x + 28)}px, ${Math.min(window.innerHeight - 36, y + 18)}px, 0)`;
        await delay(260);
    }

    async function moveAgentCursorToElement(el, label = "Working") {
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
            el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
            await delay(450);
        }
        const updated = el.getBoundingClientRect();
        await moveAgentCursorTo(updated.left + updated.width / 2, updated.top + updated.height / 2, label);
    }

    async function pulseAgentCursor(label = "Click") {
        ensureAgentCursor();
        agentCursorLabel.textContent = label;
        agentCursor.classList.remove("clicking");
        void agentCursor.offsetWidth;
        agentCursor.classList.add("clicking");
        await delay(180);
    }

    async function showScrollCue(direction = "down", targetEl = null) {
        let clientX = window.innerWidth / 2;
        let clientY = window.innerHeight / 2;
        if (targetEl) {
            const rect = targetEl.getBoundingClientRect();
            clientX = rect.left + rect.width / 2;
            clientY = rect.top + rect.height / 2;
        }
        await moveAgentCursorTo(clientX, clientY, `Scroll ${direction || ""}`.trim());
    }

    // =========================================================================
    // Visibility & Interactivity Checks
    // =========================================================================

    function extractMarkdown(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            return text ? text + ' ' : '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tagName = node.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'svg', 'canvas', 'iframe'].includes(tagName)) return '';

        try {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return '';
        } catch(e) {}

        let md = '';
        const isBlock = ['div', 'p', 'section', 'article', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr'].includes(tagName);
        
        if (tagName === 'h1') md += '\n# ';
        else if (tagName === 'h2') md += '\n## ';
        else if (tagName === 'h3') md += '\n### ';
        else if (tagName === 'li') md += '\n- ';

        for (let child of Array.from(node.childNodes)) {
            md += extractMarkdown(child);
        }

        md = md.trim();

        if (tagName === 'a' && md) md = `[${md}](${node.href}) `;
        else if (tagName === 'img') md = `![${node.alt || 'image'}] `;
        else if (tagName === 'button') md = `[Button: ${md}] `;
        
        if (isBlock) md += '\n';
        return md + (isBlock ? '' : ' ');
    }

    /**
     * Determines if an element is visible in/near the viewport.
     * Filters out aria-hidden="true" elements.
     * @param {Element} el
     * @returns {boolean}
     */
    function isElementVisible(el) {
        try {
            // Filter aria-hidden elements
            if (el.getAttribute('aria-hidden') === 'true') return false;

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;

            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1 || style.pointerEvents === 'none') {
                return false;
            }

            // Parent clipping check
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden' || parseFloat(parentStyle.opacity) < 0.1 || parentStyle.pointerEvents === 'none') {
                    return false;
                }
                if (parentStyle.overflow === 'hidden' || parentStyle.overflowY === 'hidden' || parentStyle.overflowX === 'hidden') {
                    const pRect = parent.getBoundingClientRect();
                    if (pRect.width === 0 || pRect.height === 0) return false;
                }
                parent = parent.parentElement;
            }

            const buffer = 100;
            const inViewport = (
                rect.top >= -buffer &&
                rect.left >= -buffer &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) + buffer &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth) + buffer
            );
            return inViewport;
        } catch (e) {
            return false;
        }
    }

    /**
     * Determines if an element should be treated as interactive.
     * @param {Element} el
     * @returns {boolean}
     */
    function isElementInteractive(el) {
        const tagName = el.tagName.toLowerCase();
        const role = el.getAttribute('role');

        // Exclude presentation / none roles
        if (role && PRESENTATION_ROLES.has(role)) return false;

        // Content-editable elements
        if (el.isContentEditable) return true;

        // Native interactive controls
        if (INTERACTIVE_TAGS.has(tagName)) {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            if (tagName === 'input' && el.type === 'hidden') return false;
            return true;
        }

        // ARIA interactive roles
        if (role && INTERACTIVE_ROLES.has(role)) return true;

        // Elements with tabindex (not -1) are keyboard-focusable by author intent
        if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;

        // Clickable via cursor style (only capture the "leaf" pointer node)
        try {
            const style = window.getComputedStyle(el);
            if (
                style.cursor === 'pointer' &&
                el.parentElement &&
                window.getComputedStyle(el.parentElement).cursor !== 'pointer'
            ) {
                return true;
            }
        } catch (_) { /* computed style can throw on detached nodes */ }

        // Inline onclick handler
        if (el.onclick || typeof el.onclick === 'function') return true;

        return false;
    }

    // =========================================================================
    // DOM Traversal (including Shadow DOM)
    // =========================================================================

    /**
     * Recursively collects candidate interactive elements from light and shadow DOM.
     * @param {Document|ShadowRoot} root
     * @param {Element[]} [list=[]]
     * @returns {Element[]}
     */
    function collectElementsRecursively(root, list = []) {
        if (!root) return list;

        try {
            const all = root.querySelectorAll("*");
            all.forEach((el) => {
                const tagName = el.tagName.toLowerCase();
                const role = el.getAttribute('role');
                const hasTabindex = el.hasAttribute('tabindex');

                // Quick pre-filter before the more expensive getComputedStyle check
                if (
                    INTERACTIVE_TAGS.has(tagName) ||
                    (role && INTERACTIVE_ROLES.has(role)) ||
                    hasTabindex ||
                    el.isContentEditable
                ) {
                    list.push(el);
                } else {
                    try {
                        const style = window.getComputedStyle(el);
                        if (style && style.cursor === 'pointer') {
                            list.push(el);
                        }
                    } catch (_) { /* skip */ }
                }

                // Traverse shadow root if present
                if (el.shadowRoot) {
                    collectElementsRecursively(el.shadowRoot, list);
                }
            });
        } catch (e) {
            console.error("Select to AI: Shadow DOM traversal error:", e);
        }

        return list;
    }

    // =========================================================================
    // Scanning & Overlay
    // =========================================================================

    /**
     * Scans the page for visible interactive elements, assigns IDs, renders badges,
     * and returns a structured list for the LLM.
     * @returns {Array<Object>} List of element descriptors.
     */
    function scanInteractiveElements() {
        ensureContainers();
        elementMap = {};
        const resultList = [];

        const candidates = collectElementsRecursively(document);

        // Phase 1: Semantic Scoring
        let scoredCandidates = [];
        candidates.forEach((el) => {
            if (!isElementVisible(el)) return;
            if (!isElementInteractive(el)) return;
            
            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || el.value || "").trim();
            const type = (el.type || "").toLowerCase();
            const role = el.getAttribute('role') || "";
            let score = 0;
            
            if (tag === 'input' && (type === 'text' || type === 'search' || type === 'email' || type === 'password')) {
                score += 100;
            } else if (tag === 'textarea' || el.isContentEditable) {
                score += 100;
            } else if (tag === 'button' || role === 'button' || type === 'submit') {
                score += 50;
            } else if (tag === 'a') {
                if (text.length > 10) score += 20;
                else if (text.length === 0) score -= 50;
            }
            
            // Minor penalty for being far down the page
            const rect = el.getBoundingClientRect();
            if (rect.top > window.innerHeight) score -= 10;
            if (rect.top > window.innerHeight * 2) score -= 20;

            scoredCandidates.push({ el, score });
        });

        // Phase 2: Sorting and Trimming
        scoredCandidates.sort((a, b) => b.score - a.score);
        const topCandidates = scoredCandidates.slice(0, 80);

        // Phase 3: ID Assignment & Badging
        const fragment = document.createDocumentFragment();
        let idCounter = 1;
        
        topCandidates.forEach((candidate) => {
            const el = candidate.el;
            const id = idCounter++;
            elementMap[id] = el;
            el.setAttribute("data-select-to-ai-id", String(id));

            const rect = el.getBoundingClientRect();
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const absoluteX = rect.left + scrollLeft;
            const absoluteY = rect.top + scrollTop;

            const badge = document.createElement("div");
            badge.className = "select-to-ai-badge";
            badge.id = `select-to-ai-badge-${id}`;
            badge.textContent = String(id);
            badge.style.left = absoluteX + "px";
            badge.style.top = absoluteY + "px";

            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || el.value || "").trim().substring(0, 30);
            badge.title = `${tag.toUpperCase()}: "${text}"`;

            fragment.appendChild(badge);

            let type = tag;
            if (tag === 'input') type = (el.type || 'text') + '-input';

            const entry = {
                id,
                tagName: tag,
                type,
                text,
                placeholder: el.placeholder || "",
                name: el.name || "",
                title: el.title || "",
                label: el.getAttribute('aria-label') || "",
                role: el.getAttribute('role') || "",
                value: el.value || "",
                isContentEditable: el.isContentEditable || false,
            };

            if (tag === 'a' && el.href) entry.href = el.href;
            if (typeof el.checked === 'boolean') entry.checked = el.checked;
            if (el.disabled) entry.disabled = true;
            if (el.required || el.getAttribute('aria-required') === 'true') entry.required = true;

            const ariaExpanded = el.getAttribute('aria-expanded');
            if (ariaExpanded !== null) entry.ariaExpanded = ariaExpanded;

            const ariaSelected = el.getAttribute('aria-selected');
            if (ariaSelected !== null) entry.ariaSelected = ariaSelected;

            const ariaChecked = el.getAttribute('aria-checked');
            if (ariaChecked !== null) entry.ariaChecked = ariaChecked;

            const ariaHaspopup = el.getAttribute('aria-haspopup');
            if (ariaHaspopup !== null) entry.ariaHaspopup = ariaHaspopup;

            resultList.push(entry);
        });

        if (overlayContainer) {
            overlayContainer.appendChild(fragment);
        }

        console.log(`Select to AI: Found ${resultList.length} top-scored interactive elements.`);
        return resultList;
    }

    // =========================================================================
    // Highlight
    // =========================================================================

    /**
     * Highlights the target element with a badge glow and a pulsing ring.
     * @param {number} id - Element ID from elementMap.
     */
    function highlightTarget(id) {
        const el = elementMap[id];
        if (!el) return;

        // Remove previous ring
        const prevRing = document.getElementById("select-to-ai-active-ring");
        if (prevRing) prevRing.remove();

        document.querySelectorAll(".select-to-ai-badge.active-target").forEach((b) => {
            b.classList.remove("active-target");
        });

        // Activate badge
        const badge = document.getElementById(`select-to-ai-badge-${id}`);
        if (badge) {
            badge.classList.add("active-target");
            badge.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Draw pulsing highlight ring
        const rect = el.getBoundingClientRect();
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

        highlightOverlay = document.createElement("div");
        highlightOverlay.id = "select-to-ai-active-ring";
        highlightOverlay.className = "select-to-ai-target-ring";

        const pad = 4;
        highlightOverlay.style.left = (rect.left + scrollLeft - pad) + "px";
        highlightOverlay.style.top = (rect.top + scrollTop - pad) + "px";
        highlightOverlay.style.width = (rect.width + pad * 2) + "px";
        highlightOverlay.style.height = (rect.height + pad * 2) + "px";

        if (overlayContainer) {
            overlayContainer.appendChild(highlightOverlay);
            setTimeout(() => {
                if (highlightOverlay) {
                    highlightOverlay.style.transform = "scale(1)";
                    highlightOverlay.style.opacity = "1";
                }
            }, 50);
        }
    }

    // =========================================================================
    // Event Simulation Helpers
    // =========================================================================

    /**
     * Computes common pointer/mouse event init properties for an element.
     * @param {Element} el
     * @param {Object} [modifiers={}]
     * @returns {Object}
     */
    function pointerEventDefaults(el, modifiers = {}) {
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        return {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX,
            clientY,
            screenX: window.screenX + clientX,
            screenY: window.screenY + clientY,
            button: 0,
            buttons: 1,
            ctrlKey: !!modifiers.ctrlKey,
            shiftKey: !!modifiers.shiftKey,
            altKey: !!modifiers.altKey,
            metaKey: !!modifiers.metaKey,
        };
    }

    /**
     * Dispatches a full click event sequence (pointer + mouse events) on an element.
     * Only dispatches `change` for form elements.
     * @param {Element} targetEl
     * @param {Object} [modifiers={}]
     */
    function dispatchClickEvents(targetEl, modifiers = {}) {
        const opts = pointerEventDefaults(targetEl, modifiers);

        // Pointer sequence
        targetEl.dispatchEvent(new PointerEvent('pointerover', opts));
        targetEl.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
        targetEl.dispatchEvent(new PointerEvent('pointermove', opts));
        targetEl.dispatchEvent(new PointerEvent('pointerdown', opts));

        // Mouse sequence
        targetEl.dispatchEvent(new MouseEvent('mouseover', opts));
        targetEl.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
        targetEl.dispatchEvent(new MouseEvent('mousedown', opts));

        targetEl.focus();

        targetEl.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
        targetEl.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        targetEl.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));

        // Only dispatch change on form elements
        const tag = targetEl.tagName.toLowerCase();
        if (FORM_TAGS.has(tag)) {
            targetEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    /**
     * Dispatches hover-only events (no click) on an element.
     * @param {Element} targetEl
     * @param {Object} [modifiers={}]
     */
    function dispatchHoverEvents(targetEl, modifiers = {}) {
        const opts = pointerEventDefaults(targetEl, modifiers);
        targetEl.dispatchEvent(new PointerEvent('pointerover', opts));
        targetEl.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
        targetEl.dispatchEvent(new MouseEvent('mouseover', opts));
        targetEl.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
        targetEl.dispatchEvent(new PointerEvent('pointermove', opts));
        targetEl.dispatchEvent(new MouseEvent('mousemove', opts));
    }

    // =========================================================================
    // Typing (per-character, framework-compatible)
    // =========================================================================

    /**
     * Simulates natural typing character-by-character.
     * For `contenteditable` elements uses `execCommand('insertText')`.
     * Dispatches composition events for IME compatibility.
     *
     * @param {HTMLElement} el - Target element.
     * @param {string} text - Text to type.
     * @returns {Promise<void>}
     */
    async function simulateTyping(el, text) {
        el.focus();

        const isContentEditable = el.isContentEditable;
        const nativeSetter = isContentEditable ? null : getNativeValueSetter(el);

        const eventBase = { bubbles: true, cancelable: true, view: window };

        // Fire compositionstart
        el.dispatchEvent(new CompositionEvent('compositionstart', { ...eventBase, data: '' }));

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const meta = resolveKeyMeta(char);

            const keyOpts = {
                ...eventBase,
                key: char,
                code: meta.code,
                keyCode: meta.keyCode,
                which: meta.keyCode,
                charCode: 0,
            };

            // keydown
            el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));

            // beforeinput
            el.dispatchEvent(new InputEvent('beforeinput', {
                ...eventBase,
                inputType: 'insertText',
                data: char,
            }));

            // compositionupdate
            el.dispatchEvent(new CompositionEvent('compositionupdate', {
                ...eventBase,
                data: text.substring(0, i + 1),
            }));

            // Set the value
            if (isContentEditable) {
                document.execCommand('insertText', false, char);
            } else if (nativeSetter) {
                nativeSetter.call(el, (el.value || '') + char);
            } else {
                el.value = (el.value || '') + char;
            }

            // input event
            el.dispatchEvent(new InputEvent('input', {
                ...eventBase,
                inputType: 'insertText',
                data: char,
            }));

            // keyup
            el.dispatchEvent(new KeyboardEvent('keyup', { ...keyOpts, charCode: 0 }));

            // Small delay between characters to mimic human typing
            await delay(12);
        }

        // Fire compositionend
        el.dispatchEvent(new CompositionEvent('compositionend', { ...eventBase, data: text }));

        // Final change event
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // =========================================================================
    // Action: performAction (async)
    // =========================================================================

    /**
     * Executes the requested browser interaction.
     *
     * @param {Object} data
     * @param {string} data.action - Action type.
     * @param {number} [data.id] - Element ID.
     * @param {string} [data.text] - Text for typing / key name.
     * @param {string} [data.key] - Key name for keypress.
     * @param {string} [data.scrollDirection] - up | down | left | right.
     * @param {number} [data.scrollTarget] - Element ID to scroll instead of window.
     * @param {string} [data.url] - URL for navigate action.
     * @param {number} [data.duration] - Duration in ms for wait action.
     * @param {string} [data.optionText] - Option text for select_option.
     * @param {number} [data.optionIndex] - Option index for select_option.
     * @param {Object} [data.modifiers] - {ctrlKey, shiftKey, altKey, metaKey}.
     * @returns {Promise<Object>} Result with success/error.
     */
    async function performAction(data) {
        try {
            const { action, id, text, scrollDirection, modifiers = {} } = data;

            // =================================================================
            // Actions that don't require an element
            // =================================================================

            if (action === 'scroll') {
                const amount = window.innerHeight * 0.6;
                let scrollTarget = null;

                // Element-level scrolling
                if (data.scrollTarget) {
                    scrollTarget = elementMap[data.scrollTarget];
                    if (!scrollTarget) {
                        return { success: false, error: `Scroll target element [${data.scrollTarget}] not found.` };
                    }
                    const conn = requireConnected(scrollTarget);
                    if (!conn.ok) return conn.error;
                }

                await showScrollCue(scrollDirection, scrollTarget);

                const scrollOpts = { behavior: 'smooth' };

                if (scrollDirection === 'down')  scrollOpts.top = amount;
                if (scrollDirection === 'up')    scrollOpts.top = -amount;
                if (scrollDirection === 'left')  scrollOpts.left = -amount;
                if (scrollDirection === 'right') scrollOpts.left = amount;

                if (scrollTarget) {
                    scrollTarget.scrollBy(scrollOpts);
                } else {
                    window.scrollBy(scrollOpts);
                }

                // Brief wait for dynamic content that may load after scroll
                await delay(300);

                return { success: true, message: `Scrolled ${scrollDirection}${data.scrollTarget ? ` on element [${data.scrollTarget}]` : ''}` };
            }

            if (action === 'navigate') {
                if (!data.url) return { success: false, error: 'Missing url for navigate action.' };
                await moveAgentCursorTo(window.innerWidth / 2, 80, "Navigate");
                window.location.href = data.url;
                return { success: true, message: `Navigating to ${data.url}` };
            }

            if (action === 'wait') {
                const duration = Math.min(data.duration || 2000, 10000);
                await delay(duration);
                return { success: true, message: `Waited ${duration}ms.` };
            }

            if (action === 'back') {
                await moveAgentCursorTo(28, 18, "Back");
                window.history.back();
                return { success: true, message: 'Navigated back.' };
            }

            if (action === 'forward') {
                await moveAgentCursorTo(68, 18, "Forward");
                window.history.forward();
                return { success: true, message: 'Navigated forward.' };
            }

            if (action === 'screenshot') {
                return { success: false, error: 'screenshot handled by background' };
            }

            // =================================================================
            // Actions that require an element
            // =================================================================

            const el = elementMap[id];
            if (!el) {
                return { success: false, error: `Element with ID ${id} not found. Re-scanning recommended.` };
            }

            const conn = requireConnected(el);
            if (!conn.ok) return conn.error;

            // Highlight before acting
            highlightTarget(id);

            // ----- click -----
            if (action === 'click') {
                await moveAgentCursorToElement(el, "Click");
                await pulseAgentCursor("Click");
                dispatchClickEvents(el, modifiers);
                await delay(300); // wait for potential DOM updates
                return { success: true, message: `Clicked element [${id}] successfully.` };
            }

            // ----- double_click -----
            if (action === 'double_click') {
                const opts = pointerEventDefaults(el, modifiers);
                await moveAgentCursorToElement(el, "Double click");
                await pulseAgentCursor("Double click");
                // First click sequence
                dispatchClickEvents(el, modifiers);
                // Second click sequence (detail=2)
                dispatchClickEvents(el, modifiers);
                // dblclick event
                el.dispatchEvent(new MouseEvent('dblclick', { ...opts, buttons: 0, detail: 2 }));
                await delay(300);
                return { success: true, message: `Double-clicked element [${id}] successfully.` };
            }

            // ----- right_click -----
            if (action === 'right_click') {
                const opts = pointerEventDefaults(el, modifiers);
                await moveAgentCursorToElement(el, "Right click");
                await pulseAgentCursor("Right click");
                opts.button = 2;
                opts.buttons = 2;
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
                el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
                el.dispatchEvent(new MouseEvent('contextmenu', {
                    ...opts,
                    button: 2,
                    buttons: 0,
                }));
                await delay(300);
                return { success: true, message: `Right-clicked element [${id}] successfully.` };
            }

            // ----- hover -----
            if (action === 'hover') {
                await moveAgentCursorToElement(el, "Hover");
                dispatchHoverEvents(el, modifiers);
                await delay(300);
                return { success: true, message: `Hovered over element [${id}] successfully.` };
            }

            // ----- type -----
            if (action === 'type') {
                await moveAgentCursorToElement(el, "Type");
                await simulateTyping(el, text || '');
                return { success: true, message: `Typed "${text}" into element [${id}] successfully.` };
            }

            // ----- clear -----
            if (action === 'clear') {
                await moveAgentCursorToElement(el, "Clear");
                const nativeSetter = getNativeValueSetter(el);
                if (nativeSetter) {
                    nativeSetter.call(el, '');
                } else if (el.isContentEditable) {
                    el.textContent = '';
                } else {
                    el.value = '';
                }
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, message: `Cleared element [${id}] successfully.` };
            }

            // ----- select_option -----
            if (action === 'select_option') {
                await moveAgentCursorToElement(el, "Select");
                if (el.tagName.toLowerCase() !== 'select') {
                    return { success: false, error: `Element [${id}] is not a <select> element.` };
                }
                if (data.optionIndex !== undefined && data.optionIndex !== null) {
                    el.selectedIndex = data.optionIndex;
                } else if (data.optionText) {
                    const options = Array.from(el.options);
                    const match = options.find(
                        (o) => o.text.trim().toLowerCase() === data.optionText.trim().toLowerCase()
                    );
                    if (!match) {
                        return { success: false, error: `Option "${data.optionText}" not found in <select> element [${id}].` };
                    }
                    match.selected = true;
                } else {
                    return { success: false, error: 'select_option requires optionText or optionIndex.' };
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, message: `Selected option on element [${id}] successfully.` };
            }

            // ----- checkbox_toggle -----
            if (action === 'checkbox_toggle') {
                await moveAgentCursorToElement(el, "Toggle");
                await pulseAgentCursor("Toggle");
                el.checked = !el.checked;
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, message: `Toggled checkbox [${id}] to ${el.checked}.` };
            }

            // ----- keypress -----
            if (action === 'keypress') {
                const targetEl = id ? el : document.activeElement;
                if (!targetEl) {
                    return { success: false, error: "No focused or targeted element found to press key." };
                }

                const connKey = requireConnected(targetEl);
                if (!connKey.ok) return connKey.error;

                targetEl.focus();
                await moveAgentCursorToElement(targetEl, `Press ${text || data.key || "Enter"}`);

                const key = text || data.key || "Enter";
                const meta = resolveKeyMeta(key);

                const keyOpts = {
                    key,
                    code: meta.code,
                    keyCode: meta.keyCode,
                    which: meta.keyCode,
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    ctrlKey: !!modifiers.ctrlKey,
                    shiftKey: !!modifiers.shiftKey,
                    altKey: !!modifiers.altKey,
                    metaKey: !!modifiers.metaKey,
                };

                targetEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));

                // Only dispatch keypress for printable keys (per spec)
                if (meta.printable) {
                    targetEl.dispatchEvent(new KeyboardEvent('keypress', {
                        ...keyOpts,
                        charCode: key.charCodeAt(0),
                    }));
                }

                // Special handling for Enter
                if (key === 'Enter') {
                    if (targetEl.tagName.toLowerCase() === 'input' && targetEl.form) {
                        targetEl.form.requestSubmit ? targetEl.form.requestSubmit() : targetEl.form.submit();
                    } else {
                        targetEl.click();
                    }
                }

                targetEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

                return { success: true, message: `Pressed key "${key}" on element [${id || 'active'}] successfully.` };
            }

            return { success: false, error: `Unknown action: ${action}` };

        } catch (err) {
            console.error("Select to AI: performAction error:", err);
            return { success: false, error: err.message || String(err) };
        }
    }

    // =========================================================================
    // Clear Overlay
    // =========================================================================

    /**
     * Removes all overlay elements and cleans up data attributes from tagged elements.
     */
    function clearOverlay() {
        // Remove data attributes from all tagged elements
        try {
            document.querySelectorAll('[data-select-to-ai-id]').forEach((el) => {
                el.removeAttribute('data-select-to-ai-id');
            });
        } catch (_) { /* ignore errors from detached elements */ }

        const container = document.getElementById("select-to-ai-overlay-container");
        if (container) container.remove();
        if (agentCursor) agentCursor.remove();
        if (agentCursorLabel) agentCursorLabel.remove();

        const styles = document.getElementById("select-to-ai-agent-styles");
        if (styles) styles.remove();

        elementMap = {};
        overlayContainer = null;
        highlightOverlay = null;
        agentCursor = null;
        agentCursorLabel = null;
    }

    // =========================================================================
    // Message Listener
    // =========================================================================

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'scan') {
            try {
                const list = scanInteractiveElements();
                const compressedText = extractMarkdown(document.body).replace(/\n\s*\n/g, '\n\n').trim().substring(0, 10000);
                sendResponse({ 
                    elements: list, 
                    url: window.location.href, 
                    title: document.title,
                    innerText: compressedText
                });
            } catch (err) {
                console.error("Select to AI: scan error:", err);
                const fallbackText = document.body ? document.body.innerText.substring(0, 10000) : "";
                sendResponse({ 
                    elements: [], 
                    url: window.location.href, 
                    title: document.title, 
                    error: err.message,
                    innerText: fallbackText
                });
            }
        } else if (request.action === 'interact') {
            // Async — must return true to keep the message channel open
            (async () => {
                try {
                    const result = await performAction(request.data);
                    sendResponse(result);
                } catch (err) {
                    console.error("Select to AI: interact error:", err);
                    sendResponse({ success: false, error: err.message || String(err) });
                }
            })();
            return true; // keep channel open for async sendResponse
        } else if (request.action === 'clear') {
            clearOverlay();
            sendResponse({ success: true });
        } else if (request.action === 'waitForElement') {
            // Utility: wait for a selector to appear
            (async () => {
                try {
                    const el = await waitForElement(request.selector, request.timeout || 5000);
                    sendResponse({ success: true, found: true, tagName: el.tagName.toLowerCase() });
                } catch (err) {
                    sendResponse({ success: false, found: false, error: err.message });
                }
            })();
            return true;
        } else if (request.action === 'waitForDomStable') {
            (async () => {
                try {
                    await waitForDomStable(request.quietPeriod || 500, request.timeout || 3000);
                    sendResponse({ success: true, stable: true });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
            })();
            return true;
        }
    });

})();
