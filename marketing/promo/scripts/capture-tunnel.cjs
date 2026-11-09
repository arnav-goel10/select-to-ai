// Extra real pages for the "works on every site" tunnel (screenshots only).
const fs = require("fs"), path = require("path");
const puppeteer = require(path.resolve(__dirname, "../../../node_modules/puppeteer"));
const OUT = path.resolve(__dirname, "../public/captures");
const SITES = [["github", "https://github.com/trending"], ["bbc", "https://www.bbc.com/news"], ["booking", "https://www.booking.com/"], ["youtube", "https://www.youtube.com/"], ["nytimes", "https://www.nytimes.com/"], ["docs", "https://developer.mozilla.org/en-US/docs/Web/JavaScript"], ["airbnb", "https://www.airbnb.com/"], ["spotify", "https://open.spotify.com/"]];
(async () => {
  const b = await puppeteer.launch({headless: true, args: ["--lang=en-US"]});
  for (const [name, url] of SITES) {
    const p = await b.newPage();
    await p.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
    await p.setViewport({width: 1280, height: 800, deviceScaleFactor: 1});
    await p.setExtraHTTPHeaders({"accept-language": "en-US,en;q=0.9"});
    try { await p.goto(url, {waitUntil: "load", timeout: 40000}); } catch (e) { console.log(name, "load:", e.message.slice(0, 60)); }
    await new Promise((r) => setTimeout(r, 3500));
    await p.evaluate(() => {
      const hide = (e) => e && e.style.setProperty("visibility", "hidden", "important");
      document.querySelectorAll('iframe, [id*="google_ads"], [class*="adslot"], [class*="ad-slot"], [data-ad-slot], [aria-modal="true"], [role="dialog"], [id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"]').forEach(hide);
      for (const e of document.querySelectorAll("body *")) { const cs = getComputedStyle(e); if ((cs.position === "fixed") && e.getBoundingClientRect().top > 100) hide(e); }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const title = await p.title().catch(() => "");
    await p.screenshot({path: path.join(OUT, `tunnel-${name}.jpg`), type: "jpeg", quality: 82});
    console.log(name, "|", title.slice(0, 60));
    await p.close();
  }
  await b.close();
})();
