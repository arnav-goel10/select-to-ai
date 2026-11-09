// Captures the quick box on a light page and on a dark page, each with the
// theme setting on Light and on Dark, plus one page whose CSS tries to leak
// into it. Shots are saved under docs/screenshots/quick-box/.
//
// The script is injected into the page's main world, where chrome.storage is
// absent, so a small stub answers the theme read the way storage would and
// hands back the logo as a data URL.
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "docs", "screenshots", "quick-box");

const LIGHT_PAGE = `<!doctype html><html><body style="font-family:Georgia,serif;margin:0;background:#fff;color:#111">
<header style="background:#f3f4f6;padding:18px 28px;font-size:20px;font-weight:600">Some Website</header>
<main style="padding:32px 28px;max-width:760px">
<h1 style="font-size:30px;margin:0 0 12px">An article page</h1>
<p style="color:#374151;line-height:1.7">The palette has to sit above whatever the page is doing, and must not inherit any of the page's styles. This page uses a serif font on purpose.</p>
<button style="padding:10px 16px;font-size:16px">A page button</button>
</main></body></html>`;

const DARK_PAGE = `<!doctype html><html><body style="font-family:'Courier New',monospace;margin:0;background:#0d1117;color:#e6edf3">
<header style="background:#161b22;padding:18px 28px;font-size:20px;font-weight:600;border-bottom:1px solid #30363d">dark-site.dev</header>
<main style="padding:32px 28px;max-width:760px">
<h1 style="font-size:30px;margin:0 0 12px">Release notes</h1>
<p id=sel style="color:#9da7b3;line-height:1.7">Version 2.4 moves the build cache to a shared volume and drops support for Node 18.</p>
<button style="padding:10px 16px;font-size:16px">Download</button>
</main></body></html>`;

// Rules a hostile or careless page might ship. The page's own text is not in
// a div, so it stays visible while the rules try to reach the palette host.
const HOSTILE_PAGE = LIGHT_PAGE.replace("<body", `<head><style>
* { color: red !important; font: 30px serif !important; letter-spacing: 4px !important;
    text-transform: uppercase !important; line-height: 3 !important; }
div { display: none !important; opacity: 0.2 !important; }
input, kbd, button { border: 5px solid lime !important; }
</style></head><body`);

const LOGO = "data:image/png;base64," + fs.readFileSync(path.join(EXT, "icon128.png")).toString("base64");

function stubTheme(theme) {
  return `window.chrome = window.chrome || {};
    window.chrome.runtime = { getURL: () => ${JSON.stringify(LOGO)}, sendMessage: () => {} };
    window.chrome.storage = { sync: { get: (key, cb) => setTimeout(() => cb(${JSON.stringify(theme ? { theme } : {})}), 5) } };`;
}

async function shoot(browser, { name, html, theme, scheme = "light", select = false, text }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument(stubTheme(theme));
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html), { waitUntil: "load" });
  if (select) {
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("sel"));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }
  await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, "commandPalette.js"), "utf8") });
  await new Promise((r) => setTimeout(r, 250));
  if (text) await page.keyboard.type(text);
  // Let the entrance finish so the shot is the resting state.
  await new Promise((r) => setTimeout(r, 600));
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: 400 } });
  const present = await page.evaluate(() => !!document.getElementById("select-to-ai-command-palette"));
  console.log(`${name}: palette in DOM ${present}, saved ${path.relative(ROOT, file)}`);
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new" });
  const task = "book me a table on opentable for friday";
  await shoot(browser, { name: "light-page-light-theme", html: LIGHT_PAGE, theme: "light", scheme: "dark", text: task });
  await shoot(browser, { name: "light-page-dark-theme", html: LIGHT_PAGE, theme: "dark", scheme: "light", text: task });
  await shoot(browser, { name: "dark-page-light-theme", html: DARK_PAGE, theme: "light", scheme: "dark", select: true });
  await shoot(browser, { name: "dark-page-dark-theme", html: DARK_PAGE, theme: "dark", scheme: "light", select: true, text: "summarise this" });
  // System theme on a page that tries to leak styles in.
  await shoot(browser, { name: "hostile-page-system-theme", html: HOSTILE_PAGE, theme: null, scheme: "dark", text: task });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
