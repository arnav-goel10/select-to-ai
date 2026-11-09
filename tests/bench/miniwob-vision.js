/**
 * MiniWoB++ for a screenshot model: the same tasks, seeds and episodes as
 * miniwob.js, driven by a model that sees only a picture of the page and
 * answers with pixel actions (Microsoft Fara 1.5 4B, served by Ollama).
 * No extension is loaded; the harness itself moves the mouse and types.
 *
 *   MINIWOB_HTML=/path/to/miniwob-plusplus/miniwob/html \
 *   node tests/bench/miniwob-vision.js
 *
 * Env: MINIWOB_TASKS, MINIWOB_EPISODES, MINIWOB_TIMEOUT_S, BENCH_OUT,
 * BENCH_SHARD and BENCH_HEADFUL as in miniwob.js; VISION_URL (an
 * OpenAI-compatible base URL, default the local Ollama server);
 * VISION_MODEL (default the Fara 1.5 4B GGUF pulled into Ollama);
 * VISION_MAX_STEPS (default 25 model calls an episode); VISION_SCALE (how
 * many screenshot pixels show one CSS pixel, default 3); VISION_AUTO_REPLY=1
 * answers ask_user_question the way Fara's own evaluation does instead of
 * ending the episode; VISION_DEBUG=1 prints each reply.
 *
 * An episode: the task page is opened, seeded and started exactly as in
 * miniwob.js; the model gets a screenshot and the task's own wording, and
 * then, each step, a new screenshot; its action is done with Puppeteer's
 * real mouse and keyboard. The episode ends when the page says so, when the
 * model terminates or asks the user, at the step cap, or at the timeout.
 * Success is the page's raw reward being positive.
 *
 * The picture: Fara was trained mostly on 1440x900 screenshots, and a
 * MiniWoB task is 160x210 CSS pixels. The page is laid out in a 480x300
 * CSS viewport and drawn at deviceScaleFactor 3, so the screenshot is
 * 1440x900 and the task fills about a third of its width and two thirds of
 * its height. The page's own layout and event coordinates are untouched
 * (no CSS zoom), and a mouse position is in CSS pixels.
 *
 * Coordinates: Fara 1.5 answers in a fixed 1000x1000 space laid over the
 * screenshot, whatever its size (the reference harness's FARA_DISPLAY_SIZE,
 * and its system prompt says "The screen's resolution is 1000x1000"), so
 * (x, y) is (x / 1000 * 480, y / 1000 * 300) in CSS pixels.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_TASKS, serve } = require("./miniwob.js");

const HTML = process.env.MINIWOB_HTML || "";
const BASE_URL = (process.env.VISION_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const MODEL = process.env.VISION_MODEL || "hf.co/bartowski/Fara1.5-4B-GGUF:Q4_K_M";
const KEY = process.env.VISION_API_KEY || "ollama";
const EPISODES = Math.max(1, parseInt(process.env.MINIWOB_EPISODES || "2", 10));
const TIMEOUT_MS = Math.max(20, parseInt(process.env.MINIWOB_TIMEOUT_S || "150", 10)) * 1000;
const MAX_STEPS = Math.max(1, parseInt(process.env.VISION_MAX_STEPS || "25", 10));
const SCALE = Math.max(1, parseFloat(process.env.VISION_SCALE || "3"));
const OUT = path.resolve(process.env.BENCH_OUT || path.join(__dirname, "out", "miniwob-vision"));
const HEADFUL = !!process.env.BENCH_HEADFUL;
const AUTO_REPLY = !!process.env.VISION_AUTO_REPLY;
const DEBUG = !!process.env.VISION_DEBUG;
// Not miniwob.js's port, so the two arms can run side by side.
const PORT = parseInt(process.env.MINIWOB_PORT || "8932", 10);

// The screenshot is always 1440x900, the size Fara was trained on.
const SHOT_W = 1440;
const SHOT_H = 900;
const VIEW_W = Math.round(SHOT_W / SCALE);
const VIEW_H = Math.round(SHOT_H / SCALE);
const DISPLAY_SIZE = 1000;
// Fara's harness keeps the three newest screenshots in the conversation.
const MAX_IMAGES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Fara 1.5's system prompt and computer_use tool, reproduced from Microsoft's
 * reference harness, https://github.com/microsoft/fara (main, fetched
 * 3 Oct 2026): src/fara/agents/fara/_prompts.py (identity, critical points,
 * tool description and parameters, the fn-call template), composed as
 * src/fara/qwen_helpers/fncall_prompt.py does (one system message, each tool
 * as Python's json.dumps of {"type": "function", "function": ...}), with the
 * fixed 1000x1000 display size of src/fara/agents/coord_spaces.py.
 * One change: the repo's identity names Qwen3.5-9B; the 4B model card
 * (https://huggingface.co/microsoft/Fara1.5-4B, "System prompt") gives the
 * same text naming Qwen3.5-4B, and that is used here. The em dashes of the
 * original are written as \u2014 escapes so the prompt is sent unchanged.
 */
const IDENTITY = "You are Fara, a computer use agent (CUA) specialized for web browsers. You are developed by Microsoft AI Frontiers. You assist users with completing and automating tasks that require the use of a web browser.\n\n"
  + "The model was trained in the timeframe of January - April 2026. You can effectively perform tasks even beyond this range by accessing the web browser and using the latest information on the live web. But your knowledge cutoff is limited to early 2026, so you may not be aware of events or developments that occurred after that time, without explicitly browsing and searching for latest information on the web.\n\n"
  + "This edition of the model was trained using SFT on top of Qwen3.5-4B, using a synthetic data mixture generated and developed by Microsoft AI Frontiers.";

const CRITICAL_POINTS = "A critical point is a situation where we must pause and request information or confirmation from the user before proceeding. There are three types:\n\n"
  + "Case 1: Missing User Information \u2014 The task requires personal information that the user has not provided (e.g., email, phone number, address, payment details). Never fabricate or assume personal information. Fill in only what the user has explicitly provided, then pause and ask for any missing required fields. (e.g., form requires phone number but user only gave name and email -> fill name and email, then ask for phone number.) If the user has provided all required information, proceed without stopping.\n\n"
  + "Case 2: Underspecified Task \u2014 The task description is ambiguous or missing details needed to make a decision at the current step. Pause and ask for clarification. (e.g., user asks to book a flight but doesn't specify destination -> ask for destination.) If the user's instructions contain all information needed for the current decision, proceed without stopping.\n\n"
  + "Case 3: Irreversible Action \u2014 We are about to perform an action that cannot be undone (e.g., submitting a form, completing a purchase, sending a message, deleting data). If the user explicitly authorized the action (e.g., \"submit the form\", \"complete the purchase\", \"you have my permission to submit\") -> proceed without stopping. If the user did NOT explicitly authorize the action -> stop and ask for confirmation. (e.g., \"fill out a form\" with no mention of submitting -> fill the form, then ask before submitting; \"fill out and submit a form\" -> fill and submit without stopping.)\n\n"
  + "Only stop at a critical point if (1) required information is missing, (2) the task is ambiguous, OR (3) an irreversible action lacks explicit user authorization. If the user has provided all necessary information AND explicitly authorized the action, proceed without interruption.";

const TOOL_DESCRIPTION = [
  "Use a mouse and keyboard to interact with a computer, and take screenshots.",
  "* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.",
  "* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try wait and taking another screenshot.",
  `* The screen's resolution is ${DISPLAY_SIZE}x${DISPLAY_SIZE}.`,
  "* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.",
  "* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.",
  "* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges.",
].join("\n");

const ACTION_DESCRIPTION = [
  "The action to perform. The available actions are:",
  "* `key`: Performs key down presses on the arguments passed in order, then performs key releases in reverse order. Includes \"Enter\", \"Alt\", \"Shift\", \"Tab\", \"Control\", \"Backspace\", \"Delete\", \"Escape\", \"ArrowUp\", \"ArrowDown\", \"ArrowLeft\", \"ArrowRight\", \"PageDown\", \"PageUp\", \"Shift\", etc.",
  "* `type`: Type a string of text on the keyboard.",
  "* `mouse_move`: Move the cursor to a specified (x, y) pixel coordinate on the screen.",
  "* `left_click`: Click the left mouse button.",
  "* `double_click`: Double-click the left mouse button.",
  "* `right_click`: Click the right mouse button.",
  "* `triple_click`: Triple-click the left mouse button (e.g. to select a line of text).",
  "* `left_click_drag`: Click and drag the cursor to a specified (x, y) pixel coordinate on the screen.",
  "* `scroll`: Performs a scroll of the mouse scroll wheel.",
  "* `hscroll`: Performs a horizontal scroll (mapped to regular scroll).",
  "* `visit_url`: Visit a specified URL.",
  "* `history_back`: Go back to the previous page in the browser history.",
  "* `web_search`: Perform a web search with a specified query.",
  "* `read_page_answer_question`: Read the current page content and answer a question about it.",
  "* `pause_and_memorize_fact`: Pause and memorize a fact for future reference.",
  "* `ask_user_question`: Ask the user a clarifying question and wait for a response.",
  "* `wait`: Wait specified seconds for the change to happen.",
  "* `terminate`: Terminate the current task and provide the final answer.",
].join("\n");

const TOOL = {
  name: "computer_use",
  description: TOOL_DESCRIPTION,
  parameters: {
    properties: {
      action: {
        description: ACTION_DESCRIPTION,
        enum: ["key", "type", "mouse_move", "left_click", "left_click_drag", "right_click", "double_click", "triple_click", "scroll", "hscroll", "visit_url", "history_back", "web_search", "read_page_answer_question", "pause_and_memorize_fact", "ask_user_question", "wait", "terminate"],
        type: "string",
      },
      keys: { description: "Required only by `action=key`.", type: "array" },
      text: { description: "Required only by `action=type`.", type: "string" },
      coordinate: { description: "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates to move the mouse to. Required by `action=left_click`, `action=double_click`, `action=right_click`, `action=triple_click`, `action=left_click_drag`, and `action=mouse_move`.", type: "array" },
      pixels: { description: "The amount of scrolling to perform. Positive values scroll up, negative values scroll down. Required only by `action=scroll` and `action=hscroll`.", type: "number" },
      url: { description: "The URL to visit. Required only by `action=visit_url`.", type: "string" },
      query: { description: "The query to search for. Required only by `action=web_search`.", type: "string" },
      fact: { description: "The fact to remember for the future. Required only by `action=pause_and_memorize_fact`.", type: "string" },
      question: { description: "The question to ask. Required by `action=read_page_answer_question` and `action=ask_user_question`.", type: "string" },
      time: { description: "The seconds to wait. Required only by `action=wait`.", type: "number" },
      answer: { description: "The final answer for the task. Required only by `action=terminate`.", type: "string" },
    },
    required: ["action"],
    type: "object",
  },
};

/** JSON as Python's json.dumps writes it (", " and ": " between items). */
function pyDumps(v) {
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}

const SYSTEM_PROMPT = `${IDENTITY}\n\n${CRITICAL_POINTS}\n\n`
  + "You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n"
  + pyDumps({ type: "function", function: TOOL })
  + "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call>";

// What Fara's harness says with each new screenshot, and what its evaluation
// mode answers to ask_user_question (fara15_agent.py).
const NEXT_SCREENSHOT = "Here is the next screenshot. Think about what to do next.";
const AUTO_USER_REPLY = "keep going so far as you don't make up information, you have my approval";
// Key names as Fara's harness maps them (src/fara/agents/key_mapping.py),
// except "/" and "\\", which Puppeteer knows by the character itself.
const KEY_NAMES = {
  alt: "Alt", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp",
  backspace: "Backspace", capslock: "CapsLock", cmd: "Meta", ctrl: "Control", control: "Control", delete: "Delete", end: "End", enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", home: "Home",
  insert: "Insert", option: "Alt", pagedown: "PageDown", pageup: "PageUp", shift: "Shift", space: " ", super: "Meta", tab: "Tab", win: "Meta", meta: "Meta",
};
const NOT_HERE = new Set(["visit_url", "web_search", "history_back", "read_page_answer_question"]);

/** The thoughts and the computer_use arguments of a reply, or null. */
function parseReply(message) {
  const text = String((message && message.content) || "");
  // Ollama may lift the call out of the text itself.
  const lifted = message && Array.isArray(message.tool_calls) && message.tool_calls[0];
  if (lifted && lifted.function) {
    let args = lifted.function.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch (_e) { args = null; } }
    if (args && args.action) return { thoughts: text.trim(), args };
  }
  const at = text.indexOf("<tool_call>");
  if (at < 0) return null;
  const body = text.slice(at + "<tool_call>".length).split("</tool_call>")[0].trim();
  let call = null;
  try { call = JSON.parse(body); } catch (_e) {
    // A reply cut off before its closing braces, or with one brace too many.
    const m = body.match(/\{[\s\S]*\}/);
    if (m) { try { call = JSON.parse(m[0]); } catch (_e2) { call = null; } }
  }
  if (!call) return null;
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : call.action ? call : null;
  return args && args.action ? { thoughts: text.slice(0, at).trim(), args } : null;
}

/** One model call: the reply's message, the token counts, and its seconds. */
async function ask(messages, deadline) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const usage = body.usage || {};
  return {
    message: (body.choices && body.choices[0] && body.choices[0].message) || {},
    prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, ms: Date.now() - t0,
  };
}

/**
 * The conversation as Fara's harness sends it: the system prompt, the first
 * message (screenshot and task), then each reply and the next screenshot,
 * with only the newest MAX_IMAGES screenshots kept; the first message keeps
 * its task text when its picture is dropped.
 */
function conversation(turns) {
  let images = 0;
  const kept = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "assistant") { kept.push({ role: "assistant", content: t.text }); continue; }
    if (images < MAX_IMAGES) kept.push({ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${t.image}` } }, { type: "text", text: t.text }] });
    else if (i === 0) kept.push({ role: "user", content: [{ type: "text", text: t.text }] });
    images++;
  }
  return [{ role: "system", content: SYSTEM_PROMPT }, ...kept.reverse()];
}

/** The model's 1000x1000 point as a CSS pixel position on the page. */
function toPage(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
  const [x, y] = coordinate.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: (x / DISPLAY_SIZE) * VIEW_W, y: (y / DISPLAY_SIZE) * VIEW_H };
}

/** What sits at a page position, for the record. */
async function whatIsAt(page, at) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return "nothing";
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${text ? ` "${text}"` : ""}`;
  }, at).catch(() => "");
}

/**
 * Does one action with the real mouse and keyboard, as Fara's Playwright
 * environment does. Returns what the harness tells the model next (empty
 * for most actions, as in the reference), what the action touched, and
 * whether it ends the episode.
 */
async function perform(page, args, mouse) {
  const action = String(args.action || "");
  const at = toPage(args.coordinate);
  const needsPoint = ["left_click", "right_click", "double_click", "triple_click", "mouse_move", "left_click_drag"].includes(action);
  if (needsPoint && !at) return { note: `The action ${action} needs a coordinate [x, y].`, on: "", ok: false };
  const on = at ? await whatIsAt(page, at) : "";
  switch (action) {
    case "left_click": await page.mouse.click(at.x, at.y, { delay: 10 }); break;
    case "right_click": await page.mouse.click(at.x, at.y, { button: "right" }); break;
    case "double_click": await page.mouse.click(at.x, at.y, { count: 2 }); break;
    case "triple_click": await page.mouse.click(at.x, at.y, { count: 3 }); break;
    case "mouse_move": await page.mouse.move(at.x, at.y); break;
    case "left_click_drag":
      // From where the cursor is to the point given.
      await page.mouse.down();
      await page.mouse.move(at.x, at.y, { steps: 10 });
      await page.mouse.up();
      break;
    case "type": await page.keyboard.type(String(args.text ?? args.text_value ?? "")); break;
    case "key": {
      const keys = (Array.isArray(args.keys) ? args.keys : [args.keys]).filter((k) => k !== undefined && k !== null).map((k) => KEY_NAMES[String(k).toLowerCase()] || String(k));
      const down = [];
      try {
        for (const k of keys) { await page.keyboard.down(k); down.push(k); }
      } catch (e) {
        for (const k of down.reverse()) await page.keyboard.up(k).catch(() => {});
        return { note: `The key ${keys[down.length]} is not known: ${String(e.message).slice(0, 80)}`, on, ok: false };
      }
      for (const k of down.reverse()) await page.keyboard.up(k);
      break;
    }
    case "scroll": await page.mouse.wheel({ deltaY: -Math.trunc((Number(args.pixels) || 0) * VIEW_H / DISPLAY_SIZE) }); break;
    case "hscroll": await page.mouse.wheel({ deltaX: Math.trunc((Number(args.pixels) || 0) * VIEW_W / DISPLAY_SIZE) }); break;
    case "wait": await sleep(Math.min(10, Math.max(0, Number(args.time ?? args.duration ?? 3) || 0)) * 1000); break;
    case "pause_and_memorize_fact": break;
    case "terminate": return { end: "agent stopped", on, ok: true };
    case "ask_user_question": return AUTO_REPLY ? { reply: AUTO_USER_REPLY, on, ok: true } : { end: "asked the user", on, ok: true };
    default:
      if (NOT_HERE.has(action)) return { note: `The action ${action} is not available in this test. Work with the page as it is.`, on, ok: false };
      return { note: `The action ${action} is not one of the available actions.`, on, ok: false };
  }
  if (at) mouse.at = at;
  return { note: "", on, ok: true };
}

async function main() {
  if (!HTML || !fs.existsSync(path.join(HTML, "core", "core.js"))) throw new Error("MINIWOB_HTML must point at miniwob-plusplus/miniwob/html");
  let tasks = (process.env.MINIWOB_TASKS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tasks.length) tasks = DEFAULT_TASKS;
  const shard = (process.env.BENCH_SHARD || "").match(/^(\d+)\/(\d+)$/);
  if (shard) tasks = tasks.filter((_t, i) => i % Number(shard[2]) === Number(shard[1]) - 1);
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(HTML, PORT);
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: !HEADFUL, args: ["--no-first-run", "--disable-features=DialMediaRouteProvider"] });

  const rows = [];
  const saved = path.join(OUT, "results.json");
  const earlier = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) : [];
  const done = new Set(earlier.map((r) => `${r.task}#${r.episode}`));
  rows.push(...earlier);
  const stamp = () => new Date().toTimeString().slice(0, 8);
  console.log(`MiniWoB++ by screenshot: ${MODEL} at ${BASE_URL}; page ${VIEW_W}x${VIEW_H} CSS px drawn at ${SHOT_W}x${SHOT_H}; up to ${MAX_STEPS} steps, ${TIMEOUT_MS / 1000}s an episode\nOutput: ${OUT}\n`);
  try {
    for (const task of tasks) {
      for (let episode = 1; episode <= EPISODES; episode++) {
        if (done.has(`${task}#${episode}`)) continue;
        const row = await runEpisode(browser, task, episode);
        rows.push(row);
        fs.writeFileSync(saved, JSON.stringify(rows, null, 1));
        const per = row.steps ? `  ${(row.timing.model / 1000 / row.steps).toFixed(1)}s model/step  ${Math.round(row.tokens.prompt / row.steps)}+${Math.round(row.tokens.completion / row.steps)} tok/step` : "";
        console.log(`${stamp()}  ${row.success ? "PASS" : "FAIL"}  ${task.padEnd(26)} ep ${episode}  reward ${row.reward === null ? "none" : row.reward.toFixed(2)}  ${String(row.steps).padStart(2)} steps  ${String(row.seconds).padStart(4)}s${per}  ${row.ending}  ${row.utterance.slice(0, 70)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  report(rows);
}

async function runEpisode(browser, task, episode) {
  const open = await browser.pages();
  const page = await browser.newPage();
  for (const p of open) await p.close().catch(() => {});
  await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: SCALE });
  page.on("console", () => {});
  await page.goto(`http://localhost:${PORT}/miniwob/${task}.html`, { waitUntil: "load" });
  await sleep(300);
  // Seeded and started exactly as miniwob.js does, so episode N is the same problem in both arms.
  const utterance = await page.evaluate((seed, ms) => {
    core.EPISODE_MAX_TIME = ms;
    Math.seedrandom(`episode-${seed}`);
    core.startEpisodeReal();
    const said = core.getUtterance();
    return typeof said === "string" ? said : String((said && said.utterance) || "");
  }, episode, TIMEOUT_MS + 60000);

  const t0 = Date.now();
  const deadline = t0 + TIMEOUT_MS;
  const pageState = () => page.evaluate(() => ({ done: WOB_DONE_GLOBAL, reward: WOB_RAW_REWARD_GLOBAL, reason: WOB_REWARD_REASON || "" })).catch(() => null);
  const turns = [];
  const steps = [];
  const history = [];
  const replies = [];
  const timing = { observe: 0, model: 0, act: 0 };
  const tokens = { prompt: 0, completion: 0 };
  const mouse = { at: null };
  let note = "";
  let ending = "ran out of steps";
  for (let step = 1; step <= MAX_STEPS; step++) {
    const state = await pageState();
    if (state && state.done) { ending = "page ended the episode"; break; }
    if (Date.now() >= deadline) { ending = "timed out"; break; }
    const o0 = Date.now();
    const image = await page.screenshot({ type: "png", encoding: "base64" });
    timing.observe += Date.now() - o0;
    // The task text goes with the first screenshot; later ones carry the
    // page address and, when there is one, what the harness has to say.
    const url = page.url();
    const text = step === 1 ? utterance : `Current URL: ${url}\n${note ? `${note}\n${NEXT_SCREENSHOT}` : NEXT_SCREENSHOT}`;
    turns.push({ role: "user", image, text });
    note = "";
    let reply;
    try {
      reply = await ask(conversation(turns), deadline);
    } catch (e) {
      ending = Date.now() >= deadline ? "timed out" : `model error: ${String(e.message).slice(0, 100)}`;
      break;
    }
    timing.model += reply.ms;
    tokens.prompt += reply.prompt;
    tokens.completion += reply.completion;
    // Ollama hands back the thinking apart from the reply. Fara's harness
    // keeps the whole reply, thoughts and call, as the assistant's turn.
    const thought = String(reply.message.reasoning || reply.message.reasoning_content || "").trim();
    const said = `${thought ? `${thought}\n\n` : ""}${String(reply.message.content || "").trim()}`;
    turns.push({ role: "assistant", text: said });
    replies.push(`#${step} ${said}`.slice(0, 1500));
    if (DEBUG) console.log(`  [${task} #${step}] ${reply.prompt}+${reply.completion} tok ${(reply.ms / 1000).toFixed(1)}s\n  ${said.replace(/\n/g, "\n  ")}`);
    const parsed = parseReply(reply.message);
    const record = { step, prompt_tokens: reply.prompt, completion_tokens: reply.completion, modelSeconds: +(reply.ms / 1000).toFixed(2), actionSeconds: 0 };
    if (!parsed) {
      note = "Your last reply had no readable <tool_call>.";
      steps.push({ ...record, action: null });
      history.push({ step, ok: false, action: "unreadable reply", on: "", outcome: said.slice(0, 300) });
      continue;
    }
    const a0 = Date.now();
    let did;
    try { did = await perform(page, parsed.args, mouse); } catch (e) { did = { note: `The action failed: ${String(e.message).slice(0, 120)}`, on: "", ok: false }; }
    // A moment for the page to answer the action, as the reference waits for load.
    if (!did.end) await sleep(300);
    record.actionSeconds = +((Date.now() - a0) / 1000).toFixed(2);
    timing.act += Date.now() - a0;
    const { thoughts: _t, ...shown } = parsed.args;
    steps.push({ ...record, action: shown, on: did.on });
    history.push({ step, ok: did.ok, action: JSON.stringify(shown).slice(0, 200), on: did.on, goal: (thought || parsed.thoughts).slice(0, 300), outcome: did.note || (parsed.args.action === "terminate" ? String(parsed.args.answer || "").slice(0, 300) : "") });
    if (did.end) { ending = did.end; break; }
    if (did.reply) note = did.reply;
    else if (did.note) note = did.note;
  }
  // The page settles its reward a moment after the ending action.
  await sleep(600);
  const final = await page.evaluate(() => ({ done: WOB_DONE_GLOBAL, reward: WOB_DONE_GLOBAL ? WOB_RAW_REWARD_GLOBAL : null, reason: WOB_REWARD_REASON || "" })).catch(() => ({ done: false, reward: null, reason: "" }));
  if (final.done) ending = "page ended the episode";
  else if (["agent stopped", "asked the user"].includes(ending)) ending = `agent stopped before the page ended (${ending})`;
  return {
    task, episode, utterance, success: final.done && final.reward > 0, reward: final.reward, reason: final.reason, ending,
    steps: steps.length, seconds: Math.round((Date.now() - t0) / 1000),
    tokens, timing, model: MODEL, perStep: steps, history, log: replies.join("\n").slice(0, 6000),
  };
}

function report(rows) {
  const byTask = new Map();
  for (const r of rows) { if (!byTask.has(r.task)) byTask.set(r.task, []); byTask.get(r.task).push(r); }
  const lines = ["| task | passed | steps (passed) | endings |", "| --- | --- | --- | --- |"];
  let pass = 0;
  for (const [task, rs] of [...byTask.entries()].sort()) {
    const ok = rs.filter((r) => r.success);
    pass += ok.length;
    const endings = {};
    for (const r of rs) endings[r.ending] = (endings[r.ending] || 0) + 1;
    lines.push(`| ${task} | ${ok.length}/${rs.length} | ${ok.map((r) => r.steps).join(", ") || "-"} | ${Object.entries(endings).map(([k, v]) => `${k} ${v}`).join("; ")} |`);
  }
  lines.push("", `${pass} of ${rows.length} episodes passed (${rows.length ? Math.round(100 * pass / rows.length) : 0}%) across ${byTask.size} tasks.`);
  const text = lines.join("\n");
  console.log(`\n${text}`);
  fs.writeFileSync(path.join(OUT, "report.md"), text);
}

module.exports = { SYSTEM_PROMPT, parseReply, toPage };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
