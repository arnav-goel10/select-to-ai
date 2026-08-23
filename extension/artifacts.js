/**
 * Select to AI - Artifacts.
 *
 * Turns structured agent output into downloadable artifacts: markdown
 * tables and JSON arrays extracted from a final answer become CSV files
 * the user can save with one click. Pure functions only; DOM helpers
 * take injected callbacks so they stay testable.
 *
 * Loaded by agent.html before agent.js. Exposes SELECT_TO_AI_ARTIFACTS;
 * also CommonJS-exported for Node tests.
 */
(function initArtifacts(root) {
  "use strict";

  /** Escapes a CSV cell: quotes cells containing separators/quotes/newlines. */
  function csvCell(value) {
    const text = String(value ?? "");
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  /**
   * Converts rows (array of arrays or array of flat objects) to CSV text.
   * Object rows get a header line from the union of keys in first-seen
   * order; array rows are emitted as-is.
   */
  function rowsToCsv(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return "";
    if (rows.every((row) => Array.isArray(row))) {
      return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    }
    const headers = [];
    for (const row of rows) {
      if (row && typeof row === "object") {
        for (const key of Object.keys(row)) {
          if (!headers.includes(key)) headers.push(key);
        }
      }
    }
    if (headers.length === 0) return "";
    const lines = [headers.map(csvCell).join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => csvCell(row[h])).join(","));
    }
    return lines.join("\r\n");
  }

  /**
   * Extracts artifact-worthy structures from an answer's markdown:
   * - tables: consecutive | ... | lines with a --- separator row
   * - json arrays: fenced ```json blocks whose root is an array of objects
   * Returns [{kind:"table"|"json", title, rows, csv}].
   */
  function extractArtifacts(answerText) {
    const artifacts = [];
    const text = String(answerText || "");
    if (!text.trim()) return artifacts;

    // Markdown tables: header row, |---| separator, then body rows.
    const tableRe = /(?:^\|.*\|\s*$\n?)+/gm;
    let match;
    while ((match = tableRe.exec(text)) !== null) {
      const block = match[0].trim();
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const splitRow = (line) =>
        line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const separator = lines[1];
      if (!/^\|?[\s:-]+\|[\s:|-]*$/.test(separator) || !separator.includes("-")) continue;
      const headers = splitRow(lines[0]);
      if (headers.length === 0 || !headers.some(Boolean)) continue;
      const rows = [headers];
      for (const line of lines.slice(2)) {
        const cells = splitRow(line);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
      }
      if (rows.length >= 2) {
        // Title from the nearest preceding bold/heading line, else generic.
        const before = text.slice(0, match.index);
        const titleMatch = [...before.matchAll(/\*\*(.+?)\*\*|^#{1,6}\s*(.+)$/gm)].pop();
        const title = titleMatch
          ? (titleMatch[1] || titleMatch[2] || "Table").trim()
          : "Table";
        artifacts.push({
          kind: "table",
          title: title.slice(0, 60),
          rows,
          csv: rowsToCsv(rows),
        });
      }
    }

    // Fenced JSON arrays of objects.
    const fenceRe = /```json\s*([\s\S]*?)```/g;
    let jsonIndex = 0;
    while ((match = fenceRe.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed) && parsed.length && parsed.every((p) => p && typeof p === "object" && !Array.isArray(p))) {
          jsonIndex += 1;
          artifacts.push({
            kind: "json",
            title: `Data ${jsonIndex}`,
            rows: parsed,
            csv: rowsToCsv(parsed),
          });
        }
      } catch (_err) {
        // Not valid JSON; skip.
      }
    }

    return artifacts;
  }

  /**
   * Renders download buttons under an answer bubble. injects via callbacks
   * so tests can verify wiring without a DOM.
   * makeButton(labelText, onClick) must create+append a button and return it.
   */
  function renderArtifactButtons(artifacts, answerText, makeButton) {
    let count = 0;
    artifacts.forEach((artifact, index) => {
      if (!artifact.csv) return;
      count += 1;
      const label = `Download ${artifact.kind === "json" ? "data" : "table"} as CSV${count > 1 ? ` (${count})` : ""}`;
      makeButton(label, () => {
        const blob = new Blob([artifact.csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${slugify(artifact.title) || "artifact"}-${index + 1}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    });
    return count;
  }

  function slugify(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  root.SELECT_TO_AI_ARTIFACTS = Object.freeze({
    csvCell,
    rowsToCsv,
    extractArtifacts,
    renderArtifactButtons,
    slugify,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_ARTIFACTS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
