"use strict";
// Recipes in the service worker (extension/recipes/service.js): what a
// recording that cannot see requests takes a press to be, and what is kept
// of a run so "Save as recipe" works, or says why not, after the worker
// restarted. The recorder is a stand-in that tapes what it is told; the
// class of a taped step is the real core's (classOf).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const EXT = path.resolve(__dirname, "../../extension");
const CORE = require(`${EXT}/recipes/vendor/recipes-core.js`);

const PAGE = "https://app.example/items/41";
const snap = (url) => ({ url, title: "", outline: [], text: "", elements: [] });
const button = (more) => ({ tag: "button", kind: "button", name: "Apply", href: "", form: null, submits: false, ...more });
// The controls of the stand-in page, by the agent's number for them.
const CONTROLS = {
  1: button({ name: "Apply" }),
  2: { tag: "a", kind: "link", name: "Orders", href: "https://app.example/orders", form: null, submits: false },
  3: { tag: "input", kind: "textbox", inputType: "text", name: "Quantity", form: { search: false, fields: 2 }, submits: false },
  // A message box no form holds: Enter in it sends, by a script.
  4: { ref: "e4", tag: "input", kind: "textbox", inputType: "text", name: "Message", value: "hello there", form: null, submits: false },
  5: button({ name: "Leave team" }),
};

/** service.js over a stand-in recorder and driver; `sees` is whether requests are seen (the debugger build). */
function load({ sees }) {
  class Recorder {
    constructor(driver) { this.driver = driver; this.tape = []; this.vars = {}; }
    async _do(action, target, opts) {
      const el = target ? CONTROLS[target.agentId] : null;
      const r = await this.driver.act(action);
      if (r.ok === false) throw new Error(`record: ${action.do} failed: ${r.error}`);
      const after = snap(action.do === "navigate" ? action.url : el && el.kind === "link" ? el.href : PAGE);
      // Enter in the message box sends: the message joins the page and the box empties.
      if (action.do === "press" && el && el.name === "Message") { after.text = "You: hello there"; after.elements = [{ ...el, value: "" }]; }
      this.tape.push({ action, el, ref: el ? el.ref : null, before: snap(PAGE), after, requests: r.requests || [], declaredClass: opts && opts.class });
      return r;
    }
    goto(url) { return this._do({ do: "navigate", url }, null); }
    click(target, opts) { return this._do({ do: "click" }, target, opts); }
    fill(target, value, opts) { return this._do({ do: "fill", value }, target, opts); }
    press(target, key, opts) { return this._do({ do: "press", key }, target, opts); }
    compile() { return { id: `rcp_${this.tape.length}`, title: "", steps: this.tape.map((e) => ({ action: e.action, class: CORE.classOf(e) })), provenance: {} }; }
  }
  globalThis.SELECT_TO_AI_RECIPES_CORE = { ...CORE, Recorder };
  globalThis.SELECT_TO_AI_RECIPES_DRIVER = {
    createNetworkView: () => ({ sees, mark: () => 0, since: () => [], busy: () => 0, close() {} }),
    createDriver: () => ({}),
  };
  delete require.cache[require.resolve(`${EXT}/recipes/service.js`)];
  return require(`${EXT}/recipes/service.js`);
}

function fakeChrome() {
  const area = () => {
    const data = {};
    return {
      data,
      async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
      async set(items) { Object.assign(data, structuredClone(items)); },
    };
  };
  return { storage: { session: area(), local: area() }, tabs: { get: async (id) => ({ id, url: PAGE, status: "complete" }) } };
}

let n = 0;
/** A run of the agent's on one tab: act() carries an action out through the recording, as the engine does. */
function agentRun(RECIPES, chrome) {
  const run = { id: `run-${++n}`, tabId: 1, task: "Apply the change" };
  const session = { run, page: { url: PAGE, elements: [] } };
  RECIPES.begin(run, chrome);
  const act = (a) => RECIPES.around(session, a, async () => ({ ok: true, message: "done" }));
  const finish = (state = "success") => { run.outcome = { state }; RECIPES.end(run); };
  return { run, session, act, finish };
}
const classes = (RECIPES, id) => RECIPES._recordings.get(id).rec.compile().steps.map((s) => `${s.action.do}:${s.class}`);

test("without a view of requests, a press that may have written is a commit step; what the recording shows to be harmless is not", () => {
  const RECIPES = load({ sees: false });
  const yes = (el, action = { do: "click" }, after = PAGE) => RECIPES.mayHaveWritten({ action, el, before: snap(PAGE), after: snap(after) });
  assert.equal(yes(button()), true, "a script-driven button outside a form");
  assert.equal(yes(button({ form: { search: false, fields: 3 } })), true, "a plain button inside a form");
  assert.equal(yes(button(), { do: "press", key: "Enter" }), true, "Enter on a button presses it");
  assert.equal(yes({ tag: "div", kind: "option", name: "Singapore", form: null }), true);
  assert.equal(yes({ tag: "a", kind: "link", href: "https://app.example/items/41#", form: null }), true, "a link that went nowhere ran a script");
  assert.equal(yes({ tag: "input", kind: "checkbox", inputType: "checkbox", form: null }), true, "a tick outside any form is saved by a script, or not: it cannot tell");
  // What the recording itself shows did not write.
  assert.equal(yes({ tag: "a", kind: "link", href: "https://app.example/orders", form: null }, { do: "click" }, "https://app.example/orders"), false, "a link that led to its page");
  assert.equal(yes(button({ form: { search: true, fields: 1 } })), false, "a search form");
  assert.equal(yes({ tag: "input", kind: "textbox", inputType: "text", form: null }), false, "a click into a box");
  assert.equal(yes({ tag: "input", kind: "textbox", inputType: "text", form: null }, { do: "press", key: "Enter" }), false, "Enter in a box that changed nothing");
  assert.equal(yes({ tag: "input", kind: "checkbox", inputType: "checkbox", form: { search: false, fields: 2 } }), false, "a tick inside a form waits for its submit");
  assert.equal(yes({ tag: "select", kind: "combobox", form: null }), false);
  assert.equal(yes(button(), { do: "hover" }), false);
  assert.equal(yes(button(), { do: "fill", value: "x" }), false);
});

test("without a view of requests, Enter in a box or editor outside a form is a commit step when the page read differently afterwards", () => {
  const RECIPES = load({ sees: false });
  const box = (more) => ({ ref: "e7", tag: "input", kind: "textbox", inputType: "text", name: "Message", value: "hello there", form: null, ...more });
  const editor = (more) => ({ ref: "e7", tag: "div", kind: "textbox", editable: true, name: "Comment", text: "looks good", form: null, ...more });
  const page = (text, el, more) => ({ url: PAGE, title: "", outline: [], notices: [], text, elements: el ? [el] : [], ...more });
  const enter = (el, before, after, key = "Enter") => RECIPES.mayHaveWritten({ action: { do: "press", key }, el, ref: el ? el.ref : null, before, after });
  // A chat send: the message joins the thread and the box empties.
  assert.equal(enter(box(), page("Ana: hi", box()), page("Ana: hi You: hello there", box({ value: "" }))), true, "a message sent with Enter");
  // The thread reads the same once spaces are set aside, but the box emptied.
  assert.equal(enter(editor(), page("Thread looks good", editor()), page("Thread\nlooks good", editor({ text: "" }))), true, "an editor that emptied");
  assert.equal(enter(editor(), page("Post", editor()), page("Post", null)), true, "the box is gone");
  assert.equal(enter(box(), page("Ana: hi", box()), page("Ana: hi", box(), { notices: ["Saved"] })), true, "the page announced something");
  assert.equal(enter(box(), page("Ana: hi", box()), page("Ana: hi", box(), { url: "https://app.example/items/42" })), true, "another address");
  // Enter with nothing the recording knows in focus.
  assert.equal(enter(null, page("3 items"), page("2 items")), true, "Enter with no target, after which the page changed");
  assert.equal(enter(null, page("3 items"), page("3 items")), false, "Enter with no target that changed nothing");
  assert.equal(enter(null, page("3 items"), page("2 items"), " "), false, "Space with no target scrolls");
  // Only a new line: the words on the page and in the box are the same.
  assert.equal(enter(editor(), page("Thread looks good", editor()), page("Thread looks good\n", editor({ text: "looks good\n" }))), false, "a new line in an editor");
  assert.equal(enter({ ...box(), tag: "textarea" }, page("Notes", box()), page("Notes", box({ value: "hello there\n" }))), false, "a new line in a text area");
  // A box the page itself calls a search box, and a list, are not sends.
  assert.equal(enter(box({ kind: "searchbox", inputType: "search" }), page("All items", box()), page("1 item", box())), false, "a search box");
  assert.equal(enter(box({ kind: "searchbox" }), page("All items", box()), page("1 item", box())), false, "a box with the search role");
  assert.equal(enter({ ref: "e7", tag: "select", kind: "combobox", form: null }, page("a"), page("b")), false);
  assert.equal(enter(box(), page("Ana: hi", box()), page("Ana: hi You: hello there", box({ value: "" })), "a"), false, "a letter typed is not a press");
  // Inside a form, Enter is the form's own submit, which the core classes.
  assert.equal(enter(box({ form: { search: false, fields: 2 } }), page("a", box()), page("b", box())), false);
  assert.equal(CORE.classOf({ action: { do: "press", key: "Enter" }, el: box({ form: { search: false, fields: 2 } }), requests: [] }), "commit");
});

test("a link the browser followed to a place on the same page is not a commit step; one that went nowhere is", () => {
  const RECIPES = load({ sees: false });
  const link = (href) => ({ tag: "a", kind: "link", href, form: null });
  const went = (href, after) => RECIPES.mayHaveWritten({ action: { do: "click" }, el: link(href), before: snap(PAGE), after: snap(after) });
  assert.equal(went(`${PAGE}#returns`, `${PAGE}#returns`), false, "a link to a section of the page");
  assert.equal(went(`${PAGE}#`, `${PAGE}#`), true, "an empty fragment is a script's button");
  assert.equal(went(`${PAGE}#returns`, PAGE), true, "the address did not follow the link");
  assert.equal(went("https://app.example/orders", PAGE), true, "a link to another page that stayed here");
});

test("a recorded Enter that sent a message is a commit step on a build that sees no requests", async () => {
  const blind = load({ sees: false });
  const a = agentRun(blind, fakeChrome());
  await a.act({ do: "fill", ref: 4, value: "hello there" });
  await a.act({ do: "press", ref: 4, key: "Enter" });
  await a.act({ do: "press", key: "Enter" });
  assert.deepEqual(classes(blind, a.run.id), ["navigate:read", "fill:edit", "press:commit", "press:read"]);
  const seeing = load({ sees: true });
  const b = agentRun(seeing, fakeChrome());
  await b.act({ do: "press", ref: 4, key: "Enter" });
  assert.deepEqual(classes(seeing, b.run.id), ["navigate:read", "press:read"]);
});

test("the reason a run cannot be saved is in plain words for every action a recipe cannot repeat", async () => {
  const chrome = fakeChrome();
  const RECIPES = load({ sees: false });
  const why = async (action) => {
    const a = agentRun(RECIPES, chrome);
    await a.act({ do: "click", ref: 1 });
    await a.act(action);
    a.finish();
    return (await RECIPES.canSave(chrome, a.run.id)).why;
  };
  assert.match(await why({ do: "click_at", x: 10, y: 20 }), /pressed a spot on the page by where it was/);
  assert.match(await why({ do: "delegate", task: "look it up" }), /handed part of the work to a helper run/);
  assert.equal(await why({ do: "drag", ref: 1, to_ref: 3 }), "it used drag, which a recipe cannot repeat");
  for (const action of [{ do: "click_at" }, { do: "delegate" }, { do: "some_new_action" }]) assert.doesNotMatch(await why(action), /_/, "no action name with an underscore reaches the user");
});

test("a recorded press on a script-driven button is a commit step on a build that sees no requests, and only there", async () => {
  const blind = load({ sees: false });
  const a = agentRun(blind, fakeChrome());
  await a.act({ do: "fill", ref: 3, value: "40" });
  await a.act({ do: "click", ref: 2 });
  await a.act({ do: "click", ref: 1 });
  assert.deepEqual(classes(blind, a.run.id), ["navigate:read", "fill:edit", "click:read", "click:commit"]);
  // With requests in view, a press that sent none is as the core classes it.
  const seeing = load({ sees: true });
  const b = agentRun(seeing, fakeChrome());
  await b.act({ do: "click", ref: 1 });
  assert.deepEqual(classes(seeing, b.run.id), ["navigate:read", "click:read"]);
});

test("a press the check judges is recorded as a commit whatever it said, so a replay never presses it free; a link is a commit only when the check said so", async () => {
  globalThis.SELECT_TO_AI_TOOLS = require(`${EXT}/agentTools.js`);
  globalThis.SELECT_TO_AI_POLICY = require(`${EXT}/core/policy.js`);
  try {
    const TOOLS = globalThis.SELECT_TO_AI_TOOLS;
    const page = { url: PAGE, elements: [{ id: 5, tagName: "button", accName: "Weiter" }, { id: 6, tagName: "a", accName: "Unsubscribe", url: `${PAGE}u?id=1` }], forms: [] };
    const key = (ref) => TOOLS.pressEntryOf(page.elements.find((e) => e.id === ref), page).entry.key;
    const recorded = async (ref, said) => {
      const RECIPES = load({ sees: true });
      const a = agentRun(RECIPES, fakeChrome());
      a.session.page = page;
      if (said) a.run.opinions = { [key(ref)]: said };
      await a.act({ do: "click", ref });
      return classes(RECIPES, a.run.id);
    };
    assert.deepEqual(await recorded(5, { does: "delete" }), ["navigate:read", "click:commit"]);
    assert.deepEqual(await recorded(5, null), ["navigate:read", "click:commit"], "not asked: held as a commit");
    // "Weiter" judged harmless on one run may submit on a later one: it stays a commit.
    assert.deepEqual(await recorded(5, { does: "none" }), ["navigate:read", "click:commit"]);
    // A link: the recording sees where the browser went, and the check's word can only tighten it.
    assert.deepEqual(await recorded(6, { does: "delete" }), ["navigate:read", "click:commit"]);
    // A press the check gave no answer for, pressed because the user chose to carry on without it, is a commit either way: a replay with no one there holds it.
    assert.deepEqual(await recorded(5, { unanswered: true }), ["navigate:read", "click:commit"]);
    assert.deepEqual(await recorded(6, { unanswered: true }), ["navigate:read", "click:commit"]);
  } finally {
    delete globalThis.SELECT_TO_AI_TOOLS;
    delete globalThis.SELECT_TO_AI_POLICY;
  }
});

test("a run that ended can be saved after the worker restarted, once", async () => {
  const chrome = fakeChrome();
  let RECIPES = load({ sees: false });
  const a = agentRun(RECIPES, chrome);
  await a.act({ do: "click", ref: 1 });
  a.finish();
  assert.deepEqual(await RECIPES.canSave(chrome, a.run.id), { ok: true, steps: 1 });
  // The worker restarts: its memory is gone, session storage is not.
  RECIPES = load({ sees: false });
  assert.equal(RECIPES._recordings.size, 0);
  assert.deepEqual(RECIPES.saveable(a.run.id).ok, false, "nothing in memory");
  assert.deepEqual(await RECIPES.canSave(chrome, a.run.id), { ok: true, steps: 1 });
  const saved = await RECIPES.saveRun(chrome, a.run.id);
  assert.equal(saved.ok, true, saved.why);
  const kept = chrome.storage.local.data.recipesStore.recipes;
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].recipe.steps.map((s) => s.class), ["read", "commit"]);
  assert.equal(kept[0].recipe.provenance.source, "agent_run");
  // Saved once: asked again, it says so and does not save a second copy.
  const again = await RECIPES.canSave(chrome, a.run.id);
  assert.equal(again.ok, false);
  assert.equal(again.saved, saved.id);
  assert.equal((await RECIPES.saveRun(chrome, a.run.id)).ok, false);
  assert.equal(chrome.storage.local.data.recipesStore.recipes.length, 1);
});

test("a run that cannot be saved says why, in memory and after a restart", async () => {
  const chrome = fakeChrome();
  let RECIPES = load({ sees: false });
  const cases = [
    [{ do: "fill", ref: 3, from: "email" }, /saved details/],
    [{ do: "fill_details" }, /saved details/],
    [{ do: "tabs", op: "open", url: "https://other.example/" }, /more than one tab/],
    [{ do: "click", ref: 100004 }, /inside a frame of the page/],
  ];
  const runs = [];
  for (const [action, why] of cases) {
    const a = agentRun(RECIPES, chrome);
    await a.act({ do: "click", ref: 1 });
    await a.act(action);
    a.finish();
    const can = await RECIPES.canSave(chrome, a.run.id);
    assert.equal(can.ok, false);
    assert.match(can.why, why);
    assert.ok(!can.nothing && !can.pending, "a reason the view shows");
    runs.push([a.run.id, can.why]);
  }
  RECIPES = load({ sees: false });
  for (const [id, why] of runs) assert.deepEqual(await RECIPES.canSave(chrome, id), { ok: false, why });
  // A run that only read has nothing to lose: it is marked so the view stays quiet.
  const quiet = agentRun(RECIPES, chrome);
  await quiet.act({ do: "scroll", direction: "down" });
  quiet.finish();
  assert.equal((await RECIPES.canSave(chrome, quiet.run.id)).nothing, true);
  // A run nothing is known of: the reason is that its recording is gone.
  assert.match((await RECIPES.canSave(chrome, "run-unknown")).why, /no longer kept \(the browser or the extension restarted/);
  // That is the extension's business, so it is marked for the view to leave unsaid.
  assert.equal((await RECIPES.canSave(chrome, "run-unknown")).gone, true);
});

test("a run the worker restarted under says so when it ends", async () => {
  const chrome = fakeChrome();
  let RECIPES = load({ sees: false });
  const a = agentRun(RECIPES, chrome);
  await a.act({ do: "click", ref: 1 });
  // Restart mid-run: the steps recorded so far are gone.
  RECIPES = load({ sees: false });
  RECIPES.install({ ...chrome, runtime: { onConnect: { addListener() {} } } });
  a.run.outcome = { state: "success" };
  RECIPES.end(a.run);
  const can = await RECIPES.canSave(chrome, a.run.id);
  assert.equal(can.ok, false);
  assert.match(can.why, /restarted while the run was going/);
});

test("only the last few runs are kept, and no typed secret is among what is kept", async () => {
  const chrome = fakeChrome();
  const RECIPES = load({ sees: false });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const a = agentRun(RECIPES, chrome);
    await a.act({ do: "click", ref: 1 });
    a.finish();
    await RECIPES.canSave(chrome, a.run.id);
    ids.push(a.run.id);
  }
  const kept = chrome.storage.session.data.recipeDrafts;
  assert.deepEqual(kept.map((d) => d.runId), ids.slice(-4).reverse());
  assert.ok(kept.every((d) => !("secrets" in d) && !("vars" in d)), "only the compiled recipe is kept");
});

test("the agent page shows why a run cannot be saved instead of dropping the line", () => {
  const src = require("node:fs").readFileSync(`${EXT}/agent.js`, "utf8");
  const draw = src.slice(src.indexOf("function drawSaveRecipe("), src.indexOf("const RECEIPT_STATES"));
  assert.match(draw, /This run cannot be saved as a recipe: \$\{can\.why/);
  assert.match(draw, /can\.nothing \|\| can\.pending/, "only a run with nothing to repeat, or one still going, stays quiet");
  assert.ok(!/if \(!can \|\| !can\.ok\) return;/.test(draw), "a run that cannot be saved is not passed over in silence");
});
