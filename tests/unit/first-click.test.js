"use strict";
// The first setup click asks Chrome for what that click needs (plan item 22).
//
// It used to ask for every website plus notifications in one prompt. Now a
// first task asks for the one site it works on, "Open the agent" asks for
// nothing, every other site is asked for by the agent's own card when it
// gets there, and notifications by the switch in Settings that needs them.
// The welcome page is run for real, through sign-in to the first-task list.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("../helpers/page-harness.js");

globalThis.SELECT_TO_AI_DEFAULTS = require("../../extension/defaults.js");
const S = require("../../extension/setup.js");

const OPENROUTER = "https://openrouter.ai/*";

/** The welcome page after "Continue with OpenRouter" went through, on its first-task list. */
async function connectedWelcome(extra = {}) {
  const consent = { [S.CONSENT_KEY]: { [S.consentId("openrouter")]: 1 } };
  const page = loadPage({
    html: "welcome.html",
    local: consent,
    globals: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ key: "sk-or-v1-made-up-for-the-test" }) }) },
    ...extra,
  });
  await settle(6);
  page.$("connectOR").click();
  // Signing in hashes a value off the main thread, which takes its own time: waited for, within two seconds.
  // Then the free or paid choice, and Save and continue.
  for (const until = Date.now() + 2000; page.visible("modelStep") === false && Date.now() < until;) await settle(10);
  assert.equal(page.visible("modelStep"), true, "the free or paid choice is shown once signed in");
  page.$("saveSetup").click();
  for (const until = Date.now() + 2000; !page.visible("done") && Date.now() < until;) await settle(10);
  await settle(40);
  assert.deepEqual(page.errors, []);
  assert.equal(page.visible("done"), true, "the page reached its first-task list");
  // Connecting asked for the provider's own host, which that click needs.
  assert.deepEqual(page.calls.request, [{ origins: [OPENROUTER] }]);
  page.calls.request.length = 0;
  return page;
}

test("siteAccess names one site and its subdomains, never every site", () => {
  assert.deepEqual(S.siteAccess("news.ycombinator.com"), ["https://*.news.ycombinator.com/*"]);
  assert.deepEqual(S.siteAccess(" Wikipedia.org "), ["https://*.wikipedia.org/*"]);
  for (const bad of ["", null, "*", "*.com", "com", "https://*/*", "<all_urls>", "a b.com", "example.com/path", "http://example.com"]) {
    assert.equal(S.siteAccess(bad), null, String(bad));
  }
});

test("a first task asks Chrome for that task's site alone, then opens the agent", async () => {
  const page = await connectedWelcome();
  const tries = page.$("tries").children;
  assert.ok(tries.length >= 3, "the first tasks are listed");

  for (const button of tries) {
    page.calls.request.length = 0;
    page.calls.tabsCreate.length = 0;
    const task = button.firstChild.textContent;
    const site = button.lastChild.textContent;
    button.click();
    assert.equal(page.calls.request.length, 1, "one prompt, inside the click");
    const asked = page.calls.request[0];
    assert.deepEqual(asked, { origins: [`https://*.${site}/*`] }, task);
    assert.ok(!("permissions" in asked), "notifications are not asked for here");
    assert.ok(!asked.origins.some((o) => /^https?:\/\/\*\/\*$|all_urls/.test(o)), "and not every website");
    await settle(4);
    assert.equal(page.calls.tabsCreate.length, 1);
    assert.match(page.calls.tabsCreate[0].url, /agent\.html\?task=.+&autostart=1$/);
  }
});

test("a no to the site still opens the agent, which asks on its own card", async () => {
  const page = await connectedWelcome();
  // From here on Chrome's prompt is declined.
  page.chrome.permissions.request = (q, cb) => { page.calls.request.push(q); setImmediate(() => cb(false)); };
  page.$("tries").children[0].click();
  await settle(4);
  assert.equal(page.calls.tabsCreate.length, 1);
});

test("Open the agent, with no task, asks Chrome for nothing", async () => {
  const page = await connectedWelcome();
  page.$("openAgent").click();
  await settle(4);
  assert.deepEqual(page.calls.request, []);
  assert.equal(page.calls.tabsCreate.length, 1);
  assert.match(page.calls.tabsCreate[0].url, /agent\.html$/);
});

test("notifications are asked for by the Settings switch that needs them, and only there", async () => {
  const options = loadPage({ html: "options.html" });
  await settle(10);
  assert.deepEqual(options.errors, []);
  const sw = options.$("taskNotices");
  assert.equal(sw.checked, false, "off until Chrome holds the permission");

  sw.checked = true;
  sw.fire("change");
  assert.deepEqual(options.calls.request, [{ permissions: ["notifications"] }], "asked inside the click, alone");
  await settle(6);
  assert.equal(sw.checked, true);

  sw.checked = false;
  sw.fire("change");
  await settle(6);
  assert.deepEqual(options.calls.removed, [{ permissions: ["notifications"] }]);
  assert.equal(sw.checked, false);
});

test("the switch stays off when Chrome's prompt is declined, and shows a grant already held", async () => {
  const declined = loadPage({ html: "options.html", grantOnRequest: false });
  await settle(10);
  declined.$("taskNotices").checked = true;
  declined.$("taskNotices").fire("change");
  await settle(6);
  assert.equal(declined.$("taskNotices").checked, false);

  const held = loadPage({ html: "options.html", granted: ["notifications"] });
  await settle(10);
  assert.equal(held.$("taskNotices").checked, true);
});
