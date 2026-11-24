"use strict";
// A label tied to a native checkbox or radio button is what a person
// presses for it. Pages often hide the box itself and draw the label as
// the option, with no pointer cursor, tabindex or click handler on it.
// The lister used to count such a label only by those cues, so the
// options of a filter panel could be listed on one load and missing on
// the next. The label now counts by its structure: its line carries the
// box's state, a press on it is reported as that box's kind, find reaches
// it, and a box that is shown with its label is listed once.
const test = require("node:test");
const assert = require("node:assert/strict");
const { build, CONTENT } = require("../helpers/content-source.js");
const T = require("../../extension/agentTools.js");

/** A `const NAME = new Set([...])` of the content script, as it is there. */
function constSet(name) {
  const at = CONTENT.indexOf(`const ${name} = new Set([`);
  assert.ok(at > 0, `${name} is in agentContentScript.js`);
  const end = CONTENT.indexOf("]);", at);
  return new Function(`return ${CONTENT.slice(at + `const ${name} = `.length, end + 2)};`)();
}

/**
 * A stand-in element. o: { attrs, type, checked, text, hidden, box, parent }.
 * Its style is plain (cursor auto), it has no tabindex and no onclick.
 */
function node(tag, o = {}) {
  const n = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...(o.attrs || {}) },
    type: o.type || "",
    checked: !!o.checked,
    disabled: false,
    required: false,
    value: "",
    placeholder: "",
    title: "",
    alt: "",
    isContentEditable: false,
    onclick: null,
    hidden: !!o.hidden,
    childNodes: [],
    parentElement: null,
    labels: [],
    control: null,
    form: null,
    words: o.text || "",
    box: o.box || [10, 10, 120, 20],
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    checkVisibility() { for (let x = this; x; x = x.parentElement) if (x.hidden) return false; return true; },
    getBoundingClientRect() {
      if (!this.checkVisibility()) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      const [l, t, w, h] = this.box;
      return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h };
    },
    get innerText() { return this.checkVisibility() ? [this.words, ...this.childNodes.map((c) => c.innerText)].filter(Boolean).join(" ") : ""; },
    get textContent() { return [this.words, ...this.childNodes.map((c) => c.textContent)].filter(Boolean).join(" "); },
  };
  if (o.parent) { n.parentElement = o.parent; o.parent.childNodes.push(n); }
  return n;
}

/** A label tied to `input`: by for= when `wraps` is false, by holding it when true. */
function tie(label, input, wraps) {
  label.control = input;
  input.labels.push(label);
  if (wraps) { input.parentElement = label; label.childNodes.push(input); }
  else { input.attrs.id = input.attrs.id || "box"; label.attrs.for = input.attrs.id; }
}

const NAMES = ["checkableOf", "listedThroughControl", "isElementInteractive", "isDrawnOver", "isRendered", "placeOf",
  "stateOf", "stagedOwner", "accessibleName", "labelOf", "findControls"];

function lister(all) {
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: (n) => ({ cursor: "auto", display: n.hidden ? "none" : "inline", visibility: "visible", opacity: "1", pointerEvents: "auto" }),
  };
  const scope = {
    window,
    document: { documentElement: { clientHeight: 800, clientWidth: 1280 }, body: null, getElementById: () => null },
    PRESENTATION_ROLES: constSet("PRESENTATION_ROLES"),
    INTERACTIVE_TAGS: constSet("INTERACTIVE_TAGS"),
    INTERACTIVE_ROLES: constSet("INTERACTIVE_ROLES"),
    offeredRows: new WeakSet(),
    isDrawing: () => false,
    isRowOfLabels: () => false,
    hoverPointers: () => new Set(),
    isNamedByPlace: () => false,
    wordsBeside: () => "",
    sensitiveKind: () => "",
    ENTRY: "input",
    CSS: { escape: (s) => s },
    collectElementsRecursively: () => all,
    textPieces: () => [],
    pinnedElements: new Set(),
    lastFound: [],
    lastFoundAll: false,
  };
  scope.isShown = (n) => fns.isRendered(n) || fns.isDrawnOver(n);
  const fns = build(NAMES, scope);
  // What the scan lists, by the same tests it applies, and the fields its
  // entry gets from a label tied to a box (scanInteractiveElements).
  const listed = () => all.filter((n) => fns.isElementInteractive(n) && scope.isShown(n) && !fns.listedThroughControl(n));
  const entryOf = (n) => {
    const tag = n.tagName.toLowerCase();
    const e = { id: all.indexOf(n) + 1, tagName: tag, inputType: tag === "input" ? n.type : undefined, text: n.innerText, accName: fns.accessibleName(n) };
    if (typeof n.checked === "boolean" && tag === "input") e.checked = n.checked;
    const box = fns.checkableOf(n);
    if (box) { e.controlKind = box.type; e.ariaChecked = String(!!box.checked); }
    return e;
  };
  return { ...fns, listed, entryOf, scope };
}

for (const [how, wraps] of [["by for=", false], ["by holding it", true]]) {
  for (const type of ["checkbox", "radio"]) {
    test(`a label tied ${how} to a hidden ${type} is listed once, with the box's state, and pressing it is a ${type}`, () => {
      const panel = node("div");
      const label = node("label", { text: "Spayed/Neutered", parent: panel });
      const input = node("input", { type, hidden: true, parent: wraps ? null : panel });
      tie(label, input, wraps);
      const l = lister([panel, label, input]);
      assert.deepEqual(l.listed(), [label], "the label stands for the box, and the box is not listed");
      const line = T.formatElementLine(l.entryOf(label));
      assert.match(line, /label "Spayed\/Neutered" checked=false/);
      assert.equal(T.pressKind(l.entryOf(label)), type);
      assert.match(l.stateOf(label), /^not checked$/);
      // What a press on the label does to the box it is tied to.
      input.checked = true;
      assert.match(T.formatElementLine(l.entryOf(label)), /checked=true/);
      assert.match(l.stateOf(label), /^checked$/, "the result of the press reads the new state");
    });
  }
}

test("find on a word of the label returns the label as a control, not text", () => {
  const panel = node("div");
  const black = node("label", { text: "Black & White or Tuxedo", parent: panel });
  const white = node("label", { text: "White", parent: panel });
  const a = node("input", { type: "checkbox", hidden: true, parent: panel, attrs: { id: "a" } });
  const b = node("input", { type: "checkbox", hidden: true, parent: panel, attrs: { id: "b" } });
  tie(black, a, false);
  tie(white, b, false);
  const l = lister([panel, black, white, a, b]);
  const found = l.findControls("White");
  assert.equal(found[0], "White", "the shortest label with every word comes first");
  assert.ok(l.scope.pinnedElements.has(white), "the label stays listed from the next scan on");
});

test("a shown box and its label are one line: the box's, which carries the label's words", () => {
  const panel = node("div");
  const label = node("label", { text: "Gift wrap", parent: panel });
  const input = node("input", { type: "checkbox", parent: label });
  tie(label, input, true);
  const l = lister([panel, label, input]);
  assert.deepEqual(l.listed(), [input]);
  assert.equal(l.accessibleName(input), "Gift wrap");
  assert.deepEqual(l.findControls("Gift wrap").length, 1);
});

test("a box moved off to the side of the page is listed as its label", () => {
  const panel = node("div");
  const label = node("label", { text: "Senior", parent: panel });
  const input = node("input", { type: "checkbox", parent: panel, box: [-9999, 10, 13, 13], attrs: { id: "s" } });
  tie(label, input, false);
  const l = lister([panel, label, input]);
  assert.ok(l.listed().includes(label));
});

test("a label for a text box is not made a control", () => {
  const form = node("form");
  const label = node("label", { text: "Postcode", parent: form });
  const input = node("input", { type: "text", parent: form, attrs: { id: "pc" } });
  tie(label, input, false);
  const l = lister([form, label, input]);
  assert.equal(l.checkableOf(label), null);
  assert.equal(l.isElementInteractive(label), false);
  assert.deepEqual(l.listed(), [input]);
  assert.equal(T.pressKind(l.entryOf(label)), "button", "only its own markup speaks for it");
});

test("a label tied to a box in a form with its own submit is staged in that form", () => {
  const form = node("form");
  const label = node("label", { text: "Kitten", parent: form });
  const input = node("input", { type: "checkbox", hidden: true, parent: form, attrs: { id: "k" } });
  input.form = form;
  tie(label, input, false);
  const l = lister([form, label, input]);
  assert.equal(l.stagedOwner(label, false), form);
});
