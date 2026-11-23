/**
 * Select to AI - recipes in the real extension, end to end.
 *
 *   node tests/e2e/recipes-extension.js
 *
 * Chromium (Playwright's) loads the unpacked extension in a persistent
 * profile. A local fixture page has a note box and a "Save draft" button
 * that posts a form. The agent, driven by a scripted model gateway, types a
 * note and saves it; the run is saved as a recipe from the agent page
 * ("Save as recipe"). Then the recipe is run from the Recipes panel three
 * times, against three versions of the page:
 *
 *   unchanged  proved, with no model call
 *   cosmetic   new ids, classes and wrappers, and a cookie banner over the
 *              page: the "Save draft" press is covered, the step is repaired
 *              by one inserted step (dismissing the banner) and proved
 *   meaning    the same button, but the words around it now say saving
 *              publishes the note to every customer: the run stops before
 *              the press, and the server never receives the form
 *
 * Last, "Save as recipe" itself: a run that filled the note from the user's
 * saved details shows why it cannot be saved, and a finished run can still
 * be saved after the worker's memory is gone.
 *
 * Repair and meaning checks use the extension's configured provider. With
 * ANTHROPIC_API_KEY in ~/.config/select-to-ai/keys.env that is Anthropic,
 * whose lite model is claude-haiku-5-5; without it, the scripted gateway
 * answers them. The key is read from the file and never printed.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");

// The local test server is granted, as after Allow on the site-access card.
const EXT = require("../helpers/granted-build.js").grantedBuild(path.resolve(__dirname, "../../extension"));
const KEYS = path.join(os.homedir(), ".config/select-to-ai/keys.env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function anthropicKey() {
  if (process.env.RECIPES_E2E_SCRIPTED) return "";
  try {
    const m = /^(?:export\s+)?ANTHROPIC_API_KEY=["']?([^"'\s]+)/m.exec(fs.readFileSync(KEYS, "utf8"));
    return m ? m[1] : "";
  } catch (_) { return ""; }
}

/* ----------------------------------------------------------- fixture site */

function notePage(mode) {
  const c = mode === "cosmetic";
  const meaning = mode === "meaning";
  const wrap = (h) => (c ? `<div class="x9f"><div class="row-k2">${h}</div></div>` : h);
  const banner = c ? `<div id="cmp-7" role="dialog" aria-label="Cookies" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10;display:flex;align-items:flex-end">
<div style="background:#fff;padding:20px;width:100%"><p>We use cookies to improve this site.</p>
<button type="button" onclick="document.getElementById('cmp-7').remove()">Reject all</button>
<button type="button" onclick="document.getElementById('cmp-7').remove()">Accept all</button></div></div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team notes</title>
<style>body{font-family:sans-serif;margin:24px} textarea{display:block;width:320px;height:60px;margin:6px 0 12px}</style></head>
<body><main><h1>Team notes</h1>
<section aria-label="${meaning ? "Publish" : "Draft"}" class="${c ? "s-4d1" : "draft"}"><h2>${meaning ? "Publish to customers" : "New draft"}</h2>
<p>${meaning ? "Saving publishes this note to every customer on your mailing list." : "Drafts stay private until you share them."}</p>
<form method="post" action="/save">
${wrap(`<label for="${c ? "f-31" : "note"}">Note</label><textarea id="${c ? "f-31" : "note"}" name="note"></textarea>`)}
${wrap(`<button type="submit" id="${c ? "b-88" : "save"}" class="${c ? "q1" : "primary"}"${mode === "meaning-commit" ? ' title="Publishes this note to every customer on your mailing list"' : ""}>Save draft</button>`)}
</form></section></main>${banner}</body></html>`;
}

/* ------------------------------------------------------ scripted gateway */

function sse(name, args) {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
  ];
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

function elementsOf(text) {
  const at = Math.max(text.lastIndexOf("Interactive elements ("), text.lastIndexOf("\nControls:\n"));
  const list = at >= 0 ? text.slice(at) : text;
  return [...list.matchAll(/^[ \t]*\*?\[(\d+)\] (\w+)(?:\([\w-]+\))?(?: "([^"]*)")?(.*)$/gm)].map((m) => ({ id: Number(m[1]), tag: m[2], name: m[3] || "", rest: m[4] }));
}

function startServer() {
  const state = { mode: "base", fromDetails: false, saves: [], calls: { step: 0, verdict: 0, answer: 0, other: [] } };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const body = () => new Promise((r) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => r(b)); });
    const send = (code, text, type = "text/html") => { res.writeHead(code, { "content-type": type }); res.end(text); };
    if (u.pathname === "/note") return send(200, notePage(state.mode));
    if (u.pathname === "/save" && req.method === "POST") {
      return void body().then((b) => {
        const note = new URLSearchParams(b).get("note") || "";
        state.saves.push({ mode: state.mode, note });
        res.writeHead(303, { location: `/saved?n=${encodeURIComponent(note)}` });
        res.end();
      });
    }
    if (u.pathname === "/saved") return send(200, `<!doctype html><html><head><title>Saved</title></head><body><h1>Draft saved</h1><p role="status">Draft saved: ${String(u.searchParams.get("n") || "").replace(/[<>&"]/g, "")}</p></body></html>`);
    if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
      return void body().then((raw) => {
        const b = JSON.parse(raw);
        const tool = b.tools && b.tools[0] && b.tools[0].function ? b.tools[0].function.name : "";
        const text = (b.messages || []).map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("\n"))).join("\n\n");
        const user = (b.messages || []).slice(1).map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("\n"))).join("\n");
        let args;
        if (tool === "step") {
          state.calls.step++;
          const url = (user.match(/^Current page: .* \| (\S+)$/m) || [])[1] || "";
          const els = elementsOf(user);
          if (/\/saved/.test(url)) args = { memory: "", goal: "Answer", actions: [{ do: "done", success: true, answer: "I saved the draft note.", evidence: ["Draft saved"] }] };
          else {
            const box = els.find((e) => /note/i.test(e.name) && /text/i.test(e.tag));
            const save = els.find((e) => /save draft/i.test(e.name));
            if (!box || !save) throw new Error(`fixture controls not listed:\n${user.slice(0, 2000)}`);
            // With state.fromDetails the note is filled from the user's saved details, which a recipe does not keep.
            const fill = state.fromDetails ? { do: "fill", ref: box.id, from: "profile.email" } : { do: "fill", ref: box.id, value: "Ship it Friday" };
            args = { memory: "", goal: "Save the note as a draft", actions: [fill, { do: "click", ref: save.id }] };
          }
        } else if (tool === "verdict") {
          state.calls.verdict++;
          args = { requirements: [{ need: "the draft is saved", met: true }], pass: true, reason: "The page says the draft was saved." };
        } else if (tool === "answer") {
          // Repair, the second check of a repair and the meaning check, when no real model is configured.
          state.calls.answer++;
          if (/^You repair one step/m.test(text)) {
            const line = user.split("\n").find((l) => /^\[f\d+e\d+\]/.test(l) && /Reject all/.test(l));
            args = { patch: line ? "insert" : "cannot", ref: line ? /^\[(f\d+e\d+)\]/.exec(line)[1] : "", insert_action: line ? "click" : "none", insert_key: "", insert_value: "", predicted: "the cookie banner closes", confidence: "high", why: "A cookie banner covers the page." };
          } else if (/^You check whether one step/m.test(text)) {
            args = /customer/i.test(user) ? { same: "different", why: "Saving now publishes the note to customers." } : { same: "same", why: "Only the wording changed." };
          } else args = { same: "same", why: "The same control." };
        } else if (tool === "press_check") {
          // The page-blind press check, answered by the test's stand-in judge.
          state.calls.other.push(tool);
          args = require("../helpers/fake-judge.js").answer({ user });
        } else {
          state.calls.other.push(tool || "(none)");
          args = tool === "learned" ? { site_notes: [], lesson: "", about_user: [], drop: [] } : tool === "context" ? { items: [] } : {};
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(tool || "answer", args));
      }).catch((e) => { console.log(`[gateway] ${e.message}`); send(500, JSON.stringify({ error: { message: e.message } }), "application/json"); });
    }
    if (u.pathname === "/favicon.ico") return send(404, "");
    send(404, "not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

/* -------------------------------------------------------------------- run */

async function main() {
  const { chromium } = require("playwright");
  const { server, state, base } = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recipes-e2e-"));
  const key = anthropicKey();
  let context = null;
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push([name, null]); console.log(`ok   ${name}`); } catch (e) { results.push([name, e]); console.log(`FAIL ${name}\n     ${String(e.message).split("\n").slice(0, 8).join("\n     ")}`); }
  };
  let spent = 0;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: !process.env.E2E_HEADFUL,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
      viewport: { width: 1280, height: 860 },
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const set = (area, items) => worker.evaluate(([a, i]) => chrome.storage[a].set(i), [area, items]);
    await set("sync", { agentActiveProvider: "custom", agentCustomUrl: `${base}/v1`, agentModel: "e2e-scripted-model", showAgent: true, agentRiskConfirmation: false, agentDomainAllowlist: "", openingMode: "tab", agentLearning: false });
    // The user already agreed to what the agent sends (setup.js consent).
    await set("local", { onboardingComplete: true, agentDataConsent: { [`custom ${new URL(base).origin}`]: Date.now(), anthropic: Date.now() } });

    // 1. The agent saves a note; the run is saved as a recipe.
    const fixture = context.pages()[0] || (await context.newPage());
    await fixture.goto(`${base}/note`);
    const tabId = await worker.evaluate(async (href) => { const t = (await chrome.tabs.query({})).find((x) => x.url === href); return t ? t.id : null; }, fixture.url());
    const agent = await context.newPage();
    agent.on("pageerror", (e) => console.log(`  [agent pageerror] ${e.message}`));
    const task = "Save a draft note on this page that says Ship it Friday";
    await agent.goto(`chrome-extension://${extensionId}/agent.html?task=${encodeURIComponent(task)}&autostart=1&fresh=1&tabId=${tabId}`);

    await check("the agent's run succeeds and offers Save as recipe", async () => {
      await agent.waitForSelector(".recipe-save-btn", { timeout: 60000 }).catch(async (e) => {
        const seen = await worker.evaluate(() => [...self.SELECT_TO_AI_RECIPES._recordings.values()].map((r) => ({ broken: r.broken, steps: r.steps, ended: r.ended })));
        throw new Error(`${e.message.split("\n")[0]}\nrecordings: ${JSON.stringify(seen)}\npanel: ${(await agent.evaluate(() => document.body.innerText)).slice(-600)}`);
      });
      assert.equal(state.saves.length, 1);
      assert.equal(state.saves[0].note, "Ship it Friday");
    });
    await check("the run is saved as a recipe from its answer", async () => {
      await agent.click(".recipe-save-btn");
      await agent.waitForFunction(() => /Saved as a recipe/.test(document.querySelector(".recipe-save")?.textContent || ""), null, { timeout: 10000 });
      const store = await worker.evaluate(() => chrome.storage.local.get("recipesStore"));
      const recipe = store.recipesStore.recipes[0].recipe;
      assert.deepEqual(recipe.steps.map((s) => `${s.action.do}:${s.class}`), ["navigate:read", "fill:edit", "click:commit"]);
      assert.deepEqual(recipe.variables.map((v) => [v.name, v.example]), [["note", "Ship it Friday"]]);
      assert.ok(!JSON.stringify(recipe).includes("sk-ant"), "no key in the recipe");
    });

    // The model for repair: the user's configured provider.
    if (key) await set("sync", { agentActiveProvider: "anthropic", agentModel: "claude-sonnet-5-5" }), await set("local", { agentAnthropicKey: key });
    console.log(`     repair model: ${key ? "Anthropic (lite tier: claude-haiku-5-5)" : "scripted gateway"}`);

    async function runFromPanel(mode, note) {
      state.mode = mode;
      await agent.click("#openRecipesBtn").catch(async () => {
        // The drawer may be closed in a narrow window.
        await agent.click("#sidebarToggleBtn");
        await agent.click("#openRecipesBtn");
      });
      await agent.waitForSelector("#recipesModal:not([hidden]) .recipe-open");
      await agent.click(".recipe-open");
      await agent.fill(".recipe-run-form input[name=note]", note);
      await agent.click(".recipe-run-form button[type=submit]");
      await agent.waitForSelector(".recipe-run-out .recipe-receipt, .recipe-run-out .recipe-receipt-why", { timeout: 120000 });
      const out = await agent.evaluate(() => {
        const box = document.querySelector(".recipe-run-out");
        return { head: box.querySelector(".recipe-receipt-head strong")?.textContent || "", why: box.querySelector(".recipe-receipt-why")?.textContent || "", cost: box.querySelector(".recipe-receipt-cost")?.textContent || "", text: box.innerText };
      });
      const store = await worker.evaluate(() => chrome.storage.local.get("recipesStore"));
      const receipt = store.recipesStore.recipes[0].receipts[0];
      spent += (receipt && receipt.cost.usd) || 0;
      // A picture of the panel with the receipt, when asked for (RECIPES_E2E_SHOT=dir).
      if (process.env.RECIPES_E2E_SHOT) await agent.screenshot({ path: path.join(process.env.RECIPES_E2E_SHOT, `recipes-${mode}.png`) });
      await agent.click("#recipesClose");
      // The run's tab is closed; the agent page stays.
      for (const p of context.pages()) if (p !== agent && p !== fixture) await p.close().catch(() => {});
      return { out, receipt };
    }

    await check("unchanged page: proved with no model call", async () => {
      const before = state.saves.length;
      const { out, receipt } = await runFromPanel("base", "Q3 report is due");
      assert.equal(out.head, "Proved", out.text);
      assert.equal(receipt.end.state, "done_proven", receipt.end.why);
      assert.equal(receipt.cost.modelCalls, 0);
      assert.equal(state.saves.length, before + 1);
      assert.equal(state.saves[state.saves.length - 1].note, "Q3 report is due");
    });

    await check("cosmetic change (new ids and wrappers, a cookie banner over the button): repaired and proved", async () => {
      const before = state.saves.length;
      const { out, receipt } = await runFromPanel("cosmetic", "Ship the beta");
      assert.equal(receipt.end.state, "done_proven", `${receipt.end.why}\n${out.text}`);
      assert.equal(out.head, "Proved");
      assert.ok(receipt.cost.modelCalls >= 1, "the repair used the model");
      assert.ok(receipt.repairs.some((r) => r.status === "persisted"), JSON.stringify(receipt.repairs));
      assert.equal(state.saves.length, before + 1);
      assert.deepEqual(state.saves[state.saves.length - 1], { mode: "cosmetic", note: "Ship the beta" });
      console.log(`     repair: ${receipt.repairs.map((r) => `${r.status}: ${r.diffText}`).join("; ")} (${receipt.cost.modelCalls} calls, ${receipt.cost.models.join(",")})`);
    });

    await check("meaning change (saving now publishes to customers): stops before the press, nothing is sent", async () => {
      const before = state.saves.length;
      const { out, receipt } = await runFromPanel("meaning", "Internal only");
      assert.equal(receipt.end.state, "needs_you", `${receipt.end.why}\n${out.text}`);
      assert.equal(out.head, "Stopped: needs you");
      assert.equal(state.saves.length, before, "the form was never sent");
      assert.ok(!receipt.steps.some((s) => s.class === "commit" && s.status === "ok"), "the commit step did not run");
      console.log(`     why: ${receipt.end.why}`);
    });
    await check("meaning change on the button alone (its tooltip says it publishes): the note is typed, the press is not made", async () => {
      const before = state.saves.length;
      const { out, receipt } = await runFromPanel("meaning-commit", "Internal only");
      assert.equal(receipt.end.state, "needs_you", `${receipt.end.why}\n${out.text}`);
      const commit = receipt.steps.find((s) => s.class === "commit");
      assert.ok(receipt.steps.some((s) => s.action === "fill" && s.status === "ok") || receipt.steps.some((s) => /put/.test(s.intent) && s.status === "ok"), JSON.stringify(receipt.steps));
      assert.ok(!commit || commit.status !== "ok", "the commit step did not run");
      assert.match(receipt.end.why, /Save draft/);
      assert.equal(state.saves.length, before, "the form was never sent");
      console.log(`     why: ${receipt.end.why}`);
    });

    // 3. "Save as recipe" does not go missing: a run that cannot be saved
    // says why, and a run that can is still saveable after the worker
    // restarted. Both on the scripted gateway, as in step 1.
    await set("sync", { agentActiveProvider: "custom", agentModel: "e2e-scripted-model" });
    await agent.close();
    const panelText = (page) => page.evaluate(() => document.body.innerText.slice(-600)).catch(() => "");
    /** A new agent page that runs `task` on the fixture's note page, from a fresh conversation. */
    async function runOnNote(task) {
      state.mode = "base";
      await fixture.goto(`${base}/note`);
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log(`  [agent pageerror] ${e.message}`));
      await page.goto(`chrome-extension://${extensionId}/agent.html?task=${encodeURIComponent(task)}&autostart=1&fresh=1&tabId=${tabId}`);
      return page;
    }

    await check("a run that filled in the user's saved details says why it cannot be saved", async () => {
      // An email on file, and the user's standing yes to filling forms on this site.
      await worker.evaluate(async (site) => {
        await self.SELECT_TO_AI_ENGINE.changeMemory({ op: "field", key: "email", value: "ada@example.com", source: "you_said" });
        await self.SELECT_TO_AI_ENGINE.changeMemory({ op: "consent", site, value: true });
      }, new URL(base).hostname);
      state.fromDetails = true;
      const before = state.saves.length;
      const page = await runOnNote("Save a draft note on this page with my email address in it");
      try {
        await page.waitForSelector(".recipe-save-why", { timeout: 60000 }).catch(async (e) => { throw new Error(`${e.message.split("\n")[0]}\npanel: ${await panelText(page)}`); });
        const said = await page.evaluate(() => document.querySelector(".recipe-save").textContent);
        assert.match(said, /^This run cannot be saved as a recipe: it filled in your saved details, which a recipe does not keep\.$/);
        assert.equal(await page.locator(".recipe-save-btn").count(), 0, "no Save button is offered");
        assert.equal(state.saves.length, before + 1, "the run itself went through");
        assert.equal(state.saves[state.saves.length - 1].note, "ada@example.com");
        console.log(`     shown: ${said}`);
      } finally {
        state.fromDetails = false;
        await page.close().catch(() => {});
      }
    });

    await check("a finished run is still saveable after the worker restarted", async () => {
      const recipesBefore = (await worker.evaluate(() => chrome.storage.local.get("recipesStore"))).recipesStore.recipes.length;
      const first = await runOnNote("Save a draft note on this page that says Ship it Friday");
      await first.waitForSelector(".recipe-save-btn", { timeout: 60000 }).catch(async (e) => { throw new Error(`${e.message.split("\n")[0]}\npanel: ${await panelText(first)}`); });
      await first.close();
      // A worker that Chrome stopped and started again has nothing in its
      // memory, only what it kept in storage. Played from inside, as in
      // run-v4.js: stopping the real worker under automation leaves it stopped.
      const lost = await worker.evaluate(() => { const r = self.SELECT_TO_AI_RECIPES._recordings; const n = r.size; r.clear(); return n; });
      assert.ok(lost >= 1, "there was a recording in the worker's memory to lose");
      // The user comes back to the conversation and saves it.
      const again = await context.newPage();
      again.on("pageerror", (e) => console.log(`  [agent pageerror] ${e.message}`));
      await again.goto(`chrome-extension://${extensionId}/agent.html`);
      try {
        await again.waitForSelector(".recipe-save-btn", { timeout: 30000 }).catch(async (e) => { throw new Error(`${e.message.split("\n")[0]}\npanel: ${await panelText(again)}`); });
        await again.click(".recipe-save-btn");
        await again.waitForFunction(() => /Saved as a recipe/.test(document.querySelector(".recipe-save")?.textContent || ""), null, { timeout: 10000 });
        const recipes = (await worker.evaluate(() => chrome.storage.local.get("recipesStore"))).recipesStore.recipes;
        assert.equal(recipes.length, recipesBefore + 1);
        assert.deepEqual(recipes[0].recipe.steps.map((s) => `${s.action.do}:${s.class}`), ["navigate:read", "fill:edit", "click:commit"]);
      } finally {
        await again.close().catch(() => {});
      }
    });
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`model spend on replays: $${spent.toFixed(4)}; gateway calls: ${JSON.stringify(state.calls)}`);
  const failed = results.filter(([, e]) => e);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
