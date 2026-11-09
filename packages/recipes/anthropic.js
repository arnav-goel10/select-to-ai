/**
 * A model client for repair on the Anthropic Messages API, through the
 * official SDK. Returns the model's patch as JSON (structured output), with
 * token usage and an estimated cost.
 */

/** USD per million tokens (input, output), prompts up to 100K tokens. */
export const PRICES = {
  "claude-haiku-5-5": [0.10, 0.50],
  "claude-sonnet-5-5": [2.00, 10.00],
  "claude-opus-5-5": [4.00, 20.00],
};

/**
 * @param {object} [opts]
 * @param {string} [opts.model]  default "claude-haiku-5-5"
 * @param {object} [opts.client]  an Anthropic SDK client; one is made from the environment if absent
 * @param {"off"|"adaptive"} [opts.thinking]  default "off": repair is a short, contract-bound choice
 * @param {number} [opts.maxTokens]
 * @returns {{name:string, model:string, complete:(req:{system:string,user:string,schema:object,image?:string})=>Promise<{json:any, usage:object}>}}
 */
export function anthropicModel(opts = {}) {
  const model = opts.model || "claude-haiku-5-5";
  let client = opts.client || null;
  const thinking = opts.thinking || "off";
  return {
    name: "anthropic",
    model,
    async complete(req) {
      if (!client) {
        const mod = await import("@anthropic-ai/sdk");
        const Anthropic = mod.default || mod.Anthropic;
        client = new Anthropic();
      }
      const content = [];
      if (req.image) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: req.image } });
      content.push({ type: "text", text: req.user });
      const params = {
        model,
        max_tokens: opts.maxTokens || 2000,
        system: req.system,
        messages: [{ role: "user", content }],
        output_config: { format: { type: "json_schema", schema: req.schema } },
      };
      // (Haiku 5.5 does not take a temperature; checks rely on the prompt.)
      if (thinking === "off") params.thinking = { type: "disabled" };
      else params.thinking = { type: "adaptive" };
      const t0 = Date.now();
      const res = await client.messages.create(params);
      const ms = Date.now() - t0;
      const inTok = res.usage ? (res.usage.input_tokens || 0) + (res.usage.cache_read_input_tokens || 0) + (res.usage.cache_creation_input_tokens || 0) : 0;
      const outTok = res.usage ? res.usage.output_tokens || 0 : 0;
      const price = PRICES[model] || [0, 0];
      const usage = { provider: "anthropic", model, inTok, outTok, ms, usd: (inTok * price[0] + outTok * price[1]) / 1e6 };
      if (res.stop_reason === "refusal") throw Object.assign(new Error("the model declined the request"), { usage });
      const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      let json;
      try { json = JSON.parse(text); } catch { throw Object.assign(new Error(`the model's answer was not JSON: ${text.slice(0, 200)}`), { usage }); }
      return { json, usage };
    },
  };
}
