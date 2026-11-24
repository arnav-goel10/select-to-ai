"use strict";
// Pages with no <main>, no role="main" and no <article>, in the shapes
// older sites take, and what of each the reader must take as the page's main
// content and what it must leave out. The same files are read by the unit
// test (tests/unit/main-content.test.js, through a parsed DOM) and by the
// browser test (tests/e2e/extract-layout.js, through the real content
// script), so one cannot pass while the other fails on the same page.
// The ids and classes are often misleading on purpose: a reader that went
// by names would pick the wrong part. No page is copied from a real site.
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
];

const html = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

module.exports = { CASES, html };
