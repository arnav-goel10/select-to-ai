// Metrics, markdown report and the coverage-vs-false-heal SVG.

export const PRICES = {
  // USD per million tokens [input, output]
  "anthropic:claude-haiku-5-5": [0.1, 0.5],
  "anthropic:claude-sonnet-5-5": [2, 10],
  "anthropic:claude-opus-5-5": [4, 20],
};

export function priceCalls(calls) {
  let usd = 0;
  let unpriced = 0;
  for (const c of calls) {
    const p = PRICES[`${c.provider}:${c.model}`];
    if (!p) unpriced++;
    else usd += (c.inTok * p[0] + c.outTok * p[1]) / 1e6;
  }
  return { usd, unpriced };
}

// Wilson 95% interval.
export function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

const rate = (rows, pred) => {
  const k = rows.filter(pred).length;
  return { k, n: rows.length, rate: rows.length ? k / rows.length : null, ci: wilson(k, rows.length) };
};

export const cellKey = (r) => `${r.task}|${r.mutation || "none"}|${r.varIdx}`;

/**
 * rows: one per run. baseline: Map cellKey -> reference-replay row (defines
 * which mutated cells actually break a no-repair replay).
 */
export function summarize(rows, baseline) {
  const unmut = rows.filter((r) => !r.mutation);
  const mutated = rows.filter((r) => r.mutation);
  const rep = mutated.filter((r) => r.expected === "repairable");
  const stop = mutated.filter((r) => r.expected === "must-stop");
  const breaking = rep.filter((r) => baseline.get(cellKey(r)) && !baseline.get(cellKey(r)).truthOk);
  const healed = rows.filter((r) => r.healed);
  const cost = rows.reduce((a, r) => a + r.usd, 0);
  return {
    runs: rows.length,
    successUnmutated: rate(unmut, (r) => r.truthOk),
    successRepairable: rate(rep, (r) => r.truthOk),
    repairCoverage: rate(breaking, (r) => r.truthOk),
    correctStop: rate(stop, (r) => r.truthOk),
    successAllMutated: rate(mutated, (r) => r.truthOk),
    healedRuns: healed.length,
    falseHealRate: rate(healed, (r) => r.falseHeal),
    falseHealsPerMutatedRun: rate(mutated, (r) => r.falseHeal),
    falseDoneRate: rate(rows, (r) => r.falseDone),
    falseDoneMutated: rate(mutated, (r) => r.falseDone),
    wrongActionRate: rate(rows, (r) => r.wrongAction),
    wrongActionCommit: rate(rows.filter((r) => r.reversibility === "commit"), (r) => r.wrongAction),
    modelFree: rate(rows, (r) => r.calls === 0),
    usdTotal: cost,
    usdPerRun: rows.length ? cost / rows.length : 0,
    secPerRun: rows.length ? rows.reduce((a, r) => a + r.ms, 0) / rows.length / 1000 : 0,
    modelCalls: rows.reduce((a, r) => a + r.calls, 0),
    tokensIn: rows.reduce((a, r) => a + r.tokIn, 0),
    tokensOut: rows.reduce((a, r) => a + r.tokOut, 0),
  };
}

const pct = (x) => (x.rate == null ? "n/a" : `${(x.rate * 100).toFixed(1)}% (${x.k}/${x.n})`);
const pctCI = (x) => (x.rate == null ? "n/a" : `${(x.rate * 100).toFixed(1)}% [${(x.ci[0] * 100).toFixed(0)}-${(x.ci[1] * 100).toFixed(0)}] (${x.k}/${x.n})`);

export function adapterTable(summaries) {
  const lines = [
    "| Adapter | Success, unmutated | Success, repairable mutations | Repair coverage (breaking cells) | Correct stop (must-stop) | False-heal rate (of heals) | False heals / mutated run | False-done rate | Wrong-action rate | Model-free | $/run | s/run |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, s] of summaries) {
    lines.push(
      `| ${name} | ${pctCI(s.successUnmutated)} | ${pctCI(s.successRepairable)} | ${pctCI(s.repairCoverage)} | ${pctCI(s.correctStop)} | ${s.healedRuns ? pct(s.falseHealRate) : "no heals"} | ${pct(s.falseHealsPerMutatedRun)} | ${pct(s.falseDoneRate)} | ${pct(s.wrongActionRate)} | ${pct(s.modelFree)} | ${s.usdPerRun.toFixed(5)} | ${s.secPerRun.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

export function familyTable(rows, adapters, label = (f) => f) {
  const fams = [...new Set(rows.filter((r) => r.mutation).map((r) => `${r.family}|${r.expected}`))].sort();
  const head = `| Family | Expected | ${adapters.join(" | ")} |\n|---|---|${adapters.map(() => "---").join("|")}|`;
  const body = fams.map((fe) => {
    const [fam, exp] = fe.split("|");
    const cells = adapters.map((a) => {
      const rs = rows.filter((r) => r.adapter === a && r.family === fam && r.expected === exp);
      const ok = rs.filter((r) => r.truthOk).length;
      const fh = rs.filter((r) => r.falseHeal).length;
      const wa = rs.filter((r) => r.wrongAction).length;
      return rs.length ? `${ok}/${rs.length}${wa ? ` wa${wa}` : ""}${fh ? ` fh${fh}` : ""}` : "-";
    });
    return `| ${label(fam)} | ${exp} | ${cells.join(" | ")} |`;
  });
  return [head, ...body].join("\n");
}

const COLORS = ["#2d64d8", "#d8572d", "#2a9d5c", "#8e44ad", "#c0392b", "#16a085", "#7f8c8d", "#b8860b"];

// Coverage (y) against false heals per mutated run (x). One point per adapter
// configuration; configurations of the same system (name before "(") are
// joined into a curve, ordered by false-heal rate.
export function curveSvg(summaries, title) {
  const W = 640, H = 420, L = 70, R = 190, T = 40, B = 60;
  const pts = summaries.map(([name, s]) => ({ name, sys: name.split("(")[0], x: s.falseHealsPerMutatedRun.rate ?? 0, y: s.repairCoverage.rate ?? 0 }));
  const xmax = Math.max(0.05, ...pts.map((p) => p.x)) * 1.15;
  const sx = (x) => L + (x / xmax) * (W - L - R);
  const sy = (y) => H - B - y * (H - T - B);
  const systems = [...new Set(pts.map((p) => p.sys))];
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="12">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<text x="${L}" y="22" font-size="14" font-weight="600">${title}</text>`,
    `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#333"/>`,
    `<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#333"/>`,
  ];
  for (let i = 0; i <= 5; i++) {
    const y = i / 5;
    out.push(`<line x1="${L - 4}" y1="${sy(y)}" x2="${W - R}" y2="${sy(y)}" stroke="#eee"/><text x="${L - 8}" y="${sy(y) + 4}" text-anchor="end">${(y * 100).toFixed(0)}%</text>`);
    const x = (xmax * i) / 5;
    out.push(`<text x="${sx(x)}" y="${H - B + 18}" text-anchor="middle">${(x * 100).toFixed(1)}%</text>`);
  }
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 18}" text-anchor="middle">False heals per mutated run (wrong action or false done after a heal)</text>`);
  out.push(`<text transform="translate(18 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">Repair coverage (breaking cells)</text>`);
  systems.forEach((sys, i) => {
    const c = COLORS[i % COLORS.length];
    const ps = pts.filter((p) => p.sys === sys).sort((a, b) => a.x - b.x);
    if (ps.length > 1) out.push(`<polyline fill="none" stroke="${c}" stroke-width="2" points="${ps.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}"/>`);
    for (const p of ps) out.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="5" fill="${c}"><title>${p.name}: coverage ${(p.y * 100).toFixed(1)}%, false heals ${(p.x * 100).toFixed(2)}%</title></circle>`);
    out.push(`<circle cx="${W - R + 16}" cy="${T + 10 + i * 18}" r="5" fill="${c}"/><text x="${W - R + 26}" y="${T + 14 + i * 18}">${sys}</text>`);
  });
  out.push("</svg>");
  return out.join("\n");
}
