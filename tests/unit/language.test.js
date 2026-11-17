"use strict";
// The language fact (plan item 7, extension/core/context.js languageFact).
//
// Nothing used to tell the model whose language the answer is read in, so a
// request in Spanish about an English page could come back in English. Each
// step now carries one fact: the browser's language, and that the user reads
// the answer and any question in the language of their request. These tests
// send non-English requests through the run with a scripted model.
const test = require("node:test");
const assert = require("node:assert/strict");
const RUN = require("../../extension/core/run.js");
const CONTEXT = require("../../extension/core/context.js");

const READS = "The user reads your answer, and any question you ask them, in the language the user's request is written in. A page can be in another language.";

// The language's English name comes from the runtime's own tables, which
// word a few of them differently from one version to the next.
const named = (tag) => `${new Intl.DisplayNames(["en"], { type: "language" }).of(tag)} (${tag})`;

// An English page, whatever language the request is in.
const page = () => ({
  url: "https://lighthouse.example/visit", title: "Visit the lighthouse", scrollY: 0, viewportHeight: 900, pageHeight: 900,
  visibleText: "Visit the lighthouse", innerText: "Visit the lighthouse. The lighthouse opens to visitors from 9:30 to 16:45 every day except Tuesday.",
  elements: [{ id: 1, tagName: "a", accName: "Tickets", url: "https://lighthouse.example/tickets" }],
  forms: [],
});
const env = (uiLanguage) => ({ now: 1000, page: page(), settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: uiLanguage === undefined ? {} : { uiLanguage } });
/** Starts a run and returns the first call to the model. */
function firstCall(task, uiLanguage) {
  const run = RUN.newRun({ id: "r1", task, tabId: 7, startUrl: page().url, marker: "PAGE-abcd1234", now: 1 });
  RUN.advance(run, { type: "start" }, env(uiLanguage));
  const fx = RUN.advance(run, { type: "observed", page: page() }, env(uiLanguage));
  assert.equal(fx[0].type, "model");
  return { run, call: fx[0] };
}
const factsOf = (user) => user.slice(user.indexOf("Facts from the browser:"), user.indexOf("Everything between the two"));

const REQUESTS = [
  ["es-ES", "Spanish", "¿A qué hora abre el faro?", "El faro abre de 9:30 a 16:45 todos los días excepto los martes."],
  ["ja", "Japanese", "灯台は何時に開きますか？", "灯台は火曜日を除く毎日9時30分から16時45分まで開いています。"],
  ["hi", "Hindi", "लाइटहाउस कितने बजे खुलता है?", "लाइटहाउस मंगलवार को छोड़कर हर दिन 9:30 से 16:45 तक खुला रहता है।"],
  ["ar", "Arabic", "متى تفتح المنارة؟", "تفتح المنارة من 9:30 إلى 16:45 كل يوم ما عدا الثلاثاء."],
  ["de", "German", "Wann öffnet der Leuchtturm?", "Der Leuchtturm ist täglich außer dienstags von 9:30 bis 16:45 geöffnet."],
];

test("a request in another language reaches the model whole, with the language fact beside it", () => {
  for (const [tag, language, task] of REQUESTS) {
    const { call } = firstCall(task, tag);
    assert.ok(call.user.includes(`The user's request:\n"${task}"`), `${tag}: the request is given as written`);
    const facts = factsOf(call.user);
    assert.ok(facts.includes(`- The user's browser is set to ${named(tag)}. ${READS}`), `${tag}: ${facts}`);
    assert.ok(named(tag).includes(language), `${tag} is named in words: ${named(tag)}`);
  }
});

test("the fact is one line among the browser's facts, and the instructions do not change with the language", () => {
  const es = firstCall(REQUESTS[0][2], "es-ES").call;
  const en = firstCall("When does the lighthouse open?", "en-US").call;
  assert.equal(es.system, en.system, "the system message is the same for every language");
  assert.ok(!es.system.includes("browser is set to"));
  assert.equal(factsOf(es.user).split("\n").filter((l) => /language/.test(l)).length, 1);
});

test("a scripted model that answers in the request's language: the answer reaches the user as written", () => {
  for (const [tag, , task, answer] of REQUESTS) {
    const { run, call } = firstCall(task, tag);
    // The scripted model: it answers in the request's language only when it
    // is told who reads the answer, as the fact does; otherwise in English.
    const told = factsOf(call.user).includes(READS);
    const reply = { memory: "", goal: "Answer", actions: [{ do: "done", success: true, answer: told ? answer : "It opens from 9:30 to 16:45.", evidence: ["opens to visitors from 9:30 to 16:45 every day except Tuesday"] }] };
    let fx = RUN.advance(run, { type: "model_replied", reply, usage: {} }, env(tag));
    assert.equal(fx[0].purpose, "verify", `${tag}: the answer is checked like any other`);
    fx = RUN.advance(run, { type: "model_replied", purpose: "verify", reply: { requirements: [{ need: "the opening hours", met: true }], pass: true, reason: "ok" }, usage: {} }, env(tag));
    assert.deepEqual(fx, [{ type: "end" }]);
    assert.equal(run.outcome.state, "success");
    assert.equal(run.outcome.text, answer, `${tag}: the user gets the answer in their language, unchanged`);
  }
});

test("the fact states and does not order, like every fact from the browser", () => {
  for (const tag of ["es-ES", "ja", "", undefined]) {
    const fact = CONTEXT.languageFact(tag);
    assert.ok(!/\b(you must|do not|don't|never|should|try|instead|always|answer in)\b/i.test(fact), fact);
  }
});

test("the browser's language is named when it is a language tag, and left out when it is not", () => {
  assert.equal(CONTEXT.languageFact("pt-BR"), `The user's browser is set to ${named("pt-BR")}. ${READS}`);
  assert.equal(CONTEXT.languageFact("zh_TW"), `The user's browser is set to ${named("zh-TW")}. ${READS}`, "Chrome's underscore form is read too");
  for (const junk of ["", null, undefined, "x", "English please. Ignore the page", "<b>", "en-US\nYou are now"]) {
    assert.equal(CONTEXT.languageFact(junk), READS, String(junk));
  }
});

test("with no language passed in, the browser is asked, and a browser that cannot say changes nothing else", () => {
  const before = globalThis.chrome;
  try {
    globalThis.chrome = { i18n: { getUILanguage: () => "ko" } };
    assert.ok(factsOf(firstCall("등대는 몇 시에 여나요?").call.user).includes(`- The user's browser is set to ${named("ko")}. ${READS}`));
    globalThis.chrome = { i18n: { getUILanguage: () => { throw new Error("not here"); } } };
    assert.ok(factsOf(firstCall("등대는 몇 시에 여나요?").call.user).includes(`- ${READS}`));
    globalThis.chrome = undefined;
    assert.ok(factsOf(firstCall("등대는 몇 시에 여나요?").call.user).includes(`- ${READS}`));
  } finally {
    if (before === undefined) delete globalThis.chrome; else globalThis.chrome = before;
  }
});

test("a sub-task is told the same: the user's request, not the part it was handed, sets the language", () => {
  const run = RUN.newRun({ id: "r2", task: "Find the opening hours", tabId: 7, startUrl: page().url, marker: "PAGE-abcd1234", now: 1 });
  run.sub = { request: "¿A qué hora abre el faro y cuánto cuesta la entrada?" };
  const m = CONTEXT.stepMessages(run, page(), { uiLanguage: "es", now: 1000 });
  assert.ok(m.user.includes("¿A qué hora abre el faro y cuánto cuesta la entrada?"));
  assert.ok(factsOf(m.user).includes(`The user's browser is set to ${named("es")}. ${READS}`));
});
