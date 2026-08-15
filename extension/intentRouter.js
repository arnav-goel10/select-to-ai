/**
 * Omnibox intent router shared by the extension service worker and Node.js tests.
 * Classifies what the user typed after the "ai" keyword into one of three intents:
 *   navigate - they named a site and want to go there
 *   ask      - they want an answer from the AI
 *   agent    - they want the browser agent to do something
 * Keep this module dependency-free so the same routing runs in production and tests.
 */
(function initIntentRouter(root) {
  "use strict";

  // Sites people type as a single bare word expecting navigation.
  const KNOWN_SITES = {
    google: "https://www.google.com",
    youtube: "https://www.youtube.com",
    gmail: "https://mail.google.com",
    github: "https://github.com",
    reddit: "https://www.reddit.com",
    twitter: "https://x.com",
    x: "https://x.com",
    linkedin: "https://www.linkedin.com",
    facebook: "https://www.facebook.com",
    instagram: "https://www.instagram.com",
    netflix: "https://www.netflix.com",
    amazon: "https://www.amazon.com",
    spotify: "https://open.spotify.com",
    chatgpt: "https://chatgpt.com",
    claude: "https://claude.ai",
    gemini: "https://gemini.google.com",
    perplexity: "https://www.perplexity.ai",
    wikipedia: "https://www.wikipedia.org",
    stackoverflow: "https://stackoverflow.com",
    maps: "https://maps.google.com",
    drive: "https://drive.google.com",
    docs: "https://docs.google.com",
    notion: "https://www.notion.so",
    figma: "https://www.figma.com",
    twitch: "https://www.twitch.tv",
  };

  const NAV_PREFIXES = /^(?:go to|goto|go|open|visit)\s+/i;
  const ASK_PREFIXES = /^(?:ask|a:|\?)\s+/i;
  const AGENT_PREFIXES = /^(?:do|agent|task)\s*:?\s+/i;

  const INTERROGATIVE = /^(?:who|what|when|where|why|how|which|whose|is|are|was|were|can|could|do|does|did|should|would|will|explain|define|tell me|give me|write|translate|convert|calculate)\b/i;

  const PAGE_CONTEXT = /\b(?:this (?:page|tab|site|article)|current (?:page|tab)|these tabs|my tabs|the page|open tabs)\b/i;

  const AGENT_VERBS = /^(?:click|fill|submit|book|buy|order|purchase|add|remove|delete|clear|play|pause|download|upload|log ?in|log ?out|sign (?:in|up|out)|search|look up|find|compare|extract|scrape|collect|summarize|summarise|scroll|close|switch|refresh|reload|draft|post|reply|send|apply|checkout|star|follow|subscribe|unsubscribe|watch|mute|like|save|bookmark|navigate)\b/i;

  const CONJUNCTION = /\b(?:and then|then|and)\b/i;

  function normalizeNavigationUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || /\s/.test(raw)) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      if (url.username || url.password) return null;
      const host = url.hostname;
      const isLoopback = host === "localhost" || host === "127.0.0.1";
      const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
      const hasTld = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host);
      if (!isLoopback && !isIp && !hasTld) return null;
      return url.toString();
    } catch (_error) {
      return null;
    }
  }

  function knownSiteUrl(word) {
    return KNOWN_SITES[String(word || "").toLowerCase()] || null;
  }

  function result(intent, extras) {
    return Object.assign({ intent }, extras);
  }

  function classifyOmniboxInput(rawInput) {
    const text = String(rawInput || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return result("ask", { query: "", confidence: "low", reason: "empty input" });
    }

    // 1. Explicit overrides always win, so every intent stays one prefix away.
    const askMatch = text.match(ASK_PREFIXES);
    if (askMatch) {
      return result("ask", {
        query: text.slice(askMatch[0].length).trim() || text,
        confidence: "high",
        reason: "explicit ask prefix",
      });
    }
    const agentMatch = text.match(AGENT_PREFIXES);
    if (agentMatch) {
      return result("agent", {
        query: text.slice(agentMatch[0].length).trim() || text,
        confidence: "high",
        reason: "explicit agent prefix",
      });
    }

    // 2. Navigation: a URL-shaped input, optionally behind go/open/visit.
    const navMatch = text.match(NAV_PREFIXES);
    const navRemainder = navMatch ? text.slice(navMatch[0].length).trim() : text;
    const singleToken = !/\s/.test(navRemainder);
    if (singleToken) {
      const direct = normalizeNavigationUrl(navRemainder) || knownSiteUrl(navRemainder);
      if (direct) {
        return result("navigate", {
          url: direct,
          query: navRemainder,
          confidence: "high",
          reason: navMatch ? "navigation prefix with site" : "input is a site",
        });
      }
    }

    // 3. Anything about the current page or open tabs is browser work.
    if (PAGE_CONTEXT.test(text)) {
      return result("agent", {
        query: text,
        confidence: "high",
        reason: "refers to the page or tabs",
      });
    }

    // 4. Questions go to the AI.
    if (/\?$/.test(text)) {
      return result("ask", { query: text, confidence: "high", reason: "ends with a question mark" });
    }
    if (INTERROGATIVE.test(text)) {
      return result("ask", { query: text, confidence: "medium", reason: "reads as a question" });
    }

    // 5. Imperatives aimed at the browser go to the agent.
    if (navMatch) {
      // "open youtube and play lofi" style: navigation verb but a real task after it.
      return result("agent", {
        query: text,
        confidence: "medium",
        reason: "navigation verb with a task after it",
      });
    }
    if (AGENT_VERBS.test(text)) {
      if (/^find out\b/i.test(text)) {
        return result("ask", { query: text, confidence: "medium", reason: "find out reads as a question" });
      }
      const multiStep = CONJUNCTION.test(text) || /\bon\s+[a-z0-9.-]+/i.test(text);
      return result("agent", {
        query: text,
        confidence: multiStep ? "high" : "medium",
        reason: multiStep ? "imperative with steps or a target site" : "imperative verb",
      });
    }

    // 6. Everything else is a request for an answer.
    return result("ask", { query: text, confidence: "low", reason: "no navigation or action signal" });
  }

  const api = Object.freeze({
    KNOWN_SITES,
    classifyOmniboxInput,
    normalizeNavigationUrl,
  });

  root.SELECT_TO_AI_INTENT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
