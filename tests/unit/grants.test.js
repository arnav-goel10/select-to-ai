"use strict";
// Optional permissions (extension/core/grants.js): with notifications and
// the optional hosts ungranted every helper resolves quietly, host requests
// ask for exactly the origin in hand, and the assistant content script is
// registered once however often it is asked.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const G = require("../../extension/core/grants.js");

const event = () => {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), fire: (...a) => listeners.forEach((fn) => fn(...a)) };
};

// A chrome stand-in. notifications is left out unless asked for, as in a
// worker where the user never granted it.
function fakeChrome({ notifications = false, granted = [], grantOnRequest = true } = {}) {
  const calls = { request: [], contains: [], register: [], update: [], unregister: [], create: [], clear: [] };
  const grants = new Set(granted);
  const registered = new Map();
  const c = {
    calls,
    grants,
    registered,
    runtime: { lastError: undefined },
    permissions: {
      onAdded: event(),
      contains(q, cb) {
        calls.contains.push(q);
        cb([...(q.origins || []), ...(q.permissions || [])].every((x) => grants.has(x)));
      },
      request(q, cb) {
        calls.request.push(q);
        if (grantOnRequest) [...(q.origins || []), ...(q.permissions || [])].forEach((x) => grants.add(x));
        cb(grantOnRequest);
      },
    },
    scripting: {
      getRegisteredContentScripts(f, cb) {
        setTimeout(() => cb([...registered.values()].filter((s) => !f || !f.ids || f.ids.includes(s.id))), 1);
      },
      registerContentScripts(list, cb) {
        calls.register.push(list);
        for (const s of list) {
          if (registered.has(s.id)) { c.runtime.lastError = { message: `Duplicate script ID '${s.id}'` }; cb(); c.runtime.lastError = undefined; return; }
          registered.set(s.id, s);
        }
        cb();
      },
      updateContentScripts(list, cb) {
        calls.update.push(list);
        for (const s of list) registered.set(s.id, { ...registered.get(s.id), ...s });
        cb();
      },
      unregisterContentScripts(f, cb) {
        calls.unregister.push(f);
        for (const id of f.ids) registered.delete(id);
        cb();
      },
    },
  };
  if (notifications) {
    c.notifications = {
      onClicked: event(),
      onButtonClicked: event(),
      create(...args) {
        const cb = args.pop();
        calls.create.push(args);
        cb(typeof args[0] === "string" ? args[0] : "auto-1");
      },
      clear(id, cb) { calls.clear.push(id); cb(true); },
    };
  }
  return c;
}

test("with notifications ungranted every helper resolves and nothing throws", async () => {
  const chrome = fakeChrome();
  const g = G.create(chrome);
  assert.equal(chrome.notifications, undefined);
  assert.equal(await g.notify({ title: "Task done", message: "x" }), null);
  assert.equal(await g.notify("agent-wait:3", { title: "Waiting" }), null);
  assert.equal(await g.clearNotice("agent-wait:3"), false);
  assert.equal(g.onNoticeClicked(() => {}), false);
  assert.equal(await g.hasNotifications(), false);
  assert.equal(await g.hasHost("https://claude.ai"), false);
  assert.deepEqual(await g.registerAssistantScripts(), []);
  assert.equal(g.faviconFor({ url: "https://example.com/" }), G.GENERIC_ICON);
});

test("with no chrome at all (a plain page or Node) every helper still resolves", async () => {
  const g = G.create({});
  assert.equal(await g.notify({ message: "x" }), null);
  assert.equal(await g.clearNotice("a"), false);
  assert.equal(g.onNoticeClicked(() => {}), false);
  assert.equal(await g.hasNotifications(), false);
  assert.equal(await g.requestNotifications(), false);
  assert.equal(await g.hasHost("https://claude.ai"), false);
  assert.equal(await g.requestHost("https://claude.ai"), false);
  assert.deepEqual(await g.registerAssistantScripts(), []);
  // The module's own instance runs here with chrome undefined.
  assert.equal(typeof globalThis.chrome, "undefined");
  assert.equal(await G.notify({ message: "x" }), null);
  assert.equal(await G.hasHost("https://claude.ai"), false);
});

test("a click listener asked for before the grant attaches when notifications are granted", async () => {
  const chrome = fakeChrome();
  const g = G.create(chrome);
  const seen = [];
  const handler = (id, button) => seen.push([id, button]);
  assert.equal(g.onNoticeClicked(handler), false);
  assert.equal(g.onNoticeClicked(handler), false, "the same handler twice is one handler");
  assert.equal(chrome.permissions.onAdded.listeners.length, 1, "one watcher however often it is called");
  // The user grants notifications: Chrome then exposes the API.
  const n = fakeChrome({ notifications: true }).notifications;
  chrome.notifications = n;
  chrome.permissions.onAdded.fire({ permissions: ["notifications"], origins: [] });
  assert.equal(n.onClicked.listeners.length, 1);
  assert.equal(n.onButtonClicked.listeners.length, 1);
  n.onClicked.fire("agent-wait:7");
  n.onButtonClicked.fire("agent-wait:7", 0);
  assert.deepEqual(seen, [["agent-wait:7", null], ["agent-wait:7", 0]]);
});

test("with notifications granted, notify and clear pass through and listeners attach at once", async () => {
  const chrome = fakeChrome({ notifications: true, granted: ["notifications"] });
  const g = G.create(chrome);
  assert.equal(await g.hasNotifications(), true);
  assert.equal(await g.notify("agent-wait:2", { title: "Waiting", message: "Sign in" }), "agent-wait:2");
  assert.deepEqual(chrome.calls.create[0], ["agent-wait:2", { type: "basic", iconUrl: "icon128.png", title: "Waiting", message: "Sign in" }]);
  assert.equal(await g.notify({ title: "Task done", message: "ok" }), "auto-1");
  assert.equal(chrome.calls.create[1].length, 1, "no id means Chrome picks one");
  assert.equal(await g.clearNotice("agent-wait:2"), true);
  assert.equal(g.onNoticeClicked(() => {}), true);
  g.onNoticeClicked(() => {});
  assert.equal(chrome.notifications.onClicked.listeners.length, 1, "Chrome sees one listener for any number of handlers");
});

test("requestHost asks for exactly the origin in hand", async () => {
  const chrome = fakeChrome();
  const g = G.create(chrome);
  assert.equal(await g.requestHost("https://api.openai.com/v1/chat/completions?x=1"), true);
  assert.deepEqual(chrome.calls.request[0], { origins: ["https://api.openai.com/*"] });
  await g.requestHost("http://localhost:11434");
  assert.deepEqual(chrome.calls.request[1], { origins: ["http://localhost:11434/*"] }, "the port is part of the origin");
  await g.requestHost("https://claude.ai/*");
  assert.deepEqual(chrome.calls.request[2], { origins: ["https://claude.ai/*"] });
  await g.requestHost(["https://openrouter.ai/api", "https://openrouter.ai/x"]);
  assert.deepEqual(chrome.calls.request[3], { origins: ["https://openrouter.ai/*"] });
  assert.equal(await g.hasHost("https://api.openai.com/anything"), true);
  assert.equal(await g.hasHost("https://api.anthropic.com"), false);
});

test("requestHost never widens a request: wildcards and other schemes ask nothing", async () => {
  const chrome = fakeChrome();
  const g = G.create(chrome);
  for (const bad of ["https://*/*", "<all_urls>", "*://claude.ai/*", "https://*.openai.com/*", "file:///etc/passwd", "chrome://settings", "", null, "not a url", ["https://claude.ai", "https://*/*"]]) {
    assert.equal(await g.requestHost(bad), false, String(bad));
  }
  assert.equal(chrome.calls.request.length, 0);
});

test("requestHost calls Chrome in the same tick, so the click's user gesture still counts", () => {
  const chrome = fakeChrome();
  const g = G.create(chrome);
  g.requestHost("https://claude.ai");
  assert.equal(chrome.calls.request.length, 1, "the request went out before any await");
  g.requestNotifications();
  assert.deepEqual(chrome.calls.request[1], { permissions: ["notifications"] });
});

test("registerAssistantScripts is idempotent and follows the grants", async () => {
  const chrome = fakeChrome();
  const g = G.create(chrome);
  assert.deepEqual(await g.registerAssistantScripts(), []);
  assert.equal(chrome.calls.register.length, 0, "nothing granted, nothing registered");

  chrome.grants.add("https://claude.ai/*");
  assert.deepEqual(await g.registerAssistantScripts(), ["https://claude.ai/*"]);
  assert.deepEqual(await g.registerAssistantScripts(), ["https://claude.ai/*"]);
  // Called again and again at the same time, as worker start and a grant can.
  await Promise.all([g.registerAssistantScripts(), g.registerAssistantScripts(), g.registerAssistantScripts()]);
  assert.equal(chrome.calls.register.length, 1, "registered once, then updated in place");
  assert.equal(chrome.registered.size, 1);
  const script = chrome.registered.get(G.ASSISTANT_SCRIPT_ID);
  assert.deepEqual(script.js, ["config.js", "contentScript.js"]);
  assert.equal(script.allFrames, true);
  assert.equal(script.persistAcrossSessions, true);

  chrome.grants.add("https://perplexity.ai/*");
  assert.deepEqual(await g.registerAssistantScripts(), ["https://claude.ai/*", "https://perplexity.ai/*"]);
  assert.deepEqual(chrome.registered.get(G.ASSISTANT_SCRIPT_ID).matches, ["https://claude.ai/*", "https://perplexity.ai/*"]);

  chrome.grants.clear();
  assert.deepEqual(await g.registerAssistantScripts(), []);
  assert.equal(chrome.registered.size, 0, "a removed grant takes the script away");
  assert.equal(chrome.calls.unregister.length, 1);
});

test("the assistant script files exist and match the static content script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../extension/manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].js, ["config.js", "contentScript.js"]);
  for (const f of ["config.js", "contentScript.js"]) assert.ok(fs.existsSync(path.join(__dirname, "../../extension", f)), f);
  for (const host of Object.values(G.ASSISTANT_HOSTS)) {
    assert.ok(!manifest.host_permissions.includes(host), `${host} stays optional`);
    assert.ok(!manifest.content_scripts[0].matches.includes(host), `${host} is not a static match`);
  }
});

test("faviconFor uses the tab's own icon or a generic one, never _favicon", () => {
  const g = G.create(fakeChrome());
  assert.equal(g.faviconFor({ url: "https://a.example/x", favIconUrl: "https://a.example/favicon.ico" }), "https://a.example/favicon.ico");
  assert.equal(g.faviconFor({ url: "https://a.example/x", favIconUrl: "data:image/png;base64,AAAA" }), "data:image/png;base64,AAAA");
  assert.equal(g.faviconFor({ url: "chrome://newtab", favIconUrl: "chrome://theme/IDR_X" }), G.GENERIC_ICON);
  assert.equal(g.faviconFor({ url: "https://a.example/" }), G.GENERIC_ICON);
  const tabs = [{ url: "https://b.example/p", favIconUrl: "https://b.example/i.png" }];
  assert.equal(g.faviconFor("https://b.example/other", tabs), "https://b.example/i.png");
  assert.equal(g.faviconFor("https://c.example/", tabs), G.GENERIC_ICON);
  assert.equal(g.faviconFor(null), G.GENERIC_ICON);
  assert.match(G.GENERIC_ICON, /^data:image\/svg\+xml,/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../../extension/core/grants.js"), "utf8"), /_favicon/);
});

test("the worker loads grants.js before engine.js and the engine never touches notifications unguarded at load", () => {
  const bg = fs.readFileSync(path.join(__dirname, "../../extension/background.js"), "utf8");
  const at = bg.indexOf("'core/grants.js'");
  assert.ok(at > 0 && at < bg.indexOf("'engine.js'"), "core/grants.js is imported before engine.js");
  const engine = fs.readFileSync(path.join(__dirname, "../../extension/engine.js"), "utf8");
  const listener = engine.indexOf("chrome.notifications.onClicked.addListener");
  if (listener > 0) assert.match(engine.slice(Math.max(0, listener - 300), listener), /if \(chrome\.notifications\)/);
});
