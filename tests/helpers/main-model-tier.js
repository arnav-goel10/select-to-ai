"use strict";
// Test-only. How main placed a model before the tier table, copied as it
// was in extension/defaults.js on main at 3d2d4f6 (the tier lines only),
// so tests/unit/model-tiers.test.js can hold the new tierOf to it. Nothing
// ships this file.

/* eslint-disable */
const FRONTIER_FAMILY = /claude-(fable|opus|sonnet)|gpt-(5|6)(?![\w.-]*(mini|nano))|gemini-[\w.-]*pro|grok-4/i;
const SMALL_WORD = /(?:^|[^a-z])(mini|nano|lite|small|haiku|ministral|tiny)(?![a-z])|openrouter\/free|(?:^|[^a-z0-9])e\d+b(?![a-z0-9])/i;
const FRONTIER_LIMITS = Object.freeze({ tier: "frontier", lines: 320, pageBudget: 24000, maxActions: 8 });
const SMALL_LIMITS = Object.freeze({ tier: "small", lines: 140, pageBudget: 8000, maxActions: 5 });
/** The largest parameter count a model's name states, in billions, or 0. */
function billionsIn(id) {
  let most = 0;
  for (const m of String(id).matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)) most = Math.max(most, parseFloat(m[1]));
  return most;
}
function limitsFor(id) {
  if (FRONTIER_FAMILY.test(id)) return FRONTIER_LIMITS;
  const size = billionsIn(id);
  // Large by its size alone: given a large model's room.
  if (size >= 200) return FRONTIER_LIMITS;
  if (size > 0) return size < 40 ? SMALL_LIMITS : STANDARD_PROFILE;
  return SMALL_WORD.test(id) ? SMALL_LIMITS : STANDARD_PROFILE;
}
const STANDARD_PROFILE = Object.freeze({ tier: "standard", lines: 220, pageBudget: 12000, maxActions: 6 });

/** The tier main gave a model id. */
function mainTier(id) {
  return limitsFor(id).tier;
}

module.exports = { mainTier };
