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
// The first eight are led by prose. The next five are led by links, where
// the links are the page: a reading that weighed link text as menu took a
// stray paragraph for the page and dropped the listing. What must hold on
// them is the rule itself: never read less than the whole page would. The
// last one hides more text than it shows (a closed consent dialog, a
// mega menu, a folded panel); `drawn` marks that its reading is checked
// as drawn text, since what is hidden must weigh nothing and be read as
// nothing.
const fs = require("node:fs");
const path = require("node:path");

const CASES = [
  {
    file: "blog-sidebar.html",
    shape: "a blog post beside a sidebar of archives and links, with a cookie notice after the page",
    read: ["A dry stone wall holds itself up by weight and friction alone", "one over two and two over one", "Did you use a frame and string lines"],
    notRead: ["September 2025", "Bees at the bottom of the lane", "Laying the hedge along the lane", "small cookie to remember", "Copyright 2026 Field Notes"],
  },
  {
    file: "forum-thread.html",
    shape: "a forum thread laid out in a table, with a list of similar topics and a footer",
    read: ["the top sinks and I get a dense band under the crust", "That sounds like over-proofing", "it held its shape with a proper dome"],
    notRead: ["Rye starter smells of nail polish", "Powered by a small forum package", "Board index"],
  },
  {
    file: "product-page.html",
    shape: "a product page with options, a specification table, reviews, related products and a footer",
    read: ["pressed steel kettle with a glass enamel coat", "Steel with glass enamel", "Took it on a week of canoe camping"],
    notRead: ["Folding wood stove", "Nesting cups, set of four", "Sign up for news and offers", "Kettles and pots"],
  },
  {
    file: "docs-navtree.html",
    shape: "a documentation page beside a deep navigation tree",
    read: ["Waits until every task already in the queue has finished", "Milliseconds to wait before rejecting", "E_DRAIN_TIMEOUT"],
    notRead: ["Testing with a fake broker", "Migrating from version 2", "open source under the MIT licence"],
  },
  {
    file: "news-front.html",
    shape: "a news front page: a lead story and a grid of stories beside a most-read rail",
    read: ["footbridge over the river by the old mill", "The women's eight held off a late push", "leaving the square at ten"],
    notRead: ["Potholes on the hill road", "Library extends its weekend opening hours", "Printed and published in the valley"],
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
    shape: "a short status line above a long list: both are the page",
    read: ["Opened: Lunch on Friday", "Notes about item 29"],
    notRead: [],
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
    notRead: [],
  },
  {
    file: "category-grid.html",
    shape: "a shop category grid of product cards with a closing paragraph",
    read: ["Enamel camping kettle", "Folding wood stove", "Washing-up bowl, folding", "\u00a39.00", "\u00a316.50"],
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
    notRead: [],
  },
  {
    file: "hidden-dialog.html",
    shape: "a news story with a hidden consent dialog, a hidden mega menu and a folded panel, each holding more words than it shows",
    drawn: true,
    read: ["opened again on Saturday morning after two years of repairs", "chosen because it weathers well", "will open late on Saturday evenings"],
    notRead: ["Consent purpose", "Your privacy choices", "Department 3.2 pages", "Correction panel"],
  },
];

const html = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

module.exports = { CASES, html };
