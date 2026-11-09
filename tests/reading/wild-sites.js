/**
 * Real pages for the generality check (tests/reading/wild.js). Chosen by
 * category before any result was seen, and none of them was used to tune the
 * page reader: the point is to catch a reader that only works on the pages
 * it was developed against. Do not edit this list to improve a score; add
 * pages instead.
 */
"use strict";
const SITES = [
  // news: home pages and articles
  ["news", "https://www.bbc.com/news"],
  ["news", "https://apnews.com/"],
  ["news", "https://www.theguardian.com/international"],
  ["news", "https://www.straitstimes.com/"],
  ["news", "https://www.npr.org/sections/news/"],
  // reference and long reads
  ["reference", "https://www.britannica.com/science/black-hole"],
  ["reference", "https://en.wikipedia.org/wiki/Photosynthesis"],
  ["reference", "https://plato.stanford.edu/entries/consciousness/"],
  ["reference", "https://paulgraham.com/greatwork.html"],
  ["reference", "https://martinfowler.com/articles/microservices.html"],
  // developer docs
  ["docs", "https://kubernetes.io/docs/concepts/overview/"],
  ["docs", "https://docs.djangoproject.com/en/5.1/topics/http/urls/"],
  ["docs", "https://www.postgresql.org/docs/current/tutorial-join.html"],
  ["docs", "https://learn.microsoft.com/en-us/azure/storage/common/storage-introduction"],
  ["docs", "https://docs.stripe.com/payments"],
  ["docs", "https://www.w3schools.com/css/css_grid.asp"],
  ["docs", "https://developer.apple.com/documentation/swiftui"],
  // shopping and product pages
  ["shop", "https://www.apple.com/iphone/"],
  ["shop", "https://www.ikea.com/sg/en/p/billy-bookcase-white-00263850/"],
  ["shop", "https://www.amazon.com/dp/B0BSHF7WHW"],
  ["shop", "https://www.etsy.com/"],
  // forums and Q&A
  ["forum", "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array"],
  ["forum", "https://old.reddit.com/r/AskHistorians/"],
  ["forum", "https://news.ycombinator.com/news"],
  ["forum", "https://github.com/torvalds/linux"],
  ["forum", "https://github.com/facebook/react/issues"],
  // government, health, education
  ["gov", "https://www.mom.gov.sg/passes-and-permits/employment-pass"],
  ["gov", "https://www.cdc.gov/flu/about/index.html"],
  ["gov", "https://www.nhs.uk/conditions/diabetes/"],
  ["gov", "https://www.nus.edu.sg/"],
  ["gov", "https://www.weather.gov/"],
  // recipes, health and lifestyle
  ["lifestyle", "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/"],
  ["lifestyle", "https://www.seriouseats.com/the-food-lab-best-chocolate-chip-cookie-recipe"],
  ["lifestyle", "https://www.healthline.com/nutrition/green-tea-benefits"],
  ["lifestyle", "https://www.goodreads.com/book/show/5907.The_Hobbit"],
  // media, travel, finance
  ["media", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ["media", "https://www.imdb.com/title/tt0111161/"],
  ["travel", "https://www.booking.com/"],
  ["travel", "https://www.timeanddate.com/worldclock/"],
  ["finance", "https://finance.yahoo.com/quote/AAPL/"],
  ["finance", "https://www.investopedia.com/terms/c/compoundinterest.asp"],
  // pricing and SaaS
  ["saas", "https://www.notion.com/pricing"],
  ["saas", "https://slack.com/pricing"],
  ["saas", "https://vercel.com/pricing"],
  // papers
  ["paper", "https://arxiv.org/abs/1706.03762"],
  ["paper", "https://www.nature.com/articles/s41586-021-03819-2"],
];
module.exports = { SITES };
