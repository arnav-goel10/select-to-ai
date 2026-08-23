/**
 * Select to AI - Playbooks.
 *
 * Shareable, versioned task templates: the community flywheel. A playbook
 * is a JSON object {schemaVersion, id, name, description, category,
 * task} where `task` is a full agent prompt (optionally with {input}
 * placeholders the user fills before running).
 *
 * Pure validation/normalization + a bundled starter gallery. Exposes
 * SELECT_TO_AI_PLAYBOOKS; also CommonJS-exported for Node tests.
 */
(function initPlaybooks(root) {
  "use strict";

  const SCHEMA_VERSION = 1;

  /** The bundled starter gallery: concrete, honest, broadly useful tasks. */
  const BUNDLED = Object.freeze([
    {
      schemaVersion: 1,
      id: "competitor-price-scan",
      name: "Competitor price scan",
      description: "Find {input} prices across two retail sites and report the cheapest with evidence.",
      category: "Research",
      task: "Search the web for '{input}' price on two different major retail sites (for example Amazon and Walmart, or their local equivalents). Open each product page, note the current price and stock status, then finish with a short comparison: which site is cheaper, by how much, and quote the exact price text you saw on each page as evidence.",
    },
    {
      schemaVersion: 1,
      id: "page-fact-extractor",
      name: "Page fact extractor",
      description: "Pull every key fact from the current-style page into a clean list.",
      category: "Productivity",
      task: "Open the page I describe and extract its key facts (names, numbers, dates, contacts) into a compact labeled list. If the page has a table, reproduce it exactly. Page or topic: {input}",
    },
    {
      schemaVersion: 1,
      id: "job-application-tracker",
      name: "Job application tracker",
      description: "Turn a careers page into a structured table of open roles.",
      category: "Career",
      task: "Navigate to this careers page: {input}. List every open role in a markdown table with columns Role | Location | Team | Apply link URL. Include only roles visible after dismissing any cookie banners; scroll until you have covered all listings.",
    },
    {
      schemaVersion: 1,
      id: "recipe-shopper",
      name: "Recipe to shopping list",
      description: "Convert a recipe page into an aisle-organized grocery list.",
      category: "Home",
      task: "Open this recipe page: {input}. Extract every ingredient with quantity, then produce a single consolidated shopping list grouped by store aisle (produce, dairy, meat, pantry, other), merging duplicates. Note servings so quantities can be scaled.",
    },
    {
      schemaVersion: 1,
      id: "news-briefing",
      name: "Topic news briefing",
      description: "Five-line briefing on any topic from live news results.",
      category: "Research",
      task: "Search news sites for recent coverage of: {input}. Read the top three distinct articles, then give me a five-line briefing: what happened, who is involved, why it matters, what is disputed (if anything), and what to watch next. Cite which outlet each line came from.",
    },
    {
      schemaVersion: 1,
      id: "flight-options",
      name: "Flight options scan",
      description: "Compare flight options for a route and date window.",
      category: "Travel",
      task: "Search for flights {input}. Compare at least three options across total travel time, number of stops, and price. Finish with a recommendation for someone prioritizing arrival time over price savings under 10%.",
    },
  ]);

  /**
   * Validates and normalizes a playbook (e.g. from an imported file).
   * Returns {ok, playbook|error}.
   */
  function normalizePlaybook(input) {
    if (!input || typeof input !== "object") {
      return { ok: false, error: "A playbook must be a JSON object." };
    }
    if (input.schemaVersion !== SCHEMA_VERSION) {
      return {
        ok: false,
        error: `Unsupported schemaVersion ${JSON.stringify(input.schemaVersion)}; expected ${SCHEMA_VERSION}.`,
      };
    }
    const id = String(input.id || "").trim().slice(0, 64);
    const name = String(input.name || "").trim().slice(0, 80);
    const task = String(input.task || "").trim().slice(0, 4000);
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      return { ok: false, error: "Playbook id must be kebab-case (letters, digits, dashes)." };
    }
    if (!name) return { ok: false, error: "A playbook needs a name." };
    if (!task) return { ok: false, error: "A playbook needs a task." };
    return {
      ok: true,
      playbook: {
        schemaVersion: SCHEMA_VERSION,
        id,
        name,
        description: String(input.description || "").trim().slice(0, 200),
        category: String(input.category || "General").trim().slice(0, 40) || "General",
        task,
      },
    };
  }

  /**
   * Substitutes {input} placeholders. Missing user input leaves the
   * placeholder intact so the model can ask rather than guess.
   */
  function renderTask(playbook, userInput) {
    const value = String(userInput ?? "").trim();
    return String(playbook.task).replaceAll("{input}", value || "{input}");
  }

  root.SELECT_TO_AI_PLAYBOOKS = Object.freeze({
    SCHEMA_VERSION,
    BUNDLED,
    normalizePlaybook,
    renderTask,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_PLAYBOOKS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
