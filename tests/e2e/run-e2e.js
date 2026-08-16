/**
 * Select to AI - end-to-end task harness (npm run bench:e2e).
 *
 * Launches Chromium with the unpacked extension, points the agent at the
 * local scripted gateway (tests/e2e/server.js), and runs four scenarios
 * through the REAL pipeline, router, planner, executor tool calls, schema
 * validation, DOM actions in a live tab, outcome deltas, validator, memory:
 *
 *   search   - a form search ends with the expected grounded answer
 *   form     - every field is filled with replace-not-append semantics
 *   login    - a login wall ends in ask_user (never credential guessing)
 *   compare  - remember-notes carry data across pages; validation passes
 *
 * Deliberately NOT part of `npm run check` (CI time): run locally with
 * `npm run bench:e2e`, or via the manual GitHub workflow (e2e.yml).
 */
"use strict";

const path = require("node:path");
const { createE2EServer } = require("./server.js");

const PORT = parseInt(process.env.E2E_PORT || "8907", 10);
const EXTENSION_PATH = path.resolve(__dirname, "../../extension");
const SCENARIO_TIMEOUT_MS = 90000;

const results = [];

function recordResult(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
}

async function waitFor(fn, timeoutMs, intervalMs = 400, label = "condition") {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Reads the last VISIBLE final-answer box on the agent page (or ""). */
async function readFinalAnswer(agentPage) {
  return agentPage.evaluate(() => {
    const boxes = [...document.querySelectorAll(".final-answer-box")];
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i];
      const visible = window.getComputedStyle(box).display !== "none";
      const text = (box.innerText || "").trim();
      if (visible && text && text !== "Thinking...") return text;
    }
    return "";
  });
}

async function readRunLog(agentPage) {
  return agentPage.evaluate(() =>
    [...document.querySelectorAll(".log-item")].map((item) => item.innerText).join("\n"),
  );
}

async function controlRequest(baseUrl, pathName, options) {
  const response = await fetch(`${baseUrl}${pathName}`, options);
  return response.json();
}

async function main() {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (err) {
    console.error("puppeteer is not installed. Run: npm install");
    process.exit(1);
  }

  const server = createE2EServer(PORT);
  await server.listen();
  console.log(`Fixture + scripted gateway server: ${server.baseUrl}`);

  const browser = await puppeteer.launch({
    headless: process.env.E2E_HEADFUL ? false : true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--disable-features=DialMediaRouteProvider",
    ],
  });

  let exitCode = 0;
  try {
    // Locate the extension's service worker to learn its id.
    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === "service_worker" && target.url().includes("background.js"),
      { timeout: 20000 },
    );
    const extensionId = new URL(workerTarget.url()).host;
    const worker = await workerTarget.worker();
    console.log(`Extension loaded: ${extensionId}`);

    // Seed configuration through the extension's own storage APIs: custom
    // gateway on loopback, agent enabled, onboarding done. This is exactly
    // what the options page would have written.
    await worker.evaluate(
      (settings) => new Promise((resolve) => chrome.storage.sync.set(settings, resolve)),
      {
        agentActiveProvider: "custom",
        agentCustomUrl: `${server.baseUrl}/v1`,
        agentModel: "e2e-scripted-model",
        showAgent: true,
        agentRiskConfirmation: true,
        agentDomainAllowlist: "",
        openingMode: "tab",
        theme: "dark",
      },
    );
    await worker.evaluate(
      () => new Promise((resolve) => chrome.storage.local.set({ onboardingComplete: true }, resolve)),
    );

    const scenarioRuns = [
      {
        name: "search",
        startPath: "/search",
        async assert({ answer, log }) {
          if (!answer.includes("$19")) {
            return `final answer missing "$19": ${JSON.stringify(answer)}`;
          }
          if (!/Validation Passed/i.test(log)) return "validator pass entry missing";
          return null;
        },
      },
      {
        name: "form",
        startPath: "/signup",
        async assert({ answer, fixturePage }) {
          const expected = {
            name: "Ada Lovelace",
            email: "ada@example.com",
            company: "Analytical Engines Ltd",
            phone: "555-0100",
          };
          const values = await fixturePage.evaluate(() => ({
            name: document.getElementById("name").value,
            email: document.getElementById("email").value,
            company: document.getElementById("company").value,
            phone: document.getElementById("phone").value,
            confirmation: document.getElementById("signup-confirmation").textContent,
          }));
          for (const [key, want] of Object.entries(expected)) {
            // Exact equality proves replace-not-append: any appended "OLD
            // DATA" residue fails here.
            if (values[key] !== want) {
              return `field ${key} = ${JSON.stringify(values[key])}, wanted ${JSON.stringify(want)}`;
            }
          }
          if (!values.confirmation.includes("Thanks for signing up, Ada Lovelace")) {
            return `confirmation missing: ${JSON.stringify(values.confirmation)}`;
          }
          if (!answer.includes("Ada Lovelace")) return "final answer does not mention the signup";
          return null;
        },
      },
      {
        name: "login",
        startPath: "/account",
        async assert({ answer, fixturePage, actions }) {
          if (!answer.includes("I need your input to continue")) {
            return `run did not end in ask_user: ${JSON.stringify(answer)}`;
          }
          const typedActions = actions.filter((a) => a.action === "type");
          if (typedActions.length > 0) {
            return `agent typed on the login page: ${JSON.stringify(typedActions)}`;
          }
          const fields = await fixturePage.evaluate(() => ({
            username: document.getElementById("username").value,
            password: document.getElementById("password").value,
          }));
          if (fields.username !== "" || fields.password !== "") {
            return `credential fields were touched: ${JSON.stringify(fields)}`;
          }
          return null;
        },
      },
      {
        name: "compare",
        startPath: "/home",
        async assert({ answer, log }) {
          if (!answer.includes("$18") || !/item b/i.test(answer)) {
            return `final answer wrong: ${JSON.stringify(answer)}`;
          }
          const noteSaves = (log.match(/Note Saved/g) || []).length;
          if (noteSaves < 2) return `expected 2 remember notes, saw ${noteSaves}`;
          if (!/Validation Passed/i.test(log)) return "validator pass entry missing";
          return null;
        },
      },
    ];

    for (const run of scenarioRuns) {
      console.log(`\nScenario: ${run.name}`);
      const control = await controlRequest(server.baseUrl, "/control/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: run.name }),
      });

      // One non-extension tab = the agent's target tab.
      const pages = await browser.pages();
      const fixturePage = pages[0] || (await browser.newPage());
      await fixturePage.goto(`${server.baseUrl}${run.startPath}`, { waitUntil: "load" });

      // Open the agent panel with the task handed over (omnibox-style) and
      // autostart. The scripted gateway drives every model decision.
      const agentPage = await browser.newPage();
      agentPage.on("pageerror", (err) => console.log(`  [agent pageerror] ${err.message}`));
      const agentUrl =
        `chrome-extension://${extensionId}/agent.html` +
        `?task=${encodeURIComponent(control.task)}&autostart=1`;
      await agentPage.goto(agentUrl, { waitUntil: "load" });

      let detail = null;
      try {
        const answer = await waitFor(
          () => readFinalAnswer(agentPage),
          SCENARIO_TIMEOUT_MS,
          500,
          `${run.name} final answer`,
        );
        const log = await readRunLog(agentPage);
        const { actions } = await controlRequest(server.baseUrl, "/control/log", { method: "GET" });
        detail = await run.assert({ answer, log, fixturePage, actions });
        if (detail) {
          console.log(`  [answer] ${answer}`);
        }
      } catch (err) {
        detail = err.message;
        try {
          console.log("  [log dump]\n" + (await readRunLog(agentPage)));
        } catch (_) { /* page may be gone */ }
      }

      recordResult(run.name, detail === null, detail || "");
      await agentPage.close();
      await fixturePage.goto("about:blank");
    }
  } catch (err) {
    exitCode = 1;
    console.error(`Harness error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }

  // Scenario/pass table
  console.log("\n===== E2E scenario results =====");
  console.log("| scenario | result |");
  console.log("| -------- | ------ |");
  for (const result of results) {
    console.log(`| ${result.name.padEnd(8)} | ${result.pass ? "PASS" : "FAIL"}   |`);
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0 || results.length === 0) exitCode = 1;
  console.log(
    failed.length === 0 && results.length > 0
      ? "\nAll scenarios passed."
      : `\n${failed.length} scenario(s) failed.`,
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
