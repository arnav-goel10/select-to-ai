/**
 * Select to AI - Contextual task suggestions.
 *
 * Replaces the static first-run suggestion cards with tasks derived from
 * the page the user is actually on. A tiny deterministic classifier maps
 * the active tab's URL (and, when cheaply available, its title) to three
 * concrete suggestions, so a first run is one click instead of a blank
 * prompt. No model calls, no network: the suggestions are computed locally.
 *
 * Loaded by agent.html before agent.js. Exposes
 * SELECT_TO_AI_SUGGESTIONS.buildSuggestions(url, title) for tests and
 * renderContextualSuggestions(container, onClick) for the page.
 */
(function initSuggestions(root) {
  "use strict";

  // Site-family matchers keyed by hostname fragment. Order matters: first
  // match wins. Each entry produces up to three suggestions; generic
  // fallbacks fill any remainder so the grid always shows three cards.
  const SITE_RECIPES = [
    {
      match: (host) => /(^|\.)github\.com$/.test(host) || /(^|\.)gitlab\.com$/.test(host),
      suggestions: [
        { label: "Summarize what this repository does", prompt: "Read this repository page and summarize in two sentences what it does, who it is for, and how to install or run it." },
        { label: "Explain the README setup steps", prompt: "Open the README and list the exact setup and installation steps it describes." },
        { label: "List the most used languages here", prompt: "Determine which programming languages this repository uses and what each is used for." },
      ],
    },
    {
      match: (host) => /amazon\.|ebay\.|etsy\.|aliexpress\./.test(host),
      suggestions: [
        { label: "Compare top products on this page", prompt: "Compare the visible products on this search results page on price, rating, and review count, then recommend one." },
        { label: "Find price and delivery date", prompt: "Find this product's current price and the earliest delivery date shown on the page." },
        { label: "Summarize recent reviews", prompt: "Scroll through the reviews and summarize the main compliments and complaints buyers mention." },
      ],
    },
    {
      match: (host) => /youtube\.|vimeo\.com/.test(host),
      suggestions: [
        { label: "Summarize this video from its page", prompt: "Using the title, description, and any transcript or chapters visible, summarize what this video covers." },
        { label: "List the chapter timestamps", prompt: "Extract the chapter list with timestamps if the page shows one." },
        { label: "Find related videos on this topic", prompt: "Find three other highly-viewed videos on the same topic and note their view counts." },
      ],
    },
    {
      match: (host) => /linkedin\.com/.test(host),
      suggestions: [
        { label: "Summarize this profile", prompt: "Summarize this LinkedIn profile: current role, background, and notable experience." },
        { label: "Draft a connection note", prompt: "Based on this profile, draft a short, specific connection request note under 300 characters." },
        { label: "List open roles at this company", prompt: "Check this company's jobs page for open roles relevant to software engineering and list them." },
      ],
    },
    {
      match: (host) => /wikipedia\.org/.test(host),
      suggestions: [
        { label: "Give me a two-minute summary", prompt: "Summarize this Wikipedia article in plain language in about 150 words." },
        { label: "Extract key facts as a list", prompt: "Extract the key facts from this article as a short bulleted list." },
        { label: "Trace the timeline of events", prompt: "Build a chronological timeline of the events described in this article." },
      ],
    },
    {
      match: (host) => /docs\.|developer\.|documentation/.test(host) || /\.dev$/.test(host),
      suggestions: [
        { label: "Summarize this documentation", prompt: "Summarize what this documentation page explains and list the main API methods or concepts it covers." },
        { label: "Show a minimal working example", prompt: "Find the minimal working code example on this page and explain what each part does." },
        { label: "List requirements and prerequisites", prompt: "List every requirement, prerequisite, and version constraint mentioned on this page." },
      ],
    },
    {
      match: (host) => /stackoverflow\.com/.test(host),
      suggestions: [
        { label: "Extract the accepted answer", prompt: "Find the accepted answer on this page and summarize the fix it proposes step by step." },
        { label: "Compare the top answers", prompt: "Compare the top two answers and say which approach is better and why." },
        { label: "List the code snippets", prompt: "Extract every code snippet on this page with a one-line explanation of each." },
      ],
    },
    {
      match: (host) => /news\.|\.news|bbc\.|cnn\.|reuters\.|straitstimes\.com/.test(host),
      suggestions: [
        { label: "Summarize these headlines", prompt: "Summarize the top headlines currently visible on this page in one line each." },
        { label: "Deep-dive the lead story", prompt: "Open the lead story, read it, and give me the key facts: who, what, where, when, and why it matters." },
        { label: "Find different coverage", prompt: "Find how two other news outlets cover this same story and compare their angles." },
      ],
    },
  ];

  // Generic fallbacks that work on any site, ordered by usefulness.
  const GENERIC_SUGGESTIONS = [
    { label: "Summarize this page", prompt: "Read the page and summarize it in three sentences, ending with the single most useful takeaway." },
    { label: "Extract the key data", prompt: "Extract the structured information on this page (names, prices, dates, contacts, or whatever applies) as a clean list." },
    { label: "Answer a question using this page", prompt: "Read this page carefully, then answer: what problem does this page solve and how do I use it?" },
    { label: "Find the contact or support info", prompt: "Find contact information, support channels, or office locations mentioned on this page." },
    { label: "Compare items across this page", prompt: "Identify the things being listed or compared on this page and build a small comparison table." },
  ];

  function hostnameOf(url) {
    try {
      return new URL(String(url || "")).hostname.toLowerCase();
    } catch (_err) {
      return "";
    }
  }

  /**
   * Returns exactly three suggestions ({label, prompt}) for the given URL
   * and optional page title. Site-specific recipes take priority; generic
   * fallbacks pad to three. Deterministic: same input, same output.
   */
  function buildSuggestions(url, _title) {
    const host = hostnameOf(url);
    let picked = [];
    if (host && !/^(newtab|about|chrome)/.test(host)) {
      for (const recipe of SITE_RECIPES) {
        if (recipe.match(host)) {
          picked = recipe.suggestions.slice();
          break;
        }
      }
    }
    for (const generic of GENERIC_SUGGESTIONS) {
      if (picked.length >= 3) break;
      picked.push(generic);
    }
    return picked.slice(0, 3).map((s) => ({ label: s.label, prompt: s.prompt }));
  }

  /**
   * Renders suggestion cards into the container (the welcome screen's
   * existing suggestions grid). onClick(prompt) runs for a click.
   */
  function renderContextualSuggestions(container, onClick) {
    if (!container) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      const suggestions = buildSuggestions(tab ? tab.url : "", tab ? tab.title : "");
      container.innerHTML = "";
      suggestions.forEach((suggestion) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "suggestion-card";
        card.setAttribute("data-prompt", suggestion.prompt);
        const span = document.createElement("span");
        span.className = "suggestion-label";
        span.textContent = `"${suggestion.label}..."`;
        card.appendChild(span);
        card.addEventListener("click", () => onClick(suggestion.prompt));
        container.appendChild(card);
      });
    });
  }

  root.SELECT_TO_AI_SUGGESTIONS = Object.freeze({
    buildSuggestions,
    renderContextualSuggestions,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECT_TO_AI_SUGGESTIONS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
