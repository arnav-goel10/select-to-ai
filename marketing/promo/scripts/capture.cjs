// Captures real pages for the promo (screenshots + element positions).
// node scripts/capture.cjs   -> public/captures/*.png and captures.json
const fs = require("fs"), path = require("path");
const puppeteer = require(path.resolve(__dirname, "../../../node_modules/puppeteer"));
const OUT = path.resolve(__dirname, "../public/captures");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2);

// Other companies' ads and pop-ups have no place in our ad.
async function clean(p) {
  await p.evaluate(() => {
    const hide = (e) => e && (e.style.setProperty("visibility", "hidden", "important"));
    document.querySelectorAll('iframe, video, [id*="google_ads"], [class*="adslot"], [class*="ad-slot"], [class*="leaderboard"], [class*="jwplayer"], [class*="mm-ads"], [data-ad-slot]').forEach(hide);
    for (const e of document.querySelectorAll("div, section, aside, span")) {
      const t = (e.innerText || "").trim();
      if (/^Advertisement$/i.test(t)) hide(e.closest('[class*="ad"]') || e.parentElement);
      if (/genius kitchen finds|Visiting from Singapore|showing you items that ship to/i.test(t) && t.length < 400) hide(e.closest('[class*="banner"], [class*="popover"], [class*="modal"], [role="dialog"]') || e);
    }
    document.querySelectorAll('#nav-signin-tooltip, .nav-flyout, #nav-flyout-accountList, #glow-ingress-block, #nav-global-location-slot, .glow-toaster').forEach(hide);
    for (const e of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(e);
      if ((cs.position === "fixed" || cs.position === "sticky") && e.getBoundingClientRect().top > 120) hide(e);
    }
  });
  await sleep(400);
}

async function open(browser, url) {
  const p = await browser.newPage();
  // Amazon's own currency and language preference: show US dollars.
  await p.setCookie({ name: "i18n-prefs", value: "USD", domain: ".amazon.com", path: "/" }, { name: "lc-main", value: "en_US", domain: ".amazon.com", path: "/" });
  await p.setUserAgent(UA);
  await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await p.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await p.goto(url, { waitUntil: "load", timeout: 45000 }).catch((e) => console.log("load:", e.message));
  await sleep(3500);
  return p;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-first-run", "--lang=en-US"] });
  const data = fs.existsSync(path.join(OUT, "captures.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "captures.json"))) : {};
  try {
    if (!only.length || only.includes("wiki")) {
      const p = await open(browser, "https://en.wikipedia.org/wiki/Black_hole");
      const info = await p.evaluate(() => {
        const para = [...document.querySelectorAll("#mw-content-text p")].find((x) => x.innerText.trim().length > 200);
        window.scrollTo(0, Math.max(0, para.getBoundingClientRect().top + window.scrollY - 230));
        return true;
      });
      await sleep(600);
      const d = await p.evaluate(() => {
        const para = [...document.querySelectorAll("#mw-content-text p")].find((x) => x.innerText.trim().length > 200);
        const range = document.createRange(); range.selectNodeContents(para);
        const lines = [];
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.height < 8) continue;
          const l = lines.find((x) => Math.abs(x.y - r.top) < 6);
          if (l) { l.x1 = Math.max(l.x1, r.right); l.x0 = Math.min(l.x0, r.left); } else lines.push({ y: r.top, h: r.height, x0: r.left, x1: r.right });
        }
        lines.sort((a, b) => a.y - b.y);
        return { lines: lines.slice(0, 5), text: para.innerText.replace(/\[\d+\]/g, "").slice(0, 600), title: document.title };
      });
      await p.screenshot({ path: path.join(OUT, "wiki.png") });
      data.wiki = { url: "en.wikipedia.org/wiki/Black_hole", ...d };
      console.log("wiki", d.lines.length, "lines:", d.text.slice(0, 140));
      await p.close();
    }
    if (!only.length || only.includes("recipe")) {
      const p = await open(browser, "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/");
      const d = await p.evaluate(() => {
        const t = document.body.innerText;
        const pick = (re) => (t.match(re) || [""])[0];
        return { title: document.title, h1: (document.querySelector("h1") || {}).innerText, preheat: pick(/Preheat[^\n.]*\./), bake: pick(/Bake[^\n]*\./), rating: pick(/\d\.\d\s*\(\s*[\d,]+\)/), len: t.length };
      });
      await clean(p);
      await p.screenshot({ path: path.join(OUT, "recipe.png") });
      data.recipe = { url: "allrecipes.com/recipe/10813/best-chocolate-chip-cookies", ...d };
      console.log("recipe", JSON.stringify(d));
      await p.close();
    }
    if (!only.length || only.includes("amazon")) {
      // Prefer Amazon.com (USD) over the Singapore store this machine is redirected to.
      const pick = await open(browser, "https://www.amazon.com/s?k=noise+cancelling+headphones");
      await pick.evaluate(() => { const b = [...document.querySelectorAll("a, button, input, span")].find((x) => /Go to Amazon\.com/i.test(x.innerText || x.value || "")); if (b) b.click(); });
      await sleep(4000);
      await pick.close();
      const home = await open(browser, "https://www.amazon.com/deals"); // amazon.com home redirects by location; Today's Deals does not
      await home.evaluate(() => { const b = [...document.querySelectorAll("input, button, span")].find((x) => /^Dismiss$/i.test((x.innerText || x.value || "").trim())); if (b) b.click(); });
      await sleep(600);
      await clean(home);
      const box = await home.evaluate(() => { const b = document.querySelector("#twotabsearchtextbox, input[name=field-keywords]"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await home.screenshot({ path: path.join(OUT, "amazon-home.png") });
      console.log("amazon home search box:", JSON.stringify(box), await home.title());
      await home.close();
      const p = await open(browser, "https://www.amazon.com/s?k=noise+cancelling+headphones");
      await p.evaluate(() => { const b = [...document.querySelectorAll("a, button, input, span")].find((x) => /Go to Amazon\.com/i.test(x.innerText || x.value || "")); if (b) b.click(); });
      await sleep(3000);
      await clean(p);
      const d = await p.evaluate(() => {
        const cards = [...document.querySelectorAll('div[data-component-type="s-search-result"]')].map((c) => {
          const r = c.getBoundingClientRect();
          const title = (c.querySelector("h2") || {}).innerText || "";
          const price = (c.querySelector(".a-price .a-offscreen") || {}).textContent || "";
          const rating = ((c.querySelector(".a-icon-alt") || {}).textContent || "").replace(/ out of 5 stars/, "");
          const reviews = ((c.querySelector('[aria-label$="ratings"], a[href*="customerReviews"] span') || {}).textContent || "").trim();
          const sponsored = /Sponsored/.test(c.innerText);
          return { x: r.left, y: r.top, w: r.width, h: r.height, title: title.slice(0, 90), price, rating, reviews, sponsored };
        });
        const b = document.querySelector("#twotabsearchtextbox"); const br = b ? b.getBoundingClientRect() : null;
        return { cards, box: br && { x: br.left, y: br.top, w: br.width, h: br.height }, title: document.title };
      });
      await p.screenshot({ path: path.join(OUT, "amazon-results.png"), clip: { x: 0, y: 0, width: 1280, height: 1700 }, captureBeyondViewport: true });
      data.amazon = { url: "amazon.com/s?k=noise+cancelling+headphones", homeBox: box, ...d };
      console.log("amazon results", d.cards.length, d.title);
      for (const c of d.cards.slice(0, 12)) console.log(" ", Math.round(c.x), Math.round(c.y), c.price, c.rating, c.reviews, c.sponsored ? "SP" : "", c.title.slice(0, 60));
      await p.close();
    }
  } finally {
    fs.writeFileSync(path.join(OUT, "captures.json"), JSON.stringify(data, null, 2));
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
