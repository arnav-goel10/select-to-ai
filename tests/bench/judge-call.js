/**
 * The call to the judge model, shared by run.js and rejudge.js.
 *
 * The default judge is a model that drives no run in this benchmark and can
 * see screenshots, on the same NVIDIA endpoint the drivers use (see
 * DEFAULT_JUDGE below for why this one).
 *
 * Env:
 *   BENCH_JUDGE_URL     OpenAI-compatible base URL (default NVIDIA's)
 *   BENCH_JUDGE_MODEL   the judge's model (default DEFAULT_JUDGE.model)
 *   BENCH_JUDGE_KEY     its key (default BENCH_API_KEY)
 *   BENCH_JUDGE_VISION  1 to send screenshots, 0 not to (default: 1 for the
 *                       default judge, 0 for any other model)
 *   BENCH_JUDGE_SHOTS   how many screenshots to send (default 3): the final
 *                       page and the last view of the pages the run left
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JUDGE_SYSTEM, judgeMessage, parseVerdict, pickScreenshots } = require("./judge.js");

// Kimi K3 answers HTTP 410 (Gone) on the NVIDIA endpoint since early
// November 2026; set BENCH_JUDGE_MODEL and BENCH_JUDGE_KEY to another judge.
// Kimi K3: free on the NVIDIA endpoint, takes images, and is neither driver
// used so far (gpt-oss-20b, nemotron-3-ultra), so it does not share their
// blind spots. It read a Wolfram|Alpha result table from a screenshot
// correctly on 4 Oct 2026, as did gemma-4-31b and llama-3.2-90b-vision.
const DEFAULT_JUDGE = { url: "https://integrate.api.nvidia.com/v1", model: "moonshotai/kimi-k3", vision: true };

function judgeConfig(env = process.env) {
  const key = env.BENCH_JUDGE_KEY || env.BENCH_API_KEY || "";
  const isAnthropic = /^sk-ant-/i.test(key) || /anthropic\.com/i.test(env.BENCH_JUDGE_URL || "");
  const defaultModel = isAnthropic ? "claude-haiku-5-5" : DEFAULT_JUDGE.model;
  const model = env.BENCH_JUDGE_MODEL || defaultModel;
  const vision = env.BENCH_JUDGE_VISION !== undefined && env.BENCH_JUDGE_VISION !== ""
    ? env.BENCH_JUDGE_VISION !== "0"
    : (isAnthropic && /^claude-/i.test(model)) || (model === DEFAULT_JUDGE.model && DEFAULT_JUDGE.vision);
  return {
    url: (env.BENCH_JUDGE_URL || (isAnthropic ? "https://api.anthropic.com/v1/messages" : DEFAULT_JUDGE.url)).replace(/\/$/, ""),
    model,
    key,
    vision,
    isAnthropic,
    shots: Math.max(0, parseInt(env.BENCH_JUDGE_SHOTS || "3", 10)),
  };
}

let canScale = null;
/**
 * A screenshot as a data URL, scaled to at most `edge` pixels on its long
 * side with macOS's sips when it is there (a 1280x900 shot drops from about
 * 150 KB to about 50 KB); otherwise the file as it is.
 */
function imageUrl(file, edge = 1024) {
  let bytes = null;
  if (canScale !== false) {
    const out = path.join(os.tmpdir(), `judge-shot-${process.pid}-${path.basename(file)}`);
    try {
      execFileSync("sips", ["-Z", String(edge), "-s", "format", "jpeg", "-s", "formatOptions", "55", file, "--out", out], { stdio: "ignore" });
      bytes = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      canScale = true;
    } catch (_e) {
      canScale = false;
    }
  }
  if (!bytes) bytes = fs.readFileSync(file);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The verdict on one run. `run.screenshots` are file paths, oldest first.
 * Returns {success, blocked, keyPoints, met, reason} or, when no verdict
 * could be had, {success: false, judgeFailed: true, reason}.
 */
async function judgeRun(run, cfg = judgeConfig()) {
  let files = cfg.vision ? pickScreenshots((run.screenshots || []).filter((f) => fs.existsSync(f)), run.history, cfg.shots) : [];
  const isAnthropic = cfg.isAnthropic || /^sk-ant-/i.test(cfg.key || "") || /anthropic\.com/i.test(cfg.url || "");
  const contentFor = (shots) => {
    const text = judgeMessage({ ...run, screenshots: shots });
    if (!shots.length) return text;
    if (isAnthropic) {
      return [
        { type: "text", text },
        ...shots.map((f) => {
          const data = imageUrl(f).replace(/^data:image\/jpeg;base64,/, "");
          return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
        }),
      ];
    }
    return [{ type: "text", text }, ...shots.map((f) => ({ type: "image_url", image_url: { url: imageUrl(f) } }))];
  };
  let content = contentFor(files);
  let lastReply = "";
  let degenerated = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = isAnthropic
      ? (/\/v1\/messages$/.test(cfg.url) ? cfg.url : `${cfg.url.replace(/\/v1$/, "")}/v1/messages`)
      : `${cfg.url}/chat/completions`;
    const headers = isAnthropic
      ? { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${cfg.key}` };
    const reqBody = isAnthropic
      // Current Claude models take no temperature but their own; they think adaptively, so the room covers thinking too.
      ? { model: cfg.model, max_tokens: 8000, system: JUDGE_SYSTEM, messages: [{ role: "user", content }] }
      : { model: cfg.model, temperature: degenerated ? 0.2 : 0, max_tokens: degenerated ? 4000 : 8000, messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content }] };
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(240000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      if (isAnthropic) {
        const text = (Array.isArray(body.content) ? body.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
        const verdict = parseVerdict(text);
        // What the judge cost, kept apart from the agent's own spend.
        if (verdict) return { ...verdict, screenshotsSeen: files.length, judgeUsage: { model: cfg.model, input: (body.usage && body.usage.input_tokens) || 0, output: (body.usage && body.usage.output_tokens) || 0 } };
        lastReply = String(text || JSON.stringify(body)).slice(0, 600);
      } else {
        const message = (body.choices && body.choices[0] && body.choices[0].message) || {};
        const verdict = parseVerdict(message.content) || parseVerdict(message.reasoning_content || message.reasoning);
        if (verdict) return { ...verdict, screenshotsSeen: files.length };
        lastReply = String(message.content || message.reasoning_content || JSON.stringify(body)).slice(0, 600);
      }
      // If a vision judge degenerated into repetition ("!!!!..."), retry with fewer images and slight temperature.
      degenerated = true;
      if (files.length > 1) { files = files.slice(-1); content = contentFor(files); }
    } else if (res.status === 400 && Number((JSON.stringify(body).match(/at most (\d+) image/i) || [])[1]) < files.length) {
      // Some models take fewer images than asked for: as many as they take are sent, the final page first.
      const most = Number(JSON.stringify(body).match(/at most (\d+) image/i)[1]);
      files = most > 0 ? files.slice(-most) : [];
      content = contentFor(files);
      attempt--;
      continue;
    } else if (![429, 0].includes(res.status) && res.status < 500) {
      return { success: false, reason: `judge error HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`, judgeFailed: true };
    } else {
      lastReply = JSON.stringify(body).slice(0, 300);
    }
    await sleep(5000 * (attempt + 1));
  }
  return { success: false, reason: "the judge gave no readable verdict", judgeFailed: true, judgeReply: lastReply };
}

module.exports = { DEFAULT_JUDGE, judgeConfig, judgeRun, imageUrl };
