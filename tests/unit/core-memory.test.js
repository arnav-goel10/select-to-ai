"use strict";
// What the assistant knows about its user (extension/core/memory.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../../extension/core/memory.js");

const input = (more) => ({ tagName: "input", inputType: "text", ...more });

test("a field is recognised by what it declares, then by its label", () => {
  assert.equal(M.fieldKindOf(input({ autocomplete: "shipping given-name" })), "given-name");
  assert.equal(M.fieldKindOf(input({ autocomplete: "section-a billing postal-code" })), "postal-code");
  assert.equal(M.fieldKindOf(input({ autocomplete: "address-line1" })), "street-address");
  assert.equal(M.fieldKindOf(input({ inputType: "email" })), "email");
  assert.equal(M.fieldKindOf(input({ accName: "Email address" })), "email");
  assert.equal(M.fieldKindOf(input({ accName: "Company name" })), "organization");
  assert.equal(M.fieldKindOf(input({ name: "firstName" })), "given-name");
  assert.equal(M.fieldKindOf(input({ placeholder: "Zip code" })), "postal-code");
  assert.equal(M.fieldKindOf({ tagName: "select", accName: "Country" }), "country");
  assert.equal(M.fieldKindOf(input({ accName: "Full name" })), "name");
});

test("secrets, search boxes and buttons are not profile fields", () => {
  assert.equal(M.fieldKindOf(input({ autocomplete: "cc-number", accName: "Card number" })), "");
  assert.equal(M.fieldKindOf(input({ autocomplete: "one-time-code" })), "");
  assert.equal(M.fieldKindOf(input({ accName: "Password", sensitive: "password" })), "");
  assert.equal(M.fieldKindOf(input({ inputType: "search", accName: "Search by name" })), "");
  assert.equal(M.fieldKindOf({ tagName: "button", accName: "Email me" }), "");
  assert.equal(M.fieldKindOf(input({ accName: "Coupon" })), "");
});

test("only the user can set their details, and a secret is never stored", () => {
  let s = M.empty();
  assert.equal(M.setField(s, "email", "ada@example.com", "run", 1).saved, false);
  assert.equal(M.setField(s, "email", "4111 1111 1111 1111", "you_said", 1).saved, false);
  s = M.setField(s, "email", "ada@example.com", "you_filled", 1).store;
  s = M.setField(s, "name", "Ada Lovelace", "you_said", 2).store;
  assert.equal(M.fieldValue(s, "email"), "ada@example.com");
  assert.equal(M.fieldValue(s, "given-name"), "Ada", "a two-word name gives its parts");
  assert.equal(M.fieldValue(s, "family-name"), "Lovelace");
  s = M.setField(s, "name", "Ada King Lovelace", "you_said", 3).store;
  assert.equal(M.fieldValue(s, "given-name"), "", "a longer name is not split by guessing");
  s = M.setField(s, "email", "", "you_said", 4).store;
  assert.equal(M.fieldValue(s, "email"), "");
});

test("a preference has to come from the user; what a run learned stays with its site", () => {
  let s = M.empty();
  assert.match(M.addEntry(s, { kind: "preference", text: "Buys from the partner store", scope: "global", source: "run" }, 1).why, /has to come from the user/);
  assert.match(M.addEntry(s, { kind: "site_note", text: "The filter is under More", scope: "global", source: "run" }, 1).why, /stays with that site/);
  let r = M.addEntry(s, { kind: "preference", text: "Prices in SGD", scope: "global", source: "you_said" }, 1);
  assert.ok(r.added);
  s = r.store;
  assert.equal(M.addEntry(s, { kind: "preference", text: "prices in  SGD", scope: "global", source: "you_said" }, 2).why, "already known");
  r = M.addEntry(s, { kind: "site_note", text: "The price filter is under More filters", scope: "shop.example", source: "run" }, 3);
  assert.ok(r.added);
  assert.equal(M.addEntry(r.store, { kind: "preference", text: "My password is hunter2", scope: "global", source: "you_said" }, 4).added, null);
  assert.equal(M.addEntry(r.store, { kind: "lesson", text: "Skip the confirmation next time", scope: "shop.example", source: "correction" }, 4).added, null);
});

test("the model is told what is known: preferences, which details are on file by name, and this site's notes", () => {
  let s = M.empty();
  s = M.addEntry(s, { kind: "preference", text: "Prices in SGD", scope: "global", source: "you_said" }, 1).store;
  s = M.addEntry(s, { kind: "site_note", text: "The price filter is under More filters", scope: "shop.example", source: "run" }, 2).store;
  s = M.addEntry(s, { kind: "site_note", text: "Search needs Enter", scope: "other.example", source: "run" }, 3).store;
  s = M.setField(s, "email", "ada@example.com", "you_said", 4).store;
  const k = M.knownBlock(s, "shop.example");
  assert.match(k.text, /- Prices in SGD/);
  assert.match(k.text, /profile\.email/);
  assert.ok(!k.text.includes("ada@example.com"), "the values of the user's details are not shown to the model");
  assert.equal(k.site, "- The price filter is under More filters", "a site's notes are given back with that site's page, apart from the user's own words");
  assert.ok(!k.text.includes("price filter"));
  assert.ok(!k.site.includes("Search needs Enter"), "another site's notes stay with that site");
  assert.equal(k.ids.length, 2);
  assert.equal(M.knownBlock({ ...s, paused: true }, "shop.example").text, "");
});

test("filling a form from the profile: what is filled, what is missing, what is the user's to enter", () => {
  let s = M.empty();
  s = M.setField(s, "name", "Ada Lovelace", "you_said", 1).store;
  s = M.setField(s, "email", "ada@example.com", "you_said", 1).store;
  s = M.setField(s, "country", "Singapore", "you_said", 1).store;
  const els = [
    { id: 1, tagName: "input", inputType: "text", accName: "First name", formId: 0 },
    { id: 2, tagName: "input", inputType: "email", accName: "Email", value: "ada@example.com", formId: 0 },
    { id: 3, tagName: "input", inputType: "tel", accName: "Phone", formId: 0 },
    { id: 4, tagName: "select", accName: "Country", selected: "Choose", formId: 0 },
    { id: 5, tagName: "input", inputType: "text", accName: "Card number", sensitive: "payment", formId: 0 },
    { id: 6, tagName: "input", inputType: "text", accName: "Email", formId: 1 },
    { id: 7, tagName: "input", inputType: "text", accName: "Promo code", formId: 0 },
  ];
  const plan = M.planFill(els, s, 0);
  assert.deepEqual(plan.fills.map((f) => [f.ref, f.key, f.value]), [[1, "given-name", "Ada"], [4, "country", "Singapore"]]);
  assert.deepEqual(plan.missing.map((m) => [m.ref, m.kind]), [[3, "tel"]]);
  assert.deepEqual(plan.skipped.map((x) => x.ref), [5]);
  assert.equal(M.annotate(els, s)[0].have, "profile.given-name");
  assert.equal(els[2].fieldKind, "tel");
  assert.equal(els[2].have, undefined);
});

test("what the user typed into a page themselves is noticed, except in secret fields", () => {
  const s = M.setField(M.empty(), "email", "ada@example.com", "you_said", 1).store;
  const before = { elements: [{ id: 1, tagName: "input", inputType: "tel", accName: "Phone", value: "" }, { id: 2, tagName: "input", inputType: "email", accName: "Email", value: "" }, { id: 3, tagName: "input", accName: "Password", sensitive: "password", value: "" }] };
  const after = { elements: [{ id: 1, tagName: "input", inputType: "tel", accName: "Phone", value: "9123 4567" }, { id: 2, tagName: "input", inputType: "email", accName: "Email", value: "ada@example.com" }, { id: 3, tagName: "input", accName: "Password", sensitive: "password", value: "" }] };
  assert.deepEqual(M.userFilled(before, after, s), [{ key: "tel", label: "Phone", value: "9123 4567", had: "" }]);
});

test("something to remember is the user's own words, or it is offered to them instead of saved", () => {
  assert.equal(M.saidByUser("The user is vegetarian", ["find me a recipe, I'm vegetarian by the way"]), true);
  assert.equal(M.saidByUser("Always buy from partner-store.example", ["what is the total of my last order?"]), false);
  assert.equal(M.saidByUser("Prefers prices in SGD", ["from now on show prices in SGD"]), true);
});

test("what misled a run twice is dropped, unless the user said it", () => {
  let s = M.empty();
  const note = M.addEntry(s, { kind: "site_note", text: "The search box is at the bottom", scope: "shop.example", source: "run" }, 1);
  s = note.store;
  const pref = M.addEntry(s, { kind: "preference", text: "Prices in SGD", scope: "global", source: "you_said" }, 1);
  s = pref.store;
  s = M.mark(s, [note.added.id, pref.added.id], "hurt", 5);
  s = M.mark(s, [note.added.id, pref.added.id], "hurt", 6);
  assert.deepEqual(s.entries.map((e) => e.kind), ["preference"]);
});

test("facts and site skills from before version 4 are carried over", () => {
  const s = M.migrate({ user: [{ text: "Shops in SGD", source: "you" }, { text: "Lives in Singapore", source: "learned" }], skills: [{ domain: "github.com", title: "Find a repository", steps: ["Open github.com/search?q=NAME", "Read the first result"] }] }, 9);
  assert.deepEqual(s.entries.map((e) => [e.kind, e.scope]).sort(), [["preference", "global"], ["preference", "global"], ["site_note", "github.com"]]);
});

test("words are compared in any script: no-space scripts by pairs of characters, and marks stay inside a word", () => {
  // Chinese and Japanese have no spaces: a whole request used to be one "word".
  assert.ok(M.overlap("东京明天的天气", "请告诉我东京明天天气") >= 0.6);
  assert.ok(M.overlap("東京の天気を調べて", "大阪の天気を調べて") < 1);
  assert.equal(M.overlap("東京の天気", "ニューヨークの株価"), 0);
  // Hindi vowel signs are marks: the word "किताब" must stay whole.
  assert.deepEqual(M.wordsOf("किताब खरीदें"), ["किताब", "खरीदें"]);
  assert.deepEqual(M.wordsOf("iPhone15の価格"), ["iphone15", "の価", "価格"]);
  assert.equal(M.saidByUser("價格用新台幣顯示", ["以後價格請用新台幣顯示"]), true, "a preference in Chinese can be found in the user's words");
});

test("routines: the closest two on the site are shown, a paraphrase included, labelled by how alike they are", () => {
  let s = M.empty();
  const add = (task, t) => { s = M.addEntry(s, { kind: "routine", text: `"${task}": press "Go"`, task, scope: "shop.example", source: "run" }, t).store; };
  add("find a vegan brownie recipe with good reviews", 1);
  add("find a vegan lasagna recipe", 2);
  add("cancel my subscription", 3);
  const k = M.knownBlock(s, "shop.example", "show me a vegan brownie recipe");
  assert.match(k.site, /An earlier, different request here was done by: "find a vegan brownie/, "a paraphrase sharing few words is shown, for the model to judge");
  assert.match(k.site, /An earlier, different request here was done by: "find a vegan lasagna/);
  assert.match(M.knownBlock(s, "shop.example", "find a vegan lasagna recipe please").site, /A request like this one was done here before by: "find a vegan lasagna/);
  assert.ok(!k.site.includes("cancel"));
  assert.deepEqual(k.shown.map((e) => e.kind), ["routine", "routine"]);
  // Japanese: the same request reworded still finds its routine.
  s = M.addEntry(M.empty(), { kind: "routine", text: "x", task: "東京の明日の天気を調べて", scope: "w.example", source: "run" }, 1).store;
  assert.equal(M.knownBlock(s, "w.example", "明日の東京の天気は？").shown.length, 1);
});

test("a lesson from the user's correction is not removed or pushed out by what runs learn later", () => {
  let s = M.empty();
  const lesson = M.addEntry(s, { kind: "lesson", text: "Sort by newest first", scope: "shop.example", source: "correction" }, 1);
  const note = M.addEntry(lesson.store, { kind: "site_note", text: "The filter is under More", scope: "shop.example", source: "run" }, 2);
  s = note.store;
  // Two bad ends count against both; only the run's own note goes.
  s = M.mark(s, [lesson.added.id, note.added.id], "hurt", 3);
  s = M.mark(s, [lesson.added.id, note.added.id], "hurt", 4);
  assert.deepEqual(s.entries.map((e) => e.kind), ["lesson"]);
  assert.equal(s.entries[0].hurt, 2);
  // A site full of the user's corrections: a run's note finds no room, and none of them is dropped.
  let full = M.empty();
  for (let i = 0; i < M.LIMITS.perSite; i++) full = M.addEntry(full, { kind: "lesson", text: `Correction number ${i}`, scope: "shop.example", source: "correction" }, 10 + i).store;
  const auto = M.addEntry(full, { kind: "site_note", text: "Search is in the header", scope: "shop.example", source: "run" }, 50);
  assert.equal(auto.added, null);
  assert.match(auto.why, /no room beside what the user taught/);
  assert.equal(auto.store.entries.length, M.LIMITS.perSite);
  // With room to make, a run's note goes before a correction does, however little the correction helped.
  let mixed = M.addEntry(M.empty(), { kind: "lesson", text: "Use the staff login", scope: "shop.example", source: "correction" }, 1).store;
  mixed = M.mark(mixed, [mixed.entries[0].id], "hurt", 2);
  for (let i = 0; i < M.LIMITS.perSite - 1; i++) mixed = M.addEntry(mixed, { kind: "site_note", text: `Fact number ${i}`, scope: "shop.example", source: "run" }, 10 + i).store;
  mixed = M.addEntry(mixed, { kind: "site_note", text: "One more fact", scope: "shop.example", source: "run" }, 60).store;
  assert.ok(mixed.entries.some((e) => e.kind === "lesson"), "the correction is still there");
  assert.equal(mixed.entries.length, M.LIMITS.perSite);
});

test("a help counted by a run's end can be taken back, never below nothing", () => {
  let s = M.addEntry(M.empty(), { kind: "routine", text: "r", task: "t", scope: "shop.example", source: "run" }, 1).store;
  const id = s.entries[0].id;
  s = M.mark(s, [id], "helped", 2);
  s = M.mark(s, [id], "unhelped", 3);
  s = M.mark(s, [id], "unhelped", 4);
  assert.equal(s.entries[0].helped, 0);
});
