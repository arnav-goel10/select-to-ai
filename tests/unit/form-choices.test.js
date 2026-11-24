"use strict";
// What a form sends besides its boxes, as describeForm counts it: each
// dropdown, each checked radio or tick box, each slider and colour, and
// the controls the page builds of its own inside it. The form check is
// shown the choices the page lists, and a form with more than are listed,
// or with a control of the page's own, is held (agentTools.js unsureSend).
const test = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("../helpers/content-source.js");

/** A stand-in form control. */
function control(tag, o = {}) {
  return {
    tagName: tag.toUpperCase(),
    type: o.type || "",
    checked: !!o.checked,
    disabled: !!o.disabled,
    value: o.value || "",
    isContentEditable: !!o.editable,
    attrs: { ...(o.attrs || {}) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    getBoundingClientRect() { return o.hidden ? { width: 0, height: 0 } : { width: 100, height: 20 }; },
  };
}

function describe(elements, inside) {
  const form = {
    elements,
    attrs: { method: "post", action: "/save" },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    closest: () => null,
    querySelectorAll: () => inside || [],
    action: "https://notes.example/save",
  };
  const { describeForm } = build(["describeForm"], {
    accessibleName: () => "",
    sensitiveKind: () => "",
    location: { href: "https://notes.example/new", origin: "https://notes.example" },
  });
  return describeForm(form);
}

test("a form counts the choices it sends and the controls the page builds inside it", () => {
  const boxes = [control("input", { type: "text", value: "Plan" }), control("textarea", { value: "Q3" })];
  const f = describe([
    ...boxes,
    control("select"),
    control("select", { hidden: true }),
    control("select", { disabled: true }),
    control("input", { type: "radio", checked: true }),
    control("input", { type: "radio", checked: false }),
    control("input", { type: "range" }),
    control("input", { type: "hidden", value: "token" }),
    control("button", { type: "submit" }),
  ]);
  assert.equal(f.plain, true);
  assert.equal(f.fields, 2);
  // Two dropdowns (a hidden one too, not a disabled one), the checked radio and the slider.
  assert.equal(f.choices, 4);
  assert.equal(f.built, 0);
  const g = describe(boxes, [
    control("div", { editable: true, attrs: { contenteditable: "true" } }),
    control("div", { attrs: { role: "textbox" } }),
    control("div", { attrs: { role: "combobox" } }),
    control("span", { attrs: { role: "switch" } }),
    // Not counted: an editable region switched off, and a native box with a role.
    control("div", { attrs: { contenteditable: "false" } }),
    control("input", { type: "text", attrs: { role: "combobox" } }),
  ]);
  assert.equal(g.choices, 0);
  assert.equal(g.built, 4);
});

test("a control the page builds is counted by what it marks itself as holding, not by a list of a few roles", () => {
  const boxes = [control("input", { type: "text", value: "Plan" }), control("textarea", { value: "Q3" }), control("button", { type: "submit" })];
  const hiddenValue = control("input", { type: "hidden", value: "everyone" });
  // A custom element with no value, name or state of its own: a wrapper for layout.
  const wrapper = () => ({ tagName: "APP-CARD", attrs: {}, isContentEditable: false, getAttribute() { return null; } });
  const shapes = {
    // A dropdown button backed by a hidden field (the Headless UI Listbox shape).
    "a button that opens a list": [[hiddenValue], [control("button", { type: "button", attrs: { "aria-haspopup": "listbox", "aria-expanded": "false" } })]],
    "a list with a chosen option": [[hiddenValue], [control("div", { attrs: { role: "listbox" } }), control("div", { attrs: { role: "option", "aria-selected": "true" } })]],
    "a toggle button": [[hiddenValue], [control("button", { type: "button", attrs: { "aria-pressed": "true" } })]],
    "a checked menu radio": [[hiddenValue], [control("div", { attrs: { role: "menuitemradio", "aria-checked": "true" } })]],
    "a radio group": [[], [control("div", { attrs: { role: "radiogroup" } })]],
    "a search box": [[], [control("div", { attrs: { role: "searchbox" } })]],
    "a value on a plain element": [[], [control("div", { attrs: { "aria-valuenow": "20" } })]],
    // Form-associated custom elements: in form.elements, with no role on the host.
    "a custom switch the form lists": [[control("md-switch", { checked: true, attrs: { name: "notify" } })], []],
    "a custom dropdown the form lists": [[control("my-select", { value: "everyone", attrs: { name: "visibility" } })], []],
    "a custom element with a name inside": [[], [control("my-select", { attrs: { name: "visibility" } })]],
  };
  for (const [name, [listed, inside]] of Object.entries(shapes)) {
    const f = describe([...boxes, ...listed], [...listed, ...inside]);
    assert.equal(f.plain, true, name);
    assert.ok(f.built >= 1, `${name} is counted as a control the page builds`);
  }
  // Not counted: a layout wrapper, an option of a native dropdown and a plain element.
  const quiet = describe(boxes, [
    wrapper(),
    control("option", { attrs: { "aria-selected": "true" } }),
    control("div"),
  ]);
  assert.equal(quiet.built, 0);
  // One element counted once, when the form lists it and it sits inside too.
  const both = control("my-select", { attrs: { name: "visibility" } });
  assert.equal(describe([...boxes, both], [both]).built, 1);
});
