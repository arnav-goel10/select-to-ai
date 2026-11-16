/**
 * The call to the judge model, shared by run.js and rejudge.js.
 *
 * The default judge is a model that drives no run in this benchmark and can
 * see screenshots, on the same NVIDIA endpoint the drivers use (see
 * DEFAULT_JUDGE below for why this one).
 *
 * Env:
 *   BENCH_JUDGE_URL     OpenAI-compatible base URL, or Anthropic's messages
 *                       URL (default: Anthropic's for an Anthropic key or
 *                       agent, otherwise NVIDIA's)
 *   BENCH_JUDGE_MODEL   the judge's model (default DEFAULT_JUDGE.model)
 *   BENCH_JUDGE_KEY     its key. Without it the agent's key (BENCH_API_KEY)
 *                       is used only when the judge's endpoint is the agent's
 *                       own provider. A key is never sent to another
 *                       provider's endpoint: judgeConfig reports a problem
 *                       instead, and run.js stops on it.
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

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch (_e) { return ""; } };

/** The endpoint the agent's own key belongs to: its provider's, or the custom URL. */
function agentEndpoint(env = process.env) {
  if (env.BENCH_DRY === "1") return "";
  const provider = env.BENCH_PROVIDER || "openrouter";
  if (provider === "custom") return env.BENCH_CUSTOM_URL || "";
  const { PROVIDER_ENDPOINTS } = require("../../extension/defaults.js");
  return (PROVIDER_ENDPOINTS[provider] || {}).baseUrl || "";
}

/**
 * Where the judge is, and with which key. The judge's own key
 * (BENCH_JUDGE_KEY) goes where BENCH_JUDGE_URL says. The agent's key is
 * reused only for a judge on the agent's own provider: the hosts must be the
 * same. Anything else leaves the key empty and says why in `problem`.
 */
function judgeConfig(env = process.env) {
  const own = env.BENCH_JUDGE_KEY || "";
  const agentKey = env.BENCH_API_KEY || "";
  const agentUrl = agentEndpoint(env);
  const url = (env.BENCH_JUDGE_URL
    || (own ? (/^sk-ant-/i.test(own) ? ANTHROPIC_URL : DEFAULT_JUDGE.url)
      : /(^|\.)anthropic\.com$/.test(hostOf(agentUrl)) || /^sk-ant-/i.test(agentKey) ? ANTHROPIC_URL : DEFAULT_JUDGE.url)).replace(/\/$/, "");
  const isAnthropic = /(^|\.)anthropic\.com$/.test(hostOf(url));
  let key = own;
  let problem = "";
  if (!key) {
    if (agentKey && hostOf(url) && hostOf(url) === hostOf(agentUrl)) key = agentKey;
    else if (agentKey) problem = `The judge is at ${hostOf(url) || "an unknown address"} and the agent's key belongs to ${hostOf(agentUrl) || "another provider"}: a key is never sent to another provider. Set BENCH_JUDGE_KEY (and BENCH_JUDGE_URL) for the judge.`;
    else problem = "Set BENCH_JUDGE_KEY for the judge.";
  }
  const defaultModel = isAnthropic ? "claude-haiku-5-5" : DEFAULT_JUDGE.model;
  const model = env.BENCH_JUDGE_MODEL || defaultModel;
  const vision = env.BENCH_JUDGE_VISION !== undefined && env.BENCH_JUDGE_VISION !== ""
    ? env.BENCH_JUDGE_VISION !== "0"
    : (isAnthropic && /^claude-/i.test(model)) || (model === DEFAULT_JUDGE.model && DEFAULT_JUDGE.vision);
  return {
    url,
    model,
    key,
    vision,
    isAnthropic,
    problem,
    shots: Math.max(0, parseInt(env.BENCH_JUDGE_SHOTS || "3", 10)),
  };
}

/** Text from a provider's error with anything shaped like a key taken out: some providers echo the key they were sent. */
function scrub(text) {
  return String(text || "")
    .replace(/\b(sk|pk|rk|nvapi|gsk|xai|key)[-_][A-Za-z0-9_\-*.]{6,}/gi, "[key removed]")
    .replace(/\bBearer\s+[A-Za-z0-9_\-.*]{8,}/gi, "Bearer [key removed]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[long token removed]");
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
  const isAnthropic = cfg.isAnthropic !== undefined ? !!cfg.isAnthropic : /(^|\.)anthropic\.com$/.test(hostOf(cfg.url));
  // Every answered call is paid for, whether or not its verdict could be read.
  const judgeUsage = { model: cfg.model, input: 0, output: 0, calls: 0 };
  const paid = (body) => {
    const u = (body && body.usage) || {};
    judgeUsage.input += u.input_tokens || u.prompt_tokens || 0;
    judgeUsage.output += u.output_tokens || u.completion_tokens || 0;
    judgeUsage.calls++;
  };
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
      paid(body);
      if (isAnthropic) {
        const text = (Array.isArray(body.content) ? body.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
        const verdict = parseVerdict(text);
        // What the judge cost, kept apart from the agent's own spend.
        if (verdict) return { ...verdict, screenshotsSeen: files.length, judgeUsage };
        lastReply = scrub(String(text || JSON.stringify(body)).slice(0, 600));
      } else {
        const message = (body.choices && body.choices[0] && body.choices[0].message) || {};
        const verdict = parseVerdict(message.content) || parseVerdict(message.reasoning_content || message.reasoning);
        if (verdict) return { ...verdict, screenshotsSeen: files.length, judgeUsage };
        lastReply = scrub(String(message.content || message.reasoning_content || JSON.stringify(body)).slice(0, 600));
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
      return { success: false, reason: `judge error HTTP ${res.status}: ${scrub(JSON.stringify(body).slice(0, 200))}`, judgeFailed: true, judgeUsage };
    } else {
      lastReply = scrub(JSON.stringify(body).slice(0, 300));
    }
    await sleep((cfg.retryMs || 5000) * (attempt + 1));
  }
  return { success: false, reason: "the judge gave no readable verdict", judgeFailed: true, judgeReply: lastReply, judgeUsage };
}

module.exports = { DEFAULT_JUDGE, ANTHROPIC_URL, agentEndpoint, judgeConfig, judgeRun, imageUrl, scrub };
