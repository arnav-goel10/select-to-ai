"use strict";
// The start-site behaviour set (start-site-eval.js): twenty pairs of a page
// the user was on and a request they made there, written for this set alone.
// No pair, site or request comes from a benchmark suite, and the sites are
// made up, so no model knows them.
//
// "on": the site can answer, but not from the page that is open: the answer
// is behind its own search or menus. The first action should stay on it.
// "off": a general question asked from a tab that has nothing to do with
// it. The run should leave within two steps.
//
// Each case has the page the run starts on and `inside`, the page the site
// shows after an action on it that does not lead to an answer: its own
// search results for the request's words, with none that fit.

let next = 1;
const control = (tagName, accName, more) => ({ id: next++, tagName, accName, ...more });

/** A start page: a search box, a menu of the site's own pages, and a little text. */
function site(host, title, text, menu) {
  const base = `https://www.${host}`;
  const elements = [
    control("input", `Search ${title}`, { inputType: "search", role: "searchbox", formId: 0 }),
    control("button", "Search", { submits: true, formId: 0 }),
    ...menu.map(([label, path]) => control("a", label, { url: `${base}${path}` })),
  ];
  const innerText = [title, ...menu.map(([label]) => label), text].join("\n");
  return { url: `${base}/`, title, scrollY: 0, viewportHeight: 900, pageHeight: 1400, visibleText: innerText.slice(0, 600), innerText, elements, forms: [{ id: 0, search: true, fields: 1, action: `${base}/search` }] };
}

/** The same site's search results for words it has nothing on. */
function inside(page, words) {
  const elements = page.elements.map((el) => ({ ...el }));
  const innerText = `${page.title}\nSearch results for "${words}"\nNo results match your search. Try other words, or browse the menu.\n${page.elements.slice(2).map((el) => el.accName).join("\n")}`;
  return { ...page, url: `${page.url}search?q=${encodeURIComponent(words)}`, title: `Search: ${words} | ${page.title}`, visibleText: innerText.slice(0, 600), innerText, elements };
}

const PAGES = {
  library: () => site("millbrookpubliclibrary.org", "Millbrook Public Library", "Welcome to Millbrook Public Library. Join our autumn reading challenge. New this month: large-print titles and a seed library.", [["Hours & Locations", "/visit"], ["Catalogue", "/catalogue"], ["Events", "/events"], ["Your Account", "/account"], ["Contact us", "/contact"]]),
  bikes: () => site("spokeandgear.com", "Spoke & Gear Cycles", "Free tune-up with every new bike. Workshop open six days a week.", [["Bikes", "/bikes"], ["Helmets", "/helmets"], ["Lights & Locks", "/accessories"], ["Workshop", "/workshop"], ["Sale", "/sale"]]),
  recipes: () => site("thriftykitchen.net", "Thrifty Kitchen", "Home cooking on a budget. This week: five soups under three pounds a bowl.", [["Recipes", "/recipes"], ["Vegetarian", "/recipes/vegetarian"], ["Quick meals", "/recipes/quick"], ["Meal plans", "/plans"], ["About", "/about"]]),
  ferry: () => site("islandlinkferries.com", "Island Link Ferries", "Sailings to Garth Island and Fenmouth. Book ahead in summer.", [["Timetables", "/timetables"], ["Fares", "/fares"], ["Travel info", "/travel-info"], ["Manage booking", "/manage"], ["Help", "/help"]]),
  maths: () => site("dept-maths.hollinsuniversity.edu", "Hollins University, Department of Mathematics", "The Department of Mathematics teaches over 900 students each year. Seminars are open to all.", [["Courses", "/courses"], ["People", "/people"], ["Timetable", "/timetable"], ["Research", "/research"], ["News", "/news"]]),
  council: () => site("eastvalecouncil.gov.uk", "Eastvale District Council", "Find out about council services in Eastvale. Report a problem online.", [["Bins and recycling", "/bins"], ["Council tax", "/council-tax"], ["Parking", "/parking"], ["Planning", "/planning"], ["Contact the council", "/contact"]]),
  museum: () => site("harrowgatemuseum.org", "Harrowgate Museum of Craft", "Explore three floors of craft, from medieval tiles to modern glass. Café on the ground floor.", [["Visit", "/visit"], ["What's on", "/whats-on"], ["Collections", "/collections"], ["Shop", "/shop"], ["Support us", "/support"]]),
  docs: () => site("docs.quillhttp.dev", "Quill HTTP client documentation", "Quill is a small HTTP client for Node. Install it with npm install quill-http.", [["Getting started", "/start"], ["Guides", "/guides"], ["API reference", "/api"], ["Changelog", "/changelog"], ["FAQ", "/faq"]]),
  books: () => site("lanternbooks.co.uk", "Lantern Books", "An independent bookshop since 1987. Free delivery on orders over twenty pounds.", [["Fiction", "/fiction"], ["Non-fiction", "/non-fiction"], ["Children's", "/children"], ["Gift cards", "/gift-cards"], ["Our shops", "/shops"]]),
  gym: () => site("corefitclubs.com", "CoreFit Clubs", "Twelve clubs across the region. Join with no contract this month.", [["Clubs", "/clubs"], ["Class timetable", "/classes"], ["Membership", "/membership"], ["Personal training", "/pt"], ["Members' area", "/members"]]),
};

const CASES = [
  // On the site: the answer is there, behind its own search or menus.
  { name: "library-hours", group: "on", page: "library", task: "what time does the library close on Saturday?" },
  { name: "bike-helmets", group: "on", page: "bikes", task: "do they have any kids' helmets under 40 pounds?" },
  { name: "veg-lasagne", group: "on", page: "recipes", task: "find a vegetarian lasagne recipe that takes under an hour" },
  { name: "ferry-luggage", group: "on", page: "ferry", task: "how many bags can I take on as a foot passenger?" },
  { name: "stats-lecturer", group: "on", page: "maths", task: "who teaches the first-year statistics course this term?" },
  { name: "bin-day", group: "on", page: "council", task: "what day is the garden waste collected in Northfield ward?" },
  { name: "museum-sunday", group: "on", page: "museum", task: "is entry free on Sundays, and when does it open?" },
  { name: "request-timeout", group: "on", page: "docs", task: "how do I set a timeout on a request?" },
  { name: "paperback", group: "on", page: "books", task: "is there a paperback of The Salt Orchard, and how much is it?" },
  { name: "thursday-classes", group: "on", page: "gym", task: "what classes are on Thursday evening at the Eastgate club?" },
  // Off the site: a general question asked from an unrelated tab.
  { name: "lisbon-population", group: "off", page: "bikes", task: "what is the population of Lisbon?" },
  { name: "euro-yen", group: "off", page: "library", task: "what is today's exchange rate from euros to yen?" },
  { name: "oslo-weather", group: "off", page: "docs", task: "what will the weather be in Oslo this weekend?" },
  { name: "nz-prime-minister", group: "off", page: "museum", task: "who is the prime minister of New Zealand right now?" },
  { name: "iron-symptoms", group: "off", page: "books", task: "what are the common symptoms of iron deficiency, according to a health service?" },
  { name: "python-release", group: "off", page: "council", task: "what is the latest stable release of the Python language?" },
  { name: "kilimanjaro-permit", group: "off", page: "gym", task: "how much does a park permit cost to climb Kilimanjaro?" },
  { name: "train-leeds-york", group: "off", page: "recipes", task: "when is the first train from Leeds to York tomorrow morning?" },
  { name: "banana-calories", group: "off", page: "maths", task: "how many calories are in a medium banana?" },
  { name: "marathon-record", group: "off", page: "ferry", task: "what is the current men's marathon world record time?" },
];

/** A case's start page and the page the site shows after an action on it that leads nowhere. */
function pagesOf(c) {
  next = 1;
  const page = PAGES[c.page]();
  return { page, inside: inside(page, c.task) };
}

module.exports = { CASES, pagesOf };
