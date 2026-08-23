/**
 * Select to AI - Browser target validation.
 *
 * The extension ships to Chromium browsers (Chrome, Edge, Brave, and any
 * other that accepts MV3 packages). This module centralizes the small
 * amount of per-target logic: display metadata and packaging variants.
 *
 * Pure functions; CommonJS-exported for Node tests.
 */
(function initTargets(root) {
  "use strict";

  const TARGETS = Object.freeze({
    chrome: {
      id: "chrome",
      name: "Chrome",
      storeName: "Chrome Web Store",
      zipName: "select-to-ai-chrome.zip",
      notes:
        "Primary target. Upload dist/select-to-ai-chrome.zip through the Chrome Web Store developer dashboard.",
    },
    edge: {
      id: "edge",
      name: "Microsoft Edge",
      storeName: "Edge Add-ons",
      zipName: "select-to-ai-edge.zip",
      notes:
        "The unpacked extension/ directory is already Edge-compatible (MV3, no Chrome-exclusive APIs beyond sidePanel, which Edge 114+ supports). Package the same source with this script and upload through Partner Center. Edge reviews typically take longer than Chrome's.",
    },
  });

  function listTargets() {
    return Object.values(TARGETS);
  }

  function getTarget(id) {
    return TARGETS[id] || null;
  }

  /**
   * Manifest-level compatibility audit for a given target. Returns an array
   * of human-readable issues (empty = compatible). Kept as data, not
   * heuristics, so it stays honest.
   */
  function checkCompatibility(targetId, manifest) {
    const issues = [];
    if (!getTarget(targetId)) return [`Unknown browser target "${targetId}".`];
    if (targetId === "edge") {
      // Everything Select to AI uses is supported by Edge 114+.
      if ((manifest.permissions || []).includes("sidePanel")) {
        issues.push(
          "sidePanel requires Edge 114+; set minimum_chrome_version accordingly.",
        );
      }
    }
    return issues;
  }

  root.SELECT_TO_AI_TARGETS = Object.freeze({
    TARGETS,
    listTargets,
    getTarget,
    checkCompatibility,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_TARGETS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
