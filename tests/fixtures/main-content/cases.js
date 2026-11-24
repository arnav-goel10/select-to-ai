"use strict";
// Pages with no <main>, no role="main" and no <article>, in the shapes
// older sites take, and the lines on each that must be read. The same files
// are read by the unit test (tests/unit/main-content.test.js, through a
// parsed DOM) and by the browser test (tests/e2e/extract-layout.js, through
// the real content script), so one cannot pass while the other fails on the
// same page. The ids and classes are often misleading on purpose. No page
// is copied from a real site.
//
// The rule is the one the content script follows: with no landmark, no part
// of the page is taken and the whole page is read, as on main. So every
// line listed in `read` must be read: the article and its sidebar, the
// listing and the paragraph beside it, and the short lines that tell the
// agent what its action did or what to do next (a status line, a total, an
// error, a price and stock line, a result count, a "did you mean" and a
// next link, a notice, a step and its Continue button, a note on prices, a
// title). `hidden` names text the page does not draw, which is never read.
// The first eight pages are led by prose, the next five by links, then one
// hides more text than it shows, then six where a list sits beside prose,
// and the last ten are short lines beside a larger part.
const fs = require("node:fs");
const path = require("node:path");

const CASES = [
  {
    file: "blog-sidebar.html",
    shape: "a blog post beside a sidebar of archives and links, with a cookie notice after the page",
    read: ["A dry stone wall holds itself up by weight and friction alone", "one over two and two over one", "Did you use a frame and string lines", "September 2025", "Bees at the bottom of the lane", "Laying the hedge along the lane", "small cookie to remember", "Copyright 2026 Field Notes"],
  },
  {
    file: "forum-thread.html",
    shape: "a forum thread laid out in a table, with a list of similar topics and a footer",
    read: ["the top sinks and I get a dense band under the crust", "That sounds like over-proofing", "it held its shape with a proper dome", "Rye starter smells of nail polish", "Powered by a small forum package", "Board index"],
  },
  {
    file: "product-page.html",
    shape: "a product page with options, a specification table, reviews, related products and a footer",
    read: ["pressed steel kettle with a glass enamel coat", "Steel with glass enamel", "Took it on a week of canoe camping", "Folding wood stove", "Nesting cups, set of four", "Sign up for news and offers", "Kettles and pots"],
  },
  {
    file: "docs-navtree.html",
    shape: "a documentation page beside a deep navigation tree",
    read: ["Waits until every task already in the queue has finished", "Milliseconds to wait before rejecting", "E_DRAIN_TIMEOUT", "Testing with a fake broker", "Migrating from version 2", "open source under the MIT licence"],
  },
  {
    file: "news-front.html",
    shape: "a news front page: a lead story and a grid of stories beside a most-read rail",
    read: ["footbridge over the river by the old mill", "The women's eight held off a late push", "leaving the square at ten", "Potholes on the hill road", "Library extends its weekend opening hours", "Printed and published in the valley"],
  },
  {
    file: "reference-table.html",
    shape: "a reference page led by a table, in an old table layout with a menu column",
    read: ["how well it holds under load", "Joining two ropes of different sizes", "Practise each one until you can tie it in the dark", "Knots by type", "Other rope pages", "Write to the editor"],
  },
  {
    file: "wrapped-column.html",
    shape: "a wrapper holding a column of links (called content) beside the text (called sidebar)",
    read: ["Mosses grow on stone 120.", "Spores travel far 79.", "Related page number 7"],
  },
  {
    file: "status-line.html",
    shape: "a short status line above a long list that holds nearly all the page",
    read: ["Opened: Lunch on Friday", "Notes about item 0", "Notes about item 29"],
  },
  {
    file: "link-aggregator.html",
    shape: "a link aggregator: a table of ranked stories with a volunteers' blurb under it",
    read: ["A solar kiln for drying oak boards", "The quiet economics of village shops", "Sharpening a scythe on the field edge", "points by reader1", "comments"],
  },
  {
    file: "board-index.html",
    shape: "a forum board index: a table of forums under a welcome paragraph",
    read: ["Getting started", "Soil and compost", "Ponds, hedgehogs, birds and the slugs that eat everything", "Off topic", "Mapping every bench in a small town"],
  },
  {
    file: "category-grid.html",
    shape: "a shop category grid of product cards with a closing paragraph",
    read: ["Enamel camping kettle", "Folding wood stove", "Washing-up bowl, folding", "£9.00", "£16.50"],
  },
  {
    file: "file-directory.html",
    shape: "a file directory listing with an intro paragraph",
    read: ["river-survey-01.csv", "river-survey-20.csv", "river-survey-40.csv", "SUMS.txt", "2026-01-01 04:00"],
  },
  {
    file: "cart.html",
    shape: "a cart page: item lines with boxes and buttons, a total, and a terms paragraph",
    read: ["Enamel camping kettle", "Stainless steel mug", "Aluminium windshield", "£34.00", "£24.00", "Total to pay: £72.00"],
  },
  {
    file: "hidden-dialog.html",
    shape: "a news story with a hidden consent dialog, a hidden mega menu and a folded panel, each holding more words than it shows",
    read: ["opened again on Saturday morning after two years of repairs", "chosen because it weathers well", "will open late on Saturday evenings"],
    hidden: ["Consent purpose", "Your privacy choices", "Department 3.2 pages", "Correction panel"],
  },
  {
    file: "home-sections.html",
    shape: "a home page with an intro and a list of section links",
    read: ["forty-two plots on the old brickworks field", "Section 1: plot letting", "Section 6: plot letting", "Section 12: plot letting"],
  },
  {
    file: "two-lists.html",
    shape: "a page with two lists of links beside its prose, a meetings list and a contacts list",
    read: ["nine councillors, elected every four years", "Meeting of 1 March", "Meeting of 6 March", "Councillor 1, ward 1", "Councillor 6, ward 6"],
  },
  {
    file: "help-results.html",
    shape: "search help text above a list of titles-only results",
    read: ["Put a phrase in quotes", "Document 1: minutes", "Document 7: minutes", "Document 14: minutes"],
  },
  {
    file: "rules-topics.html",
    shape: "forum rules above a table of topics",
    read: ["Keep each topic to one question", "Topic 1: slugs", "Topic 9: slugs", "Topic 18: slugs", "18 replies"],
  },
  {
    file: "product-manuals.html",
    shape: "a product page with lists of manuals and of other sizes",
    read: ["pressed from one sheet of steel", "Price 39.00", "Manual part 1 (PDF)", "Manual part 5 (PDF)", "Kettle 1 litre, 21.00", "Kettle 5 litre, 25.00"],
  },
  {
    file: "order-summary.html",
    shape: "an order summary: priced lines and a total above a longer note",
    read: ["Deck brush 1", "Deck brush 4", "2 x 7.50", "Total 60.00", "We pack orders by hand"],
  },
  {
    file: "basket-total.html",
    shape: "a basket: a table of lines with the total to pay under it",
    read: ["Total to pay: 108.00", "Seed tray 1 with lid", "Seed tray 12 with lid"],
    controls: ["Checkout"],
  },
  {
    file: "form-error.html",
    shape: "a form whose error says the booking was not saved, above many fields and their help",
    read: ["Your booking was not saved", "Help 1:", "Help 14:"],
  },
  {
    file: "price-stock.html",
    shape: "a product page whose price and stock line sit beside a longer description",
    read: ["Cedar raised bed", "Price: 84.00", "Only 2 left", "Paragraph 8"],
  },
  {
    file: "result-count.html",
    shape: "search results with a result count, a did-you-mean line and a next link around the list",
    read: ["3 of 214 results shown", "Did you mean", "Result 1: garden hose reel", "Result 20: garden hose reel", "Next page"],
  },
  {
    file: "locked-thread.html",
    shape: "a thread with a locked notice above its posts",
    read: ["This topic is locked. You cannot reply.", "Post 1:", "Post 15:"],
  },
  {
    file: "signed-out.html",
    shape: "minutes with a signed-out notice above them",
    read: ["You have been signed out. Sign in again to carry on.", "Minutes", "Paragraph 9"],
  },
  {
    file: "wizard-step.html",
    shape: "a wizard step: the step line, the address fields and the Back and Continue buttons",
    read: ["Step 2 of 4: Delivery", "Where should we send it?", "Line 10 of the address"],
    controls: ["Continue"],
  },
  {
    file: "vat-note.html",
    shape: "a price list with a note that prices include VAT above it",
    read: ["Updated 2 minutes ago. Prices include VAT.", "Item 1 cold frame", "Item 25 cold frame"],
  },
  {
    file: "article-title.html",
    shape: "an article whose title sits outside the block of its text",
    read: ["Water butt", "From the garden wiki", "Paragraph 10", "Last edited 3 May"],
  },
  {
    file: "inbox-opened.html",
    shape: "an inbox with the opened message's status above the list",
    read: ["Opened: Lunch on Friday", "Sender 1: Notes 1", "Sender 30: Notes 30"],
  },
];

const html = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

module.exports = { CASES, html };
