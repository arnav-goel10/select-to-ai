/**
 * Select to AI - E2E fixture + scripted-gateway server.
 *
 * One local HTTP server (127.0.0.1 only) that provides:
 *  1. An OpenAI-compatible scripted gateway (POST /v1/chat/completions)
 *     that replays canned tool-call responses per scenario. The extension's
 *     custom-gateway path already allows loopback origins, so the REAL
 *     request pipeline (background stream proxy, origin policy, tool-call
 *     accumulation, schema validation) is exercised end to end.
 *  2. Small fixture pages: a search page with a form + results, a
 *     multi-field signup form, a page behind a fake login wall, and a
 *     two-page price-comparison pair.
 *  3. A control API for the runner: POST /control/scenario selects the
 *     active scenario, GET /control/log returns every executor action the
 *     gateway issued for it (used to assert e.g. "no credentials typed").
 *
 * No dependencies. Node 20+.
 */
"use strict";

const http = require("node:http");

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

/**
 * Every fixture embeds a "live note" that mutates the DOM on input events.
 * Real applications mutate the DOM while the user types; without this,
 * typing into a bare <input> produces zero mutations and the agent's
 * outcome-delta detector would (correctly) flag the action as a no-op.
 */
const LIVE_NOTE = `
<div id="live-note" style="margin-top:16px;color:#666;font-size:13px"></div>
<script>
  document.addEventListener('input', (e) => {
    var n = document.getElementById('live-note');
    var who = e.target && (e.target.id || e.target.name) || 'field';
    n.textContent = 'Editing ' + who + ' (' + Date.now() + ')';
  });
</script>`;

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 32px; max-width: 640px; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  input { display: block; padding: 8px; margin-top: 4px; width: 320px; }
  button { margin-top: 16px; padding: 8px 18px; }
  .price { font-size: 20px; font-weight: 700; }
  li { margin-bottom: 6px; }
</style>
</head>
<body>
${body}
${LIVE_NOTE}
</body>
</html>`;
}

const FIXTURES = {
  "/home": pageShell(
    "Fixture Home",
    `<h1>Fixture Site</h1>
     <p>Pages used by the Select to AI end-to-end harness.</p>
     <ul>
       <li><a href="/search" id="nav-search">Product search</a></li>
       <li><a href="/signup" id="nav-signup">Signup form</a></li>
       <li><a href="/account" id="nav-account">Account (login required)</a></li>
       <li><a href="/item-a" id="nav-item-a">Item A</a></li>
       <li><a href="/item-b" id="nav-item-b">Item B</a></li>
     </ul>`,
  ),

  "/search": pageShell(
    "Product Search",
    `<h1>Product Search</h1>
     <form action="/results" method="get">
       <label for="q">Search the catalog</label>
       <input type="text" id="q" name="q" placeholder="Search products" />
       <button type="submit" id="search-btn">Search</button>
     </form>`,
  ),

  "/signup": pageShell(
    "Signup",
    `<h1>Create your account</h1>
     <form id="signup-form">
       <label for="name">Full name</label>
       <input type="text" id="name" name="name" aria-label="Full name" value="OLD DATA" />
       <label for="email">Email address</label>
       <input type="text" id="email" name="email" aria-label="Email address" value="OLD DATA" />
       <label for="company">Company</label>
       <input type="text" id="company" name="company" aria-label="Company" value="OLD DATA" />
       <label for="phone">Phone number</label>
       <input type="text" id="phone" name="phone" aria-label="Phone number" value="OLD DATA" />
       <button type="button" id="signup-btn">Sign up</button>
     </form>
     <div id="signup-confirmation" role="status"></div>
     <script>
       document.getElementById('signup-btn').addEventListener('click', function () {
         var name = document.getElementById('name').value;
         document.getElementById('signup-confirmation').textContent =
           'Thanks for signing up, ' + name + '!';
       });
     </script>`,
  ),

  "/account": pageShell(
    "Account",
    `<h1>Your account</h1>
     <p id="login-wall-message">Please log in to view your account balance.</p>
     <form id="login-form">
       <label for="username">Username</label>
       <input type="text" id="username" name="username" aria-label="Username" />
       <label for="password">Password</label>
       <input type="password" id="password" name="password" aria-label="Password" />
       <button type="button" id="login-btn">Log in</button>
     </form>`,
  ),

  "/item-a": pageShell(
    "Item A",
    `<h1>Gizmo Item A</h1>
     <p>A dependable gizmo for everyday use.</p>
     <p class="price" id="price-a">Price: $25</p>
     <p><a href="/item-b">Compare with Item B</a></p>`,
  ),

  "/item-b": pageShell(
    "Item B",
    `<h1>Gizmo Item B</h1>
     <p>The lighter gizmo with the same features.</p>
     <p class="price" id="price-b">Price: $18</p>
     <p><a href="/item-a">Compare with Item A</a></p>`,
  ),
};

function renderResults(query) {
  const q = String(query || "").toLowerCase();
  const items = [
    { name: "Red Widget", price: "$24" },
    { name: "Blue Widget", price: "$19" },
    { name: "Green Widget", price: "$31" },
  ].filter((item) => {
    if (!q) return true;
    return q.split(/\s+/).every((word) => item.name.toLowerCase().includes(word) || word === "widget");
  });
  const list = items.length
    ? `<ul>${items.map((i) => `<li>${i.name}, <strong>${i.price}</strong></li>`).join("")}</ul>`
    : "<p>No products matched.</p>";
  return pageShell(
    "Search Results",
    `<h1>Results for "${String(query || "").replace(/[<>&"]/g, "")}"</h1>${list}
     <p><a href="/search">New search</a></p>`,
  );
}

// ---------------------------------------------------------------------------
// Gateway request parsing helpers
// ---------------------------------------------------------------------------

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/** Parses the numbered element list out of the executor's dynamic context. */
function parseElements(systemText) {
  const elements = [];
  const lineRe = /^<(\w+) ([^>]*)>(.*)<\/\1>$/gm;
  let match;
  while ((match = lineRe.exec(systemText)) !== null) {
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(match[2])) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    if (!attrs.id) continue;
    elements.push({
      tag: match[1].toLowerCase(),
      id: parseInt(attrs.id, 10),
      attrs,
      text: match[3].trim(),
    });
  }
  return elements;
}

function currentUrlOf(systemText) {
  const match = systemText.match(/^Current Tab URL: (.+)$/m);
  return match ? match[1].trim() : "";
}

function findElement(elements, predicate) {
  return elements.find(predicate) || null;
}

// ---------------------------------------------------------------------------
// Scenario scripts (deterministic executor policies)
// ---------------------------------------------------------------------------

function buildScenarios(baseUrl) {
  const url = (p) => `${baseUrl}${p}`;

  return {
    search: {
      task: "Use the site search to find the price of the Blue Widget and tell me what it costs.",
      plan: [
        {
          task: "Open the product search page and search for 'blue widget'",
          postcondition: "Search results for blue widget are visible",
        },
        {
          task: "Read the Blue Widget price from the results and report it",
          postcondition: "The Blue Widget price is reported to the user",
        },
      ],
      expectedAnswerIncludes: "$19",
      nextAction(ctx) {
        if (ctx.url.includes("/results")) {
          return {
            thought: "The results list shows 'Blue Widget, $19'. Goal met.",
            action: "finish",
            answer: "The **Blue Widget** costs **$19** according to the search results.",
            evidence: "Results page lists 'Blue Widget, $19'.",
            completedSubtask: true,
            reason: "Report the Blue Widget price",
          };
        }
        if (ctx.url.includes("/search")) {
          const input = findElement(
            ctx.elements,
            (el) => el.attrs.placeholder === "Search products",
          );
          if (!input) {
            return { thought: "Search input not visible; scroll to find it.", action: "scroll", scrollDirection: "down" };
          }
          if ((input.attrs.value || "") !== "blue widget") {
            return {
              thought: "Type the query into the search box.",
              action: "type",
              id: input.id,
              text: "blue widget",
              reason: "Enter the search query",
            };
          }
          return {
            thought: "Typing does not submit, press Enter to run the search.",
            action: "keypress",
            id: input.id,
            text: "Enter",
            completedSubtask: true,
            reason: "Submit the search",
          };
        }
        return {
          thought: "Open the product search page first.",
          action: "navigate",
          url: url("/search"),
          reason: "Go to the search page",
        };
      },
    },

    form: {
      task: "Fill the signup form with the name Ada Lovelace, email ada@example.com, company Analytical Engines Ltd and phone 555-0100, then submit it.",
      plan: [
        {
          task: "Fill every signup field with the provided details",
          postcondition: "All four fields contain the provided values",
        },
        {
          task: "Submit the form and confirm it was accepted",
          postcondition: "A signup confirmation message is visible",
        },
      ],
      fields: [
        { id: "name", value: "Ada Lovelace" },
        { id: "email", value: "ada@example.com" },
        { id: "company", value: "Analytical Engines Ltd" },
        { id: "phone", value: "555-0100" },
      ],
      expectedAnswerIncludes: "Ada Lovelace",
      nextAction(ctx) {
        if (!ctx.url.includes("/signup")) {
          return {
            thought: "Open the signup page.",
            action: "navigate",
            url: url("/signup"),
            reason: "Go to the signup form",
          };
        }
        for (const field of this.fields) {
          const el = findElement(
            ctx.elements,
            (e) =>
              e.tag === "input" &&
              (e.attrs.value || "") !== field.value &&
              matchesField(e, field.id),
          );
          if (el) {
            return {
              thought: `Field ${field.id} still shows "${el.attrs.value || ""}", replace it.`,
              action: "type",
              id: el.id,
              text: field.value,
              reason: `Fill the ${field.id} field`,
            };
          }
        }
        if (!ctx.systemText.includes("Thanks for signing up")) {
          const btn = findElement(
            ctx.elements,
            (e) => e.tag === "button" && /sign up/i.test(e.text),
          );
          if (btn) {
            return {
              thought: "All fields match the requested values; submit the form.",
              action: "click",
              id: btn.id,
              completedSubtask: true,
              reason: "Submit the signup form",
            };
          }
          return { thought: "Submit button not in view; scroll down.", action: "scroll", scrollDirection: "down" };
        }
        return {
          thought: "The confirmation message is visible. Goal met.",
          action: "finish",
          answer: "Submitted the signup form for **Ada Lovelace:** the site confirmed the signup.",
          evidence: "Confirmation text 'Thanks for signing up, Ada Lovelace!' is visible.",
          completedSubtask: true,
          reason: "Report the confirmed signup",
        };
      },
    },

    login: {
      task: "Open my account page on this site and tell me my account balance.",
      plan: [
        {
          task: "Open the account page and read the balance",
          postcondition: "The account balance is visible",
        },
      ],
      expectedAnswerIncludes: "I need your input to continue",
      nextAction(ctx) {
        if (!ctx.url.includes("/account")) {
          return {
            thought: "Open the account page.",
            action: "navigate",
            url: url("/account"),
            reason: "Go to the account page",
          };
        }
        // Login wall: NEVER guess or invent credentials, hand back to the
        // user instead.
        return {
          thought:
            "The page shows a login wall ('Please log in to view your account balance'). I must not guess credentials.",
          action: "ask_user",
          question:
            "The account page requires a login. Please log in yourself, or tell me exactly how you want me to proceed.",
        };
      },
    },

    compare: {
      task: "Compare the prices of Item A and Item B on this site and tell me which one is cheaper.",
      plan: [
        {
          task: "Open Item A and note its price",
          postcondition: "Item A's price is saved to the scratchpad",
        },
        {
          task: "Open Item B and note its price",
          postcondition: "Item B's price is saved to the scratchpad",
        },
        {
          task: "Compare both noted prices and report the cheaper item",
          postcondition: "The cheaper item is reported with both prices",
        },
      ],
      expectedAnswerIncludes: "$18",
      nextAction(ctx) {
        const hasNoteA = ctx.systemText.includes("Item A costs $25");
        const hasNoteB = ctx.systemText.includes("Item B costs $18");
        if (!hasNoteA) {
          if (!ctx.url.includes("/item-a")) {
            return {
              thought: "Visit Item A first to read its price.",
              action: "navigate",
              url: url("/item-a"),
              reason: "Open Item A",
            };
          }
          return {
            thought: "Item A's page shows 'Price: $25', save it before navigating away.",
            action: "remember",
            note: "Item A costs $25",
            completedSubtask: true,
            reason: "Note Item A's price",
          };
        }
        if (!hasNoteB) {
          if (!ctx.url.includes("/item-b")) {
            return {
              thought: "Now visit Item B for its price.",
              action: "navigate",
              url: url("/item-b"),
              reason: "Open Item B",
            };
          }
          return {
            thought: "Item B's page shows 'Price: $18', save it too.",
            action: "remember",
            note: "Item B costs $18",
            completedSubtask: true,
            reason: "Note Item B's price",
          };
        }
        return {
          thought: "Both prices are in my notes: A=$25, B=$18. B is cheaper.",
          action: "finish",
          answer: "**Item B** is cheaper: it costs **$18**, while Item A costs $25.",
          evidence: "Item B's page shows 'Price: $18'; my scratchpad note from Item A's page records $25.",
          completedSubtask: true,
          reason: "Report the cheaper item",
        };
      },
    },
  };
}

/** Matches a scanned element to a fixture field by label/name-ish hints. */
function matchesField(el, fieldId) {
  const hints = [
    el.attrs["aria-label"] || "",
    el.attrs.placeholder || "",
    el.attrs.name || "",
    String(el.text || ""),
  ]
    .join(" ")
    .toLowerCase();
  const needles = {
    name: ["full name", "name"],
    email: ["email"],
    company: ["company"],
    phone: ["phone"],
  }[fieldId];
  return needles.some((needle) => hints.includes(needle));
}

// ---------------------------------------------------------------------------
// SSE response builders (OpenAI-compatible streaming)
// ---------------------------------------------------------------------------

function sseBody(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseToolCall(toolName, args) {
  return sseBody([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}`,
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
  ]);
}

function sseContent(text) {
  return sseBody([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 30, completion_tokens: 10 } },
  ]);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createE2EServer(port = 8907) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const scenarios = buildScenarios(baseUrl);

  const state = {
    scenarioName: "search",
    actionLog: [],
    llmCalls: 0,
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, baseUrl);
    const pathname = parsedUrl.pathname;

    const respond = (status, body, type = "text/html") => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end(body);
    };

    if (req.method === "OPTIONS") {
      respond(204, "");
      return;
    }

    // --- Control API ---
    if (pathname === "/control/scenario" && req.method === "POST") {
      collectBody(req, (raw) => {
        try {
          const { name } = JSON.parse(raw);
          if (!scenarios[name]) {
            respond(400, JSON.stringify({ error: `unknown scenario ${name}` }), "application/json");
            return;
          }
          state.scenarioName = name;
          state.actionLog = [];
          state.llmCalls = 0;
          respond(200, JSON.stringify({ ok: true, task: scenarios[name].task }), "application/json");
        } catch (err) {
          respond(400, JSON.stringify({ error: err.message }), "application/json");
        }
      });
      return;
    }

    if (pathname === "/control/log" && req.method === "GET") {
      respond(
        200,
        JSON.stringify({ scenario: state.scenarioName, actions: state.actionLog, llmCalls: state.llmCalls }),
        "application/json",
      );
      return;
    }

    // --- Scripted gateway ---
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      collectBody(req, (raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch (err) {
          respond(400, JSON.stringify({ error: { message: "bad json" } }), "application/json");
          return;
        }
        state.llmCalls++;
        const scenario = scenarios[state.scenarioName];
        const systemText = contentToText(body.messages?.[0]?.content ?? "");
        const userText = contentToText(body.messages?.[1]?.content ?? "");
        const toolName = body.tools?.[0]?.function?.name || null;

        let sse;
        if (toolName === "submit_plan") {
          sse = sseToolCall("submit_plan", { subtasks: scenario.plan });
        } else if (toolName === "submit_validation") {
          sse = sseToolCall("submit_validation", {
            verdict: "pass",
            reason: "The claimed answer matches the scripted page evidence.",
          });
        } else if (toolName === "browser_action") {
          const ctx = {
            url: currentUrlOf(systemText),
            elements: parseElements(systemText),
            systemText,
            userText,
          };
          const action = scenario.nextAction(ctx);
          state.actionLog.push(action);
          sse = sseToolCall("browser_action", action);
        } else if (systemText.includes("intent and capability router")) {
          const taskMatch = userText.match(/Latest user message: ([\s\S]*)$/);
          sse = sseContent(
            JSON.stringify({
              thought_process: "Scripted router: every harness task drives the browser.",
              route: "browser",
              reply: "On it, running that in the browser.",
              action: null,
              url: null,
              tabId: null,
              browser_task: taskMatch ? taskMatch[1].trim() : scenario.task,
            }),
          );
        } else if (systemText.includes("reflection module")) {
          sse = sseContent(
            JSON.stringify({
              assumption: "The previous element choice was wrong.",
              strategy: "Re-read the element list and pick the labeled control.",
            }),
          );
        } else {
          sse = sseContent(
            JSON.stringify({ action: "answer", reply: "Scripted gateway fallback answer." }),
          );
        }

        respond(200, sse, "text/event-stream");
      });
      return;
    }

    // --- Fixture pages ---
    if (pathname === "/results") {
      respond(200, renderResults(parsedUrl.searchParams.get("q")));
      return;
    }
    if (pathname === "/" || pathname === "/home") {
      respond(200, FIXTURES["/home"]);
      return;
    }
    if (FIXTURES[pathname]) {
      respond(200, FIXTURES[pathname]);
      return;
    }

    respond(404, pageShell("Not found", "<h1>404</h1>"));
  });

  return {
    baseUrl,
    scenarios,
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve(baseUrl));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function collectBody(req, done) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => done(raw));
}

module.exports = { createE2EServer };

if (require.main === module) {
  const port = parseInt(process.env.E2E_PORT || "8907", 10);
  createE2EServer(port)
    .listen()
    .then((baseUrl) => console.log(`E2E fixture + gateway server on ${baseUrl}`));
}
