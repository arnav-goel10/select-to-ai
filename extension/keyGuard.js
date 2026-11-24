/**
 * Select to AI: keys and focus around things that arrive on their own.
 *
 * A card, a dialog or a control the page shows by itself (an approval, a
 * question, a selection) may arrive while the user is typing. Two rules
 * keep their keys where they meant them:
 *
 * 1. Nothing the page shows by itself takes focus from a field the user is
 *    typing in (offerFocus). A card is announced to screen readers instead.
 * 2. A card's buttons do not act on a key press that began before the card
 *    had been on screen, and the page in view, for ARM_MS (guardKeys). A
 *    held key's repeats never count. A pointer press is not affected: it
 *    has to begin on the button, so it cannot begin before the button was there.
 */
(function (root) {
  "use strict";

  // How long a card is on screen before a key press can act on it.
  const ARM_MS = 500;
  // Inputs whose keys do not type text.
  const NOT_TYPED = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"]);

  /** True for an element the user types text into. */
  function isTypingField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag === "INPUT") return !NOT_TYPED.has(String(el.type || "text").toLowerCase()) && !el.disabled && !el.readOnly;
    const role = String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
    return role === "textbox" || role === "searchbox" || role === "combobox";
  }

  /** The element that has focus, inside shadow roots too. */
  function activeIn(doc) {
    let a = doc && doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a || null;
  }

  /** True when focus may be moved without taking it from a field being typed in. */
  const focusIsFree = (doc) => !isTypingField(activeIn(doc));

  /** Moves focus to `target` unless the user is typing in a field; says whether it did. */
  function offerFocus(doc, target) {
    if (!target || typeof target.focus !== "function" || !focusIsFree(doc)) return false;
    target.focus({ preventScroll: true });
    return true;
  }

  const isActivationKey = (key) => key === "Enter" || key === " " || key === "Spacebar";

  /**
   * Whether a click on a guarded button counts. `click` is {trusted, detail};
   * `armedAt` is when the card had been in view for ARM_MS (Infinity before);
   * `key` is the last Enter or Space press {downAt, upAt, repeat} or null.
   * A click from a pointer (detail above 0) or from the page's own script
   * always counts. A keyboard click counts only once the card is armed, and
   * only from a key that went down after that and was not a held repeat.
   */
  function clickCounts(click, armedAt, now, key) {
    if (!click.trusted || click.detail > 0) return true;
    if (!(now >= armedAt)) return false;
    // The key behind this click: one still down, or let go a moment ago (Space acts on release).
    const behind = key && (key.upAt === null || now - key.upAt < 100) ? key : null;
    if (behind && (behind.repeat || behind.downAt < armedAt)) return false;
    return true;
  }

  /**
   * Guards the buttons inside `card`. `watch` is the part that must be in
   * view (the row of buttons). Returns a function that stops the guard.
   */
  function guardKeys(card, watch, options) {
    const o = options || {};
    const win = o.win || root;
    const doc = card.ownerDocument;
    const armMs = o.armMs === undefined ? ARM_MS : o.armMs;
    const now = o.now || (() => win.performance.now());
    let inView = false;
    let armedAt = Infinity;
    let key = null;
    const pageShown = () => !doc || doc.visibilityState === undefined || doc.visibilityState === "visible";
    const update = () => {
      if (inView && pageShown()) { if (armedAt === Infinity) armedAt = now() + armMs; }
      else armedAt = Infinity;
    };
    const onKeyDown = (e) => { if (isActivationKey(e.key)) key = { downAt: e.timeStamp || now(), upAt: null, repeat: !!e.repeat || (key !== null && key.upAt === null) }; };
    const onKeyUp = (e) => { if (isActivationKey(e.key) && key) key.upAt = e.timeStamp || now(); };
    const onClick = (e) => {
      const t = e.target;
      const button = t && t.closest ? t.closest("button") : null;
      if (!button || !card.contains(button)) return;
      if (clickCounts({ trusted: e.isTrusted, detail: e.detail }, armedAt, now(), key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    let observer = null;
    if (typeof win.IntersectionObserver === "function") {
      observer = new win.IntersectionObserver((entries) => {
        for (const entry of entries) inView = entry.isIntersecting && entry.intersectionRatio >= 0.99;
        update();
      }, { threshold: [0, 0.99, 1] });
      observer.observe(watch || card);
    } else {
      inView = true;
      update();
    }
    const onVisibility = () => update();
    // Keys are watched on the whole page: the press may begin in another field.
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("keyup", onKeyUp, true);
    doc.addEventListener("visibilitychange", onVisibility);
    card.addEventListener("click", onClick, true);
    return function stop() {
      if (observer) observer.disconnect();
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("keyup", onKeyUp, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      card.removeEventListener("click", onClick, true);
    };
  }

  const api = Object.freeze({ ARM_MS, isTypingField, focusIsFree, offerFocus, clickCounts, guardKeys });
  root.SELECT_TO_AI_KEYS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
