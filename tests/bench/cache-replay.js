"use strict";
/**
 * The cached conversation on a live model: one 20-step run, asked both
 * ways, with what each step's prompt cost in cached and uncached tokens.
 *
 *   ANTHROPIC_API_KEY=... node tests/bench/cache-replay.js
 *   CACHE_REPLAY_DRY=1 node tests/bench/cache-replay.js   (no model: prompt sizes only)
 *
 * The run is a recording: the pages of a shop the run walks through
 * (search, sort, filter, product pages, a second page of results, a size
 * guide) and the step the model took on each, with what it did. It is
 * played through the engine (extension/core/run.js) with no browser, so
 * each step's prompt is exactly the one the engine builds, and each step
 * is asked of the model twice: as one message (the build before the
 * conversation, with its system text cached), and as the conversation
 * (llm.js). The model's replies are not used: the recorded steps drive
 * the run, so both builds see the same run.
 *
 * Env:
 *   ANTHROPIC_API_KEY    the key (the run is refused without it)
 *   CACHE_REPLAY_MODEL   model id (default claude-haiku-5-5)
 *   CACHE_REPLAY_CAP_USD hard spend cap (default 1): a call is not made
 *                        when its worst case would pass it
 *   CACHE_REPLAY_REPORT  write the JSON report here
 *   CACHE_REPLAY_DRY=1   no calls: characters per step, both builds
 *
 * Bars (docs: the step 1 ruling in the review): from step 3 on, cached
 * tokens are at least 60% of the conversation's input on every step, and
 * its uncached input (input tokens plus cache writes) is at least 30% below
 * the one message's.
 */
const fs = require("node:fs");
const RUN = require("../../extension/core/run.js");
const LLM = require("../../extension/core/llm.js");
const D = require("../../extension/defaults.js");
const JUDGE = require("../helpers/fake-judge.js");

const advance = JUDGE.judging(RUN);
const MODEL = process.env.CACHE_REPLAY_MODEL || "claude-haiku-5-5";
const CAP = Math.max(0, parseFloat(process.env.CACHE_REPLAY_CAP_USD || "1"));
const DRY = process.env.CACHE_REPLAY_DRY === "1";
const KEY = process.env.ANTHROPIC_API_KEY || "";
const REPLY_ROOM = 256;
const STEPS = 20;
const SITE = "https://harbor-outfitters.example";

// ------------------------------------------------------------- the pages

/** Deterministic words: the same page every time it is made. */
function prose(seed, n) {
  const words = ["shell", "seams", "taped", "breathable", "hood", "adjustable", "cuffs", "pockets", "zip", "recycled", "nylon", "lining", "warm", "light", "packable", "trail", "city", "rain", "wind", "layer", "fit", "regular", "relaxed", "length", "hip", "care", "wash", "cold", "dry", "low", "reviews", "rated", "comfort", "sizing", "true", "colour", "navy", "olive", "black", "storm"];
  let x = seed * 2654435761 % 4294967296;
  const out = [];
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; out.push(words[x % words.length]); if (i % 14 === 13) out.push("."); }
  return out.join(" ").replace(/ \./g, ".");
}

const PRODUCTS = Array.from({ length: 48 }, (_, i) => ({ slug: `jacket-${i + 1}`, name: `${["Storm", "Coast", "Ridge", "Harbor", "Drift", "Squall"][i % 6]} ${["Shell", "Parka", "Anorak", "Rain Jacket"][i % 4]} ${i + 1}`, price: 59 + ((i * 37) % 180), waterproof: i % 3 !== 1 }));

let ids = 0;
const el = (tagName, accName, more) => ({ id: ++ids, tagName, accName, ...more });

/** The site's frame: header menus, account links and footer, on every page. */
function frame() {
  const nav = ["Women", "Men", "Kids", "Jackets", "Fleece", "Base layers", "Footwear", "Packs", "Camping", "Sale", "New in", "Gift cards"].map((n) => el("a", n, { url: `${SITE}/c/${n.toLowerCase().replace(/ /g, "-")}` }));
  const head = [el("a", "Harbor Outfitters home", { url: `${SITE}/` }), el("input", "Search the store", { inputType: "search", role: "searchbox", formId: 0 }), el("button", "Search", { submits: true, formId: 0 }), el("a", "Sign in", { url: `${SITE}/account` }), el("a", "Basket, 0 items", { url: `${SITE}/basket` })];
  const foot = ["Help centre", "Delivery", "Returns", "Size guide", "Store finder", "Gift cards", "Repairs", "Our materials", "Careers", "Press", "Affiliates", "Privacy", "Cookies", "Terms", "Accessibility", "Contact us"].map((n) => el("a", n, { url: `${SITE}/help/${n.toLowerCase().replace(/ /g, "-")}` }));
  return { head: [...head, ...nav], foot };
}

function shopPage(url, title, middle, text) {
  ids = 0;
  const f = frame();
  const elements = [...f.head, ...middle(), ...f.foot];
  const innerText = `${title}\n${text}\nHelp centre Delivery Returns Size guide Store finder. Free delivery over $75. Returns within 60 days.`;
  return { url, title, scrollY: 0, viewportHeight: 900, pageHeight: 6000, whole: true, visibleText: innerText.slice(0, 900), innerText, elements, forms: [{ id: 0, search: true, fields: 1 }] };
}

function results(q, page, sort, filter) {
  const list = PRODUCTS.filter((p) => !filter || p.waterproof).sort((a, b) => (sort ? a.price - b.price : 0)).slice((page - 1) * 24, page * 24);
  const url = `${SITE}/search?q=${encodeURIComponent(q)}${sort ? "&sort=price" : ""}${filter ? "&waterproof=1" : ""}${page > 1 ? `&page=${page}` : ""}`;
  return shopPage(url, `Search: ${q} | Harbor Outfitters`, () => [
    el("button", "Sort: price, low to high", { role: "combobox" }),
    el("input", "Waterproof", { inputType: "checkbox", checked: !!filter }),
    el("input", "Insulated", { inputType: "checkbox" }),
    el("input", "Packable", { inputType: "checkbox" }),
    ...list.flatMap((p) => [el("a", p.name, { url: `${SITE}/p/${p.slug}` }), el("button", `Quick view ${p.name}`, {})]),
    el("a", "Page 2", { url: `${url}&page=2` }),
  ], list.map((p) => `${p.name} $${p.price}.00 ${p.waterproof ? "Waterproof" : "Water resistant"} ${prose(p.price, 18)}`).join("\n"));
}

function product(i) {
  const p = PRODUCTS[i];
  return shopPage(`${SITE}/p/${p.slug}`, `${p.name} | Harbor Outfitters`, () => [
    el("select", "Size", { options: ["XS", "S", "M", "L", "XL"] }),
    el("select", "Colour", { options: ["Navy", "Olive", "Black"] }),
    el("button", "Add to basket", {}),
    el("a", "Size guide", { url: `${SITE}/help/size-guide` }),
    el("a", "Reviews (128)", { url: `${SITE}/p/${p.slug}#reviews` }),
    el("a", "Compare", { url: `${SITE}/compare?items=${p.slug}` }),
    ...Array.from({ length: 8 }, (_, k) => el("a", `You may also like: ${PRODUCTS[(i + k + 1) % 48].name}`, { url: `${SITE}/p/${PRODUCTS[(i + k + 1) % 48].slug}` })),
  ], `${p.name}\n$${p.price}.00\n${p.waterproof ? "Waterproof to 20,000 mm, fully taped seams." : "Water resistant finish."}\nDetails\n${prose(i + 7, 700)}\nWarranty: two years against faults in materials and making.\nReviews\n${prose(i + 99, 500)}`);
}

const sizeGuide = () => shopPage(`${SITE}/help/size-guide`, "Size guide | Harbor Outfitters", () => ["XS", "S", "M", "L", "XL"].map((s) => el("button", `Show measurements for ${s}`, {})), `Size guide\n${prose(3, 900)}`);

// ------------------------------------------------------ the recorded run

const q = "waterproof rain jacket";
const home = shopPage(`${SITE}/`, "Harbor Outfitters: outdoor clothing", () => PRODUCTS.slice(0, 12).map((p) => el("a", p.name, { url: `${SITE}/p/${p.slug}` })), `Harbor Outfitters\nNew season jackets\n${prose(1, 600)}`);
const searchRef = (pg) => pg.elements.find((e) => e.accName === "Search the store").id;
const refOf = (pg, name) => { const e = pg.elements.find((x) => x.accName === name); if (!e) throw new Error(`no "${name}" on ${pg.url}`); return e.id; };
const r1 = results(q, 1, false, false);
const r2 = results(q, 1, true, false);
const r3 = results(q, 1, true, true);
const r4 = results(q, 2, true, true);
const pick = (pg, n) => pg.elements.filter((e) => e.tagName === "a" && /^\w+ (Shell|Parka|Anorak|Rain Jacket) \d+$/.test(e.accName))[n];
const indexOf = (e) => PRODUCTS.findIndex((p) => p.name === e.accName);
const pA = product(indexOf(pick(r3, 0)));
const pB = product(indexOf(pick(r3, 3)));
const pC = product(indexOf(pick(r4, 1)));
const pD = product(indexOf(pick(r3, 5)));
const guide = sizeGuide();

/**
 * Each step: the page it was taken on, the model's call, what its actions
 * did, and the page it led to. The calls are what a model wrote for such a
 * task, notes and all.
 */
const RECORDING = [
  [home, { note: "Need: cheapest waterproof rain jacket with a two-year warranty.", goal: "Search the store", do: "fill", ref: searchRef(home), value: q, then: [{ do: "press", key: "Enter", ref: searchRef(home) }] }, [`Typed "${q}".`, `Pressed Enter. The page changed: now at ${r1.url}. 24 results.`], r1],
  [r1, { note: "", goal: "Sort by price", do: "click", ref: refOf(r1, "Sort: price, low to high") }, [`Done. The page changed: now at ${r2.url}. Sorted by price, low to high.`], r2],
  [r2, { note: "", goal: "Only waterproof ones", do: "click", ref: refOf(r2, "Waterproof") }, [`Done. Checked. The page changed: now at ${r3.url}. 32 results.`], r3],
  [r3, { note: `Cheapest waterproof on page 1: ${pick(r3, 0).accName}.`, goal: "Open the cheapest", do: "click", ref: pick(r3, 0).id }, [`Done. The page changed: now at ${pA.url}.`], pA],
  [pA, { note: "", goal: "Read the warranty part", do: "find", query: "Warranty" }, ["1 match: \"Warranty: two years against faults in materials and making.\" in the page text, below the reviews."], pA],
  [pA, { note: `${pick(r3, 0).accName}: two-year warranty (product page).`, goal: "Back to the results", do: "back" }, [`Went back. Now at ${r3.url}.`], r3],
  [r3, { note: "", goal: "Check the next one", do: "click", ref: pick(r3, 3).id }, [`Done. The page changed: now at ${pB.url}.`], pB],
  [pB, { note: "", goal: "Look for its warranty", do: "find", query: "Warranty" }, ["1 match: \"Warranty: two years against faults in materials and making.\" in the page text."], pB],
  [pB, { note: `${pick(r3, 3).accName}: two-year warranty.`, goal: "Back to the results", do: "back" }, [`Went back. Now at ${r3.url}.`], r3],
  [r3, { note: "", goal: "See the next page of results", do: "click", ref: refOf(r3, "Page 2") }, [`Done. The page changed: now at ${r4.url}.`], r4],
  [r4, { note: "Page 2 is dearer than page 1, as sorted.", goal: "Open one from page 2", do: "click", ref: pick(r4, 1).id }, [`Done. The page changed: now at ${pC.url}.`], pC],
  [pC, { note: "", goal: "Read the rest of the details", do: "scroll", direction: "down" }, ["Scrolled down one screen. New on screen: Details, the warranty line and the first reviews."], pC],
  [pC, { note: `${pick(r4, 1).accName}: dearer, same warranty.`, goal: "Compare it", do: "click", ref: refOf(pC, "Compare") }, [`Done. The page changed: now at ${SITE}/compare?items=${pC.url.split("/").pop()}.`], pC],
  [pC, { note: "", goal: "Back to the product", do: "back" }, [`Went back. Now at ${pC.url}.`], pC],
  [pC, { note: "", goal: "Back to page 1 of the results", do: "navigate", url: r3.url }, [`Opened ${r3.url}.`], r3],
  [r3, { note: "", goal: "Check one more", do: "click", ref: pick(r3, 5).id }, [`Done. The page changed: now at ${pD.url}.`], pD],
  [pD, { note: "", goal: "Check its returns", do: "find", query: "Returns" }, ["2 matches: \"Returns within 60 days.\" in the page text, and the link \"Returns\" [footer]."], pD],
  [pD, { note: "Returns: 60 days, all items (every page's footer).", goal: "Check the sizes", do: "click", ref: refOf(pD, "Size guide") }, [`Done. The page changed: now at ${guide.url}.`], guide],
  [guide, { note: "Sizes run true (size guide).", goal: "Back to the jacket", do: "back" }, [`Went back. Now at ${pD.url}.`], pD],
];

/** The run played through the engine: the step effect of each of the STEPS steps. */
function play() {
  const env = (pg) => ({ now: Date.UTC(2026, 10, 25), page: pg, settings: { riskConfirmation: true, allowlist: "", verify: true }, extras: { uiLanguage: "en-GB" } });
  const run = RUN.newRun({ id: "replay", task: "Find the cheapest waterproof rain jacket on this site that has a two-year warranty, and tell me its price.", tabId: 1, startUrl: home.url, marker: "PAGE-5ca1ab1e", now: 1 });
  advance(run, { type: "start" }, env(home));
  const steps = [advance(run, { type: "observed", page: home }, env(home)).find((f) => f.type === "model")];
  for (const [on, call, said, next] of RECORDING) {
    let fx = advance(run, { type: "model_replied", reply: call, usage: { prompt: 0, completion: 0, cost: 0, model: MODEL } }, env(on));
    said.forEach((message, i) => {
      if (!fx.some((f) => f.type === "act")) throw new Error(`step ${steps.length}: the engine did not run "${call.goal}" (${JSON.stringify(fx.map((f) => f.type))}; ${run.notice || ""})`);
      const last = i === said.length - 1;
      fx = advance(run, { type: "acted", result: { ok: true, message, pageChanged: last && next !== on } }, env(last ? next : on));
    });
    const asked = advance(run, { type: "observed", page: next }, env(next)).find((f) => f.type === "model");
    if (!asked) throw new Error(`step ${steps.length + 1}: no step was asked for`);
    steps.push(asked);
  }
  if (steps.length !== STEPS) throw new Error(`the recording has ${steps.length} steps, not ${STEPS}`);
  return steps;
}

// ------------------------------------------------------------ the asking

const cfg = { provider: "anthropic", apiKey: KEY, baseUrl: "https://api.anthropic.com/v1/messages", customUrl: "", promptCaching: true };
const RATES = D.findModelRates(MODEL);

function request(fx, conversing) {
  const req = conversing
    ? { system: fx.system, user: fx.last, turns: fx.turns, tool: fx.tool, effort: fx.effort }
    : { system: fx.system, user: fx.user, tool: fx.tool, effort: fx.effort };
  const built = LLM.buildRequest(req, cfg, MODEL, { maxTokens: REPLY_ROOM });
  built.body.stream = false;
  return built;
}

/** The most a call could cost: every character a token, written to the cache, and the whole reply room. */
const worst = (body) => (JSON.stringify(body).length * 1.25 * RATES[0] + REPLY_ROOM * RATES[1]) / 1000;
const costOf = (u) => ((u.input_tokens + 0.1 * u.cache_read_input_tokens + 1.25 * u.cache_creation_input_tokens) * RATES[0] + u.output_tokens * RATES[1]) / 1000;

async function ask(built) {
  const res = await fetch(built.endpoint, { method: "POST", headers: built.headers, body: JSON.stringify(built.body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${LLM.errorText(text, res.status)}`);
  const u = JSON.parse(text).usage || {};
  return { input_tokens: u.input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0, output_tokens: u.output_tokens || 0 };
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);

async function main() {
  if (!RATES) { console.error(`No price is known for ${MODEL}, so the spend cap cannot be kept.`); process.exit(1); }
  const steps = play();
  if (DRY) {
    console.log("step  one-message chars  conversation: turns chars + last chars");
    steps.forEach((fx, i) => console.log(`${String(i + 1).padStart(4)}  ${String(fx.user.length).padStart(17)}  ${String(JSON.stringify(fx.turns).length).padStart(19)} + ${fx.last.length}`));
    return;
  }
  if (!KEY) { console.error("Set ANTHROPIC_API_KEY."); process.exit(1); }
  let spent = 0;
  const arms = {};
  // One build after the other, so each step of a build follows its own step before.
  for (const [name, conversing] of [["oneMessage", false], ["conversation", true]]) {
    arms[name] = [];
    for (const fx of steps) {
      const built = request(fx, conversing);
      if (spent + worst(built.body) > CAP) throw new Error(`stopped before step ${arms[name].length + 1} of ${name}: it could pass the $${CAP} cap ($${spent.toFixed(4)} spent)`);
      const u = await ask(built);
      spent += costOf(u);
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
      arms[name].push({ ...u, total, uncached: u.input_tokens + u.cache_creation_input_tokens });
    }
  }
  console.log(`model ${MODEL}, ${STEPS} steps, spent $${spent.toFixed(4)} of the $${CAP} cap\n`);
  console.log("step | one message: input, read, write | conversation: input, read, write | cached share | uncached, one message -> conversation");
  for (let i = 0; i < STEPS; i++) {
    const a = arms.oneMessage[i];
    const b = arms.conversation[i];
    console.log(`${String(i + 1).padStart(4)} | ${a.input_tokens}, ${a.cache_read_input_tokens}, ${a.cache_creation_input_tokens} | ${b.input_tokens}, ${b.cache_read_input_tokens}, ${b.cache_creation_input_tokens} | ${pct(b.cache_read_input_tokens, b.total)}% | ${a.uncached} -> ${b.uncached}`);
  }
  const from3 = (arm) => arms[arm].slice(2);
  const shares = from3("conversation").map((s) => pct(s.cache_read_input_tokens, s.total));
  const report = {
    model: MODEL, steps: STEPS, spentUSD: Math.round(spent * 1e6) / 1e6, capUSD: CAP,
    fromStep3: {
      conversationCachedShareMin: Math.min(...shares),
      conversationCachedShareAll: pct(sum(from3("conversation"), (s) => s.cache_read_input_tokens), sum(from3("conversation"), (s) => s.total)),
      oneMessageCachedShareAll: pct(sum(from3("oneMessage"), (s) => s.cache_read_input_tokens), sum(from3("oneMessage"), (s) => s.total)),
      uncachedOneMessage: sum(from3("oneMessage"), (s) => s.uncached),
      uncachedConversation: sum(from3("conversation"), (s) => s.uncached),
      inputOneMessage: sum(from3("oneMessage"), (s) => s.total),
      inputConversation: sum(from3("conversation"), (s) => s.total),
    },
    perStep: arms,
  };
  const f = report.fromStep3;
  f.uncachedFallPct = pct(f.uncachedOneMessage - f.uncachedConversation, f.uncachedOneMessage);
  console.log(`\nfrom step 3 on: cached share of the conversation's input ${f.conversationCachedShareAll}% (lowest step ${f.conversationCachedShareMin}%; one message ${f.oneMessageCachedShareAll}%)`);
  console.log(`uncached input ${f.uncachedOneMessage} -> ${f.uncachedConversation} tokens, ${f.uncachedFallPct}% less`);
  if (process.env.CACHE_REPLAY_REPORT) fs.writeFileSync(process.env.CACHE_REPLAY_REPORT, JSON.stringify(report, null, 2));
  const fails = [];
  if (f.conversationCachedShareMin < 60) fails.push(`a step from step 3 on had only ${f.conversationCachedShareMin}% of its input cached (bar 60%)`);
  if (f.uncachedFallPct < 30) fails.push(`uncached input fell by ${f.uncachedFallPct}% (bar 30%)`);
  if (fails.length) { console.log(`\nFAIL: ${fails.join("; ")}`); process.exit(1); }
  console.log("\nPASS");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
