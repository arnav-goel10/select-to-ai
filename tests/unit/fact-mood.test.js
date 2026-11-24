"use strict";
// What the browser tells the model about a run is facts: what was measured,
// what happened, what the browser will and will not do. A fact never gives
// an order ("go back", "rewrite them", "do not press it"): an order is a
// prompt rule hidden as a fact, written for whatever case caused it.
//
// The check is by grammar, not by a list of forbidden words. Every branch of
// every fact builder is called, and each sentence, and each clause after a
// colon or a semicolon, has to read as a statement: it opens with a word of
// English's closed classes (a determiner, pronoun, numeral, preposition or
// conjunction), a name of the step tool's (an action or a field), a gerund,
// or a noun followed straight away by its verb ("Today is"). An imperative
// opens with its verb and no subject, and fails. "You" with a modal of
// obligation fails too.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../extension/core/context.js");
const STEP = require("../../extension/core/step.js");

// English's closed word classes that can open a statement. Grammar, not
// topic: no verb is among them, so no order passes through them.
const CLOSED = new Set((
  "a an another other the this that these those its your their his her our my some any no every each either neither both all half " +
  "one two three several many much more most few fewer less only not nothing something anything everything none nobody " +
  "who what which whose when where while since because if as so but and or yet then there here it they you he she we " +
  "of on in at by for from with without to into onto under over after before during until through about between among " +
  "than whether although though once"
).split(" "));
// Finite forms of the verbs that follow a bare-noun subject: the auxiliaries, and a verb's -s and -ed forms.
const AUX = new Set("is are was were has have had can could will would may might does did shows holds".split(" "));
const finite = (w) => AUX.has(w) || /^[a-z]{3,}(?:s|ed)$/.test(w);
const OBLIGATION = /\byou\s+(?:must|should|need to|have to|ought to|had better)\b/i;

// The step tool's own names: an action or a field is a noun in a fact.
const NAMES = new Set([...STEP.ACTION_NAMES, ...Object.keys(STEP.stepTool({}).parameters.properties)]);

// Data the test hands to a builder is marked ⟦like this⟧, and is not grammar.
const DATA = (s) => `⟦${s}⟧`;

function clausesOf(fact) {
  const plain = String(fact)
    .replace(/⟦[^⟧]*⟧/g, " DATA ")
    .replace(/"[^"]*"/g, " DATA ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " DATA ")
    .replace(/\s+/g, " ").trim();
  return plain.split(/(?<=[.!?])\s+(?=[A-Z0-9])|[:;]\s+/).map((c) => c.trim()).filter((c) => /[A-Za-z]/.test(c));
}

/** Why a clause reads as an order, or "" when it reads as a statement. */
function orderIn(clause) {
  if (OBLIGATION.test(clause)) return "an obligation put on the model";
  const words = clause.match(/[A-Za-z_][A-Za-z_'-]*|\d+/g) || [];
  const [first, second] = [words[0] || "", (words[1] || "").toLowerCase()];
  if (/^\d/.test(first) || first === "DATA" || NAMES.has(first) || first.includes("_")) return "";
  const w = first.toLowerCase();
  if (CLOSED.has(w) || /^[a-z]{2,}ing$/.test(w)) return "";
  if (finite(second)) return "";
  return `opens with "${first}", which is not a subject`;
}

function allFacts() {
  const out = [];
  const page = { url: "https://e.example/a", title: "T", elements: [] };
  const run = (x) => ({ step: 4, maxSteps: 25, facts: {}, visits: {}, steers: [], history: [], ...x });
  const runs = [
    run({ finalStep: true, wrapUp: { by: "stuck", steps: 6, why: DATA("the page did not change") } }),
    run({ finalStep: true, wrapUp: { by: "declined", what: DATA("Send") } }),
    run({ finalStep: true, wrapUp: { by: "user" } }),
    run({ finalStep: true }),
    run({ notesCut: 20, memory: "x" }),
    run({ notesRefused: 30, memory: "x".repeat(STEP.NOTES_LIMIT) }),
    run({ memory: "x".repeat(STEP.NOTES_ROOM + 50), notesFull: "ask" }),
    run({ memory: "x".repeat(STEP.NOTES_ROOM + 50) }),
    run({ memory: "x".repeat(100) }),
    run({ history: Array.from({ length: 25 }, (_, i) => ({ step: i + 1, goal: "g", actions: [] })) }),
    run({ facts: { repeats: 3 } }), run({ facts: { same: 3 } }),
    run({ facts: { cycle: { rounds: 2, size: 2, actions: [DATA("click [3]"), DATA("back")] } } }),
    run({ facts: { unchanged: 3, failures: 3 } }),
    run({ visits: { "https://e.example/a": 4 } }),
    run({ progress: { news: { rule: "revisits", count: 4, of: 8 } }, visits: { a: 1 } }),
    run({ progress: { news: { rule: "searches", count: 4, of: 10 } } }),
    run({ progress: { failedAsk: { url: "https://e.example/x", n: 3, hows: [DATA("status 404")] } } }),
    run({ steers: ["also check the price"] }),
    run({ fromNothing: { from: "newtab", reused: true } }),
    run({ fromNothing: { from: "browser", url: "chrome://settings", reused: false } }),
    run({ fromNothing: { from: "error", url: "https://down.example/", reused: false } }),
  ];
  const pages = [
    page,
    { ...page, blockers: [{ kind: "human_check", away: DATA("search.example") }, { kind: "human_check", whole: false }, { kind: "human_check", whole: true }, { kind: "sign_in", whole: true }, { kind: "code" }, { kind: "payment" }] },
    { ...page, overlays: [{ where: "middle", name: "Cookies", controls: 2 }, { where: "top", framed: true }, { where: "bottom" }] },
    { ...page, inBackground: true, behind: "follow" }, { ...page, inBackground: true, behind: "subtask" }, { ...page, inBackground: true, behind: "user" },
    { ...page, dialogs: [{ kind: "alert" }] }, { ...page, dialogs: [{ kind: "alert" }, { kind: "confirm" }] },
    { ...page, held: { ms: 8000 } }, { ...page, protectedPage: true }, { ...page, injection: true },
  ];
  for (const r of runs) for (const p of pages) out.push(...C.runFacts(r, p, Date.UTC(2026, 9, 2)));
  for (const tag of ["", "ja", "pt-BR", "not a tag"]) out.push(C.languageFact(tag));
  for (const b of ["follow", "subtask", "user"]) out.push(C.behindFact(b));
  for (const w of ["action", "look"]) out.push(C.unansweredNote(9000, w));
  const taken = ["navigation", "form", "window", "media", "value"];
  for (const w of [{ tried: ["pointer"] }, { tried: ["pointer", "Enter"], hover: true, by: "Enter" }, { tried: ["pointer", "Enter"], hover: true }, { tried: ["pointer", "Enter"], by: "Enter", seen: true }, { tried: ["pointer", "Enter"], by: "Enter" }, { tried: ["pointer", "Enter", "Space"] }]) out.push(C.waysNote(w, 5, taken));
  for (const d of [{ kind: "alert", text: "Hi" }, { kind: "confirm", text: "Sure?" }, { kind: "prompt" }]) out.push(C.dialogNote(d));
  for (const s of [{ ms: 2000, loading: true }, { ms: 2000, network: true, asked: true }, { ms: 2000, network: true }, { ms: 2000 }, {}]) out.push(C.noChangeNote(s));
  for (const o of [{ urlChanged: true, newElementCount: 2 }, { titleChanged: true, newElementCount: -1 }, { domMutationCount: 3 }, { scrollChanged: true }, { noEffect: true }]) out.push(C.effectNote(o, { ms: 1000 }));
  for (const o of [{ error: DATA("net::ERR_FAILED") }, { status: 404 }, { status: 429, statusText: DATA("Too Many") }, { asked: "https://e.example/a/b", url: "https://e.example/" }, { asked: "https://e.example/a", url: "https://other.example/a" }]) out.push(C.arrivalNote(o));
  for (const [e, behind] of [["", true], ["needs all_urls", false], [DATA("refused"), false]]) out.push(C.noPicture(e, behind).why);
  out.push(C.todayLine(Date.UTC(2026, 9, 2)));
  // The facts the step message adds itself, and the one about pictures.
  const msg = C.stepMessages(run({ task: "t", marker: "PAGE-abcd1234" }), { ...page, whole: true, innerText: "Body." }, { uiLanguage: "", noPictures: DATA("It is behind another tab.") }).user;
  out.push(...msg.slice(msg.indexOf("Facts from the browser:")).split("\n- ").slice(1).map((l) => l.split("\n\n")[0]));
  return [...new Set(out.filter(Boolean))];
}

test("the grammar check tells an order from a statement", () => {
  for (const order of ["Go back and finish from what you have read.", "It is not handed to the user: go back and finish.", "Rewrite them shorter with rewrite_notes.", "Do not press it again by script.", "The page changed: check that the change is the one you wanted.", "Finish now and tell the user.", "You must answer now.", "This is the last step; keep what the answer needs."]) {
    assert.ok(clausesOf(order).some((c) => orderIn(c)), `not caught: ${order}`);
  }
  for (const fact of ["Today is Friday.", "Nothing came up.", "wait gives a busy page more time.", "rewrite_notes replaces them with a shorter version.", "4 of your last 8 steps were searches.", "Reading it works as usual.", "Pointer events were sent."]) {
    assert.deepEqual(clausesOf(fact).map(orderIn).filter(Boolean), [], `taken for an order: ${fact}`);
  }
});

test("no fact the browser gives the model is an order", () => {
  const facts = allFacts();
  assert.ok(facts.length >= 60, `every branch reached (${facts.length} facts)`);
  const orders = [];
  for (const f of facts) for (const c of clausesOf(f)) { const why = orderIn(c); if (why) orders.push(`${why}: ${f}`); }
  assert.deepEqual(orders, []);
});
