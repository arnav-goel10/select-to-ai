import type { ModelClient } from "./index.js";
export type { ModelClient } from "./index.js";

/** Prices in USD per million tokens [input, output], used for receipts' cost. */
export const PRICES: Record<string, [number, number]>;

/**
 * Repair and meaning-check model on the Anthropic Messages API, with
 * structured output. Default model "claude-haiku-5-5", thinking off.
 * Reads ANTHROPIC_API_KEY from the environment unless `client` is given.
 */
export function anthropicModel(opts?: { model?: string; client?: any; thinking?: "off" | "adaptive"; maxTokens?: number }): ModelClient;
