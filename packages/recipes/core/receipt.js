/**
 * Receipts (design §5): what a run did, how each step was found, what each
 * check observed, what was repaired, and whether "done" is proven. The word
 * "Done" is used only for `done_proven`. Pure functions.
 */
import { fill, clip } from "./text.js";
import { describePredicate } from "./post.js";

/**
 * Build a receipt from a finished replay state.
 * @param {object} state
 */
export function fromReplay(state) {
  const r = state.recipe;
  const shown = { ...state.bindings };
  for (const v of r.variables || []) if (v.type === "secret" && v.name in shown) shown[v.name] = "(secret)";
  const vars = (r.variables || []).map((v) => ({ name: v.name, shown: v.type === "secret" ? "(secret)" : v.type === "profile" ? `your ${v.profileKey || v.name} on file` : (state.bindings[v.name] ?? "") }));
  const proofItems = [];
  if (state.end.state === "done_proven") {
    for (const x of state.doneResults || []) proofItems.push({ what: describePredicate(x.pred, shown), quote: x.observed, url: state.lastSnap && state.lastSnap.url });
    for (const [name, value] of Object.entries(state.extracts)) proofItems.push({ what: `read ${name}`, quote: value });
    for (const d of state.downloads) proofItems.push({ what: `downloaded ${d.name}`, quote: `${d.bytes} bytes, sha256 ${String(d.sha256 || "").slice(0, 16)}` });
  }
  const answer = r.result && r.result.answer ? fill(r.result.answer, { ...shown, ...state.extracts }) : (Object.keys(state.extracts).length ? Object.values(state.extracts).join("\n") : undefined);
  return {
    id: state.id,
    kind: "replay",
    recipeId: r.id,
    recipeVersion: r.versions && r.versions[r.active] ? r.versions[r.active].v : 1,
    startedAt: state.startedAt,
    endedAt: state.end.at,
    request: fill(r.title, shown),
    variables: vars,
    steps: state.log.map((x) => ({ ...x })),
    repairs: state.repairs.map((x) => ({ ...x })),
    end: {
      state: state.end.state,
      proof: { kind: state.end.state === "done_proven" ? "postconditions" : "none", items: proofItems },
      why: state.end.why,
    },
    healed: state.repairs.some((x) => x.status === "persisted"),
    answer,
    extracts: { ...state.extracts },
    downloads: state.downloads.map((d) => ({ name: d.name, bytes: d.bytes, sha256: d.sha256, path: d.path })),
    cost: { modelCalls: state.cost.modelCalls, promptTokens: state.cost.inTok, completionTokens: state.cost.outTok, usd: round6(state.cost.usd), models: [...state.cost.models] },
    checks: { drift: state.checks ? state.checks.drift : 0 },
    drift: state.drift.map((d) => ({ ...d })),
    trace: [...state.trace],
  };
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }

/**
 * One line a person reads first. "Done" only for done_proven.
 * @param {object} receipt
 */
export function headline(receipt) {
  const e = receipt.end;
  switch (e.state) {
    case "done_proven": return `Done: ${receipt.request}${receipt.healed ? " (repaired, please review)" : ""}`;
    case "done_unproven": return `Finished, but I couldn't confirm it worked: ${e.why}`;
    case "needs_you": return `Needs you: ${e.why}`;
    case "stopped": return `Stopped: ${e.why}`;
    case "failed": return `Failed: ${e.why}`;
    default: return `Ended (${e.state}): ${e.why}`;
  }
}

/** The receipt as Markdown. */
export function toMarkdown(receipt) {
  const out = [];
  out.push(`# ${headline(receipt)}`);
  out.push("");
  out.push(`Recipe ${receipt.recipeId} v${receipt.recipeVersion}. Receipt ${receipt.id}.`);
  if (receipt.variables.length) out.push(`Values: ${receipt.variables.map((v) => `${v.name} = "${clip(v.shown, 60)}"`).join(", ")}`);
  out.push("");
  out.push("| # | Step | Found by | Score | Margin | Check | Status |");
  out.push("|---|---|---|---|---|---|---|");
  for (const s of receipt.steps) {
    const found = s.resolution ? s.resolution.method : "-";
    const check = s.post.length ? s.post.map((p) => `${p.held ? "ok" : "FAIL"} ${p.predicate}`).join(", ") : "-";
    out.push(`| ${s.n} | ${esc(s.intent)}: ${esc(s.action)}${s.target ? ` ("${esc(s.target)}")` : ""} | ${found} | ${s.resolution ? s.resolution.score : "-"} | ${s.resolution ? s.resolution.margin : "-"} | ${check} | ${s.status} |`);
  }
  if (receipt.repairs.length) {
    out.push("");
    out.push("## Repairs");
    for (const r of receipt.repairs) out.push(`- step ${r.step}, ${r.patch}: ${r.status}${r.review ? " (please review)" : ""}. ${esc(r.diffText || "")}${r.why ? ` Why: ${esc(r.why)}` : ""}`);
  }
  out.push("");
  out.push("## Proof");
  if (receipt.end.proof.items.length) for (const p of receipt.end.proof.items) out.push(`- ${p.what}${p.quote ? `: "${esc(clip(p.quote, 120))}"` : ""}`);
  else out.push(`- none: ${receipt.end.why}`);
  if (receipt.answer) { out.push(""); out.push(`Answer: ${receipt.answer}`); }
  out.push("");
  out.push(`Cost: ${receipt.cost.modelCalls} model calls, ${receipt.cost.promptTokens}+${receipt.cost.completionTokens} tokens, $${receipt.cost.usd}.`);
  return out.join("\n");
}

function esc(t) { return String(t == null ? "" : t).replace(/\|/g, "\\|").replace(/\n/g, " "); }
