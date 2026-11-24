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
  // A screenshot kept in memory ({name, data}): sent as it was taken.
  if (file && typeof file === "object" && file.data) return `data:image/jpeg;base64,${Buffer.from(file.data).toString("base64")}`;
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

const shotThere = (f) => (f && typeof f === "object" ? !!f.data : fs.existsSync(f));
const JUDGE_MAX_TOKENS = 8000;

/**
 * The judge's fixed instructions as a cached block: the same bytes on every
 * call, so every call after the first reads them from the cache. `ttl` "1h"
 * for a batch, whose requests can run far apart.
 */
function cachedSystem(ttl = "") {
  return [{ type: "text", text: JUDGE_SYSTEM, cache_control: ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" } }];
}

/** A provider's usage block added to a judge's running count: uncached input, cache writes and reads, output, calls. */
function addUsage(into, u = {}) {
  into.input += u.input_tokens || u.prompt_tokens || 0;
  into.output += u.output_tokens || u.completion_tokens || 0;
  into.cacheWrite = (into.cacheWrite || 0) + (u.cache_creation_input_tokens || 0);
  into.cacheRead = (into.cacheRead || 0) + (u.cache_read_input_tokens || 0);
  into.calls++;
  return into;
}

function anthropicContent(run, shots) {
  const text = judgeMessage({ ...run, screenshots: shots });
  if (!shots.length) return text;
  return [
    { type: "text", text },
    ...shots.map((f) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageUrl(f).replace(/^data:image\/jpeg;base64,/, "") } })),
  ];
}

function openAiContent(run, shots) {
  const text = judgeMessage({ ...run, screenshots: shots });
  if (!shots.length) return text;
  return [{ type: "text", text }, ...shots.map((f) => ({ type: "image_url", image_url: { url: imageUrl(f) } }))];
}

/**
 * The verdict on one run. `run.screenshots` are file paths, oldest first.
 * Returns {success, blocked, keyPoints, met, reason} or, when no verdict
 * could be had, {success: false, judgeFailed: true, reason}.
 */
async function judgeRun(run, cfg = judgeConfig()) {
  let files = cfg.vision ? pickScreenshots((run.screenshots || []).filter(shotThere), run.history, cfg.shots) : [];
  const isAnthropic = cfg.isAnthropic !== undefined ? !!cfg.isAnthropic : /(^|\.)anthropic\.com$/.test(hostOf(cfg.url));
  // Every answered call is paid for, whether or not its verdict could be read.
  const judgeUsage = { model: cfg.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
  const paid = (body) => addUsage(judgeUsage, body && body.usage);
  const contentFor = (shots) => (isAnthropic ? anthropicContent(run, shots) : openAiContent(run, shots));
  let content = contentFor(files);
  let lastReply = "";
  let degenerated = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Under a spend cap the caller says when another call would pass it (cfg.stopRetry, given what the calls so far used).
    if (judgeUsage.calls && cfg.stopRetry && cfg.stopRetry(judgeUsage)) return { success: false, reason: "the judge gave no readable verdict, and the spend cap left no room to ask again", judgeFailed: true, judgeReply: lastReply, judgeUsage };
    const endpoint = isAnthropic
      ? (/\/v1\/messages$/.test(cfg.url) ? cfg.url : `${cfg.url.replace(/\/v1$/, "")}/v1/messages`)
      : `${cfg.url}/chat/completions`;
    const headers = isAnthropic
      ? { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${cfg.key}` };
    const reqBody = isAnthropic
      // Current Claude models take no temperature but their own; they think adaptively, so the room covers thinking too.
      ? { model: cfg.model, max_tokens: JUDGE_MAX_TOKENS, system: cachedSystem(), messages: [{ role: "user", content }] }
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


// Tokens an image of at most 1024 pixels on its long side can take, and the
// judge's fixed instructions, for a reserve that is never less than a call's
// real price (Anthropic counts about one token per 750 pixels).
const IMAGE_TOKENS_AT_MOST = 1600;
const SYSTEM_TOKENS_AT_MOST = Math.ceil(JUDGE_SYSTEM.length / 2);

/**
 * The judge through Anthropic's Message Batches API, for runs whose verdict
 * can wait: half the price of a direct call, with the fixed instructions in a
 * one-hour cache block. Runs are added as they finish and sent in batches of
 * `flushEvery`; `tick` sends what is due and collects the batches that have
 * ended; `drain` waits for the rest. Each request is retried once (an errored
 * or expired request, or a reply with no readable verdict), then given up as
 * a judge failure, which the report counts as lost.
 *
 * Until its verdict is in, a run's judge call is held at `reservedUSD`: the
 * most it can cost (the fixed instructions written to the cache, the run's
 * own text and screenshots at the input price, every output token used), so
 * a spend cap that counts the reserve is never passed.
 */
class JudgeBatch {
  constructor(cfg, { flushEvery = 4, pollMs = 30000, ratesFor = null, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), tries = 2 } = {}) {
    if (!cfg.isAnthropic) throw new Error("The batch judge runs on Anthropic's endpoint only.");
    this.cfg = cfg;
    this.flushEvery = flushEvery;
    this.pollMs = pollMs;
    this.ratesFor = ratesFor;
    this.fetch = fetchImpl;
    this.now = now;
    this.tries = tries;
    this.items = new Map();
    this.pending = [];
    this.open = new Map();
    this.sendFailures = 0;
    const messages = /\/v1\/messages$/.test(cfg.url) ? cfg.url : `${cfg.url.replace(/\/v1$/, "")}/v1/messages`;
    this.batchesUrl = `${messages}/batches`;
  }

  headers() { return { "content-type": "application/json", "x-api-key": this.cfg.key, "anthropic-version": "2023-06-01" }; }

  /** The most a request can cost, in US dollars, at batch prices. */
  estimateUSD(params) {
    const [input, output] = (this.ratesFor && this.ratesFor(this.cfg.model)) || [0, 0];
    let chars = 0;
    let images = 0;
    for (const m of params.messages) for (const part of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) { if (part.type === "text") chars += String(part.text || "").length; else images++; }
    // Only the fixed instructions carry a cache mark, so only they can be written to the cache (at twice the
    // input price for one hour). The run's own text and screenshots are plain input, at the input price.
    const runTokens = Math.ceil(chars / 2) + images * IMAGE_TOKENS_AT_MOST;
    return 0.5 * ((runTokens * input) + (SYSTEM_TOKENS_AT_MOST * input * 2) + (params.max_tokens * output)) / 1000;
  }

  /** Queues one run's judging under `id` (letters, digits, _ and -). Returns the reserve it holds. */
  add(id, run) {
    const files = this.cfg.vision ? pickScreenshots((run.screenshots || []).filter(shotThere), run.history, this.cfg.shots) : [];
    const params = { model: this.cfg.model, max_tokens: JUDGE_MAX_TOKENS, system: cachedSystem("1h"), messages: [{ role: "user", content: anthropicContent(run, files) }] };
    const estimateUSD = this.estimateUSD(params);
    this.items.set(id, { params, estimateUSD, tries: 0, shots: files.length, usage: { model: this.cfg.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0, batch: true, cacheTtl: "1h" }, lastReply: "" });
    this.pending.push(id);
    return estimateUSD;
  }

  get reservedUSD() { let n = 0; for (const it of this.items.values()) n += it.estimateUSD; return n; }
  get waiting() { return this.items.size; }

  async send() {
    const ids = this.pending.splice(0);
    if (!ids.length) return;
    const body = { requests: ids.map((id) => ({ custom_id: id, params: this.items.get(id).params })) };
    const res = await this.fetch(this.batchesUrl, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok || !json.id) {
      this.pending.unshift(...ids);
      this.sendFailures++;
      this.lastError = res ? `the batch was refused, HTTP ${res.status}: ${scrub(JSON.stringify(json).slice(0, 160))}` : "the batch endpoint did not answer";
      return;
    }
    for (const id of ids) this.items.get(id).tries++;
    this.open.set(json.id, { ids, polled: this.now() });
  }

  /** What one result means: a verdict, or null when the request goes round again. */
  settleResult(id, result) {
    const it = this.items.get(id);
    if (!it) return null;
    if (result && result.type === "succeeded" && result.message) {
      addUsage(it.usage, result.message.usage);
      const text = (Array.isArray(result.message.content) ? result.message.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
      const verdict = parseVerdict(text);
      if (verdict) return { ...verdict, screenshotsSeen: it.shots, judgeUsage: it.usage };
      it.lastReply = scrub(String(text).slice(0, 600));
    } else it.lastReply = scrub(JSON.stringify(result || {}).slice(0, 300));
    if (it.tries < this.tries) { this.pending.push(id); return null; }
    return { success: false, reason: "the judge gave no readable verdict", judgeFailed: true, judgeReply: it.lastReply, judgeUsage: it.usage };
  }

  /** Sends what is due and collects every batch that has ended. Returns [{id, verdict}]. */
  async tick({ force = false } = {}) {
    if (this.pending.length && (force || this.pending.length >= this.flushEvery)) await this.send();
    const done = [];
    for (const [batchId, b] of [...this.open]) {
      if (!force && this.now() - b.polled < this.pollMs) continue;
      b.polled = this.now();
      const res = await this.fetch(`${this.batchesUrl}/${encodeURIComponent(batchId)}`, { headers: this.headers(), signal: AbortSignal.timeout(60000) }).catch(() => null);
      const info = res && res.ok ? await res.json().catch(() => ({})) : {};
      if (info.processing_status !== "ended" || !info.results_url) continue;
      const out = await this.fetch(info.results_url, { headers: this.headers(), signal: AbortSignal.timeout(120000) }).catch(() => null);
      if (!out || !out.ok) continue;
      const lines = String(await out.text().catch(() => "")).split("\n").filter((l) => l.trim());
      const seen = new Set();
      for (const line of lines) {
        let r;
        try { r = JSON.parse(line); } catch (_e) { continue; }
        if (!r || !b.ids.includes(r.custom_id)) continue;
        seen.add(r.custom_id);
        const verdict = this.settleResult(r.custom_id, r.result);
        if (verdict) { done.push({ id: r.custom_id, verdict }); this.items.delete(r.custom_id); }
      }
      // A request the results left out goes round again, as an errored one would.
      for (const id of b.ids) if (!seen.has(id)) { const verdict = this.settleResult(id, null); if (verdict) { done.push({ id, verdict }); this.items.delete(id); } }
      this.open.delete(batchId);
    }
    return done;
  }

  /** Waits for every queued verdict, up to `maxMs`; what is still out then is a judge failure. */
  async drain(maxMs, sleepMs = this.pollMs) {
    const t0 = this.now();
    const done = [];
    while (this.items.size && this.now() - t0 < maxMs) {
      done.push(...(await this.tick({ force: true })));
      if (this.items.size) await sleep(sleepMs);
    }
    for (const [id, it] of this.items) done.push({ id, verdict: { success: false, reason: `the batch judge gave no verdict in time${this.lastError ? ` (${this.lastError})` : ""}`, judgeFailed: true, judgeReply: it.lastReply, judgeUsage: it.usage } });
    this.items.clear();
    this.pending = [];
    return done;
  }
}

/**
 * Whether a capped run should wait for the verdicts still out before it
 * decides anything: when what they hold would leave less than `runRoomUSD`
 * (or nothing at all) for `needUSD` under the cap. A hold is the most a
 * verdict can cost, and it is replaced by the real price once the verdict is
 * in, so a shard decides it is over the cap only on what was really spent.
 */
function waitForHolds({ capUSD = 0, committedUSD = 0, needUSD = 0, runRoomUSD = 0, waiting = 0 } = {}) {
  if (!capUSD || !waiting) return false;
  const room = capUSD - committedUSD - needUSD;
  return !(room > 0 && room > runRoomUSD);
}

module.exports = { waitForHolds, DEFAULT_JUDGE, ANTHROPIC_URL, agentEndpoint, judgeConfig, judgeRun, imageUrl, scrub, cachedSystem, addUsage, JudgeBatch, JUDGE_MAX_TOKENS };
