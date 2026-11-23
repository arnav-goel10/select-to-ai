"use strict";
// A spot asked for inside a control can sit on a listed control of its own
// (a Delete button on a card). The press would reach that inner control,
// which the policy never judged, so the spot is refused and the model is
// told to use the inner control's ref.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CONTENT, build } = require("../helpers/content-source.js");

/** A card [5] at 0,0 400 by 200 with a Delete button [6] in its top right corner. */
function page() {
  const ids = new Map();
  const node = (name, parent, box, id) => {
    const n = {
      name, nodeType: 1, parentElement: parent || null, isConnected: true, label: name,
      getBoundingClientRect: () => ({ left: box[0], top: box[1], width: box[2], height: box[3], right: box[0] + box[2], bottom: box[1] + box[3] }),
      contains(x) { for (let y = x; y; y = y.parentElement) if (y === n) return true; return false; },
      closest: () => null,
    };
    if (id) ids.set(n, id);
    return n;
  };
  const card = node("Order 1042", null, [0, 0, 400, 200], 5);
  const title = node("title", card, [10, 10, 200, 30]);
  const del = node("Delete", card, [300, 0, 100, 50], 6);
  const icon = node("icon", del, [330, 10, 40, 30]);
  const inside = (n, x, y) => { const r = n.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
  const drawnAt = (x, y) => [icon, del, title, card].find((n) => inside(n, x, y)) || null;
  const idOf = (n) => ids.get(n) || null;
  const fns = build(["spotIn", "aimAtSpot", "insideOf", "missedSpot", "numberedOf", "pressesOn"], {
    bringIntoView: () => {},
    drawnAt,
    idOf,
    upOf: (n) => n.parentElement || null,
    getComputedStyle: () => ({ pointerEvents: "auto" }),
    nameOfDrawn: (n) => (n ? (idOf(n) ? `[${idOf(n)}] "${n.label}"` : `"${n.label}"`) : "nothing"),
    coveredResult: (id, what) => ({ success: false, covered: true, error: `[${id}] is covered: ${what}` }),
  });
  return { card, del, title, ...fns };
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
