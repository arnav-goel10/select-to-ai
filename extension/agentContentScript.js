(function () {
    'use strict';

    if (window.selectToAiAgentInitialized) {
        return;
    }
    window.selectToAiAgentInitialized = true;


    // =========================================================================
    // State
    // =========================================================================

    /** @type {Object<number, Element>} Map of assigned IDs to DOM elements */
    let elementMap = {};

    /**
     * Private WeakMap from DOM element to assigned numeric ID. Kept in the
     * content script's isolated world rather than stamped as a DOM attribute
     * so page scripts cannot detect the extension or tamper with element IDs.
     * @type {WeakMap<Element, number>}
     */
    let elementIds = new WeakMap();
    const idOf = (el) => (el && typeof el === "object" ? elementIds.get(el) || null : null);
    window.__selectToAiIdOf = idOf;
    window.__selectToAiListedElements = () => Object.values(elementMap).filter((el) => el && el.isConnected);

    /**
     * Monotonic id counter for stable element ids. Element ids are reused
     * across re-scans while the page lives (the content script's lifetime),
     * and reset automatically on navigation because the script reloads.
     */
    let nextElementId = 1;

    /**
     * The id of an element a recipe replay found by its own means
     * (recipes/driver.js), so it is acted on by the same code as the
     * agent's actions. An element the scan listed keeps its id; any other
     * is given the next new one, as a scan would.
     */
    window.__selectToAiAdopt = (el) => {
        if (!el || typeof el !== "object" || !el.isConnected) return null;
        const had = elementIds.get(el);
        if (had && elementMap[had] === el) return had;
        const id = nextElementId++;
        elementMap[id] = el;
        elementIds.set(el, id);
        return id;
    };

    /** @type {HTMLDivElement|null} Container for overlay badges */
    let overlayContainer = null;

    /** @type {HTMLDivElement|null} Active highlight ring element */
    let highlightOverlay = null;

    /** @type {HTMLDivElement|null} Visual cursor used to show agent movement */
    let agentCursor = null;

    /** @type {HTMLDivElement|null} Small label beside the visual cursor */
    let agentCursorLabel = null;

    /**
     * Set when the agent panel sends 'clear' (Stop / session reset) so an
     * in-flight simulateTyping loop stops instead of finishing the text.
     * Reset at the start of every new action.
     */
    let cancelRequested = false;

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

    /**
     * Key metadata lookup, keyCode, code, and whether the key is printable.
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
    // Visual-only pauses (the on-page cursor) are skipped when nobody can see
    // them: a hidden tab's timers are throttled to about one per second, which
    // turned a 260ms cursor glide into a full second per action.
    const visualDelay = (ms) => (document.visibilityState === "hidden" ? Promise.resolve() : delay(ms));

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
     * Waits until the DOM is "stable", no mutations for `quietPeriod` ms.
     * @param {number} [quietPeriod=500] - How long (ms) with no mutations to consider stable.
     * @param {number} [timeout=3000] - Hard timeout in ms.
     * @returns {Promise<void>}
     */
    function waitForDomStable(quietPeriod = 500, timeout = 3000) {
        // Waits for the page to stop CHANGING, not for mutations to stop.
        //
        // This used to debounce a MutationObserver watching childList,
        // attributes and characterData across the whole subtree. Any CSS
        // animation, ticking clock, carousel or lazy-load kept re-arming the
        // debounce, so on a busy page every single action paid the full hard
        // timeout: measured at 2201ms per action against 404ms here
        // (tests/benchmark/settle-benchmark.js).
        //
        // Sampling a cheap structural signature instead is immune to cosmetic
        // churn, because opacity and text-tick changes do not move it. The
        // quiet period is kept as a floor so async content that has not landed
        // yet is never missed, which a pure "settle as soon as it looks stable"
        // version got wrong.
        const POLL_MS = 100;
        const STABLE_SAMPLES = 2;

        function pageSignature() {
            let interactive = 0;
            let total = 0;
            try {
                interactive = document.querySelectorAll(
                    'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]'
                ).length;
                total = document.querySelectorAll("*").length;
            } catch (_) { /* keep zeros */ }
            return [
                location.href,
                document.title,
                interactive,
                total,
                Math.round(window.scrollY || 0),
            ].join("|");
        }

        return new Promise((resolve) => {
            const started = Date.now();
            let last = pageSignature();
            let stable = 0;

            const tick = () => {
                const now = pageSignature();
                if (now === last) stable += 1;
                else { stable = 0; last = now; }

                const elapsed = Date.now() - started;
                if ((stable >= STABLE_SAMPLES && elapsed >= quietPeriod) || elapsed >= timeout) {
                    resolve();
                    return;
                }
                setTimeout(tick, POLL_MS);
            };

            setTimeout(tick, POLL_MS);
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
                    error: 'That control is no longer on the page: the page redrew or removed it.'
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

            /* A number is drawn over the page, not part of it: the pointer, the
               agent's or the person's, goes through it to what is beneath. */
            .select-to-ai-badge {
                position: absolute;
                pointer-events: none;
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

    function placeAgentCursor(clientX, clientY, label = "Working") {
        ensureAgentCursor();
        const x = Math.max(8, Math.min(window.innerWidth - 24, clientX));
        const y = Math.max(8, Math.min(window.innerHeight - 24, clientY));
        agentCursor.style.opacity = "1";
        agentCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        agentCursorLabel.textContent = label;
        agentCursorLabel.style.opacity = "1";
        agentCursorLabel.style.transform = `translate3d(${Math.min(window.innerWidth - 180, x + 28)}px, ${Math.min(window.innerHeight - 36, y + 18)}px, 0)`;
    }

    async function moveAgentCursorTo(clientX, clientY, label = "Working") {
        placeAgentCursor(clientX, clientY, label);
        await visualDelay(140);
    }

    async function moveAgentCursorToElement(el, label = "Working") {
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
            // At once, never smoothly: in a tab that is drawn, a smooth scroll
            // (of this page and of the pages around a frame) is still moving
            // when the pointer is aimed, and the press lands where the
            // control was. Measured on a seat button inside another site's frame.
            el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
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
        await visualDelay(90);
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

    /** The name a person would read for a control: its label, not its markup. */
    function accessibleName(el) {
        try {
            const aria = el.getAttribute('aria-label');
            if (aria && aria.trim()) return aria.trim();
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
                const t = labelledBy.split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean)
                    .map((n) => n.innerText || n.textContent || '').join(' ').trim();
                if (t) return t.replace(/\s+/g, ' ').slice(0, 80);
            }
            if (el.labels && el.labels.length) {
                const t = (el.labels[0].innerText || '').replace(/\s+/g, ' ').trim();
                if (t) return t.slice(0, 80);
            }
            if (el.alt) return el.alt;
            if (el.tagName === 'IMG' || el.tagName === 'SVG') return el.getAttribute('title') || '';
            if (isNamedByPlace(el)) return wordsBeside(el);
        } catch (_) { /* fall back to visible text */ }
        return '';
    }

    const CONTROL_SELECTOR = 'input:not([type="hidden"]), select, textarea, button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [contenteditable="true"]';

    /** A field a person names by the words printed next to it. */
    function isNamedByPlace(el) {
        const tag = el.tagName;
        if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
        if (tag === 'INPUT') return !/^(button|submit|reset|image|hidden|file)$/.test((el.type || 'text').toLowerCase());
        return /^(textbox|combobox|checkbox|radio|switch|spinbutton|slider)$/.test(el.getAttribute('role') || '');
    }

    /**
     * The short text that labels a field in its row: the words just before
     * it (just after it, for a checkbox or radio), the previous cell of its
     * table row, or the leading text of the boxes around it. Words that sit
     * on the other side of another control belong to that control.
     */
    function wordsBeside(el) {
        const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
        const hasWords = (t) => /[\p{L}\p{N}]/u.test(t);
        // The words of one neighbour: null when it is, or holds, another control.
        const wordsOf = (n) => {
            if (n.nodeType === 3) return clean(n.data);
            if (n.nodeType !== 1 || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) return '';
            if (n.matches(CONTROL_SELECTOR) || n.querySelector(CONTROL_SELECTOR)) return null;
            if (n.tagName === 'LABEL' && n.control && n.control !== el) return null;
            return clean(n.innerText);
        };
        // The words on one side of a node within its parent, nearest first, up to the first that say something.
        const side = (node, forward) => {
            const pieces = [];
            for (let n = forward ? node.nextSibling : node.previousSibling; n; n = forward ? n.nextSibling : n.previousSibling) {
                const t = wordsOf(n);
                if (t === null) return null;
                if (!t) continue;
                if (forward) pieces.push(t); else pieces.unshift(t);
                if (hasWords(t)) break;
            }
            return clean(pieces.join(' ')).replace(/\s*[:\uff1a]\s*$/, '').replace(/^\s*[:\uff1a]\s*/, '');
        };
        const fits = (t) => t && hasWords(t) && t.length <= 60;
        const tick = el.tagName === 'INPUT' ? /^(checkbox|radio)$/.test((el.type || '').toLowerCase()) : /^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '');
        if (tick) {
            const after = side(el, true);
            if (fits(after)) return after;
            // A box to tick is named by the words right beside it and no
            // others: words further up belong to something else.
            const before = side(el, false);
            return fits(before) ? before : '';
        }
        // Up through the boxes around it while it is the only control in
        // them, and no further than its table row or list entry.
        let node = el;
        for (let depth = 0; depth < 4 && node.parentElement && node !== document.body; depth++) {
            const before = side(node, false);
            if (before === null) return '';
            if (fits(before)) return before;
            if (before && hasWords(before)) return '';
            const parent = node.parentElement;
            if (/^(TR|LI|FORM|FIELDSET|BODY|TABLE|UL|OL)$/.test(parent.tagName) || parent.getAttribute('role') === 'row') break;
            node = parent;
        }
        return '';
    }

    /** The state a control shows, in words: ticked, chosen, open, its value. */
    function stateOf(el) {
        try {
            const said = [];
            const type = (el.type || '').toLowerCase();
            const checked = el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(type) ? String(el.checked) : el.getAttribute('aria-checked');
            if (checked !== null) said.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'partly checked' : 'not checked');
            const pressed = el.getAttribute('aria-pressed');
            if (pressed !== null) said.push(pressed === 'true' ? 'pressed' : 'not pressed');
            const selected = el.getAttribute('aria-selected');
            if (selected !== null) said.push(selected === 'true' ? 'selected' : 'not selected');
            const expanded = el.getAttribute('aria-expanded');
            if (expanded !== null) said.push(expanded === 'true' ? 'open' : 'closed');
            const secret = (el.tagName === 'INPUT' && type === 'password') || !!sensitiveKind(el);
            const value = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow')
                || (!secret && (el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].text : '') : /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|reset|image|file)$/.test(type) ? el.value : ''));
            if (value) said.push(`showing "${String(value).replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
            return said.join(', ');
        } catch (_) { return ''; }
    }

    // When the engine last gave no answer about a real key, scripted keys
    // are used for a while instead of waiting on it for every press.
    let realKeysQuietUntil = 0;

    /** Asks the engine to press a real key in this tab. False when it cannot. */
    function pressRealKey(key, meta, modifiers, times) {
        if (Date.now() < realKeysQuietUntil) return Promise.resolve(false);
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            try {
                const textOf = key === 'Enter' ? '\r' : key === 'Space' || key === ' ' ? ' ' : meta.printable && key.length === 1 ? key : '';
                const bits = (modifiers.altKey ? 1 : 0) | (modifiers.ctrlKey ? 2 : 0) | (modifiers.metaKey ? 4 : 0) | (modifiers.shiftKey ? 8 : 0);
                const sent = chrome.runtime.sendMessage({ action: 'agentRealKey', key: key === 'Space' ? ' ' : key, code: meta.code, keyCode: meta.keyCode, text: bits & 7 ? '' : textOf, modifiers: bits, times }, (r) => {
                    void chrome.runtime.lastError;
                    done(!!(r && r.ok));
                });
                if (sent && typeof sent.then === 'function') sent.then((r) => done(!!(r && r.ok)), () => done(false));
                setTimeout(() => { if (!settled) realKeysQuietUntil = Date.now() + 60000; done(false); }, 4000);
            } catch (_) { done(false); }
        });
    }

    /**
     * One key pressed on a control, as a person would press it: a real key
     * where the engine can send one, a scripted one otherwise. `how`
     * carries which of the two worked to the next press in the same action.
     */
    async function stepKey(el, key, how) {
        if (document.activeElement !== el) el.focus();
        const meta = resolveKeyMeta(key);
        if (how.real !== false && window === window.top) {
            how.real = await pressRealKey(key, meta, {}, 1);
            if (how.real) return;
        }
        const opts = { key, code: meta.code, keyCode: meta.keyCode, which: meta.keyCode, bubbles: true, cancelable: true, composed: true, view: window };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    /** The number a short piece of text reads as, or null. */
    function numberIn(text) {
        const t = String(text || '').trim();
        if (!t || t.length > 40) return null;
        const m = t.match(/-?\d[\d,]*(?:\.\d+)?/);
        return m ? Number(m[0].replace(/,/g, '')) : null;
    }

    /**
     * Every short piece of text and every box on the page that reads as a
     * number: {node, home, value}. `home` is the element the text is in, for
     * when the page replaces the text itself.
     */
    function numbersOnPage() {
        const out = [];
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const v = numberIn(n.data);
                if (v !== null) out.push({ node: n, home: n.parentElement, value: v });
            }
            for (const box of document.querySelectorAll('input')) {
                const v = numberIn(box.value);
                if (v !== null) out.push({ node: box, home: box, value: v });
            }
        } catch (_) { /* no page to read */ }
        return out;
    }

    /** What a number found by numbersOnPage reads now, or null. */
    function numberNow(found) {
        const n = found.node;
        if (n.isConnected) return numberIn(n.nodeType === 3 ? n.data : n.value);
        return found.home && found.home.isConnected ? numberIn(found.home.innerText) : null;
    }

    /** What a page's markup calls a wordless control: class, id and picture names. */
    function markingsOf(el) {
        try {
            const inner = el.querySelector('img, svg, use, i, span');
            const parts = [];
            for (const n of [el, inner]) {
                if (!n) continue;
                parts.push(n.getAttribute('class') || '', n.id || '', n.getAttribute('data-icon') || '', n.getAttribute('title') || '');
                const src = n.getAttribute('src') || n.getAttribute('href') || n.getAttribute('xlink:href') || '';
                if (src && !/^data:/.test(src)) parts.push(src.split(/[?]/)[0].split('/').pop().replace(/\.[a-z0-9]{2,4}$/i, ''));
            }
            const words = [...new Set(parts.join(' ').split(/\s+/).filter((w) => /[a-z]{3}/i.test(w) && !/^data-select-to-ai/.test(w)))];
            return words.join(' ').slice(0, 50);
        } catch (_) { return ''; }
    }

    /** The colour a control is painted, in a word: its background, or a shape's fill. */
    function colourOf(el) {
        try {
            if (typeof SELECT_TO_AI_TOOLS === 'undefined' || !SELECT_TO_AI_TOOLS.colourName) return '';
            const shape = (n) => n instanceof SVGElement && n.tagName.toLowerCase() !== 'svg';
            const paint = (n) => {
                const cs = getComputedStyle(n);
                const c = parseColor(shape(n) ? cs.fill : cs.backgroundColor);
                return c && c.a >= 0.3 ? c : null;
            };
            let c = paint(el);
            // A drawing with no background of its own is the colour of what is drawn in it.
            if (!c && el.tagName.toLowerCase() === 'svg') {
                const first = el.querySelector('circle, rect, ellipse, path, polygon, polyline');
                if (first) c = paint(first);
            }
            return c ? SELECT_TO_AI_TOOLS.colourName(c) : '';
        } catch (_) { return ''; }
    }

    /** Same-site links as a path, others as host plus path, no tracking noise. */
    function shortHref(href) {
        try {
            const u = new URL(href, location.href);
            if (!/^https?:$/.test(u.protocol)) return '';
            // A link to a spot on this same page scrolls; it does not go anywhere.
            if (u.hash && u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) return u.hash.slice(0, 60);
            // A link to this very page (a button written as a link) goes nowhere worth naming.
            if (!u.hash && u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) return '';
            const path = u.pathname + (u.search && u.search.length < 40 ? u.search : '');
            if (u.origin !== location.origin) return u.host + path;
            // Links under this page's own folder, relative: a docs sidebar
            // repeated "/en-US/docs/Web/JavaScript/Reference/.../Array/" sixty times.
            const dir = location.pathname.replace(/[^/]*$/, '');
            return dir.length > 12 && path.startsWith(dir) && path.length > dir.length ? `./${path.slice(dir.length)}` : path;
        } catch (_) { return ''; }
    }

    const BOILERPLATE = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-hidden="true"]';
    const MAIN_SELECTORS = ['main', '[role="main"]', 'article', '#mw-content-text', '#content', '#main', '.main-content', '#main-content'];
    // How much of a page's text is kept for find and read. Long documents
    // (a specification, a manual) run to half a million characters, and a
    // section past the cap could be seen in its table of contents but never read.
    const PAGE_TEXT_LIMIT = 700000;

    /**
     * The page's main content area. A page that marks one with <main> or
     * role="main" says so itself. The other selectors are guesses from
     * common names, and a guess must hold a fair share of the page's text:
     * a document whose sections take their ids from their titles has a
     * section called "Content" (id="content"), and a listing has one
     * <article> per card. Taking that one part as the page hid the rest.
     */
    function pickMain(doc) {
        const bodyLength = ((doc.body && doc.body.innerText) || '').trim().length;
        for (const sel of MAIN_SELECTORS) {
            const cand = doc.querySelector(sel);
            if (!cand) continue;
            const length = (cand.innerText || '').trim().length;
            if (length <= 200) continue;
            const declared = sel === 'main' || sel === '[role="main"]';
            if (declared || length >= bodyLength * 0.3) return cand;
        }
        return null;
    }

    /**
     * Text a page draws inside open shadow roots (web components). innerText
     * does not reach into them, so a reading built on it misses whatever a
     * component renders: a usage figure, a price, a status line.
     */
    function shadowText(root) {
        const out = [];
        const seenRoots = new Set();
        const visit = (scope, depth) => {
            if (depth > 6 || out.length > 400) return;
            for (const el of scope.querySelectorAll('*')) {
                const sr = el.shadowRoot;
                if (!sr || seenRoots.has(sr)) continue;
                seenRoots.add(sr);
                for (const kid of sr.children) {
                    if (/^(STYLE|SCRIPT|TEMPLATE|SLOT)$/.test(kid.tagName)) continue;
                    const t = seenText(kid).replace(/[ \t ]+/g, ' ').trim();
                    if (t) out.push(t);
                }
                visit(sr, depth + 1);
            }
        };
        visit(root, 0);
        return out.join('\n');
    }

    /**
     * What an element with no words of its own says through its attributes.
     * Star ratings, levels and scores are often drawn as icons, with the value
     * only in an attribute: aria-label="4 out of 5", title="Supported", or a
     * class like "star-rating Three" or "rating-45" that the page's style turns
     * into stars. Controls are left out: they are listed with their names.
     */
    const RATING_WORD = /^(?:rating|ratings|rated|stars?|score)$/i;
    const VALUE_WORD = /^(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|half|full|empty)$/i;
    /**
     * True when a class list carries a rating's value: a rating word with a
     * value after it in the same class ("a-star-4-5", "rating-45"), or a
     * rating class beside a class that is only a value ("star-rating Three").
     * A value elsewhere ("score-panel mt-2") is layout, not a rating.
     */
    function ratingClass(cls) {
        const tokens = String(cls || '').split(/\s+/).filter(Boolean);
        const parts = tokens.map((t) => t.split(/[_-]+/));
        let rated = false;
        for (const p of parts) {
            const at = p.findIndex((x) => RATING_WORD.test(x));
            if (at < 0) continue;
            rated = true;
            if (p.slice(at + 1).some((x) => VALUE_WORD.test(x))) return true;
        }
        return rated && tokens.some((t) => VALUE_WORD.test(t));
    }
    function markedMeaning(el) {
        if (!el || el.nodeType !== 1) return '';
        // Controls are listed with their names; pictures and frames are read as media.
        if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|OPTION|LABEL|SUMMARY|IMG|VIDEO|CANVAS|SVG|IFRAME|PICTURE)$/i.test(el.tagName)) return '';
        const role = el.getAttribute('role') || '';
        if (/^(button|link|menuitem|tab|checkbox|radio|switch|option|textbox|combobox|slider)$/.test(role)) return '';
        // Attributes first: they are cheap, and most elements have none of these.
        const said = el.getAttribute('aria-hidden') === 'true' ? '' : (el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const cls = (typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '')).replace(/\s+/g, ' ').trim();
        const byClass = cls && ratingClass(cls) ? `class "${cls.slice(0, 80)}"` : '';
        if (!said && !byClass) return '';
        // Only an element with no words of its own: otherwise its words say it.
        if ((el.innerText || el.textContent || '').trim()) return '';
        return said ? said.slice(0, 120) : byClass;
    }

    /**
     * The heading of the part of the page the address points to (#fragment):
     * the heading itself, or the first heading in the section it names.
     * The text under it is found in the page's reading by this heading.
     */
    function anchorHeading(doc, hash) {
        const id = String(hash || '').replace(/^#/, '');
        if (!id) return '';
        let target = null;
        try { target = doc.getElementById(decodeURIComponent(id)); } catch (_e) { target = doc.getElementById(id); }
        if (!target && doc.getElementsByName) target = doc.getElementsByName(id)[0] || null;
        if (!target) return '';
        const isHeading = (n) => n && /^H[1-6]$/.test(n.tagName);
        let heading = isHeading(target) ? target : (target.querySelector && target.querySelector('h1, h2, h3, h4, h5, h6'));
        if (!heading && target.closest) {
            const section = target.closest('section');
            heading = section && section.querySelector('h1, h2, h3, h4, h5, h6');
        }
        if (!isHeading(heading)) return '';
        return String(heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    function tidyText(t) {
        return String(t || '')
            .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
            .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    /**
     * What the page says, the way a reader takes it in: the main content
     * without menus and footers (native innerText, which is fast and already
     * respects CSS visibility), a heading outline of the whole page, and the
     * text currently on screen.
     */
    /**
     * The main content as compact Markdown: headings as #, lists as -,
     * tables as rows, code fenced, images and media as short notes. Structure
     * is what lets a model read one section, skip another, or read a table,
     * and it costs fewer tokens than flattened text with the same words.
     * Hidden elements, menus and citation markers ("[12]") are left out.
     */
    // ---- text a reader cannot see ---------------------------------------
    // The agent reads what a person looking at the page would read. Text
    // drawn in the background's own colour, at a size too small to read,
    // pushed off the page or clipped to a pixel is not part of that, and is
    // the usual hiding place for instructions aimed at an AI.
    const unseenBox = new WeakMap();
    const unseenText = new WeakMap();
    const paintedBehind = new WeakMap();

    function parseColor(value) {
        const m = String(value || '').match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/);
        if (!m) return null;
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (m[4] && m[4].endsWith('%')) a /= 100;
        return { r: +m[1], g: +m[2], b: +m[3], a };
    }

    /** The colour painted behind an element, or null when it is a picture or gradient. */
    function backgroundBehind(el) {
        if (!el || el.nodeType !== 1) {
            // Nothing painted: the browser's own canvas, white unless the page opts into a dark scheme.
            const scheme = getComputedStyle(document.documentElement).colorScheme || '';
            return /dark/.test(scheme) ? null : { r: 255, g: 255, b: 255, a: 1 };
        }
        if (paintedBehind.has(el)) return paintedBehind.get(el);
        const cs = getComputedStyle(el);
        let out;
        if (cs.backgroundImage && cs.backgroundImage !== 'none') out = null;
        else {
            const bg = parseColor(cs.backgroundColor);
            out = bg && bg.a > 0.5 ? bg : backgroundBehind(el.parentElement);
        }
        paintedBehind.set(el, out);
        return out;
    }

    /** True when the element's box can never be seen: off the page, or clipped to a pixel. */
    function boxUnseeable(el) {
        if (unseenBox.has(el)) return unseenBox.get(el);
        let out = false;
        try {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                // Left of or above the page itself: no amount of scrolling reaches it.
                if (r.right + window.scrollX < -50 || r.bottom + window.scrollY < -50) out = true;
                else if (r.width <= 2 && r.height <= 2 && getComputedStyle(el).overflow !== 'visible') out = true;
            }
        } catch (_) { /* treat as seeable */ }
        unseenBox.set(el, out);
        return out;
    }

    /** True when text set directly in this element cannot be read: invisible ink, or too small. */
    function textUnseeable(el) {
        if (unseenText.has(el)) return unseenText.get(el);
        let out = false;
        try {
            const cs = getComputedStyle(el);
            if (parseFloat(cs.fontSize) < 3 || parseFloat(cs.textIndent) < -500) out = true;
            // Gradient headings are transparent text showing their own background.
            else if (cs.webkitBackgroundClip !== 'text' && cs.backgroundClip !== 'text') {
                const ink = parseColor(cs.color);
                if (ink && ink.a < 0.1) out = true;
                else if (ink) {
                    const behind = backgroundBehind(el);
                    out = !!behind && Math.max(Math.abs(ink.r - behind.r), Math.abs(ink.g - behind.g), Math.abs(ink.b - behind.b)) <= 10;
                }
            }
        } catch (_) { /* treat as readable */ }
        unseenText.set(el, out);
        return out;
    }

    const ownsText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false; };

    // What seenText left out during one reading of the page, kept so the
    // run can be told when the page hides something written to an AI.
    let leftOut = null;
    const leave = (t) => { if (leftOut && t && leftOut.size < 400) leftOut.add(t); };

    /**
     * Lines of what a reading left out that are long enough to say
     * something: a sentence, not a "Skip to content" link or a menu item.
     * Scripts written without spaces carry more per character, so their
     * characters count for more. Each line once, at most 8.
     */
    function unseenPassages(found) {
        const weight = (t) => (t.match(/[\p{L}\p{N}]/gu) || []).length + 2 * (t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/gu) || []).length;
        const lines = new Set();
        for (const chunk of found || []) {
            for (const raw of String(chunk).split('\n')) {
                const line = raw.replace(/\s+/g, ' ').trim();
                if (line && weight(line) >= 40) lines.add(line.slice(0, 400));
            }
        }
        const all = [...lines];
        return all.filter((l) => !all.some((o) => o !== l && o.includes(l))).slice(0, 8);
    }

    /** An element's text as laid out, without the parts of it a reader cannot see. */
    function seenText(el) {
        // innerText is what is drawn. Only where a node has none of its own
        // (an SVG) is its content read instead, so hidden words stay out.
        let text = (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
        if (!text.trim()) return '';
        if (ownsText(el) && textUnseeable(el)) {
            if (!el.firstElementChild) { leave(text); return ''; }
            for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim() && text.includes(n.textContent.trim())) { leave(n.textContent); text = text.replace(n.textContent.trim(), ''); }
        }
        if (!el.firstElementChild) return text;
        for (const kid of el.querySelectorAll('*')) {
            if (boxUnseeable(kid) || (ownsText(kid) && textUnseeable(kid))) {
                const gone = (kid.innerText || kid.textContent || '').trim();
                if (gone && text.includes(gone)) { leave(gone); text = text.replace(gone, ''); }
            }
        }
        return text;
    }

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'NAV', 'FOOTER', 'ASIDE', 'BUTTON', 'SELECT', 'OPTION', 'INPUT', 'TEXTAREA', 'IFRAME', 'MENU']);
    const SKIP_CLASS = /(?:^|\s)(?:mw-editsection|reference|noprint|navbox|sidebar|toc|cookie|advert|ads?|share|social|breadcrumb)(?:\s|$)/i;
    function extractMarkdown(root, maxChars) {
        const out = [];
        let used = 0;
        const media = { images: 0, videos: 0, charts: 0, tables: 0, imageAlts: [] };
        const seen = new Set();
        const push = (s) => {
            if (used >= maxChars || !s) return;
            // The same long line twice is a clone (carousels, sticky headers), not new content.
            if (s.length >= 40 && !s.startsWith('|')) {
                if (seen.has(s)) return;
                seen.add(s);
            }
            out.push(s);
            used += s.length + 1;
        };
        const inlineText = (el) => seenText(el)
            .replace(/\[\d+\]|\[citation needed\]|\[edit\]/gi, '')
            .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
        // Elements inside one read as a line that say what they mean only
        // through attributes: a listing card's empty star-rating paragraph
        // sits beside its title and price, and inline text never shows it.
        const marksIn = (el) => {
            const found = [];
            if (!el.querySelectorAll) return found;
            for (const d of el.querySelectorAll('[class], [aria-label], [title]')) {
                if (found.length >= 8) break;
                if (found.some((f) => f.el.contains(d))) continue;
                if (d.closest && d.closest('button, [role="button"]')) continue;
                const m = markedMeaning(d);
                if (m && !hidden(d)) found.push({ el: d, m });
            }
            return found.map((f) => `[${f.m}]`);
        };
        const inlineOrMarked = (el) => {
            const t = inlineText(el);
            if (!t) { const m = markedMeaning(el); if (m) return `[${m}]`; }
            return [t, ...marksIn(el)].filter(Boolean).join(' ');
        };
        const hidden = (el) => {
            if (el.hidden || boxUnseeable(el)) return true;
            // aria-hidden marks decoration (icons, a price repeated for screen
            // readers) but also every carousel slide not currently shown, whose
            // headlines are real content. Short text is decoration; repeats of
            // long lines (cloned slides) are dropped when pushed.
            if (el.getAttribute('aria-hidden') === 'true' && (el.innerText || '').trim().length < 40) return true;
            // display:contents wrappers have no box, so checkVisibility()
            // calls them hidden although everything inside them shows.
            // visibilityProperty matches innerText: tooltips and closed menus
            // hidden with visibility:hidden are not page text. Opacity is not
            // checked, since scroll-in animations start content at opacity 0.
            if (typeof el.checkVisibility === 'function') return !el.checkVisibility({ visibilityProperty: true }) && getComputedStyle(el).display !== 'contents';
            return el.offsetParent === null && !['fixed', 'contents'].includes(getComputedStyle(el).position) && getComputedStyle(el).display !== 'contents';
        };
        const walk = (el, depth) => {
            if (used >= maxChars || !el || el.nodeType !== 1) return;
            const tag = el.tagName;
            // An accordion's question is content, though it sits in a button:
            // disclosure buttons (aria-expanded / aria-controls) are kept as text.
            if (isDisclosure(el) && !hidden(el)) {
                const t = inlineText(el);
                if (t) push(t);
                return;
            }
            if (SKIP_TAGS.has(tag) || SKIP_CLASS.test(el.className && el.className.baseVal === undefined ? el.className : '')) return;
            const role = el.getAttribute('role');
            if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary') return;
            if (hidden(el)) return;
            // An element with no words whose attributes carry its meaning (a star rating drawn from a class).
            // Its content is still read when it has any: pictures inside it,
            // or a web component's shadow root, which innerText does not see.
            const marked = markedMeaning(el);
            if (marked) {
                push(`[${marked}]`);
                if (!el.firstElementChild && !el.shadowRoot) return;
            }
            if (/^H[1-6]$/.test(tag)) { const t = inlineText(el); if (t) push(`${'#'.repeat(Number(tag[1]))} ${t}`); return; }
            if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION' || tag === 'DT' || tag === 'DD') {
                const t = marked ? '' : inlineOrMarked(el);
                if (t) push(tag === 'BLOCKQUOTE' ? `> ${t}` : t);
                el.querySelectorAll('img').forEach((img) => walk(img, depth + 1));
                return;
            }
            if (tag === 'LI') {
                const readable = !textUnseeable(el);
                const own = [...el.childNodes].filter((n) => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName)))
                    .map((n) => (n.nodeType === 3 ? (readable ? n.textContent : '') : (n.nodeType === 1 && !hidden(n) ? inlineOrMarked(n) : ''))).join(' ').replace(/\s+/g, ' ').replace(/\[\d+\]/g, '').trim();
                if (own) push(`${'  '.repeat(Math.max(0, depth))}- ${own}`);
                el.querySelectorAll(':scope > ul, :scope > ol').forEach((sub) => walk(sub, depth + 1));
                return;
            }
            if (tag === 'UL' || tag === 'OL') { [...el.children].forEach((c) => walk(c, tag === 'UL' || tag === 'OL' ? depth : depth)); return; }
            if (tag === 'TABLE') {
                media.tables++;
                // Comparison tables, price lists and schedules run long; the
                // page budget and part-by-part reading bound the size, not a row cap.
                const rows = [...el.rows].slice(0, 400);
                rows.forEach((r, i) => {
                    const cells = [...r.cells].map((c) => inlineOrMarked(c).slice(0, 600));
                    if (cells.some(Boolean)) push(`| ${cells.join(' | ')} |`);
                    if (i === 0) push(`|${cells.map(() => ' --- ').join('|')}|`);
                });
                if (el.rows.length > 400) push(`(table continues: ${el.rows.length - 400} more rows)`);
                return;
            }
            if (tag === 'PRE') { const t = seenText(el).trim(); if (t) push('```\n' + t.slice(0, 20000) + '\n```'); return; }
            if (tag === 'IMG') {
                const r = el.getBoundingClientRect();
                if (r.width >= 120 && r.height >= 80) {
                    media.images++;
                    const alt = (el.alt || el.title || '').trim();
                    if (alt && media.imageAlts.length < 12) media.imageAlts.push(alt.slice(0, 80));
                    if (alt) push(`[image: ${alt.slice(0, 120)}]`);
                }
                return;
            }
            if (tag === 'VIDEO') { media.videos++; push(`[video${el.title ? `: ${el.title}` : ''}]`); return; }
            if (tag === 'CANVAS') { const r = el.getBoundingClientRect(); if (r.width >= 150 && r.height >= 100) { media.charts++; push('[chart or drawing]'); } return; }
            // Web components keep their content in an open shadow root that
            // innerText never sees (MDN renders its examples this way).
            if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, depth);
            // Containers: lay text out the way the browser does. Text and
            // inline children run together into one line; block children
            // start their own. Most sites put prices, dates, names and labels
            // in bare divs and spans, so short text is content too.
            let line = [];
            const flush = () => {
                const t = line.join(' ').replace(/\s+/g, ' ').replace(/\[\d+\]|\[citation needed\]|\[edit\]/gi, '').trim();
                line = [];
                if (/[\p{L}\p{N}]/u.test(t)) push(t);
            };
            const ownReadable = !ownsText(el) || !textUnseeable(el);
            for (const child of el.childNodes) {
                if (child.nodeType === 3) { if (ownReadable) line.push(child.textContent); continue; }
                if (child.nodeType !== 1) continue;
                if (runsInline(child)) {
                    if ((SKIP_TAGS.has(child.tagName) && !isDisclosure(child)) || hidden(child)) continue;
                    line.push(inlineOrMarked(child));
                    continue;
                }
                flush();
                walk(child, depth);
            }
            flush();
        };
        const isDisclosure = (el) => el.tagName === 'BUTTON' && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls'));
        // An inline element whose text has no line breaks (so no block inside it).
        const runsInline = (el) => {
            if (/^(IMG|VIDEO|CANVAS|TABLE|PRE|UL|OL|LI|P|BLOCKQUOTE|FIGCAPTION|DT|DD|H[1-6])$/.test(el.tagName) || el.shadowRoot) return false;
            if (SKIP_CLASS.test(el.className && el.className.baseVal === undefined ? el.className : '')) return false;
            const display = getComputedStyle(el).display;
            return display.startsWith('inline') && !/\n/.test(el.innerText || '');
        };
        walk(root, 0);
        return { markdown: out.join('\n').replace(/\n{3,}/g, '\n\n'), media };
    }

    // Parts of a page the Markdown walk leaves out by design (SKIP_TAGS and roles).
    const WALK_SKIPS = 'nav, footer, [role="navigation"], [role="contentinfo"]';

    /**
     * The share of the plain reading's words that the Markdown reading
     * kept, leaving out the words of the parts the walk skips on purpose
     * (`skipped`, their text). Asides are not left out: a page may put real
     * content in one, and then the plain reading should win.
     */
    function keptShare(markdown, plain, skipped) {
        let yard = String(plain || '');
        for (const chunk of skipped || []) if (chunk && chunk.length > 20) yard = yard.split(chunk).join('\n');
        const wordsOf = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
        const mdWords = new Set(wordsOf(markdown));
        const plainWords = wordsOf(yard);
        return plainWords.length ? plainWords.filter((w) => mdWords.has(w)).length / plainWords.length : 1;
    }

    function extractPageContent() {
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const mainEl = pickMain(document);
        // The plain reading is both the fallback and the yardstick the
        // structured one is held to, so it leaves out unseeable text too:
        // otherwise a page could stuff itself with hidden words to force
        // the fallback and get them read.
        leftOut = new Set();
        let text = tidyText(seenText(mainEl || document.body));
        // Web components' own text, which innerText leaves out. Without it
        // the plain reading (the fallback, and the yardstick for the
        // structured one) has none of what a component draws.
        const inShadow = shadowText(mainEl || document.body);
        if (inShadow) text = tidyText(`${text}\n${inShadow}`);
        const unseen = unseenPassages(leftOut);
        leftOut = null;
        if (!mainEl) {
            // No marked-up main area: drop the menus' own text instead.
            document.querySelectorAll(BOILERPLATE).forEach((b) => {
                const chunk = tidyText(b.innerText || '');
                if (chunk.length > 20 && chunk.length < text.length / 2) text = text.replace(chunk, '');
            });
            text = tidyText(text);
        }

        const outline = [];
        document.querySelectorAll('h1, h2, h3').forEach((h) => {
            if (outline.length >= 40) return;
            if (boxUnseeable(h)) return;
            const label = seenText(h).replace(/\s+/g, ' ').trim();
            if (!label || (typeof h.checkVisibility === 'function' && !h.checkVisibility())) return;
            const r = h.getBoundingClientRect();
            const where = r.bottom < 0 ? 'above' : r.top > vh ? 'below' : 'on screen';
            outline.push({ level: Number(h.tagName[1]), text: label.slice(0, 90), where });
        });

        const onScreen = [];
        let onScreenChars = 0;
        (mainEl || document.body).querySelectorAll('h1, h2, h3, h4, p, li, td, dd, dt, blockquote, pre, figcaption, [role="heading"]').forEach((node) => {
            if (onScreenChars > 1800) return;
            const r = node.getBoundingClientRect();
            if (r.height <= 0 || r.bottom < 0 || r.top > vh) return;
            if (node.parentElement && node.parentElement.closest('p, li, td, blockquote') && node.tagName !== 'P') return;
            // Blocks holding controls are UI (a settings menu), not content.
            if (node.querySelector('input, button, select, textarea')) return;
            if (boxUnseeable(node)) return;
            const t = seenText(node).replace(/\s+/g, ' ').trim();
            if (!t || onScreen[onScreen.length - 1] === t) return;
            onScreen.push(t);
            onScreenChars += t.length;
        });

        let md = { markdown: '', media: { images: 0, videos: 0, charts: 0, tables: 0, imageAlts: [] } };
        try { md = extractMarkdown(mainEl || document.body, PAGE_TEXT_LIMIT); } catch (_e) { /* plain text stays */ }
        // Markdown when it kept the page's words; plain text when a site's
        // markup hides content from the walk. Judged by words kept, not by
        // length: a structured version missing every price is not "long enough".
        // Menus and the footer are left out of the walk on purpose, so their
        // words are not counted against it: a guessed main area that wraps
        // the whole page (caniuse's div#main) would otherwise lose the walk
        // to a plain reading that is mostly menu and footer.
        const skipped = [...(mainEl || document.body).querySelectorAll(WALK_SKIPS)].map((b) => tidyText(b.innerText || ''));
        const useMarkdown = md.markdown.length > 0 && keptShare(md.markdown, text, skipped) >= 0.85;
        const forms = document.querySelectorAll('form, input:not([type="hidden"]), textarea, select').length;
        return {
            text: (useMarkdown ? md.markdown : text).slice(0, PAGE_TEXT_LIMIT),
            format: useMarkdown ? 'markdown' : 'text',
            anchor: (() => { try { return anchorHeading(document, location.hash); } catch (_e) { return ''; } })(),
            outline,
            visibleText: onScreen.join('\n').slice(0, 1800),
            unseen,
            usedMain: !!mainEl,
            media: { ...md.media, formFields: forms },
        };
    }

    /**
     * True when the element is drawn and can take a pointer: it has a size,
     * is not hidden by style or aria-hidden, and accepts pointer events.
     * Where it sits relative to the screen is a separate question (placeOf).
     * @param {Element} el
     * @returns {boolean}
     */
    /**
     * True for a native checkbox, radio button, slider or dropdown that the
     * page has made transparent or tiny in order to draw its own control in
     * the same place. It is still the real control: it holds the state, takes the
     * keyboard, and is what a screen reader announces. What stands in for it
     * (its label, or the box around it) has to be on the page.
     */
    function isDrawnOver(el) {
        try {
            const native = el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /^(checkbox|radio|range)$/.test((el.type || '').toLowerCase()));
            if (!native) return false;
            if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
            if (typeof el.checkVisibility === 'function' ? !el.checkVisibility({ visibilityProperty: true }) : false) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const standIn = (el.labels && el.labels[0]) || el.parentElement;
            return !!standIn && isRendered(standIn);
        } catch (_) {
            return false;
        }
    }
    /** On the page for a person to use: drawn, or a native control the page draws over. */
    const isShown = (el) => isRendered(el) || isDrawnOver(el);

    function isRendered(el) {
        try {
            if (el.getAttribute('aria-hidden') === 'true') return false;

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;

            // Native ancestor check (display, visibility, opacity) instead of
            // computing the style of every ancestor by hand.
            if (typeof el.checkVisibility === "function") {
                if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
                const own = window.getComputedStyle(el);
                return own.pointerEvents !== 'none';
            }

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
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Where a box sits relative to what is on screen: "screen" (on it, or
     * within a short scroll), "above", "below", or "side" (off to the left or
     * right, as in a carousel). `distance` is how far away in pixels.
     */
    function placeOf(rect) {
        const margin = 100;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        if (rect.right < -margin || rect.left > vw + margin) return { where: 'side', distance: Infinity };
        if (rect.bottom < -margin) return { where: 'above', distance: -rect.bottom };
        if (rect.top > vh + margin) return { where: 'below', distance: rect.top - vh };
        return { where: 'screen', distance: 0 };
    }

    /** A password, payment, one-time-code or identity field: its value is never read. */
    function sensitiveKind(el) {
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return '';
        const type = (el.type || '').toLowerCase();
        if (type === 'password') return 'password';
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (/password/.test(ac)) return 'password';
        if (/\bcc-/.test(ac)) return 'payment';
        if (ac.includes('one-time-code')) return 'code';
        // What the field is called anywhere a person or a script would read
        // it: its name and id, its own label, and the visible label tied to it.
        let labelled = '';
        try { labelled = el.labels && el.labels.length ? (el.labels[0].innerText || '') : ''; } catch (_) { /* no label */ }
        // A field named only by the words beside it is read by those words too.
        let beside = '';
        try { beside = labelled ? '' : accessibleName(el); } catch (_) { /* no name */ }
        const hint = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''} ${labelled} ${beside}`.toLowerCase();
        if (/card.?(number|num|no)\b|\bcc.?num|\bcvv\b|\bcvc\b|security.?code|card.?code|\biban\b|\bexpir(y|es|ation)\b|\bexp\.? ?(date|month|year)\b|\bmm ?\/ ?yy/.test(hint)) return 'payment';
        if (/\botp\b|one.?time|verification.?code|\b2fa\b|passcode/.test(hint)) return 'code';
        if (/\bssn\b|social.?security|passport|national.?id/.test(hint)) return 'id';
        return '';
    }

    /** What a form is for, from its structure: a search or lookup, something that sends what was typed, or one box that may do either. */
    function describeForm(form) {
        const controls = Array.from(form.elements || []);
        const typed = controls.filter((c) => {
            if (c.tagName === 'TEXTAREA') return true;
            return c.tagName === 'INPUT' && !/^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/.test((c.type || 'text').toLowerCase());
        }).filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const kinds = typed.map((c) => (c.tagName === 'TEXTAREA' ? 'textarea' : (c.type || 'text').toLowerCase()));
        const isSearchBox = form.getAttribute('role') === 'search' || !!form.closest('[role="search"]') || kinds.includes('search');
        // A GET form reads something: a search, a lookup, an advanced search
        // with a date range (arXiv and GitHub, held as sends on 1 Oct 2026).
        // A message box, an email or phone field, or a password sends
        // something whatever the method says.
        const plainLookup = (form.getAttribute('method') || 'get').toLowerCase() === 'get'
            && typed.length > 0 && kinds.every((k) => /^(text|search|number|date|month|week|time|datetime-local)$/.test(k))
            && !controls.some((c) => sensitiveKind(c));
        // One box for words or numbers and nothing else of the person's: no
        // second box, no file, no tick box, no secret field, and a box whose
        // autocomplete names none of their details. Such a form may ask the
        // site something (a calculator, a translator, a tracking box) or post
        // words for other people (a comment, a chat), and its structure
        // cannot tell which. It is marked so the send it makes can be judged.
        const oneBox = typed.length === 1
            && /^(text|search|number|textarea|date|month|week|time|datetime-local)$/.test(kinds[0])
            && /^(?:on|off)?$/.test((typed[0].getAttribute('autocomplete') || '').trim().toLowerCase())
            && !controls.some((c) => sensitiveKind(c) || (c.tagName === 'INPUT' && /^(file|checkbox)$/.test((c.type || '').toLowerCase())));
        // Where the form goes, without its query: the same form on the same
        // page has the same address from one look at the page to the next.
        let action = '';
        try { const u = new URL(form.getAttribute('action') || '', location.href); action = `${u.origin}${u.pathname}`; } catch (_) { /* ignore */ }
        let crossOrigin = false;
        try { crossOrigin = !!form.getAttribute('action') && new URL(form.action, location.href).origin !== location.origin; } catch (_) { /* ignore */ }
        return {
            search: isSearchBox || plainLookup,
            oneBox,
            action,
            fields: typed.length,
            filled: typed.filter((c) => c.value).length,
            crossOrigin,
        };
    }

    // The containers a control belongs to, numbered so the listing can group
    // controls that share one.
    const groupIds = new WeakMap();
    let nextGroupId = 1;
    function groupKey(node) {
        if (!groupIds.has(node)) groupIds.set(node, nextGroupId++);
        return groupIds.get(node);
    }

    function nameOfContainer(node, kind) {
        const clean = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
        const aria = node.getAttribute('aria-label');
        if (aria && aria.trim()) return clean(aria, 60);
        const by = node.getAttribute('aria-labelledby');
        if (by) {
            const t = by.split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean).map((n) => n.innerText || n.textContent || '').join(' ');
            if (t.trim()) return clean(t, 60);
        }
        // A card, a result or a table row is named by what it says: the
        // title and the details beside it (price, rating, date).
        if (kind === 'item') return clean(node.innerText || node.textContent, 70);
        const heading = node.querySelector('legend, caption, h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (heading) return clean(heading.innerText || heading.textContent, 60);
        return '';
    }

    /**
     * True for one of several look-alike blocks side by side (product cards,
     * search results, feed posts), however the page marks them up: at least
     * three siblings with the same tag and the same first class name.
     */
    function isRepeatedBlock(node) {
        const parent = node.parentElement;
        if (!parent || parent.children.length < 3) return false;
        const sig = (n) => `${n.tagName}.${(n.getAttribute('class') || '').trim().split(/\s+/)[0] || ''}`;
        const mine = sig(node);
        let same = 0;
        for (const sibling of parent.children) {
            if (sig(sibling) === mine) same++;
            if (same >= 3) return true;
        }
        return false;
    }

    /**
     * What is drawn on top of the page: a dialog over its middle, or a bar
     * pinned across the bottom of the window. Found by where it
     * sits, not by what the page calls it: a cookie notice built from plain
     * boxes is as much in the way as one marked up as a dialog.
     *
     * The window is sampled at a few points. Whatever is drawn at a point
     * and pinned to the window (position fixed, or an open dialog) is a
     * layer. A layer that holds most of the page's own text is the page (a
     * web app laid out in one pinned box), not something on top of it.
     */
    let overlayLayers = [];
    function findOverlays() {
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        if (!vw || !vh || !document.body) return [];
        const ours = (n) => n.id && /^select-to-ai-/.test(n.id);
        const layerOf = (el) => {
            for (let n = el, d = 0; n && n !== document.body && n !== document.documentElement && d < 40; d++) {
                if (ours(n)) return null;
                if (n.matches && n.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return n;
                if (window.getComputedStyle(n).position === 'fixed') return n;
                n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
            }
            return null;
        };
        const at = (x, y) => { const el = document.elementFromPoint(x, y); return el ? layerOf(el) : null; };
        const found = new Map();
        const add = (node, where) => { if (node && !found.has(node)) found.set(node, where); };
        // Over the middle means over the centre of the window, or over most
        // of the points around it: a side panel that reaches one of them is
        // part of the page's own layout.
        const hits = new Map();
        let centre = null;
        for (const [fx, fy] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65]]) {
            const node = at(vw * fx, vh * fy);
            if (!node) continue;
            hits.set(node, (hits.get(node) || 0) + 1);
            if (fx === 0.5 && fy === 0.5) centre = node;
        }
        for (const [node, n] of hits) if (node === centre || n >= 3) add(node, 'middle');
        // A bar pinned to the bottom is nearly always a notice, an offer or
        // an ad. One pinned to the top is nearly always the site's own
        // header, whatever it is built from, so the top is not looked at.
        for (const fx of [0.25, 0.5, 0.75]) add(at(vw * fx, vh - 12), 'bottom');
        const pageText = (document.body.innerText || '').length;
        const out = [];
        for (const [node, at0] of found) {
            let where = at0;
            const r = node.getBoundingClientRect();
            const text = (node.innerText || '').length;
            // Most of the page's text is in it: it is the page.
            if (pageText > 400 && text > pageText * 0.6) continue;
            if (where !== 'middle' && r.height > vh * 0.5) where = 'middle';
            if (where === 'middle') {
                if (r.width * r.height < vw * vh * 0.06) continue;
            } else {
                if (r.width < vw * 0.6) continue;
                // The site's own bar of links is part of the page.
                if (node.matches('header, nav, [role="banner"], [role="navigation"]') || node.closest('header, nav') || node.querySelector('nav, [role="navigation"]')) continue;
            }
            const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
            const heading = node.querySelector('h1, h2, h3, h4, [role="heading"]');
            const frame = node.tagName === 'IFRAME' ? node : node.querySelector('iframe');
            const name = clean(node.getAttribute('aria-label')) || clean(heading && heading.innerText) || clean(node.innerText).slice(0, 70)
                || clean(frame && (frame.getAttribute('title') || frame.getAttribute('aria-label')));
            // Drawn by another site inside a frame: what is in it cannot be listed.
            out.push({ node, where, name: name.slice(0, 70), framed: !!frame && !clean(node.innerText) });
        }
        return out;
    }
    const overlayOf = (el) => overlayLayers.find((l) => l.node.contains(el)) || null;

    /**
     * True when a button is the "x" on a value chosen in a field the user
     * types or picks into (a tag, a chosen option of a multi-select).
     * Pressing it takes the value out of what the field holds. In a form it
     * changes nothing until the form is sent; some apps save a field's
     * values as they change, and then re-adding the value undoes it. Either
     * way it is not a delete of a saved record, whatever its words say.
     *
     * Read from the page's structure, not from any one library. All of
     * these must hold, and anything else is left to the delete rules:
     * - the button shows no words of its own (an x, or an icon);
     * - it is not in an option, a list of options or a menu, nor in the
     *   popup a box says it controls (a list of past searches or of saved
     *   cards, whose x deletes them);
     * - the smallest box around it that holds a box the user types into
     *   holds a picker's box (a combobox, or an input that offers choices
     *   as it is typed in) and nothing else: no link, heading, table,
     *   other kind of field or form, only a little text, a few lines tall;
     * - it sits on a value of its own (the x is inside an item with the
     *   value's words) that comes before the typing box, where a field's
     *   chosen values are.
     * A cart row or a saved record has a link, a price, a quantity, a
     * heading or words on its button, so it is never taken for one.
     * `facts` caches what is read about a box for one snapshot.
     */
    const PICKER_ROLES = /^(combobox|listbox|searchbox)$/;
    const ENTRY = 'input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],textarea,[role="combobox"],[role="searchbox"],[role="textbox"],[contenteditable="true"],[contenteditable=""]';
    const POPUP = '[role="option"],[role="listbox"],[role="menu"],[role="menubar"],[role="menuitem"],[role="tree"],[role="treeitem"],[role="grid"],[role="tooltip"]';
    const NOT_A_FIELD = 'a[href],select,h1,h2,h3,h4,h5,h6,[role="heading"],form,table,input[type="number"],input[type="checkbox"],input[type="radio"],input[type="password"],input[type="file"]';
    const OFFERS_CHOICES = (box) => !!box && (PICKER_ROLES.test(box.getAttribute('role') || '') || box.hasAttribute('aria-autocomplete') || /^(listbox|true|tree|grid|menu)$/.test(box.getAttribute('aria-haspopup') || '') || box.hasAttribute('list'));
    const popupsOf = (box) => ['aria-controls', 'aria-owns'].flatMap((a) => (box.getAttribute(a) || '').split(/\s+/)).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
    function fieldBox(node, facts) {
        if (facts && facts.has(node)) return facts.get(node);
        const boxes = [...node.querySelectorAll(ENTRY)];
        let out = null;
        if (boxes.length) {
            const picker = PICKER_ROLES.test(node.getAttribute('role') || '') ? boxes[0] : boxes.find(OFFERS_CHOICES);
            const text = picker && boxes.length <= 2 && !node.querySelector(NOT_A_FIELD) ? ((node.innerText || node.textContent || '') + '').trim() : null;
            const height = text !== null && text.length <= 200 ? node.getBoundingClientRect().height : Infinity;
            out = { boxes, picker: picker || null, small: text !== null && text.length <= 200 && (!height || height <= 200) };
        }
        if (facts) facts.set(node, out);
        return out;
    }
    function inPickedValues(el, facts) {
        if (!el || el.matches(ENTRY) || el.matches('select,option,a[href]')) return false;
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'submit' || type === 'image' || (el.tagName === 'BUTTON' && el.form && !el.hasAttribute('type'))) return false;
        // An x or an icon: a button that shows words says what it does.
        const own = ((el.textContent || '') + '').trim();
        if (/[\p{L}\p{N}]/u.test(own) && !/^x$/i.test(own)) return false;
        if (el.closest(POPUP)) return false;
        let node = el.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 5; node = node.parentElement, depth++) {
            if (!node.querySelector(ENTRY)) continue;
            // The smallest box with a field in it decides: it is a picker's, or the button is not one.
            const field = fieldBox(node, facts);
            if (!field || !field.picker || !field.small || field.boxes.includes(el) || el.contains(field.picker)) return false;
            if (field.boxes.some((b) => popupsOf(b).some((p) => p.contains(el)))) return false;
            // A chosen value comes before the box it was typed or picked in.
            if (!(field.picker.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) return false;
            // The x is on a value: the item of the box it sits in has the value's words beside it.
            let item = el;
            while (item.parentElement && item.parentElement !== node) item = item.parentElement;
            if (item === el || item.contains(field.picker)) return false;
            const value = ((item.textContent || '') + '').replace(own, '').trim();
            return value.length > 0 && value.length <= 60;
        }
        return false;
    }

    /**
     * The part of the page a control belongs to: an open dialog, a card or
     * row, a form, the navigation, the footer. Several buttons with the same
     * label ("Add to cart") are told apart by this. A control whose label
     * is not unique on the page (`repeated`, that label) also counts a short
     * row as its item when the row says something besides that label, so
     * each "Odd" in a column of them is named by the words of its row.
     */
    function groupOf(el, repeated) {
        const own = ((el.innerText || el.textContent || el.value || '') + '').trim().length;
        let inner = null;
        let dialog = null;
        for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 30; node = node.parentElement, depth++) {
            const tag = node.tagName.toLowerCase();
            const role = node.getAttribute('role') || '';
            if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog' || node.getAttribute('aria-modal') === 'true') { dialog = node; break; }
            if (inner) continue;
            if (tag === 'li' || tag === 'article' || tag === 'tr' || role === 'listitem' || role === 'article' || role === 'row' || isRepeatedBlock(node)) {
                // Only a container that says a good deal more than the
                // control does: a card with a name and a price around an
                // "Add to cart", not a menu entry around its own link.
                const size = ((node.innerText || node.textContent || '') + '').trim().length;
                if (size >= own * 1.5 + 20 && size < 1500) inner = { kind: 'item', node };
                else if (repeated && size < 200) {
                    const flat = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const rest = flat(node.innerText).replace(repeated, '').replace(flat(el.innerText), '');
                    if (/[\p{L}\p{N}]/u.test(rest)) inner = { kind: 'item', node };
                }
            } else if (tag === 'fieldset' || role === 'radiogroup' || role === 'group') {
                if (nameOfContainer(node, 'group')) inner = { kind: 'group', node };
            } else if (tag === 'form' || role === 'form' || role === 'search') {
                inner = { kind: role === 'search' ? 'search' : 'form', node };
            } else if (tag === 'nav' || role === 'navigation') {
                inner = { kind: 'navigation', node };
            } else if (tag === 'footer' || role === 'contentinfo') {
                if (!node.closest('article, section, li')) inner = { kind: 'footer', node };
            } else if (tag === 'aside' || role === 'complementary') {
                inner = { kind: 'sidebar', node };
            }
        }
        const label = (g) => { const n = nameOfContainer(g.node, g.kind); return n ? `${g.kind} "${n}"` : g.kind; };
        // A layer found by where it sits, with no dialog markup of its own.
        const layer = dialog ? null : overlayOf(el);
        if (layer) {
            const what = layer.where === 'middle' ? 'dialog' : `bar at the ${layer.where} of the window`;
            return { key: groupKey(layer.node), kind: 'dialog', label: layer.name ? `${what} "${layer.name}"` : what };
        }
        if (dialog && inner) return { key: groupKey(inner.node), kind: inner.kind, label: `${label({ kind: 'dialog', node: dialog })} > ${label(inner)}` };
        if (dialog) return { key: groupKey(dialog), kind: 'dialog', label: label({ kind: 'dialog', node: dialog }) };
        // Items side by side in one list share its key, so a run of them can be told.
        if (inner) return { key: groupKey(inner.node), kind: inner.kind, label: label(inner), list: inner.kind === 'item' && inner.node.parentElement ? groupKey(inner.node.parentElement) : null };
        return null;
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

        // Content-editable: only the editable box itself is a control. Every
        // span inside it (each highlighted token in a code editor) used to be
        // listed as its own element.
        if (el.isContentEditable) {
            const parent = el.parentElement;
            return !(parent && parent.isContentEditable);
        }

        // Native interactive controls
        // A disabled control is still listed (marked disabled): "Continue"
        // greyed out until a box is ticked is something the agent must see.
        if (INTERACTIVE_TAGS.has(tagName)) {
            if (tagName === 'input' && el.type === 'hidden') return false;
            return true;
        }

        // ARIA interactive roles
        if (role && INTERACTIVE_ROLES.has(role)) return true;

        // A row of the list that typing in a field brought up is a choice,
        // whatever it is made of.
        if (offeredRows.has(el)) return true;

        // Elements with tabindex (not -1) are keyboard-focusable by author intent
        if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;

        // A thing the page lets be dragged is a thing to act on.
        if (el.getAttribute('draggable') === 'true') return true;

        // Clickable via cursor style: the outermost node the pointer hand
        // starts on. When that node is only a row of short separate labels
        // ("Reply" beside "Forward"), each label is the thing to press.
        try {
            const style = window.getComputedStyle(el);
            const parent = el.parentElement;
            if (style.cursor === 'pointer' && parent) {
                const outermost = (n) => !n.parentElement || window.getComputedStyle(n.parentElement).cursor !== 'pointer';
                if (outermost(el)) return !isRowOfLabels(el);
                if (window.getComputedStyle(parent).cursor === 'pointer' && outermost(parent) && isRowOfLabels(parent)) return true;
            }
            // A hand that grips, or arrows that move: the outermost thing
            // the page says can be picked up and moved (a row of a list to
            // reorder). A whole region with that pointer (a map) is a place
            // to drag across, not one thing.
            if ((style.cursor === 'grab' || style.cursor === 'move') && parent && window.getComputedStyle(parent).cursor !== style.cursor) {
                const r = el.getBoundingClientRect();
                if (r.width * r.height < (window.innerWidth || 1) * (window.innerHeight || 1) * 0.25) return true;
            }
        } catch (_) { /* computed style can throw on detached nodes */ }

        // The page shows the pointer hand over it only while the mouse is there.
        if (hoverPointers().has(el)) return true;

        // Inline onclick handler
        if (el.onclick || typeof el.onclick === 'function') return true;

        return false;
    }

    /** A box with no words of its own that holds a few short labels side by side. */
    function isRowOfLabels(el) {
        const kids = Array.from(el.children);
        if (kids.length < 2 || kids.length > 8) return false;
        for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) return false;
        return kids.every((k) => { const t = (k.innerText || '').trim(); return t && t.length <= 30 && !k.children.length; });
    }

    /**
     * The elements a stylesheet gives the pointer hand only on hover. Their
     * computed cursor says nothing until the mouse is over them, so the
     * rules are read instead. Worked out once per pass over the page.
     */
    let hoverPointerCache = { at: 0, set: new Set() };
    function hoverPointers() {
        if (Date.now() - hoverPointerCache.at < 400) return hoverPointerCache.set;
        const set = new Set();
        let rulesRead = 0;
        const read = (rules) => {
            for (const rule of rules) {
                if (++rulesRead > 6000) return;
                if (rule.cssRules && !rule.selectorText) { try { read(rule.cssRules); } catch (_) { /* skip */ } continue; }
                if (!rule.selectorText || rule.selectorText.indexOf(':hover') < 0 || !rule.style || rule.style.cursor !== 'pointer') continue;
                for (const part of rule.selectorText.split(',')) {
                    if (part.indexOf(':hover') < 0) continue;
                    const sel = part.replace(/:hover/g, '').trim();
                    if (!sel || sel === '*') continue;
                    try { document.querySelectorAll(sel).forEach((n) => { if (set.size < 400) set.add(n); }); } catch (_) { /* not a selector on its own */ }
                }
            }
        };
        for (const sheet of Array.from(document.styleSheets)) {
            // A sheet from another site cannot be read.
            try { read(sheet.cssRules); } catch (_) { /* skip */ }
        }
        hoverPointerCache = { at: Date.now(), set };
        return set;
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
                    el.getAttribute('draggable') === 'true' ||
                    el.isContentEditable ||
                    offeredRows.has(el) ||
                    hoverPointers().has(el)
                ) {
                    list.push(el);
                } else {
                    try {
                        // Off-screen nodes can never be listed (visibility
                        // is viewport-bound), so skip their style lookup.
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && r.bottom > -100 && r.top < (window.innerHeight || 0) + 100) {
                            const style = window.getComputedStyle(el);
                            if (style && (style.cursor === 'pointer' || style.cursor === 'grab' || style.cursor === 'move')) {
                                list.push(el);
                            }
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
     * Fallback stable-id allocator used when the shared agentTools module is
     * not available in this page. Mirrors
     * SELECT_TO_AI_TOOLS.assignStableElementIds.
     */
    function fallbackAssignStableIds(previousIds, startId) {
        let counter = Number.isInteger(startId) && startId > 0 ? startId : 1;
        const used = new Set();
        const ids = previousIds.map((prev) => {
            if (Number.isInteger(prev) && prev >= 1 && prev < counter && !used.has(prev)) {
                used.add(prev);
                return prev;
            }
            while (used.has(counter)) counter++;
            const id = counter;
            used.add(id);
            counter++;
            return id;
        });
        return { ids, nextId: counter };
    }

    /**
     * Scans the page for visible interactive elements, assigns STABLE ids
     * (reused across scans within this page), renders badges, and returns a
     * structured list for the LLM in DOM/reading order.
     * @param {number} [limit=80] - Max elements to include (top by score).
     * @returns {Array<Object>} List of element descriptors.
     */
    // Scans on this page so far: an element first numbered after the first
    // scan appeared since the agent last looked (a menu, suggestions, an error).
    let scanCount = 0;
    // Controls the agent asked for with find: listed on every scan while
    // they stay on the page.
    const pinnedElements = new Set();
    // What the last scan left out and what it learned about the page's
    // forms, returned with the scan.
    let lastScanExtras = { hiddenControls: { above: 0, below: 0 }, forms: [] };
    // The numbers in the listing as it was last made.
    let lastListed = new Set();
    // Off-screen controls that make the list: those the task names, those
    // that complete a form already on screen, and those found with find.
    const FAR_LIMIT = 20;

    /** The words a person would use for a control. Never what was typed into it. */
    function labelOf(el) {
        const isField = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(button|submit|reset)$/.test((el.type || '').toLowerCase()));
        const own = isField ? "" : (el.textContent || el.value || "");
        return `${own} ${accessibleName(el)} ${el.placeholder || ""} ${el.title || ""}`.replace(/\s+/g, ' ').trim();
    }

    /**
     * Finds controls anywhere on the page whose label has the given words,
     * and keeps them in the element list from the next scan on.
     */
    function findControls(query) {
        const words = String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
        const literal = String(query || "").trim().toLowerCase();
        if (!literal) return [];
        if (!words.length) {
            // Nothing in it is a word ("+", "$"): it is looked for as written.
            const hit = collectElementsRecursively(document).filter((el) => isElementInteractive(el) && labelOf(el).toLowerCase().includes(literal) && isShown(el));
            const best = (hit.length ? hit.sort((x, y) => labelOf(x).length - labelOf(y).length) : textPieces(literal)).slice(0, 8);
            best.forEach((el) => pinnedElements.add(el));
            lastFound = best;
            lastFoundAll = best.length > 0;
            return best.map((el) => labelOf(el).slice(0, 60));
        }
        const matches = [];
        collectElementsRecursively(document).forEach((el, order) => {
            if (el.tagName === 'OPTION' && el.closest('select')) return;
            if (!isElementInteractive(el)) return;
            const hay = labelOf(el).toLowerCase();
            if (!hay) return;
            // Whole words, or their beginnings: "men" is not in "improvement".
            const tokens = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
            const hits = words.filter((w) => tokens.some((t) => t === w || (w.length >= 3 && t.startsWith(w)))).length;
            if (!hits || !isShown(el)) return;
            if (el.tagName === 'LABEL' && el.control && !isRendered(el.control) && isDrawnOver(el.control)) return;
            matches.push({ el, hits, order, exact: hits === words.length });
        });
        // Every word beats some words; then the shortest label (the control
        // itself, not a block that happens to contain it); then page order.
        matches.sort((a, b) => b.hits - a.hits || labelOf(a.el).length - labelOf(b.el).length || a.order - b.order);
        let best = matches.length ? matches.filter((m) => m.hits === matches[0].hits).slice(0, 8) : [];
        // No control carries all the words. A short piece of the page's
        // text that reads exactly so can still be pressed, as a person
        // presses words they see: it is given a number too.
        if (!best.length || !best[0].exact) {
            const pieces = textPieces(literal).slice(0, 8).map((el) => ({ el, exact: true }));
            if (pieces.length) best = pieces;
        }
        best.forEach((m) => pinnedElements.add(m.el));
        lastFound = best.map((m) => m.el);
        // Whether the controls found carry every word asked for, or only some.
        lastFoundAll = best.length > 0 && best[0].exact;
        return best.map((m) => labelOf(m.el).slice(0, 60));
    }
    /**
     * The smallest drawn pieces of the page whose own text has these
     * characters and that no control already covers. They join the listing.
     */
    function textPieces(literal) {
        const found = [];
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n && found.length < 24; n = walker.nextNode()) {
                if (!n.data || !n.data.toLowerCase().includes(literal)) continue;
                const el = n.parentElement;
                if (!el || found.includes(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
                if ((el.innerText || '').trim().length > 80 || !isRendered(el) || !isShown(el)) continue;
                if (el.closest('a[href], button, [role="button"], [role="link"], label, select, textarea')) continue;
                offeredRows.add(el);
                found.push(el);
            }
        } catch (_) { /* no text to walk */ }
        return found;
    }
    let lastFoundAll = false;
    // The controls the last find brought in, so they can be given back with their numbers.
    let lastFound = [];
    let lastScanRequest = null;
    // Found controls are marked as new in the next listing the model sees.
    const justFound = new Set();
    // Elements the browser has already been asked about, for a listener.
    const listenerAsked = new WeakSet();
    let listenerPicked = [];
    // What the agent's own action made a thing to press: rows of a list
    // that typing in a field brought up, pieces of text that find located.
    const offeredRows = new WeakSet();

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.whole]  list the whole page's controls, not the
     *   part near the screen: every field, button and menu wherever it is,
     *   and the links nearest the screen up to the limit. Nothing is drawn
     *   on the page.
     */
    function scanInteractiveElements(limit = 80, task = "", opts = {}) {
        const whole = !!opts.whole;
        ensureContainers();
        try { overlayLayers = findOverlays(); } catch (_) { overlayLayers = []; }
        const keywords =
            typeof SELECT_TO_AI_TOOLS !== "undefined" && SELECT_TO_AI_TOOLS.taskKeywords
                ? SELECT_TO_AI_TOOLS.taskKeywords(task)
                : [];

        // Prune detached elements from the persistent map; keep the rest so
        // ids stay stable across scans on the same page.
        Object.keys(elementMap).forEach((key) => {
            if (!elementMap[key] || !elementMap[key].isConnected) delete elementMap[key];
        });

        const resultList = [];
        const candidates = collectElementsRecursively(document);
        const elementLimit = Math.max(10, Math.min(parseInt(limit, 10) || 80, whole ? 600 : 150));

        pinnedElements.forEach((el) => { if (!el.isConnected) pinnedElements.delete(el); });
        const hiddenControls = { above: 0, below: 0 };
        // Forms with a control on screen: the rest of such a form (the fields
        // and the submit button below the fold) belongs in the list too.
        const formsOnScreen = new Set();
        candidates.forEach((el) => {
            if (!el.form) return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && placeOf(r).where === 'screen') formsOnScreen.add(el.form);
        });

        // Phase 1: Semantic Scoring (order index preserves document order;
        // collectElementsRecursively walks the DOM, splicing shadow content
        // in right after its host).
        let scoredCandidates = [];
        candidates.forEach((el, order) => {
            // A native <select>'s options are chosen through the select itself.
            if (el.tagName === 'OPTION' && el.closest('select')) return;
            if (!isElementInteractive(el)) return;
            const place = placeOf(el.getBoundingClientRect());
            if (place.where === 'side') return;
            let far = false;
            if (place.where !== 'screen' && whole) {
                far = true;
            } else if (place.where !== 'screen') {
                const hay = keywords.length ? labelOf(el).toLowerCase() : "";
                const wanted = pinnedElements.has(el)
                    || (el.form && formsOnScreen.has(el.form))
                    || (hay && keywords.some((w) => hay.includes(w)));
                if (!wanted) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) hiddenControls[place.where]++;
                    return;
                }
                far = true;
            }
            if (!isShown(el)) return;
            // A label whose control is listed itself: the control's line
            // carries the label's words and the state, so the label is not
            // listed a second time.
            if (el.tagName === 'LABEL' && el.control && !isRendered(el.control) && isDrawnOver(el.control)) return;

            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || el.value || "").trim();
            const type = (el.type || "").toLowerCase();
            const role = el.getAttribute('role') || "";
            let score = 0;

            // Footnote markers ("[7]", "^", "12") are reference noise. They
            // are raised above the line or point at a note on this page; a
            // bare number that goes somewhere else is a page of results.
            if (tag === 'a' && /^(?:\[\s*[\w\d]{1,4}\s*\]|\^|\d{1,3})$/.test(text)) {
                const to = el.getAttribute('href') || '';
                const note = to.length > 1 && to.startsWith('#') && (() => { try { const n = decodeURIComponent(to.slice(1)); return !!(document.getElementById(n) || document.getElementsByName(n).length); } catch (_) { return false; } })();
                // A bare "#" is a button written as a link: the 7 of a calendar is one.
                if (el.closest('sup') || note) return;
            }
            // Links to a spot on this same page (tables of contents, "back to
            // top") scroll rather than navigate, and repeat the outline the
            // model already has: they fill only leftover space.
            if (tag === 'a') {
                const raw = el.getAttribute('href') || '';
                // Only a link to a named spot that exists on this page. A
                // bare "#" (or a fragment nothing answers to) is how pages
                // write a button as a link: it does something when pressed.
                const spotExists = (hash) => {
                    const name = decodeURIComponent(String(hash || '').replace(/^#/, ''));
                    if (!name || name.startsWith('!') || name.startsWith('/')) return false;
                    try { return !!(document.getElementById(name) || document.getElementsByName(name).length); } catch (_) { return false; }
                };
                let samePage = raw.startsWith('#') && spotExists(raw);
                if (!samePage && !raw.startsWith('#') && el.hash) {
                    try { const u = new URL(el.href); samePage = u.origin === location.origin && u.pathname === location.pathname && u.search === location.search && spotExists(u.hash); } catch (_) { /* ignore */ }
                }
                // A whole-page listing has no room for a table of contents:
                // the outline and read reach those sections.
                if (samePage && whole && !pinnedElements.has(el)) return;
                if (samePage) score -= 70;
            }

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

            // What a person would look at first: what is on screen, then what
            // is near it. Far-away controls only make the list when they
            // match the task (a "Checkout" button three screens down).
            const rect = el.getBoundingClientRect();
            const vh = window.innerHeight || 800;
            const distance = rect.bottom < 0 ? -rect.bottom : rect.top > vh ? rect.top - vh : 0;
            if (distance === 0) score += 60;
            else if (distance < vh) score += 25;
            else if (distance > vh * 2) score -= 40;
            if (keywords.length) {
                const hay = `${text} ${el.getAttribute('aria-label') || ""} ${el.placeholder || ""} ${el.title || ""}`.toLowerCase();
                let hits = 0;
                for (const w of keywords) if (hay.includes(w)) hits++;
                score += Math.min(hits, 3) * 45;
            }

            if (el.disabled || el.getAttribute('aria-disabled') === 'true') score -= 30;
            if (pinnedElements.has(el)) score += 500;
            if (whole) {
                // By what a control is and where it is, never by the task's
                // words: fields, buttons and menus come first wherever they
                // are; links fill what is left, nearest the screen first.
                score = (tag === 'a' ? 0 : 1000) - Math.min(900, distance / 10) + (pinnedElements.has(el) ? 5000 : 0);
            }

            scoredCandidates.push({ el, score, order, far, where: place.where });
        });

        // Phase 2: Select the top-N by score, then SERIALIZE in document
        // (reading) order so the model sees the page the way a person does.
        scoredCandidates.sort((a, b) => b.score - a.score);
        // The same label to the same place twice adds nothing: keep the best.
        const seenKeys = new Set();
        scoredCandidates = scoredCandidates.filter((c) => {
            const label = (c.el.getAttribute('aria-label') || c.el.textContent || c.el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const key = `${c.el.tagName}|${label}|${c.el.getAttribute('href') || ''}`;
            if (!label || c.el.tagName !== 'A') return true;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
        });
        let samePageKept = 0;
        let farKept = 0;
        const kept = [];
        scoredCandidates.forEach((c) => {
            let keep = kept.length < elementLimit;
            const href = c.el.tagName === 'A' ? String(c.el.getAttribute('href') || '').trim() : '';
            // A bare "#" goes nowhere: it is a button written as a link (the
            // days of a calendar), not a link to a spot on the page.
            if (keep && href !== '#' && (href.startsWith('#') || (c.el.tagName === 'A' && c.el.hash && c.el.pathname === location.pathname && c.el.origin === location.origin))) {
                samePageKept++;
                keep = samePageKept <= 8;
            }
            if (keep && c.far && !pinnedElements.has(c.el) && !whole) {
                farKept++;
                keep = farKept <= FAR_LIMIT;
            }
            if (keep) kept.push(c);
            // Whatever did not fit is still there: count it so the agent
            // knows to scroll or to look for it with find.
            else if (c.where === 'above' || c.where === 'below') hiddenControls[c.where]++;
            else hiddenControls.below++;
        });
        const topCandidates = kept;
        topCandidates.sort((a, b) => a.order - b.order);

        const formIndex = new Map();
        const forms = [];
        const formIdOf = (form) => {
            if (!form) return undefined;
            if (!formIndex.has(form)) {
                formIndex.set(form, forms.length);
                forms.push({ id: forms.length, ...describeForm(form) });
            }
            return formIndex.get(form);
        };

        // Phase 3: Stable ID assignment, reuse the id already stamped on a
        // still-present element; allocate new ids monotonically.
        const previousIds = topCandidates.map((candidate) => {
            const stamped = idOf(candidate.el);
            return Number.isInteger(stamped) ? stamped : null;
        });
        const allocator =
            typeof SELECT_TO_AI_TOOLS !== "undefined" && SELECT_TO_AI_TOOLS.assignStableElementIds
                ? SELECT_TO_AI_TOOLS.assignStableElementIds
                : fallbackAssignStableIds;
        const allocation = allocator(previousIds, nextElementId);
        nextElementId = allocation.nextId;

        // Phase 4: Badging & serialization
        const fragment = document.createDocumentFragment();

        // What each control is called and the words drawn on it. innerText
        // is what is drawn, where the node has one (an SVG has not): words
        // inside a closed menu are not the control's.
        const named = topCandidates.map(({ el }) => {
            const secret = sensitiveKind(el);
            const drawn = typeof el.innerText === 'string' ? el.innerText : el.textContent;
            const text = (el.tagName === 'SELECT' || secret ? '' : (drawn || el.value || ""))
                .replace(/\s+/g, " ").trim().substring(0, 80);
            const accName = accessibleName(el);
            const label = el.getAttribute('aria-label') || "";
            return { secret, text, accName, key: (accName || label || text || el.placeholder || el.title || '').replace(/\s+/g, ' ').trim().toLowerCase() };
        });
        // Labels that more than one listed control carries.
        const labelCount = new Map();
        // What is read about a box around a control, once per box (inPickedValues).
        const fieldFacts = new Map();
        for (const n of named) if (n.key) labelCount.set(n.key, (labelCount.get(n.key) || 0) + 1);

        let deepFocus = document.activeElement;
        while (deepFocus && deepFocus.shadowRoot && deepFocus.shadowRoot.activeElement) deepFocus = deepFocus.shadowRoot.activeElement;
        topCandidates.forEach((candidate, index) => {
            const el = candidate.el;
            const id = allocation.ids[index];
            elementMap[id] = el;
            elementIds.set(el, id);

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
            const { secret, text, accName, key: nameKey } = named[index];
            badge.title = `${tag.toUpperCase()}: "${text}"`;

            if (!whole) fragment.appendChild(badge);

            let type = tag;
            if (tag === 'input') type = (el.type || 'text') + '-input';

            const viewportH = window.innerHeight || document.documentElement.clientHeight;
            let position = "in-viewport";
            if (rect.bottom < 0) position = "above-fold";
            else if (rect.top > viewportH) position = "below-fold";

            const entry = {
                id,
                isNew: (scanCount > 0 && previousIds[index] === null) || justFound.has(el),
                tagName: tag,
                type,
                inputType: tag === 'input' ? (el.type || 'text').toLowerCase() : undefined,
                accName,
                text,
                placeholder: el.placeholder || "",
                name: el.name || "",
                title: el.title || "",
                label: el.getAttribute('aria-label') || "",
                role: el.getAttribute('role') || "",
                value: el.value || "",
                isContentEditable: el.isContentEditable || false,
                rect: {
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                },
                position,
            };
            if (pinnedElements.has(el)) entry.pinned = true;
            if (el.readOnly && (tag === 'input' || tag === 'textarea')) entry.readOnly = true;
            // A control with no words at all (an icon) is still called
            // something by its page: its class and id, the icon inside it,
            // the picture's file. Those are given as they are, with its
            // colour and where its middle is on the page, which tell it
            // apart from others like it.
            if (!entry.accName && !entry.text && !entry.placeholder && !entry.title && !entry.label && !entry.name) {
                const marks = markingsOf(el);
                if (marks) entry.marked = marks;
                // A text box, a list or a text area is painted the way the
                // browser paints them all: that colour says nothing about it.
                const colour = tag === 'input' || tag === 'select' || tag === 'textarea' ? '' : colourOf(el);
                if (colour) entry.colour = colour;
                entry.at = { x: Math.round(absoluteX + rect.width / 2), y: Math.round(absoluteY + rect.height / 2) };
            }
            // What a field says it is for, in the page's own words: the
            // standard autocomplete name, and its id as a last hint.
            const ac = el.getAttribute('autocomplete');
            if (ac) entry.autocomplete = ac.toLowerCase().slice(0, 60);
            if (el.id && (tag === 'input' || tag === 'select' || tag === 'textarea')) entry.htmlId = String(el.id).slice(0, 40);

            // A secret field's value stays on the page: the agent is told
            // only that the field exists and whether it is filled.
            if (secret) {
                entry.sensitive = secret;
                entry.filled = !!el.value;
                entry.value = "";
            }
            if (overlayOf(el)) entry.onTop = true;
            if (inPickedValues(el, fieldFacts)) entry.inField = true;
            // The control the keyboard is on, where a key with no ref lands.
            if (el === deepFocus) entry.focused = true;
            const group = groupOf(el, nameKey && labelCount.get(nameKey) > 1 ? nameKey : '');
            if (group) {
                entry.groupKey = group.key;
                entry.groupKind = group.kind;
                entry.group = group.label;
                if (group.list) entry.groupList = group.list;
            }
            const ownForm = el.form || (tag === 'button' || tag === 'input' ? el.closest('form') : null);
            if (ownForm) {
                entry.formId = formIdOf(ownForm);
                // The control that sends the form: a submit button, or a
                // button with no type (submit is the default inside a form).
                if ((tag === 'button' || tag === 'input') && /^(submit|image)$/.test((el.type || '').toLowerCase())) entry.submits = true;
            }
            if (tag === 'input') {
                const kind = (el.type || 'text').toLowerCase();
                // What a date or time box accepts when typed into.
                const formats = { date: 'YYYY-MM-DD', time: 'HH:MM', month: 'YYYY-MM', week: 'YYYY-Www', 'datetime-local': 'YYYY-MM-DDTHH:MM' };
                if (formats[kind]) entry.format = formats[kind];
                if (kind === 'number' || kind === 'range' || formats[kind]) {
                    if (el.min !== '') entry.min = el.min;
                    if (el.max !== '') entry.max = el.max;
                }
                if (el.maxLength > 0 && el.maxLength < 100) entry.maxLength = el.maxLength;
            }

            if (tag === 'a' && el.href) {
                entry.href = shortHref(el.href);
                // The full address, never shown to the model: it records
                // which addresses the agent has really seen on a page.
                if (/^https?:/.test(el.href)) entry.url = String(el.href).slice(0, 400);
            }
            if (tag === 'select') {
                const opts = Array.from(el.options || []);
                entry.selected = opts[el.selectedIndex] ? opts[el.selectedIndex].text.trim() : "";
                entry.options = opts.map((o) => o.text.trim()).filter(Boolean).slice(0, 12);
                if (opts.length > 12) entry.options.push(`+${opts.length - 12} more`);
            }
            if (typeof el.checked === 'boolean') entry.checked = el.checked;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
            if (el.required || el.getAttribute('aria-required') === 'true') entry.required = true;

            const ariaExpanded = el.getAttribute('aria-expanded');
            if (ariaExpanded !== null) {
                entry.ariaExpanded = ariaExpanded;
                entry.expanded = ariaExpanded;
            }

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

        lastScanExtras = { hiddenControls, forms };
        lastListed = new Set(resultList.map((e) => e.id));
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

    /** The middle of an element's box, in this frame's viewport. */
    function centreOf(el) {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    /**
     * The fields of a pointer or mouse event made by script, as Chrome
     * fills them for a real mouse: it crosses shadow boundaries (composed),
     * it is the primary mouse pointer, and it says which button is held and
     * how hard. Clicks, hovers and drags all take their fields from here,
     * so a page sees the same pointer whichever of them it is.
     * @param {{x: number, y: number}} point  in this frame's viewport
     * @param {{held?: boolean, button?: number, detail?: number, related?: Element|null, modifiers?: Object}} [o]
     */
    function pointerInit(point, o = {}) {
        const keys = o.modifiers || {};
        const button = o.button || 0;
        return {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            screenX: window.screenX + point.x,
            screenY: window.screenY + point.y,
            button,
            buttons: o.held ? (button === 2 ? 2 : 1) : 0,
            detail: o.detail || 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            pressure: o.held ? 0.5 : 0,
            relatedTarget: o.related || null,
            ctrlKey: !!keys.ctrlKey,
            shiftKey: !!keys.shiftKey,
            altKey: !!keys.altKey,
            metaKey: !!keys.metaKey,
        };
    }

    // What the scripted pointer was last over, so its next move leaves it as a mouse would.
    let pointerOver = null;

    /**
     * Moves the scripted pointer onto `target`. What it was over hears it
     * go, the target hears it arrive, and every box around either whose
     * edge it crossed hears it leave or enter, as with a mouse: a menu that
     * closes when the pointer leaves it closes, and a box that listens for
     * the pointer entering it is told. Nothing is sent when the pointer is
     * already there, unless `again` asks for the arrival to be said again.
     */
    function movePointerTo(target, point, modifiers, again) {
        const prev = pointerOver && pointerOver.isConnected && pointerOver !== target ? pointerOver : null;
        const fresh = pointerOver !== target;
        pointerOver = target;
        if (!fresh && !again) return;
        const holds = (box, n) => { for (let x = n; x; x = upOf(x)) if (x === box) return true; return false; };
        const quiet = (init) => ({ ...init, bubbles: false, cancelable: false });
        if (prev) {
            const out = pointerInit(point, { modifiers, related: target });
            prev.dispatchEvent(new PointerEvent('pointerout', out));
            prev.dispatchEvent(new MouseEvent('mouseout', out));
            for (let n = prev; n && n.nodeType === 1 && !holds(n, target); n = upOf(n)) {
                n.dispatchEvent(new PointerEvent('pointerleave', quiet(out)));
                n.dispatchEvent(new MouseEvent('mouseleave', quiet(out)));
            }
        }
        const over = pointerInit(point, { modifiers, related: prev });
        target.dispatchEvent(new PointerEvent('pointerover', over));
        target.dispatchEvent(new MouseEvent('mouseover', over));
        // Outermost first, as the browser enters them.
        const entered = [];
        for (let n = target; n && n.nodeType === 1 && !(prev && holds(n, prev)); n = upOf(n)) entered.unshift(n);
        for (const n of entered) {
            n.dispatchEvent(new PointerEvent('pointerenter', quiet(over)));
            n.dispatchEvent(new MouseEvent('mouseenter', quiet(over)));
        }
    }

    /**
     * Where a pointer's events start: the innermost thing drawn at the
     * point, when that is inside the control. A page may listen on a part
     * inside the control (the link inside a tab), so the events start where
     * a press at that point would and travel up from there.
     */
    function pointerTargetIn(control, point) {
        try {
            const hit = document.elementFromPoint(point.x, point.y);
            if (hit && hit !== control && control.contains(hit)) return hit;
        } catch (_) { /* a detached control has no point */ }
        return control;
    }

    /**
     * A click made by script, as a mouse makes one: the pointer arrives,
     * presses, lets go, and the click follows. `point` is where, for a
     * press at a given point of the page (click_at); the control's middle
     * otherwise. `detail` is which click of a run this is (2 for the second
     * of a double click). Returns false when the page cancelled the click.
     */
    function dispatchClickEvents(control, modifiers = {}, point = null, detail = 1) {
        const at = point || centreOf(control);
        const targetEl = pointerTargetIn(control, at);
        movePointerTo(targetEl, at, modifiers);
        const idle = pointerInit(at, { modifiers });
        targetEl.dispatchEvent(new PointerEvent('pointermove', idle));
        targetEl.dispatchEvent(new MouseEvent('mousemove', idle));

        const down = pointerInit(at, { modifiers, held: true, detail });
        targetEl.dispatchEvent(new PointerEvent('pointerdown', { ...down, detail: 0 }));
        // A page that cancels mousedown keeps the focus and the selection
        // where they are (the toolbar of a text editor does), so the focus
        // moves only when the press was left to the browser.
        if (targetEl.dispatchEvent(new MouseEvent('mousedown', down))) focusField(control);

        const up = pointerInit(at, { modifiers, detail });
        targetEl.dispatchEvent(new PointerEvent('pointerup', { ...up, detail: 0 }));
        targetEl.dispatchEvent(new MouseEvent('mouseup', up));
        // The browser itself sends the change of a box the click ticks; a
        // second one made here would run the page's handler twice.
        return targetEl.dispatchEvent(new PointerEvent('click', up));
    }

    /**
     * Moves the scripted pointer over a control without pressing: the
     * events start at what is drawn at the control's middle, as for a click.
     */
    function dispatchHoverEvents(control, modifiers = {}) {
        const at = centreOf(control);
        const targetEl = pointerTargetIn(control, at);
        movePointerTo(targetEl, at, modifiers, true);
        const idle = pointerInit(at, { modifiers });
        targetEl.dispatchEvent(new PointerEvent('pointermove', idle));
        targetEl.dispatchEvent(new MouseEvent('mousemove', idle));
    }

    // =========================================================================
    // The real pointer
    // =========================================================================
    //
    // Clicks, hovers, drags and presses at a point are made with the real
    // pointer where the engine has the debugger connection: the browser
    // moves its own mouse, so CSS :hover, pointer capture, drag and drop and
    // pages that ignore events made by a script all behave as for a person.
    // Points here are in this frame's own CSS pixels; the engine places
    // them in the window. Where the connection cannot be had, the events
    // are made by script, as before, and the result says which it was.

    const POINTER_TOOLS = typeof SELECT_TO_AI_TOOLS !== 'undefined' && SELECT_TO_AI_TOOLS.dragSteps ? SELECT_TO_AI_TOOLS : null;
    // When the engine last gave no answer about the pointer, events made by
    // a script are used for a while instead of waiting on it every time.
    let realPointerQuietUntil = 0;
    // How long the engine has to start a gesture before the page stops
    // waiting for it. A gesture not started by then is not started at all,
    // so it cannot follow the scripted events used instead.
    const POINTER_WAIT_MS = 8000;

    /**
     * Asks the engine to move the real pointer along `steps`. Resolves
     * { ok, sent, covered }: ok when the whole gesture ran, sent how many
     * events went before it stopped, covered what the main page draws over
     * this frame at a point aimed at (for a frame only).
     */
    function realPointer(steps, drag) {
        const none = { ok: false, sent: 0 };
        if (!POINTER_TOOLS || Date.now() < realPointerQuietUntil) return Promise.resolve(none);
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v && typeof v === 'object' ? v : none); } };
            try {
                const sent = chrome.runtime.sendMessage({ action: 'agentPointer', steps, drag: !!drag, inner: window.innerWidth, startBy: Date.now() + POINTER_WAIT_MS }, (r) => {
                    void chrome.runtime.lastError;
                    done(r);
                });
                if (sent && typeof sent.then === 'function') sent.then(done, () => done(none));
                // The gesture itself takes about a second; the wait covers it and the start.
                setTimeout(() => { if (!settled) realPointerQuietUntil = Date.now() + 60000; done(none); }, POINTER_WAIT_MS + 4000);
            } catch (_) { done(none); }
        });
    }

    /** The control element that owns a node: up through parents and shadow hosts. */
    const upOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

    /** The nearest listed control at or around a node, or null. */
    function numberedOf(n) {
        for (let x = n; x; x = upOf(x)) if (idOf(x)) return x;
        return null;
    }

    /** The innermost element drawn at a point of this frame, past what the agent draws, through shadow roots. */
    function drawnAt(x, y) {
        let hit = null;
        for (const n of document.elementsFromPoint(x, y)) if (!agentDrawn(n)) { hit = n; break; }
        for (let depth = 0; hit && hit.shadowRoot && depth < 8; depth++) {
            const inner = (hit.shadowRoot.elementsFromPoint ? hit.shadowRoot.elementsFromPoint(x, y) : []).find((n) => n !== hit && !agentDrawn(n));
            if (!inner) break;
            hit = inner;
        }
        return hit;
    }

    /**
     * True when a press on `hit` is a press on `el`: inside it, on one of its
     * labels, or on what holds it when it takes no pointer itself.
     */
    function pressesOn(el, hit) {
        if (!hit || !el) return false;
        for (let n = hit; n; n = upOf(n)) if (n === el) return true;
        try {
            if (el.labels && Array.from(el.labels).some((l) => l.contains(hit))) return true;
            const label = hit.closest && hit.closest('label');
            if (label && label.control === el) return true;
            if (hit.contains(el) && getComputedStyle(el).pointerEvents === 'none') return true;
        } catch (_) { /* a detached node */ }
        return false;
    }

    /** What a person would call something drawn on the page, by its listing number when it has one. */
    function nameOfDrawn(n) {
        if (!n) return 'nothing';
        if (n.tagName === 'IFRAME') return `a frame${n.title ? ` "${n.title.slice(0, 40)}"` : ''}`;
        const numbered = numberedOf(n);
        if (numbered) return `[${idOf(numbered)}] "${labelOf(numbered).slice(0, 50)}"`;
        const words = String((n.getAttribute && n.getAttribute('aria-label')) || n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50);
        return `a ${String(n.tagName || 'box').toLowerCase()}${words ? ` "${words}"` : ' with no words'}`;
    }

    /**
     * The part of a node that can be seen: its box cut to the window and to
     * every box around it that clips what overflows it (a list that scrolls
     * inside the page, say). A control scrolled out of such a box is inside
     * the window but drawn nowhere.
     */
    function visibleRect(node) {
        const r = node.getBoundingClientRect();
        let left = Math.max(0, r.left), top = Math.max(0, r.top);
        let right = Math.min(window.innerWidth, r.right), bottom = Math.min(window.innerHeight, r.bottom);
        for (let n = upOf(node); n && n.nodeType === 1 && n !== document.documentElement && n !== document.body; n = upOf(n)) {
            let s;
            try { s = getComputedStyle(n); } catch (_) { break; }
            if (s.position === 'fixed') break;
            const clipsX = s.overflowX !== 'visible', clipsY = s.overflowY !== 'visible';
            if (!clipsX && !clipsY) continue;
            const b = n.getBoundingClientRect();
            if (clipsX) { left = Math.max(left, b.left + n.clientLeft); right = Math.min(right, b.left + n.clientLeft + n.clientWidth); }
            if (clipsY) { top = Math.max(top, b.top + n.clientTop); bottom = Math.min(bottom, b.top + n.clientTop + n.clientHeight); }
        }
        return { left, top, right, bottom, full: r };
    }

    /**
     * Scrolls a control to the middle of the window, and of any box it
     * scrolls inside, when part of it cannot be seen.
     */
    function bringIntoView(el) {
        const v = visibleRect(el);
        const r = v.full;
        const seen = Math.max(0, v.right - v.left) * Math.max(0, v.bottom - v.top);
        if (seen >= r.width * r.height - 1) return;
        try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (_) { el.scrollIntoView(); }
    }

    /**
     * Where a person would press a control: the middle of the part of it on
     * screen, or another spot of it that nothing covers. A control drawn too
     * small to press (a box the page hides to draw its own) is pressed by
     * its label. Returns { point, hit }, or { point: null, cover } when
     * something else covers every spot, or { point: null } when it is not on
     * screen at all.
     */
    function aimAt(el) {
        const spots = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
        // Only the page itself there: nothing is drawn over the control, it
        // is just not drawn at that point. That is no evidence of a cover.
        const bare = (n) => !n || n === document.documentElement || n === document.body;
        const tryOn = (node) => {
            // Aimed within the part that can be seen, not the whole box: a
            // box that scrolls inside the page cuts off the rest.
            const { left, top, right, bottom, full: r } = visibleRect(node);
            if (right - left < 1 || bottom - top < 1) return { point: null, small: true };
            let first;
            for (const [fx, fy] of spots) {
                // Whole pixels: what the page reads from the press is then the very point checked here.
                const x = Math.min(right - 0.5, Math.max(left, Math.round(left + (right - left) * fx)));
                const y = Math.min(bottom - 0.5, Math.max(top, Math.round(top + (bottom - top) * fy)));
                const hit = drawnAt(x, y);
                if (first === undefined && !bare(hit)) first = hit;
                if (pressesOn(el, hit)) return { point: { x, y }, hit };
            }
            return { point: null, ...(first !== undefined ? { cover: first } : {}), small: (r.width < 5 || r.height < 5) };
        };
        const own = tryOn(el);
        if (own.point || !own.small) return own;
        for (const label of Array.from(el.labels || [])) {
            const by = tryOn(label);
            if (by.point) return by;
        }
        return { point: null };
    }

    /**
     * The result when what was aimed at is covered: said, and nothing
     * pressed. No pointer was used, real or made by script, so the result
     * names none: the trace and the count of real presses leave it out.
     */
    function coveredResult(id, what, hovering) {
        const who = /^\d+$/.test(String(id)) ? `[${id}]` : String(id);
        return {
            success: false, covered: true,
            error: `${who} is covered: ${what} is drawn over it where it is on screen, so the ${hovering ? 'pointer' : 'press'} would reach that instead. Nothing was ${hovering ? 'moved over it' : 'pressed'}.`,
        };
    }

    /**
     * Before a press at a point or a drop: what is there now is what was
     * checked. The same listed control, a frame where a frame was checked,
     * or nothing listed where nothing was. `own` is a control whose own
     * spot it may be (the thing being dragged). Null when it is.
     */
    function unexpectedAt(hit, expect, what, own) {
        if (!expect) return null;
        const isFrame = !!(hit && hit.tagName === 'IFRAME');
        const n = isFrame ? null : numberedOf(hit);
        const now = n ? idOf(n) : null;
        const want = expect.ref === undefined || expect.ref === null ? null : Number(expect.ref);
        const same = expect.frame ? isFrame : !isFrame && (now === want || !!(own && n && (n === own || own.contains(n) || n.contains(own))));
        if (same) return null;
        return { success: false, error: `${what} is not what was checked before: ${nameOfDrawn(hit)} is there now${want !== null ? `, not [${want}]` : ''}. Nothing was pressed.` };
    }

    /**
     * Listens for the press the real pointer makes, to say where it landed,
     * and for the click it makes, to say whether the page took it over
     * (cancelled what the browser would have done).
     */
    function watchPress() {
        const got = { down: null, click: null };
        const on = (e) => { if (e.isTrusted && !got.down) got.down = { target: e.composedPath ? e.composedPath()[0] : e.target, x: e.clientX, y: e.clientY }; };
        const onClick = (e) => { if (e.isTrusted && !got.click) got.click = e; };
        window.addEventListener('pointerdown', on, true);
        window.addEventListener('mousedown', on, true);
        window.addEventListener('click', onClick, true);
        return { got, stop() { window.removeEventListener('pointerdown', on, true); window.removeEventListener('mousedown', on, true); window.removeEventListener('click', onClick, true); } };
    }

    /**
     * Moves the agent's cursor along a gesture as it happens, so the person
     * watching sees the pointer go where the real one goes.
     */
    async function followGesture(steps, label) {
        ensureAgentCursor();
        const was = agentCursor.style.transition;
        agentCursor.style.transition = 'transform 0.06s linear, opacity 0.2s ease';
        let holding = false;
        try {
            for (const s of steps) {
                if (s.t === 'wait') { await delay(s.ms || 0); continue; }
                if (s.t === 'down') holding = true;
                if (s.t === 'up') holding = false;
                placeAgentCursor(s.x, s.y, holding ? `${label}: holding` : label);
            }
        } finally { agentCursor.style.transition = was; }
    }

    /**
     * Runs a gesture with the real pointer, with the agent's cursor drawn
     * along it, and says what became of it: { real } when it ran, { real:
     * false } when the engine cannot move the pointer (nothing was sent),
     * or { fail } when it must not go on or stopped partway.
     */
    async function gesture(steps, { drag = false, label = 'Click', id = null, hovering = false } = {}) {
        const watch = watchPress();
        const [r] = await Promise.all([realPointer(steps, drag), document.visibilityState === 'hidden' ? null : followGesture(steps, label)]);
        watch.stop();
        if (r.covered) return { fail: coveredResult(id, r.covered, hovering) };
        if (!r.ok && !(r.sent > 0)) return { real: false };
        if (!r.ok) return { fail: { success: false, pointer: 'real', error: `The pointer stopped partway${r.error ? ` (${String(r.error).slice(0, 80)})` : ''}: the page may have had only part of it.` } };
        return { real: true, landed: watch.got.down, clicked: watch.got.click, dropped: !!r.dropped };
    }

    /**
     * A press (or a hover) on a control with the real pointer: brought on
     * screen, aimed where a person would press it, then move, a short rest,
     * press and let go. { real: true, note } when it ran; { real: false }
     * when the engine cannot move the pointer or the control is not drawn
     * on screen (the caller makes the events by script, as before); { fail }
     * when something else is drawn over it.
     */
    async function pointerOnControl(el, id, label, hovering) {
        if (!POINTER_TOOLS || Date.now() < realPointerQuietUntil) return { real: false };
        bringIntoView(el);
        const aim = aimAt(el);
        if (!aim.point) return aim.cover !== undefined ? { fail: coveredResult(id, nameOfDrawn(aim.cover), hovering) } : { real: false };
        const steps = hovering ? [{ t: 'move', x: aim.point.x, y: aim.point.y, aim: true }] : POINTER_TOOLS.clickSteps(aim.point);
        if (!hovering) agentCursor && agentCursor.classList.remove('clicking');
        const g = await gesture(steps, { label, id, hovering });
        if (!g.real) return g;
        if (!hovering && agentCursor) { agentCursor.classList.add('clicking'); }
        let note = '';
        if (!hovering && !g.landed) note = ' The page did not see the press arrive.';
        else if (!hovering && !pressesOn(el, g.landed.target)) note = ` The press landed on ${nameOfDrawn(g.landed.target)}, not on [${id}]: the page moved under it.`;
        return { real: true, note, clicked: g.clicked };
    }

    /** Where a node sits among its siblings, to say afterwards whether a drag moved it. */
    function placeOfNode(el) {
        const p = el && el.parentElement;
        return p ? { parent: p, index: Array.prototype.indexOf.call(p.children, el), count: p.children.length } : null;
    }

    const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

    /**
     * True when a person cannot scroll the window along this axis: the root
     * hides its overflow, or the body does and the root passes that on to
     * the window. A script still could, so this is asked before scrolling.
     */
    function windowHeld(vertical) {
        const overflow = (n) => { const o = window.getComputedStyle(n); return vertical ? o.overflowY : o.overflowX; };
        const html = document.documentElement;
        const body = document.body;
        return /hidden|clip/.test(overflow(html)) || (overflow(html) === 'visible' && !!body && /hidden|clip/.test(overflow(body)));
    }

    /**
     * The box a person would scroll when the window itself cannot move the
     * asked way: a box with its own scroll bar, with content larger than it,
     * that can still move that way and covers at least a quarter of the
     * screen. The one under the middle of the screen is preferred, then the
     * one taking the most of the screen. Null when the window can move, or
     * when no such box can.
     * @returns {{el: Element, what: string}|null}
     */
    function mainScrollBox(direction) {
        const dir = direction === 'bottom' ? 'down' : direction === 'top' ? 'up' : direction;
        const vertical = dir === 'down' || dir === 'up';
        if (!vertical && dir !== 'left' && dir !== 'right') return null;
        const canMove = (n) => dir === 'down' ? n.scrollTop + n.clientHeight < n.scrollHeight - 1
            : dir === 'up' ? n.scrollTop > 0
            : dir === 'right' ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1
            : n.scrollLeft > 0;
        const overflow = (n) => { const o = window.getComputedStyle(n); return vertical ? o.overflowY : o.overflowX; };
        const html = document.documentElement;
        const page = document.scrollingElement || html;
        const locked = windowHeld(vertical);
        if (!locked && canMove(page)) return null;
        const vw = window.innerWidth || html.clientWidth;
        const vh = window.innerHeight || html.clientHeight;
        const shown = (r) => Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const middle = document.elementFromPoint(vw / 2, vh / 2);
        let best = null;
        for (const n of document.querySelectorAll('body *')) {
            if (n.id === 'select-to-ai-overlay-container' || n.closest('#select-to-ai-overlay-container')) continue;
            if (vertical ? n.scrollHeight <= n.clientHeight + 4 : n.scrollWidth <= n.clientWidth + 4) continue;
            if (!/auto|scroll|overlay/.test(overflow(n)) || !canMove(n)) continue;
            const area = shown(n.getBoundingClientRect());
            if (area < vw * vh * 0.25) continue;
            const central = !!(middle && n.contains(middle));
            if (!best || central > best.central || (central === best.central && area > best.area)) best = { n, area, central };
        }
        if (!best) return null;
        const name = nameOfContainer(best.n, 'region');
        return { el: best.n, what: name ? `the part "${name}"` : 'the main part of the page' };
    }

    /** What a container is called: its listing number, its label, or its heading. */
    function nameOfPlace(box) {
        const numbered = numberedOf(box);
        if (numbered && numbered !== box.ownerDocument.body) return `[${idOf(numbered)}] "${labelOf(numbered).slice(0, 50)}"`;
        for (let n = box; n && n !== document.body; n = n.parentElement) {
            const named = n.getAttribute('aria-label') || (n.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"]') || {}).innerText;
            if (named && named.trim()) return `the part "${named.replace(/\s+/g, ' ').trim().slice(0, 50)}"`;
        }
        return 'another part of the page';
    }

    /**
     * A drag made by script, for when the real pointer cannot be had: the
     * pointer and mouse events at each point of the same gesture, and the
     * drag and drop events when what is dragged is draggable. A page that
     * captures the pointer or checks for a real one will not follow it.
     */
    async function syntheticDrag(el, steps) {
        let held = false;
        let source = null;
        let data = null;
        let over = null;
        const at = (s, buttons) => pointerInit(s, { held: buttons === 1 });
        const draggable = el.closest('[draggable="true"]') || (el.closest('a[href], img') && el.closest('[draggable="false"]') === null ? el.closest('a[href], img') : null);
        for (const s of steps) {
            if (s.t === 'wait') { await (document.visibilityState === 'hidden' ? Promise.resolve() : delay(s.ms || 0)); continue; }
            const target = drawnAt(s.x, s.y) || document.body;
            if (s.t === 'down') {
                target.dispatchEvent(new PointerEvent('pointerdown', at(s, 1)));
                target.dispatchEvent(new MouseEvent('mousedown', at(s, 1)));
                held = true;
            } else if (s.t === 'move') {
                if (held && draggable && !source) {
                    data = typeof DataTransfer === 'function' ? new DataTransfer() : null;
                    if (draggable.dispatchEvent(new DragEvent('dragstart', { ...at(s, 1), dataTransfer: data }))) source = draggable;
                }
                if (source) {
                    if (over !== target) { target.dispatchEvent(new DragEvent('dragenter', { ...at(s, 1), dataTransfer: data })); over = target; }
                    target.dispatchEvent(new DragEvent('dragover', { ...at(s, 1), dataTransfer: data }));
                } else {
                    target.dispatchEvent(new PointerEvent('pointermove', at(s, held ? 1 : 0)));
                    target.dispatchEvent(new MouseEvent('mousemove', at(s, held ? 1 : 0)));
                }
            } else if (s.t === 'up') {
                if (source) {
                    target.dispatchEvent(new DragEvent('drop', { ...at(s, 0), dataTransfer: data }));
                    source.dispatchEvent(new DragEvent('dragend', { ...at(s, 0), dataTransfer: data }));
                } else {
                    target.dispatchEvent(new PointerEvent('pointerup', at(s, 0)));
                    target.dispatchEvent(new MouseEvent('mouseup', at(s, 0)));
                }
                held = false;
            }
        }
    }

    // =========================================================================
    // Typing (per-character, framework-compatible)
    // =========================================================================

    /** True for a field that offers a list of choices while you type. */
    function offersChoices(el) {
        const role = el.getAttribute('role');
        const auto = el.getAttribute('aria-autocomplete');
        return role === 'combobox' || auto === 'list' || auto === 'both' || el.getAttribute('aria-haspopup') === 'listbox';
    }

    /** True for a field whose Enter runs a search on what was typed. */
    function isSearchField(el) {
        if ((el.type || '').toLowerCase() === 'search' || el.getAttribute('role') === 'searchbox') return true;
        const form = el.form || el.closest('form, [role="search"]');
        if (!form) return false;
        const region = form.getAttribute('role') === 'search' ? form : form.closest('[role="search"]');
        if (!region && !(form.tagName === 'FORM' && describeForm(form).search)) return false;
        // One box that takes the words: Enter searches them. A search made
        // of several fields (from, to, dates) is a form like any other, and
        // each of its fields takes its value from the choices it offers.
        const boxes = Array.from((region || form).querySelectorAll('input, textarea')).filter((c) => {
            if (c.tagName === 'INPUT' && /^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/.test((c.type || 'text').toLowerCase())) return false;
            const r = c.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        return boxes.length <= 1;
    }

    /** Waits briefly for a field's choices to show and returns their labels (up to 6). */
    async function openChoices() {
        const seen = () => Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li'))
            .filter((o) => isRendered(o))
            .map((o) => (o.innerText || o.value || o.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        for (let waited = 0; waited <= 900; waited += 150) {
            const found = seen();
            if (found.length) return [...new Set(found)].slice(0, 6);
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return [];
    }

    /**
     * The numbers of nodes the listing has not shown yet, so a result can
     * name them the way the listing will: [66] "Chicago, Illinois". The page
     * is looked at again, as find does, and they are marked as new.
     */
    function refsFor(nodes) {
        if (!lastScanRequest) return nodes.map(() => null);
        try {
            scanInteractiveElements(lastScanRequest.limit || 80, lastScanRequest.task || "", { whole: lastScanRequest.whole });
        } catch (_) { return nodes.map(() => null); }
        return nodes.map((n) => {
            let holder = idOf(n) ? n : null;
            if (!holder && n && n.querySelectorAll) {
                for (const child of n.querySelectorAll('*')) {
                    if (idOf(child)) { holder = child; break; }
                }
            }
            if (!holder) holder = numberedOf(n);
            if (!holder) return null;
            justFound.add(holder);
            return idOf(holder);
        });
    }
    /** Choices as a result names them: by number when they have one. */
    function namedChoices(nodes, max) {
        const seen = new Set();
        const kept = [];
        for (const n of nodes) {
            const label = (n.innerText || n.value || n.textContent || '').replace(/\s+/g, ' ').trim();
            if (!label || seen.has(label)) continue;
            seen.add(label);
            kept.push({ n, label: label.slice(0, 80) });
            if (kept.length >= max) break;
        }
        const refs = refsFor(kept.map((k) => k.n));
        return kept.map((k, i) => (refs[i] ? `[${refs[i]}] "${k.label}"` : `"${k.label}"`)).join(', ');
    }

    /**
     * Puts the cursor in a control, and takes it out again, as a person
     * does. The browser sends a page its focus and blur events only while
     * the page's own window has the keyboard, and it often does not: the
     * person is typing in the side panel. Controls that open on focus, or
     * keep what was typed only when the field is left, never hear about it
     * then, so the events are sent by hand.
     */
    function focusField(el) {
        const had = document.activeElement;
        try { el.focus(); } catch (_) { return; }
        if (document.hasFocus()) return;
        if (had && had !== el && had !== document.body) {
            had.dispatchEvent(new FocusEvent('blur', { relatedTarget: el }));
            had.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: el }));
        }
        el.dispatchEvent(new FocusEvent('focus', { relatedTarget: had || null }));
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: had || null }));
    }
    function leaveField(el) {
        if (!el || !el.isConnected) return;
        if (document.hasFocus()) {
            if (document.activeElement === el) { try { el.blur(); } catch (_) { /* nothing to leave */ } }
            return;
        }
        el.dispatchEvent(new FocusEvent('blur'));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        try { el.blur(); } catch (_) { /* nothing to leave */ }
    }

    /** The text box the cursor is in right now, through any shadow roots, or null. */
    function caretBox() {
        let a = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        if (!a || a === document.body) return null;
        if (a.isContentEditable || a.tagName === 'TEXTAREA') return a;
        if (a.tagName === 'INPUT' && !/^(button|submit|reset|image|file|hidden|checkbox|radio|range|color)$/.test((a.type || 'text').toLowerCase()) && !a.readOnly) return a;
        return null;
    }

    /**
     * Simulates natural typing character-by-character.
     * Replaces any existing value by default (prefilled fields would
     * otherwise end up with concatenated text).
     * For `contenteditable` elements uses `execCommand('insertText')`.
     * Dispatches composition events for IME compatibility.
     *
     * @param {HTMLElement} el - Target element.
     * @param {string} text - Text to type.
     * @returns {Promise<void>}
     */
    async function simulateTyping(el, text) {
        focusField(el);

        const isContentEditable = el.isContentEditable;
        const nativeSetter = isContentEditable ? null : getNativeValueSetter(el);

        const eventBase = { bubbles: true, cancelable: true, view: window };

        // Replace semantics: clear any prefilled content first, keeping
        // React/controlled inputs in sync via the native setter + input event.
        if (isContentEditable) {
            if ((el.textContent || '').length > 0) {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                selection.removeAllRanges();
                selection.addRange(range);
                document.execCommand('delete');
            }
        } else if ((el.value || '').length > 0) {
            if (nativeSetter) {
                nativeSetter.call(el, '');
            } else {
                el.value = '';
            }
            el.dispatchEvent(new InputEvent('input', {
                ...eventBase,
                inputType: 'deleteContentBackward',
            }));
        }

        // Fire compositionstart
        el.dispatchEvent(new CompositionEvent('compositionstart', { ...eventBase, data: '' }));

        for (let i = 0; i < text.length; i++) {
            if (cancelRequested) break;
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

            // No pause between characters: every per-key event above still
            // fires in order, which is what frameworks listen for, and a
            // 12ms pause per character cost seconds in throttled tabs.
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
            cancelRequested = false;
            const { action, id, text, scrollDirection, modifiers = {} } = data;

            // =================================================================
            // Actions that don't require an element
            // =================================================================

            if (action === 'scroll') {
                let amount = window.innerHeight * 0.85;
                let scrollTarget = null;

                // Bring one control into view (it may sit in its own scroller).
                if (data.intoView) {
                    const target = elementMap[data.intoView];
                    if (!target) return { success: false, error: `Element [${data.intoView}] not found.` };
                    const conn = requireConnected(target);
                    if (!conn.ok) return conn.error;
                    target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
                    return { success: true, message: `Scrolled [${data.intoView}] into view.` };
                }

                // Element-level scrolling
                if (data.scrollTarget) {
                    scrollTarget = elementMap[data.scrollTarget];
                    if (!scrollTarget) {
                        return { success: false, error: `Scroll target element [${data.scrollTarget}] not found.` };
                    }
                    const conn = requireConnected(scrollTarget);
                    if (!conn.ok) return conn.error;
                }

                // The box that scrolls is the control itself (a text box
                // longer than its frame) or the nearest box around it that
                // does (a panel, a list with its own bar). With none, the page.
                if (scrollTarget) {
                    const scrolls = (n) => {
                        if (n.scrollHeight <= n.clientHeight + 4 && n.scrollWidth <= n.clientWidth + 4) return false;
                        if (n.tagName === 'TEXTAREA') return true;
                        const o = window.getComputedStyle(n);
                        return /auto|scroll/.test(`${o.overflowY} ${o.overflowX}`);
                    };
                    let box = scrollTarget;
                    while (box && box !== document.body && box !== document.documentElement && !scrolls(box)) box = box.parentElement;
                    scrollTarget = box && box !== document.body && box !== document.documentElement ? box : null;
                }

                // Many apps never scroll the window: the page is a fixed frame
                // and the content scrolls in a large box inside it (mail, chat,
                // dashboards, document viewers). When the window cannot move
                // the asked way, scroll the box a person would.
                let mainBox = null;
                if (!scrollTarget && !data.toText && scrollDirection) {
                    mainBox = mainScrollBox(scrollDirection);
                    if (mainBox) scrollTarget = mainBox.el;
                    else if (windowHeld(!['left', 'right'].includes(scrollDirection))) {
                        const edge = { down: 'bottom', up: 'top', left: 'left edge', right: 'right edge' }[scrollDirection] || scrollDirection;
                        return { success: true, message: `Nothing moved: the page is already at the ${edge}.` };
                    }
                }

                // Hidden tabs never run smooth scrolling, which left the agent
                // scrolling a page that did not move ("scroll unchanged").
                const hidden = document.visibilityState === 'hidden';
                const behavior = hidden ? 'instant' : 'smooth';

                // Jump straight to a section: the outline shows the headings,
                // so "scroll to Demographics" beats scrolling blind.
                if (data.toText) {
                    const want = String(data.toText).trim().toLowerCase();
                    const pick = (sel) => Array.from(document.querySelectorAll(sel)).find((n) => (n.innerText || '').toLowerCase().includes(want) && n.getBoundingClientRect().height > 0);
                    const target = pick('h1, h2, h3, h4, h5, h6, [role="heading"]') || pick('p, li, td, th, dt, dd, summary, label, button, a');
                    if (!target) return { success: false, error: `No heading or text containing "${data.toText}" on this page. Check the page outline for the exact wording.` };
                    await showScrollCue('down', target);
                    target.scrollIntoView({ behavior, block: 'start' });
                    await (hidden ? Promise.resolve() : delay(350));
                    if (Math.abs(target.getBoundingClientRect().top) > 40) target.scrollIntoView({ behavior: 'instant', block: 'start' });
                    return { success: true, message: `Scrolled to "${(target.innerText || '').trim().slice(0, 60)}".` };
                }

                if (scrollTarget) amount = Math.max(40, scrollTarget.clientHeight * 0.85);
                await showScrollCue(scrollDirection === 'bottom' ? 'down' : scrollDirection === 'top' ? 'up' : scrollDirection, scrollTarget);

                const scroller = scrollTarget || document.scrollingElement || document.documentElement;
                const before = { top: scroller.scrollTop, left: scroller.scrollLeft };
                // All the way, as dragging the bar to its end does.
                if (scrollDirection === 'bottom' || scrollDirection === 'top') {
                    const to = scrollDirection === 'bottom' ? scroller.scrollHeight : 0;
                    if (scrollTarget) scrollTarget.scrollTo({ top: to, behavior: 'instant' }); else window.scrollTo({ top: to, behavior: 'instant' });
                    await delay(150);
                    const what = mainBox ? mainBox.what : scrollTarget ? `the box around [${data.scrollTarget}]` : 'the page';
                    if (scroller.scrollTop === before.top) return { success: true, message: `Nothing moved: ${what} is already at the ${scrollDirection}.` };
                    return { success: true, message: `Scrolled to the ${scrollDirection} of ${what}.` };
                }
                const scrollOpts = { behavior };

                if (scrollDirection === 'down')  scrollOpts.top = amount;
                if (scrollDirection === 'up')    scrollOpts.top = -amount;
                if (scrollDirection === 'left')  scrollOpts.left = -amount;
                if (scrollDirection === 'right') scrollOpts.left = amount;

                if (scrollTarget) {
                    scrollTarget.scrollBy(scrollOpts);
                } else {
                    window.scrollBy(scrollOpts);
                }

                // Smooth scrolling is asynchronous and is not a DOM mutation,
                // so give it a moment to progress before measuring.
                await (hidden ? Promise.resolve() : delay(400));
                if (scroller.scrollTop === before.top && scroller.scrollLeft === before.left) {
                    const instant = { ...scrollOpts, behavior: 'instant' };
                    if (scrollTarget) scrollTarget.scrollBy(instant); else window.scrollBy(instant);
                }

                // Where that leaves the reader: how far down, and whether
                // there is any further to go.
                await (hidden ? Promise.resolve() : delay(120));
                const vertical = scrollDirection === 'down' || scrollDirection === 'up';
                const view = Math.max(1, scrollTarget ? scroller.clientHeight : window.innerHeight);
                const total = Math.max(view, scroller.scrollHeight);
                const moved = scroller.scrollTop !== before.top || scroller.scrollLeft !== before.left;
                const what = mainBox ? mainBox.what : scrollTarget ? `the box around [${data.scrollTarget}]` : 'the page';
                if (!moved) return { success: true, message: `Nothing moved: ${what} is already at the ${{ down: 'bottom', up: 'top', left: 'left edge', right: 'right edge' }[scrollDirection] || 'end'}.` };
                const end = vertical && scroller.scrollTop + view >= total - 2 ? ' That is the bottom.' : vertical && scroller.scrollTop <= 0 ? ' That is the top.' : '';
                const where = vertical ? ` Screen ${Math.min(Math.ceil(total / view), Math.floor(scroller.scrollTop / view) + 1)} of ${Math.ceil(total / view)} of ${what} is in view.` : '';
                if (mainBox) {
                    const of = vertical ? ` Screen ${Math.min(Math.ceil(total / view), Math.floor(scroller.scrollTop / view) + 1)} of ${Math.ceil(total / view)} of it.` : '';
                    return { success: true, message: `Scrolled ${what} ${scrollDirection}.${of}${end}` };
                }
                return { success: true, message: `Scrolled ${scrollDirection}.${where}${end}` };
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

            // ----- fill_form: several fields in one step -----
            if (action === 'fill_form') {
                const filled = [];
                for (const field of data.fields || []) {
                    const target = elementMap[field.id];
                    if (!target) return { success: false, error: `Element with ID ${field.id} not found. Re-scanning recommended.` };
                    const connected = requireConnected(target);
                    if (!connected.ok) return connected.error;
                    highlightTarget(field.id);
                    await moveAgentCursorToElement(target, "Type");
                    const tag = target.tagName.toLowerCase();
                    const inputType = (target.type || '').toLowerCase();
                    if (tag === 'select') {
                        const want = String(field.text).trim().toLowerCase();
                        const match = Array.from(target.options).find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want);
                        if (!match) return { success: false, error: `Option "${field.text}" not found in <select> element [${field.id}]. Filled so far: ${filled.join(', ') || 'none'}.` };
                        match.selected = true;
                        target.dispatchEvent(new Event('input', { bubbles: true }));
                        target.dispatchEvent(new Event('change', { bubbles: true }));
                        filled.push(`[${field.id}] = "${match.text.trim()}"`);
                    } else if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
                        const want = !/^(false|no|off|0|unchecked)$/i.test(String(field.text).trim());
                        if (!!target.checked !== want) target.click();
                        filled.push(`[${field.id}] ${target.checked ? 'checked' : 'unchecked'}`);
                    } else {
                        await simulateTyping(target, field.text);
                        if (cancelRequested) return { success: false, error: 'Typing cancelled before completion.' };
                        filled.push(`[${field.id}] = "${field.text}"`);
                    }
                }
                let submitted = '';
                if (data.submitId !== undefined) {
                    const button = elementMap[data.submitId];
                    if (!button) return { success: false, error: `Submit element ${data.submitId} not found after filling ${filled.join(', ')}.` };
                    await moveAgentCursorToElement(button, "Click");
                    await pulseAgentCursor("Click");
                    dispatchClickEvents(button, modifiers);
                    submitted = ` Then clicked [${data.submitId}].`;
                }
                return { success: true, message: `Filled ${filled.length} fields: ${filled.join(', ')}.${submitted}` };
            }

            // ----- click_at: a point of the page with no control listed at it -----
            if (action === 'click_at') {
                const px = Number(data.x);
                const py = Number(data.y);
                const doc = document.scrollingElement || document.documentElement;
                if (!(px >= 0) || !(py >= 0) || px > doc.scrollWidth || py > doc.scrollHeight) {
                    return { success: false, error: `${data.x},${data.y} is not on the page, which is ${doc.scrollWidth} pixels wide and ${doc.scrollHeight} high.` };
                }
                // The point is in page pixels; it is brought into the window first.
                let x = px - window.scrollX;
                let y = py - window.scrollY;
                if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
                    window.scrollTo({ left: Math.max(0, px - window.innerWidth / 2), top: Math.max(0, py - window.innerHeight / 2), behavior: 'instant' });
                    x = px - window.scrollX;
                    y = py - window.scrollY;
                }
                if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return { success: false, error: `The page could not be scrolled to bring ${px},${py} on screen.` };
                const hit = drawnAt(x, y);
                const wrong = unexpectedAt(hit, data.expect, `What is at ${px},${py}`, null);
                if (wrong) return wrong;
                const point = { x, y };
                const g = await gesture(POINTER_TOOLS ? POINTER_TOOLS.clickSteps(point) : [], { label: 'Click', id: `The point ${px},${py}` });
                if (g.fail) return g.fail;
                if (!g.real) {
                    if (!hit || hit.tagName === 'IFRAME') return { success: false, pointer: 'synthetic', error: `${px},${py} is inside a frame, which a press made by script cannot reach. The real pointer is not available here.` };
                    await moveAgentCursorTo(x, y, 'Click');
                    await pulseAgentCursor('Click');
                    dispatchClickEvents(hit, {}, point);
                }
                const note = g.real && !g.landed && hit && hit.tagName !== 'IFRAME' ? ' The page did not see the press arrive.' : '';
                return { success: true, pointer: g.real ? 'real' : 'synthetic', message: `Clicked at ${px},${py}, on ${nameOfDrawn(hit)}.${note}` };
            }

            // =================================================================
            // Actions that require an element
            // =================================================================

            const el = elementMap[id];
            // A key press with no target goes to the focused element or the
            // page ("/" to focus site search, Escape to close a popup). This
            // guard used to reject it before the keypress handler could run.
            const pageLevelKey = action === 'keypress' && (id === undefined || id === null);
            if (!el && !pageLevelKey) {
                return { success: false, error: `Element with ID ${id} not found. Re-scanning recommended.` };
            }

            if (!pageLevelKey) {
                const conn = requireConnected(el);
                if (!conn.ok) return conn.error;
                // Highlight before acting
                highlightTarget(id);
            }

            // ----- click -----
            if (action === 'click') {
                // A native dropdown cannot be opened by a synthetic click.
                if (el.tagName === 'SELECT') {
                    return { success: false, error: `[${id}] is a dropdown: it is given one of its options as its value, not clicked open.` };
                }
                // The real pointer where it can be had; a click with keys
                // held is made by script, as before.
                const plain = !modifiers.ctrlKey && !modifiers.shiftKey && !modifiers.altKey && !modifiers.metaKey;
                // A real press on a file, colour or date box opens a picker the
                // browser draws outside the page, which the agent can neither
                // read nor close by its listing; those are given values by fill.
                const opensPicker = (n) => !!n && n.tagName === 'INPUT' && /^(file|color|date|datetime-local|month|week|time)$/i.test(n.type || '');
                const picker = opensPicker(el) || (el.tagName === 'LABEL' && opensPicker(el.control));
                const pressed = plain && !picker ? await pointerOnControl(el, id, "Click", false) : { real: false };
                if (pressed.fail) return pressed.fail;
                let went = true;
                if (!pressed.real) {
                    await moveAgentCursorToElement(el, "Click");
                    await pulseAgentCursor("Click");
                    went = dispatchClickEvents(el, modifiers);
                }
                const pointer = pressed.real ? 'real' : 'synthetic';
                const note = pressed.note || '';
                // A link that opens in a new tab. A real click opens it as for
                // a person, and the engine follows the tab it finds; a scripted
                // click is not allowed to open one, and a real one in a tab
                // behind another may not be, so unless the page took the click
                // over, the address is handed back for the tab to be opened.
                const link = el.closest ? el.closest('a[href]') : null;
                if (pressed.real && pressed.clicked) went = !pressed.clicked.defaultPrevented;
                if (went && link && link.target && !/^_(self|parent|top)$/i.test(link.target) && /^https?:/i.test(link.href)) {
                    return { success: true, opensTab: link.href, pointer, message: `Clicked element [${id}].${note}` };
                }
                // Settling is handled by the interact wrapper's mutation
                // counter (event-driven, replaces the old fixed 300ms wait).
                const isTextField = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|number|password)$/.test((el.type || 'text').toLowerCase()));
                if (el.disabled) return { success: true, pointer, message: `Clicked element [${id}]. It is disabled, so the click does nothing to it.` };
                // `cancelled`: the page took the click over, which is an answer to it.
                return { success: true, pointer, ...(went ? {} : { cancelled: true }), message: `Clicked element [${id}].${isTextField ? ' It is a text field: the click only put the cursor in it.' : ''}${note}` };
            }

            // ----- double_click -----
            if (action === 'double_click') {
                await moveAgentCursorToElement(el, "Double click");
                await pulseAgentCursor("Double click");
                // Two clicks, the second counted as the second, then the double click.
                dispatchClickEvents(el, modifiers);
                dispatchClickEvents(el, modifiers, null, 2);
                el.dispatchEvent(new MouseEvent('dblclick', pointerInit(centreOf(el), { modifiers, detail: 2 })));
                return { success: true, message: `Double-clicked element [${id}].` };
            }

            // ----- right_click -----
            if (action === 'right_click') {
                await moveAgentCursorToElement(el, "Right click");
                await pulseAgentCursor("Right click");
                const at = centreOf(el);
                const down = pointerInit(at, { modifiers, held: true, button: 2 });
                const up = pointerInit(at, { modifiers, button: 2 });
                el.dispatchEvent(new PointerEvent('pointerdown', down));
                el.dispatchEvent(new MouseEvent('mousedown', down));
                el.dispatchEvent(new PointerEvent('pointerup', up));
                el.dispatchEvent(new MouseEvent('mouseup', up));
                el.dispatchEvent(new MouseEvent('contextmenu', up));
                return { success: true, message: `Right-clicked element [${id}].` };
            }

            // ----- hover -----
            if (action === 'hover') {
                // The real pointer is moved there and stays, so a menu that
                // opens while the pointer is over it (CSS :hover) stays open.
                const moved = await pointerOnControl(el, id, "Hover", true);
                if (moved.fail) return moved.fail;
                if (!moved.real) {
                    await moveAgentCursorToElement(el, "Hover");
                    dispatchHoverEvents(el, modifiers);
                }
                return { success: true, pointer: moved.real ? 'real' : 'synthetic', message: `Moved the pointer over [${id}] without pressing it${moved.real ? ', and left it there' : ''}.` };
            }

            // ----- drag -----
            // Press on a control, move while holding, let go: on another
            // control (to), or a distance in a direction.
            if (action === 'drag') {
                const to = data.to !== undefined && data.to !== null ? elementMap[data.to] : null;
                if (data.to !== undefined && data.to !== null && !to) return { success: false, error: `Element [${data.to}] not found. Re-scanning recommended.` };
                if (to && !to.isConnected) return { success: false, error: `[${data.to}] is no longer on the page.` };
                const vector = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[data.direction] || null;
                const distance = Number(data.distance) || 0;
                if (!to && (!vector || !(distance > 0))) return { success: false, error: 'drag needs a control to drop on, or a direction and a distance.' };
                // Both ends on screen at once, as a person needs them: the
                // window is scrolled so the middle of the way is in its middle.
                bringIntoView(el);
                const centre = (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
                const a0 = centre(el);
                const b0 = to ? centre(to) : { x: a0.x + vector[0] * distance, y: a0.y + vector[1] * distance };
                const span = { x: Math.abs(b0.x - a0.x), y: Math.abs(b0.y - a0.y) };
                if (span.y > window.innerHeight - 20 || span.x > window.innerWidth - 20) {
                    return { success: false, error: `The two ends of that drag are ${Math.round(Math.max(span.x, span.y))} pixels apart, more than the window shows at once (${window.innerWidth} by ${window.innerHeight}). Drag a shorter way, in parts.` };
                }
                const mid = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
                if (mid.x < 0 || mid.y < 0 || mid.x > window.innerWidth || mid.y > window.innerHeight || Math.min(a0.x, b0.x, a0.y, b0.y) < 0 || Math.max(a0.x, b0.x) > window.innerWidth || Math.max(a0.y, b0.y) > window.innerHeight) {
                    window.scrollBy({ left: mid.x - window.innerWidth / 2, top: mid.y - window.innerHeight / 2, behavior: 'instant' });
                }
                const from = aimAt(el);
                if (!from.point) return from.cover !== undefined ? coveredResult(id, nameOfDrawn(from.cover), false) : { success: false, error: `[${id}] is not drawn on screen, so it cannot be dragged.` };
                let end;
                if (to) {
                    const onto = aimAt(to);
                    if (!onto.point) return onto.cover !== undefined ? coveredResult(data.to, nameOfDrawn(onto.cover), false) : { success: false, error: `[${data.to}] is not drawn on screen, so nothing can be dropped on it.` };
                    end = onto.point;
                } else {
                    end = { x: from.point.x + vector[0] * distance, y: from.point.y + vector[1] * distance };
                }
                const edge = end.x < 1 || end.y < 1 || end.x > window.innerWidth - 1 || end.y > window.innerHeight - 1;
                end = { x: Math.max(1, Math.min(window.innerWidth - 1, end.x)), y: Math.max(1, Math.min(window.innerHeight - 1, end.y)) };
                // What it lets go on is what was checked before the drag.
                const wrong = unexpectedAt(drawnAt(end.x, end.y), data.expect, 'What is under the place to let go', el);
                if (wrong) return wrong;
                const placeBefore = placeOfNode(el);
                // What the drag can change, read before it: the value of a
                // slider around or inside it (the control's own value is said
                // after every action anyway), the numbers on the page, and
                // where it is.
                const near = el.closest('[role="slider"], input[type="range"]') || el.querySelector('[role="slider"], input[type="range"]');
                const valued = near === el ? null : near;
                const valueOf = (n) => (n ? (n.tagName === 'INPUT' ? n.value : n.getAttribute('aria-valuetext') || n.getAttribute('aria-valuenow')) : null);
                const valueBefore = valueOf(valued);
                const numbersBefore = numbersOnPage();
                const boxBefore = el.getBoundingClientRect();
                const scrollBefore = { x: window.scrollX, y: window.scrollY };
                const steps = POINTER_TOOLS ? POINTER_TOOLS.dragSteps(from.point, end) : [{ t: 'move', ...from.point }, { t: 'down', ...from.point }, { t: 'move', ...end }, { t: 'up', ...end }];
                const g = await gesture(steps, { drag: true, label: 'Drag', id });
                if (g.fail) return g.fail;
                if (!g.real) await syntheticDrag(el, steps);
                const said = [`Dragged [${id}] ${to ? `onto [${data.to}]` : `${data.direction} ${distance} px${edge ? ', stopping at the edge of the window' : ''}`}.`];
                if (g.real && !g.landed) said.push('The page did not see the press arrive.');
                else if (g.real && !pressesOn(el, g.landed.target)) said.push(`The press landed on ${nameOfDrawn(g.landed.target)}, not on [${id}].`);
                // Where it is now, when the drag moved it in the page.
                const placeAfter = el.isConnected ? placeOfNode(el) : null;
                if (placeBefore && placeAfter && placeAfter.parent === placeBefore.parent && placeAfter.index !== placeBefore.index) {
                    said.push(`[${id}] is now ${ordinal(placeAfter.index + 1)} of ${placeAfter.count} in its list (it was ${ordinal(placeBefore.index + 1)}).`);
                } else if (placeBefore && placeAfter && placeAfter.parent !== placeBefore.parent) {
                    said.push(`[${id}] is now in ${nameOfPlace(placeAfter.parent)}.`);
                }
                // What it changed, as fill says it: the value the control
                // holds, else the number on the page nearest it that moved.
                await delay(60);
                let shows = null;
                const valueAfter = valueOf(valued);
                if (valued && valueAfter !== valueBefore) {
                    shows = String(valueAfter);
                    said.push(`[${id}] now shows "${shows}" (it was "${valueBefore}").`);
                } else if (el.isConnected && !(near === el && stateOf(el))) {
                    const at = el.getBoundingClientRect();
                    const far = (f) => { const r = f.home.getBoundingClientRect(); return Math.hypot((r.left + r.right - at.left - at.right) / 2, (r.top + r.bottom - at.top - at.bottom) / 2); };
                    const changed = numbersBefore.filter((f) => { const now = numberNow(f); return now !== null && now !== f.value; }).sort((a, b) => far(a) - far(b));
                    if (changed.length) {
                        shows = String(numberNow(changed[0]));
                        said.push(`A number on the page went from ${changed[0].value} to ${shows}${changed.length > 1 ? ` (${changed.length - 1} other number${changed.length > 2 ? 's' : ''} changed too)` : ''}.`);
                    }
                    // Where it is drawn now, with any scroll of the window taken out.
                    const dx = Math.round(at.left + window.scrollX - scrollBefore.x - boxBefore.left), dy = Math.round(at.top + window.scrollY - scrollBefore.y - boxBefore.top);
                    if (dx || dy) said.push(`[${id}] moved ${[dx ? `${Math.abs(dx)} px ${dx > 0 ? 'right' : 'left'}` : '', dy ? `${Math.abs(dy)} px ${dy > 0 ? 'down' : 'up'}` : ''].filter(Boolean).join(' and ')}.`);
                    else if (!changed.length && placeAfter && placeBefore && placeAfter.parent === placeBefore.parent && placeAfter.index === placeBefore.index) said.push(`[${id}] did not move, and no value or number on the page changed.`);
                }
                return { success: true, pointer: g.real ? 'real' : 'synthetic', ...(shows !== null ? { shows } : {}), message: said.join(' ') };
            }

            // ----- fill -----
            // One action for every control that holds a value. What kind of
            // control it is, and how that kind is operated, is this code's
            // business, not the model's: a native dropdown, a checkbox, a
            // date field, a text box that offers choices and a custom
            // dropdown built from divs are all "give this control this value".
            // The reply says what the control shows afterwards.
            if (action === 'fill') {
                const value = String(data.value == null ? '' : data.value);
                const tag = el.tagName;
                const type = (el.type || '').toLowerCase();
                const role = el.getAttribute('role') || '';
                // Labels are compared by their words: "One-way" is "One way",
                // and "Price (low to high)" is "price low to high".
                const words = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
                const same = (a, b) => words(a) === words(b);
                const pick = (labels, want) => {
                    const w = words(want);
                    const l = labels.map(words);
                    let i = l.indexOf(w);
                    // The name itself, before what qualifies it: "London" is
                    // "London, United Kingdom" and not "London Stansted Airport".
                    if (i < 0) {
                        const named = labels.map((x, n) => (words(String(x).split(/\s*[,(\u2013\u2014|]\s*|\s+-\s+/)[0]) === w ? n : -1)).filter((n) => n >= 0);
                        if (named.length === 1) i = named[0];
                    }
                    if (i < 0) { const starts = l.map((x, n) => (x.startsWith(w) ? n : -1)).filter((n) => n >= 0); if (starts.length === 1) i = starts[0]; }
                    if (i < 0) { const has = l.map((x, n) => (w && x.includes(w) ? n : -1)).filter((n) => n >= 0); if (has.length === 1) i = has[0]; }
                    return i;
                };
                await moveAgentCursorToElement(el, "Fill");

                if (tag === 'SELECT') {
                    const options = Array.from(el.options);
                    let i = pick(options.map((o) => o.text), value);
                    if (i < 0) i = options.findIndex((o) => same(o.value, value));
                    if (i < 0) return { success: false, error: `[${id}] has no option "${value}". Its options: ${options.slice(0, 20).map((o) => `"${o.text.trim()}"`).join(', ')}.` };
                    options[i].selected = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, shows: options[i].text.trim(), message: `[${id}] now shows "${options[i].text.trim()}".` };
                }

                const nativeCheck = tag === 'INPUT' && (type === 'checkbox' || type === 'radio');
                if (nativeCheck || ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
                    const want = !/^(off|false|no|0|unchecked|uncheck)$/i.test(value.trim());
                    const isOn = () => (nativeCheck ? !!el.checked : el.getAttribute('aria-checked') === 'true');
                    if (isOn() !== want) {
                        if ((type === 'radio' || /radio/.test(role)) && !want) return { success: false, error: `[${id}] is one of a set of choices: it is turned off by choosing another one.` };
                        const before = isOn();
                        await pulseAgentCursor("Fill");
                        el.click();
                        if (nativeCheck && type === 'checkbox' && el.checked === before) {
                            // The page stopped the click: set it and say so to the page.
                            el.checked = want;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        await delay(80);
                    }
                    return isOn() === want
                        ? { success: true, shows: want ? 'on' : 'off', message: `[${id}] is now ${want ? 'on' : 'off'}.` }
                        : { success: false, error: `[${id}] did not change: it is still ${isOn() ? 'on' : 'off'}.` };
                }

                // Fields the browser draws itself (date, time, colour, range)
                // take a value in one exact form and ignore typed keys.
                if (tag === 'INPUT' && /^(date|time|datetime-local|month|week|color|range)$/.test(type)) {
                    const setter = getNativeValueSetter(el);
                    if (setter) setter.call(el, value); else el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    if (!el.value) {
                        const form = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www', color: '#rrggbb', range: 'a number' }[type];
                        return { success: false, error: `[${id}] did not take "${value}". It needs ${form}${el.min ? `, from ${el.min}` : ''}${el.max ? ` to ${el.max}` : ''}.` };
                    }
                    return { success: true, shows: el.value, message: `[${id}] now shows "${el.value}".` };
                }

                // A slider or spin box that is not a native one is moved with
                // the keys a person would use, until it reads the value asked
                // for. A spin box steps up and down; a slider right and left,
                // or up and down when right and left do not move it.
                if (role === 'slider' || role === 'spinbutton') {
                    const now = () => Number(el.getAttribute('aria-valuenow'));
                    const want = Number(value);
                    if (Number.isNaN(want) || Number.isNaN(now())) return { success: false, error: `[${id}] takes a number${el.getAttribute('aria-valuemin') !== null ? ` from ${el.getAttribute('aria-valuemin')} to ${el.getAttribute('aria-valuemax')}` : ''}.` };
                    el.focus();
                    const ways = role === 'spinbutton' ? [['ArrowUp', 'ArrowDown']] : [['ArrowRight', 'ArrowLeft'], ['ArrowUp', 'ArrowDown']];
                    const how = {};
                    let way = 0;
                    let moved = false;
                    for (let i = 0; i < 400 && now() !== want; i++) {
                        const before = now();
                        await stepKey(el, ways[way][want > before ? 0 : 1], how);
                        if (now() === before) await delay(40);
                        if (now() !== before) moved = true;
                        else if (!moved && way + 1 < ways.length) { way++; continue; }
                        // It stopped moving, or stepped past the value: it cannot land on it.
                        if (now() === before || (want > before) !== (want > now()) && now() !== want) break;
                    }
                    const shows = el.getAttribute('aria-valuetext') || String(now());
                    return now() === want
                        ? { success: true, shows, message: `[${id}] now shows "${shows}".` }
                        : { success: false, error: `[${id}] could not be set to ${value}: it shows "${shows}"${el.getAttribute('aria-valuemin') !== null ? ` and goes from ${el.getAttribute('aria-valuemin')} to ${el.getAttribute('aria-valuemax')}` : ''}.` };
                }

                const textLike = tag === 'TEXTAREA' || el.isContentEditable || (tag === 'INPUT' && !/^(button|submit|reset|image|file|hidden)$/.test(type));
                if (textLike) {
                    const read = () => (el.isContentEditable ? (el.innerText || '') : (el.value || '')).trim();
                    const before = read();
                    // A person cannot type into a read-only box either: it is
                    // filled by whatever opens when it is clicked.
                    if (el.readOnly) return { success: false, error: `[${id}] did not take typed text: it is read-only and shows "${before.slice(0, 60)}". Click it and use what opens.` };
                    const renderedOptions = () => Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li')).filter((o) => isRendered(o));
                    const optionsBefore = new Set(renderedOptions());
                    // A list of suggestions is not always marked as one. For a
                    // box that says nothing about itself, what counts is what
                    // typing brings up against it: list rows that were not
                    // drawn before, placed above or below the box.
                    const renderedRows = () => Array.from(document.querySelectorAll('li, [role="option"]')).filter((o) => isRendered(o));
                    const rowsBefore = new Set(renderedRows());
                    const rowsBroughtUp = () => {
                        const at = box.getBoundingClientRect();
                        const rows = renderedRows().filter((o) => {
                            if (rowsBefore.has(o)) return false;
                            const r = o.getBoundingClientRect();
                            return r.right > at.left && r.left < at.right && r.top < at.bottom + 400 && r.bottom > at.top - 400;
                        });
                        const outer = rows.filter((o) => !rows.some((p) => p !== o && p.contains(o)));
                        outer.forEach((o) => offeredRows.add(o));
                        return outer;
                    };
                    // The box a person would be typing in at this spot. It is
                    // nearly always the field itself; some pages draw another
                    // box over it once it has been clicked, and that one takes
                    // the keys.
                    let box = el;
                    const spot = el.getBoundingClientRect();
                    if (spot.width > 0 && spot.bottom > 0 && spot.top < (window.innerHeight || 0)) {
                        const atSpot = document.elementFromPoint(spot.left + spot.width / 2, spot.top + spot.height / 2);
                        const drawnOver = atSpot && atSpot !== el && !el.contains(atSpot) && !atSpot.readOnly
                            && (atSpot.tagName === 'TEXTAREA' || atSpot.isContentEditable || (atSpot.tagName === 'INPUT' && !/^(button|submit|reset|image|file|hidden|checkbox|radio|range|color)$/.test((atSpot.type || 'text').toLowerCase())));
                        if (drawnOver) box = atSpot;
                    }
                    const typedOver = box !== el;
                    await simulateTyping(box, value);
                    if (cancelRequested) return { success: false, error: 'Typing cancelled before completion.' };
                    const valueOf = (b) => (b.isContentEditable ? (b.innerText || '') : (b.value || '')).trim();
                    const shown = () => valueOf(box);
                    // A field that offers choices takes its value from a choice.
                    const choose = async () => {
                        if (isSearchField(box)) return null;
                        const marked = offersChoices(box);
                        // The choices this typing brought up: the ones that were
                        // not on the page before it, so another list left open
                        // elsewhere is not taken for this box's. An unmarked
                        // box is given a shorter wait, since most have no list.
                        let all = [];
                        for (let waited = 0; waited <= (marked ? 900 : 600) && !all.length; waited += 150) {
                            all = marked ? renderedOptions().filter((o) => !optionsBefore.has(o)) : [];
                            if (!all.length) all = rowsBroughtUp();
                            if (!all.length) await delay(150);
                        }
                        if (!marked && !all.length) return null;
                        // Nothing new came up: a list of its own may already
                        // have been open. Its own is the one it names, or the
                        // one drawn in the same part of the page.
                        if (!all.length) {
                            const named = (box.getAttribute('aria-controls') || box.getAttribute('aria-owns') || '').split(/\s+/).map((i) => i && document.getElementById(i)).filter(Boolean);
                            let near = null;
                            for (let n = box.parentElement, d = 0; n && n !== document.body && d < 4 && !near; n = n.parentElement, d++) if (renderedOptions().some((o) => n.contains(o))) near = n;
                            const homes = named.length ? named : near ? [near] : [];
                            all = renderedOptions().filter((o) => homes.some((h) => h.contains(o)));
                        }
                        const labels = [...new Set(all.map((o) => (o.innerText || o.value || o.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 6);
                        if (!labels.length) return null;
                        const i = pick(all.map((o) => (o.innerText || o.textContent || '')), value);
                        if (i >= 0) {
                            dispatchClickEvents(all[i], {});
                            await delay(120);
                            const now = (el.isConnected ? valueOf(el) : '') || shown();
                            return { success: true, shows: now, message: `Typed "${value}" into [${id}] and chose "${(all[i].innerText || all[i].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)}" from its list.${now ? ` It now shows "${now.slice(0, 80)}".` : ''}` };
                        }
                        return { success: true, shows: shown(), choices: labels, message: `Typed "${value}" into [${id}]. It opened a list of choices and none is exactly that: ${namedChoices(all, 6)}. Nothing is chosen yet: click the one you want.` };
                    };
                    let chosen = value && !shown() ? null : await choose();
                    if (!chosen && value && !shown()) {
                        // The box is empty again. Some boxes open a larger one
                        // as typing starts and move the cursor, or the text,
                        // into it. A person's keystrokes land wherever the
                        // cursor is, so the text goes there too.
                        await delay(150);
                        const caret = caretBox();
                        const other = caret && caret !== box ? caret : Array.from(document.querySelectorAll('input, textarea')).find((b) => b !== box && !b.readOnly && valueOf(b) === value.trim() && isRendered(b)) || null;
                        if (other) {
                            await simulateTyping(other, value);
                            if (valueOf(other)) { box = other; chosen = await choose(); }
                        }
                    }
                    if (chosen) return chosen;
                    // Typing changed nothing: the box takes its value some other
                    // way (a calendar, a picker), and saying it worked would be a lie.
                    if (value && box === el && !typedOver && shown() === before && before !== value.trim()) {
                        return { success: false, error: `[${id}] did not take typed text${el.readOnly ? ' (it is read-only)' : ''}: it still shows "${before.slice(0, 60)}". Click it and use what opens.` };
                    }
                    // Text went in and the box is empty again: it was not kept.
                    if (value && !shown()) return { success: false, error: `[${id}] did not keep the text: it is empty after typing "${value.slice(0, 60)}". Look at what the page shows now.` };
                    // Done typing: a person now leaves the field, and many
                    // fields keep what was typed only then (a date box, a
                    // field checked as it is left). A search box is left as
                    // it is, since Enter in it is usually what comes next.
                    if (!isSearchField(box)) leaveField(box);
                    // A box that takes its value from a list, and no list came up for these words.
                    const noList = value && offersChoices(box) && !isSearchField(box) ? ` It takes its value from a list of choices, and none came up for "${value.slice(0, 60)}": nothing is chosen. Shorter or different words may bring the list up.` : '';
                    // A search box holds the words; nothing has been searched yet.
                    const notRun = value && isSearchField(box) ? ' It is a search box: nothing has been searched yet.' : '';
                    return { success: true, shows: shown(), message: (box !== el
                        ? `Typed "${value.slice(0, 80)}". The page moved the cursor to another box${labelOf(box) ? ` ("${labelOf(box).slice(0, 40)}")` : ''}, and the text is there now.`
                        : `[${id}] now shows "${shown().slice(0, 120)}".`) + noList + notRun };
                }

                // A dropdown built from other elements: open it, choose by label.
                const opens = role === 'combobox' || role === 'listbox' || /^(listbox|menu|true)$/.test(el.getAttribute('aria-haspopup') || '') || el.hasAttribute('aria-expanded');
                if (opens) {
                    const optionNodes = () => Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="listbox"] li, [role="menu"] li')).filter((o) => isRendered(o));
                    // Its own list, when it names one and that list is open already.
                    const homes = (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').split(/\s+/).map((i) => i && document.getElementById(i)).filter(Boolean);
                    let nodes = optionNodes().filter((o) => homes.some((h) => h.contains(o)));
                    // Otherwise it is pressed, and what that brings up is what
                    // it offers: entries marked as a list's, or, for a menu
                    // built from plain buttons and links, whatever controls
                    // appeared. A list left open elsewhere on the page is not
                    // its. If the press closed it, it was open: press again.
                    for (let press = 0; press < 2 && !nodes.length; press++) {
                        const already = new Set(optionNodes());
                        const listedBefore = new Set(lastListed);
                        await pulseAgentCursor("Fill");
                        dispatchClickEvents(el, {});
                        for (let waited = 0; waited <= 900 && !nodes.length; waited += 150) { await delay(150); nodes = optionNodes().filter((o) => !already.has(o)); }
                        if (!nodes.length && lastScanRequest) {
                            try {
                                const list = scanInteractiveElements(lastScanRequest.limit || 80, lastScanRequest.task || "", { whole: lastScanRequest.whole });
                                nodes = list.filter((e) => !listedBefore.has(e.id)).map((e) => elementMap[e.id]).filter((n) => n && n !== el && !n.contains(el) && !el.contains(n));
                                nodes.forEach((n) => justFound.add(n));
                            } catch (_) { nodes = []; }
                        }
                    }
                    if (!nodes.length) return { success: false, error: `[${id}] was pressed and nothing to choose from appeared. Look at what the page shows now.` };
                    const labels = nodes.map((o) => (o.innerText || o.textContent || '').replace(/\s+/g, ' ').trim());
                    const i = pick(labels, value);
                    if (i < 0) return { success: true, choices: labels.slice(0, 20), message: `[${id}] opened these choices and none is "${value}": ${namedChoices(nodes, 20)}. Nothing is chosen yet: click the one you want.` };
                    dispatchClickEvents(nodes[i], {});
                    await delay(150);
                    const after = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                    return { success: true, shows: after, message: `Chose "${labels[i].slice(0, 80)}" in [${id}]. It now shows "${after.slice(0, 80)}".` };
                }

                // A handle built from a plain element (a slider's knob) holds
                // no value of its own: what it moves is a number shown
                // somewhere on the page. One arrow key on it shows which
                // number, and which way that key moves it; then it is pressed
                // until the number reads the value asked for.
                const want = Number(value.trim());
                // The part that takes the keys: the control itself, or the one
                // such part inside it when the number given is its outer box
                // (a slider's track, with the knob inside).
                const takesKeys = (n) => n.tabIndex >= 0 && !n.getAttribute('role') && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY|OPTION|LABEL)$/.test(n.tagName);
                const inner = takesKeys(el) ? [] : Array.from(el.querySelectorAll('[tabindex]')).filter((n) => takesKeys(n) && isRendered(n));
                const knob = takesKeys(el) ? el : inner.length === 1 ? inner[0] : null;
                const plain = !role && !!knob;
                if (plain && value.trim() && !Number.isNaN(want)) {
                    const how = {};
                    const opposite = { ArrowRight: 'ArrowLeft', ArrowLeft: 'ArrowRight', ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp' };
                    let found = null;
                    for (const key of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) {
                        const before = numbersOnPage();
                        await stepKey(knob, key, how);
                        await delay(80);
                        const at = knob.getBoundingClientRect();
                        const far = (f) => {
                            const r = f.home.getBoundingClientRect();
                            return Math.hypot((r.left + r.right - at.left - at.right) / 2, (r.top + r.bottom - at.top - at.bottom) / 2);
                        };
                        const changed = before.filter((f) => { const now = numberNow(f); return now !== null && now !== f.value; });
                        // The nearest number that moved is the one a person would look at.
                        changed.sort((a, b) => far(a) - far(b));
                        if (changed.length) {
                            const rose = numberNow(changed[0]) > changed[0].value;
                            found = { ...changed[0], up: rose ? key : opposite[key], down: rose ? opposite[key] : key };
                            break;
                        }
                    }
                    if (!found) return { success: false, error: `[${id}] holds no value of its own, and arrow keys did not move it: no number on the page changed when they were pressed on it. Use click on it, or on the controls beside it, instead.` };
                    const read = () => numberNow(found);
                    for (let i = 0; i < 400 && read() !== want && !cancelRequested; i++) {
                        const before = read();
                        if (before === null) break;
                        await stepKey(knob, want > before ? found.up : found.down, how);
                        if (read() === before) await delay(40);
                        const now = read();
                        // It stopped moving, or stepped past the value: it cannot land on it.
                        if (now === before || now === null || ((want > before) !== (want > now) && now !== want)) break;
                    }
                    const reads = read();
                    const n = found.node;
                    const shown = String((n.isConnected ? (n.nodeType === 3 ? n.data : n.value) : found.home && found.home.innerText) || reads).trim().slice(0, 40);
                    return reads === want
                        ? { success: true, shows: shown, message: `[${id}] now shows "${shown}": its arrow keys move that number on the page.` }
                        : { success: false, error: `[${id}] could not be set to ${value}: its arrow keys move a number on the page that now reads "${shown}".` };
                }

                return { success: false, error: `[${id}] is a ${tag.toLowerCase()}${role ? ` (${role})` : ''} and does not hold a value. Use click on it instead.` };
            }

            // ----- type -----
            if (action === 'type') {
                await moveAgentCursorToElement(el, "Type");
                await simulateTyping(el, text || '');
                if (cancelRequested) {
                    return { success: false, error: 'Typing cancelled before completion.' };
                }
                // A field that offers choices as you type (a city, an airport,
                // a name) takes its value from the choice, not from Enter:
                // pressing Enter there submits the form with nothing picked.
                // A search box is the exception: Enter searches what was typed.
                const choices = offersChoices(el) && !isSearchField(el) ? await openChoices() : [];
                if (choices.length) {
                    return { success: true, message: `Typed "${text}" into element [${id}]. It opened a list of choices instead of taking the text as it is: ${choices.map((c) => `"${c}"`).join(', ')}. Click the one you want (they are in the element list now, marked *)${data.submit ? '; Enter was not pressed' : ''}.` };
                }
                if (data.submit) {
                    // Type then Enter in one step: a search is one decision.
                    const pressed = await performAction({ action: 'keypress', id, text: 'Enter', modifiers: {} });
                    if (!pressed || !pressed.success) {
                        return { success: false, error: `Typed "${text}" into [${id}], but pressing Enter failed: ${pressed && pressed.error}` };
                    }
                    return { success: true, message: `Typed "${text}" into element [${id}] and pressed Enter.` };
                }
                return { success: true, message: `Typed "${text}" into element [${id}] (replacing any existing value).` };
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

                const tag = el.tagName.toLowerCase();
                const inputType = (el.type || '').toLowerCase();
                const isNativeCheckable =
                    tag === 'input' && (inputType === 'checkbox' || inputType === 'radio');

                // A single click both toggles the state and fires the
                // click/input/change events. (Setting .checked AND clicking
                // toggles twice, a net no-op.)
                const stateBefore = isNativeCheckable ? !!el.checked : null;
                el.click();

                if (isNativeCheckable && inputType === 'checkbox' && el.checked === stateBefore) {
                    // The page prevented the click's default action, fall
                    // back to setting the property and announcing the change.
                    el.checked = !stateBefore;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }

                if (isNativeCheckable) {
                    return {
                        success: true,
                        message: `Toggled element [${id}]; it is now ${el.checked ? 'checked' : 'unchecked'}.`,
                    };
                }
                const ariaChecked = el.getAttribute('aria-checked');
                return {
                    success: true,
                    message: `Clicked toggle element [${id}]${ariaChecked !== null ? `; aria-checked is now "${ariaChecked}"` : ''}.`,
                };
            }

            // ----- keypress -----
            if (action === 'keypress') {
                const targetEl = pageLevelKey ? (document.activeElement || document.body) : el;
                // A key that presses what it lands on goes only where it was
                // judged to land: one of the controls named in landsOn, or
                // nothing in particular. Focus that moved elsewhere since is
                // said, and the key is not pressed.
                const keyName = String(text || data.key || 'Enter');
                if (pageLevelKey && Array.isArray(data.landsOn) && /(^|\+)\s*(enter|return|numpadenter|space|spacebar| )$/i.test(keyName)) {
                    let focus = document.activeElement;
                    while (focus && focus.shadowRoot && focus.shadowRoot.activeElement) focus = focus.shadowRoot.activeElement;
                    const nowhere = !focus || focus === document.body || focus === document.documentElement;
                    const judged = data.landsOn.some((n) => elementMap[n] === focus);
                    if (!nowhere && !judged) {
                        const known = Object.keys(elementMap).find((n) => elementMap[n] === focus);
                        return { success: false, error: `The focus is on ${known ? `[${known}]` : 'a control that is not listed'}, not where this key was judged to land, so ${keyName} was not pressed. Press it with the ref of the control it is meant for.` };
                    }
                }
                if (!targetEl) {
                    return { success: false, error: "No focused or targeted element found to press key." };
                }

                const connKey = requireConnected(targetEl);
                if (!connKey.ok) return connKey.error;
                // Keys do not reach a control that is switched off.
                if (!pageLevelKey && targetEl.disabled) return { success: false, error: `[${id}] is disabled: it takes no keys. scroll with its ref moves what is inside it.` };

                targetEl.focus();
                await moveAgentCursorToElement(targetEl, `Press ${text || data.key || "Enter"}`);

                const key = text || data.key || "Enter";
                const meta = resolveKeyMeta(key);

                // A real key where one can be sent (the engine's debugger
                // connection, top page only): the browser then does what
                // the key does, such as scrolling, moving focus or typing.
                const count = key === 'Enter' ? 1 : Math.max(1, Math.min(50, Number(data.times) || 1));
                if (window === window.top && await pressRealKey(key, meta, modifiers, count)) {
                    return { success: true, real: true, message: `Pressed ${key}${count > 1 ? ` ${count} times` : ''}${id ? ` in [${id}]` : ''}.` };
                }

                const keyOpts = {
                    key,
                    code: meta.code,
                    keyCode: meta.keyCode,
                    which: meta.keyCode,
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    ctrlKey: !!modifiers.ctrlKey,
                    shiftKey: !!modifiers.shiftKey,
                    altKey: !!modifiers.altKey,
                    metaKey: !!modifiers.metaKey,
                };

                // dispatchEvent returns false when a listener called
                // preventDefault, i.e. the page handled the key itself.
                const keydownUnhandled = targetEl.dispatchEvent(
                    new KeyboardEvent('keydown', keyOpts),
                );

                // Dispatch keypress for printable keys and Enter (browsers
                // fire keypress for Enter with charCode 13).
                let keypressUnhandled = true;
                if (meta.printable || key === 'Enter') {
                    keypressUnhandled = targetEl.dispatchEvent(new KeyboardEvent('keypress', {
                        ...keyOpts,
                        charCode: key === 'Enter' ? 13 : key.charCodeAt(0),
                    }));
                }

                // Enter fallback: only submit/click when the page did NOT
                // handle the key events itself, otherwise the action fires
                // twice (e.g. a form submitted by the page AND requestSubmit).
                let enterFallbackUsed = false;
                if (key === 'Enter' && keydownUnhandled && keypressUnhandled) {
                    const targetTag = targetEl.tagName.toLowerCase();
                    if (targetTag === 'input' && targetEl.form) {
                        targetEl.form.requestSubmit ? targetEl.form.requestSubmit() : targetEl.form.submit();
                        enterFallbackUsed = true;
                    } else if (
                        typeof targetEl.click === 'function' &&
                        targetEl.matches('button, a[href], summary, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]')
                    ) {
                        // What Enter does by itself in a browser: it presses
                        // the button or follows the link it is on. In a text
                        // box with no form around it, it does nothing.
                        targetEl.click();
                        enterFallbackUsed = true;
                    }
                }

                targetEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

                // The same key again, as a person taps it several times.
                const times = key === 'Enter' ? 1 : Math.max(1, Math.min(50, Number(data.times) || 1));
                for (let i = 1; i < times && targetEl.isConnected && !cancelRequested; i++) {
                    await delay(25);
                    targetEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
                    if (meta.printable) targetEl.dispatchEvent(new KeyboardEvent('keypress', { ...keyOpts, charCode: key.charCodeAt(0) }));
                    targetEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
                }

                return {
                    success: true,
                    message: `Pressed ${key}${times > 1 ? ` ${times} times` : ''}${id ? ` in [${id}]` : ''}.`,
                };
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
    // =========================================================================
    // What only the user can get past, and waiting for them to get past it
    // =========================================================================

    // Widgets that check a person is visiting, by where they are served from.
    // These are the verification services, not the sites that use them.
    const HUMAN_CHECK_WIDGETS = [
        'iframe[src*="recaptcha/api2/anchor"]', 'iframe[src*="recaptcha/enterprise/anchor"]', 'iframe[src*="recaptcha/api2/bframe"]',
        'iframe[src*="hcaptcha.com"]', 'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="arkoselabs.com"]', 'iframe[src*="funcaptcha"]',
        'iframe[src*="captcha-delivery.com"]', '#px-captcha', '.cf-turnstile', '.h-captcha',
    ].join(', ');

    /**
     * What on this page only the user can do, read from its structure: a
     * sign-in form, a one-time code, card fields, a human check. Nothing
     * here looks at what the page says about itself.
     */
    function detectBlockers() {
        const shown = (sel) => Array.from(document.querySelectorAll(sel)).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
        const out = [];
        if (shown('input[type="password"], input[autocomplete~="current-password"]').length) out.push({ kind: 'sign_in' });
        if (shown('input[autocomplete~="one-time-code"]').length) out.push({ kind: 'code' });
        if (shown('input[autocomplete~="cc-number"], input[autocomplete~="cc-csc"], input[autocomplete~="cc-exp"]').length) out.push({ kind: 'payment' });
        // Fields the policy judges by their names and labels too (sensitiveKind):
        // a code box or card field with no autocomplete is still one.
        const kinds = new Set(out.map((b) => b.kind));
        for (const el of shown('input:not([type="hidden"]), textarea')) {
            if (kinds.has('code') && kinds.has('payment') && kinds.has('sign_in')) break;
            const k = sensitiveKind(el);
            const kind = k === 'password' ? 'sign_in' : k === 'code' || k === 'payment' ? k : '';
            if (kind && !kinds.has(kind)) { kinds.add(kind); out.push({ kind }); }
        }
        // A widget a person can act on: the small badge of a background check is not one.
        const widgets = shown(HUMAN_CHECK_WIDGETS).filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 60 && r.height >= 40 && !el.closest('.grecaptcha-badge'); });
        const text = document.body ? (document.body.innerText || '') : '';
        const wholePage = typeof SELECT_TO_AI_TOOLS !== 'undefined' && SELECT_TO_AI_TOOLS.isChallengePage
            && SELECT_TO_AI_TOOLS.isChallengePage({ title: document.title, url: location.href, innerText: text.slice(0, 2000), elements: Array.from(document.querySelectorAll('a, button, input, select, textarea')).slice(0, 20) });
        if (wholePage) out.push({ kind: 'human_check', whole: true });
        else if (widgets.length) out.push({ kind: 'human_check' });
        return out;
    }

    let needsYouHost = null;
    let needsYouTimer = null;
    let needsYouObserver = null;

    function removeNeedsYou() {
        if (needsYouTimer) clearInterval(needsYouTimer);
        if (needsYouObserver) needsYouObserver.disconnect();
        needsYouTimer = null;
        needsYouObserver = null;
        if (needsYouHost) needsYouHost.remove();
        needsYouHost = null;
        document.querySelectorAll('[data-select-to-ai-press]').forEach((el) => { el.style.outline = el.dataset.selectToAiPress; el.removeAttribute('data-select-to-ai-press'); });
    }

    /** A small banner on the page the agent is waiting on, in its own shadow root. */
    function showNeedsYou(text, done) {
        if (needsYouHost) needsYouHost.remove();
        needsYouHost = document.createElement('div');
        needsYouHost.id = 'select-to-ai-needs-you';
        needsYouHost.style.cssText = 'all: initial; position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;';
        const root = needsYouHost.attachShadow({ mode: 'closed' });
        const bar = document.createElement('div');
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'display: flex; align-items: center; gap: 12px; max-width: min(560px, 92vw); padding: 10px 14px; border-radius: 12px; background: #18181b; color: #fafafa; font: 500 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.28);';
        const dot = document.createElement('span');
        dot.style.cssText = `flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${done ? '#4ade80' : '#fb923c'};`;
        const label = document.createElement('span');
        label.textContent = text;
        bar.append(dot, label);
        if (!done) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = "I'm done";
            button.style.cssText = 'flex: none; border: 0; border-radius: 8px; padding: 6px 10px; background: #fafafa; color: #18181b; font: 600 12px system-ui, sans-serif; cursor: pointer;';
            button.addEventListener('click', () => { try { chrome.runtime.sendMessage({ action: 'agentWaitDone' }); } catch (_) { /* extension reloaded */ } });
            bar.appendChild(button);
        }
        root.appendChild(bar);
        (document.body || document.documentElement).appendChild(needsYouHost);
        if (done) setTimeout(() => { if (needsYouHost) needsYouHost.remove(); needsYouHost = null; }, 1800);
    }

    /**
     * Shows the banner and watches for what was in the way to go: twice in
     * a row with it gone, and the extension is told. Only the structure is
     * looked at while the user works; nothing they type is read.
     *
     * A blocker is only said to be gone once it was seen on this page. A
     * sign-in that asks for the email first has no password box yet, and a
     * hand-off the model chose may name a blocker the structure never shows:
     * such a wait ends with the user's "I'm done", an answer in the panel, or
     * a new page that shows the blocker and then loses it.
     */
    function waitForUser(kind, text, pressId) {
        removeNeedsYou();
        showNeedsYou(text, false);
        const target = pressId ? elementMap[pressId] : null;
        if (target && target.isConnected) {
            target.dataset.selectToAiPress = target.style.outline || '';
            target.style.outline = '3px solid #fb923c';
            target.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
        const startUrl = location.href;
        const present = () => detectBlockers().some((b) => b.kind === kind);
        let had = !!pressId || present();
        const seen = () => { try { chrome.runtime.sendMessage({ action: 'agentBlockerSeen', kind }); } catch (_) { /* extension reloaded */ } };
        if (had && !pressId) seen();
        let clear = 0;
        // A button the user was asked to press: their own click is the signal.
        let pressed = false;
        if (target) target.addEventListener('click', (e) => { if (e.isTrusted) pressed = true; }, { capture: true });
        const check = () => {
            // A control to press that is not in this page's own listing (one
            // inside a frame) cannot be watched from here: the wait is ended
            // by the user's "I'm done", never by its seeming to be gone.
            const still = pressId
                ? !pressed && (target ? target.isConnected && location.href === startUrl : true)
                : present();
            if (still && !had) { had = true; seen(); }
            // Never seen: nothing here can say it is gone.
            if (!had) return;
            clear = still ? 0 : clear + 1;
            if (clear >= 2) {
                removeNeedsYou();
                try { chrome.runtime.sendMessage({ action: 'agentBlockerCleared', kind }); } catch (_) { /* extension reloaded */ }
            }
        };
        needsYouTimer = setInterval(check, 700);
    }

    function clearOverlay() {
        removeNeedsYou();
        try {
            document.querySelectorAll('[data-select-to-ai-q]').forEach((el) => {
                el.removeAttribute('data-select-to-ai-q');
            });
        } catch (_) { /* ignore errors from detached elements */ }

        const container = document.getElementById("select-to-ai-overlay-container");
        if (container) container.remove();
        if (agentCursor) agentCursor.remove();
        if (agentCursorLabel) agentCursorLabel.remove();

        const styles = document.getElementById("select-to-ai-agent-styles");
        if (styles) styles.remove();

        elementIds = new WeakMap();
        elementMap = {};
        overlayContainer = null;
        highlightOverlay = null;
        agentCursor = null;
        agentCursorLabel = null;
    }

    // =========================================================================
    // Outcome measurement (cheap validator signal)
    // =========================================================================

    /**
     * The open shadow roots on the page, those inside others too, up to a
     * bound. What a component shows inside its own root is part of the
     * page, and a look at the document alone misses it.
     */
    function openRoots() {
        const out = [];
        const into = (root) => {
            let all = [];
            try { all = root.querySelectorAll('*'); } catch (_) { return; }
            for (const el of all) {
                if (out.length >= 60) return;
                const inner = el.shadowRoot;
                if (!inner || agentDrawn(el)) continue;
                out.push(inner);
                into(inner);
            }
        };
        into(document);
        return out;
    }

    /** Captures the page facts an action can change. */
    function captureOutcomeSnapshot() {
        let elementCount = 0;
        try {
            const controls = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]';
            elementCount = document.querySelectorAll(controls).length;
            for (const root of openRoots()) elementCount += root.querySelectorAll(controls).length;
        } catch (_) { /* keep what was counted */ }
        return {
            url: window.location.href,
            title: document.title,
            scrollX: Math.round(window.scrollX || 0),
            scrollY: Math.round(window.scrollY || 0),
            elementCount,
        };
    }

    /**
     * Counts DOM mutations from now until stopped. The quiet-period wait
     * itself is waitForDomStable's job, this only measures how much
     * actually changed while it settles.
     */
    // What the agent itself draws on the page (its cursor, its labels, the
    // numbers it gives controls) is not the page changing.
    function agentDrawn(n) {
        let el = n && n.nodeType === 1 ? n : n && n.parentElement;
        // Inside a shadow root the host is what was put on the page.
        const root = el && el.getRootNode ? el.getRootNode() : null;
        if (root && root !== document && root.host) el = root.host;
        return !!el && (el === agentCursor || el === agentCursorLabel || el === needsYouHost || el.id === 'select-to-ai-agent-bar'
            || (overlayContainer && overlayContainer.contains(el))
            || (typeof el.className === 'string' && el.className.indexOf('select-to-ai') >= 0));
    }

    function createMutationCounter() {
        let count = 0;
        let observer = null;
        try {
            const own = agentDrawn;
            observer = new MutationObserver((records) => {
                for (const r of records) {
                    if (r.type === 'attributes' && String(r.attributeName || '').startsWith('data-select-to-ai')) continue;
                    if (own(r.target)) continue;
                    if (r.type === 'childList' && r.target === document.body
                        && [...r.addedNodes, ...r.removedNodes].every(own)) continue;
                    count++;
                }
            });
            const what = { childList: true, subtree: true, attributes: true, characterData: true };
            observer.observe(document.body, what);
            // A change inside a component's own root does not reach the body's observer.
            for (const root of openRoots()) { try { observer.observe(root, what); } catch (_) { /* that root is left out */ } }
        } catch (_) { /* observation unavailable; count stays 0 */ }

        return {
            stop() {
                try { if (observer) observer.disconnect(); } catch (_) { /* ignore */ }
                return count;
            },
        };
    }

    // =========================================================================
    // Settling: what the page does by itself, and what an action set off
    // =========================================================================

    const SETTLE_TOOLS = typeof SELECT_TO_AI_TOOLS !== 'undefined' && SELECT_TO_AI_TOOLS.settleVerdict ? SELECT_TO_AI_TOOLS : null;
    // The start of the action being settled; 0 while the agent is not acting.
    let actingSince = 0;
    // The last change to the page that counts as the action's doing.
    let lastChangeAt = 0;
    // Elements the page changed while the agent was not acting: { first, last, count }.
    let idleChanges = new WeakMap();
    // Elements whose words alone changed during this action: { last, count }.
    let actionTicks = new WeakMap();
    // A change is a separate moment when it comes this long after the last one.
    const MOMENT_MS = 300;
    // An element whose words alone change at this many separate moments, at
    // least TICK_MS apart, during an action is a counter or a clock.
    const TICKS = 3;
    const TICK_MS = 500;

    // The page's own requests, for a browser with no network view to give.
    // A small function the engine runs in the page's own world
    // (core/inject.js, netShim) says when each fetch and XMLHttpRequest
    // call begins and ends. They are counted here the way the engine counts
    // the debugger's, so what a page asks for by itself is told from what
    // an action made it ask for.
    // The name is made anew for each page, and only the engine is told it
    // (with the listing), so a page cannot speak under it by knowing it.
    const NET_EVENT = (() => {
        try { return `n${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`; } catch (_) { return `n${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`; }
    })();
    const pageNet = SETTLE_TOOLS && SETTLE_TOOLS.createNetworkTracker ? SETTLE_TOOLS.createNetworkTracker() : null;
    // True once that function has said it is there.
    let pageNetAlive = false;
    const pageNetOpen = new Set();
    // When the page last began a request of any kind, its background ones too.
    let pageNetLastStart = 0;

    // The page's browser dialogs (alert, confirm, prompt), said by the same
    // function in the page's world. From the agent's first look or action
    // on the page until the run hands it to the user (needsYou) or lets it
    // go (clear), a dialog is answered as closing it would answer it, and
    // kept here to tell the agent; at any other time the page's own dialog
    // opens for the user as it always did. A step can take minutes with a
    // slow model, so the hold is not timed by the step: DIALOG_HOLD_MS is
    // only a cap for a run that ended without saying so (its worker
    // stopped), after which the page's dialogs are the user's again. The
    // check before leaving a page is never answered here (core/inject.js).
    let pageDialogsAlive = false;
    let pageDialogs = [];
    let dialogsHeldUntil = 0;
    const DIALOG_HOLD_MS = 180000;

    /** One thing the page's world said about its requests. Anything else a page sends under that name is left alone. */
    function onPageNet(e) {
        let said = null;
        try { said = JSON.parse(String(e.detail || '')); } catch (_) { return; }
        if (!said || typeof said !== 'object') return;
        if (said.t === 'hello') {
            // Said even with no count to keep here, so the count is not sent again on every look.
            if (said.net !== false) pageNetAlive = true;
            if (said.dialogs) pageDialogsAlive = true;
            return;
        }
        if (said.t === 'dialog') {
            const kind = ['alert', 'confirm', 'prompt'].includes(said.kind) ? said.kind : '';
            if (!kind || !(actingSince > 0 || Date.now() < dialogsHeldUntil)) return;
            // Cancelled: the page's world closes it as a person closing it would.
            try { e.preventDefault(); } catch (_) { return; }
            if (pageDialogs.length < 10) pageDialogs.push({ kind, text: String(said.text || '').slice(0, 300), at: Date.now() });
            return;
        }
        if (!pageNet) return;
        const id = String(said.id || '').slice(0, 40);
        if (!id) return;
        if (said.t === 'start' && (said.kind === 'Fetch' || said.kind === 'XHR') && pageNetOpen.size < 200) {
            let url = String(said.url || '').slice(0, 300);
            try { url = new URL(url, location.href).href; } catch (_) { /* counted under what it was given as */ }
            pageNetOpen.add(id);
            pageNetLastStart = Date.now();
            pageNet.started(id, url, said.kind, pageNetLastStart);
        } else if (said.t === 'end' && pageNetOpen.delete(id)) {
            pageNet.ended(id, Date.now());
        }
    }

    /** The dialogs the page opened since they were last told, which are then let go. */
    function takeDialogs() {
        const out = pageDialogs;
        pageDialogs = [];
        return out;
    }

    /** The agent is working on the page: its dialogs are answered for the next DIALOG_HOLD_MS. 0 gives them back to the user. */
    function holdDialogs(ms) {
        dialogsHeldUntil = ms > 0 ? Date.now() + ms : 0;
    }

    /**
     * The requests an action begun at `since` started, as the page's own
     * world counted them: { open, quietFor, asked }, or null when nothing
     * is counting. `asked` is whether it started any at all.
     */
    function pageRequests(since, now) {
        if (!pageNet || !pageNetAlive) return null;
        const st = pageNet.state(since, now);
        return { ...st, asked: st.open > 0 || st.quietFor < now - since };
    }

    /**
     * Starts listening to the page's world, and reads what the page asked
     * for before this script arrived from the browser's own record of it,
     * so an address the page asks for again and again by itself is known as
     * its background from the first action on.
     */
    function watchRequests() {
        // The page's dialogs come under the same name, so the listener is
        // there even when there is no count of requests to keep.
        document.addEventListener(NET_EVENT, onPageNet, true);
        if (!pageNet) return;
        try {
            for (const r of performance.getEntriesByType('resource')) {
                if (r.initiatorType !== 'fetch' && r.initiatorType !== 'xmlhttprequest') continue;
                const id = `past ${r.startTime}`;
                pageNet.started(id, r.name, r.initiatorType === 'fetch' ? 'Fetch' : 'XHR', performance.timeOrigin + r.startTime);
                pageNet.ended(id, performance.timeOrigin + (r.responseEnd || r.startTime));
            }
        } catch (_) { /* no record: the count starts now */ }
    }

    /** An element the page changes over and over by itself: a clock, a feed, a rotating panel. */
    function changesByItself(el, now) {
        const rec = idleChanges.get(el);
        return !!rec && rec.count >= 2 && now - rec.last <= 20000;
    }

    /**
     * Watches the page for as long as this script lives. Between actions it
     * learns which elements the page keeps changing by itself; during an
     * action it records when anything else last changed. Attribute changes
     * (styles, classes: animation) are left out; added or removed nodes and
     * changed words are what a page shows new things with.
     */
    function watchPage() {
        try {
            const observer = new MutationObserver((records) => {
                const now = Date.now();
                for (const r of records) {
                    const el = r.target && r.target.nodeType === 1 ? r.target : r.target && r.target.parentElement;
                    if (!el || agentDrawn(r.target)) continue;
                    const moved = r.type === 'childList' ? [...r.addedNodes, ...r.removedNodes] : [];
                    if (moved.length && moved.every(agentDrawn)) continue;
                    if (!actingSince) {
                        let rec = idleChanges.get(el);
                        if (!rec || now - rec.last > 20000) rec = { first: now, last: 0, count: 0 };
                        if (now - rec.last >= MOMENT_MS) { rec.count += 1; rec.last = now; }
                        idleChanges.set(el, rec);
                        continue;
                    }
                    if (changesByItself(el, now)) continue;
                    const wordsOnly = r.type === 'characterData' || (moved.length > 0 && moved.every((n) => n.nodeType === 3));
                    if (wordsOnly) {
                        const t = actionTicks.get(el) || { last: 0, count: 0 };
                        if (now - t.last >= TICK_MS) { t.count += 1; t.last = now; }
                        actionTicks.set(el, t);
                        if (t.count > TICKS) continue;
                    }
                    lastChangeAt = now;
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        } catch (_) { /* nothing to watch; settling falls back to the quiet period */ }
    }

    /** Shown on the page: has size, and is not hidden or see-through. */
    function shownNow(el) {
        try {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom + (window.scrollY || 0) <= 0) return false;
            if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
            const st = getComputedStyle(el);
            return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
        } catch (_) { return false; }
    }

    /**
     * What the page marks as still working, by structure, in any language:
     * a region marked aria-busy, a progress bar that is not full, and an
     * animation that repeats without end (a spinner, a placeholder's
     * shimmer). Each is keyed by the thing itself, so those present before
     * an action can be told from those it brought up.
     */
    function busyMarks() {
        const out = new Map();
        try {
            for (const el of document.querySelectorAll('[aria-busy="true"]')) if (!agentDrawn(el) && shownNow(el)) out.set(el, 'busy');
            for (const el of document.querySelectorAll('[role="progressbar"], progress')) {
                if (agentDrawn(el) || !shownNow(el)) continue;
                const now = Number(el.tagName === 'PROGRESS' ? (el.hasAttribute('value') ? el.value : NaN) : el.getAttribute('aria-valuenow'));
                const max = Number(el.tagName === 'PROGRESS' ? el.max : (el.getAttribute('aria-valuemax') || 100));
                if (Number.isFinite(now) && Number.isFinite(max) && now >= max) continue; // full: done
                out.set(el, 'progress');
            }
            if (typeof document.getAnimations === 'function') {
                for (const a of document.getAnimations()) {
                    const fx = a.effect;
                    const timing = fx && fx.getComputedTiming ? fx.getComputedTiming() : null;
                    if (!timing || timing.iterations !== Infinity || a.playState !== 'running') continue;
                    const el = fx.target;
                    if (!el || agentDrawn(el) || !shownNow(el)) continue;
                    out.set(a, 'animation');
                }
            }
        } catch (_) { /* what could be read is kept */ }
        return out;
    }

    /**
     * The requests the action started, as the extension sees them through
     * the browser's network view of this tab: { open, quietFor }, or null
     * when that view is not available.
     */
    function askNetwork(since) {
        return new Promise((resolve) => {
            let answered = false;
            const finish = (v) => { if (!answered) { answered = true; resolve(v); } };
            if (!chrome.runtime || !chrome.runtime.id) { finish(null); return; }
            setTimeout(() => finish(null), 250);
            try {
                chrome.runtime.sendMessage({ action: 'agentNetState', since }, (r) => {
                    void (chrome.runtime && chrome.runtime.lastError);
                    finish(r && r.net ? { open: Number(r.open) || 0, quietFor: Number(r.quietFor) || 0, asked: !!r.asked } : null);
                });
            } catch (_) { finish(null); }
        });
    }

    /**
     * Waits until the page has finished what the action started: nothing it
     * started is open on the network, no new busy mark is showing, and the
     * page has not changed for the quiet period; or until the ceiling. The
     * requests are the browser's view of the tab where the engine has one,
     * else the page's own count of them, else not known.
     * Returns { ms, loading, signs, network, asked }: `network` is whether
     * the requests could be seen, `asked` whether the action started any.
     */
    async function settleAfterAction(since, busyBefore) {
        const T = SETTLE_TOOLS;
        const S = T.SETTLE;
        const begun = Date.now();
        let far = await askNetwork(since);
        let net = far || pageRequests(since, Date.now());
        let asked = !!(net && net.asked);
        let verdict = { done: false, signs: [] };
        for (;;) {
            await new Promise((r) => setTimeout(r, 100));
            // The engine's view can go away (the user closed the debugging bar): the page's count is used from then on.
            if (far) far = await askNetwork(since);
            const now = Date.now();
            net = far || pageRequests(since, now);
            if (net && net.asked) asked = true;
            // With no requests in view, what the page shows is all there is.
            const ceiling = net ? S.CEILING_MS : S.FALLBACK_MS;
            const busy = [];
            for (const [k, kind] of busyMarks()) if (!busyBefore.has(k)) busy.push(kind);
            // An endless animation says little by itself: a carousel or a
            // pulsing badge looks the same as a spinner. It holds the wait
            // only while the network view shows the page still fetching, or,
            // with no such view, for six seconds.
            const fetching = !!(net && net.open > 0);
            if (busy.includes('animation') && !fetching && (net || now - begun > 6000)) busy.splice(0, busy.length, ...busy.filter((k) => k !== 'animation'));
            verdict = T.settleVerdict({ elapsed: now - begun, domQuietFor: now - Math.max(since, lastChangeAt), busy, net });
            if (verdict.done || cancelRequested) return { ms: now - begun, loading: false, network: !!net, asked };
            if (now - begun >= ceiling) return { ms: now - begun, loading: true, signs: verdict.signs, network: !!net, asked };
        }
    }

    /** Fallback outcome-delta computation mirroring SELECT_TO_AI_TOOLS. */
    function fallbackComputeOutcomeDelta(before, after, mutationCount) {
        const urlChanged = before.url !== after.url;
        const titleChanged = before.title !== after.title;
        const scrollChanged =
            Math.abs(after.scrollY - before.scrollY) > 2 ||
            Math.abs(after.scrollX - before.scrollX) > 2;
        const newElementCount = after.elementCount - before.elementCount;
        return {
            urlChanged,
            titleChanged,
            domMutationCount: mutationCount,
            newElementCount,
            scrollChanged,
            noEffect:
                !urlChanged && !titleChanged && !scrollChanged &&
                mutationCount === 0 && newElementCount === 0,
        };
    }

    // =========================================================================
    // A press the page did not answer
    // =========================================================================
    //
    // A press made by script is not a person's press, and a page can ignore
    // it. When a press changed nothing, and nothing says the page took it,
    // it is made the next way before the result is given: with the keyboard
    // (the focus on the control, then Enter, then Space). The result says
    // which way the page answered, or that no change was seen after any.
    // A way is tried only while nothing at all says the page took the one
    // before, so a press that worked out of sight (a request sent, a form
    // sent, a field's value changed, a box scrolled, something changed
    // inside a component) is not made twice. A page can also act on a press
    // a while after it (a timer, a request the count does not see), so the
    // page is watched a while longer before each key, and a key is sent
    // only when the page allows that key on that control as it allowed the
    // click (the engine says so with the press). The control's own click() is
    // never called on top: it runs the very listeners the pointer's click
    // already ran, so a control that took the first would act twice. Where
    // what a press does cannot be seen at all (a drawing on the page), no
    // other way is tried.

    /**
     * Watches for a press taking effect where the page itself shows no
     * change: the page begins to go elsewhere, a form is sent, another
     * window takes the user's eye, or something starts or stops playing.
     * stop() ends the watch and returns what was seen.
     */
    function watchTaken() {
        const seen = new Set();
        const going = () => seen.add('navigation');
        const sent = () => seen.add('form');
        const away = (e) => { if (e.type !== 'blur' || e.target === window) seen.add('window'); };
        const playing = () => Array.from(document.querySelectorAll('video, audio')).map((m) => `${m.paused}${m.muted}`).join();
        const was = { playing: playing(), full: document.fullscreenElement || null };
        const nav = window.navigation && typeof window.navigation.addEventListener === 'function' ? window.navigation : null;
        if (nav) nav.addEventListener('navigate', going);
        window.addEventListener('beforeunload', going, true);
        window.addEventListener('submit', sent, true);
        window.addEventListener('blur', away, true);
        document.addEventListener('visibilitychange', away, true);
        let stopped = false;
        return {
            stop() {
                if (stopped) return [...seen];
                stopped = true;
                if (nav) nav.removeEventListener('navigate', going);
                window.removeEventListener('beforeunload', going, true);
                window.removeEventListener('submit', sent, true);
                window.removeEventListener('blur', away, true);
                document.removeEventListener('visibilitychange', away, true);
                if (playing() !== was.playing || (document.fullscreenElement || null) !== was.full) seen.add('media');
                return [...seen];
            },
        };
    }

    /** The value every field on the page holds, in open shadow roots too, as one string to compare. */
    function fieldsNow() {
        const out = [];
        try {
            for (const root of [document, ...openRoots()]) {
                for (const f of root.querySelectorAll('input, select, textarea')) {
                    if (out.length >= 400) break;
                    out.push(`${f.type === 'password' ? String(f.value || '').length : f.value}\u0001${f.checked ? 1 : 0}`);
                }
            }
        } catch (_) { /* what could be read is compared */ }
        return out.join('\u0002');
    }

    /** The element holding the focus, followed into shadow roots. */
    function focusNow() {
        let a = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a || null;
    }

    /**
     * Watches for what a press can do that neither the page's elements nor
     * its counted requests show: a field given a new value by the page's
     * code, a box inside the page scrolled, the focus moved, anything at
     * all fetched (a request the page makes by itself at other times, or
     * through a function it kept from before the count began, is still in
     * the browser's own record). A drawing on the page is 'canvas' from
     * the start: what a press redraws in it cannot be seen. stop() ends
     * the watch and returns what was seen. Any of it means the press is
     * not made another way.
     */
    function watchUnseen() {
        const seen = new Set();
        const fields = fieldsNow();
        const focus = focusNow();
        const since = Date.now();
        try {
            for (const c of document.querySelectorAll('canvas')) {
                const r = c.getBoundingClientRect();
                if (r.width * r.height >= 10000 && shownNow(c)) { seen.add('canvas'); break; }
            }
        } catch (_) { /* none found */ }
        const scrolled = (e) => { if (!agentDrawn(e.target)) seen.add('scroll'); };
        const roots = [document, ...openRoots()];
        for (const root of roots) root.addEventListener('scroll', scrolled, true);
        // What the extension itself loads into the page (its own pictures) is not the page fetching.
        const theirs = (list) => list.some((e) => !/^(chrome-extension|data):/.test(String((e && e.name) || '')));
        // The record is read two ways: as it is added to, and by its length at the end.
        const recorded = () => { try { return typeof performance === 'object' && performance.getEntriesByType ? performance.getEntriesByType('resource') : []; } catch (_) { return []; } };
        const had = recorded().length;
        let loads = null;
        try {
            if (typeof PerformanceObserver === 'function') {
                loads = new PerformanceObserver((list) => { if (theirs(list.getEntries())) seen.add('request'); });
                loads.observe({ type: 'resource' });
            }
        } catch (_) { loads = null; }
        let stopped = false;
        return {
            stop() {
                if (stopped) return [...seen];
                stopped = true;
                for (const root of roots) root.removeEventListener('scroll', scrolled, true);
                try { if (loads) { if (theirs(loads.takeRecords())) seen.add('request'); loads.disconnect(); } } catch (_) { /* nothing more to read */ }
                if (pageNetLastStart >= since) seen.add('request');
                const now = recorded();
                if (now.length > had && theirs(now.slice(had))) seen.add('request');
                if (fieldsNow() !== fields) seen.add('value');
                if (focusNow() !== focus) seen.add('focus');
                return [...seen];
            },
        };
    }

    /** One key sent to a control by script: down, pressed and up. False when the page cancelled it. */
    function scriptKey(el, key) {
        const meta = resolveKeyMeta(key);
        const opts = { key, code: meta.code, keyCode: meta.keyCode, which: meta.keyCode, bubbles: true, cancelable: true, composed: true, view: window };
        const down = el.dispatchEvent(new KeyboardEvent('keydown', opts));
        const pressed = el.dispatchEvent(new KeyboardEvent('keypress', { ...opts, charCode: meta.keyCode }));
        const up = el.dispatchEvent(new KeyboardEvent('keyup', opts));
        return down && pressed && up;
    }

    /**
     * True for a control a press does something to, so that a press which
     * changed nothing may be made another way: it is on the page and
     * switched on, it is not a box that only takes the cursor, it is not
     * a surface that draws its own inside, where a press means a point,
     * and it is not marked as the one already chosen (the open tab, the
     * current page's link), where a press rightly does nothing.
     */
    function takesPress(el) {
        if (!el || !el.isConnected || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (el.isContentEditable || /^(TEXTAREA|SELECT|CANVAS|VIDEO|AUDIO|IFRAME|OBJECT|EMBED)$/.test(el.tagName)) return false;
        if (el.tagName === 'INPUT' && !/^(button|submit|reset|image|checkbox|radio|file)$/.test((el.type || 'text').toLowerCase())) return false;
        const current = el.getAttribute('aria-current');
        if (el.getAttribute('aria-selected') === 'true' || (current && current !== 'false')) return false;
        return true;
    }

    /**
     * True when nothing at all says the page took a press. `m` is what was
     * measured after it: { changed, cancelled, taken, unseen, network,
     * asked, loading }. A page whose requests cannot be seen is never
     * judged to have ignored a press: it may be waiting for an answer to it.
     */
    function unanswered(m) {
        return !!m && !m.changed && !m.cancelled && !(m.taken || []).length && !(m.unseen || []).length && !!m.network && !m.asked && !m.loading;
    }

    /**
     * Makes a press the page did not answer the next way, and the next.
     * `first` is what was measured after the press by pointer events;
     * `pressBy(way)` presses that way and resolves what was measured after
     * it, or null when that way cannot be used here; `pressBy('wait')`
     * presses nothing and watches the page a while longer. Returns null
     * when the first press was answered or cannot be judged, or no other
     * way could be used; else { tried, by, seen, last }: the ways tried in
     * order, the way the page took (null when it took none; 'pointer' when
     * the first press was answered late), and whether a change was seen
     * after it.
     */
    async function otherPressWays(first, pressBy) {
        const tried = ['pointer'];
        let last = first;
        for (const way of ['Enter', 'Space']) {
            if (!unanswered(last) || cancelRequested) break;
            // The page may yet act on the press before: it is given longer, and anything it then does is that press's answer.
            const late = await pressBy('wait');
            if (late && !unanswered(late)) return { tried, by: tried[tried.length - 1], seen: !!late.changed, last: late };
            if (cancelRequested) break;
            const m = await pressBy(way);
            if (!m) continue;
            tried.push(way);
            last = m;
            if (last.changed) return { tried, by: way, seen: true, last };
        }
        if (tried.length === 1) return null;
        return unanswered(last) ? { tried, by: null, seen: false, last } : { tried, by: tried[tried.length - 1], seen: false, last };
    }

    /**
     * The other ways for one control, as the page's handler runs them:
     * { ways, waited }, what otherPressWays returned and how long the page
     * was watched over all of them. A way that cannot be used here adds
     * nothing.
     */
    async function pressWays(el, first, busyBefore, compute) {
        let waited = 0;
        const ways = await otherPressWays(first, async (way) => {
            const m = await pressBy(el, way, busyBefore, compute);
            if (m) waited += m.ms;
            return m;
        });
        return { ways, waited };
    }

    /** True for a control the keyboard can reach, so a key may follow a press on it. */
    function takesFocus(el) {
        return !!el && (el.tabIndex >= 0 || el.hasAttribute('tabindex'));
    }

    /** Waits until the page changes or asks for something, or the longer watch for a late answer is over. */
    async function laterSign(since) {
        const until = since + ((SETTLE_TOOLS && SETTLE_TOOLS.SETTLE.SECOND_PRESS_MS) || 2000);
        while (Date.now() < until && !cancelRequested && lastChangeAt < since && pageNetLastStart < since) await new Promise((r) => setTimeout(r, 100));
    }

    /**
     * Presses a control one way and measures what the page did: 'Enter' or
     * 'Space' with the focus on it; 'focus' only puts the focus on it (for
     * a hover that brought nothing up); 'wait' presses nothing and watches
     * the page a while longer for what the press before set off. Null for
     * a key when the control did not take the focus: a key sent to a
     * control that does not hold the focus is not what a person at the
     * keyboard can do. Null for the wait when no key can follow it.
     */
    async function pressBy(el, way, busyBefore, compute) {
        if (way === 'wait' && !takesFocus(el)) return null;
        // The focus goes on first for a key, so that what is measured is
        // what the key did, not what taking the focus did.
        if (way === 'Enter' || way === 'Space') {
            focusField(el);
            if (focusNow() !== el) return null;
        }
        const before = captureOutcomeSnapshot();
        const counter = createMutationCounter();
        const state = stateOf(el);
        const watch = watchTaken();
        const unseen = way === 'focus' ? null : watchUnseen();
        const since = Date.now();
        let cancelled = false;
        try {
            if (way === 'focus') {
                focusField(el);
            } else if (way !== 'wait') {
                cancelled = !scriptKey(el, way === 'Space' ? ' ' : 'Enter');
            }
        } catch (_) { /* a page's own handler threw: what the page then did is measured all the same */ }
        if (way === 'wait') await laterSign(since);
        const settle = await settleAfterAction(since, busyBefore);
        const outcome = compute(before, captureOutcomeSnapshot(), counter.stop());
        // Taking the focus can scroll the control into view, which brings nothing up.
        const onlyScrolled = way === 'focus' && outcome.scrollChanged && !outcome.urlChanged && !outcome.titleChanged && !outcome.domMutationCount && !outcome.newElementCount;
        const changed = (!outcome.noEffect && !onlyScrolled) || !el.isConnected || stateOf(el) !== state;
        return { changed, cancelled, taken: watch.stop(), unseen: unseen ? unseen.stop() : [], outcome, settle, ms: Date.now() - since, network: !!settle.network, asked: !!settle.asked, loading: !!settle.loading };
    }

    /** Actions whose real page effect should be measured. */
    const MEASURED_ACTIONS = new Set([
        'click', 'double_click', 'right_click', 'hover', 'type', 'fill_form', 'clear',
        'select_option', 'checkbox_toggle', 'keypress', 'scroll', 'fill', 'drag', 'click_at',
    ]);

    // =========================================================================
    // Message Listener
    // =========================================================================

    /**
     * The frames worth reading as part of this page: one that is drawn on
     * top of it (a consent notice served by another site is the common
     * case), or one that fills a good part of the window. A frame that is a
     * human check is never one of them.
     */
    let frameCandidates = [];
    function findFrames() {
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        const out = [];
        const add = (frame, onTop) => {
            if (!frame || out.some((f) => f.el === frame) || !frame.contentWindow) return;
            try { if (frame.matches(HUMAN_CHECK_WIDGETS) || frame.closest('.cf-turnstile, .h-captcha, #px-captcha')) return; } catch (_) { return; }
            const r = frame.getBoundingClientRect();
            if (r.width < 120 || r.height < 60) return;
            const label = (frame.getAttribute('title') || frame.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
            out.push({ el: frame, onTop, label, ref: idOf(frame), position: r.bottom < 0 ? 'above-fold' : r.top > vh ? 'below-fold' : 'in-viewport' });
        };
        for (const l of overlayLayers) add(l.node.tagName === 'IFRAME' ? l.node : l.node.querySelector('iframe'), true);
        for (const frame of document.querySelectorAll('iframe')) {
            const r = frame.getBoundingClientRect();
            if (r.width * r.height >= vw * vh * 0.2 && isRendered(frame)) add(frame, !!overlayOf(frame));
        }
        return out.slice(0, 3);
    }

    /**
     * Every frame drawn on this page, where it is in page pixels, and
     * whether it is a human check. A press at a point on one the agent has
     * not read could reach anything inside it.
     */
    function frameAreas() {
        const out = [];
        for (const frame of document.querySelectorAll('iframe')) {
            if (out.length >= 20) break;
            const r = frame.getBoundingClientRect();
            if (r.width < 2 || r.height < 2 || !isRendered(frame)) continue;
            let check = false;
            try { check = frame.matches(HUMAN_CHECK_WIDGETS) || !!frame.closest('.cf-turnstile, .h-captcha, #px-captcha'); } catch (_) { /* keep false */ }
            out.push({ x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), ...(check ? { check: true } : {}) });
        }
        return out;
    }

    /**
     * Where a frame's inside is drawn in this window: its left and top in
     * the window, its drawn width, and the frame as a whole in page pixels.
     * A frame scaled by its page's styles is drawn wider or narrower than it
     * lays out, and that is in the width.
     */
    function frameInside(frame) {
        const r = frame.getBoundingClientRect();
        const cs = getComputedStyle(frame);
        const scale = frame.offsetWidth > 0 ? r.width / frame.offsetWidth : 1;
        const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0, pt = parseFloat(cs.paddingTop) || 0;
        return {
            left: r.left + (frame.clientLeft + pl) * scale,
            top: r.top + (frame.clientTop + pt) * scale,
            width: (frame.clientWidth - pl - pr) * scale,
            area: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
            scrollX: Math.round(window.scrollX || 0),
            scrollY: Math.round(window.scrollY || 0),
        };
    }

    /**
     * The engine placing a frame's points in this window, for the real
     * pointer. The points a gesture aims at are brought on screen here (the
     * frame scrolled itself; its place in this page may not be in view), and
     * what this page draws over the frame at them is named: a press there
     * would reach that, not the frame.
     */
    function frameBox(request) {
        const f = frameCandidates.find((c) => c.token === request.token);
        if (!f || !f.el.isConnected) return { found: false };
        let box = frameInside(f.el);
        const inner = Number(request.inner) || 0;
        const scale = inner > 0 && box.width > 0 ? box.width / inner : 1;
        const place = (p) => ({ x: box.left + p.x * scale, y: box.top + p.y * scale });
        const points = (request.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (points.length) {
            const at = points.map(place);
            const xs = at.map((p) => p.x), ys = at.map((p) => p.y);
            const out = Math.min(...xs) < 0 || Math.min(...ys) < 0 || Math.max(...xs) > window.innerWidth || Math.max(...ys) > window.innerHeight;
            if (out) {
                window.scrollBy({ left: (Math.min(...xs) + Math.max(...xs)) / 2 - window.innerWidth / 2, top: (Math.min(...ys) + Math.max(...ys)) / 2 - window.innerHeight / 2, behavior: 'instant' });
                box = frameInside(f.el);
            }
            for (const p of points.map(place)) {
                const hit = drawnAt(p.x, p.y);
                if (hit !== f.el) return { found: true, ...box, covered: `${nameOfDrawn(hit)} on the page around the frame` };
            }
        }
        return { found: true, ...box };
    }

    watchPage();
    watchRequests();

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const reply = sendResponse;
        // A frame answers only what was sent to it by name; everything else is for the page.
        if (window !== window.top && !request.inFrame) return false;
        if (request.action === 'frameTokens') {
            try {
                frameCandidates = findFrames();
                const frames = frameCandidates.map((f) => {
                    const token = `f${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
                    f.token = token;
                    try { f.el.contentWindow.postMessage({ selectToAiFrame: token }, '*'); } catch (_) { /* a frame that went away */ }
                    return { token, label: f.label, onTop: f.onTop, ref: f.ref, position: f.position };
                });
                sendResponse({ success: true, frames });
            } catch (err) {
                sendResponse({ success: false, frames: [], error: err.message || String(err) });
            }
            return false;
        }
        if (request.action === 'frameBox') {
            try { sendResponse(frameBox(request)); } catch (err) { sendResponse({ found: false, error: err.message || String(err) }); }
            return false;
        }
        if (request.action === 'scan') {
            lastScanRequest = { limit: request.limit, task: request.task, whole: !!request.whole };
            holdDialogs(DIALOG_HOLD_MS);
            try {
                const list = scanInteractiveElements(request.limit || 80, request.task || "", { whole: !!request.whole });
                justFound.clear();
                scanCount++;
                const content = extractPageContent();
                sendResponse({
                    elements: list,
                    hiddenControls: lastScanExtras.hiddenControls,
                    // What is drawn on top of the page, if anything.
                    frames: window === window.top ? findFrames().length : 0,
                    frameAreas: window === window.top ? frameAreas() : [],
                    overlays: overlayLayers.map((l) => ({ where: l.where, name: l.name, framed: l.framed, controls: list.filter((e) => e.onTop && elementMap[e.id] && l.node.contains(elementMap[e.id])).length })),
                    blockers: detectBlockers(),
                    // Whether the page's own world is counting its requests yet (the engine starts that).
                    netView: pageNetAlive,
                    // The name the page's world is to say them under.
                    netEvent: NET_EVENT,
                    // Whether that function answers the page's dialogs yet, and the ones it answered since the last look or action.
                    dialogView: pageDialogsAlive,
                    dialogs: takeDialogs(),
                    whole: !!request.whole,
                    // A tab behind another is not drawn: its animations stand still.
                    inBackground: document.visibilityState === 'hidden',
                    forms: lastScanExtras.forms,
                    url: window.location.href,
                    title: document.title,
                    // A PDF the browser draws in its own viewer has no text here; the engine reads the file (pdfText.js).
                    contentType: document.contentType || '',
                    // A page that is only one embedded PDF: the file's own address, so that file is read and not this page.
                    pdfEmbed: (() => {
                        const one = document.body && document.body.children.length <= 2 ? document.querySelector('body > embed[type="application/pdf"]') : null;
                        const src = one ? String(one.src || '') : '';
                        return /^https?:\/\//i.test(src) ? src : '';
                    })(),
                    innerText: content.text,
                    textFormat: content.format,
                    anchor: content.anchor,
                    media: content.media,
                    outline: content.outline,
                    visibleText: content.visibleText,
                    unseen: content.unseen,
                    scrollX: Math.round(window.scrollX || 0),
                    scrollY: Math.round(window.scrollY || 0),
                    viewportWidth: window.innerWidth || 0,
                    viewportHeight: window.innerHeight || 0,
                    pageHeight: Math.max(
                        document.documentElement ? document.documentElement.scrollHeight : 0,
                        document.body ? document.body.scrollHeight : 0
                    )
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
            // While the agent acts, the browser's own pointer and keys it
            // sends are trusted events like a person's; the bar's watch for
            // the user's own clicks, keys and scrolls (agentBar.js) leaves
            // them out by this mark, kept a moment past the action.
            window.__selectToAiActingUntil = Infinity;
            holdDialogs(DIALOG_HOLD_MS);
            // A dialog the action set off is said with its result, whatever the result is.
            const sendResponse = (r) => {
                window.__selectToAiActingUntil = Date.now() + 300;
                holdDialogs(DIALOG_HOLD_MS);
                const dialogs = takeDialogs();
                reply(r && typeof r === 'object' && dialogs.length ? { ...r, dialogs } : r);
            };
            // Async, must return true to keep the message channel open
            (async () => {
                try {
                    const shouldMeasure = MEASURED_ACTIONS.has(request.data && request.data.action);
                    if (!shouldMeasure) {
                        sendResponse(await performAction(request.data));
                        return;
                    }

                    // Measure the real outcome instead of reporting an
                    // optimistic "clicked successfully": snapshot, act, wait
                    // for the DOM to settle via waitForDomStable
                    // (event-driven, bounded, replaces the old fixed
                    // post-action delays), snapshot again, attach the delta.
                    const before = captureOutcomeSnapshot();
                    const counter = createMutationCounter();
                    // The controls that had a number before the action, to tell which are new after it.
                    const numbered = new Set(lastListed);
                    // The control the action is on (for a key with no
                    // control named, the one holding the cursor), and the
                    // state it shows, to say afterwards what it shows now.
                    const told = /^(click|press|double_click|hover|drag)$/.test(request.data.action);
                    const acted = told ? (elementMap[request.data.id] || (request.data.id === undefined ? document.activeElement : null)) : null;
                    const stateBefore = acted ? stateOf(acted) : '';
                    // What was already busy is the page's own; only what the action brings up is waited for.
                    const busyBefore = SETTLE_TOOLS ? busyMarks() : null;
                    const since = Date.now();
                    actingSince = since;
                    actionTicks = new WeakMap();
                    if (pageNet) pageNet.begin();
                    const compute =
                        typeof SELECT_TO_AI_TOOLS !== "undefined" && SELECT_TO_AI_TOOLS.computeOutcomeDelta
                            ? SELECT_TO_AI_TOOLS.computeOutcomeDelta
                            : fallbackComputeOutcomeDelta;
                    // A press the page does not answer is made another way (see
                    // otherPressWays), unless the user approved this one press.
                    const kind = request.data.action;
                    const again = !!SETTLE_TOOLS && !request.data.once && (kind === 'click' || kind === 'hover');
                    const watch = again && kind === 'click' ? watchTaken() : null;
                    // What a press does out of sight is watched for every click, so the result can say it.
                    const unseenWatch = kind === 'click' && SETTLE_TOOLS ? watchUnseen() : null;
                    let result;
                    try {
                        result = await performAction(request.data);
                        if (result && result.success) {
                            if (SETTLE_TOOLS) result.settle = await settleAfterAction(since, busyBefore);
                            else {
                                const isTyping = request.data.action === 'type';
                                await waitForDomStable(isTyping ? 250 : 350, isTyping ? 1200 : 2200);
                            }
                            result.outcome = compute(before, captureOutcomeSnapshot(), counter.stop());
                            const taken = watch ? watch.stop() : [];
                            const unseen = unseenWatch ? unseenWatch.stop() : [];
                            // A field's new value is the press's doing, and is said (the focus the press itself moves is not).
                            if (unseen.includes('value') && result.outcome.noEffect) taken.push('value');
                            // A request in the browser's own record is one the page made, though the count missed it.
                            if (unseen.includes('request') && result.settle) result.settle.asked = true;
                            if (taken.length) result.taken = taken;
                            const scripted = again && result.pointer === 'synthetic' && !result.opensTab && acted && acted.isConnected;
                            // A key is sent only where the engine found that key allowed on this control (request.data.keys).
                            if (scripted && kind === 'click' && request.data.keys === true && takesPress(acted)) {
                                const first = { changed: !result.outcome.noEffect || stateOf(acted) !== stateBefore, cancelled: !!result.cancelled, taken, unseen: unseen.filter((u) => u !== 'focus'), ...result.settle };
                                const { ways, waited } = await pressWays(acted, first, busyBefore, compute);
                                result.settle = { ...result.settle, ms: result.settle.ms + waited };
                                if (ways) {
                                    result.ways = { tried: ways.tried, by: ways.by, seen: ways.seen };
                                    result.outcome = ways.last.outcome;
                                    result.settle = { ...ways.last.settle, ms: result.settle.ms, ...((ways.last.unseen || []).includes('request') ? { asked: true } : {}) };
                                    // What the page was seen to set off after the last of them is said too.
                                    const after = [...(ways.last.taken || [])];
                                    if ((ways.last.unseen || []).includes('value') && ways.last.outcome.noEffect) after.push('value');
                                    if (after.length) result.taken = [...new Set([...taken, ...after])];
                                }
                            } else if (scripted && kind === 'hover' && result.outcome.noEffect) {
                                // Menus made for the keyboard open with the focus on what opens them.
                                const m = await pressBy(acted, 'focus', busyBefore, compute);
                                result.ways = { tried: ['pointer', 'focus'], by: m.changed ? 'focus' : null, seen: m.changed, hover: true };
                                result.outcome = m.outcome;
                                result.settle = { ...m.settle, ms: result.settle.ms + m.settle.ms };
                            }
                        }
                    } finally {
                        actingSince = 0;
                        if (pageNet) pageNet.end();
                        counter.stop();
                        if (watch) watch.stop();
                        if (unseenWatch) unseenWatch.stop();
                    }
                    if (result && result.success) {
                        if (acted && acted.isConnected && typeof result.message === 'string') {
                            const stateNow = stateOf(acted);
                            if (stateNow && stateNow !== stateBefore) {
                                const n = idOf(acted);
                                result.message += ` ${n ? `[${n}]` : 'The control with the cursor'} is now ${stateNow}.`;
                                result.stateChanged = true;
                            }
                        }
                        // What the action brought up, by the numbers the listing
                        // will give it: a menu's entries, a popover's fields. On
                        // the same page only; a new page is listed whole anyway.
                        if (lastScanRequest && lastScanRequest.whole && !result.outcome.urlChanged && !result.choices && !result.opensTab) {
                            try {
                                const list = scanInteractiveElements(lastScanRequest.limit || 80, lastScanRequest.task || "", { whole: true });
                                const fresh = list.filter((e) => !numbered.has(e.id) && elementMap[e.id]);
                                if (fresh.length) {
                                    fresh.forEach((e) => justFound.add(elementMap[e.id]));
                                    const line = typeof SELECT_TO_AI_TOOLS !== "undefined" && SELECT_TO_AI_TOOLS.formatElementLine ? SELECT_TO_AI_TOOLS.formatElementLine : (e) => `[${e.id}]`;
                                    result.appeared = fresh.slice(0, 8).map((e) => line(e).replace(/^\*/, '').slice(0, 90));
                                    result.appearedMore = Math.max(0, fresh.length - 8);
                                    // Something opened, so the click did more than place the cursor.
                                    if (typeof result.message === 'string') result.message = result.message.replace(' It is a text field: the click only put the cursor in it.', '');
                                }
                            } catch (_) { /* the listing is made again by the next scan */ }
                        }
                    }
                    sendResponse(result);
                } catch (err) {
                    console.error("Select to AI: interact error:", err);
                    sendResponse({ success: false, error: err.message || String(err) });
                }
            })();
            return true; // keep channel open for async sendResponse
        } else if (request.action === 'readText') {
            // The page's text alone, for a tab the user pointed at: no
            // element scan and nothing drawn on the page.
            try {
                const content = extractPageContent();
                sendResponse({ success: true, text: content.text, title: document.title, url: window.location.href });
            } catch (err) {
                sendResponse({ success: false, error: err.message || String(err) });
            }
        } else if (request.action === 'find') {
            try {
                const found = findControls(request.query);
                // Numbered the way the listing numbers them, so what was
                // found can be acted on at once.
                let refs = [];
                if (found.length && lastScanRequest) {
                    scanInteractiveElements(lastScanRequest.limit || 80, lastScanRequest.task || "", { whole: lastScanRequest.whole });
                    refs = lastFound.map((el) => ({ id: idOf(el), label: labelOf(el).slice(0, 60) })).filter((r) => r.id);
                    lastFound.forEach((el) => justFound.add(el));
                }
                sendResponse({ success: true, found, refs, allWords: lastFoundAll });
            } catch (err) {
                sendResponse({ success: false, error: err.message || String(err) });
            }
        } else if (request.action === 'listenerCandidates') {
            // Drawn things nothing marks as controls, not asked about before.
            // They are marked for the engine to ask the browser about, and
            // the marks come off when the answer arrives.
            try {
                const picked = [];
                const all = document.body ? document.body.querySelectorAll('*') : [];
                const high = window.innerHeight || 0, wide = window.innerWidth || 0;
                for (const el of all) {
                    if (picked.length >= 60) break;
                    if (listenerAsked.has(el) || offeredRows.has(el)) continue;
                    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|HR|HTML|BODY|HEAD)$/i.test(el.tagName)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > high || r.right < 0 || r.left > wide) continue;
                    // A whole region is not a thing to press; a listener on it is for what is inside.
                    if (r.width * r.height > wide * high * 0.25) continue;
                    if (typeof el.className === 'string' && el.className.indexOf('select-to-ai') >= 0) continue;
                    if (overlayContainer && overlayContainer.contains(el)) continue;
                    listenerAsked.add(el);
                    if (isElementInteractive(el) || el.closest('a[href], button, input, select, textarea, label, [role="button"], [role="link"], [onclick]')) continue;
                    if (el.querySelector('a[href], button, input, select, textarea')) continue;
                    // The thing itself, not what it is laid out in: a box with
                    // nothing inside it, or with only its own words and a few
                    // small parts. Paragraphs and layout boxes are left out.
                    if (el.children.length > 3 || el.querySelectorAll('*').length > 6) continue;
                    if ((el.innerText || '').trim().length > 60) continue;
                    el.setAttribute('data-select-to-ai-q', String(picked.length));
                    picked.push(el);
                }
                listenerPicked = picked;
                sendResponse({ success: true, count: picked.length });
            } catch (err) { sendResponse({ success: false, count: 0 }); }
        } else if (request.action === 'listenerHits') {
            try {
                const hits = new Set(request.hits || []);
                let added = 0;
                listenerPicked.forEach((el, i) => {
                    el.removeAttribute('data-select-to-ai-q');
                    // The outermost of nested ones: a press on what is inside it reaches it.
                    if (hits.has(i) && !listenerPicked.some((o, j) => j !== i && hits.has(j) && o.contains(el))) { offeredRows.add(el); added++; }
                });
                listenerPicked = [];
                sendResponse({ success: true, added });
            } catch (err) { sendResponse({ success: false, added: 0 }); }
        } else if (request.action === 'probe') {
            // What is in the way on this page, and nothing else about it.
            try { sendResponse({ success: true, blockers: detectBlockers(), url: location.href }); } catch (err) { sendResponse({ success: false, error: err.message || String(err) }); }
        } else if (request.action === 'needsYou') {
            // The user's turn: the page's dialogs are theirs again.
            holdDialogs(0);
            try { waitForUser(request.kind, request.text, request.press); sendResponse({ success: true }); } catch (err) { sendResponse({ success: false, error: err.message || String(err) }); }
        } else if (request.action === 'needsYouDone') {
            removeNeedsYou();
            if (request.text) showNeedsYou(request.text, true);
            sendResponse({ success: true });
        } else if (request.action === 'clear') {
            // Stop/reset: also cancel any in-flight simulated typing.
            cancelRequested = true;
            holdDialogs(0);
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
        }
    });

    // When the user clicks, types or scrolls inside a frame on the page while
    // the agent's own pointer/keys are idle, let the engine's view watch know.
    if (window !== window.top) {
        let lastFrameTouch = 0;
        const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);
        const onSubframeTouch = (e) => {
            if (!e.isTrusted || (window.__selectToAiActingUntil || 0) > Date.now()) return;
            if (e.type === "keydown" && (MODIFIERS.has(e.key) || e.metaKey || e.ctrlKey)) return;
            const now = Date.now();
            if (now - lastFrameTouch < 1000) return;
            lastFrameTouch = now;
            try { chrome.runtime.sendMessage({ action: "agentBarTouched" }, () => { void chrome.runtime.lastError; }); } catch (_e) {}
        };
        for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
            window.addEventListener(type, onSubframeTouch, { capture: true, passive: true });
        }
    }

})();
