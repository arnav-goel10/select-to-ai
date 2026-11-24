"use strict";
// Pages with no <main>, no role="main" and no <article>, in the shapes
// older sites take, and what of each the reader must take as the page's main
// content and what it must leave out. The same files are read by the unit
// test (tests/unit/main-content.test.js, through a parsed DOM) and by the
// browser test (tests/e2e/extract-layout.js, through the real content
// script), so one cannot pass while the other fails on the same page.
// The ids and classes are often misleading on purpose: a reader that went
// by names would pick the wrong part. No page is copied from a real site.
//
// The rule is the one the content script follows: a part is the page's
// content only when it holds at least 80 percent of all the text a reader
// can see on the page, link text counted as text. Otherwise the whole page
// is read, as it was before. `whole` marks a page where no part holds that
// much, so the whole page must be read. `notRead` names text outside the
// part taken (or hidden text that is never read). The first eight pages are
// led by prose, the next five by links, then one hides more text than it
// shows (`drawn` marks that its reading is checked as drawn text), and the
// last six are shapes a reviewer found where a list of links is the smaller
// part beside prose: every list, row, line and total on them must be read.
const fs = require("node:fs");
const path = require("node:path");

const CASES = [
  {
    file: "blog-sidebar.html",
    shape: "a blog post beside a sidebar of archives and links, with a cookie notice after the page",
    read: ["A dry stone wall holds itself up by weight and friction alone", "one over two and two over one", "Did you use a frame and string lines"],
    notRead: ["small cookie to remember", "Copyright 2026 Field Notes"],
  },
  {
    file: "forum-thread.html",
    shape: "a forum thread laid out in a table, with a list of similar topics and a footer",
    read: ["the top sinks and I get a dense band under the crust", "That sounds like over-proofing", "it held its shape with a proper dome"],
    whole: true,
    notRead: [],
  },
  {
    file: "product-page.html",
    shape: "a product page with options, a specification table, reviews, related products and a footer",
    read: ["pressed steel kettle with a glass enamel coat", "Steel with glass enamel", "Took it on a week of canoe camping"],
    notRead: ["Sign up for news and offers", "Kettles and pots"],
  },
  {
    file: "docs-navtree.html",
    shape: "a documentation page beside a deep navigation tree",
    read: ["Waits until every task already in the queue has finished", "Milliseconds to wait before rejecting", "E_DRAIN_TIMEOUT"],
    notRead: ["open source under the MIT licence"],
  },
  {
    file: "news-front.html",
    shape: "a news front page: a lead story and a grid of stories beside a most-read rail",
    read: ["footbridge over the river by the old mill", "The women's eight held off a late push", "leaving the square at ten"],
    notRead: ["Printed and published in the valley"],
  },
  {
    file: "reference-table.html",
    shape: "a reference page led by a table, in an old table layout with a menu column",
    read: ["how well it holds under load", "Joining two ropes of different sizes", "Practise each one until you can tie it in the dark"],
    notRead: ["Knots by type", "Other rope pages", "Write to the editor"],
  },
  {
    file: "wrapped-column.html",
    shape: "a wrapper holding a column of links (called content) beside the text (called sidebar)",
    read: ["Mosses grow on stone 120.", "Spores travel far 79."],
    notRead: ["Related page number 7"],
  },
  {
    file: "status-line.html",
    shape: "a short status line above a long list that holds nearly all the page: the list is taken, and the line, under a fifth of the page, is left out",
    read: ["Notes about item 0", "Notes about item 29"],
    notRead: ["Opened: Lunch on Friday"],
  },
  {
    file: "link-aggregator.html",
    shape: "a link aggregator: a table of ranked stories with a volunteers' blurb under it",
    read: ["A solar kiln for drying oak boards", "The quiet economics of village shops", "Sharpening a scythe on the field edge", "points by reader1", "comments"],
    notRead: [],
  },
  {
    file: "board-index.html",
    shape: "a forum board index: a table of forums under a welcome paragraph",
    read: ["Getting started", "Soil and compost", "Ponds, hedgehogs, birds and the slugs that eat everything", "Off topic", "Mapping every bench in a small town"],
    whole: true,
    notRead: [],
  },
  {
    file: "category-grid.html",
    shape: "a shop category grid of product cards with a closing paragraph",
    read: ["Enamel camping kettle", "Folding wood stove", "Washing-up bowl, folding", "\u00a39.00", "\u00a316.50"],
    whole: true,
    notRead: [],
  },
  {
    file: "file-directory.html",
    shape: "a file directory listing with an intro paragraph",
    read: ["river-survey-01.csv", "river-survey-20.csv", "river-survey-40.csv", "SUMS.txt", "2026-01-01 04:00"],
    notRead: [],
  },
  {
    file: "cart.html",
    shape: "a cart page: item lines with boxes and buttons, a total, and a terms paragraph",
    read: ["Enamel camping kettle", "Stainless steel mug", "Aluminium windshield", "\u00a334.00", "\u00a324.00", "Total to pay: \u00a372.00"],
    whole: true,
    notRead: [],
  },
  {
    file: "hidden-dialog.html",
    shape: "a news story with a hidden consent dialog, a hidden mega menu and a folded panel, each holding more words than it shows",
    whole: true,
    drawn: true,
    read: ["opened again on Saturday morning after two years of repairs", "chosen because it weathers well", "will open late on Saturday evenings"],
    notRead: ["Consent purpose", "Your privacy choices", "Department 3.2 pages", "Correction panel"],
  },
  {
    file: "home-sections.html",
    shape: "a home page with an intro and a list of section links",
    whole: true,
    read: ["forty-two plots on the old brickworks field", "Section 1: plot letting", "Section 6: plot letting", "Section 12: plot letting"],
    notRead: [],
  },
  {
    file: "two-lists.html",
    shape: "a page with two lists of links beside its prose, a meetings list and a contacts list",
    whole: true,
    read: ["nine councillors, elected every four years", "Meeting of 1 March", "Meeting of 6 March", "Councillor 1, ward 1", "Councillor 6, ward 6"],
    notRead: [],
  },
  {
    file: "help-results.html",
    shape: "search help text above a list of titles-only results",
    whole: true,
    read: ["Put a phrase in quotes", "Document 1: minutes", "Document 7: minutes", "Document 14: minutes"],
    notRead: [],
  },
  {
    file: "rules-topics.html",
    shape: "forum rules above a table of topics",
    whole: true,
    read: ["Keep each topic to one question", "Topic 1: slugs", "Topic 9: slugs", "Topic 18: slugs", "18 replies"],
    notRead: [],
  },
  {
    file: "product-manuals.html",
    shape: "a product page with lists of manuals and of other sizes",
    whole: true,
    read: ["pressed from one sheet of steel", "Price 39.00", "Manual part 1 (PDF)", "Manual part 5 (PDF)", "Kettle 1 litre, 21.00", "Kettle 5 litre, 25.00"],
    notRead: [],
  },
  {
    file: "order-summary.html",
    shape: "an order summary: priced lines and a total above a longer note",
    whole: true,
    read: ["Deck brush 1", "Deck brush 4", "2 x 7.50", "Total 60.00", "We pack orders by hand"],
    notRead: [],
  },
];

const html = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

module.exports = { CASES, html };
