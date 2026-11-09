/**
 * Plugging in another model provider.
 *
 * Recipes needs one method: complete({system, user, schema}) returning
 * {json, usage}. `schema` is a JSON Schema the answer must follow; `json` is
 * the parsed answer. `usage` feeds the receipt's cost line. The same client
 * is used for repairs, the edit double-check and the meaning check.
 *
 * Below: any OpenAI-compatible chat completions endpoint with JSON-schema
 * output (OpenAI, Azure OpenAI, vLLM, Ollama, LiteLLM, ...).
 *
 *   import { openAICompatible } from "./examples/custom-model.js";
 *   await replay(page, recipe, { vars, repair: { model: openAICompatible({ model: "gpt-x-mini" }) } });
 *
 * Note: published results (docs/results-heldout-v*.md) were measured with
 * Claude Haiku 5.5 only. Measure on your own pages before trusting another model.
 */
export function openAICompatible({
  model,
  baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey = process.env.OPENAI_API_KEY,
  pricePerMTok = [0, 0],
} = {}) {
  if (!model) throw new Error("openAICompatible: pass { model }");
  return {
    name: "openai-compatible",
    model,
    async complete({ system, user, schema }) {
      const t0 = Date.now();
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
        }),
      });
      if (!res.ok) throw new Error(`model call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      const inTok = body.usage?.prompt_tokens || 0, outTok = body.usage?.completion_tokens || 0;
      const usage = { provider: "openai-compatible", model, inTok, outTok, ms: Date.now() - t0, usd: (inTok * pricePerMTok[0] + outTok * pricePerMTok[1]) / 1e6 };
      // A thrown error never lets a step through: a failed repair or check stops the run.
      return { json: JSON.parse(body.choices[0].message.content), usage };
    },
  };
}

/** The smallest possible client, for tests: always says it cannot help. */
export const neverRepairs = {
  name: "never",
  async complete({ schema }) {
    const json = schema.required.includes("patch")
      ? { patch: "cannot", ref: "", insert_action: "none", insert_key: "", insert_value: "", predicted: "", confidence: "low", why: "no model" }
      : { same: schema.properties.same.enum.includes("unsure") ? "unsure" : "no", why: "no model" };
    return { json, usage: { inTok: 0, outTok: 0, usd: 0 } };
  },
};
