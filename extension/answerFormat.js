/**
 * Answer rendering for the agent page: Markdown to HTML, escaping every text
 * run before it becomes HTML, so model text cannot inject markup.
 */
(function initAnswerFormat(root) {
  "use strict";

  // -------------------------------------------------------------------------
  // Markdown -> safe HTML. Every text run is escaped before it becomes HTML.
  // -------------------------------------------------------------------------

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safeUrl(url) {
    return /^https?:\/\//i.test(url) ? url : "";
  }

  function inlineHtml(text, citeLookup) {
    let s = esc(text);
    // Code spans are lifted out first so their contents are not re-formatted.
    // The placeholder is plain text on purpose: a bare index would let the
    // restore step below match every number in the answer.
    const code = [];
    s = s.replace(/`([^`]+)`/g, (_m, c) => {
      code.push(c);
      return "%%STAI-CODE-" + (code.length - 1) + "%%";
    });
    s = s.replace(/\[\^(\d+)\]/g, (_m, n) => {
      const hit = citeLookup && citeLookup.get(String(n));
      const url = hit && safeUrl(hit.url);
      const title = hit && hit.label ? ' title="' + esc(hit.label) + '"' : "";
      return url
        ? '<sup class="cite"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"' + title + ">" + esc(n) + "</a></sup>"
        : '<sup class="cite">' + esc(n) + "</sup>";
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => {
      // The whole string was escaped above, so "?a=1&b=2" is now "&amp;".
      // Escaping that again yields "&amp;amp;" and a broken link.
      const href = safeUrl(u.replace(/&amp;/g, "&"));
      return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>" : t;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/%%STAI-CODE-(\d+)%%/g, (_m, i) => "<code>" + code[Number(i)] + "</code>");
    return s;
  }

  /**
   * Renders Markdown to HTML for the palette. The result contains only tags
   * generated here; nothing from the provider's DOM survives as markup.
   */
  function renderAnswerHtml(markdown, citations, options) {
    const opts = options || {};
    const headingShift = typeof opts.headingShift === "number" ? opts.headingShift : 2;
    // Markers whose ordinal resolved to a real URL become links; unresolved
    // ones stay as plain superscripts rather than dead anchors.
    const citeByN = new Map();
    (Array.isArray(citations) ? citations : []).forEach((c) => {
      if (c && typeof c.n === "number") citeByN.set(String(c.n), c);
    });

    // Some models write a list inline ("...waist down. - She was charged...
    // - The trial..."). Two or more " - " markers that each start a new
    // sentence are a list: put the items on their own lines.
    const source = String(markdown || "").split(/\r?\n/).map((line) => {
      if (/^\s*([-*•]|\d+[.)])\s/.test(line) || /^\s*\|/.test(line)) return line;
      const pieces = line.split(/(?<=[.!?:;)])\s+[-•]\s+(?=[A-Z0-9*"“])/);
      return pieces.length >= 3 ? pieces.map((p) => `- ${p.trim()}`).join("\n") : line;
    }).join("\n");
    const lines = source.split(/\r?\n/);
    const parts = [];
    let list = null;
    let listTag = "ul";
    let listStart = 1;
    let fence = null;
    let table = null;

    const closeList = () => {
      if (list) {
        // A numbered list interrupted by a paragraph keeps counting.
        const start = listTag === "ol" && listStart > 1 ? ' start="' + listStart + '"' : "";
        parts.push("<" + listTag + start + ">" + list.join("") + "</" + listTag + ">");
      }
      list = null;
    };
    const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const closeTable = () => {
      if (!table) return;
      const [head, ...body] = table;
      const th = head.map((c) => "<th>" + inlineHtml(c, citeByN) + "</th>").join("");
      const trs = body.map((r) => "<tr>" + r.map((c) => "<td>" + inlineHtml(c, citeByN) + "</td>").join("") + "</tr>").join("");
      parts.push('<div class="table-wrap"><table><thead><tr>' + th + "</tr></thead><tbody>" + trs + "</tbody></table></div>");
      table = null;
    };

    for (const line of lines) {
      if (/^```(\w+)?\s*$/.test(line)) {
        if (fence === null) { closeList(); fence = []; }
        else { parts.push("<pre><code>" + esc(fence.join("\n")) + "</code></pre>"); fence = null; }
        continue;
      }
      if (fence !== null) { fence.push(line); continue; }

      // Tables: a header row, a |---| separator, then rows.
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && /-/.test(line)) continue; // separator
        closeList();
        if (!table) table = [];
        table.push(cells(line));
        continue;
      }
      closeTable();

      if (/^\s*---+\s*$/.test(line)) { closeList(); parts.push("<hr>"); continue; }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        // An h1 inside a small palette would shout; shift everything down.
        const level = Math.min(heading[1].length + headingShift, 6);
        parts.push("<h" + level + ">" + inlineHtml(heading[2], citeByN) + "</h" + level + ">");
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) { closeList(); parts.push("<blockquote>" + inlineHtml(quote[1], citeByN) + "</blockquote>"); continue; }

      const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
      const bullet = line.match(/^(\s*)[-*•]\s+(.*)$/);
      if (ordered || bullet) {
        const indent = (ordered ? ordered[1] : bullet[1]).replace(/\t/g, "  ").length;
        const content = inlineHtml(ordered ? ordered[3] : bullet[2], citeByN);
        // An indented item nests under the previous one.
        if (indent >= 2 && list && list.length) {
          const last = list.length - 1;
          const sub = ordered ? "ol" : "ul";
          const closing = "</" + sub + "></li>";
          if (list[last].endsWith(closing)) list[last] = list[last].slice(0, -closing.length) + "<li>" + content + "</li>" + closing;
          else list[last] = list[last].replace(/<\/li>$/, "<" + sub + "><li>" + content + "</li>" + closing);
          continue;
        }
        const tag = ordered ? "ol" : "ul";
        if (list && listTag !== tag) closeList();
        if (!list) listStart = ordered ? Number(ordered[2]) : 1;
        listTag = tag;
        if (!list) list = [];
        list.push("<li>" + content + "</li>");
        continue;
      }

      closeList();
      if (line.trim()) parts.push("<p>" + inlineHtml(line, citeByN) + "</p>");
    }
    closeTable();
    if (fence !== null && fence.length) {
      parts.push("<pre><code>" + esc(fence.join("\n")) + "</code></pre>");
    }
    closeList();

    if (Array.isArray(citations) && citations.length) {
      const items = citations.map((c) => {
        const url = safeUrl(c && c.url);
        if (!url) return "";
        let host = url;
        try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (_e) { /* keep raw */ }
        const raw = c.label && !/^https?:\/\//i.test(c.label) ? c.label : host;
        return '<li><span class="cite-n">' + esc(String(c.n)) + "</span>" +
          '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(raw) + "</a>" +
          '<span class="cite-host">' + esc(host) + "</span></li>";
      }).join("");
      if (items) {
        parts.push('<div class="sources"><div class="sources-h">Sources</div><ol>' + items + "</ol></div>");
      }
    }

    return parts.join("");
  }

  const api = Object.freeze({
    renderAnswerHtml: renderAnswerHtml,
    inlineHtml: inlineHtml,
    escapeHtml: esc,
  });

  root.SELECT_TO_AI_ANSWER = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
