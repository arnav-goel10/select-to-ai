/**
 * Select to AI - the page's controls, as the model reads them.
 *
 * The scan lists every control on the page, wherever it is. This turns that
 * list into the text the model is shown, inside a line budget set for the
 * model in use. A page with more controls than the budget is cut down by
 * its structure, never by guessing what the task needs:
 *
 *   1. a long run of look-alike items (result cards, table rows) keeps the
 *      ones on screen, a few after them, and says how many more there are;
 *   2. a block of links that is a menu, a sidebar or a footer becomes one
 *      line naming the first few;
 *   3. a long run of plain links keeps the ones on screen and a few after.
 *
 * Fields, buttons and dropdowns are not cut by any of these: a filter three
 * screens down is listed whether or not anyone has scrolled to it. A page
 * that is still too long after all three loses controls from the bottom
 * up, but never the ones the last action brought up (an opened menu, a
 * dialog) or a find brought in, and the ones on screen go last. Every
 * control on the page can still be acted on by its ref, and find brings any
 * of them into the listing by the words on it.
 *
 * Pure functions.
 */
(function initObserve(root) {
  "use strict";

  const TOOLS = root.SELECT_TO_AI_TOOLS || (typeof require === "function" ? require("../agentTools.js") : null);

  const isLink = (el) => String(el.tagName || "").toLowerCase() === "a";
  const onScreen = (el) => !el.position || el.position === "in-viewport";
  const MENU_KINDS = new Set(["navigation", "footer", "sidebar"]);
  const short = (t, n) => { const v = String(t || "").replace(/\s+/g, " ").trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

  /** Consecutive controls that share a container, in page order. */
  function blocksOf(elements) {
    const blocks = [];
    for (const el of elements) {
      const last = blocks[blocks.length - 1];
      if (el.groupKey && last && last.key === el.groupKey) last.els.push(el);
      else blocks.push({ key: el.groupKey || null, kind: el.groupKind || "", label: el.group || "", list: el.groupList || null, els: [el] });
    }
    return blocks;
  }

  // What an item is made of ("a link and a button"), so look-alikes can be told.
  const shapeOf = (block) => block.els.map((el) => `${String(el.tagName || "").toLowerCase()}${el.role ? `:${el.role}` : ""}`).join(",");
  const kept = (block) => block.els.some((el) => el.pinned || el.isNew);
  // Two items belong to one run when they sit side by side in the same list,
  // or are made of the same controls. Cards in one list rarely match exactly:
  // one has a badge, the next does not.
  const alike = (a, b) => a.kind === "item" && b.kind === "item" && !!a.key && !!b.key && ((a.list && a.list === b.list) || shapeOf(a) === shapeOf(b));

  /**
   * The members of a run to keep when it is too long: every one that is on
   * screen, since that is what the user is looking at, and `more` of the
   * ones that follow. With none on screen, the first `more`.
   */
  function nearScreen(run, visible, more) {
    const on = run.filter(visible);
    if (!on.length) return run.slice(0, more);
    const after = run.indexOf(on[on.length - 1]) + 1;
    return [...on, ...run.slice(after, after + Math.max(0, more - on.length))];
  }

  /** Where the items left out of a run are: "5 above, 38 below". */
  function whereOf(blocks) {
    const above = blocks.filter((b) => b.els[0].position === "above-fold").length;
    const below = blocks.filter((b) => b.els[0].position === "below-fold").length;
    const parts = [above ? `${above} above` : "", below ? `${below} below` : ""].filter(Boolean);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  /**
   * @param elements  the scan's controls, in page order
   * @param opts      {maxLines}: the budget
   * @returns {text, lines, shown, cut}
   */
  function formatControls(elements, opts) {
    const o = { maxLines: 160, ...(opts || {}) };
    const all = elements || [];
    const blocks = blocksOf(all);
    // Each level cuts more. The first that fits the budget is used, so a
    // page that fits is listed whole.
    const levels = [
      { items: Infinity, menus: false, links: Infinity },
      { items: 8, menus: false, links: Infinity },
      { items: 8, menus: true, links: Infinity },
      { items: 6, menus: true, links: 12 },
      { items: 4, menus: true, links: 8 },
      { items: 3, menus: true, links: 5 },
    ];
    let rows = [];
    for (const level of levels) {
      rows = render(blocks, level);
      if (rows.length <= o.maxLines) break;
    }
    let cut = 0;
    if (rows.length > o.maxLines) {
      // Still too long. What the last action brought up stays, with what a
      // find brought in; then what is on screen; then the rest, from the
      // top of the page, for as long as there is room.
      const rank = (r) => (r.el ? (r.el.isNew || r.el.pinned || r.el.onTop ? 0 : onScreen(r.el) ? 1 : 2) : r.text === "On top of the page:" || r.text === "The page under it:" ? 0 : 2);
      const order = rows.map((r, i) => ({ r, i })).filter((x) => !x.r.isHead).sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i);
      const keep = new Set();
      let used = 1; // the line that says how much was left out
      for (const { r } of order) {
        const cost = 1 + (r.head && !keep.has(r.head) ? 1 : 0);
        if (used + cost > o.maxLines) continue;
        keep.add(r);
        if (r.head) keep.add(r.head);
        used += cost;
      }
      cut = rows.filter((r) => r.el && !keep.has(r)).length;
      rows = rows.filter((r) => keep.has(r));
      rows.push({ text: `${cut} more control${cut === 1 ? " is" : "s are"} not listed. find lists them by the words on them.` });
    }
    return { text: rows.map((r) => r.text).join("\n"), lines: rows.length, shown: rows.filter((r) => r.el).length, cut };
  }

  /** The listing at one level of cutting, as rows: {text, el, head} for a control, {text} for the rest. */
  function render(blocks, level) {
    const rows = [];
    const line = (el, head) => rows.push({ text: `${head ? "  " : ""}${TOOLS.formatElementLine(el, {})}`, el, head: head || null });
    const group = (block) => {
      if (block.key && block.els.length > 1) {
        const head = { text: `${block.label || block.kind}:`, isHead: true };
        rows.push(head);
        for (const el of block.els) line(el, head);
      } else {
        for (const el of block.els) {
          // A lone control still says which card or dialog it is in.
          const own = TOOLS.elementLabel(el).toLowerCase();
          const adds = el.group && !(own.length > 8 && el.group.toLowerCase().includes(own.slice(0, 40)) && el.group.length < own.length + 30);
          const where = adds && (el.groupKind === "item" || el.groupKind === "dialog") ? ` (in ${el.group})` : "";
          rows.push({ text: `${TOOLS.formatElementLine(el, {})}${where}`, el, head: null });
        }
      }
    };

    // What is drawn on top of the page comes first: it is what a person
    // would see first, and often has to be answered before anything else.
    const top = blocks.filter((b) => b.els.some((el) => el.onTop));
    if (top.length) {
      rows.push({ text: "On top of the page:" });
      for (const b of top) group(b);
      rows.push({ text: "The page under it:" });
    }

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (top.includes(block)) continue;

      // 1. A run of look-alike items.
      if (block.kind === "item" && block.key) {
        let j = i;
        while (j + 1 < blocks.length && alike(blocks[j], blocks[j + 1])) j++;
        const run = blocks.slice(i, j + 1);
        if (run.length > level.items) {
          // Every item on screen, then some of the ones after them.
          const chosen = new Set(nearScreen(run, (b) => b.els.some(onScreen), level.items));
          for (const b of run) if (kept(b)) chosen.add(b);
          const rest = run.filter((b) => !chosen.has(b));
          for (const b of run) if (chosen.has(b)) group(b);
          if (rest.length) rows.push({ text: `${rest.length} more item${rest.length === 1 ? "" : "s"} like ${chosen.size === 1 ? "this" : "these"}${whereOf(rest)}. scroll brings others into the listing; find lists one by its name.` });
        } else {
          for (const b of run) group(b);
        }
        i = j;
        continue;
      }

      // 2. A menu, sidebar or footer that is mostly links.
      const links = block.els.filter(isLink);
      if (level.menus && MENU_KINDS.has(block.kind) && links.length > 8) {
        const others = block.els.filter((el) => !isLink(el) || el.pinned || el.isNew);
        const names = links.slice(0, 6).map((el) => `"${short(TOOLS.elementLabel(el), 24)}"`).join(", ");
        const head = { text: `${block.label || block.kind}: ${links.length} links, among them ${names}. find lists one by its name.` };
        rows.push(head);
        for (const el of others) line(el, head);
        continue;
      }

      // 3. A long run of plain links outside any container.
      if (!block.key && isLink(block.els[0])) {
        let j = i;
        while (j + 1 < blocks.length && !blocks[j + 1].key && isLink(blocks[j + 1].els[0])) j++;
        const run = blocks.slice(i, j + 1).map((b) => b.els[0]);
        if (run.length > level.links) {
          const chosen = new Set(nearScreen(run, onScreen, level.links));
          for (const el of run) if (el.pinned || el.isNew) chosen.add(el);
          for (const el of run) if (chosen.has(el)) line(el, null);
          const rest = run.length - chosen.size;
          if (rest > 0) rows.push({ text: `${rest} more link${rest === 1 ? "" : "s"} here. find lists one by its name.` });
        } else {
          for (const el of run) line(el, null);
        }
        i = j;
        continue;
      }

      group(block);
    }
    return rows;
  }

  const api = Object.freeze({ formatControls, blocksOf });
  root.SELECT_TO_AI_OBSERVE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
