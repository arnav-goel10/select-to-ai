"use strict";
// The page's controls as the model reads them (extension/core/observe.js):
// everything when it fits, cut down by structure when it does not.
const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../../extension/core/observe.js");

let id = 0;
const el = (tagName, accName, more) => ({ id: ++id, tagName, accName, position: "in-viewport", ...more });
const card = (n, position) => {
  const g = { groupKey: 1000 + n, groupKind: "item", group: `item "Widget ${n} $${n}.99"`, position };
  return [el("a", `Widget ${n}`, { ...g, href: `/p/${n}` }), el("button", "Add to cart", g)];
};
const lines = (out) => out.text.split("\n");

test("a page that fits the budget is listed whole, wherever its controls are", () => {
  id = 0;
  const page = [
    el("input", "Search", { inputType: "search" }),
    ...card(1), ...card(2), ...card(3, "below-fold"),
    el("select", "Sort by", { position: "below-fold", selected: "Featured", options: ["Featured", "Price: low to high"] }),
  ];
  const out = O.formatControls(page, { maxLines: 160 });
  assert.equal(out.shown, page.length);
  assert.equal(out.cut, 0);
  assert.match(out.text, /item "Widget 3 \$3\.99":\n  \[6\] a "Widget 3" → \/p\/3 \(below\)\n  \[7\] button "Add to cart" \(below\)/);
  assert.match(out.text, /\[8\] select "Sort by" = "Featured" options="Featured \| Price: low to high" \(below\)/, "a control off screen is listed with where it is");
});

test("a long run of look-alike items keeps the ones on screen and counts the rest", () => {
  id = 0;
  const page = [el("input", "Search", { inputType: "search" })];
  for (let n = 1; n <= 60; n++) page.push(...card(n, n <= 10 ? "above-fold" : n <= 14 ? "in-viewport" : "below-fold"));
  page.push(el("select", "Sort by", { position: "below-fold" }), el("a", "Next page", { position: "below-fold", href: "/s?page=2" }));
  const out = O.formatControls(page, { maxLines: 60 });
  assert.ok(out.lines <= 60, `${out.lines} lines`);
  assert.match(out.text, /item "Widget 11 \$11\.99":/, "the first item on screen is shown");
  assert.ok(!/item "Widget 1 \$1\.99":/.test(out.text), "items scrolled past are counted, not listed");
  assert.match(out.text, /\d+ more items like these \(10 above, \d+ below\)\. scroll brings others into the listing; find lists one by its name\./);
  assert.match(out.text, /select "Sort by"/, "a dropdown below sixty cards is still listed");
  assert.match(out.text, /a "Next page"/);
  assert.match(out.text, /input\(search\) "Search"/);
});

test("a menu or a footer that is mostly links becomes one line; its fields and buttons stay", () => {
  id = 0;
  const nav = { groupKey: 1, groupKind: "navigation", group: 'navigation "Departments"' };
  const foot = { groupKey: 2, groupKind: "footer", group: "footer" };
  const page = [
    ...Array.from({ length: 40 }, (_, i) => el("a", `Department ${i + 1}`, nav)),
    el("button", "Sign in", nav),
    ...Array.from({ length: 100 }, (_, i) => el("button", `Action ${i + 1}`)),
    ...Array.from({ length: 30 }, (_, i) => el("a", `Footer ${i + 1}`, { ...foot, position: "below-fold" })),
  ];
  const out = O.formatControls(page, { maxLines: 120 });
  assert.ok(out.lines <= 120, `${out.lines} lines`);
  assert.match(out.text, /navigation "Departments": 40 links, among them "Department 1", "Department 2".*find lists one by its name\.\n  \[41\] button "Sign in"/);
  assert.match(out.text, /footer: 30 links, among them "Footer 1"/);
  assert.equal(lines(out).filter((l) => /button "Action/.test(l)).length, 100, "no button is dropped");
});

test("what find pinned, and what just appeared, is never folded away", () => {
  id = 0;
  const page = [];
  for (let n = 1; n <= 80; n++) page.push(...card(n, n <= 4 ? "in-viewport" : "below-fold"));
  page[2 * 70].pinned = true; // Widget 71's link, found by name
  const out = O.formatControls(page, { maxLines: 40 });
  assert.match(out.text, /item "Widget 71 \$71\.99":/);
});

test("a page with more fields and buttons than the budget says how many it left out", () => {
  id = 0;
  const page = Array.from({ length: 300 }, (_, i) => el("button", `Button ${i + 1}`));
  const out = O.formatControls(page, { maxLines: 50 });
  assert.equal(out.lines, 50);
  assert.equal(out.cut, 251);
  assert.match(lines(out)[49], /^251 more controls are not listed\. find lists them by the words on them\.$/);
});

test("a long run of plain links keeps the ones on screen", () => {
  id = 0;
  const page = [...Array.from({ length: 200 }, (_, i) => el("a", `Result ${i + 1}`, { position: i < 50 ? "above-fold" : i < 58 ? "in-viewport" : "below-fold" })), el("button", "Load more", { position: "below-fold" })];
  const out = O.formatControls(page, { maxLines: 30 });
  assert.ok(out.lines <= 30);
  assert.match(out.text, /a "Result 51"/);
  assert.ok(!/a "Result 1"\n/.test(out.text));
  assert.match(out.text, /\d+ more links here\. find lists one by its name\./);
  assert.match(out.text, /button "Load more"/);
});

test("a page too long even when cut down keeps what the last action brought up, then what is on screen", () => {
  id = 0;
  const page = [
    el("button", "Sort by: Our top picks", { expanded: "true" }),
    ...Array.from({ length: 200 }, (_, i) => el("button", `Filter ${i + 1}`, { position: i < 20 ? "above-fold" : i < 30 ? "in-viewport" : "below-fold" })),
    // The opened menu is at the end of the page, as most pages draw one.
    ...["Price (lowest first)", "Price (highest first)", "Top reviewed"].map((name) => el("button", name, { role: "menuitem", isNew: true, groupKey: 9, groupKind: "group", group: "menu" })),
  ];
  const out = O.formatControls(page, { maxLines: 40 });
  assert.equal(out.lines, 40);
  assert.match(out.text, /menu:\n  \*?\[202\] button "Price \(lowest first\)"/, "the menu that just opened is listed, under its heading");
  assert.match(out.text, /button "Top reviewed"/);
  assert.match(out.text, /button "Filter 21"/, "then the controls on screen");
  assert.match(out.text, /button "Filter 30"/);
  assert.match(out.text, /^\[1\] button "Sort by: Our top picks"/, "in page order");
  assert.match(out.text, /\n\d+ more controls are not listed\. find lists them by the words on them\.$/);
  assert.equal(out.shown + out.cut, page.length);
});

test("items side by side in one list are a run even when no two are made of the same controls", () => {
  id = 0;
  const page = [el("input", "Search", { inputType: "search" })];
  for (let n = 1; n <= 40; n++) {
    const g = { groupKey: 2000 + n, groupKind: "item", group: `item "Hotel ${n}"`, groupList: 77, position: n <= 3 ? "in-viewport" : "below-fold" };
    page.push(el("a", `Hotel ${n}`, g), ...Array.from({ length: n % 4 }, (_, i) => el("button", `Badge ${i + 1}`, g)), el("a", "See availability", g));
  }
  page.push(el("select", "Sort by", { position: "below-fold" }));
  const out = O.formatControls(page, { maxLines: 60 });
  assert.equal(out.cut, 0, "the run is counted, so nothing is cut off the end");
  assert.match(out.text, /\d+ more items like these \(\d+ below\)/);
  assert.match(out.text, /select "Sort by"/);
});

test("a control on screen is not cut from a long run while controls off screen are kept", () => {
  id = 0;
  // Eight links in a row at the top of a page, all on screen; the last is the one that matters.
  const page = [
    ...Array.from({ length: 7 }, (_, i) => el("a", `Day ${i + 1}`, { href: `/d/${i + 1}` })),
    el("a", "arXiv:2609.39991", { href: "/abs/2609.39991" }),
    ...Array.from({ length: 300 }, (_, i) => el("button", `Tool ${i + 1}`, { position: "below-fold" })),
  ];
  const out = O.formatControls(page, { maxLines: 60 });
  assert.match(out.text, /a "arXiv:2609\.39991"/, "it is on screen, so it is listed");
  assert.match(out.text, /a "Day 1"/);
});
