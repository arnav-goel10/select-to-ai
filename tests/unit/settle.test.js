"use strict";
// The wait after an action: what counts as the page still doing what the
// action started, and what is the page's own background.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const TOOLS = require(path.join(__dirname, "../../extension/agentTools.js"));
const { SETTLE, createNetworkTracker, settleVerdict, stillLoadingNote, requestKey } = TOOLS;

test("a request the action started is open until it ends, then quiet is counted from its end", () => {
  const net = createNetworkTracker();
  net.begin();
  net.started("1", "https://shop.example/api/search?q=a", "Fetch", 1000);
  assert.deepEqual(net.state(1000, 1200), { open: 1, quietFor: 200 });
  assert.equal(net.state(1000, 3900).open, 1);
  net.ended("1", 4000);
  assert.deepEqual(net.state(1000, 4300), { open: 0, quietFor: 300 });
  net.end();
});

test("requests begun before the action are not the action's", () => {
  const net = createNetworkTracker();
  net.started("old", "https://a.example/feed", "XHR", 500);
  net.begin();
  assert.equal(net.state(1000, 1100).open, 0);
});

test("images, styles, sockets, event streams and beacons are not waited for", () => {
  const net = createNetworkTracker();
  net.begin();
  for (const [i, type] of ["Image", "Stylesheet", "Font", "Media", "WebSocket", "EventSource", "Ping", "Other"].entries()) net.started(String(i), `https://a.example/${i}`, type, 1000);
  assert.equal(net.state(1000, 1100).open, 0);
});

test("an address the page asks for again and again while the agent is idle is background", () => {
  const net = createNetworkTracker();
  // A poll every second while the model was thinking.
  for (let t = 0; t < 3; t++) { net.started(`p${t}`, `https://a.example/api/ping?t=${t}`, "Fetch", t * 1000); net.ended(`p${t}`, t * 1000 + 50); }
  net.begin();
  net.started("p3", "https://a.example/api/ping?t=3", "Fetch", 3000);
  net.started("s", "https://a.example/api/search", "Fetch", 3000);
  assert.equal(net.state(2990, 3100).open, 1, "the poll is not counted, the search is");
  net.ended("s", 3200);
  net.ended("p3", 3600);
  // The poll ending later does not hold the quiet period open.
  assert.equal(net.state(2990, 3700).quietFor, 500);
});

test("one request while idle is not yet background", () => {
  const net = createNetworkTracker();
  net.started("a", "https://a.example/api/results", "Fetch", 0);
  net.ended("a", 100);
  net.begin();
  net.started("b", "https://a.example/api/results", "Fetch", 5000);
  assert.equal(net.state(5000, 5100).open, 1);
});

test("a long poll held open while idle makes its address background", () => {
  const net = createNetworkTracker();
  net.started("lp", "https://a.example/updates", "XHR", 0);
  net.ended("lp", SETTLE.LONG_REQUEST_MS + 1000);
  net.begin();
  const t = SETTLE.LONG_REQUEST_MS + 1100;
  net.started("lp2", "https://a.example/updates", "XHR", t);
  assert.equal(net.state(t, t + 100).open, 0);
});

test("a request the action started stops counting once it has been open past the long limit", () => {
  const net = createNetworkTracker();
  net.begin();
  net.started("x", "https://a.example/stream", "Fetch", 0);
  assert.equal(net.state(0, SETTLE.LONG_REQUEST_MS - 1).open, 1);
  assert.equal(net.state(0, SETTLE.LONG_REQUEST_MS + 1).open, 0);
});

test("a redirect keeps one request open, not two", () => {
  const net = createNetworkTracker();
  net.begin();
  net.started("r", "https://a.example/go", "Document", 0);
  net.started("r", "https://a.example/there", "Document", 50);
  assert.equal(net.state(0, 100).open, 1);
  net.ended("r", 300);
  assert.equal(net.state(0, 400).open, 0);
});

test("the query does not make a different address", () => {
  assert.equal(requestKey("https://a.example/api/x?t=1#h"), "https://a.example/api/x");
  assert.equal(requestKey("not a url?x=1"), "not a url");
});

test("settled only when nothing is open, nothing new is busy and the page has been still for the quiet period", () => {
  const q = SETTLE.QUIET_MS;
  const quietNet = { open: 0, quietFor: q };
  assert.equal(settleVerdict({ elapsed: q, domQuietFor: q, busy: [], net: quietNet }).done, true);
  assert.equal(settleVerdict({ elapsed: q - 1, domQuietFor: q, busy: [], net: quietNet }).done, false, "the quiet period is a floor");
  assert.equal(settleVerdict({ elapsed: q, domQuietFor: q - 1, busy: [], net: quietNet }).done, false);
  assert.equal(settleVerdict({ elapsed: q, domQuietFor: q, busy: ["progress"], net: quietNet }).done, false);
  const open = settleVerdict({ elapsed: q, domQuietFor: q, busy: [], net: { open: 2, quietFor: 0 } });
  assert.equal(open.done, false);
  assert.deepEqual(open.signs, ["2 network requests still open"]);
  assert.equal(settleVerdict({ elapsed: q, domQuietFor: q, busy: [], net: { open: 0, quietFor: q - 1 } }).done, false);
  // Without the network view, the page alone decides.
  assert.equal(settleVerdict({ elapsed: q, domQuietFor: q, busy: [], net: null }).done, true);
});

test("the model is told plainly what was still loading", () => {
  const v = settleVerdict({ elapsed: 12000, domQuietFor: 0, busy: ["progress", "animation", "progress"], net: { open: 1, quietFor: 0 } });
  assert.equal(stillLoadingNote(12000, v.signs), "The page was still loading after 12 seconds: 1 network request still open, a progress bar is showing, a loading animation is running, the page was still changing.");
  assert.equal(stillLoadingNote(8040, []), "The page was still loading after 8 seconds.");
});

test("the ceilings are bounded and the fallback waits longer than the old 2.2 s cap", () => {
  assert.ok(SETTLE.CEILING_MS >= 10000 && SETTLE.CEILING_MS <= 15000);
  assert.ok(SETTLE.FALLBACK_MS > 2200 && SETTLE.FALLBACK_MS <= SETTLE.CEILING_MS);
  assert.ok(SETTLE.LONG_REQUEST_MS < SETTLE.CEILING_MS);
});
