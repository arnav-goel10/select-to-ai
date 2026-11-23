"use strict";
// A press on a control can land on a control of its own inside it (a
// Delete button on a card, a link in a row). The press would reach that
// inner control, which the policy never judged, so it is not aimed at:
// a spot asked for there is refused, a press with no spot is aimed at a
// spot of the control's own surface, and the events made by script start
// on the control itself. A control under a bar pinned over it is scrolled
// clear once before it is called covered.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CONTENT, build } = require("../helpers/content-source.js");

const NAMES = ["spotIn", "aimAtSpot", "insideOf", "missedSpot", "numberedOf", "pressesOn", "innerControlAt", "sameControl",
  "aimAt", "aimClear", "aimedAt", "stillOn", "scriptedAim", "pointerOnControl", "pointerTargetIn", "spotsOf", "drawnAllOver",
  "coverNote", "passedOverNote"];

/**
 * A page of boxes. Each is [name, parent, [left, top, width, height], opts]
 * with opts { id, tag, shown, control }; what is drawn at a point is the
 * last box declared that holds it (later boxes are drawn on top).
 */
function world(spec, extra) {
  const ids = new Map();
  const byName = {};
  const order = [];
  let shift = 0;
  const scrolled = [];
  for (const [name, parentName, box, o = {}] of spec) {
    const parent = parentName ? byName[parentName] : null;
    const n = {
      name, nodeType: 1, parentElement: parent, isConnected: true, label: o.label || name, tagName: (o.tag || "div").toUpperCase(),
      fixed: !!o.fixed, shown: o.shown !== false, labels: [],
      getBoundingClientRect() { const t = box[1] - (this.fixed ? 0 : shift); return { left: box[0], top: t, width: box[2], height: box[3], right: box[0] + box[2], bottom: t + box[3] }; },
      contains(x) { for (let y = x; y; y = y.parentElement) if (y === n) return true; return false; },
      closest: () => null,
      matches(sel) { return sel === "CONTROL" && ["BUTTON", "A", "INPUT"].includes(this.tagName); },
      scrollIntoView() { scrolled.push(name); const r = this.getBoundingClientRect(); shift += r.top + r.height / 2 - 300; },
    };
    if (o.id) ids.set(n, o.id);
    byName[name] = n;
    order.push(n);
  }
  for (const [name, , , o = {}] of spec) {
    if (o.control) { byName[name].control = byName[o.control]; byName[o.control].labels.push(byName[name]); }
  }
  const inside = (n, x, y) => { const r = n.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
  const drawnAt = (x, y) => [...order].reverse().find((n) => inside(n, x, y)) || null;
  const idOf = (n) => ids.get(n) || null;
  const scope = {
    bringIntoView: () => {},
    drawnAt,
    idOf,
    upOf: (n) => n.parentElement || null,
    getComputedStyle: () => ({ pointerEvents: "auto" }),
    document: { documentElement: null, body: null },
    visibleRect: (n) => { const r = n.getBoundingClientRect(); const top = Math.max(0, r.top); return { left: r.left, top, right: r.right, bottom: Math.min(600, r.bottom), full: r }; },
    centreInView: (n) => n.scrollIntoView(),
    labelOf: (n) => n.label,
    isShown: (n) => n.shown,
    CONTROL_SELECTOR: "CONTROL",
    nameOfDrawn: (n) => (n ? (idOf(n) ? `[${idOf(n)}] "${n.label}"` : `a ${n.tagName.toLowerCase()} "${n.label}"`) : "nothing"),
    coveredResult: (id, what) => ({ success: false, covered: true, error: `[${id}] is covered: ${what}` }),
    POINTER_TOOLS: null,
    realPointerQuietUntil: 0,
    agentCursor: null,
    gesture: null,
    ...(extra || {}),
  };
  const fns = build(NAMES, scope);
  return { ...byName, ...fns, scrolled, scope };
}

/** A card [5] at 0,0 400 by 200 with a Delete button [6] in its top right corner. */
function page() {
  return world([
    ["card", null, [0, 0, 400, 200], { id: 5, label: "Order 1042" }],
    ["title", "card", [10, 10, 200, 30]],
    ["del", "card", [300, 0, 100, 50], { id: 6, tag: "button", label: "Delete" }],
    ["icon", "del", [330, 10, 40, 30]],
  ]);
}

test("a spot of a card that lands on a listed button inside it is refused, naming that button", () => {
  const p = page();
  const spot = p.aimAtSpot(p.card, { fx: 0.85, fy: 0.1 });
  assert.equal(spot.point, null);
  assert.equal(spot.inner, p.del);
  const r = p.missedSpot(5, spot, false);
  assert.equal(r.success, false);
  assert.match(r.error, /At that spot of \[5\] is \[6\] "Delete", a control of its own inside it/);
  assert.match(r.error, /Nothing was pressed\. To use \[6\] "Delete", give its own ref/);
});

test("a spot of a card on its own words, and a spot of the inner button itself, are pressed", () => {
  const p = page();
  const words = p.aimAtSpot(p.card, { fx: 0.1, fy: 0.1 });
  assert.deepEqual(words.point, { x: 40, y: 20 });
  assert.equal(words.inner, undefined);
  const own = p.aimAtSpot(p.del, { fx: 0.5, fy: 0.5 });
  assert.deepEqual(own.point, { x: 350, y: 25 });
});

test("every gesture aimed at a spot goes through the refusal for an inner control", () => {
  const calls = CONTENT.split("aimAtSpot(el, data)").length - 1;
  assert.ok(calls >= 6, "click, double_click, right_click, hold, hover and drag aim at a spot");
  assert.ok(!/coveredResult\(id, nameOfDrawn\(spot\.cover\), (true|false)\)/.test(CONTENT));
  assert.match(CONTENT, /if \(grip && grip\.inner\) return missedSpot\(id, grip, false\);/);
});

/** A card [5] 400 by 200 with a listed button [6] drawn at its middle. */
function centred() {
  return world([
    ["card", null, [0, 0, 400, 200], { id: 5, label: "Blue teapot $24" }],
    ["picture", "card", [0, 0, 400, 150]],
    ["remove", "card", [150, 75, 100, 50], { id: 6, tag: "button", label: "Remove" }],
  ]);
}

test("a press with no spot on a card is aimed at the card's own surface, not the button at its middle", () => {
  const p = centred();
  const aim = p.aimAt(p.card);
  assert.ok(aim.point, "a spot of the card itself was found");
  assert.notEqual(p.numberedOf(aim.hit), p.remove);
  assert.equal(p.numberedOf(aim.hit), p.card);
  // The events made by script at the card's middle start on the card, not on the button.
  assert.equal(p.pointerTargetIn(p.card, { x: 200, y: 100 }), p.card);
  // A part of the card itself is still where the events start.
  assert.equal(p.pointerTargetIn(p.card, { x: 50, y: 50 }), p.picture);
});

test("a press made by script goes to the point aimed at, the same one a real press would use", async () => {
  const p = centred();
  const r = await p.pointerOnControl(p.card, 5, "Click", false, null);
  assert.equal(r.real, false);
  assert.ok(r.aimed, "the point aimed at is handed to the scripted press");
  const at = p.stillOn(p.card, r.aimed);
  assert.equal(p.innerControlAt(p.card, p.scope.drawnAt(at.x, at.y)), null);
  assert.notEqual(p.scope.drawnAt(at.x, at.y), p.remove);
});

test("a card covered all over by controls of its own is not pressed, and the result names one and says why", async () => {
  const p = world([
    ["row", null, [0, 0, 300, 40], { id: 7, label: "Invoice 1042 Open Delete" }],
    ["open", "row", [0, 0, 150, 40], { id: 8, tag: "a", label: "Open" }],
    ["delete", "row", [150, 0, 150, 40], { id: 9, tag: "button", label: "Delete" }],
  ]);
  const aim = p.aimAt(p.row);
  assert.equal(aim.point, null);
  assert.ok(aim.inner === p.open || aim.inner === p.delete);
  const r = await p.pointerOnControl(p.row, 7, "Click", false, null);
  assert.ok(r.fail, "nothing is pressed");
  assert.match(r.fail.error, /^Every spot of \[7\] on screen is on a control of its own inside it, such as \[\d\] "(Open|Delete)"/);
  assert.match(r.fail.error, /Nothing was pressed\. To use \[\d\] "(Open|Delete)", give its own ref; to use \[7\], pick a spot of it outside that control/);
  // The gestures made only by script are refused the same way.
  assert.match(p.scriptedAim(p.row, 7, false).fail.error, /Every spot of \[7\]/);
});

test("a button the page draws invisibly over a card is passed over too, and said to be unseen", () => {
  const p = world([
    ["card", null, [0, 0, 300, 200], { id: 5, label: "Blue teapot $24" }],
    ["photo", "card", [0, 0, 300, 160]],
    ["quick", "card", [100, 80, 100, 40], { tag: "button", shown: false, label: "Add to cart" }],
  ]);
  assert.equal(p.innerControlAt(p.card, p.quick), p.quick);
  const aim = p.aimAt(p.card);
  assert.ok(aim.point);
  assert.notEqual(aim.hit, p.quick);
  assert.equal(p.pointerTargetIn(p.card, { x: 150, y: 100 }), p.card);
  const r = p.missedSpot(5, { point: null, inner: p.quick }, false, true);
  assert.match(r.error, /such as a button "Add to cart", so the press would reach that instead\. Nothing was pressed\. That control is not in the list of controls you were shown: the page does not draw it for a person to see\. To use \[5\], pick a spot/);
  assert.doesNotMatch(r.error, /give its own ref/);
});

test("a part of the control that is no control is pressed as the control", () => {
  const p = world([
    ["card", null, [0, 0, 300, 200], { id: 5 }],
    ["price", "card", [100, 80, 100, 40], { tag: "span" }],
  ]);
  assert.equal(p.innerControlAt(p.card, p.price), null);
  assert.equal(p.aimAt(p.card).hit, p.price);
});

test("a control drawn inside the one pressed that the listing left out is still a control of its own", () => {
  // A row listed, its Delete link dropped from the listing (past its
  // limits), drawn where the row's middle is.
  const p = world([
    ["row", null, [0, 0, 400, 40], { id: 5, label: "Invoice 1042 Acme Ltd $120.00" }],
    ["words", "row", [0, 0, 400, 40], { tag: "span" }],
    ["del", "row", [150, 0, 100, 40], { tag: "a", label: "Delete" }],
  ]);
  assert.equal(p.innerControlAt(p.row, p.del), p.del);
  const aim = p.aimAt(p.row);
  assert.ok(aim.point);
  assert.equal(aim.hit, p.words);
  assert.equal(aim.passed, p.del, "the aim says what it went round");
  assert.equal(p.pointerTargetIn(p.row, { x: 200, y: 20 }), p.row);
  const r = p.missedSpot(5, { point: null, inner: p.del }, false, true);
  assert.match(r.error, /such as a a "Delete", so the press would reach that instead\. Nothing was pressed\. That control is not in the list of controls you were shown\. To use \[5\], pick a spot/);
  assert.doesNotMatch(r.error, /does not draw it/);
});

test("a link drawn out over the whole of a card is the card, though its own box is only its words", async () => {
  // A card whose title link has a layer of its own (a ::after) stretched
  // over the card: every spot of the card is the link.
  const p = world([
    ["card", null, [0, 0, 300, 200], { id: 5, label: "Red kettle $30" }],
    ["title", "card", [10, 10, 120, 24]],
    ["link", "title", [10, 10, 120, 24], { id: 6, tag: "a", label: "Red kettle" }],
    ["stretch", "link", [0, 0, 300, 200]],
  ]);
  assert.equal(p.innerControlAt(p.card, p.stretch), null);
  const r = await p.pointerOnControl(p.card, 5, "Click", false, null);
  assert.equal(r.fail, undefined, "the press is not refused");
  const at = p.stillOn(p.card, r.aimed);
  // The events start where a person's press would, on the link's layer.
  assert.equal(p.pointerTargetIn(p.card, at), p.stretch);
  // One link over only part of the card is still a control of its own.
  const q = world([
    ["card", null, [0, 0, 300, 200], { id: 5, label: "Red kettle $30" }],
    ["link", "card", [100, 80, 100, 40], { id: 6, tag: "a", label: "Red kettle" }],
  ]);
  assert.equal(q.innerControlAt(q.card, q.link), q.link);
});

test("a press that went round an inner control and got no answer says so and names it", () => {
  const p = world([]);
  const none = { outcome: { noEffect: true }, settle: { network: true } };
  const note = p.passedOverNote(7, '[8] "Open inbox"', none);
  assert.match(note, /The press went on \[7\] itself, clear of \[8\] "Open inbox" inside it, and the page showed no answer to it\. If \[7\] does its work through \[8\] "Open inbox", press that instead\./);
  // Any answer from the page, and nothing is said.
  assert.equal(p.passedOverNote(7, '[8] "Open inbox"', { outcome: { noEffect: false } }), "");
  assert.equal(p.passedOverNote(7, '[8] "Open inbox"', { ...none, stateChanged: true }), "");
  assert.equal(p.passedOverNote(7, '[8] "Open inbox"', { ...none, ways: { by: "Enter" } }), "");
  assert.equal(p.passedOverNote(7, '[8] "Open inbox"', { ...none, settle: { asked: true } }), "");
  assert.equal(p.passedOverNote(7, null, none), "");
  // The click hands what it went round to the measured result, which adds the note.
  assert.match(CONTENT, /const passedOver = pressed\.passed \? \{ passedOver: nameOfDrawn\(pressed\.passed\) \} : \{\};/);
  assert.match(CONTENT, /result\.message \+= passedOverNote\(request\.data\.id, result\.passedOver, result\);/);
});

test("a tab whose whole surface is its link, or a control with exactly the same words, is the same control", () => {
  const p = world([
    ["tab", null, [0, 0, 120, 40], { id: 3, label: "Settings" }],
    ["link", "tab", [0, 0, 120, 40], { id: 4, tag: "a", label: "Settings" }],
    ["tab2", null, [200, 0, 120, 40], { id: 13, label: "Billing" }],
    ["link2", "tab2", [216, 8, 88, 24], { id: 14, tag: "a", label: "Billing" }],
  ]);
  assert.equal(p.innerControlAt(p.tab, p.link), null);
  assert.equal(p.aimAt(p.tab).hit, p.link);
  assert.equal(p.pointerTargetIn(p.tab, { x: 60, y: 20 }), p.link);
  assert.equal(p.innerControlAt(p.tab2, p.link2), null);
  assert.equal(p.aimAt(p.tab2).hit, p.link2);
});

test("a label with a box drawn by the page is pressed on its words, not on the link inside it", () => {
  const p = world([
    ["agree", null, [0, 0, 560, 40], { tag: "label", id: 20, label: "Show prices with tax, as explained in the pricing notes", control: "box" }],
    ["box", "agree", [0, 10, 20, 20], { tag: "input", shown: true }],
    ["notes", "agree", [150, 0, 200, 40], { id: 21, tag: "a", label: "pricing notes" }],
  ]);
  // The label listed: its own input is its surface, the link is not.
  assert.equal(p.innerControlAt(p.agree, p.box), null);
  assert.equal(p.innerControlAt(p.agree, p.notes), p.notes);
  const aim = p.aimAt(p.agree);
  assert.ok(aim.point);
  assert.notEqual(aim.hit, p.notes);
  assert.equal(p.pointerTargetIn(p.agree, { x: 280, y: 20 }), p.agree);
});

test("a box too small to press is pressed by its label, clear of a link inside the label", () => {
  const p = world([
    ["label", null, [0, 0, 560, 40], { tag: "label", label: "Show prices with tax, as explained in the pricing notes", control: "input" }],
    ["notes", "label", [150, 0, 200, 40], { id: 21, tag: "a", label: "pricing notes" }],
    ["input", null, [0, 0, 0, 0], { tag: "input", id: 22 }],
  ]);
  assert.equal(p.innerControlAt(p.input, p.notes), p.notes);
  const aim = p.aimAt(p.input);
  assert.ok(aim.point);
  assert.equal(aim.hit, p.label);
});

test("a row under a bar pinned over it is scrolled clear once and pressed, not called covered", async () => {
  const p = world([
    ["row", null, [0, 20, 400, 44], { id: 30, label: "Grace: Lunch on Friday" }],
    ["header", null, [0, 0, 600, 80], { fixed: true, label: "Inbox" }],
  ]);
  const first = p.aimAt(p.row);
  assert.equal(first.point, null);
  assert.equal(first.cover, p.header);
  const r = await p.pointerOnControl(p.row, 30, "Click", false, null);
  assert.deepEqual(p.scrolled, ["row"]);
  assert.equal(r.fail, undefined, "the press was not refused");
  assert.ok(r.aimed);
  const at = p.stillOn(p.row, r.aimed);
  assert.equal(p.scope.drawnAt(at.x, at.y), p.row);
});

test("with the real pointer, what still covers a control after it is scrolled to the middle is refused as covering it", async () => {
  const p = world([
    ["row", null, [0, 20, 400, 44], { id: 30 }],
    ["dialog", null, [0, 0, 800, 600], { fixed: true, label: "Accept cookies" }],
  ], { POINTER_TOOLS: { clickSteps: (pt) => [{ t: "move", ...pt }] }, gesture: async () => { throw new Error("a covered control was pressed"); } });
  const r = await p.pointerOnControl(p.row, 30, "Click", false, null);
  assert.deepEqual(p.scrolled, ["row"], "scrolled once, not again and again");
  assert.match(r.fail.error, /\[30\] is covered: a div "Accept cookies"/);
});

test("with no real pointer, a covered control is still pressed by script, and the result says what covers it", async () => {
  // Events made by script go to the control whatever is drawn over it (a
  // leftover see-through backdrop, a notice), as they always did.
  const p = world([
    ["row", null, [0, 20, 400, 44], { id: 30 }],
    ["layer", null, [0, 0, 800, 600], { fixed: true }],
  ]);
  const r = await p.pointerOnControl(p.row, 30, "Click", false, null);
  assert.equal(r.fail, undefined, "not refused");
  assert.equal(r.real, false);
  assert.equal(r.cover, p.layer);
  // The events start on the control itself, not on the layer.
  assert.equal(p.pointerTargetIn(p.row, { x: 200, y: 42 }), p.row);
  assert.match(p.coverNote(30, r.cover, false), /^ a div "layer" is drawn over \[30\] where it is on screen, so a person's press would reach that instead\. The events were made by script on \[30\] itself\.$/);
  assert.match(p.coverNote(30, r.cover, true), /a person's pointer would reach/);
  assert.equal(p.coverNote(30, undefined, false), "");
  // A hover, and the gestures made only by script, the same way.
  const h = await p.pointerOnControl(p.row, 30, "Hover", true, null);
  assert.equal(h.cover, p.layer);
  const g = p.scriptedAim(p.row, 30, false);
  assert.equal(g.fail, undefined);
  assert.equal(g.cover, p.layer);
  for (const said of ["Clicked element", "Double-clicked element", "Right-clicked element", "before letting go", "without pressing it, and left it there"]) {
    const at = CONTENT.indexOf(said);
    assert.ok(at > 0 && /coverNote\(id, (pressed|aim|moved)\.cover, (true|false)\)/.test(CONTENT.slice(at - 1200, at + 300)), `${said} says what covers the control`);
  }
});

test("a spot asked for under a pinned bar is scrolled clear too", () => {
  const p = world([
    ["chart", null, [0, 10, 400, 60], { id: 40 }],
    ["header", null, [0, 0, 600, 80], { fixed: true }],
  ]);
  const spot = p.aimAtSpot(p.chart, { fx: 0.5, fy: 0.5 });
  assert.ok(spot.point);
  assert.deepEqual(p.scrolled, ["chart"]);
});

test("a real press that lands on a control inside the one aimed at says so", async () => {
  // The page moved between the aim and the press: the press reached the button.
  const p = world([
    ["card", null, [0, 0, 400, 200], { id: 5, label: "Blue teapot $24" }],
    ["picture", "card", [0, 0, 400, 150]],
    ["remove", "card", [150, 75, 100, 50], { id: 6, tag: "button", label: "Remove" }],
  ], { POINTER_TOOLS: { clickSteps: (pt) => [{ t: "move", ...pt }] }, gesture: async () => ({ real: true, landed: { target: landed } }) });
  const landed = p.remove;
  const r = await p.pointerOnControl(p.card, 5, "Click", false, null);
  assert.equal(r.real, true);
  assert.match(r.note, /The press landed on \[6\] "Remove", a control of its own inside \[5\], not on \[5\] itself/);
});
